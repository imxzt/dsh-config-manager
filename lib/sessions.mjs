/**
 * sessions.mjs — 会话日志扫描与修复（F 项）。
 *
 * 这是 dsh-undo-savepoint 的 `undo_scan` 的替代实现。移除那个插件后，
 * 会话文件修复能力就没有了，而 git 无法替代它——所以这里自建。
 *
 * 要修的是什么：DSH 的会话日志是 `<home>/sessions/--<cwd>--/session-<uuid>/
 * session.v4.jsonl.zstd`，正常布局是**多帧 zstd**（首帧只有 header 行，
 * 之后每帧若干条 storage record）。两种已知损坏：
 *
 *   1. **单帧布局违规**（legacy）：整个日志被压成一个帧。DSH 读取时按帧
 *      推进，单帧多事件会让它载入异常（曾表现为 8/18 会话打不开）。
 *      修法：拆回首帧=header、次帧=其余文本。
 *   2. **synthetic-closer 重叠**：崩溃恢复时写入了一个只含 `step/end` +
 *      `turn/end` 的「合成收尾帧」，而其后一帧又从收尾前的 seq 重新开始，
 *      造成 seq 重叠。修法：删掉那个收尾帧，让尾部恢复连续。
 *
 * 算法与参考实现（dsh-undo-savepoint v0.4.9 tools/session-scan.mjs）保持
 * 语义一致，但重写为零依赖、可单测的纯函数：`analyze(bytes)` 只读，
 * `repair(bytes)` 返回新 buffer 不落盘，落盘由调用方决定。
 */

import { zstdCompressSync, zstdDecompressSync, constants as zlibConstants } from 'node:zlib'
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

/** zstd 帧魔数（小端 0xFD2FB528）。 */
const ZSTD_MAGIC = 0xfd2fb528

/**
 * DSH 写帧时带 content checksum（实测真实会话文件帧头 ck 位为 1）。
 * 修复产出必须保持一致——否则 DSH 读修复后的文件会因校验缺失而行为异常。
 *
 * 参数名是 `zlib.constants.ZSTD_c_checksumFlag`（不是 `Symbol.for('zlib.zstdChecksum')`，
 * 后者会被静默忽略：实测加与不加的帧头完全相同）。
 */
const ZSTD_CHECKSUM = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }

/** 扫描出所有 zstd 帧的字节区间；torn=true 表示尾部有截断的帧。 */
export function scanFrames(b) {
  const frames = []
  let off = 0
  while (off < b.length) {
    const start = off
    if (b.length - off < 4) { frames.push({ start, end: off, torn: true }); return frames }
    if (b.readUInt32LE(off) !== ZSTD_MAGIC) throw new Error('bad frame magic at ' + off)
    off += 4
    if (off === b.length) { frames.push({ start, end: off, torn: true }); return frames }
    const d = b.readUInt8(off)
    off += 1
    if ((d & 24) !== 0) throw new Error('reserved frame-header bit at ' + (off - 1))
    const csf = d >>> 6
    const ss = (d & 32) !== 0
    const ck = (d & 4) !== 0
    const df = d & 3
    const db = df === 3 ? 4 : df
    const csb = csf === 0 ? (ss ? 1 : 0) : 1 << csf
    const rhb = (ss ? 0 : 1) + db + csb
    if (b.length - off < rhb) { frames.push({ start, end: off, torn: true }); return frames }
    off += rhb
    for (;;) {
      if (b.length - off < 3) { frames.push({ start, end: off, torn: true }); return frames }
      const bh = b.readUIntLE(off, 3)
      off += 3
      const last = (bh & 1) !== 0
      const bt = (bh >>> 1) & 3
      const bs = bh >>> 3
      if (bt === 3) throw new Error('reserved block type at ' + (off - 3))
      const pl = bt === 1 ? 1 : bs
      if (b.length - off < pl) { frames.push({ start, end: off, torn: true }); return frames }
      off += pl
      if (last) break
    }
    if (ck) {
      if (b.length - off < 4) { frames.push({ start, end: off, torn: true }); return frames }
      off += 4
    }
    frames.push({ start, end: off })
  }
  return frames
}

/** 逐帧解压并拼接成完整文本。任何 torn 帧都抛错。 */
export function decodeAll(b) {
  const frames = scanFrames(b)
  const parts = []
  for (const f of frames) {
    if (f.torn) throw new Error('torn frame at byte ' + f.start)
    parts.push(zstdDecompressSync(b.subarray(f.start, f.end)))
  }
  return Buffer.concat(parts).toString('utf8')
}

/** 会话 header 行的严格判定（与 DSH 落盘格式一致）。 */
export function isSessionHeader(v) {
  return typeof v === 'object' && v !== null && v.type === 'session'
    && typeof v.version === 'number' && typeof v.id === 'string'
    && typeof v.createdAt === 'number' && Number.isSafeInteger(v.createdAt) && v.createdAt >= 0
    && typeof v.delegationDepth === 'number' && Number.isSafeInteger(v.delegationDepth) && v.delegationDepth >= 0
}

/**
 * 一行 storage record 携带的 seq 区间。
 * 返回 `{ first, last, type }`、`{ noSeq: true, type }` 或 null（非 JSON）。
 */
export function recordSeqRange(line) {
  let v = null
  try { v = JSON.parse(line) } catch { return null }
  if (typeof v !== 'object' || v === null) return null
  if (Number.isSafeInteger(v.seq0)) {
    const texts = Array.isArray(v.data?.texts) ? v.data.texts : null
    const args = Array.isArray(v.data?.args) ? v.data.args : null
    const payload = texts ?? args
    if (payload && payload.length > 0) return { first: v.seq0, last: v.seq0 + payload.length - 1, type: v.type }
    return { first: v.seq0, last: v.seq0, type: v.type }
  }
  if (Number.isSafeInteger(v.seq)) return { first: v.seq, last: v.seq, type: v.type }
  return { noSeq: true, type: v.type }
}

/** 解析一个帧里的全部记录。返回 `{ records }` 或 `{ records: null, badLine }`。 */
export function frameRecords(b, frames, i) {
  const f = frames[i]
  const text = zstdDecompressSync(b.subarray(f.start, f.end)).toString('utf8')
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  const records = []
  for (const line of lines) {
    const r = recordSeqRange(line)
    if (!r) return { records: null, badLine: line }
    records.push({ line, ...r })
  }
  return { records }
}

/**
 * 只读分析。返回：
 *  - `{ status: 'ok', events, frames }`
 *  - `{ status: 'fixable', reason, ... , repairStart?, repairEnd? }`
 *  - `{ status: 'corrupt', reason }`
 *
 * `repairStart/repairEnd` 存在时表示「删除这段字节即可修好」（synthetic-closer
 * 重叠），否则 fixable 表示需要整体重编码（单帧布局违规）。
 */
export function analyze(b) {
  try {
    const frames = scanFrames(b)
    if (frames.some((f) => f.torn)) return { status: 'corrupt', reason: 'torn frame' }
    if (frames.length === 0) return { status: 'corrupt', reason: 'empty or header-less' }

    const headerText = zstdDecompressSync(b.subarray(frames[0].start, frames[0].end)).toString('utf8')
    const nl = headerText.indexOf('\n')
    if (nl === -1) return { status: 'corrupt', reason: 'no newline in decoded text' }
    let parsed = null
    try { parsed = JSON.parse(headerText.slice(0, nl)) } catch { /* 首行非 JSON */ }
    if (!isSessionHeader(parsed)) return { status: 'corrupt', reason: 'first line is not a valid session header' }

    if (frames.length < 2) {
      const text = decodeAll(b)
      const lines = text.split('\n').filter((l) => l.trim().length > 0)
      // 空会话合法落盘为单帧仅含 header（0 事件）→ ok；有事件行才是违规。
      if (lines.length <= 1) return { status: 'ok', events: 0, frames: frames.length }
      return {
        status: 'fixable',
        reason: 'single-frame layout violation',
        events: Math.max(0, lines.length - 1),
        frames: frames.length,
      }
    }

    const metas = []
    let expected = null
    let seqIssue = null
    let events = 0
    let badJson = null
    for (let i = 1; i < frames.length; i++) {
      const { records, badLine } = frameRecords(b, frames, i)
      if (!records) { badJson ??= { frame: i, line: badLine }; continue }
      const expectedBefore = expected
      const firstSeq = records[0]?.first
      const lastSeq = records.at(-1)?.last
      const types = records.map((r) => r.type)
      const isCloserPair = records.length === 2 && types[0] === 'step/end' && types[1] === 'turn/end'
        && records[1].first === records[0].first + 1
      for (const rec of records) {
        if (rec.noSeq) { events += 1; continue }
        events += rec.last - rec.first + 1
        if (expected === null) expected = rec.first
        else if (rec.first !== expected) seqIssue ??= { frame: i, expected, got: rec.first }
        expected = rec.last + 1
      }
      metas.push({ i, start: frames[i].start, end: frames[i].end, firstSeq, lastSeq, isCloserPair, expectedBefore })
    }

    if (badJson) return { status: 'corrupt', reason: `bad JSON line in frame ${badJson.frame}` }

    // synthetic-closer 重叠：只含收尾对的帧，其后一帧从收尾前的 seq 重新开始。
    let candidate = null
    for (let i = 0; i < metas.length; i++) {
      const m = metas[i]
      if (!m.isCloserPair) continue
      for (let j = i + 1; j < metas.length; j++) {
        if (metas[j].firstSeq === m.expectedBefore) {
          candidate = { start: m.start, end: m.end, expectedBefore: m.expectedBefore }
          break
        }
      }
      if (candidate) break
    }
    if (candidate) {
      return {
        status: 'fixable',
        reason: 'synthetic-closer overlap',
        events,
        frames: frames.length,
        repairStart: candidate.start,
        repairEnd: candidate.end,
      }
    }
    if (seqIssue) {
      return {
        status: 'corrupt',
        reason: `seq gap in committed region at frame ${seqIssue.frame} (expected ${seqIssue.expected}, got ${seqIssue.got})`,
      }
    }
    return { status: 'ok', events, frames: frames.length }
  } catch (error) {
    return { status: 'corrupt', reason: String(error?.message ?? error) }
  }
}

/**
 * 依据 analyze 的结果产出修好的字节。**不落盘**。
 *
 * 重叠修复会循环删除，直到重分析为 ok——多次崩溃可能留下多个重叠帧，
 * 只删第一个会让文件每次修复都选同一个 closer，永远修不完。
 */
export function repair(b, report) {
  if (report?.status !== 'fixable') throw new Error('repair requires a fixable analysis')

  if (report.repairStart !== undefined && report.repairEnd !== undefined) {
    let out = Buffer.concat([b.subarray(0, report.repairStart), b.subarray(report.repairEnd)])
    for (let removed = 1; ; removed++) {
      const check = analyze(out)
      if (check.status === 'ok') return out
      if (check.status !== 'fixable' || check.reason !== 'synthetic-closer overlap'
        || check.repairStart === undefined || check.repairEnd === undefined) {
        throw new Error(`seq-overlap repair re-analysis failed: ${check.reason}`)
      }
      if (removed >= 1024) throw new Error('seq-overlap repair exceeded safe iteration limit (1024)')
      out = Buffer.concat([out.subarray(0, check.repairStart), out.subarray(check.repairEnd)])
    }
  }

  // 单帧布局违规：解码全文，重压成「header 帧 + 其余帧」。
  const text = decodeAll(b)
  const nl = text.indexOf('\n')
  if (nl === -1) throw new Error('no newline in decoded text')
  const headerLine = text.slice(0, nl)
  const rest = text.slice(nl + 1)
  let parsed = null
  try { parsed = JSON.parse(headerLine) } catch { /* 下抛 */ }
  if (!isSessionHeader(parsed)) throw new Error('first line is not a valid session header')

  const frames = [zstdCompressSync(Buffer.from(headerLine + '\n', 'utf8'), ZSTD_CHECKSUM)]
  if (rest.length > 0) frames.push(zstdCompressSync(Buffer.from(rest, 'utf8'), ZSTD_CHECKSUM))
  const out = Buffer.concat(frames)

  // 三重校验：文本一致、每行仍是合法 JSON、重分析为 ok。
  const check = decodeAll(out)
  if (check !== text) throw new Error('round-trip text mismatch')
  for (const l of check.split('\n')) {
    if (l.trim() && recordSeqRange(l) === null) throw new Error('bad JSON line after recode')
  }
  const re = analyze(out)
  if (re.status !== 'ok') throw new Error(`recode re-analysis failed: ${re.reason}`)
  return out
}

/**
 * 规范日志文件名识别：`session.jsonl.zstd` 为第 0 代，
 * `session.vN.jsonl.zstd`（N>=2）为第 N 代。同目录多代并存取最高代。
 */
export function parseLogName(name) {
  const lower = name.toLowerCase()
  if (lower === 'session.jsonl.zstd') return { generation: 0 }
  const m = /^session\.v(\d+)\.jsonl\.zstd$/.exec(lower)
  return m ? { generation: Number(m[1]) } : null
}

/** 遍历 `<home>/sessions` 下全部会话日志文件。 */
export function walkSessionFiles(sessionsRoot) {
  const out = []
  if (!existsSync(sessionsRoot)) return out
  let workspaces = []
  try { workspaces = readdirSync(sessionsRoot, { withFileTypes: true }) } catch { return out }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    const wsDir = join(sessionsRoot, ws.name)
    let sessions = []
    try { sessions = readdirSync(wsDir, { withFileTypes: true }) } catch { continue }
    for (const s of sessions) {
      if (!s.isDirectory()) continue
      const sDir = join(wsDir, s.name)
      let files = []
      try { files = readdirSync(sDir, { withFileTypes: true }) } catch { continue }
      // 同目录多代并存时只取最高代——低代是历史遗留，DSH 不读。
      const candidates = files
        .filter((f) => f.isFile() && parseLogName(f.name) !== null)
        .map((f) => ({ name: f.name, ...parseLogName(f.name) }))
        .sort((a, b) => b.generation - a.generation)
      if (candidates.length === 0) continue
      const chosen = candidates[0]
      const path = join(sDir, chosen.name)
      let size = null
      try { size = statSync(path).size } catch { /* 忽略 */ }
      out.push({
        workspace: ws.name,
        session: s.name,
        file: chosen.name,
        generation: chosen.generation,
        path,
        size,
        superseded: candidates.slice(1).map((c) => c.name),
      })
    }
  }
  return out
}

/**
 * 扫描全部会话文件（只读）。
 * @returns {{ ok: boolean, total: number, summary: Record<string, number>, files: Array }}
 */
export function scanAll(sessionsRoot) {
  const files = walkSessionFiles(sessionsRoot)
  const summary = { ok: 0, fixable: 0, corrupt: 0 }
  const results = []
  for (const f of files) {
    let report
    try {
      report = analyze(readFileSync(f.path))
    } catch (error) {
      report = { status: 'corrupt', reason: `read failed: ${String(error?.message ?? error)}` }
    }
    summary[report.status] = (summary[report.status] ?? 0) + 1
    results.push({ ...f, report })
  }
  return { ok: true, total: files.length, summary, files: results }
}

/**
 * 修复一个文件。**默认 dry-run**：只返回将要做什么，不落盘。
 *
 * `backup: true` 时把原文件复制成 `<file>.bak-<stamp>` 再写——
 * 修复是不可逆的字节操作，没有备份就不该写。
 */
export function repairFile(path, options = {}) {
  const dryRun = options.dryRun !== false
  let original
  try {
    original = readFileSync(path)
  } catch (error) {
    return { ok: false, error: `read failed: ${String(error?.message ?? error)}` }
  }
  const report = analyze(original)
  if (report.status === 'ok') return { ok: true, action: 'none', report }
  if (report.status === 'corrupt') {
    return { ok: false, action: 'refuse', report, error: `cannot repair: ${report.reason}` }
  }

  let fixed
  try {
    fixed = repair(original, report)
  } catch (error) {
    return { ok: false, action: 'refuse', report, error: `repair failed: ${String(error?.message ?? error)}` }
  }

  const verified = analyze(fixed)
  if (verified.status !== 'ok') {
    return { ok: false, action: 'refuse', report, error: `repaired bytes do not verify: ${verified.reason}` }
  }

  if (dryRun) {
    return {
      ok: true,
      action: 'would-repair',
      report,
      after: verified,
      bytesBefore: original.length,
      bytesAfter: fixed.length,
    }
  }

  let backupPath = null
  if (options.backup !== false) {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    backupPath = `${path}.bak-${stamp}`
    try {
      copyFileSync(path, backupPath)
    } catch (error) {
      return { ok: false, action: 'refuse', report, error: `backup failed, refusing to write: ${String(error?.message ?? error)}` }
    }
  }
  try {
    writeFileSync(path, fixed)
  } catch (error) {
    return { ok: false, action: 'refuse', report, backupPath, error: `write failed: ${String(error?.message ?? error)}` }
  }
  return {
    ok: true,
    action: 'repaired',
    report,
    after: verified,
    bytesBefore: original.length,
    bytesAfter: fixed.length,
    backupPath,
  }
}
