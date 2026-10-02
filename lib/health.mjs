/**
 * health.mjs — profile 健康诊断（B 项）。
 *
 * 每一项都对应一次**真实发生过的事故**，不是假想的检查：
 *  - bundle 可解析性   → 2026-10-03 profile 重置事故（声明了但磁盘没有 → 启动硬失败）
 *  - 目录联接健康      → pnpm install 把 file: 依赖换成实体副本，破坏改源码即时生效
 *  - bundles/deps 一致性 → 孤儿声明与孤儿依赖
 *  - lockfile 一致性   → 依赖树与锁定文件漂移
 *  - manifest 语法/BOM → DSH 在 JSON.parse 前就中止
 *  - patch 挂载重复    → 重复 insert 行导致组合失败
 *
 * 所有检查都是**只读**的：诊断绝不修改任何文件。
 */

import { existsSync, readFileSync, lstatSync, readlinkSync } from 'node:fs'
import { join, basename } from 'node:path'
import {
  declaredBundles, declaredDependencies, readProfileManifest,
} from './paths.mjs'

/** 严重度：err 会导致启动失败；warn 是隐患；info 是事实陈述。 */
export const SEVERITY = { ERR: 'err', WARN: 'warn', INFO: 'info' }

/**
 * 这些前缀的 bundle 由 DSH 安装包（app.asar）提供，**不在 profile 的
 * node_modules 里**，因此不能按 profile 解析结果判定失败。
 *
 * 这正是 dsh-undo-savepoint 0.4.9 的 doctor 恒误报的根因：它的
 * `bundleAnchors()` 只锚 `$DSH_HOME` 与 profile 目录，缺 DSH 安装锚点，
 * 于是每个 `@deepseek-ai/*` 都被判为 cannot resolve。真实加载器
 * （dsh-app-boot 的 `resolveBundleDir`）是「安装锚点优先、profile 兜底」。
 */
const HOST_PROVIDED_PREFIXES = ['@deepseek-ai/']

/** 该 bundle 名是否由 DSH 安装包提供。 */
export function isHostProvided(bundleName) {
  return HOST_PROVIDED_PREFIXES.some((p) => bundleName.startsWith(p))
}

/**
 * web profile 模板的 bundles —— DSH 恢复流程会把损坏 profile 重置成这个形状
 * （见 dsh-app-boot 的 `PROFILE_TEMPLATES.web`）。用于识别「被重置」。
 */
export const TEMPLATE_BUNDLE_NAMES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** profile patch 被重置后必然出现的 DSH 自管条目。 */
export const TEMPLATE_PATCH_MARKERS = [
  'ui-settings-account', 'ui-chat', 'ui-settings', 'agent-default-model',
]

/** 读一个包的 package.json（失败返回 null）。 */
function readPackageJson(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 该包声明的 bundle patch 文件（可能是字符串或数组），返回绝对路径列表。 */
function bundlePatchPaths(pkg, dir) {
  const raw = pkg?.dsh?.bundle?.patch
  if (typeof raw === 'string' && raw !== '') return [join(dir, raw)]
  if (Array.isArray(raw)) return raw.filter((x) => typeof x === 'string' && x !== '').map((x) => join(dir, x))
  return []
}

/**
 * 检查 1：每个声明的 bundle 是否真的可解析。
 *
 * 这是**最要命的一项**：一个指向已删除包的 bundle 会让下次启动时
 * `resolveBundleDir()` 抛错，DSH 随即触发 profile 恢复，把 bundles 重置成
 * 模板、cordis.patch.yml 覆盖成模板，全部插件配置静默丢失。
 */
export function checkBundles(ctx, manifest) {
  const items = []
  for (const name of declaredBundles(manifest)) {
    if (typeof name !== 'string' || name === '') {
      items.push({ severity: SEVERITY.ERR, bundle: String(name), message: 'non-string bundle entry' })
      continue
    }
    if (isHostProvided(name)) {
      items.push({ severity: SEVERITY.INFO, bundle: name, message: 'provided by the DSH installation (app.asar), not resolvable from the profile by design' })
      continue
    }
    const dir = join(ctx.profileNodeModules, ...name.split('/'))
    if (!existsSync(dir)) {
      items.push({
        severity: SEVERITY.ERR,
        bundle: name,
        message: 'package missing from node_modules — the next DSH start will fail and reset this profile',
        remedy: `remove "${name}" from dsh.profile.bundles, or run pnpm install in ${ctx.profileDir}`,
      })
      continue
    }
    const pkg = readPackageJson(dir)
    if (pkg === null) {
      items.push({ severity: SEVERITY.ERR, bundle: name, message: 'package.json missing or invalid at the declared location' })
      continue
    }
    const patches = bundlePatchPaths(pkg, dir)
    if (patches.length === 0) {
      items.push({
        severity: SEVERITY.ERR,
        bundle: name,
        message: 'package declares no dsh.bundle.patch — it is a dependency, not a bundle',
        remedy: 'remove it from dsh.profile.bundles and keep it in dependencies',
      })
      continue
    }
    const missing = patches.filter((p) => !existsSync(p))
    if (missing.length > 0) {
      items.push({ severity: SEVERITY.ERR, bundle: name, message: `dsh.bundle.patch file missing: ${missing.join(', ')}` })
      continue
    }
    items.push({ severity: SEVERITY.INFO, bundle: name, message: `resolvable (patch: ${patches.map((p) => basename(p)).join(', ')})` })
  }
  return { id: 'bundles', title: 'Bundle resolvability', items }
}

/**
 * 检查 2：`file:` 依赖的目录联接是否仍然是指向源码的联接。
 *
 * pnpm install 会把 `file:` 依赖物化成实体副本，于是「改 ~/.dsh/plugins/<x>
 * 的源码即时生效」这条契约静默失效——你会改源码却看不到任何变化。
 */
export function checkLinks(ctx, manifest) {
  const items = []
  for (const [dep, spec] of Object.entries(declaredDependencies(manifest))) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue
    const target = spec.slice('file:'.length)
    const linkPath = join(ctx.profileNodeModules, ...dep.split('/'))
    if (!existsSync(linkPath)) {
      items.push({ severity: SEVERITY.WARN, dep, message: `file: dependency has no entry in node_modules (${linkPath})` })
      continue
    }
    const link = inspectLink(linkPath, target)
    if (link.kind === 'junction') {
      items.push({ severity: SEVERITY.INFO, dep, message: `junction → ${link.target}` })
    } else if (link.kind === 'symlink') {
      items.push({ severity: SEVERITY.INFO, dep, message: `symlink → ${link.target}` })
    } else {
      items.push({
        severity: SEVERITY.WARN,
        dep,
        message: 'entry is a real directory copy, not a link — edits to the source no longer take effect',
        remedy: `re-create the link: remove "${linkPath}" (a junction must NOT be removed with -Recurse), then link it to "${target}"`,
        linkPath, target,
      })
    }
  }
  return { id: 'links', title: 'file: dependency links', items }
}

/**
 * 判定一个路径是 junction、symlink 还是实体目录，并解析其目标。
 *
 * Windows 上 junction 的 `isSymbolicLink()` 为 false，但 `readlinkSync`
 * 仍能读出目标；实体目录读 link 会抛错。两者合起来足以区分。
 */
export function inspectLink(linkPath, expectedTarget) {
  let realTarget = null
  try {
    realTarget = readlinkSync(linkPath)
  } catch {
    return { kind: 'directory', target: null }
  }
  // Windows 的 readlink 可能返回 `\\?\C:\...` 形式，规范化后再比较。
  const norm = (s) => (s ?? '').replace(/^\\\\\?\\/, '').replace(/[\\/]+$/, '').toLowerCase()
  const matched = norm(realTarget) === norm(expectedTarget)
  let isSymlink = false
  try { isSymlink = lstatSync(linkPath).isSymbolicLink() } catch { /* 忽略 */ }
  return {
    kind: isSymlink ? 'symlink' : 'junction',
    target: realTarget,
    matched,
  }
}

/**
 * 检查 3：bundles 与 dependencies 的一致性。
 *  - 在 bundles 里但不在 dependencies：孤儿声明（可能是 link: 或遗漏）
 *  - 在 dependencies 里但不在 bundles：只是依赖，正常；但若它声明了
 *    dsh.bundle.patch 却未被选中，值得提示（可能忘了启用）
 */
export function checkConsistency(ctx, manifest) {
  const bundles = declaredBundles(manifest).filter((b) => typeof b === 'string')
  const deps = declaredDependencies(manifest)
  const items = []

  for (const b of bundles) {
    if (isHostProvided(b)) continue
    if (!(b in deps)) {
      items.push({
        severity: SEVERITY.WARN,
        bundle: b,
        message: 'listed in dsh.profile.bundles but not in dependencies',
        remedy: 'add it to dependencies, or remove it from bundles',
      })
    }
  }

  for (const dep of Object.keys(deps)) {
    if (isHostProvided(dep)) continue
    if (bundles.includes(dep)) continue
    const dir = join(ctx.profileNodeModules, ...dep.split('/'))
    if (!existsSync(dir)) continue
    const pkg = readPackageJson(dir)
    if (pkg !== null && bundlePatchPaths(pkg, dir).length > 0) {
      items.push({
        severity: SEVERITY.INFO,
        dep,
        message: 'installed and declares a bundle patch but is not selected in dsh.profile.bundles',
      })
    }
  }

  if (items.length === 0) items.push({ severity: SEVERITY.INFO, message: 'bundles and dependencies agree' })
  return { id: 'consistency', title: 'Bundles ↔ dependencies', items }
}

/**
 * 检查 4：lockfile 是否与 manifest 同步。
 * 用一个便宜的判据：lockfile 里是否出现每个依赖名。
 */
export function checkLockfile(ctx, manifest) {
  const items = []
  if (!existsSync(ctx.profileLock)) {
    items.push({ severity: SEVERITY.WARN, message: 'pnpm-lock.yaml is missing — dependency state cannot be verified' })
    return { id: 'lockfile', title: 'Lockfile sync', items }
  }
  let text
  try {
    text = readFileSync(ctx.profileLock, 'utf8')
  } catch (error) {
    items.push({ severity: SEVERITY.WARN, message: `pnpm-lock.yaml unreadable: ${String(error?.message ?? error)}` })
    return { id: 'lockfile', title: 'Lockfile sync', items }
  }
  const missing = Object.keys(declaredDependencies(manifest)).filter((dep) => !text.includes(dep))
  if (missing.length > 0) {
    items.push({
      severity: SEVERITY.WARN,
      message: `declared but absent from the lockfile: ${missing.join(', ')}`,
      remedy: 'run pnpm install to resync the lockfile',
    })
  } else {
    items.push({ severity: SEVERITY.INFO, message: 'every declared dependency appears in the lockfile' })
  }
  return { id: 'lockfile', title: 'Lockfile sync', items }
}

/**
 * 检查 7：profile 是否处于「被恢复流程重置」的形状。
 *
 * **这是演练暴露的漏报。** 重置后的 profile 只有 2 个 bundle、依赖为空，
 * 而那 2 个都是 `@deepseek-ai/*`（由安装包提供）——于是「bundle 可解析」
 * 与「bundles↔dependencies」两项全部通过，健康检查报 0 错误 0 警告，
 * 而实际上用户的 18 个插件配置已经全丢了。
 *
 * 判据与 crash.mjs 的 looksReset 一致，但这里以**健康检查项**的形式呈现，
 * 让「配置被重置」在健康页就可见，不必等到看崩溃评估。
 */
export function checkResetShape(ctx, manifest) {
  const items = []
  const bundles = declaredBundles(manifest)
  const deps = Object.keys(declaredDependencies(manifest))

  const onlyTemplate = bundles.length > 0
    && bundles.length <= TEMPLATE_BUNDLE_NAMES.length
    && bundles.every((b) => TEMPLATE_BUNDLE_NAMES.includes(b))

  let patchLines = 0
  let hasMarkers = false
  if (existsSync(ctx.profilePatch)) {
    try {
      const text = readFileSync(ctx.profilePatch, 'utf8')
      patchLines = text.split('\n').length
      hasMarkers = TEMPLATE_PATCH_MARKERS.every((m) => text.includes(m))
    } catch { /* 忽略 */ }
  }

  if (onlyTemplate && patchLines > 0 && patchLines <= 40 && hasMarkers) {
    items.push({
      severity: SEVERITY.ERR,
      message: `profile is in the template shape (${bundles.length} bundles, ${patchLines} patch lines) — DSH's recovery flow reset it after a failed start`,
      remedy: 'restore the profile from a git restore point: dcm recover --yes  (or use the external UI)',
    })
  } else {
    items.push({
      severity: SEVERITY.INFO,
      message: `${bundles.length} bundles, ${deps.length} dependencies, ${patchLines || 'no'} patch lines — not in the template shape`,
    })
  }
  return { id: 'reset-shape', title: 'Profile reset shape', items }
}

/** 检查 5：profile patch 的挂载重复与悬空 insert。
 *
 * 重复 insert 同一插件会因路由重复注册而组合失败；`- insert:` 后没有
 * 子项则是历史 bug（undo-savepoint 的 dedup 曾留下悬空 insert）。
 */
export function checkPatch(ctx) {
  const items = []
  if (!existsSync(ctx.profilePatch)) {
    items.push({ severity: SEVERITY.INFO, message: 'profile has no cordis.patch.yml (nothing to check)' })
    return { id: 'patch', title: 'Profile patch', items }
  }
  let text
  try {
    text = readFileSync(ctx.profilePatch, 'utf8')
  } catch (error) {
    items.push({ severity: SEVERITY.ERR, message: `cordis.patch.yml unreadable: ${String(error?.message ?? error)}` })
    return { id: 'patch', title: 'Profile patch', items }
  }

  const lines = text.split('\n')
  const insertIds = []
  let danglingInsert = null
  /** 每个 insert 块内的 id 计数（只有块内重复才是真问题）。 */
  const inInsertCount = new Map()
  let insertIndent = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const indent = line.length - line.trimStart().length
    const insertMatch = /^(\s*)-\s+insert:\s*$/.exec(line)
    if (insertMatch) {
      // 下一个非空行必须是更深缩进的列表项，否则是悬空 insert。
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j += 1
      if (j >= lines.length || !/^\s+-\s+/.test(lines[j])) danglingInsert = i + 1
      insertIndent = indent
      continue
    }
    // 只认**顶层**（缩进 0）的 `- id:` 为 patch 条目 id。
    // 更深的 `- id:` 属于条目的 config 内容（例如 llm provider 的 models 列表），
    // 把它们当 patch id 会产生误报。
    const topId = /^-\s+id:\s*(\S+)/.exec(line)
    if (topId) {
      insertIds.push(topId[1])
      insertIndent = -1
      continue
    }
    // insert 块内更深缩进的 `- id:`
    if (insertIndent >= 0 && indent > insertIndent) {
      const innerId = /^\s+-\s+id:\s*(\S+)/.exec(line)
      if (innerId) inInsertCount.set(innerId[1], (inInsertCount.get(innerId[1]) ?? 0) + 1)
    }
  }

  if (danglingInsert !== null) {
    items.push({ severity: SEVERITY.ERR, line: danglingInsert, message: '`- insert:` with no child entries' })
  }

  // 只有 insert 块内的重复会导致「重复挂载」（组合期报 duplicate route）。
  // 顶层条目的重复是 DSH 的覆盖机制：后面的覆盖前面的，合法且常用。
  for (const [id, n] of inInsertCount) {
    if (n > 1) {
      items.push({
        severity: SEVERITY.ERR,
        message: `plugin "${id}" is inserted ${n} times — a second mount fails the composition on duplicate routes`,
        remedy: 'keep exactly one insert row for this plugin',
      })
    }
  }

  if (items.length === 0) {
    const topDup = countDuplicates(insertIds)
    items.push({
      severity: SEVERITY.INFO,
      message: topDup.length === 0
        ? `${insertIds.length} top-level patch entries, no dangling inserts`
        : `${insertIds.length} top-level patch entries; ${topDup.join(', ')} appear more than once (later entries override earlier ones — normal DSH behaviour)`,
    })
  }
  return { id: 'patch', title: 'Profile patch', items }
}

/** 返回出现次数 >1 的值。 */
function countDuplicates(values) {
  const seen = new Map()
  for (const v of values) seen.set(v, (seen.get(v) ?? 0) + 1)
  return [...seen.entries()].filter(([, n]) => n > 1).map(([v, n]) => `${v}×${n}`)
}

/**
 * 检查 6：manifest 自身的可读性与结构。
 */
export function checkManifest(ctx) {
  const items = []
  const read = readProfileManifest(ctx)
  if (!read.ok) {
    const severity = read.code === 'missing' ? SEVERITY.ERR : SEVERITY.ERR
    items.push({ severity, message: `profile manifest: ${read.message}` })
    return { id: 'manifest', title: 'Profile manifest', items }
  }
  const bundles = declaredBundles(read.value)
  if (!Array.isArray(read.value?.dsh?.profile?.bundles)) {
    items.push({ severity: SEVERITY.ERR, message: 'dsh.profile.bundles is missing or not an array' })
  } else {
    items.push({ severity: SEVERITY.INFO, message: `${bundles.length} bundles declared, ${Object.keys(declaredDependencies(read.value)).length} dependencies` })
  }
  return { id: 'manifest', title: 'Profile manifest', items }
}

/**
 * 跑全部检查。返回整体判定与分组结果。
 *
 * `blocking` 为 true 表示「现在重启有风险」——外部 UI 的启动预检门用它。
 */
export function runAll(ctx) {
  const read = readProfileManifest(ctx)
  const manifest = read.ok ? read.value : null

  const checks = [
    checkManifest(ctx),
    manifest === null ? { id: 'bundles', title: 'Bundle resolvability', items: [{ severity: SEVERITY.ERR, message: 'skipped: profile manifest unreadable' }] } : checkBundles(ctx, manifest),
    manifest === null ? { id: 'consistency', title: 'Bundles ↔ dependencies', items: [] } : checkConsistency(ctx, manifest),
    manifest === null ? { id: 'reset-shape', title: 'Profile reset shape', items: [] } : checkResetShape(ctx, manifest),
    manifest === null ? { id: 'lockfile', title: 'Lockfile sync', items: [] } : checkLockfile(ctx, manifest),
    checkLinks(ctx, manifest ?? {}),
    checkPatch(ctx),
  ]

  let errors = 0
  let warnings = 0
  for (const c of checks) {
    for (const it of c.items) {
      if (it.severity === SEVERITY.ERR) errors += 1
      else if (it.severity === SEVERITY.WARN) warnings += 1
    }
  }

  return {
    ok: errors === 0,
    blocking: errors > 0,
    errors,
    warnings,
    checks,
    ctx: { home: ctx.home, profile: ctx.profile, profileDir: ctx.profileDir },
  }
}
