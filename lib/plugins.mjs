/**
 * plugins.mjs — 插件操作护栏（D 项）。
 *
 * **设计取舍**：不接管装卸本身。DSH 自带的 `plugin_manager` 服务已经用对了
 * 顺序（"removal deselects and unloads the bundle before pnpm runs"，
 * dsh-plugin-manager/README.md L92），重造轮子没有收益。本模块的价值在装卸
 * **前后**：
 *
 *   beforeChange()  改之前自动建还原点（这样任何失败都能一键回到原状）
 *   afterChange()   改之后强制预检（bundle 是否都还能解析）
 *   guard()         一步完成「打还原点 → 执行 → 预检 → 不合格就报警」
 *
 * 这样即使调用方是 DSH 自带的插件页、或手工编辑、或第三方工具，只要经这个
 * 护栏，2026-10-03 那次事故（声明了但磁盘没有 → 启动硬失败 → profile 被重置）
 * 就不会再静默发生。
 */

import { existsSync, readFileSync, lstatSync, readlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as gitlib from './git.mjs'
import { runAll, isHostProvided } from './health.mjs'
import {
  readProfileManifest, declaredBundles, declaredDependencies,
} from './paths.mjs'
import { assess, recover } from './crash.mjs'

/**
 * 已知有害或已实证会引发事故的插件。列在这里不是黑名单拦截，而是在清单与
 * 预检里**显著提示**——用户仍可选择安装，但会先看到风险说明。
 */
export const KNOWN_RISKY = {
  'dsh-conflict-guardian': {
    severity: 'err',
    reason: '安装时 pnpm 报告 +1 -26（连带移除 26 个包），并在 profile patch 插入 '
      + '`- id: session-delete, disabled: true` 禁用了既有插件；2026-10-03 触发过 profile 重置事故。'
      + '它保护的冲突并不存在，反而制造了「依赖声明与磁盘不一致」这一致命状态。',
  },
  'dsh-session-recycle-bin': {
    severity: 'warn',
    reason: '与本地插件 dsh-session-delete（硬删除）功能重叠，两者共存时行为可能冲突。',
  },
}

/**
 * 列出 profile 的插件总览：bundles、dependencies、磁盘实况三者对齐。
 *
 * 每项给出：名字、是否选中为 bundle、是否在依赖里、磁盘是否存在、是否可解析、
 * 是否有已知风险。
 */
export function listPlugins(ctx) {
  const read = readProfileManifest(ctx)
  if (!read.ok) return { ok: false, error: read.message, plugins: [] }
  const manifest = read.value
  const bundles = declaredBundles(manifest).filter((b) => typeof b === 'string')
  const deps = declaredDependencies(manifest)
  const names = new Set([...bundles, ...Object.keys(deps)])

  const plugins = []
  for (const name of [...names].sort()) {
    const selected = bundles.includes(name)
    const declared = name in deps
    const hostProvided = isHostProvided(name)
    const dir = join(ctx.profileNodeModules, ...name.split('/'))
    const onDisk = hostProvided ? null : existsSync(dir)

    let resolvable = null
    let patchFiles = []
    if (onDisk === true) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
        const raw = pkg?.dsh?.bundle?.patch
        patchFiles = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : []
        resolvable = patchFiles.length > 0 && patchFiles.every((p) => existsSync(join(dir, p.replace(/^\.\//, ''))))
      } catch {
        resolvable = false
      }
    }

    // 危险判定：这是核心——「选中为 bundle 但磁盘没有」正是事故成因
    let risk = null
    if (selected && onDisk === false) {
      risk = { severity: 'err', reason: 'selected as a bundle but missing from node_modules — the next DSH start will fail and reset this profile' }
    } else if (selected && resolvable === false && patchFiles.length === 0) {
      risk = { severity: 'err', reason: 'selected as a bundle but the package declares no dsh.bundle.patch' }
    } else if (selected && resolvable === false) {
      risk = { severity: 'err', reason: `selected as a bundle but its patch file is missing: ${patchFiles.join(', ')}` }
    } else if (KNOWN_RISKY[name]) {
      risk = KNOWN_RISKY[name]
    }

    // 目录联接状态（只对 file: 依赖有意义）
    let link = null
    if (onDisk === true && typeof deps[name] === 'string' && deps[name].startsWith('file:')) {
      link = inspectEntry(dir)
    }

    plugins.push({
      name, selected, declared, hostProvided, onDisk, resolvable, patchFiles,
      spec: deps[name] ?? null, risk, link,
    })
  }

  return {
    ok: true,
    profile: ctx.profile,
    counts: {
      total: plugins.length,
      selected: plugins.filter((p) => p.selected).length,
      risky: plugins.filter((p) => p.risk !== null).length,
    },
    plugins,
  }
}

/** 判定一个 node_modules 条目是联接还是实体副本。 */
function inspectEntry(dir) {
  let target = null
  try {
    // readlink 对 junction 与 symlink 都有效，对实体目录抛错——正好用来区分。
    target = readlinkSync(dir)
  } catch {
    return { kind: 'directory', target: null }
  }
  let isSymlink = false
  try { isSymlink = lstatSync(dir).isSymbolicLink() } catch { /* 忽略 */ }
  return { kind: isSymlink ? 'symlink' : 'junction', target }
}

/**
 * 变更前的护栏：建一个还原点。
 *
 * 即使当前工作区是脏的，也先把它存下来——这样「改之前是什么样」永远可查。
 */
export function beforeChange(ctx, description) {
  const label = `pre-change: ${description ?? 'plugin operation'}`
  const saved = gitlib.save(ctx.repoRoot, label)
  return {
    ok: saved.ok,
    snapshot: saved.committed ? { short: saved.short, hash: saved.hash, files: saved.files } : null,
    note: saved.committed
      ? `saved a restore point (${saved.short}) before the change`
      : 'working tree was already clean; the last restore point already covers this state',
    error: saved.ok ? undefined : saved.reason,
  }
}

/**
 * 变更后的护栏：强制预检。
 *
 * **不抛异常、不自动回滚**——只报告。自动回滚是危险动作，必须由用户决定
 * （或由 recover() 显式执行）。
 */
export function afterChange(ctx, options = {}) {
  const health = runAll(ctx)
  const plugins = listPlugins(ctx)
  const risky = plugins.ok ? plugins.plugins.filter((p) => p.risk?.severity === 'err') : []

  const blocking = health.blocking || risky.length > 0
  return {
    ok: !blocking,
    blocking,
    health: { ok: health.ok, errors: health.errors, warnings: health.warnings, report: health },
    riskyPlugins: risky,
    advice: blocking
      ? 'DO NOT restart DSH until this is resolved — a missing bundle makes DSH reset the whole profile on start.'
      : 'safe to restart',
    rollbackHint: blocking && options.snapshot
      ? `roll back with: dcm restore ${options.snapshot}`
      : undefined,
  }
}

/**
 * 一步式护栏：打还原点 → 执行操作 → 预检。
 *
 * @param {object} ctx
 * @param {string} description 这次变更的说明
 * @param {() => Promise<any>|any} operation 真正做变更的函数
 */
export async function guard(ctx, description, operation) {
  const before = beforeChange(ctx, description)
  let opResult = null
  let opError = null
  try {
    opResult = await operation()
  } catch (error) {
    opError = String(error?.message ?? error)
  }
  const after = afterChange(ctx, { snapshot: before.snapshot?.short })

  return {
    ok: opError === null && after.ok,
    before,
    operation: { result: opResult, error: opError },
    after,
  }
}

/**
 * 启动预检门：回答「现在重启安全吗」。
 *
 * 这是给用户/其它工具调用的单一判据——把健康检查、插件风险、崩溃痕迹
 * 合成一个是/否。
 */
export function preflight(ctx) {
  const health = runAll(ctx)
  const plugins = listPlugins(ctx)
  const crash = assess(ctx)

  const blockers = []
  for (const c of health.checks) {
    for (const item of c.items) {
      if (item.severity === 'err') blockers.push({ source: `health:${c.id}`, message: item.message, remedy: item.remedy })
    }
  }
  if (plugins.ok) {
    for (const p of plugins.plugins) {
      if (p.risk?.severity === 'err') blockers.push({ source: `plugin:${p.name}`, message: p.risk.reason })
    }
  }
  if (crash.crashed) {
    for (const s of crash.signals) {
      if (s.severity === 'err') blockers.push({ source: `crash:${s.kind}`, message: s.message })
    }
  }

  return {
    safeToRestart: blockers.length === 0,
    blockers,
    summary: blockers.length === 0
      ? 'no blockers: restarting DSH is safe'
      : `${blockers.length} blocker(s): restarting DSH now risks a profile reset`,
    health: { errors: health.errors, warnings: health.warnings },
    pluginCounts: plugins.ok ? plugins.counts : null,
    crash: { crashed: crash.crashed, confidence: crash.confidence, recommendation: crash.recommendation },
  }
}

/**
 * 一键修复「选中的 bundle 在磁盘上不存在」——即事故的直接成因。
 *
 * 语义：把不可解析的 bundle **从 dsh.profile.bundles 中摘掉**（保留 dependencies
 * 不动，因为它可能仍被别的包依赖）。这是安全方向——宁可少加载一个插件，
 * 也不要让整个 profile 被重置。
 *
 * 默认 dry-run。
 */
export function neutralizeMissingBundles(ctx, options = {}) {
  const dryRun = options.dryRun !== false
  const read = readProfileManifest(ctx)
  if (!read.ok) return { ok: false, error: read.message }

  const manifest = read.value
  const bundles = declaredBundles(manifest)
  const missing = []
  const kept = []
  for (const b of bundles) {
    if (typeof b !== 'string') { kept.push(b); continue }
    if (isHostProvided(b)) { kept.push(b); continue }
    const dir = join(ctx.profileNodeModules, ...b.split('/'))
    if (existsSync(dir)) { kept.push(b); continue }
    missing.push(b)
  }

  if (missing.length === 0) {
    return { ok: true, action: 'none', removed: [], message: 'every selected bundle resolves; nothing to neutralize' }
  }

  if (dryRun) {
    return {
      ok: true,
      action: 'would-neutralize',
      removed: missing,
      kept,
      message: `would remove ${missing.length} unresolvable bundle(s) from dsh.profile.bundles: ${missing.join(', ')}`,
    }
  }

  // 先打还原点，再改文件。
  const snapshot = gitlib.save(ctx.repoRoot, `pre-neutralize: 摘除不可解析 bundle (${missing.join(', ')})`)

  const next = { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: kept } } }
  const path = ctx.profileManifest
  try {
    // 必须写 UTF-8 **无 BOM**：DSH 的 JSON 读取见到 BOM 会在 parse 前中止。
    writeFileSync(path, Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8'))
  } catch (error) {
    return { ok: false, error: `write failed: ${String(error?.message ?? error)}`, snapshot }
  }

  const after = runAll(ctx)
  return {
    ok: after.errors === 0,
    action: 'neutralized',
    removed: missing,
    kept,
    snapshot: snapshot.committed ? snapshot.short : null,
    healthAfter: { errors: after.errors, warnings: after.warnings },
    message: `removed ${missing.length} unresolvable bundle(s); ${after.errors} health error(s) remain`,
  }
}

/** 供外部 UI 使用的「一键恢复 + 护栏」组合。 */
export function safeRecover(ctx, options = {}) {
  const pre = preflight(ctx)
  const result = recover(ctx, options)
  return { preflight: pre, recover: result }
}