/**
 * dsh-config-manager — Client half.
 *
 * 在侧栏注册一个面板入口（`sidebar.panellist` + `main` 键控槽），面板内显示
 * 配置健康与启动预检的摘要，并提供「打开完整 UI」按钮。
 *
 * **为什么面板只是摘要而不是完整 UI**：方案 1 的取舍——完整 UI 是外部
 * 独立服务器（DSH 崩溃时页面内插件根本加载不了），页面内只做入口与速览，
 * 避免把同一套 UI 写两遍并最终漂移。
 *
 * 手写 `factory(require)` 形式，零构建步骤（与 dsh-session-delete 同款）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-config-manager',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const NS = 'dsh-config-manager'
    const PANEL_ID = 'dsh-config-manager'
    const API = '/dsh-config-manager/api'

    /** 页面语言跟随浏览器。 */
    const zh = () => String(navigator.language ?? '').toLowerCase().startsWith('zh')
    const T = (cn, en) => (zh() ? cn : en)

    /** 一次 GET，返回统一信封。 */
    async function get(path) {
      const res = await fetch(`${API}${path}`, { headers: { accept: 'application/json' } })
      const text = await res.text()
      if (text.trim() === '') return { ok: false, error: { code: `http-${res.status}`, message: `HTTP ${res.status}` } }
      try { return JSON.parse(text) } catch { return { ok: false, error: { code: `http-${res.status}`, message: `HTTP ${res.status}` } } }
    }

    /** 向宿主报告接线阶段，便于区分「bundle 没跑」与「槽位不在」。 */
    function reportReady(stage, detail) {
      try {
        void fetch(`${API}/ready`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(detail === undefined ? { stage } : { stage, detail }),
        }).catch(() => {})
      } catch { /* 仅诊断 */ }
    }

    /** 面板主体：健康 + 预检摘要。 */
    function ConfigPanel() {
      const [state, setState] = React.useState({ loading: true, error: null, data: null })
      const [tick, setTick] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        setState((s) => ({ ...s, loading: true }))
        void (async () => {
          const r = await get('/status')
          if (!alive) return
          if (r.ok !== true) setState({ loading: false, error: r.error?.message ?? 'unknown', data: null })
          else setState({ loading: false, error: null, data: r.value })
        })()
        return () => { alive = false }
      }, [tick])

      const s = { padding: '24px', maxWidth: '720px', display: 'flex', flexDirection: 'column', gap: '16px' }
      const card = (bg, border) => ({
        border: `1px solid ${border}`, background: bg, borderRadius: '10px', padding: '16px 18px',
      })
      const muted = { color: 'var(--dsh-text-secondary, #6b7280)', fontSize: '13px' }
      const btn = {
        alignSelf: 'flex-start', padding: '7px 14px', borderRadius: '7px', cursor: 'pointer',
        border: '1px solid var(--dsh-border, #d0d7de)', background: 'transparent', font: 'inherit',
      }

      if (state.loading) {
        return React.createElement('div', { style: s }, React.createElement('div', { style: muted }, T('读取中…', 'Loading…')))
      }
      if (state.error) {
        return React.createElement('div', { style: s },
          React.createElement('div', { style: card('rgba(207,34,46,.06)', 'rgba(207,34,46,.35)') },
            React.createElement('div', { style: { fontWeight: 600, marginBottom: '6px' } }, T('无法读取状态', 'Cannot read status')),
            React.createElement('div', { style: muted }, state.error),
            React.createElement('div', { style: { ...muted, marginTop: '8px' } },
              T('宿主半区可能未挂载，或该路由被拒绝。', 'The host half may not be mounted, or the route was refused.')),
          ),
        )
      }

      const d = state.data
      const pf = d.preflight
      const health = d.health
      const crash = d.crash

      const banner = crash.crashed
        ? card('rgba(207,34,46,.06)', 'rgba(207,34,46,.35)')
        : pf.safeToRestart
          ? card('rgba(26,127,55,.06)', 'rgba(26,127,55,.30)')
          : card('rgba(154,103,0,.06)', 'rgba(154,103,0,.35)')

      const title = crash.crashed
        ? T('检测到启动失败', 'Startup failure detected')
        : pf.safeToRestart ? T('一切正常', 'All good') : T('重启有风险', 'Restart is risky')

      return React.createElement('div', { style: s },
        React.createElement('div', { style: banner },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: '6px' } }, title),
          React.createElement('div', { style: muted }, pf.summary),
          pf.blockers?.length
            ? React.createElement('ul', { style: { ...muted, margin: '10px 0 0', paddingLeft: '18px' } },
                pf.blockers.slice(0, 5).map((b, i) => React.createElement('li', { key: i }, b.message)))
            : null,
        ),

        React.createElement('div', { style: card('transparent', 'var(--dsh-border, #d0d7de)') },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: '8px' } }, T('配置健康', 'Config health')),
          React.createElement('div', { style: muted },
            `${d.ctx.profile} · ${health.errors} ${T('错误', 'errors')} · ${health.warnings} ${T('警告', 'warnings')}`),
          React.createElement('div', { style: { ...muted, marginTop: '4px' } },
            T('仓库', 'Repo') + ': ' + d.ctx.home),
        ),

        React.createElement('div', { style: { display: 'flex', gap: '8px' } },
          React.createElement('button', { style: btn, onClick: () => setTick((n) => n + 1) }, T('重新检查', 'Re-check')),
          React.createElement('button', {
            style: btn,
            onClick: () => {
              // 打开外部 UI —— 破坏性操作（回滚/摘除）在那边，因为 DSH 崩溃时
              // 只有外部 UI 可用，把能力集中在一处避免两套逻辑漂移。
              window.open('http://127.0.0.1:14711/', '_blank', 'noopener')
            },
          }, T('打开完整 UI', 'Open full UI')),
        ),

        React.createElement('div', { style: muted },
          T('完整 UI 需要先运行 dcm.bat serve（端口 14711）。崩溃恢复、回滚、会话修复都在那边。',
            'The full UI needs dcm.bat serve running (port 14711). Recovery, rollback and session repair live there.')),
      )
    }

    /** 侧栏图标。 */
    function ConfigIcon() {
      return React.createElement('span', { style: { fontSize: '15px', lineHeight: 1 } }, '⚙')
    }

    function apply(ctx) {
      reportReady('apply', `slots=${typeof ctx.slots === 'object'}`)

      // 侧栏入口：与 main 的 key 必须一致，否则点击会因找不到面板而抛错。
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 60,
        label: () => T('配置管理', 'Config'),
      }, ConfigIcon))

      // 主区域面板。
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
      }, ConfigPanel))

      reportReady('registered', 'sidebar.panellist + main')
    }

    exports.name = NS
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})