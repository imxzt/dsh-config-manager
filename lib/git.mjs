/**
 * git.mjs — 配置版本管理（A 项）。
 *
 * 这是 `dshcfg.ps1` 的 Node 化版本，同时补齐它缺的能力：任意两点 diff、
 * 里程碑 tag、单文件历史、还原点统计、保留策略清理。
 *
 * 设计约束：
 * - 只用 `spawnSync` 调 git，不引入任何 npm 依赖（外部 UI 要在 DSH 崩溃时
 *   可用，多一个依赖就多一个坏点）。
 * - 所有写操作都返回结构化结果，绝不静默失败——调用方要能判断成败。
 * - 不做 `git reset --hard` 之外的历史改写；还原默认只动工作区。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 仓库身份，用于 commit 时署名（避免依赖全局 git config）。 */
const AUTHOR_NAME = 'dsh-config-manager'
const AUTHOR_EMAIL = 'dsh-config-manager@localhost'

/**
 * 跑一条 git 命令。
 * @returns {{ ok: boolean, code: number|null, stdout: string, stderr: string, argv: string[] }}
 */
export function git(repoRoot, args, options = {}) {
  const argv = ['-C', repoRoot, ...args]
  const r = spawnSync('git', argv, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  })
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ''),
    argv,
  }
}

/** git 是否可用（外部 UI 启动时先探这个）。 */
export function gitAvailable() {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true })
  return { ok: r.status === 0, version: (r.stdout ?? '').trim() }
}

/** 该目录是否已经是 git 仓库。 */
export function isRepo(repoRoot) {
  return git(repoRoot, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true'
}

/** 仓库是否存在提交（空仓库没有 HEAD）。 */
export function hasCommits(repoRoot) {
  return git(repoRoot, ['rev-parse', '--verify', 'HEAD']).ok
}

/**
 * 保证仓库按「逐字节还原」的语义工作。
 *
 * Windows 上 git 默认 `core.autocrlf=true`，会把 LF 转成 CRLF——于是
 * `restore` 出来的文件与提交时**不是逐字节一致**，配置文件回退就失真了。
 * 两处一起兜底：
 *   1. 仓库本地设 `core.autocrlf=false`（覆盖全局设置）；
 *   2. 若没有 `.gitattributes`，写一份 `* -text`（关闭一切 EOL 与编码转换）。
 *
 * 幂等：可以每次写操作前调用。
 */
export function ensureRepoHygiene(repoRoot) {
  const changes = []
  const cur = git(repoRoot, ['config', '--local', '--get', 'core.autocrlf'])
  if (cur.stdout.trim().toLowerCase() !== 'false') {
    const r = git(repoRoot, ['config', '--local', 'core.autocrlf', 'false'])
    if (r.ok) changes.push('core.autocrlf=false')
  }
  const attrPath = join(repoRoot, '.gitattributes')
  if (!existsSync(attrPath)) {
    try {
      writeFileSync(attrPath, '# 关闭一切 EOL/编码转换，保证 restore 与提交时逐字节一致。\n* -text\n', 'utf8')
      changes.push('.gitattributes')
    } catch { /* 只读仓库等场景忽略 */ }
  }
  return { ok: true, changes }
}

// ── 读操作 ────────────────────────────────────────────────────────────────

/**
 * 工作区状态。解析 `git status --porcelain=v1 -z` 的稳定输出。
 * @returns {{ ok: boolean, clean: boolean, entries: Array<{status: string, path: string, staged: boolean}> }}
 */
export function status(repoRoot) {
  const r = git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!r.ok) return { ok: false, clean: null, entries: [], error: r.stderr.trim() }
  const parts = r.stdout.split('\0').filter((s) => s !== '')
  const entries = []
  for (let i = 0; i < parts.length; i++) {
    const item = parts[i]
    if (item.length < 4) continue
    const code = item.slice(0, 2)
    const path = item.slice(3)
    // 重命名/复制在 -z 下会多带一个原路径字段，跳过它。
    if (code[0] === 'R' || code[0] === 'C') i += 1
    entries.push({
      status: code.trim() === '' ? '?' : code.trim(),
      index: code[0],
      worktree: code[1],
      staged: code[0] !== ' ' && code[0] !== '?',
      path,
    })
  }
  return { ok: true, clean: entries.length === 0, entries }
}

/** 当前分支名（detached 时返回短 SHA）。 */
export function currentBranch(repoRoot) {
  const r = git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return r.ok ? r.stdout.trim() : null
}

/**
 * 提交历史。
 * @param {number} limit 最多返回多少条
 */
export function log(repoRoot, limit = 30) {
  const fmt = '%H%x1f%h%x1f%cI%x1f%s%x1f%an'
  const r = git(repoRoot, ['log', `--max-count=${limit}`, `--format=${fmt}`])
  if (!r.ok) return { ok: false, commits: [], error: r.stderr.trim() }
  const commits = r.stdout.split('\n').filter((l) => l !== '').map((line) => {
    const [hash, short, date, subject, author] = line.split('\x1f')
    return { hash, short, date, subject, author }
  })
  return { ok: true, commits }
}

/** 某个提交改动了哪些文件（含状态字母）。 */
export function commitFiles(repoRoot, hash) {
  const r = git(repoRoot, ['show', '--name-status', '--format=', hash])
  if (!r.ok) return { ok: false, files: [], error: r.stderr.trim() }
  const files = r.stdout.split('\n').filter((l) => l.trim() !== '').map((line) => {
    const [status, ...rest] = line.split('\t')
    return { status: status.trim(), path: rest.join('\t') }
  })
  return { ok: true, files }
}

/** 工作区相对某提交的 diff 文本（不传 hash 则对 HEAD）。 */
export function diff(repoRoot, options = {}) {
  const args = ['diff', '--no-color']
  if (options.staged) args.push('--cached')
  if (options.from && options.to) args.push(options.from, options.to)
  else if (options.from) args.push(options.from)
  if (options.path) args.push('--', options.path)
  const r = git(repoRoot, args)
  return { ok: r.ok, text: r.stdout, error: r.stderr.trim() }
}

/** 受版本控制的文件清单。 */
export function trackedFiles(repoRoot) {
  const r = git(repoRoot, ['ls-files'])
  if (!r.ok) return { ok: false, files: [], error: r.stderr.trim() }
  return { ok: true, files: r.stdout.split('\n').filter((l) => l !== '') }
}

/** 某文件的历史（该文件被改动的提交）。 */
export function fileLog(repoRoot, path, limit = 20) {
  const r = git(repoRoot, ['log', `--max-count=${limit}`, '--format=%h%x1f%cI%x1f%s', '--', path])
  if (!r.ok) return { ok: false, commits: [], error: r.stderr.trim() }
  const commits = r.stdout.split('\n').filter((l) => l !== '').map((line) => {
    const [short, date, subject] = line.split('\x1f')
    return { short, date, subject }
  })
  return { ok: true, commits }
}

/** 全部 tag 及其指向的提交。 */
export function tags(repoRoot) {
  // 注意：`git tag --format` 不展开 `%x1f`（与 `git log` 不同），
  // 因此这里用制表符作分隔符——tag 名与 ISO 日期都不可能含制表符。
  const r = git(repoRoot, ['tag', '--format=%(refname:short)\t%(objectname:short)\t%(creatordate:iso-strict)'])
  if (!r.ok) return { ok: false, tags: [], error: r.stderr.trim() }
  const list = r.stdout.split('\n').filter((l) => l !== '').map((line) => {
    const [name, hash, date] = line.split('\t')
    return { name, hash, date }
  })
  return { ok: true, tags: list }
}

// ── 写操作 ────────────────────────────────────────────────────────────────

/**
 * 建还原点：暂存全部改动并提交。
 * @returns {{ ok: boolean, committed: boolean, hash?: string, files?: string[], reason?: string }}
 */
export function save(repoRoot, message, options = {}) {
  // 提交前先保证 EOL 语义正确，否则这一提交的内容在还原时会被改写。
  ensureRepoHygiene(repoRoot)
  const add = git(repoRoot, ['add', '-A'])
  if (!add.ok) return { ok: false, reason: `git add failed: ${add.stderr.trim()}` }

  const staged = git(repoRoot, ['diff', '--cached', '--name-only'])
  const files = staged.stdout.split('\n').filter((l) => l !== '')
  if (files.length === 0) return { ok: true, committed: false, files: [], reason: 'nothing to save' }

  const subject = (message ?? '').trim() === '' ? defaultMessage() : message.trim()
  const commit = git(repoRoot, [
    '-c', `user.name=${AUTHOR_NAME}`, '-c', `user.email=${AUTHOR_EMAIL}`,
    'commit', '-q', '-m', subject,
  ])
  if (!commit.ok) return { ok: false, reason: `git commit failed: ${commit.stderr.trim()}`, files }

  const hash = git(repoRoot, ['rev-parse', 'HEAD']).stdout.trim()
  return { ok: true, committed: true, hash, short: hash.slice(0, 7), files, subject }
}

function defaultMessage() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `config: ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 还原工作区到某个提交。默认只动工作区（`git restore`），
 * 不动 HEAD，因此还原本身不会丢历史。
 *
 * **逐文件还原并容忍单文件失败**：`git restore --source=<ref> -- <path>`
 * 在「该文件不存在于目标提交」时会整条命令失败，而 profile 里
 * cordis.yml / pnpm-workspace.yaml 这类文件可能只在部分提交中存在。
 * 若把它们放在一条命令里，一个缺失文件会让整个还原失败——这正是
 * 首次自测暴露的问题。
 *
 * `paths` 为空则还原全部受控文件。
 * @returns {{ ok: boolean, restored: string[], failed: Array<{path: string, error: string}>, ref: string, error?: string }}
 */
export function restore(repoRoot, ref, paths = []) {
  if (ref === undefined || ref === null || ref === '') {
    return { ok: false, restored: [], failed: [], ref: '', error: 'restore requires a commit ref' }
  }
  const verify = git(repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`])
  if (!verify.ok) return { ok: false, restored: [], failed: [], ref, error: `unknown ref: ${ref}` }

  const restoreOne = (rel) => {
    const r = git(repoRoot, ['restore', `--source=${ref}`, '--staged', '--worktree', '--', rel])
    if (r.ok) return { path: rel, ok: true }
    // 文件在目标提交中不存在：这是可接受的（该文件当时还没被创建），
    // 但要与「真失败」区分开——只有前者才容忍。
    const inRef = git(repoRoot, ['cat-file', '-e', `${ref}:${rel}`])
    return { path: rel, ok: false, absentInRef: !inRef.ok, error: r.stderr.trim() }
  }

  const targets = paths.length > 0 ? paths : trackedFiles(repoRoot).files
  const restored = []
  const failed = []
  for (const rel of targets) {
    const one = restoreOne(rel)
    if (one.ok) restored.push(one.path)
    else if (one.absentInRef) failed.push({ path: one.path, error: 'not present in target commit (skipped)' })
    else failed.push({ path: one.path, error: one.error ?? 'unknown error' })
  }

  const hardFailures = failed.filter((f) => !/not present in target commit/.test(f.error))
  return {
    ok: hardFailures.length === 0,
    restored,
    failed,
    ref,
    error: hardFailures.length > 0 ? `${hardFailures.length} file(s) failed to restore: ${hardFailures.map((f) => f.path).join(', ')}` : undefined,
  }
}

/**
 * 丢弃全部未提交改动（危险，调用方必须先确认）。
 */
export function discardAll(repoRoot) {
  const r1 = git(repoRoot, ['restore', '--staged', '--worktree', '--', '.'])
  if (!r1.ok) return { ok: false, error: r1.stderr.trim() }
  // 未跟踪文件不属于任何提交，`restore` 不会删它们；这里显式清理，
  // 否则「丢弃全部改动」会留下一堆 ? 状态的文件。
  const r2 = git(repoRoot, ['clean', '-fd'])
  if (!r2.ok) return { ok: false, error: r2.stderr.trim() }
  return { ok: true, cleaned: r2.stdout.split('\n').filter((l) => l !== '') }
}

/**
 * 打里程碑 tag。
 */
export function tag(repoRoot, name, message, ref = 'HEAD') {
  if (!/^[A-Za-z0-9._\-/]+$/.test(name ?? '')) return { ok: false, error: 'invalid tag name' }
  const exists = git(repoRoot, ['rev-parse', '--verify', `refs/tags/${name}`])
  if (exists.ok) return { ok: false, error: `tag already exists: ${name}` }
  const args = ['-c', `user.name=${AUTHOR_NAME}`, '-c', `user.email=${AUTHOR_EMAIL}`, 'tag']
  if (message && message.trim() !== '') args.push('-a', name, '-m', message.trim(), ref)
  else args.push(name, ref)
  const r = git(repoRoot, args)
  return r.ok ? { ok: true, name, ref } : { ok: false, error: r.stderr.trim() }
}

/** 删除 tag（撤销里程碑）。 */
export function deleteTag(repoRoot, name) {
  const r = git(repoRoot, ['tag', '-d', name])
  return r.ok ? { ok: true, name } : { ok: false, error: r.stderr.trim() }
}

/**
 * 保留策略清理：保留最近 `keep` 个「自动还原点」，其余删除。
 *
 * 只清理带 `auto:` 前缀的提交，人工还原点与里程碑永不自动删除。
 * 实现用 `git rebase --onto` 删除中间提交代价高且有风险，因此这里只
 * 报告可清理项，真正的删除交给 `prune` 显式执行。
 */
export function listAutoCommits(repoRoot, limit = 200) {
  const r = git(repoRoot, ['log', `--max-count=${limit}`, '--format=%H%x1f%cI%x1f%s'])
  if (!r.ok) return { ok: false, commits: [], error: r.stderr.trim() }
  const all = r.stdout.split('\n').filter((l) => l !== '').map((line) => {
    const [hash, date, subject] = line.split('\x1f')
    return { hash, date, subject, auto: subject.startsWith('auto:') }
  })
  return { ok: true, commits: all }
}

/**
 * 仓库体积与对象数（外部 UI 显示用）。
 */
export function repoStats(repoRoot) {
  const count = git(repoRoot, ['count-objects', '-vH'])
  const commits = git(repoRoot, ['rev-list', '--count', 'HEAD'])
  return {
    ok: count.ok,
    detail: count.stdout.trim(),
    commits: commits.ok ? Number(commits.stdout.trim()) : null,
  }
}
