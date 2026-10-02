/**
 * spawn-serve.test.mjs — 「打开完整 UI」按钮的启动逻辑自测。
 *
 * 用法：node test/spawn-serve.test.mjs
 *
 * 测试策略：**全部用注入点，不真的 spawn 进程、不真的连端口**。
 * `ensureServer` 的 `spawnFn` / `probeFn` 是为此留的注入点，因此这些断言
 * 在任何机器上都能跑、且不会留下游离进程。
 *
 * 关键回归点：
 *   - 已在跑时**不得**重复 spawn（否则每点一次按钮就多一个服务器）；
 *   - 未在跑时必须用 `detached` + `stdio:'ignore'`（分离进程要比 DSH 活得久）；
 *   - 拉起后**必须等就绪**再返回 URL，否则浏览器会开到连接被拒；
 *   - 超时不得谎报成功（`ok:false` 且带可读的 error）。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveLaunch, urlFor, readToken, ensureServer, bundledNodeCandidates, DEFAULT_PORT,
} from '../lib/spawn-serve.mjs'

let passed = 0
let failed = 0

function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ok   ${name}`) }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

function section(t) { console.log(`\n== ${t} ==`) }

/** 造一个带 .token 的临时 home。 */
function makeCtx() {
  const home = mkdtempSync(join(tmpdir(), 'dcm-spawn-'))
  const stateDir = join(home, 'plugins', 'dsh-config-manager')
  mkdirSync(stateDir, { recursive: true })
  return { home, stateDir, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

// ── resolveLaunch ───────────────────────────────────────────────────────

section('resolveLaunch：选哪个可执行文件')

{
  const r = resolveLaunch({ script: 'C:/x/dcm.mjs', bundled: ['C:/node/node.exe'] })
  check('优先用 DSH 自带运行时', r.cmd === 'C:/node/node.exe' && r.via === 'bundled-node', JSON.stringify(r))
  check('参数是 dcm.mjs serve --port <n>', r.args[0] === 'C:/x/dcm.mjs' && r.args[1] === 'serve' && r.args[2] === '--port', JSON.stringify(r.args))
  check('默认带 --no-open（浏览器由客户端自己开）', r.args.includes('--no-open'), JSON.stringify(r.args))
}

{
  const r = resolveLaunch({ script: 'C:/x/dcm.mjs', bundled: [], isElectron: true, execPath: 'C:/app/harness.exe' })
  check('无自带运行时时回退 Electron 自身', r.cmd === 'C:/app/harness.exe' && r.via === 'electron-as-node', JSON.stringify(r))
  check('Electron 回退必须带 ELECTRON_RUN_AS_NODE=1', r.env.ELECTRON_RUN_AS_NODE === '1', JSON.stringify(r.env))
}

{
  const r = resolveLaunch({ script: 'C:/x/dcm.mjs', bundled: [], isElectron: false })
  check('最后回退 PATH 里的 node', r.cmd === 'node' && r.via === 'path-node', JSON.stringify(r))
  check('PATH 回退不带多余环境变量', Object.keys(r.env).length === 0, JSON.stringify(r.env))
}

{
  const r = resolveLaunch({ script: 'C:/x/dcm.mjs', port: 20000, bundled: [], isElectron: false })
  check('端口可覆盖', r.args.includes('20000'), JSON.stringify(r.args))
}

{
  const r = resolveLaunch({ script: 'C:/x/dcm.mjs', bundled: [], isElectron: false, noOpen: false })
  check('noOpen=false 时不加 --no-open（保持双击 dcm.bat 的弹窗行为）', !r.args.includes('--no-open'), JSON.stringify(r.args))
}

// ── urlFor ──────────────────────────────────────────────────────────────

section('urlFor：带 token 的地址')

{
  check('带 token 时拼进 query', urlFor(14711, 'abc123') === 'http://127.0.0.1:14711/?token=abc123', urlFor(14711, 'abc123'))
  check('无 token 时退回裸地址', urlFor(14711, null) === 'http://127.0.0.1:14711/', urlFor(14711, null))
  check('token 被 URL 编码（防注入 query）', urlFor(1, 'a&b=c').includes('a%26b%3Dc'), urlFor(1, 'a&b=c'))
}

// ── readToken ───────────────────────────────────────────────────────────

section('readToken：读 .token')

{
  const ctx = makeCtx()
  check('没有 .token 时返回 null', readToken(ctx) === null, String(readToken(ctx)))
  writeFileSync(join(ctx.stateDir, '.token'), 'x'.repeat(48) + '\n')
  check('有 .token 时读出并去掉换行', readToken(ctx) === 'x'.repeat(48), String(readToken(ctx)))
  writeFileSync(join(ctx.stateDir, '.token'), 'short\n')
  check('过短的 token 视为无效（与 server.mjs 的 >=16 判据一致）', readToken(ctx) === null, String(readToken(ctx)))
  ctx.cleanup()
}

// ── bundledNodeCandidates ───────────────────────────────────────────────

section('bundledNodeCandidates：DSH 自带运行时')

{
  const home = mkdtempSync(join(tmpdir(), 'dcm-runtimes-'))
  check('没有 dsh-runtimes 时返回空数组', bundledNodeCandidates(home, 'win32').length === 0)
  mkdirSync(join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin'), { recursive: true })
  writeFileSync(join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'), '')
  const found = bundledNodeCandidates(home, 'win32')
  check('找到 node.exe 绝对路径', found.length === 1 && found[0].endsWith('node.exe'), JSON.stringify(found))
  rmSync(home, { recursive: true, force: true })
}

// ── ensureServer ────────────────────────────────────────────────────────

section('ensureServer：已在跑时不得重复启动')

{
  const ctx = makeCtx()
  writeFileSync(join(ctx.stateDir, '.token'), 'y'.repeat(48) + '\n')
  let spawnCalls = 0
  const result = await ensureServer(ctx, {
    probeFn: async () => true,
    spawnFn: () => { spawnCalls += 1; return { unref() {} } },
  })
  check('已在跑 => ok', result.ok === true)
  check('已在跑 => alreadyRunning=true', result.alreadyRunning === true, JSON.stringify(result))
  check('已在跑 => started=false', result.started === false, JSON.stringify(result))
  check('已在跑 => 一次都没 spawn（防每次点击多一个服务器）', spawnCalls === 0, String(spawnCalls))
  check('已在跑 => 返回带 token 的 URL', result.url.includes('token=' + 'y'.repeat(48)), result.url)
  ctx.cleanup()
}

section('ensureServer：未在跑时分离式启动并等就绪')

{
  const ctx = makeCtx()
  writeFileSync(join(ctx.stateDir, '.token'), 'z'.repeat(48) + '\n')
  let calls = 0
  const spawnArgs = []
  const result = await ensureServer(ctx, {
    // 第一次探活失败（未跑），之后成功（已就绪）。
    probeFn: async () => { calls += 1; return calls > 1 },
    spawnFn: (cmd, args, opts) => { spawnArgs.push({ cmd, args, opts }); return { unref() { spawnArgs[0].unrefed = true } } },
    waitMs: 3000,
    script: 'C:/x/dcm.mjs',
    bundled: ['C:/node/node.exe'],
  })
  check('启动成功 => ok', result.ok === true, JSON.stringify(result))
  check('启动成功 => started=true / alreadyRunning=false', result.started === true && result.alreadyRunning === false, JSON.stringify(result))
  check('启动成功 => 用的是分离进程', spawnArgs[0]?.opts?.detached === true, JSON.stringify(spawnArgs[0]?.opts))
  check('启动成功 => stdio=ignore（管道会绑住父进程生命周期）', spawnArgs[0]?.opts?.stdio === 'ignore', JSON.stringify(spawnArgs[0]?.opts))
  check('启动成功 => 调了 unref（要比 DSH 活得久）', spawnArgs[0]?.unrefed === true)
  check('启动成功 => 返回带 token 的 URL', result.url.includes('token=' + 'z'.repeat(48)), result.url)
  check('启动成功 => 报告启动方式', result.via === 'bundled-node', String(result.via))
  ctx.cleanup()
}

section('ensureServer：超时不得谎报成功')

{
  const ctx = makeCtx()
  const result = await ensureServer(ctx, {
    probeFn: async () => false,
    spawnFn: () => ({ unref() {} }),
    waitMs: 400,
    script: 'C:/x/dcm.mjs',
    bundled: ['C:/node/node.exe'],
  })
  check('超时 => ok=false（浏览器不能开到连接被拒的地址）', result.ok === false, JSON.stringify(result))
  check('超时 => 说明已启动但没应答', result.started === true, JSON.stringify(result))
  check('超时 => error 是可读文本', typeof result.error === 'string' && result.error.length > 0, String(result.error))
  ctx.cleanup()
}

section('ensureServer：spawn 抛错要结构化返回而不是崩')

{
  const ctx = makeCtx()
  const result = await ensureServer(ctx, {
    probeFn: async () => false,
    spawnFn: () => { throw new Error('EPERM: sandbox says no') },
    waitMs: 300,
    script: 'C:/x/dcm.mjs',
    bundled: ['C:/node/node.exe'],
  })
  check('spawn 失败 => ok=false', result.ok === false, JSON.stringify(result))
  check('spawn 失败 => 带上原始错误信息', String(result.error).includes('EPERM'), String(result.error))
  check('spawn 失败 => started=false（没起来就别说起来了）', result.started === false, JSON.stringify(result))
  ctx.cleanup()
}

section('常量')

{
  check('默认端口与 server.mjs / dcm.mjs 一致', DEFAULT_PORT === 14711, String(DEFAULT_PORT))
}

// ── 收尾 ────────────────────────────────────────────────────────────────

console.log(`\n结果: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)