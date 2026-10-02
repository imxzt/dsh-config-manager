/* dsh-config-manager — 外部 UI 前端（原生 JS，无构建步骤）
 *
 * 之所以零依赖：这个页面要在 DSH 崩溃时可用，任何构建产物或 CDN 依赖
 * 都是一个坏点。token 从 URL 取一次后存 sessionStorage，之后从地址栏抹掉。
 */

const params = new URLSearchParams(location.search)
let TOKEN = params.get('token') || sessionStorage.getItem('dcm-token') || ''
if (params.get('token')) {
  sessionStorage.setItem('dcm-token', TOKEN)
  // 抹掉地址栏里的 token，避免被截图/日志/历史记录带走。
  history.replaceState(null, '', location.pathname)
}

const $ = (id) => document.getElementById(id)

/* ── 基础设施 ── */

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'x-dcm-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = json?.error?.message ?? `HTTP ${res.status}`
    throw new Error(msg)
  }
  return json
}

let toastTimer = null
function toast(msg, kind = '') {
  const el = $('toast')
  el.textContent = msg
  el.className = 'toast' + (kind ? ' ' + kind : '')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200)
}

function openModal(html) {
  $('modalBody').innerHTML = html
  $('modal').classList.remove('hidden')
}
$('modalClose').onclick = () => $('modal').classList.add('hidden')
$('modal').onclick = (e) => { if (e.target === $('modal')) $('modal').classList.add('hidden') }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const bytes = (n) => (n === null || n === undefined ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`)

/* ── 视图切换 ── */

const loaders = {}
$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab')
  if (!tab) return
  const view = tab.dataset.view
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab)
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('hidden', v.dataset.view !== view)
  loaders[view]?.()
})

/* ── 总览 ── */

async function loadOverview() {
  const data = await api('GET', '/api/overview')
  const { ctx, git, health, crash } = data.value

  $('meta').innerHTML = `profile <code>${esc(ctx.profile)}</code> · <code>${esc(ctx.home)}</code>`

  const dot = $('healthDot')
  dot.className = 'dot ' + (health.ok ? 'ok' : 'err')
  dot.title = health.ok ? '配置健康' : `${health.errors} 项错误`

  // 崩溃横幅优先显示——这是用户最需要立刻看到的东西
  const banner = $('crashBanner')
  if (crash.crashed) {
    const rec = crash.recommendation
    banner.innerHTML = `
      <div class="banner err">
        <h3>检测到 DSH 启动失败（置信度 ${esc(crash.confidence)}）</h3>
        <p>${crash.signals.filter((s) => s.severity === 'err').map((s) => esc(s.message)).join('<br>')}</p>
        <div class="actions">
          ${rec.action === 'restore' ? `<button class="primary" id="recoverBtn">回滚到 ${esc(String(rec.ref).slice(0, 7))}</button>` : ''}
          <button class="ghost" id="forensicBtn">查看崩溃现场</button>
        </div>
        <p style="margin-top:12px">${esc(rec.reason)}</p>
      </div>`
    const rb = $('recoverBtn')
    if (rb) rb.onclick = () => doRecover(rec.ref)
    $('forensicBtn').onclick = () => showForensic(rec.ref)
  } else if (!health.ok) {
    banner.innerHTML = `
      <div class="banner warn">
        <h3>配置存在 ${health.errors} 项错误</h3>
        <p>这些错误可能导致下次启动失败。请先到「健康诊断」查看。</p>
      </div>`
  } else {
    banner.innerHTML = `
      <div class="banner ok">
        <h3>一切正常</h3>
        <p>未检测到崩溃痕迹，配置健康检查通过。</p>
      </div>`
  }

  const lastCommit = git.commits[0]
  const changed = git.changed?.length ?? 0
  $('overviewCards').innerHTML = `
    <div class="card ${health.ok ? 'ok' : 'err'}">
      <h3>健康诊断</h3>
      <div class="big">${health.ok ? '通过' : health.errors + ' 错误'}</div>
      <div class="sub">${health.warnings} 项警告 · ${esc(ctx.profile)}</div>
    </div>
    <div class="card ${changed === 0 ? '' : 'warn'}">
      <h3>未保存改动</h3>
      <div class="big">${changed}</div>
      <div class="sub">${changed === 0 ? '与最近还原点一致' : '有改动尚未建立还原点'}</div>
    </div>
    <div class="card">
      <h3>最近还原点</h3>
      <div class="big" style="font-size:15px;font-weight:500">${lastCommit ? esc(lastCommit.short) : '—'}</div>
      <div class="sub">${lastCommit ? esc(lastCommit.subject) : '还没有任何还原点'}</div>
    </div>
    <div class="card">
      <h3>还原点总数</h3>
      <div class="big">${git.commits?.length ?? 0}</div>
      <div class="sub">${git.tags?.length ?? 0} 个里程碑</div>
    </div>`
}

async function doRecover(ref) {
  const ok = confirm(
    `回滚 profile 配置到 ${String(ref).slice(0, 7)}？\n\n` +
    '· 当前状态会先自动存成「取证提交」，不会丢失\n' +
    '· 只还原 profile 配置文件，不动会话记录\n' +
    '· 回滚后需要重启 DSH 才生效',
  )
  if (!ok) return
  try {
    const r = await api('POST', '/api/crash/recover', { confirm: true, ref })
    const v = r.value
    if (!v.ok) { toast('回滚失败: ' + v.error, 'err'); return }
    toast(`已回滚，健康错误 ${v.healthBefore.errors} → ${v.healthAfter.errors}`)
    await loadOverview()
  } catch (e) { toast('回滚失败: ' + e.message, 'err') }
}

async function showForensic(ref) {
  try {
    const r = await api('GET', `/api/crash/forensic?ref=${encodeURIComponent(ref)}`)
    const v = r.value
    const patch = v.patch?.diff ?? ''
    openModal(`
      <h2 style="margin-top:0;font-size:16px">崩溃现场对比</h2>
      <p class="muted">以还原点 ${esc(String(ref).slice(0, 7))} 为基准，左边是还原点内容（<span style="color:var(--err)">-</span>），右边是崩溃后的内容（<span style="color:var(--ok)">+</span>）。</p>
      <pre class="diff">${colorDiff(patch) || '(无差异)'}</pre>`)
  } catch (e) { toast('读取失败: ' + e.message, 'err') }
}

function colorDiff(text) {
  return esc(text).split('\n').map((line) => {
    if (line.startsWith('+')) return `<span class="add">${line}</span>`
    if (line.startsWith('-')) return `<span class="del">${line}</span>`
    if (line.startsWith('@@')) return `<span class="hunk">${line}</span>`
    return line
  }).join('\n')
}

/* ── 健康诊断 ── */

async function loadHealth() {
  const r = await api('GET', '/api/health')
  const rep = r.value
  const glyph = { err: '✕', warn: '!', info: '·' }
  const parts = []
  for (const c of rep.checks) {
    const bad = c.items.filter((i) => i.severity !== 'info')
    if (bad.length === 0) {
      parts.push(`<div class="item ok"><div class="glyph" style="color:var(--ok)">✓</div><div class="body"><div class="title">${esc(c.title)}</div><div class="desc">${esc(c.items[0]?.message ?? '')}</div></div></div>`)
      continue
    }
    for (const i of bad) {
      const color = i.severity === 'err' ? 'var(--err)' : 'var(--warn)'
      parts.push(`<div class="item ${i.severity}">
        <div class="glyph" style="color:${color}">${glyph[i.severity]}</div>
        <div class="body">
          <div class="title">${esc(c.title)}${i.bundle ? ' · ' + esc(i.bundle) : ''}${i.dep ? ' · ' + esc(i.dep) : ''}</div>
          <div class="desc">${esc(i.message)}</div>
          ${i.remedy ? `<div class="remedy">建议：${esc(i.remedy)}</div>` : ''}
        </div></div>`)
    }
  }
  $('healthBody').innerHTML = parts.join('')
}
$('healthRefresh').onclick = () => loadHealth().catch((e) => toast(e.message, 'err'))

/* ── 插件护栏 ── */

async function loadPlugins() {
  const [r, pf] = await Promise.all([
    api('GET', '/api/plugins'),
    api('GET', '/api/preflight'),
  ])
  const v = r.value
  const p = pf.value

  // 启动预检门放在最上面——这是「现在能不能重启」的单一判据
  $('preflightBox').innerHTML = p.safeToRestart
    ? `<div class="banner ok" style="margin-bottom:20px"><h3>可以安全重启</h3><p>${esc(p.summary)}</p></div>`
    : `<div class="banner err" style="margin-bottom:20px">
        <h3>不要重启 DSH</h3>
        <p>${esc(p.summary)}</p>
        <div class="stack" style="margin-top:12px">
          ${p.blockers.map((b) => `<div class="item err"><div class="glyph" style="color:var(--err)">✕</div><div class="body"><div class="desc">${esc(b.message)}</div>${b.remedy ? `<div class="remedy">建议：${esc(b.remedy)}</div>` : ''}</div></div>`).join('')}
        </div>
      </div>`

  const rows = v.plugins.map((pl) => {
    const sev = pl.risk?.severity
    const cls = sev === 'err' ? 'err' : sev === 'warn' ? 'warn' : 'info'
    const glyph = sev === 'err' ? '✕' : sev === 'warn' ? '!' : (pl.selected ? '●' : '○')
    const color = sev === 'err' ? 'var(--err)' : sev === 'warn' ? 'var(--warn)' : 'var(--ink-3)'
    const flags = [
      pl.selected ? 'bundle' : null,
      pl.declared ? 'dep' : null,
      pl.hostProvided ? '安装包提供' : (pl.onDisk ? '磁盘' : '缺失'),
      pl.link ? (pl.link.kind === 'directory' ? '实体副本(联接已丢)' : '联接') : null,
    ].filter(Boolean).join(' · ')
    return `<div class="item ${cls}">
      <div class="glyph" style="color:${color}">${glyph}</div>
      <div class="body">
        <div class="title">${esc(pl.name)}</div>
        <div class="desc">${esc(flags)}</div>
        ${pl.risk ? `<div class="remedy">${esc(pl.risk.reason)}</div>` : ''}
        ${pl.link && pl.link.kind === 'directory' ? `<div class="remedy">pnpm install 把目录联接换成了实体副本，改源码不再即时生效。</div>` : ''}
      </div>
    </div>`
  }).join('')

  $('pluginList').innerHTML = `<div class="muted" style="margin-bottom:12px">共 ${v.counts.total} 项，选中 ${v.counts.selected} 项，风险 ${v.counts.risky} 项</div>` + rows
}

$('pluginsRefresh').onclick = () => loadPlugins().catch((e) => toast(e.message, 'err'))
$('neutralizeBtn').onclick = async () => {
  try {
    const dry = await api('POST', '/api/plugins/neutralize', { dryRun: true })
    const d = dry.value
    if (d.action === 'none') { toast('没有不可解析的 bundle'); return }
    const ok = confirm(
      `将把以下 bundle 从 dsh.profile.bundles 中摘除：\n\n${d.removed.map((n) => '· ' + n).join('\n')}\n\n` +
      '理由：它们在磁盘上不存在，保留会让下次启动时 DSH 重置整个 profile。\n' +
      '依赖声明会保留不动。执行前会自动建还原点。',
    )
    if (!ok) return
    const real = await api('POST', '/api/plugins/neutralize', { dryRun: false, confirm: true })
    const res = real.value
    if (!res.ok) { toast('摘除失败: ' + (res.error ?? res.message), 'err'); return }
    toast(res.message)
    await loadPlugins()
    await loadOverview()
  } catch (e) { toast(e.message, 'err') }
}

/* ── 版本与还原点 ── */

async function loadVersions() {
  const [st, lg, tg] = await Promise.all([
    api('GET', '/api/git/status'),
    api('GET', '/api/git/log?limit=40'),
    api('GET', '/api/git/tags'),
  ])
  const status = st.value, commits = lg.value.commits, tags = tg.value.tags
  const tagByHash = new Map(tags.map((t) => [t.hash, t.name]))

  const changed = status.entries ?? []
  $('changesBox').innerHTML = changed.length === 0
    ? `<div class="banner ok" style="margin-bottom:20px"><h3>没有未保存的改动</h3><p>配置与最近还原点一致。</p></div>`
    : `<div class="banner warn" style="margin-bottom:20px">
        <h3>${changed.length} 处未保存的改动</h3>
        <p>${changed.slice(0, 6).map((e) => esc(e.path)).join('<br>')}${changed.length > 6 ? `<br>…还有 ${changed.length - 6} 个` : ''}</p>
        <div class="actions">
          <button class="ghost" id="discardBtn">丢弃这些改动</button>
        </div>
      </div>`
  const db = $('discardBtn')
  if (db) db.onclick = async () => {
    if (!confirm('丢弃全部未保存改动？此操作不可撤销（但已保存的还原点不受影响）。')) return
    try { await api('POST', '/api/git/discard', { confirm: true }); toast('已丢弃'); await loadVersions() }
    catch (e) { toast(e.message, 'err') }
  }

  $('commitList').innerHTML = commits.map((c, idx) => {
    const tag = tagByHash.get(c.hash) || tagByHash.get(c.short)
    return `<div class="item clickable" data-hash="${esc(c.hash)}" data-idx="${idx}">
      <div class="glyph">${idx === 0 ? '◉' : '○'}</div>
      <div class="body">
        <div class="title">${esc(c.subject)}${tag ? `<span class="tag">${esc(tag)}</span>` : ''}</div>
        <div class="desc"><code>${esc(c.short)}</code></div>
      </div>
      <div class="when">${esc((c.date || '').replace('T', ' ').slice(0, 19))}</div>
    </div>`
  }).join('')

  for (const el of document.querySelectorAll('#commitList .item')) {
    el.onclick = () => showCommit(el.dataset.hash)
  }
}

async function showCommit(hash) {
  try {
    const [files, diff] = await Promise.all([
      api('GET', `/api/git/commitFiles?hash=${hash}`),
      api('GET', `/api/git/diff?from=${hash}~1&to=${hash}`),
    ])
    const fl = files.value.files ?? []
    openModal(`
      <h2 style="margin-top:0;font-size:16px">${esc(hash.slice(0, 7))}</h2>
      <p class="muted">${fl.length} 个文件</p>
      <div class="stack">${fl.map((f) => `<div class="item info"><div class="glyph">${esc(f.status)}</div><div class="body"><div class="desc">${esc(f.path)}</div></div></div>`).join('')}</div>
      <div class="actions" style="margin:16px 0">
        <button class="primary" id="restoreCommit">回滚到这个还原点</button>
      </div>
      <pre class="diff">${colorDiff(diff.value.text) || '(无差异)'}</pre>`)
    $('restoreCommit').onclick = async () => {
      if (!confirm(`回滚到 ${hash.slice(0, 7)}？当前状态会先存成取证提交。`)) return
      try {
        const r = await api('POST', '/api/crash/recover', { confirm: true, ref: hash })
        const v = r.value
        if (!v.ok) { toast('回滚失败: ' + v.error, 'err'); return }
        $('modal').classList.add('hidden')
        toast(`已回滚，健康错误 ${v.healthBefore.errors} → ${v.healthAfter.errors}`)
        await loadVersions()
        await loadOverview()
      } catch (e) { toast(e.message, 'err') }
    }
  } catch (e) { toast('读取失败: ' + e.message, 'err') }
}

$('saveBtn').onclick = async () => {
  const msg = $('saveMsg').value.trim()
  try {
    const r = await api('POST', '/api/git/save', { message: msg || undefined })
    const v = r.value
    if (!v.ok) { toast('保存失败: ' + v.reason, 'err'); return }
    if (!v.committed) { toast('没有新改动，无需保存'); return }
    $('saveMsg').value = ''
    toast(`已保存还原点 ${v.short}`)
    await loadVersions()
  } catch (e) { toast(e.message, 'err') }
}

/* ── 会话文件 ── */

async function loadSessions() {
  $('sessionSummary').textContent = '扫描中…'
  const r = await api('GET', '/api/sessions')
  const s = r.value
  $('sessionSummary').innerHTML = `共 ${s.total} 个会话 · 健康 ${s.summary.ok ?? 0} · 可修复 ${s.summary.fixable ?? 0} · 损坏 ${s.summary.corrupt ?? 0}`
  const bad = s.files.filter((f) => f.report.status !== 'ok')
  if (bad.length === 0) {
    $('sessionList').innerHTML = `<div class="item ok"><div class="glyph" style="color:var(--ok)">✓</div><div class="body"><div class="title">全部会话文件健康</div><div class="desc">没有发现需要修复的会话日志。</div></div></div>`
    return
  }
  $('sessionList').innerHTML = bad.map((f) => {
    const sev = f.report.status === 'corrupt' ? 'err' : 'warn'
    return `<div class="item ${sev}">
      <div class="glyph" style="color:var(--${sev === 'err' ? 'err' : 'warn'})">${sev === 'err' ? '✕' : '!'}</div>
      <div class="body">
        <div class="title">${esc(f.session)}</div>
        <div class="desc">${esc(f.report.reason)} · ${bytes(f.size)}</div>
        <div class="desc"><code>${esc(f.path)}</code></div>
      </div>
      <div class="when">${esc(f.report.status)}</div>
    </div>`
  }).join('')
}

$('scanBtn').onclick = () => loadSessions().catch((e) => toast(e.message, 'err'))
$('fixDryBtn').onclick = () => doFix(true)
$('fixBtn').onclick = () => doFix(false)

async function doFix(dryRun) {
  if (!dryRun && !confirm('修复会话文件？\n\n修复前会为每个文件生成 .bak-<时间戳> 备份。')) return
  try {
    const r = await api('POST', '/api/sessions/fix', { dryRun })
    const v = r.value
    if (v.results.length === 0) { toast('没有需要修复的会话'); return }
    const lines = v.results.map((x) => `${x.ok ? '✓' : '✕'} ${x.session}: ${x.action}${x.error ? ' — ' + x.error : ''}`)
    openModal(`<h2 style="margin-top:0;font-size:16px">${dryRun ? '试修结果（未落盘）' : '修复结果'}</h2>
      <pre class="diff">${esc(lines.join('\n'))}</pre>`)
    if (!dryRun) await loadSessions()
  } catch (e) { toast(e.message, 'err') }
}

/* ── 启动 ── */

loaders.overview = () => loadOverview().catch((e) => toast(e.message, 'err'))
loaders.health = () => loadHealth().catch((e) => toast(e.message, 'err'))
loaders.plugins = () => loadPlugins().catch((e) => toast(e.message, 'err'))
loaders.versions = () => loadVersions().catch((e) => toast(e.message, 'err'))
loaders.sessions = () => loadSessions().catch((e) => toast(e.message, 'err'))

$('refreshBtn').onclick = () => {
  const active = document.querySelector('.tab.active')?.dataset.view ?? 'overview'
  loaders[active]?.()
}

if (!TOKEN) {
  document.body.innerHTML = '<main><div class="banner err"><h3>缺少访问令牌</h3><p>请使用启动时打印的完整链接（含 <code>?token=…</code>）打开本页面。</p></div></main>'
} else {
  loaders.overview()
}
