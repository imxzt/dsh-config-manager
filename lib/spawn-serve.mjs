/**
 * spawn-serve.mjs — 从宿主半区拉起外部 UI 服务器（分离进程）。
 *
 * **为什么需要这个模块**：外部 UI 是独立服务器（`lib/server.mjs`），而客户端
 * 半区跑在浏览器/Electron 渲染进程里，**没有执行本机 `.bat` 的能力**——
 * `window.open('file:///…/dcm.bat')` 只会下载或报错。启动本机进程这件事只能
 * 由宿主半区做，所以「打开完整 UI」按钮的语义是：先 POST 宿主半区的 `/serve`
 * 让宿主把服务器拉起来，拿到带 token 的 URL 后再由浏览器打开。
 *
 * **为什么用 `detached` + `stdio:'ignore'` 而不是管道**：
 * - 分离进程必须比 DSH 活得久（DSH 崩了它还得在，这正是本工具的场景），
 *   所以 `unref()` 掉、不随父进程退出；
 * - 管道会把子进程绑在父进程的 stdio 生命周期上，DSH 重启时留下悬空句柄；
 * - 顺带避开受限环境对管道式 spawn 的拒绝（`spawnSync … EPERM`）。
 *
 * 本模块**不 import 任何 npm 依赖**：外部 UI 要在 DSH 崩溃时可用，多一个
 * 依赖就多一个坏点。
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join } from 'node:path'

/** 外部 UI 的默认端口（与 lib/server.mjs、bin/dcm.mjs 保持一致）。 */
export const DEFAULT_PORT = 14711

/**
 * 该 home 下 DSH 自带运行时的 node 可执行文件。
 *
 * 与 `dcm.bat` 用同一套推导顺序（`<home>/dsh-runtimes/*`），因此不写死任何
 * 用户路径；运行时目录按名字排序取最新的一个。
 *
 * @param {string} home - DSH home。
 * @param {string} [platform] - 目标平台，默认当前平台。
 * @returns {string[]} 存在的 node 可执行文件绝对路径（可能为空）。
 */
export function bundledNodeCandidates(home, platform = process.platform) {
  const runtimes = join(home, 'dsh-runtimes')
  let names
  try {
    names = readdirSync(runtimes, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
  const exeNames = platform === 'win32' ? ['node.exe', 'node'] : ['node', 'node.exe']
  const out = []
  for (const name of names) {
    for (const exe of exeNames) {
      const candidate = join(runtimes, name, 'dependencies', 'node', 'bin', exe)
      if (existsSync(candidate)) out.push(candidate)
    }
  }
  return out
}

/**
 * 决定用什么可执行文件、什么参数、什么环境去跑 `bin/dcm.mjs serve`。
 *
 * 优先级（纯函数，便于自测）：
 *   1. DSH 自带运行时（最稳：版本与 DSH 自身一致，且不依赖 PATH）；
 *   2. Electron 自身加 `ELECTRON_RUN_AS_NODE=1`（宿主是 Electron 主进程时
 *      `process.execPath` 是 GUI 可执行文件，必须带这个变量才当 node 用）；
 *   3. PATH 里的 `node`。
 *
 * @param {object} [options]
 * @returns {{ cmd: string, args: string[], env: Record<string,string>, via: string }}
 */
export function resolveLaunch(options = {}) {
  const {
    script,
    port = DEFAULT_PORT,
    bundled = [],
    execPath = process.execPath,
    isElectron = process.versions.electron !== undefined,
    noOpen = true,
  } = options
  const args = [script, 'serve', '--port', String(port)]
  if (noOpen) args.push('--no-open')
  if (bundled.length > 0) return { cmd: bundled[0], args, env: {}, via: 'bundled-node' }
  if (isElectron) return { cmd: execPath, args, env: { ELECTRON_RUN_AS_NODE: '1' }, via: 'electron-as-node' }
  return { cmd: 'node', args, env: {}, via: 'path-node' }
}

/** 外部 UI 的带 token 地址（token 是唯一认证输入）。 */
export function urlFor(port, token) {
  const base = `http://127.0.0.1:${port}/`
  return typeof token === 'string' && token !== '' ? `${base}?token=${encodeURIComponent(token)}` : base
}

/**
 * 读取外部 UI 的 token（`lib/server.mjs` 的 `ensureToken` 写下的那个）。
 *
 * 服务器还没跑过时文件不存在——此时返回 null，由调用方决定是等待还是报错。
 *
 * @param {{ stateDir: string }} ctx - core 的 context。
 * @returns {string|null} token，或 null。
 */
export function readToken(ctx) {
  try {
    const t = readFileSync(join(ctx.stateDir, '.token'), 'utf8').trim()
    return t.length >= 16 ? t : null
  } catch {
    return null
  }
}

/**
 * 探一次 `/ping`：服务器是否已经在跑。
 *
 * `/ping` 刻意不需要 token（`lib/server.mjs` 如此设计），所以可以安全地用作
 * 存活探针，且不泄露任何信息。
 *
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function probeServer(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    let req
    try {
      req = request(
        { host: '127.0.0.1', port, path: '/ping', method: 'GET', timeout: timeoutMs },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (c) => { body += c })
          res.on('end', () => done(res.statusCode === 200 && body.includes('pong')))
          res.on('error', () => done(false))
        },
      )
    } catch {
      done(false)
      return
    }
    req.on('timeout', () => { req.destroy(); done(false) })
    req.on('error', () => done(false))
    req.end()
  })
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 确保外部 UI 在跑：已在跑就直接返回地址；没跑就分离式拉起来并等它就绪。
 *
 * 这是 `/serve` 路由的全部逻辑，也是「打开完整 UI」按钮真正需要的能力。
 *
 * @param {{ stateDir: string, home: string }} ctx - core 的 context。
 * @param {object} [options]
 * @param {number}   [options.port]        端口。
 * @param {string}   [options.script]      `bin/dcm.mjs` 的绝对路径。
 * @param {number}   [options.waitMs]      拉起后等待就绪的上限。
 * @param {Function} [options.spawnFn]     注入点，默认 `child_process.spawn`（便于自测）。
 * @param {Function} [options.probeFn]     注入点，默认 {@link probeServer}。
 * @returns {Promise<object>} `{ ok, alreadyRunning, started, port, url, token, via?, error? }`
 */
export async function ensureServer(ctx, options = {}) {
  const port = options.port ?? DEFAULT_PORT
  const probeFn = options.probeFn ?? probeServer
  const spawnFn = options.spawnFn ?? spawn

  if (await probeFn(port, options.probeTimeoutMs ?? 500)) {
    const token = readToken(ctx)
    return { ok: true, alreadyRunning: true, started: false, port, token, url: urlFor(port, token) }
  }

  const launch = resolveLaunch({
    script: options.script,
    port,
    bundled: options.bundled ?? bundledNodeCandidates(ctx.home),
    execPath: options.execPath,
    isElectron: options.isElectron,
    noOpen: options.noOpen !== false,
  })

  let child
  try {
    child = spawnFn(launch.cmd, launch.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: dirname(options.script ?? '.'),
      env: { ...process.env, ...launch.env },
    })
    // 分离进程必须比 DSH 活得久；不 unref 会随父进程退出被带走。
    child.unref?.()
  } catch (error) {
    return {
      ok: false,
      alreadyRunning: false,
      started: false,
      port,
      via: launch.via,
      error: `spawn failed: ${error?.message ?? error}`,
    }
  }

  const waitMs = options.waitMs ?? 5000
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await delay(150)
    if (await probeFn(port, 250)) {
      const token = readToken(ctx)
      return { ok: true, alreadyRunning: false, started: true, port, token, url: urlFor(port, token), via: launch.via }
    }
  }

  return {
    ok: false,
    alreadyRunning: false,
    started: true,
    port,
    via: launch.via,
    error: `外部 UI 已在后台启动，但 ${Math.round(waitMs / 1000)} 秒内没有应答 /ping；请稍后手动刷新，或查看 ${join(ctx.stateDir, 'plugin.log')}`,
  }
}