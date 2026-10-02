/**
 * crash.mjs — 崩溃检测与恢复（C 项）。
 *
 * 外部 UI 的主战场。DSH 起不来时页面内插件根本加载不了，所以崩溃恢复
 * 只能由外部入口提供。
 *
 * 检测三类崩溃痕迹（都不依赖 DSH 运行）：
 *  1. `boot-state.json` 的 `ok:false` 或 `crashReason` —— DSH 自己记的启动失败。
 *  2. **profile 被恢复重置**：bundles 骤减到模板默认值、cordis.patch.yml
 *     被覆盖成模板。识别特征是与 git 基线对比行数/项数骤降。
 *  3. `cordis.patch.yml.bak-<stamp>` 的时间戳晚于最近一次基线还原点 ——
 *     说明 DSH 在备份 patch，即刚触发过恢复流程。
 *
 * 恢复动作一律**先取证再动手**：把当前状态存成一个 git 提交（可对比），
 * 再还原到指定还原点。绝不静默丢弃现场。
 */

import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readProfileManifest, declaredBundles } from './paths.mjs'
import * as gitlib from './git.mjs'
import { runAll, TEMPLATE_BUNDLE_NAMES, TEMPLATE_PATCH_MARKERS } from './health.mjs'

/**
 * web profile 模板的 bundles —— DSH 恢复流程会把损坏 profile 重置成这个形状。
 * 常量定义在 health.mjs（那里也用它做健康检查），此处只是别名以免两处漂移。
 */
export const TEMPLATE_BUNDLES = TEMPLATE_BUNDLE_NAMES

/**
 * 读启动状态文件。**不依赖 dsh-undo-savepoint 的目录**——那个插件已移除，
 * 它的 `undo-snapshots/` 不存在，读它永远失败（首次演练暴露的问题）。
 *
 * 按优先级找三处：
 *  1. 本工具自己的 stateDir（页面内插件与外部 UI 都会写这里）；
 *  2. 旧的 undo-snapshots/auto（若用户仍装着那个插件，兼容读取）；
 *  3. 都没有则视为未知——未知不等于正常。
 */
export function readBootState(ctx) {
  const candidates = [
    join(ctx.stateDir, 'boot-state.json'),
    join(ctx.home, 'undo-snapshots', 'auto', 'boot-state.json'),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      return { exists: true, path, value: JSON.parse(readFileSync(path, 'utf8')) }
    } catch (error) {
      return { exists: true, path, error: String(error?.message ?? error) }
    }
  }
  return { exists: false, path: candidates[0] }
}

/**
 * 写本工具的启动状态（页面内插件启动成功/失败时调用）。
 * 自动创建 stateDir —— 它可能还没被创建过。
 */
export function writeBootState(ctx, state) {
  try {
    mkdirSync(ctx.stateDir, { recursive: true })
    writeFileSync(join(ctx.stateDir, 'boot-state.json'), JSON.stringify({
      ...state,
      updatedAt: new Date().toISOString(),
    }, null, 2), 'utf8')
    return { ok: true, path: join(ctx.stateDir, 'boot-state.json') }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 找出 profile 下的 patch 备份文件及其时间。 */
export function findPatchBackups(ctx) {
  const out = []
  let entries = []
  try { entries = readdirSync(ctx.profileDir) } catch { return out }
  for (const name of entries) {
    if (!/^cordis\.patch\.yml\.bak-/.test(name)) continue
    const path = join(ctx.profileDir, name)
    let size = null
    let mtime = null
    try {
      const st = statSync(path)
      size = st.size
      mtime = st.mtime.toISOString()
    } catch { /* 忽略 */ }
    out.push({ name, path, size, mtime })
  }
  return out.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)))
}

/**
 * 判断 profile 是否被恢复流程重置过。
 *
 * 判据（需同时成立，避免把「用户主动精简配置」误判为崩溃）：
 *  a. bundles 只剩模板默认的那几个（<=2 且都属模板）；
 *  b. patch 里出现 DSH 自管条目且行数很少（<=40 行）。
 */
export function looksReset(ctx, manifest) {
  const bundles = declaredBundles(manifest)
  const onlyTemplate = bundles.length > 0 && bundles.length <= TEMPLATE_BUNDLES.length
    && bundles.every((b) => TEMPLATE_BUNDLES.includes(b))

  let patchLines = 0
  let hasTemplateMarkers = false
  if (existsSync(ctx.profilePatch)) {
    try {
      const text = readFileSync(ctx.profilePatch, 'utf8')
      patchLines = text.split('\n').length
      hasTemplateMarkers = TEMPLATE_PATCH_MARKERS.every((m) => text.includes(m))
    } catch { /* 忽略 */ }
  }
  const patchShrunk = patchLines > 0 && patchLines <= 40 && hasTemplateMarkers

  return {
    reset: onlyTemplate && patchShrunk,
    detail: { bundleCount: bundles.length, onlyTemplate, patchLines, hasTemplateMarkers },
  }
}

/**
 * 完整崩溃评估。返回一个可直接渲染的报告。
 *
 * @returns {{
 *   crashed: boolean, confidence: 'high'|'medium'|'low',
 *   signals: Array<{kind: string, severity: string, message: string, detail?: any}>,
 *   boot: any, backups: any[], reset: any, health: any, repo: any,
 *   recommendation: { action: string, ref?: string, reason: string },
 * }}
 */
export function assess(ctx) {
  const signals = []

  // ── 信号 1：boot-state ──
  const boot = readBootState(ctx)
  if (boot.exists && boot.value) {
    const v = boot.value
    if (v.ok === false) {
      signals.push({
        kind: 'boot-failed',
        severity: 'err',
        message: `DSH recorded a failed start at ${v.startedAt ?? '?'}${v.crashReason ? `: ${v.crashReason}` : ''}`,
        detail: v,
      })
    } else if (v.ok === true) {
      signals.push({
        kind: 'boot-ok',
        severity: 'info',
        message: `last start succeeded at ${v.okAt ?? v.startedAt ?? '?'}`,
        detail: v,
      })
    }
  } else {
    signals.push({ kind: 'boot-unknown', severity: 'info', message: 'no boot-state.json (DSH may never have completed a start here)' })
  }

  // ── 信号 2：profile 被重置 ──
  const read = readProfileManifest(ctx)
  const manifest = read.ok ? read.value : null
  const reset = manifest === null
    ? { reset: false, detail: { reason: 'manifest unreadable' } }
    : looksReset(ctx, manifest)
  if (reset.reset) {
    signals.push({
      kind: 'profile-reset',
      severity: 'err',
      message: `profile looks reset to the template shape: ${reset.detail.bundleCount} bundle(s), ${reset.detail.patchLines} patch line(s)`,
      detail: reset.detail,
    })
  }

  // ── 信号 3：patch 备份（恢复流程的副产物）──
  const backups = findPatchBackups(ctx)
  if (backups.length > 0) {
    signals.push({
      kind: 'patch-backup',
      severity: 'warn',
      message: `${backups.length} cordis.patch.yml backup(s) present; newest ${backups[0].name} (${backups[0].size} bytes, ${backups[0].mtime})`,
      detail: backups,
    })
  }

  // ── 健康检查（同时给出「现在能不能重启」的判定）──
  const health = runAll(ctx)

  // ── 仓库状态 ──
  const repoOk = gitlib.isRepo(ctx.repoRoot)
  const status = repoOk ? gitlib.status(ctx.repoRoot) : { ok: false, clean: null, entries: [] }
  const log = repoOk ? gitlib.log(ctx.repoRoot, 20) : { ok: false, commits: [] }
  const repo = {
    ok: repoOk,
    clean: status.clean,
    changed: status.entries ?? [],
    commits: log.commits ?? [],
  }

  // ── 判定 ──
  const hardSignals = signals.filter((s) => s.severity === 'err')
  const crashed = hardSignals.length > 0
  const confidence = crashed
    ? (signals.some((s) => s.kind === 'profile-reset') && signals.some((s) => s.kind === 'boot-failed') ? 'high'
      : signals.some((s) => s.kind === 'profile-reset') || signals.some((s) => s.kind === 'boot-failed') ? 'medium' : 'low')
    : 'low'

  // ── 建议动作 ──
  let recommendation
  if (crashed && repoOk && repo.commits.length > 0) {
    const target = pickRestoreTarget(repo, ctx)
    recommendation = {
      action: 'restore',
      ref: target.ref,
      reason: target.reason,
    }
  } else if (crashed) {
    recommendation = { action: 'manual', reason: 'crashed but no usable restore point in the git repo' }
  } else if (!health.ok) {
    recommendation = { action: 'inspect', reason: `${health.errors} health error(s) — do not restart until resolved` }
  } else {
    recommendation = { action: 'none', reason: 'no crash signature and health checks pass' }
  }

  return {
    crashed,
    confidence,
    signals,
    boot,
    backups,
    reset,
    health,
    repo,
    recommendation,
  }
}

/**
 * 挑选还原目标。
 *
 * 优先「最近一个 profile 健康、且 bundles 数量明显多于模板」的还原点——
 * 也就是崩溃前的最后良好状态。跳过那些本身就是重置状态的提交。
 */
export function pickRestoreTarget(repo, ctx) {
  for (const c of repo.commits) {
    const snapshot = readManifestAt(ctx.repoRoot, c.hash, ctx)
    if (snapshot === null) continue
    if (snapshot.bundles.length > TEMPLATE_BUNDLES.length) {
      return {
        ref: c.hash,
        reason: `${c.short} (${c.date}) has ${snapshot.bundles.length} bundles — the newest commit that is not in the reset shape`,
        snapshot,
      }
    }
  }
  const head = repo.commits[0]
  return { ref: head.hash, reason: `no non-reset commit found; falling back to HEAD ${head.short}`, snapshot: null }
}

/** 读某个提交里的 profile manifest（用于判断该还原点是否健康）。 */
export function readManifestAt(repoRoot, ref, ctx) {
  const rel = relativeProfileManifest(ctx)
  if (rel === null) return null
  const r = gitlib.git(repoRoot, ['show', `${ref}:${rel}`])
  if (!r.ok) return null
  try {
    const value = JSON.parse(r.stdout)
    return { bundles: declaredBundles(value), dependencies: Object.keys(value?.dependencies ?? {}) }
  } catch {
    return null
  }
}

/** profile manifest 相对仓库根的路径（POSIX 分隔符，git 要求）。 */
export function relativeProfileManifest(ctx) {
  const rel = ctx.profileManifest.slice(ctx.repoRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
  return rel === '' ? null : rel
}

/** profile patch 相对仓库根的路径。 */
export function relativeProfilePatch(ctx) {
  const rel = ctx.profilePatch.slice(ctx.repoRoot.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
  return rel === '' ? null : rel
}

/**
 * 执行恢复：**先取证存档，再还原**。
 *
 * @param {object} options
 * @param {string} [options.ref] 目标还原点，缺省用 assess 的建议
 * @param {boolean} [options.dryRun] 只报告将做什么
 * @returns {{ ok: boolean, forensics?: any, restored?: any, error?: string }}
 */
export function recover(ctx, options = {}) {
  if (!gitlib.isRepo(ctx.repoRoot)) {
    return { ok: false, error: `not a git repository: ${ctx.repoRoot}` }
  }

  const assessment = assess(ctx)
  const ref = options.ref ?? assessment.recommendation.ref
  if (!ref) return { ok: false, error: 'no restore target available', assessment }

  const verify = gitlib.git(ctx.repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])
  if (!verify.ok) return { ok: false, error: `unknown restore ref: ${ref}`, assessment }

  if (options.dryRun === true) {
    const files = [relativeProfileManifest(ctx), relativeProfilePatch(ctx), 'profiles/' + ctx.profile + '/pnpm-lock.yaml'].filter(Boolean)
    return { ok: true, dryRun: true, ref, files, assessment }
  }

  // 1) 取证：把当前（崩溃）状态存成一个提交，可随时 diff/对比。
  const forensic = gitlib.save(ctx.repoRoot, `forensics: 崩溃现场存档（恢复前） ${new Date().toISOString()}`)

  // 2) 还原 profile 关键文件到目标还原点。
  const paths = [
    relativeProfileManifest(ctx),
    relativeProfilePatch(ctx),
    `profiles/${ctx.profile}/pnpm-lock.yaml`,
    `profiles/${ctx.profile}/cordis.yml`,
    `profiles/${ctx.profile}/pnpm-workspace.yaml`,
  ].filter(Boolean)

  const restored = gitlib.restore(ctx.repoRoot, ref, paths)

  // 3) 还原结果本身也提交一次：还原是一个应当被记录的动作，且这样
  //    工作区回到干净状态（否则 `git restore --staged` 会在索引里留下
  //    暂存改动，UI 会误报「有未保存改动」）。
  let recorded = null
  if (restored.ok) {
    recorded = gitlib.save(ctx.repoRoot, `restore: 回滚到 ${ref.slice(0, 7)}（由崩溃恢复执行）`)
  }

  // 4) 还原后重新体检：必须确认 bundle 全部可解析，否则不能声称修好了。
  const after = runAll(ctx)

  return {
    ok: restored.ok && after.ok,
    ref,
    forensic,
    restored,
    recorded,
    healthBefore: { errors: assessment.health.errors, warnings: assessment.health.warnings },
    healthAfter: { errors: after.errors, warnings: after.warnings },
    healthReport: after,
    error: restored.ok ? (after.ok ? undefined : `${after.errors} health error(s) remain after restore`) : restored.error,
  }
}

/**
 * 崩溃现场取证报告：给外部 UI 展示「崩溃前 vs 现在」的差异。
 */
export function forensicDiff(ctx, ref) {
  const patchRel = relativeProfilePatch(ctx)
  const manifestRel = relativeProfileManifest(ctx)
  const out = {}
  for (const [label, rel] of [['patch', patchRel], ['manifest', manifestRel]]) {
    if (!rel) continue
    const d = gitlib.diff(ctx.repoRoot, { from: ref, path: rel })
    const stat = gitlib.git(ctx.repoRoot, ['diff', '--stat', ref, '--', rel])
    out[label] = { diff: d.text, stat: stat.stdout.trim(), ok: d.ok }
  }
  return out
}
