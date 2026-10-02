/**
 * plugins.test.mjs — 插件护栏自测。
 *
 * 用法：node test/plugins.test.mjs
 *
 * 核心回归：复刻 2026-10-03 事故的**直接成因**（选中的 bundle 在磁盘上不存在），
 * 验证护栏在三个层面都能拦住：
 *  1. listPlugins 标出风险
 *  2. preflight 判定「不安全重启」
 *  3. neutralizeMissingBundles 能修好它
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveContext } from '../lib/paths.mjs'
import * as gitlib from '../lib/git.mjs'
import {
  listPlugins, preflight, beforeChange, afterChange, guard,
  neutralizeMissingBundles, KNOWN_RISKY,
} from '../lib/plugins.mjs'

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ok   ${name}`) }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}
function section(t) { console.log(`\n== ${t} ==`) }

/** 造环境：一个好包 + 一个「声明了但磁盘没有」的包（事故成因）。 */
function makeEnv() {
  const home = mkdtempSync(join(tmpdir(), 'dcm-plug-'))
  const prof = join(home, 'profiles', 'desktop')
  const nm = join(prof, 'node_modules')
  mkdirSync(nm, { recursive: true })
  mkdirSync(join(home, 'plugins', 'dsh-config-manager'), { recursive: true })

  const good = join(nm, 'good-plugin')
  mkdirSync(good, { recursive: true })
  writeFileSync(join(good, 'package.json'), JSON.stringify({ name: 'good-plugin', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(good, 'cordis.patch.yml'), '- insert: []\n')

  writeFileSync(join(prof, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: { 'good-plugin': '1.0.0', 'ghost-plugin': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'good-plugin', 'ghost-plugin'] } },
  }, null, 2))
  writeFileSync(join(prof, 'cordis.patch.yml'), Array.from({ length: 50 }, (_, i) => `- id: r${i}\n  name: "x"`).join('\n') + '\n')
  writeFileSync(join(prof, 'pnpm-lock.yaml'), 'good-plugin:\nghost-plugin:\n')

  gitlib.git(home, ['init', '-b', 'main'])
  gitlib.git(home, ['config', 'user.name', 't'])
  gitlib.git(home, ['config', 'user.email', 't@l'])
  return { home, prof, nm }
}

// ── listPlugins ─────────────────────────────────────────────────────────

section('插件总览')

{
  const env = makeEnv()
  const ctx = resolveContext({ home: env.home, profile: 'desktop' })
  const r = listPlugins(ctx)

  check('总览成功', r.ok === true)
  check('列出 3 项（base + good + ghost）', r.plugins.length === 3, String(r.plugins.length))

  const ghost = r.plugins.find((p) => p.name === 'ghost-plugin')
  check('ghost 被选中为 bundle', ghost.selected === true)
  check('ghost 在依赖里', ghost.declared === true)
  check('ghost 磁盘不存在', ghost.onDisk === false)
  check('ghost 被标为 err 风险', ghost.risk?.severity === 'err', JSON.stringify(ghost.risk))
  check('ghost 风险说明含「会重置 profile」', /reset this profile/.test(ghost.risk?.reason ?? ''), ghost.risk?.reason)

  const good = r.plugins.find((p) => p.name === 'good-plugin')
  check('good 无风险', good.risk === null, JSON.stringify(good.risk))
  check('good 可解析', good.resolvable === true)

  const base = r.plugins.find((p) => p.name === '@deepseek-ai/dsh-base')
  check('@deepseek-ai/* 标记为安装包提供', base.hostProvided === true)
  check('@deepseek-ai/* 不误报风险', base.risk === null, JSON.stringify(base.risk))
  check('onDisk 对安装包提供者为 null', base.onDisk === null)

  check('计数含 1 个风险项', r.counts.risky === 1, JSON.stringify(r.counts))
  check('计数含 3 个选中', r.counts.selected === 3, JSON.stringify(r.counts))

  rmSync(env.home, { recursive: true, force: true })
}

// ── 已知有害插件提示 ────────────────────────────────────────────────────

section('已知有害插件')

{
  const env = makeEnv()
  const ctx = resolveContext({ home: env.home, profile: 'desktop' })
  // 装一个 conflict-guardian（真存在于磁盘，但被列入 KNOWN_RISKY）
  const dir = join(env.nm, 'dsh-conflict-guardian')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-conflict-guardian', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(dir, 'cordis.patch.yml'), '- insert: []\n')
  const m = JSON.parse(readFileSync(ctx.profileManifest, 'utf8'))
  m.dependencies['dsh-conflict-guardian'] = '1.0.0'
  m.dsh.profile.bundles.push('dsh-conflict-guardian')
  writeFileSync(ctx.profileManifest, JSON.stringify(m, null, 2))

  const r = listPlugins(ctx)
  const cg = r.plugins.find((p) => p.name === 'dsh-conflict-guardian')
  check('conflict-guardian 被标为风险', cg.risk !== null, JSON.stringify(cg.risk))
  check('风险说明引用了实测证据', /\+1 -26|2026-10-03/.test(cg.risk?.reason ?? ''), cg.risk?.reason)
  check('KNOWN_RISKY 有该条目', 'dsh-conflict-guardian' in KNOWN_RISKY)
  rmSync(env.home, { recursive: true, force: true })
}

// ── preflight 启动预检门 ────────────────────────────────────────────────

section('启动预检门')

{
  const env = makeEnv()
  const ctx = resolveContext({ home: env.home, profile: 'desktop' })
  const pf = preflight(ctx)
  check('ghost 存在时判定不安全重启', pf.safeToRestart === false, JSON.stringify(pf.blockers))
  check('blocker 来源含 plugin:ghost-plugin', pf.blockers.some((b) => b.source === 'plugin:ghost-plugin'), JSON.stringify(pf.blockers.map((b) => b.source)))
  check('摘要说明有风险', /risks a profile reset/.test(pf.summary), pf.summary)

  // 修好之后应判定安全
  const fix = neutralizeMissingBundles(ctx, { dryRun: false })
  check('neutralize 成功', fix.ok === true, JSON.stringify(fix))
  check('摘除了 ghost', fix.removed.includes('ghost-plugin'), JSON.stringify(fix.removed))
  check('保留 good-plugin', fix.kept.includes('good-plugin'), JSON.stringify(fix.kept))
  check('保留 @deepseek-ai/*', fix.kept.includes('@deepseek-ai/dsh-base'))

  const pf2 = preflight(ctx)
  check('修复后判定安全重启', pf2.safeToRestart === true, JSON.stringify(pf2.blockers))

  rmSync(env.home, { recursive: true, force: true })
}

// ── neutralizeMissingBundles ────────────────────────────────────────────

section('摘除不可解析 bundle')

{
  const env = makeEnv()
  const ctx = resolveContext({ home: env.home, profile: 'desktop' })

  // dry-run 不改文件
  const before = readFileSync(ctx.profileManifest, 'utf8')
  const dry = neutralizeMissingBundles(ctx, { dryRun: true })
  check('dry-run 报 would-neutralize', dry.action === 'would-neutralize', JSON.stringify(dry))
  check('dry-run 不改文件', readFileSync(ctx.profileManifest, 'utf8') === before)
  check('dry-run 列出将摘除项', dry.removed.includes('ghost-plugin'))

  // 真摘：应产生还原点
  const real = neutralizeMissingBundles(ctx, { dryRun: false })
  check('真摘成功', real.ok === true, JSON.stringify(real))
  check('产生了 pre-neutralize 还原点', typeof real.snapshot === 'string', String(real.snapshot))
  const after = JSON.parse(readFileSync(ctx.profileManifest, 'utf8'))
  check('ghost 已从 bundles 移除', !after.dsh.profile.bundles.includes('ghost-plugin'))
  check('ghost 仍在 dependencies（不误删依赖）', 'ghost-plugin' in after.dependencies)
  check('写出的 manifest 无 BOM', readFileSync(ctx.profileManifest)[0] !== 0xef)

  // 再跑一次应报 none
  const again = neutralizeMissingBundles(ctx, { dryRun: true })
  check('已修好后报 none', again.action === 'none', JSON.stringify(again))

  rmSync(env.home, { recursive: true, force: true })
}

// ── beforeChange / afterChange / guard ──────────────────────────────────

section('变更护栏')

{
  const env = makeEnv()
  const ctx = resolveContext({ home: env.home, profile: 'desktop' })

  const before = beforeChange(ctx, '安装某插件')
  check('beforeChange 建了还原点', before.ok === true && before.snapshot !== null, JSON.stringify(before))
  check('还原点信息含 short', typeof before.snapshot?.short === 'string')

  const after = afterChange(ctx, { snapshot: before.snapshot.short })
  check('afterChange 检出 blocking（ghost 还在）', after.blocking === true, JSON.stringify(after.health))
  check('afterChange 给出「不要重启」建议', /DO NOT restart/.test(after.advice), after.advice)
  check('afterChange 列出风险插件', after.riskyPlugins.some((p) => p.name === 'ghost-plugin'))
  check('afterChange 用传入的快照给出回滚命令', /dcm restore/.test(after.rollbackHint ?? ''), String(after.rollbackHint))
  check('回滚命令指向 beforeChange 的还原点', (after.rollbackHint ?? '').includes(before.snapshot.short), String(after.rollbackHint))

  // 不传快照时不该编造回滚命令
  const noSnap = afterChange(ctx)
  check('未传快照时不给回滚命令', noSnap.rollbackHint === undefined, String(noSnap.rollbackHint))

  // guard：包住一次「成功」的操作
  const g = await guard(ctx, '测试操作', () => 'done')
  check('guard 返回操作结果', g.operation.result === 'done', JSON.stringify(g.operation))
  check('guard 因预检不过而 ok=false', g.ok === false, JSON.stringify({ ok: g.ok }))

  // guard：操作抛异常也要留下记录
  const g2 = await guard(ctx, '会失败的操作', () => { throw new Error('boom') })
  check('guard 捕获操作异常', g2.operation.error === 'boom', String(g2.operation.error))
  check('guard 在异常时仍做了预检', typeof g2.after.blocking === 'boolean')

  rmSync(env.home, { recursive: true, force: true })
}

// ── 真实环境（只读）─────────────────────────────────────────────────────

section('真实环境（只读）')

{
  const ctx = resolveContext({})
  const r = listPlugins(ctx)
  const pf = preflight(ctx)
  console.log(`  profile=${ctx.profile} 插件数=${r.counts?.total} 选中=${r.counts?.selected} 风险=${r.counts?.risky}`)
  console.log(`  安全重启=${pf.safeToRestart}  ${pf.summary}`)
  check('真实环境插件总览可用', r.ok === true)
  check('真实环境预检可用', typeof pf.safeToRestart === 'boolean')
  check('真实环境当前安全重启', pf.safeToRestart === true, JSON.stringify(pf.blockers))
  check('真实环境无风险插件', (r.counts?.risky ?? 0) === 0, JSON.stringify(r.plugins.filter((p) => p.risk).map((p) => p.name)))
}

console.log(`\n结果: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)