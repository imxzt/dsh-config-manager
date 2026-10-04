/**
 * server.mjs — 外部 Web UI 的 HTTP 服务器。
 *
 * **为什么是独立服务器而不是页面内插件**：DSH 起不来时页面内插件根本
 * 加载不了，而崩溃恢复恰恰是那时唯一需要的东西。所以这个服务器只依赖
 * node（+ git），可以在 DSH 完全挂掉时跑起来。
 *
 * 安全：只绑 127.0.0.1，且要求一个 token。回环也**不是**可信边界——
 * 本机任何进程都能访问回环端口，而这个 UI 能改写 profile 配置。
 * token 生成后写进 `<home>/plugins/dsh-config-manager/.token`（权限 0600
 * 尽力而为），并打印到启动日志。
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

import * as gitlib from './git.mjs'
import { runAll } from './health.mjs'
import { assess, recover, forensicDiff } from './crash.mjs'
import { scanAll, repairFile } from './sessions.mjs'
import { listPlugins, preflight, neutralizeMissingBundles } from './plugins.mjs'
import { resolveContext } from './paths.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const WEBUI = join(here, '..', 'webui')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

/** 读取或生成 token。 */
export function ensureToken(ctx) {
  const dir = join(ctx.home, 'plugins', 'dsh-config-manager')
  const path = join(dir, '.token')
  if (existsSync(path)) {
    const t = readFileSync(path, 'utf8').trim()
    if (t.length >= 16) return { token: t, path, created: false }
  }
  const token = randomBytes(24).toString('hex')
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, token + '\n', { encoding: 'utf8', mode: 0o600 })
  } catch { /* 写不了就只在内存里用 */ }
  return { token, path, created: true }
}

/** 常量时间比较，避免 token 逐字符泄露。 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** 从 query 或 header 取 token。 */
function tokenOf(req, url) {
  const q = url.searchParams.get('token')
  if (q) return q
  const h = req.headers['x-dcm-token']
  return typeof h === 'string' ? h : null
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2)
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * API 路由表。每个 handler 返回 `{ status, value }`。
 * 约定信封：成功 `{ ok: true, value }`，失败 `{ ok: false, error: { code, message } }`。
 */
function buildRoutes(ctx) {
  return {
    'GET /api/overview': async () => {
      const health = runAll(ctx)
      const crash = assess(ctx)
      const repoOk = gitlib.isRepo(ctx.repoRoot)
      const st = repoOk ? gitlib.status(ctx.repoRoot) : { ok: false, clean: null, entries: [] }
      const log = repoOk ? gitlib.log(ctx.repoRoot, 20) : { ok: false, commits: [] }
      const tags = repoOk ? gitlib.tags(ctx.repoRoot) : { ok: false, tags: [] }
      return {
        status: 200,
        value: {
          ctx: { home: ctx.home, profile: ctx.profile, profileDir: ctx.profileDir },
          git: { available: gitlib.gitAvailable(), repo: repoOk, clean: st.clean, changed: st.entries, commits: log.commits, tags: tags.tags },
          health: { ok: health.ok, errors: health.errors, warnings: health.warnings },
          crash: { crashed: crash.crashed, confidence: crash.confidence, signals: crash.signals, recommendation: crash.recommendation },
        },
      }
    },

    'GET /api/health': async () => ({ status: 200, value: runAll(ctx) }),
    'POST /api/health': async () => ({ status: 200, value: runAll(ctx) }),

    'GET /api/crash': async () => ({ status: 200, value: assess(ctx) }),

    'GET /api/git/status': async () => ({ status: 200, value: gitlib.status(ctx.repoRoot) }),
    'GET /api/git/log': async (req, url) => {
      const n = Number(url.searchParams.get('limit') ?? 30)
      return { status: 200, value: gitlib.log(ctx.repoRoot, Number.isFinite(n) ? n : 30) }
    },
    'GET /api/git/tags': async () => ({ status: 200, value: gitlib.tags(ctx.repoRoot) }),
    'GET /api/git/files': async () => ({ status: 200, value: gitlib.trackedFiles(ctx.repoRoot) }),
    'GET /api/git/stats': async () => ({ status: 200, value: gitlib.repoStats(ctx.repoRoot) }),
    'GET /api/git/diff': async (req, url) => {
      const from = url.searchParams.get('from') ?? undefined
      const to = url.searchParams.get('to') ?? undefined
      const path = url.searchParams.get('path') ?? undefined
      return { status: 200, value: gitlib.diff(ctx.repoRoot, { from, to, path, staged: url.searchParams.get('staged') === '1' }) }
    },
    'GET /api/git/fileLog': async (req, url) => {
      const path = url.searchParams.get('path')
      if (!path) return { status: 400, value: { ok: false, error: { code: 'missing-path', message: 'path is required' } } }
      return { status: 200, value: gitlib.fileLog(ctx.repoRoot, path) }
    },
    'GET /api/git/commitFiles': async (req, url) => {
      const hash = url.searchParams.get('hash')
      if (!hash) return { status: 400, value: { ok: false, error: { code: 'missing-hash', message: 'hash is required' } } }
      return { status: 200, value: gitlib.commitFiles(ctx.repoRoot, hash) }
    },
    'GET /api/crash/forensic': async (req, url) => {
      const ref = url.searchParams.get('ref')
      if (!ref) return { status: 400, value: { ok: false, error: { code: 'missing-ref', message: 'ref is required' } } }
      return { status: 200, value: forensicDiff(ctx, ref) }
    },

    'POST /api/git/save': async (req) => {
      const body = JSON.parse((await readBody(req)) || '{}')
      return { status: 200, value: gitlib.save(ctx.repoRoot, body.message) }
    },
    'POST /api/git/restore': async (req) => {
      const body = JSON.parse((await readBody(req)) || '{}')
      return { status: 200, value: gitlib.restore(ctx.repoRoot, body.ref, body.paths ?? []) }
    },
    'POST /api/git/discard': async (req) => {
      const body = JSON.parse((await readBody(req)) || '{}')
      if (body.confirm !== true) {
        return { status: 400, value: { ok: false, error: { code: 'needs-confirm', message: 'discard requires confirm:true' } } }
      }
      return { status: 200, value: gitlib.discardAll(ctx.repoRoot) }
    },
    'POST /api/git/tag': async (req) => {
      const body = JSON.parse((await readBody(req)) || '{}')
      return { status: 200, value: gitlib.tag(ctx.repoRoot, body.name, body.message, body.ref ?? 'HEAD') }
    },
    'POST /api/git/deleteTag': async (req) => {
      const body = JSON.parse((await readBody(req)) || '{}')
      return { status: 200, value: gitlib.deleteTag(ctx.repoRoot, body.name) }
    },

    'POST /api/crash/recover': async (req) => {
      const body = JSON.parse((await readBody(req)) || '{}')
      if (body.confirm !== true) {
        return { status: 400, value: { ok: false, error: { code: 'needs-confirm', message: 'recover requires confirm:true' } } }
      }
      return { status: 200, value: recover(ctx, { ref: body.ref, dryRun: body.dryRun === true }) }
    },

    'GET /api/sessions': async () => ({ status: 200, value: scanAll(ctx.sessionsRoot) }),

    'POST /api/sessions/fix': async (req) => {
      const body = JSON.parse((await readBody(req)) || '{}')
      const dryRun = body.dryRun !== false
      const scan = scanAll(ctx.sessionsRoot)
      const targets = Array.isArray(body.paths) && body.paths.length > 0
        ? scan.files.filter((f) => body.paths.includes(f.path))
        : scan.files.filter((f) => f.report.status === 'fixable')
      const results = targets.map((f) => ({ path: f.path, session: f.session, workspace: f.workspace, ...repairFile(f.path, { dryRun }) }))
      return { status: 200, value: { scanned: scan.total, dryRun, results } }
    },

    // ── 插件护栏（D 项）──
    'GET /api/plugins': async () => ({ status: 200, value: listPlugins(ctx) }),
    'GET /api/preflight': async () => ({ status: 200, value: preflight(ctx) }),
    'POST /api/plugins/neutralize': async (req) => {
      const body = JSON.parse((await readBody(req)) || '{}')
      const dryRun = body.dryRun !== false
      if (!dryRun && body.confirm !== true) {
        return { status: 400, value: { ok: false, error: { code: 'needs-confirm', message: 'neutralize requires confirm:true when not a dry run' } } }
      }
      return { status: 200, value: neutralizeMissingBundles(ctx, { dryRun }) }
    },
  }
}

/** 静态文件服务（限定在 webui 目录内）。 */
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname
  // 防目录穿越：拒绝任何 `..` 段。
  if (rel.includes('..')) { res.writeHead(400); res.end('bad path'); return }
  const file = join(WEBUI, rel)
  if (!file.startsWith(WEBUI)) { res.writeHead(400); res.end('bad path'); return }
  if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return }
  try {
    const body = readFileSync(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch (error) {
    res.writeHead(500); res.end(String(error?.message ?? error))
  }
}

/**
 * 启动服务器。
 * @param {{ ctx?: object, port?: number, open?: boolean, quiet?: boolean }} options
 * @returns {Promise<{ url: string, token: string, close: () => Promise<void> }>}
 */
export function startServer(options = {}) {
  const ctx = options.ctx ?? resolveContext({})
  const port = options.port ?? 14711
  const tokenInfo = ensureToken(ctx)
  const token = tokenInfo.token
  const routes = buildRoutes(ctx)

  const server = createServer(async (req, res) => {
    let url
    try {
      url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    } catch {
      res.writeHead(400); res.end('bad url'); return
    }
    const pathname = url.pathname

    // 健康探针不需要 token（用于判断服务是否起来了），但不泄露任何信息。
    if (pathname === '/ping') { sendJson(res, 200, { ok: true, value: 'pong' }); return }

    // 静态页本身不校验 token（否则浏览器打不开页面），
    // 但页面里没有任何数据——所有数据都要带 token 调 API。
    if (!pathname.startsWith('/api/')) { serveStatic(res, pathname); return }

    const provided = tokenOf(req, url)
    if (!safeEqual(provided ?? '', token)) {
      sendJson(res, 401, { ok: false, error: { code: 'unauthorized', message: 'missing or wrong token' } })
      return
    }

    const key = `${req.method} ${pathname}`
    const handler = routes[key]
    if (!handler) {
      sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `no route for ${key}` } })
      return
    }
    try {
      const r = await handler(req, url)
      // handler 一律返回 `{ status, value }`。**不要**靠「结果里有 ok 字段」
      // 来猜它是不是信封——健康报告、git 结果本身都带 `ok` 字段，那样会把
      // 裸数据误当成信封，前端拿到 undefined（曾导致健康页空白）。
      // 需要裸数据的端点自己用 `{ value }` 包一层即可。
      const status = r?.status ?? 200
      const value = r !== null && typeof r === 'object' && 'value' in r ? r.value : r
      sendJson(res, status, { ok: true, value })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: { code: 'handler-error', message: String(error?.message ?? error) } })
    }
  })

  return new Promise((resolve, reject) => {
    // 端口被占用时给出可执行的提示，而不是把 EADDRINUSE 当未捕获异常抛出去
    // （双击 dcm.bat 时窗口会一闪而过，用户只看到「开不了」）。
    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        reject(new Error(
          `端口 ${port} 已被占用。\n`
          + `  · 如果那是本工具的旧实例，直接访问 http://127.0.0.1:${port}/ 即可；\n`
          + `  · 想换端口：dcm serve --port ${port + 1}`,
        ))
        return
      }
      reject(error)
    })
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${port}/?token=${token}`
      if (options.quiet !== true) {
        console.log('')
        console.log('  dsh-config-manager — 外部配置管理 UI')
        console.log(`  profile : ${ctx.profile}`)
        console.log(`  home    : ${ctx.home}`)
        console.log(`  打开    : ${url}`)
        console.log(`  token   : 已写入 ${tokenInfo.path}${tokenInfo.created ? ' (新建)' : ''}`)
        console.log('')
        console.log('  这个 UI 能改写 profile 配置，请勿把上面的链接分享出去。')
        console.log('  按 Ctrl+C 停止。')
        console.log('')
      }
      if (options.open === true) {
        // 尽力打开浏览器；打不开不影响服务。
        try {
          const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
          const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
          spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()
        } catch { /* 忽略 */ }
      }
      resolve({
        url,
        token,
        server,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}
