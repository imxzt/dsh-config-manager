/**
 * crash.test.mjs — 崩溃检测与恢复自测。
 *
 * 用法：node test/crash.test.mjs
 *
 * 关键验证点（都是真实事故的回归测试）：
 *  1. 能识别「profile 被重置成模板形状」——2026-10-03 事故的核心症状。
 *  2. 能识别 boot-state 的 ok:false。
 *  3. 恢复时**先取证存档**，崩溃现场不丢。
 *  4. 还原目标优先选「非重置形状」的最近还原点。
 *  5. 不把「用户主动精简配置」误判为崩溃。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveContext } from '../lib/paths.mjs'
import * as gitlib from '../lib/git.mjs'
import {
  assess, looksReset, readBootState, findPatchBackups, recover,
  pickRestoreTarget, relativeProfileManifest, TEMPLATE_BUNDLES,
} from '../lib/crash.mjs'

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ok   ${name}`) }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}
function section(t) { console.log(`\n== ${t} ==`) }

/** 造一个可控的 home + profile，并按需写入状态。 */
function makeEnv() {
  const home = mkdtempSync(join(tmpdir(), 'dcm-crash-'))
  const prof = join(home, 'profiles', 'desktop')
  const nm = join(prof, 'node_modules')
  mkdirSync(nm, { recursive: true })
  mkdirSync(join(home, 'undo-snapshots', 'auto'), { recursive: true })
  // 本工具自己的状态目录（boot-state 等写在这里）
  mkdirSync(join(home, 'plugins', 'dsh-config-manager'), { recursive: true })

  // 一个可解析的插件包，供健康检查通过
  const plug = join(nm, 'good-plugin')
  mkdirSync(plug, { recursive: true })
  writeFileSync(join(plug, 'package.json'), JSON.stringify({ name: 'good-plugin', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(plug, 'cordis.patch.yml'), '- insert: []\n')

  return { home, prof, nm }
}

/** 写一份「健康」profile（bundles 多、patch 大）。 */
function writeHealthy(env, bundleCount = 6) {
  const bundles = [...TEMPLATE_BUNDLES, 'good-plugin']
  for (let i = 0; i < bundleCount; i++) bundles.push(`extra-${i}`)
  const deps = { 'good-plugin': '1.0.0' }
  for (let i = 0; i < bundleCount; i++) deps[`extra-${i}`] = '1.0.0'
  writeFileSync(join(env.prof, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', dependencies: deps, dsh: { profile: { bundles } } }, null, 2))
  // patch 要够长（>40 行）才不会被判成模板
  const lines = []
  for (let i = 0; i < 60; i++) lines.push(`- id: row-${i}\n  name: "x-${i}"`)
  writeFileSync(join(env.prof, 'cordis.patch.yml'), lines.join('\n') + '\n')
  writeFileSync(join(env.prof, 'pnpm-lock.yaml'), Object.keys(deps).map((d) => `${d}:`).join('\n') + '\n')
  // 让 extra-* 也真实存在，否则健康检查报缺失
  for (let i = 0; i < bundleCount; i++) {
    const d = join(env.nm, `extra-${i}`)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: `extra-${i}`, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(d, 'cordis.patch.yml'), '- insert: []\n')
  }
}

/** 写一份「被重置成模板」的 profile（事故形状）。 */
function writeReset(env) {
  writeFileSync(join(env.prof, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: {},
    dsh: { profile: { bundles: [...TEMPLATE_BUNDLES] } },
  }, null, 2))
  writeFileSync(join(env.prof, 'cordis.patch.yml'), [
    '# Your patch layer for this dsh profile',
    '- id: ui-settings-account',
    '  name: "@deepseek-ai/dsh-client-ui-settings-account"',
    '- id: ui-chat',
    '  name: "@deepseek-ai/dsh-client-ui-chat"',
    '- id: ui-settings',
    '  name: "@deepseek-ai/dsh-client-ui-settings"',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
  ].join('\n') + '\n')
}

// ── looksReset ──────────────────────────────────────────────────────────

section('重置形状识别')

{
  const env = makeEnv()
  writeHealthy(env)
  const ctx = resolveContext({ home: env.home, profile: 'desktop' })
  const read = JSON.parse(readFileSync(ctx.profileManifest, 'utf8'))
  const r = looksReset(ctx, read)
  check('健康 profile 不判为重置', r.reset === false, JSON.stringify(r.detail))

  writeReset(env)
  const read2 = JSON.parse(readFileSync(ctx.profileManifest, 'utf8'))
  const r2 = looksReset(ctx, read2)
  check('模板形状判为重置', r2.reset === true, JSON.stringify(r2.detail))
  check('报告 bundle 数为 2', r2.detail.bundleCount === 2, String(r2.detail.bundleCount))
  rmSync(env.home, { recursive: true, force: true })
}

{
  // 用户主动精简：bundles 少但 patch 仍很长 → 不应判为崩溃
  const env = makeEnv()
  writeHealthy(env)
  const ctx = resolveContext({ home: env.home, profile: 'desktop' })
  const m = JSON.parse(readFileSync(ctx.profileManifest, 'utf8'))
  m.dsh.profile.bundles = [...TEMPLATE_BUNDLES]
  writeFileSync(ctx.profileManifest, JSON.stringify(m, null, 2))
  const r = looksReset(ctx, JSON.parse(readFileSync(ctx.profileManifest, 'utf8')))
  check('bundles 少但 patch 长 → 不判为重置', r.reset === false, JSON.stringify(r.detail))
  rmSync(env.home, { recursive: true, force: true })
}

// ── boot-state 与备份 ───────────────────────────────────────────────────

section('boot-state 与 patch 备份')

{
  const env = makeEnv()
  writeHealthy(env)
  const ctx = resolveContext({ home: env.home, profile: 'desktop' })

  check('无 boot-state 时 exists=false', readBootState(ctx).exists === false)

  // boot-state 现在写在本工具自己的 stateDir 下（不再依赖 undo-savepoint 的目录）
  mkdirSync(ctx.stateDir, { recursive: true })
  writeFileSync(join(ctx.stateDir, 'boot-state.json'), JSON.stringify({
    startedAt: '2026-10-03T00:00:00.000Z', pid: 1, ok: false, okAt: null, crashReason: 'bundle resolve failed',
  }))
  const boot = readBootState(ctx)
  check('读到 boot-state', boot.exists && boot.value.ok === false)
  check('boot-state 路径在本工具 stateDir 下', boot.path.startsWith(ctx.stateDir), boot.path)

  writeFileSync(join(ctx.profileDir, 'cordis.patch.yml.bak-123456'), 'x'.repeat(100))
  const backups = findPatchBackups(ctx)
  check('找到 patch 备份', backups.length === 1 && backups[0].name === 'cordis.patch.yml.bak-123456', JSON.stringify(backups))
  rmSync(env.home, { recursive: true, force: true })
}

// ── assess ──────────────────────────────────────────────────────────────

section('崩溃评估')

{
  const env = makeEnv()
  writeHealthy(env)
  const ctx = resolveContext({ home: env.home, profile: 'desktop' })

  // 建 git 仓库并提交健康状态
  gitlib.git(env.home, ['init', '-b', 'main'])
  gitlib.git(env.home, ['config', 'user.name', 't'])
  gitlib.git(env.home, ['config', 'user.email', 't@l'])
  const base = gitlib.save(env.home, 'baseline healthy')
  check('基线提交成功', base.ok && base.committed === true)

  const clean = assess(ctx)
  check('健康状态不判崩溃', clean.crashed === false, JSON.stringify(clean.signals))
  check('健康时建议 none', clean.recommendation.action === 'none', clean.recommendation.action)

  // 制造崩溃：重置 + boot 失败 + 备份文件
  writeReset(env)
  writeFileSync(join(ctx.stateDir, 'boot-state.json'), JSON.stringify({
    startedAt: '2026-10-03T00:00:00.000Z', pid: 1, ok: false, okAt: null, crashReason: 'cannot resolve profile bundle',
  }))
  writeFileSync(join(ctx.profileDir, 'cordis.patch.yml.bak-999'), 'y'.repeat(15000))

  const crashed = assess(ctx)
  check('判定为崩溃', crashed.crashed === true, JSON.stringify(crashed.signals.map((s) => s.kind)))
  check('置信度为 high（重置+boot 双信号）', crashed.confidence === 'high', crashed.confidence)
  check('信号含 profile-reset', crashed.signals.some((s) => s.kind === 'profile-reset'))
  check('信号含 boot-failed', crashed.signals.some((s) => s.kind === 'boot-failed'))
  check('信号含 patch-backup', crashed.signals.some((s) => s.kind === 'patch-backup'))
  check('建议动作是 restore', crashed.recommendation.action === 'restore', JSON.stringify(crashed.recommendation))
  check('还原目标指向基线提交', crashed.recommendation.ref === base.hash, crashed.recommendation.ref)
  check('还原理由说明 bundle 数', /bundles/.test(crashed.recommendation.reason), crashed.recommendation.reason)

  // 取证差异
  const rel = relativeProfileManifest(ctx)
  check('relativeProfileManifest 是 POSIX 相对路径', rel === 'profiles/desktop/package.json', String(rel))

  rmSync(env.home, { recursive: true, force: true })
}

// ── recover：先取证再还原 ───────────────────────────────────────────────

section('恢复（先取证再还原）')

{
  const env = makeEnv()
  writeHealthy(env)
  const ctx = resolveContext({ home: env.home, profile: 'desktop' })
  gitlib.git(env.home, ['init', '-b', 'main'])
  gitlib.git(env.home, ['config', 'user.name', 't'])
  gitlib.git(env.home, ['config', 'user.email', 't@l'])
  const base = gitlib.save(env.home, 'baseline healthy')
  const healthyPatch = readFileSync(ctx.profilePatch, 'utf8')
  const healthyBundleCount = JSON.parse(readFileSync(ctx.profileManifest, 'utf8')).dsh.profile.bundles.length

  // 崩溃
  writeReset(env)
  writeFileSync(join(ctx.stateDir, 'boot-state.json'), JSON.stringify({ ok: false, crashReason: 'boom' }))

  // dry-run 不应改动任何东西
  const dry = recover(ctx, { dryRun: true })
  check('dry-run 成功', dry.ok === true && dry.dryRun === true, JSON.stringify(dry))
  check('dry-run 不改 manifest', JSON.parse(readFileSync(ctx.profileManifest, 'utf8')).dsh.profile.bundles.length === 2)
  check('dry-run 不产生提交', gitlib.log(env.home, 10).commits.length === 1, String(gitlib.log(env.home, 10).commits.length))

  // 真恢复
  const rec = recover(ctx)
  check('恢复成功', rec.ok === true, JSON.stringify(rec).slice(0, 400))
  check('恢复后 patch 回到健康内容', readFileSync(ctx.profilePatch, 'utf8') === healthyPatch)
  check('恢复后 bundles 数恢复', JSON.parse(readFileSync(ctx.profileManifest, 'utf8')).dsh.profile.bundles.length === healthyBundleCount, String(JSON.parse(readFileSync(ctx.profileManifest, 'utf8')).dsh.profile.bundles.length))
  check('恢复后健康检查通过', rec.healthAfter.errors === 0, JSON.stringify(rec.healthAfter))

  // 取证提交必须存在且含崩溃现场
  const commits = gitlib.log(env.home, 10).commits
  check('产生了取证提交与还原提交', commits.length === 3, String(commits.length))
  const forensic = commits.find((c) => c.subject.startsWith('forensics:'))
  check('取证提交存在', forensic !== undefined, JSON.stringify(commits.map((c) => c.subject)))
  check('还原动作被记录为提交', commits.some((c) => c.subject.startsWith('restore:')), JSON.stringify(commits.map((c) => c.subject)))
  // 取证提交里应能看到重置后的（bundles=2）manifest
  const atForensic = gitlib.git(env.home, ['show', `${forensic.hash}:profiles/desktop/package.json`])
  check('取证提交记录了崩溃现场（bundles=2）', atForensic.ok && JSON.parse(atForensic.stdout).dsh.profile.bundles.length === 2, atForensic.stdout.slice(0, 120))

  // 还原后工作区应与基线一致（干净）
  const st = gitlib.status(env.home)
  check('恢复后工作区干净', st.clean === true, JSON.stringify(st.entries))

  rmSync(env.home, { recursive: true, force: true })
}

// ── pickRestoreTarget ───────────────────────────────────────────────────

section('还原目标选择')

{
  const env = makeEnv()
  writeHealthy(env)
  const ctx = resolveContext({ home: env.home, profile: 'desktop' })
  gitlib.git(env.home, ['init', '-b', 'main'])
  gitlib.git(env.home, ['config', 'user.name', 't'])
  gitlib.git(env.home, ['config', 'user.email', 't@l'])
  const good = gitlib.save(env.home, 'healthy with 10 bundles')

  // 再提交一个「重置形状」的版本，它更新，但不该被选为目标
  writeReset(env)
  gitlib.save(env.home, 'reset shape (bad)')

  const repo = { commits: gitlib.log(env.home, 10).commits }
  const target = pickRestoreTarget(repo, ctx)
  check('跳过重置形状的更新提交', target.ref === good.hash, `${target.ref} vs ${good.hash}`)
  check('理由提到 bundle 数', /bundles/.test(target.reason), target.reason)

  rmSync(env.home, { recursive: true, force: true })
}

// ── 真实环境（只读）─────────────────────────────────────────────────────

section('真实环境评估（只读）')

{
  const ctx = resolveContext({})
  const a = assess(ctx)
  console.log(`  profile=${ctx.profile} crashed=${a.crashed} confidence=${a.confidence}`)
  console.log(`  boot: ${a.boot.exists ? (a.boot.value?.ok === false ? 'FAILED' : 'ok') : 'absent'}  backups=${a.backups.length}  healthErrors=${a.health.errors}`)
  console.log(`  建议: ${a.recommendation.action} — ${a.recommendation.reason}`)
  check('真实环境评估能跑完', typeof a.crashed === 'boolean')
  check('真实环境当前不判崩溃', a.crashed === false, JSON.stringify(a.signals.filter((s) => s.severity === 'err')))
}

console.log(`\n结果: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
