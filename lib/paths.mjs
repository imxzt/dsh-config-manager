/**
 * paths.mjs — DSH 路径解析（core 的唯一路径真源）。
 *
 * 所有其它模块都必须经这里取路径，不要在别处拼字符串：桌面版 / CLI / Web
 * 三种启动方式的 profile 判定不同，散落的拼接必然漂移。
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, readFileSync, readdirSync } from 'node:fs'

/**
 * 解析 Harness home，与 `@deepseek-ai/dsh-home-paths` 的文档口径一致：
 * 显式覆盖 → `$DSH_HOME` → `<os home>/.dsh`。
 */
export function resolveDshHome(override) {
  const raw = (override ?? process.env.DSH_HOME ?? '').trim()
  const home = raw === '' ? join(homedir(), '.dsh') : raw.replace(/^~(?=$|[\\/])/, homedir())
  return resolve(home)
}

/**
 * 解析当前 profile 名。
 *
 * **这里是本工具与 dsh-undo-savepoint 0.4.9 的关键差异。** 那个插件只解析
 * `process.argv` 的 `--profile`，桌面版由 Electron 启动、argv 里没有该参数，
 * 于是兜底成硬编码的 `web`，导致 profile 快照全程保护闲置的 web profile。
 * 本工具的优先级链：
 *   显式 override → `$DSH_PROFILE` → argv `--profile` → argv 里的 profile 目录
 *   → 唯一存在的 profile 目录 → 'desktop'
 *
 * 注意 `$DSH_PROFILE` 只在 shell 子进程里被注入（dsh-shell-env 按每次模型
 * shell 调用构建），宿主进程读不到；因此它只对**外部 CLI 入口**有效，
 * 页面内插件必须走显式 override。
 */
export function resolveProfileName(override, argv = process.argv, options = {}) {
  const explicit = (override ?? '').trim()
  if (explicit !== '') return explicit

  // env 可被显式屏蔽：测试与「外部入口指定 profile」都需要绕过宿主注入的值。
  const useEnv = options.useEnv !== false
  const env = useEnv ? (process.env.DSH_PROFILE ?? '').trim() : ''
  if (env !== '') return env

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile' && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1]
    if (a.startsWith('--profile=')) return a.slice('--profile='.length)
  }

  // 桌面宿主把 profile 目录作为位置参数传给 dsh-desktop-host，形如
  // `<home>/profiles/desktop`。这是 #43/#44 里作者认可的次级启发式。
  for (const a of argv) {
    if (typeof a !== 'string') continue
    const m = /[\\/]profiles[\\/]([^\\/]+)[\\/]?$/.exec(a)
    if (m) return m[1]
  }

  const dirs = listProfileDirs(override)
  if (dirs.length === 1) return dirs[0]
  if (dirs.includes('desktop')) return 'desktop'
  return dirs[0] ?? 'desktop'
}

/** `$DSH_HOME/profiles` 下的 profile 目录名（跳过共享 node_modules 与隐藏目录）。 */
export function listProfileDirs(homeOverride) {
  const base = join(resolveDshHome(homeOverride), 'profiles')
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * 组装一份完整的路径上下文。所有 core 模块都接收这个对象，不各自推导。
 * @param {{ home?: string, profile?: string, argv?: string[] }} [options]
 */
export function resolveContext(options = {}) {
  const home = resolveDshHome(options.home)
  const profile = resolveProfileName(options.profile, options.argv ?? process.argv, {
    useEnv: options.useEnv,
  })
  const profileDir = join(home, 'profiles', profile)
  return Object.freeze({
    home,
    profile,
    profileDir,
    profileManifest: join(profileDir, 'package.json'),
    profilePatch: join(profileDir, 'cordis.patch.yml'),
    profileLock: join(profileDir, 'pnpm-lock.yaml'),
    profileNodeModules: join(profileDir, 'node_modules'),
    compatibility: join(profileDir, 'compatibility.json'),
    homePatch: join(home, 'cordis.patch.yml'),
    sessionsRoot: join(home, 'sessions'),
    projectionCache: join(home, 'storages', 'session_projcache', 'sessions'),
    /**
     * 启动状态文件。**不要**放在 undo-snapshots 下——那是
     * dsh-undo-savepoint 的目录，插件移除后该目录不存在，读它永远失败。
     * 本工具自己的状态一律放 plugins/dsh-config-manager/ 下。
     */
    stateDir: join(home, 'plugins', 'dsh-config-manager'),
    backupsDir: join(home, 'backups'),
    pluginsDir: join(home, 'plugins'),
    /** git 仓库根：整个 home，与 dshcfg.ps1 用的是同一个仓库。 */
    repoRoot: home,
  })
}

/** 该 profile 是否存在（manifest 可读）。 */
export function profileExists(ctx) {
  return existsSync(ctx.profileManifest)
}

/**
 * 读 profile manifest。返回 null 表示文件缺失或不是合法 JSON 对象——
 * 调用方必须区分「缺失」与「损坏」，所以错误信息也一并返回。
 */
export function readProfileManifest(ctx) {
  let raw
  try {
    raw = readFileSync(ctx.profileManifest)
  } catch (error) {
    return { ok: false, code: 'missing', message: String(error?.message ?? error) }
  }
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
    return { ok: false, code: 'bom', message: 'profile manifest starts with a UTF-8 BOM; DSH aborts at JSON.parse' }
  }
  try {
    const value = JSON.parse(raw.toString('utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, code: 'shape', message: 'profile manifest must hold a JSON object' }
    }
    return { ok: true, value }
  } catch (error) {
    return { ok: false, code: 'json', message: String(error?.message ?? error) }
  }
}

/** profile manifest 里声明的 bundles（保持顺序）。 */
export function declaredBundles(manifest) {
  const bundles = manifest?.dsh?.profile?.bundles
  return Array.isArray(bundles) ? bundles : []
}

/** profile manifest 里声明的 dependencies。 */
export function declaredDependencies(manifest) {
  const deps = manifest?.dependencies
  return deps !== null && typeof deps === 'object' && !Array.isArray(deps) ? deps : {}
}
