#!/usr/bin/env node
/**
 * dcm.mjs — 命令行入口（外部 UI 之外的第二种用法）。
 *
 * 用法：
 *   node bin/dcm.mjs status                     工作区状态
 *   node bin/dcm.mjs health                     profile 健康诊断
 *   node bin/dcm.mjs crash                      崩溃评估
 *   node bin/dcm.mjs recover [--ref <hash>] [--dry-run] [--yes]
 *   node bin/dcm.mjs save "说明"                建还原点
 *   node bin/dcm.mjs log [n]                    历史
 *   node bin/dcm.mjs diff [ref]                 差异
 *   node bin/dcm.mjs restore <ref> [path...]    还原
 *   node bin/dcm.mjs tag <name> [说明]          里程碑
 *   node bin/dcm.mjs sessions [scan|fix]        会话扫描/修复
 *   node bin/dcm.mjs serve [--port N]           启动外部 Web UI
 *
 * 全局选项：--home <dir> --profile <name> --json
 *
 * DSH 起不来时这个入口仍然可用——它只依赖 node 与 git。
 */

import { resolveContext } from '../lib/paths.mjs'
import * as gitlib from '../lib/git.mjs'
import { runAll, SEVERITY } from '../lib/health.mjs'
import { assess, recover, forensicDiff } from '../lib/crash.mjs'
import { scanAll, repairFile } from '../lib/sessions.mjs'
import { listPlugins, preflight, neutralizeMissingBundles } from '../lib/plugins.mjs'

/** 极简参数解析：位置参数 + `--key value` / `--flag`。 */
function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        const key = a.slice(2)
        const next = argv[i + 1]
        if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i += 1 }
        else flags[key] = true
      }
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

const { positional, flags } = parseArgs(process.argv.slice(2))
const command = positional[0] ?? 'status'
const json = flags.json === true

const ctx = resolveContext({
  home: typeof flags.home === 'string' ? flags.home : undefined,
  profile: typeof flags.profile === 'string' ? flags.profile : undefined,
})

function out(obj) {
  if (json) { console.log(JSON.stringify(obj, null, 2)); return }
  return obj
}

/** 把健康报告渲染成人类可读文本。 */
function renderHealth(report) {
  const mark = { err: 'X', warn: '!', info: '.' }
  console.log(`profile: ${report.ctx.profile}   home: ${report.ctx.home}`)
  console.log(`结果: ${report.ok ? '健康' : '有问题'}  (${report.errors} 错误, ${report.warnings} 警告)`)
  for (const c of report.checks) {
    const bad = c.items.filter((i) => i.severity !== SEVERITY.INFO)
    if (bad.length === 0) {
      const info = c.items[0]
      console.log(`  ok   ${c.title}${info ? ' — ' + info.message : ''}`)
      continue
    }
    console.log(`  ${c.title}:`)
    for (const i of bad) {
      console.log(`    ${mark[i.severity]} ${i.bundle ?? i.dep ?? ''} ${i.message}`)
      if (i.remedy) console.log(`      -> ${i.remedy}`)
    }
  }
}

switch (command) {
  case 'status': {
    if (!gitlib.isRepo(ctx.repoRoot)) {
      console.error(`不是 git 仓库: ${ctx.repoRoot}`)
      process.exit(2)
    }
    const st = gitlib.status(ctx.repoRoot)
    const log = gitlib.log(ctx.repoRoot, 5)
    if (json) { out({ profile: ctx.profile, home: ctx.home, status: st, recent: log.commits }); break }
    console.log(`profile: ${ctx.profile}`)
    console.log(`repo:    ${ctx.repoRoot}`)
    if (st.clean) {
      console.log('工作区:  干净')
    } else {
      console.log(`工作区:  ${st.entries.length} 处未保存改动`)
      for (const e of st.entries) console.log(`  ${e.status} ${e.path}`)
    }
    console.log('最近还原点:')
    for (const c of log.commits) console.log(`  ${c.short}  ${c.date}  ${c.subject}`)
    break
  }

  case 'health': {
    const report = runAll(ctx)
    if (json) { out(report); break }
    renderHealth(report)
    process.exit(report.ok ? 0 : 1)
    break
  }

  case 'crash': {
    const a = assess(ctx)
    if (json) { out(a); break }
    console.log(`profile: ${ctx.profile}   崩溃判定: ${a.crashed ? '是' : '否'} (置信度 ${a.confidence})`)
    for (const s of a.signals) {
      const mark = s.severity === 'err' ? 'X' : s.severity === 'warn' ? '!' : '.'
      console.log(`  ${mark} [${s.kind}] ${s.message}`)
    }
    console.log(`健康检查: ${a.health.errors} 错误, ${a.health.warnings} 警告`)
    console.log(`建议: ${a.recommendation.action}${a.recommendation.ref ? ' -> ' + a.recommendation.ref.slice(0, 7) : ''}`)
    console.log(`      ${a.recommendation.reason}`)
    break
  }

  case 'recover': {
    const dry = flags['dry-run'] === true
    if (!dry && flags.yes !== true && !json) {
      const a = assess(ctx)
      console.log(`将把 profile 还原到: ${String(a.recommendation.ref).slice(0, 7)}`)
      console.log(`理由: ${a.recommendation.reason}`)
      console.log('当前状态会先存成取证提交（不会丢）。')
      console.log('确认请加 --yes 重跑。')
      process.exit(1)
    }
    const r = recover(ctx, { ref: typeof flags.ref === 'string' ? flags.ref : undefined, dryRun: dry })
    if (json) { out(r); break }
    if (dry) {
      console.log(`[dry-run] 将还原到 ${String(r.ref).slice(0, 7)}`)
      for (const f of r.files ?? []) console.log(`  ${f}`)
      break
    }
    if (!r.ok) { console.error(`恢复失败: ${r.error}`); process.exit(1) }
    console.log(`已还原到 ${String(r.ref).slice(0, 7)}`)
    console.log(`取证提交: ${r.forensic?.short ?? '-'}`)
    console.log(`健康检查: ${r.healthBefore.errors} -> ${r.healthAfter.errors} 错误`)
    break
  }

  case 'save': {
    const r = gitlib.save(ctx.repoRoot, positional[1])
    if (json) { out(r); break }
    if (!r.ok) { console.error(`保存失败: ${r.reason}`); process.exit(1) }
    if (!r.committed) { console.log('没有新改动,无需保存。'); break }
    console.log(`已保存还原点 ${r.short}: ${r.subject}`)
    for (const f of r.files) console.log(`  ${f}`)
    break
  }

  case 'log': {
    const n = Number(positional[1] ?? 20)
    const r = gitlib.log(ctx.repoRoot, Number.isFinite(n) ? n : 20)
    if (json) { out(r); break }
    for (const c of r.commits) console.log(`${c.short}  ${c.date}  ${c.subject}`)
    break
  }

  case 'diff': {
    const from = typeof positional[1] === 'string' ? positional[1] : undefined
    const d = gitlib.diff(ctx.repoRoot, { from, path: typeof positional[2] === 'string' ? positional[2] : undefined })
    if (json) { out(d); break }
    console.log(d.text === '' ? '(无差异)' : d.text)
    break
  }

  case 'restore': {
    const ref = positional[1]
    if (!ref) { console.error('用法: restore <ref> [path...]'); process.exit(2) }
    const paths = positional.slice(2)
    const r = gitlib.restore(ctx.repoRoot, ref, paths)
    if (json) { out(r); break }
    if (!r.ok) { console.error(`还原失败: ${r.error}`); process.exit(1) }
    console.log(`已还原到 ${ref.slice(0, 7)}:`)
    for (const p of r.restored) console.log(`  ${p}`)
    for (const f of r.failed) console.log(`  跳过 ${f.path} (${f.error})`)
    break
  }

  case 'tag': {
    const name = positional[1]
    if (!name) { console.error('用法: tag <name> [说明]'); process.exit(2) }
    const r = gitlib.tag(ctx.repoRoot, name, positional[2])
    if (json) { out(r); break }
    if (!r.ok) { console.error(`打标签失败: ${r.error}`); process.exit(1) }
    console.log(`已打里程碑 ${name}`)
    break
  }

  case 'sessions': {
    const sub = positional[1] ?? 'scan'
    if (sub === 'scan') {
      const scan = scanAll(ctx.sessionsRoot)
      if (json) { out(scan); break }
      console.log(`扫描 ${scan.total} 个会话: ok=${scan.summary.ok ?? 0} fixable=${scan.summary.fixable ?? 0} corrupt=${scan.summary.corrupt ?? 0}`)
      for (const f of scan.files) {
        if (f.report.status === 'ok') continue
        console.log(`  [${f.report.status}] ${f.session}`)
        console.log(`      ${f.report.reason}`)
      }
      break
    }
    if (sub === 'fix') {
      const scan = scanAll(ctx.sessionsRoot)
      const results = []
      for (const f of scan.files) {
        if (f.report.status !== 'fixable') continue
        results.push({ path: f.path, session: f.session, ...repairFile(f.path, { dryRun: flags['dry-run'] === true }) })
      }
      if (json) { out({ scanned: scan.total, repaired: results }); break }
      if (results.length === 0) { console.log('没有需要修复的会话。'); break }
      for (const r of results) {
        console.log(`${r.ok ? 'ok' : 'FAIL'} ${r.action} ${r.session}${r.backupPath ? ` (备份 ${r.backupPath})` : ''}`)
        if (!r.ok) console.log(`     ${r.error}`)
      }
      break
    }
    console.error(`未知子命令: sessions ${sub}`)
    process.exit(2)
    break
  }

  case 'preflight': {
    const pf = preflight(ctx)
    if (json) { out(pf); break }
    console.log(pf.safeToRestart ? '可以安全重启' : '不要重启 —— 会触发 profile 重置')
    console.log(`  ${pf.summary}`)
    for (const b of pf.blockers) console.log(`  X [${b.source}] ${b.message}${b.remedy ? `\n      -> ${b.remedy}` : ''}`)
    process.exit(pf.safeToRestart ? 0 : 1)
    break
  }

  case 'plugins': {
    const r = listPlugins(ctx)
    if (json) { out(r); break }
    if (!r.ok) { console.error(r.error); process.exit(1) }
    console.log(`profile ${r.profile}: ${r.counts.total} 项（选中 ${r.counts.selected}，风险 ${r.counts.risky}）`)
    for (const p of r.plugins) {
      const mark = p.risk?.severity === 'err' ? 'X' : p.risk?.severity === 'warn' ? '!' : p.selected ? '·' : ' '
      const flags = [p.selected ? 'bundle' : '', p.declared ? 'dep' : '', p.hostProvided ? 'asar' : (p.onDisk ? 'disk' : 'MISSING')].filter(Boolean).join('/')
      console.log(`  ${mark} ${p.name.padEnd(42)} ${flags}`)
      if (p.risk) console.log(`      ${p.risk.reason}`)
    }
    break
  }

  case 'neutralize': {
    const r = neutralizeMissingBundles(ctx, { dryRun: flags['dry-run'] === true })
    if (json) { out(r); break }
    if (!r.ok) { console.error(r.error ?? r.message); process.exit(1) }
    console.log(r.message)
    if (r.removed?.length) for (const n of r.removed) console.log(`  - ${n}`)
    if (r.snapshot) console.log(`还原点: ${r.snapshot}`)
    break
  }

  case 'serve': {
    const { startServer } = await import('../lib/server.mjs')
    const port = Number(flags.port ?? 14711)
    await startServer({ ctx, port, open: flags.open !== false })
    break
  }

  default:
    console.error(`未知命令: ${command}`)
    console.error('可用: status health crash preflight plugins neutralize recover save log diff restore tag sessions serve')
    process.exit(2)
}
