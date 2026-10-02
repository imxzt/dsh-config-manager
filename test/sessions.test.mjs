/**
 * sessions.test.mjs — 会话扫描/修复自测。
 *
 * 用法：node test/sessions.test.mjs
 *
 * 测试策略：**构造真实的损坏字节**（而不是 mock），验证 analyze 能识别、
 * repair 能修好、且修好的字节能被 DSH 的读取逻辑接受（多帧 + 合法 header
 * + seq 连续 + checksum 帧）。这是唯一能证明修复有效的方式。
 */

import { zstdCompressSync, zstdDecompressSync, constants as zlibConstants } from 'node:zlib'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scanFrames, decodeAll, isSessionHeader, recordSeqRange, analyze, repair,
  parseLogName, walkSessionFiles, scanAll, repairFile,
} from '../lib/sessions.mjs'

let passed = 0
let failed = 0

function check(name, cond, detail = '') {
  if (cond) { passed += 1; console.log(`  ok   ${name}`) }
  else { failed += 1; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

function section(t) { console.log(`\n== ${t} ==`) }

/** 带 checksum 的压缩，与 DSH 落盘一致。 */
const ck = (s) => zstdCompressSync(Buffer.from(s, 'utf8'), { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } })

const HEADER = JSON.stringify({
  type: 'session', version: 4, id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  createdAt: 1759400000000, delegationDepth: 0,
})

/** 构造一条 storage record。 */
const rec = (seq, type = 'step/start') => JSON.stringify({ seq, type, data: {} })

/** 正常多帧会话：首帧 header，之后每帧一条记录。 */
function healthy(events = 3) {
  const frames = [ck(HEADER + '\n')]
  for (let i = 0; i < events; i++) frames.push(ck(rec(i) + '\n'))
  return Buffer.concat(frames)
}

/** 单帧布局违规：全部内容压成一个帧。 */
function singleFrame(events = 3) {
  let text = HEADER + '\n'
  for (let i = 0; i < events; i++) text += rec(i) + '\n'
  return ck(text)
}

// ── 基础解析 ────────────────────────────────────────────────────────────

section('基础解析')

{
  const b = healthy(3)
  const frames = scanFrames(b)
  check('正常文件扫出 4 个帧（1 header + 3 事件）', frames.length === 4, String(frames.length))
  check('无 torn 帧', frames.every((f) => !f.torn))
  check('decodeAll 得到 4 行', decodeAll(b).split('\n').filter((l) => l.trim()).length === 4)
}

{
  const h = JSON.parse(HEADER)
  check('isSessionHeader 接受合法 header', isSessionHeader(h))
  check('isSessionHeader 拒绝缺 version', !isSessionHeader({ ...h, version: undefined }))
  check('isSessionHeader 拒绝非对象', !isSessionHeader('x'))
  check('isSessionHeader 拒绝 createdAt 非整数', !isSessionHeader({ ...h, createdAt: 1.5 }))
  check('isSessionHeader 拒绝负 delegationDepth', !isSessionHeader({ ...h, delegationDepth: -1 }))
}

{
  check('recordSeqRange 解析 seq', recordSeqRange(rec(7)).first === 7)
  const multi = JSON.stringify({ seq0: 10, type: 'step/end', data: { texts: ['a', 'b', 'c'] } })
  const r = recordSeqRange(multi)
  check('recordSeqRange 处理 seq0 + texts 区间', r.first === 10 && r.last === 12, JSON.stringify(r))
  check('recordSeqRange 非 JSON 返回 null', recordSeqRange('{oops') === null)
  check('recordSeqRange 无 seq 返回 noSeq', recordSeqRange(JSON.stringify({ type: 'x' })).noSeq === true)
}

// ── 健康文件 ────────────────────────────────────────────────────────────

section('健康文件判定')

{
  const a = analyze(healthy(3))
  check('正常多帧判 ok', a.status === 'ok', JSON.stringify(a))
  check('事件数正确', a.events === 3, String(a.events))
  check('帧数正确', a.frames === 4, String(a.frames))
}

{
  // 空会话：单帧只有 header，合法
  const a = analyze(ck(HEADER + '\n'))
  check('单帧仅 header 判 ok（空会话合法）', a.status === 'ok', JSON.stringify(a))
  check('空会话 events=0', a.events === 0)
}

// ── 单帧布局违规 ────────────────────────────────────────────────────────

section('单帧布局违规（legacy）')

{
  const b = singleFrame(3)
  const a = analyze(b)
  check('识别为 fixable', a.status === 'fixable', JSON.stringify(a))
  check('原因是 single-frame layout violation', a.reason === 'single-frame layout violation', a.reason)
  check('报告事件数 3', a.events === 3, String(a.events))

  const fixed = repair(b, a)
  const after = analyze(fixed)
  check('修复后判 ok', after.status === 'ok', JSON.stringify(after))
  // 修复语义与参考实现一致：切成「header 帧 + 其余文本一帧」= 2 帧。
  // 判 ok 的条件是「帧数 >= 2 且 seq 连续」，2 帧即满足。
  check('修复后为 2 帧（header + 其余）', scanFrames(fixed).length === 2, String(scanFrames(fixed).length))
  check('修复后首帧只含 header 行', (() => {
    const fr = scanFrames(fixed)
    const first = zstdDecompressSync(fixed.subarray(fr[0].start, fr[0].end)).toString('utf8')
    return first.split('\n').filter((l) => l.trim()).length === 1
  })())
  check('修复后文本内容不变', decodeAll(fixed) === decodeAll(b))
  check('修复后事件数不变', after.events === 3, String(after.events))
  check('修复产出的帧带 checksum', (() => {
    const fr = scanFrames(fixed)
    return fr.every((f) => (fixed[f.start + 4] & 4) !== 0)
  })())
}

// ── synthetic-closer 重叠 ───────────────────────────────────────────────

section('synthetic-closer 重叠')

{
  // 帧 1: seq 0；帧 2: 合成收尾对 (seq1 step/end, seq2 turn/end)；
  // 帧 3: 从 seq 1 重新开始（重叠）→ 应删掉帧 2。
  const parts = [
    ck(HEADER + '\n'),
    ck(rec(0) + '\n'),
    ck(JSON.stringify({ seq: 1, type: 'step/end', data: {} }) + '\n' + JSON.stringify({ seq: 2, type: 'turn/end', data: {} }) + '\n'),
    ck(rec(1) + '\n'),
  ]
  const b = Buffer.concat(parts)
  const a = analyze(b)
  check('识别为 fixable', a.status === 'fixable', JSON.stringify(a))
  check('原因是 synthetic-closer overlap', a.reason === 'synthetic-closer overlap', a.reason)
  check('给出 repairStart/repairEnd', typeof a.repairStart === 'number' && typeof a.repairEnd === 'number')

  const fixed = repair(b, a)
  const after = analyze(fixed)
  check('修复后判 ok', after.status === 'ok', JSON.stringify(after))
  check('修复后少了收尾帧（3 帧）', scanFrames(fixed).length === 3, String(scanFrames(fixed).length))
  check('修复后 seq 连续', after.status === 'ok')
}

{
  // 双重叠：应循环删除直到干净
  const parts = [
    ck(HEADER + '\n'),
    ck(rec(0) + '\n'),
    ck(JSON.stringify({ seq: 1, type: 'step/end', data: {} }) + '\n' + JSON.stringify({ seq: 2, type: 'turn/end', data: {} }) + '\n'),
    ck(rec(1) + '\n'),
    ck(JSON.stringify({ seq: 2, type: 'step/end', data: {} }) + '\n' + JSON.stringify({ seq: 3, type: 'turn/end', data: {} }) + '\n'),
    ck(rec(2) + '\n'),
  ]
  const b = Buffer.concat(parts)
  const a = analyze(b)
  check('双重叠识别为 fixable', a.status === 'fixable', JSON.stringify(a))
  const fixed = repair(b, a)
  check('双重叠修复后 ok', analyze(fixed).status === 'ok', JSON.stringify(analyze(fixed)))
}

// ── 不可修复的损坏 ──────────────────────────────────────────────────────

section('不可修复的损坏')

{
  // 截断的帧
  const b = healthy(2).subarray(0, healthy(2).length - 5)
  const a = analyze(b)
  check('截断文件判 corrupt 或 fixable', a.status === 'corrupt' || a.status === 'fixable', JSON.stringify(a))
}

{
  // 首行不是合法 header
  const b = ck('{"type":"nope"}\n' + rec(0) + '\n')
  const a = analyze(b)
  check('非法 header 判 corrupt', a.status === 'corrupt', JSON.stringify(a))
  check('原因是 header 无效', /session header/.test(a.reason), a.reason)
}

{
  // seq 缺口（真实损坏，不能自动修）
  const b = Buffer.concat([ck(HEADER + '\n'), ck(rec(0) + '\n'), ck(rec(5) + '\n')])
  const a = analyze(b)
  check('seq 缺口判 corrupt', a.status === 'corrupt', JSON.stringify(a))
  check('原因含 seq gap', /seq gap/.test(a.reason), a.reason)
  const r = repairFile('/nonexistent', { dryRun: true })
  check('repairFile 对不存在文件返回错误', r.ok === false)
}

{
  // 坏 JSON 行
  const b = Buffer.concat([ck(HEADER + '\n'), ck('{not json\n')])
  const a = analyze(b)
  check('坏 JSON 行判 corrupt', a.status === 'corrupt', JSON.stringify(a))
  check('原因含 bad JSON', /bad JSON/.test(a.reason), a.reason)
}

{
  // corrupt 的文件不应被 repair 接受
  let threw = false
  try { repair(Buffer.from('garbage'), { status: 'corrupt', reason: 'x' }) } catch { threw = true }
  check('repair 拒绝非 fixable 输入', threw)
}

// ── 文件名与遍历 ────────────────────────────────────────────────────────

section('文件名识别与遍历')

{
  check('session.jsonl.zstd → 第 0 代', parseLogName('session.jsonl.zstd').generation === 0)
  check('session.v4.jsonl.zstd → 第 4 代', parseLogName('session.v4.jsonl.zstd').generation === 4)
  check('session.v12.jsonl.zstd → 第 12 代', parseLogName('session.v12.jsonl.zstd').generation === 12)
  check('大小写不敏感', parseLogName('SESSION.V4.JSONL.ZSTD').generation === 4)
  check('无关文件返回 null', parseLogName('other.jsonl.zstd') === null)
}

{
  const root = mkdtempSync(join(tmpdir(), 'dcm-sess-'))
  const ws = join(root, '--C-Users-x-proj--')
  const s1 = join(ws, 'session-11111111-1111-1111-1111-111111111111')
  const s2 = join(ws, 'session-22222222-2222-2222-2222-222222222222')
  mkdirSync(s1, { recursive: true })
  mkdirSync(s2, { recursive: true })
  writeFileSync(join(s1, 'session.v4.jsonl.zstd'), healthy(2))
  // s2 有多代并存，应只取最高代
  writeFileSync(join(s2, 'session.v2.jsonl.zstd'), healthy(1))
  writeFileSync(join(s2, 'session.v4.jsonl.zstd'), singleFrame(3))
  writeFileSync(join(s2, 'notes.txt'), 'ignore me')

  const files = walkSessionFiles(root)
  check('遍历到 2 个会话', files.length === 2, String(files.length))
  const second = files.find((f) => f.session.includes('22222222'))
  check('多代并存取最高代 v4', second.file === 'session.v4.jsonl.zstd', second.file)
  check('记录了被跳过的低代', second.superseded.includes('session.v2.jsonl.zstd'), JSON.stringify(second.superseded))

  const scan = scanAll(root)
  check('scanAll 汇总总数 2', scan.total === 2, String(scan.total))
  check('scanAll 认出 1 个 fixable', scan.summary.fixable === 1, JSON.stringify(scan.summary))
  check('scanAll 认出 1 个 ok', scan.summary.ok === 1, JSON.stringify(scan.summary))

  // dry-run 不写盘
  const target = join(s2, 'session.v4.jsonl.zstd')
  const before = readFileSync(target)
  const dry = repairFile(target, { dryRun: true })
  check('dry-run 报告 would-repair', dry.ok && dry.action === 'would-repair', JSON.stringify(dry))
  check('dry-run 不修改文件', readFileSync(target).equals(before))

  // 真修：应产生备份且文件变 ok
  const real = repairFile(target, { dryRun: false })
  check('真修成功', real.ok && real.action === 'repaired', JSON.stringify(real))
  check('产生了备份文件', real.backupPath !== null && existsSync(real.backupPath), String(real.backupPath))
  check('备份内容等于原文件', readFileSync(real.backupPath).equals(before))
  check('修复后文件判 ok', analyze(readFileSync(target)).status === 'ok')
  check('修复后字节数变化被记录', typeof real.bytesBefore === 'number' && typeof real.bytesAfter === 'number')

  // 已 ok 的文件再修应为 none
  const again = repairFile(target, { dryRun: true })
  check('已健康文件返回 action=none', again.ok && again.action === 'none', JSON.stringify(again))

  // corrupt 文件拒绝修复
  const badPath = join(s1, 'session.v4.jsonl.zstd')
  writeFileSync(badPath, Buffer.from('not zstd at all'))
  const bad = repairFile(badPath, { dryRun: false })
  check('corrupt 文件被拒绝修复', bad.ok === false && bad.action === 'refuse', JSON.stringify(bad))
  check('被拒绝时未写盘', readFileSync(badPath).toString() === 'not zstd at all')

  rmSync(root, { recursive: true, force: true })
}

// ── 真实会话文件（只读冒烟）─────────────────────────────────────────────

section('真实会话文件（只读）')

{
  const root = join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh'), 'sessions')
  const files = walkSessionFiles(root)
  if (files.length === 0) {
    console.log('  skip — 本机没有会话文件')
  } else {
    const scan = scanAll(root)
    console.log(`  扫描 ${scan.total} 个会话: ok=${scan.summary.ok ?? 0} fixable=${scan.summary.fixable ?? 0} corrupt=${scan.summary.corrupt ?? 0}`)
    check('真实会话扫描能跑完', typeof scan.total === 'number')
    check('真实会话无 corrupt（当前机器健康）', (scan.summary.corrupt ?? 0) === 0, JSON.stringify(scan.summary))
    for (const f of scan.files) {
      if (f.report.status !== 'ok') console.log(`    ${f.report.status}: ${f.session} — ${f.report.reason}`)
    }
  }
}

console.log(`\n结果: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
