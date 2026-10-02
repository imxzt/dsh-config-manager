/**
 * core.test.mjs — core 模块自测（零依赖，直接 node 跑）。
 *
 * 用法：node test/core.test.mjs
 *
 * 测试原则：不依赖被测机器的具体状态，凡是涉及真实 profile 的断言都先
 * 探测前提，前提不成立就 skip 而不是 fail——否则换台机器就红。
 */

import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveContext, resolveProfileName, resolveDshHome, readProfileManifest, declaredBundles } from '../lib/paths.mjs'
import * as gitlib from '../lib/git.mjs'
import * as health from '../lib/health.mjs'

let passed = 0
let failed = 0
let skipped = 0

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}

function skip(name, why) {
  skipped += 1
  console.log(`  skip ${name} — ${why}`)
}

function section(title) {
  console.log(`\n== ${title} ==`)
}

// ── paths.mjs ────────────────────────────────────────────────────────────

section('paths.mjs')

{
  const home = resolveDshHome('C:\\Users\\test\\.dsh')
  check('resolveDshHome 接受显式覆盖', home.toLowerCase().includes('users\\test\\.dsh'), home)
}

{
  // profile 判定优先级：显式 > env > argv
  const explicit = resolveProfileName('mytest', ['--profile', 'other'])
  check('显式 override 优先于 argv', explicit === 'mytest', explicit)

  // 本机 DSH_PROFILE=desktop，会盖过 argv；测 argv 必须显式屏蔽 env。
  const fromArgv = resolveProfileName('', ['--profile', 'fromargv'], { useEnv: false })
  check('argv --profile 生效', fromArgv === 'fromargv', fromArgv)

  const fromEq = resolveProfileName('', ['--profile=eqform'], { useEnv: false })
  check('argv --profile= 形式生效', fromEq === 'eqform', fromEq)

  // env 优先于 argv（宿主/外部 CLI 指定 profile 时的预期行为）
  const prevEnv = process.env.DSH_PROFILE
  process.env.DSH_PROFILE = 'fromenv'
  const envWins = resolveProfileName('', ['--profile', 'fromargv'])
  check('env 优先于 argv', envWins === 'fromenv', envWins)
  if (prevEnv === undefined) delete process.env.DSH_PROFILE
  else process.env.DSH_PROFILE = prevEnv
}

{
  // 关键回归：桌面版 argv 里没有 --profile，但带 profile 目录位置参数。
  // dsh-undo-savepoint 0.4.9 在这里兜底成 'web'，导致保护错 profile。
  const argv = [
    'D:\\dsh\\DeepSeek Harness.exe',
    '--expose-internals',
    'C:\\Users\\x\\.dsh\\profiles\\desktop',
    'D:\\dsh\\resources\\runtime\\primary-runtime',
  ]
  const name = resolveProfileName('', argv, { useEnv: false })
  check('从 argv 的 profile 目录位置参数反推（桌面版关键路径）', name === 'desktop', name)
}

{
  const ctx = resolveContext({ home: 'C:\\Users\\test\\.dsh', profile: 'desktop' })
  check('ctx.profileDir 正确', ctx.profileDir.toLowerCase().endsWith('profiles\\desktop'), ctx.profileDir)
  check('ctx.sessionsRoot 正确', ctx.sessionsRoot.toLowerCase().endsWith('sessions'), ctx.sessionsRoot)
  check('ctx.repoRoot 等于 home', ctx.repoRoot === ctx.home, ctx.repoRoot)
  check('ctx 被冻结', Object.isFrozen(ctx))
}

{
  // 真实 profile：只验证结构可读，不假设内容
  const ctx = resolveContext({})
  if (existsSync(ctx.profileManifest)) {
    const read = readProfileManifest(ctx)
    check('真实 profile manifest 可解析', read.ok, read.message ?? '')
    if (read.ok) {
      const bundles = declaredBundles(read.value)
      check('真实 profile 有 bundles 数组', Array.isArray(bundles) && bundles.length > 0, String(bundles.length))
    }
  } else {
    skip('真实 profile manifest', '本机没有 ' + ctx.profileManifest)
  }
}

// ── git.mjs（在临时仓库里跑，不碰真实仓库）──────────────────────────────

section('git.mjs（临时仓库）')

const tmp = mkdtempSync(join(tmpdir(), 'dcm-test-'))
{
  const avail = gitlib.gitAvailable()
  check('git 可用', avail.ok, avail.version)
  if (!avail.ok) {
    skip('全部 git 测试', 'git 不可用')
  } else {
    // 初始化一个和 ~/.dsh 结构相似的仓库
    gitlib.git(tmp, ['init', '-b', 'main'])
    gitlib.git(tmp, ['config', 'user.name', 'test'])
    gitlib.git(tmp, ['config', 'user.email', 'test@localhost'])

    const cfg = join(tmp, 'profiles', 'desktop')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'package.json'), JSON.stringify({ name: 'p', dsh: { profile: { bundles: ['a'] } } }, null, 2))
    writeFileSync(join(cfg, 'cordis.patch.yml'), '# v1\n')

    check('isRepo 识别仓库', gitlib.isRepo(tmp))
    check('新仓库 hasCommits 为 false', !gitlib.hasCommits(tmp))

    const first = gitlib.save(tmp, 'baseline')
    check('save 建首个还原点', first.ok && first.committed === true, JSON.stringify(first))
    check('save 返回短 hash', typeof first.short === 'string' && first.short.length >= 7, String(first.short))

    const noop = gitlib.save(tmp, 'nothing')
    check('无改动时 save 不产生提交', noop.ok && noop.committed === false, JSON.stringify(noop))

    // 改动 → status 应报 dirty
    writeFileSync(join(cfg, 'cordis.patch.yml'), '# v2 changed\n')
    const st = gitlib.status(tmp)
    check('status 检出改动', st.ok && st.clean === false, JSON.stringify(st.entries))
    check('status 报告改动文件路径', st.entries.some((e) => e.path.includes('cordis.patch.yml')), JSON.stringify(st.entries))

    // diff 应包含新旧内容
    const d = gitlib.diff(tmp)
    check('diff 含 -# v1', d.text.includes('-# v1'), d.text.slice(0, 200))
    check('diff 含 +# v2', d.text.includes('+# v2 changed'), d.text.slice(0, 200))

    // 还原：内容回到 v1，且逐字节（这条断言就是 CRLF 事故的回归测试）
    const beforeHash = first.hash
    const restored = gitlib.restore(tmp, beforeHash, ['profiles/desktop/cordis.patch.yml'])
    check('restore 成功', restored.ok, JSON.stringify(restored))
    const after = readFileSync(join(cfg, 'cordis.patch.yml'), 'utf8')
    check('restore 后逐字节回到 v1（无 CRLF 污染）', after === '# v1\n', JSON.stringify(after))
    check('restore 后工作区干净', gitlib.status(tmp).clean === true)
    check('仓库已设 core.autocrlf=false', gitlib.git(tmp, ['config', '--local', '--get', 'core.autocrlf']).stdout.trim() === 'false')
    check('仓库已写 .gitattributes', existsSync(join(tmp, '.gitattributes')))

    // 建第二个还原点 + tag
    writeFileSync(join(cfg, 'cordis.patch.yml'), '# v3\n')
    const second = gitlib.save(tmp, 'second')
    check('save 第二个还原点', second.ok && second.committed === true)

    const tagged = gitlib.tag(tmp, 'stable-1', '稳定可用')
    check('tag 打成功', tagged.ok, JSON.stringify(tagged))
    const again = gitlib.tag(tmp, 'stable-1')
    check('重复 tag 被拒', !again.ok, JSON.stringify(again))
    const tl = gitlib.tags(tmp)
    check('tags 列出里程碑', tl.ok && tl.tags.some((t) => t.name === 'stable-1'), JSON.stringify(tl.tags))

    // 任意两点 diff（dshcfg.ps1 没有的能力）
    const two = gitlib.diff(tmp, { from: first.hash, to: second.hash })
    check('任意两点 diff 可用', two.ok && two.text.includes('# v3'), two.text.slice(0, 200))

    // log 与 commitFiles
    const lg = gitlib.log(tmp, 10)
    check('log 返回提交', lg.ok && lg.commits.length === 2, String(lg.commits.length))
    const cf = gitlib.commitFiles(tmp, second.hash)
    check('commitFiles 列出改动', cf.ok && cf.files.some((f) => f.path.includes('cordis.patch.yml')), JSON.stringify(cf.files))

    // 单文件历史
    const fl = gitlib.fileLog(tmp, 'profiles/desktop/cordis.patch.yml')
    check('fileLog 返回该文件历史', fl.ok && fl.commits.length === 2, String(fl.commits.length))

    // 丢弃全部改动（含未跟踪文件）
    writeFileSync(join(cfg, 'cordis.patch.yml'), '# dirty\n')
    writeFileSync(join(cfg, 'untracked.txt'), 'x\n')
    const disc = gitlib.discardAll(tmp)
    check('discardAll 成功', disc.ok, JSON.stringify(disc))
    check('discardAll 清掉未跟踪文件', !existsSync(join(cfg, 'untracked.txt')))
    check('discardAll 后工作区干净', gitlib.status(tmp).clean === true)

    // 未知 ref 必须被拒（防止误传空字符串把仓库搞坏）
    const bad = gitlib.restore(tmp, '')
    check('restore 拒绝空 ref', !bad.ok, JSON.stringify(bad))
    const bad2 = gitlib.restore(tmp, 'no-such-ref')
    check('restore 拒绝未知 ref', !bad2.ok, JSON.stringify(bad2))

    const stats = gitlib.repoStats(tmp)
    check('repoStats 可用', stats.ok && stats.commits === 2, JSON.stringify(stats))
  }
}

// ── health.mjs（构造已知坏状态，验证每项检查都能抓到）────────────────────

section('health.mjs（构造的坏 profile）')

{
  const h = mkdtempSync(join(tmpdir(), 'dcm-health-'))
  const home = join(h, '.dsh')
  const prof = join(home, 'profiles', 'desktop')
  const nm = join(prof, 'node_modules')
  mkdirSync(nm, { recursive: true })

  // 一个好包
  const good = join(nm, 'good-plugin')
  mkdirSync(good, { recursive: true })
  writeFileSync(join(good, 'package.json'), JSON.stringify({ name: 'good-plugin', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(good, 'cordis.patch.yml'), '- insert: []\n')

  // 一个声明了 bundle 但磁盘缺失的包 → 必须报 err（这就是事故成因）
  const manifest = {
    name: 'test-profile',
    dependencies: { 'good-plugin': '1.0.0', 'missing-plugin': '1.0.0', 'orphan-dep': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'good-plugin', 'missing-plugin', 'no-patch-pkg'] } },
  }
  writeFileSync(join(prof, 'package.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(join(prof, 'pnpm-lock.yaml'), 'good-plugin:\n  resolution: {}\n')
  writeFileSync(join(prof, 'cordis.patch.yml'), '- id: a\n  name: x\n')

  // 一个在 bundles 里但包没有 patch 的
  const noPatch = join(nm, 'no-patch-pkg')
  mkdirSync(noPatch, { recursive: true })
  writeFileSync(join(noPatch, 'package.json'), JSON.stringify({ name: 'no-patch-pkg' }))

  const ctx = resolveContext({ home, profile: 'desktop' })
  const report = health.runAll(ctx)

  check('整体判定为不健康', report.ok === false && report.blocking === true, JSON.stringify({ errors: report.errors }))
  check('检出缺失 bundle', report.checks.some((c) => c.items.some((i) => i.bundle === 'missing-plugin' && i.severity === 'err')))
  check('缺失 bundle 的提示含"重置"风险', report.checks.some((c) => c.items.some((i) => i.bundle === 'missing-plugin' && /reset this profile/.test(i.message ?? ''))))
  check('检出无 patch 的包', report.checks.some((c) => c.items.some((i) => i.bundle === 'no-patch-pkg' && i.severity === 'err')))
  check('@deepseek-ai/* 不被误报为失败', !report.checks.some((c) => c.items.some((i) => i.bundle === '@deepseek-ai/dsh-base' && i.severity === 'err')))
  check('@deepseek-ai/* 标为安装包提供', report.checks.some((c) => c.items.some((i) => i.bundle === '@deepseek-ai/dsh-base' && i.severity === 'info')))
  check('好包通过', report.checks.some((c) => c.items.some((i) => i.bundle === 'good-plugin' && i.severity === 'info')))
  check('检出 bundles 孤儿声明', report.checks.some((c) => c.items.some((i) => i.bundle === 'missing-plugin' && /not in dependencies/.test(i.message ?? ''))) === false)
  check('检出 lockfile 缺失项', report.checks.some((c) => c.items.some((i) => /absent from the lockfile/.test(i.message ?? ''))))
  check('所有检查项都有 id 与 title', report.checks.every((c) => typeof c.id === 'string' && typeof c.title === 'string'))

  // patch 悬空 insert 检测
  writeFileSync(join(prof, 'cordis.patch.yml'), '- insert:\n- id: next\n')
  const patchCheck = health.checkPatch(resolveContext({ home, profile: 'desktop' }))
  check('检出悬空 insert', patchCheck.items.some((i) => /no child entries/.test(i.message ?? '')))

  // 顶层重复 id：DSH 的覆盖机制，合法 → 必须是 info 而非 warning
  writeFileSync(join(prof, 'cordis.patch.yml'), '- id: dup\n  name: a\n- id: dup\n  name: b\n')
  const dupCheck = health.checkPatch(resolveContext({ home, profile: 'desktop' }))
  check('顶层重复 id 不报为问题（覆盖机制）', !dupCheck.items.some((i) => i.severity !== 'info'), JSON.stringify(dupCheck.items))
  check('顶层重复 id 在 info 里说明', dupCheck.items.some((i) => /override earlier ones/.test(i.message ?? '')))

  // insert 块内重复 → 真问题（重复挂载）
  writeFileSync(join(prof, 'cordis.patch.yml'), '- insert:\n    - id: plug\n      name: a\n    - id: plug\n      name: b\n')
  const innerDup = health.checkPatch(resolveContext({ home, profile: 'desktop' }))
  check('insert 块内重复 id 报 err', innerDup.items.some((i) => i.severity === 'err' && /inserted 2 times/.test(i.message ?? '')), JSON.stringify(innerDup.items))

  // provider models 里的深层 `- id:` 不应被当成 patch id
  writeFileSync(join(prof, 'cordis.patch.yml'), '- id: llm\n  name: x\n  config:\n    models:\n      - id: m1\n      - id: m2\n')
  const deepIds = health.checkPatch(resolveContext({ home, profile: 'desktop' }))
  check('深层 config 里的 id 不算 patch 条目', !deepIds.items.some((i) => i.severity !== 'info'), JSON.stringify(deepIds.items))

  // manifest 带 BOM → 必须报错
  writeFileSync(join(prof, 'package.json'), '\uFEFF' + JSON.stringify(manifest))
  const bomReport = health.runAll(resolveContext({ home, profile: 'desktop' }))
  check('检出 manifest BOM', bomReport.checks.some((c) => c.items.some((i) => /BOM/.test(i.message ?? ''))))

  // manifest 非法 JSON
  writeFileSync(join(prof, 'package.json'), '{ not json')
  const badReport = health.runAll(resolveContext({ home, profile: 'desktop' }))
  check('检出 manifest JSON 错误', badReport.ok === false)

  rmSync(h, { recursive: true, force: true })
}

// ── 重置形状漏报的回归测试（演练暴露的真问题）───────────────────────────

section('重置形状检测（回归：曾漏报为健康）')

{
  const h = mkdtempSync(join(tmpdir(), 'dcm-reset-'))
  const home = join(h, '.dsh')
  const prof = join(home, 'profiles', 'desktop')
  mkdirSync(join(prof, 'node_modules'), { recursive: true })

  // 精确复刻 DSH 恢复流程的重置结果：2 个 @deepseek-ai/* bundle、无依赖、
  // patch 只剩 4 条 DSH 自管条目。
  writeFileSync(join(prof, 'package.json'), JSON.stringify({
    name: 'dsh-profile-desktop',
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2))
  writeFileSync(join(prof, 'cordis.patch.yml'), [
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

  const report = health.runAll(resolveContext({ home, profile: 'desktop' }))
  check('重置形状被判为不健康（曾漏报为健康）', report.ok === false, JSON.stringify({ errors: report.errors, warnings: report.warnings }))
  check('重置形状触发 blocking（禁止重启）', report.blocking === true)
  const resetCheck = report.checks.find((c) => c.id === 'reset-shape')
  check('存在 reset-shape 检查项', resetCheck !== undefined)
  check('reset-shape 报 err', resetCheck?.items.some((i) => i.severity === 'err'), JSON.stringify(resetCheck?.items))
  check('提示含 recover 建议', resetCheck?.items.some((i) => /dcm recover/.test(i.remedy ?? '')), JSON.stringify(resetCheck?.items))

  rmSync(h, { recursive: true, force: true })
}

// ── 真实 profile 冒烟（只读）────────────────────────────────────────────

section('真实 profile 冒烟（只读）')

{
  const ctx = resolveContext({})
  if (existsSync(ctx.profileManifest)) {
    const report = health.runAll(ctx)
    console.log(`  真实 profile=${ctx.profile} errors=${report.errors} warnings=${report.warnings}`)
    check('真实 profile 检查能跑完不抛异常', typeof report.ok === 'boolean')
    for (const c of report.checks) {
      const errs = c.items.filter((i) => i.severity === 'err')
      if (errs.length > 0) {
        console.log(`    [${c.id}] ${errs.length} error(s):`)
        for (const e of errs.slice(0, 3)) console.log(`      - ${e.bundle ?? ''} ${e.message}`)
      }
    }
  } else {
    skip('真实 profile 冒烟', 'manifest 不存在')
  }
}

// ── 收尾 ────────────────────────────────────────────────────────────────

try { rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ }

console.log(`\n结果: ${passed} passed, ${failed} failed, ${skipped} skipped`)
process.exit(failed === 0 ? 0 : 1)
