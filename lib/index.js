/**
 * dsh-config-manager — Host half.
 *
 * 只做一件事：把 core 的能力通过 HTTP 暴露给页面内的客户端半区。
 * **逻辑一律不在这里实现**——全部 import 自 `../../lib/*.mjs`，与外部
 * UI 共用同一份 core。这是当初把核心逻辑从 PowerShell 重写成 Node 的
 * 唯一理由：两套 UI 不能各写一份逻辑，否则必然漂移。
 *
 * 路由前缀 `/dsh-config-manager/api`，与外部 UI 的 `/api/*` 不冲突。
 *
 * 注意：桌面版 Electron 下页面 origin 是 file://，但宿主注册的 prefix
 * 路由仍可通过相对路径 fetch 到达（dsh-session-delete 已实测如此）。
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveContext } from '../lib/paths.mjs'
import { runAll } from '../lib/health.mjs'
import { assess } from '../lib/crash.mjs'
import { listPlugins, preflight } from '../lib/plugins.mjs'
import { scanAll } from '../lib/sessions.mjs'
import * as gitlib from '../lib/git.mjs'

export const name = 'dsh-config-manager'

/** 只依赖 webserver；其余能力全部走 core 的文件/git 操作，不依赖宿主服务。 */
export const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-config-manager/api'

const here = fileURLToPath(new URL('.', import.meta.url))

/** 该插件自带的诊断日志路径。 */
function logPath(ctx) {
  return join(ctx.stateDir, 'plugin.log')
}

/**
 * 解析运行上下文。
 *
 * **必须显式传 profile**：宿主进程读不到 `$DSH_PROFILE`（那只由
 * dsh-shell-env 注入到模型 shell 子进程），而桌面版 argv 里没有
 * `--profile`。所以这里用 `ctx` 提供的宿主事实，拿不到才退回 core 的
 * 判定链。这正是 dsh-undo-savepoint 0.4.9 认错 profile 的地方。
 */
function contextFor(ctx) {
  const home = typeof ctx?.dshHome === 'string' && ctx.dshHome !== ''
    ? ctx.dshHome
    : (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME
      : undefined)
  return resolveContext({ home })
}

/** 统一 JSON 响应。 */
function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req, limit = 1024 * 1024) {
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
 * 信任围栏：webserver 自身无认证/同源策略，路由属主自负。
 * 与 dsh-session-delete 同款判据：Host 必须是回环、非 cross-site、
 * 若有 Origin 则 hostname 必须相同。
 */
function isTrustedRequest(req) {
  const host = String(req.headers.host ?? '')
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  const loopback = hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  if (!loopback) return false
  if (String(req.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      if (new URL(origin).hostname !== hostname) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * 路由表。与外部 UI 的语义保持一致，但只暴露页面内需要的读操作与
 * 一个「打开外部 UI」的提示——破坏性操作（恢复/摘除）引导到外部 UI，
 * 因为那些操作在 DSH 崩溃时才最需要，而页面内此时根本加载不了。
 */
function buildRoutes(ctx) {
  return {
    'GET /status': async () => {
      const c = contextFor(ctx)
      const health = runAll(c)
      const pf = preflight(c)
      const crash = assess(c)
      return {
        ctx: { home: c.home, profile: c.profile, profileDir: c.profileDir },
        health: { ok: health.ok, errors: health.errors, warnings: health.warnings },
        preflight: { safeToRestart: pf.safeToRestart, summary: pf.summary, blockers: pf.blockers },
        crash: { crashed: crash.crashed, confidence: crash.confidence, recommendation: crash.recommendation },
      }
    },

    'GET /health': async () => runAll(contextFor(ctx)),
    'GET /crash': async () => assess(contextFor(ctx)),
    'GET /plugins': async () => listPlugins(contextFor(ctx)),
    'GET /preflight': async () => preflight(contextFor(ctx)),
    'GET /sessions': async () => scanAll(contextFor(ctx).sessionsRoot),

    'GET /git/status': async () => gitlib.status(contextFor(ctx).repoRoot),
    'GET /git/log': async () => gitlib.log(contextFor(ctx).repoRoot, 15),

    /** 客户端半区的接线自检：区分「bundle 没跑」与「跑了但槽位不在」。 */
    'POST /ready': async (req) => {
      const body = JSON.parse((await readBody(req)) || '{}')
      const stage = typeof body.stage === 'string' ? body.stage : 'unknown'
      const detail = typeof body.detail === 'string' ? ` (${body.detail})` : ''
      ctx?.logger?.info?.(`[dsh-config-manager] client ready: ${stage}${detail}`)
      return { ok: true, value: { stage, at: new Date().toISOString() } }
    },
  }
}

/** Cordis plugin face。 */
export function apply(ctx) {
  const routes = buildRoutes(ctx)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      if (!isTrustedRequest(req)) {
        sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const method = pathname.slice(ROUTE_PREFIX.length)
      const key = `${req.method} ${method}`
      const handler = routes[key]
      if (!handler) {
        sendJson(res, 404, { ok: false, error: { code: 'not-found', message: `no route for ${key}` } })
        return
      }
      try {
        const value = await handler(req)
        sendJson(res, 200, { ok: true, value })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: { code: 'handler-error', message: String(error?.message ?? error) } })
      }
    },
  }), 'dsh-config-manager: status routes')

  ctx?.logger?.info?.('[dsh-config-manager] host half mounted')
}

/** 便于诊断：本插件的源码目录。 */
export const sourceDir = here