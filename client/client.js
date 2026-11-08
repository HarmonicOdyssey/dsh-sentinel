/**
 * dsh-sentinel — browser half.
 *
 * This module only renders and refreshes. All analysis happens in the Host
 * half; the panel reads the same JSON a CI script can read. If the native
 * sidebar API is unavailable, registration is skipped, the Host is told once,
 * and the tool/JSON surfaces keep working.
 */
window.__ModuleLoader__.load({
  id: 'dsh-sentinel',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PLUGIN_ID = 'dsh-sentinel'
    const TAB_KIND = 'sentinel'
    const REPORT_PATH = '/dsh-sentinel/report.json'
    const DEGRADED_PATH = '/dsh-sentinel/degraded'
    const REFRESH_MS = 5000

    const COLOR_DANGER = 'var(--dsw-alias-status-danger, #d84a3a)'
    const COLOR_WARNING = 'var(--dsw-alias-status-warning, #b7791f)'
    const COLOR_SUCCESS = 'var(--dsw-alias-status-success, #2f855a)'
    const COLOR_PRIMARY = 'var(--dsw-alias-label-primary, inherit)'
    const COLOR_SECONDARY = 'var(--dsw-alias-label-secondary, #6b7280)'
    const COLOR_TERTIARY = 'var(--dsw-alias-label-tertiary, #9ca3af)'
    const COLOR_BORDER = 'var(--dsw-alias-border-l2, rgba(127, 127, 127, .25))'
    const COLOR_HOVER = 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .12))'

    const UNKNOWN_REASON_TEXT = {
      no_literal_event_names: '无法静态确定监听的事件名（变量、拼接或模板）',
      no_event_listeners: '源码中没有监听任何事件',
      source_unreadable: '源码不可读或解析失败',
    }

    const ENGINE_STATUS_TEXT = {
      normal: '正常',
      catalog_unavailable: '词表不可用',
      self_check_failed: '自检失败',
      scan_partial: '部分扫描',
    }

    const DEGRADATION_TEXT = {
      panel_register_failed: '侧边栏不可用',
      tool_register_failed: '工具注册失败',
      catalog_load_failed: '词表加载失败',
      scan_failed: '扫描失败',
      profile_watch_failed: '清单监听不可用',
      self_check_failed: '自检失败',
    }

    /** Build an absolute route on http(s), a relative one on custom carriers. */
    function route(pathname) {
      try {
        const origin = globalThis.location && globalThis.location.origin
        if (typeof origin === 'string' && /^https?:/.test(origin)) return origin + pathname
      } catch (error) {
        /* fall through to a relative path */
      }
      return pathname
    }

    function formatTime(iso) {
      try {
        const date = new Date(iso)
        if (Number.isNaN(date.getTime())) return String(iso)
        return date.toLocaleString()
      } catch (error) {
        return String(iso)
      }
    }

    function versioned(entry) {
      return entry.version ? entry.package + '@' + entry.version : entry.package
    }

    function HealthIcon(size) {
      return h(
        'svg',
        {
          viewBox: '0 0 64 64',
          width: size || 18,
          height: size || 18,
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        h('path', {
          d: 'M32 4 54 13v18c0 14.2-9.3 24.6-22 29C19.3 55.6 10 45.2 10 31V13L32 4Z',
          fill: 'currentColor',
          opacity: 0.18,
        }),
        h('path', {
          d: 'M14 17.5 32 10l18 7.5V31c0 11.4-7.2 19.7-18 23.5C22.2 50.7 15 42.4 15 31V17.5Z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '3',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M20 33h6l3.6-8 5.4 15 3.7-9.2 2.3 2.2H40',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '3',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function Dot(color) {
      return h('span', {
        'aria-hidden': true,
        style: {
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          marginRight: 8,
          flex: 'none',
        },
      })
    }

    function SectionHeader(props) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            fontSize: 13,
            fontWeight: 600,
            color: props.color || COLOR_PRIMARY,
            margin: '18px 0 8px',
          },
        },
        Dot(props.dot),
        h('span', null, props.label),
        h('span', { style: { color: COLOR_SECONDARY, fontWeight: 400 } }, ' (' + props.count + ')'),
      )
    }

    function EmptyLine(props) {
      return h('div', { style: { color: COLOR_TERTIARY, fontSize: 12, padding: '2px 0 0 16px' } }, props.children)
    }

    function DamagedSection(props) {
      const damaged = props.report.damaged || []
      if (damaged.length === 0) {
        return h(
          'div',
          null,
          h(SectionHeader, { label: '确定性损坏', count: 0, dot: COLOR_SUCCESS, color: COLOR_PRIMARY }),
          h(EmptyLine, null, '未发现确定性损坏'),
        )
      }
      return h(
        'div',
        null,
        h(SectionHeader, { label: '确定性损坏', count: damaged.length, dot: COLOR_DANGER }),
        damaged.map(function (entry) {
          return h(
            'div',
            {
              key: entry.package,
              style: {
                border: '1px solid ' + COLOR_BORDER,
                borderLeft: '3px solid ' + COLOR_DANGER,
                borderRadius: 8,
                padding: '10px 12px',
                marginBottom: 8,
                background: 'var(--dsw-alias-bg-layer-1, transparent)',
              },
            },
            h('div', { style: { fontWeight: 600, fontSize: 13, color: COLOR_PRIMARY, wordBreak: 'break-all' } }, versioned(entry)),
            (entry.events || []).map(function (event) {
              return h(
                'div',
                { key: event, style: { color: COLOR_SECONDARY, fontSize: 12, marginTop: 6, lineHeight: 1.6 } },
                '监听 ',
                h('code', { style: { color: COLOR_PRIMARY } }, event),
                '，但当前版本词表中不存在',
              )
            }),
            h(
              'div',
              { style: { color: COLOR_TERTIARY, fontSize: 12, marginTop: 6, lineHeight: 1.6 } },
              '建议：检查该插件是否有新版本，或联系插件作者',
            ),
          )
        }),
      )
    }

    function UnknownSection(props) {
      const unknown = props.report.unknown || []
      return h(
        'div',
        null,
        h(SectionHeader, { label: '未检查', count: unknown.length, dot: COLOR_WARNING }),
        unknown.length === 0
          ? h(EmptyLine, null, '无')
          : unknown.map(function (entry) {
              return h(
                'div',
                { key: entry.package, style: { padding: '4px 0 4px 16px' } },
                h('div', { style: { fontSize: 13, color: COLOR_PRIMARY, wordBreak: 'break-all' } }, versioned(entry)),
                h(
                  'div',
                  { style: { color: COLOR_TERTIARY, fontSize: 12, marginTop: 2 } },
                  '原因：' + (UNKNOWN_REASON_TEXT[entry.reason] || entry.reason),
                ),
              )
            }),
      )
    }

    function HealthySection(props) {
      const count = props.report.healthy_count || 0
      return h(
        'details',
        { style: { marginTop: 18 } },
        h(
          'summary',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              fontSize: 13,
              fontWeight: 600,
              color: COLOR_PRIMARY,
              cursor: 'pointer',
              listStyle: 'none',
            },
          },
          Dot(COLOR_SUCCESS),
          '健康 (' + count + ')',
        ),
        h(
          'div',
          { style: { color: COLOR_TERTIARY, fontSize: 12, padding: '8px 0 0 16px' } },
          count === 0 ? '没有完全健康的包' : '这些包的监听事件在当前词表中都存在',
        ),
      )
    }

    function EngineFooter(props) {
      const report = props.report
      const status = report.engine_status
      const statusColor =
        status === 'normal' ? COLOR_SUCCESS : status === 'scan_partial' ? COLOR_WARNING : COLOR_DANGER
      const sourceLabel =
        status === 'catalog_unavailable'
          ? '不可用'
          : report.catalog_source === 'builtin_snapshot'
            ? '内置快照（' + report.catalog_version_hint + '，可能滞后于当前 DSH 版本）'
            : 'persistence-catalog.md（' + report.catalog_version_hint + '）'
      return h(
        'div',
        {
          style: {
            marginTop: 22,
            paddingTop: 12,
            borderTop: '1px solid ' + COLOR_BORDER,
            color: COLOR_SECONDARY,
            fontSize: 12,
            lineHeight: 1.7,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', color: COLOR_PRIMARY, fontWeight: 600 } },
          Dot(statusColor),
          '体检引擎状态：' + (ENGINE_STATUS_TEXT[status] || status),
        ),
        report.engine_reason
          ? h('div', { style: { marginTop: 4, color: COLOR_SECONDARY } }, '原因：' + report.engine_reason)
          : null,
        h('div', { style: { marginTop: 4 } }, '词表来源：' + sourceLabel),
        h('div', { style: { marginTop: 2 } }, '检查时间：' + formatTime(report.generated_at)),
        (report.degradations || []).length > 0
          ? h(
              'div',
              { style: { marginTop: 4, color: COLOR_WARNING } },
              '降级：' +
                report.degradations
                  .map(function (reason) {
                    return DEGRADATION_TEXT[reason] || reason
                  })
                  .join(' / '),
            )
          : null,
        (report.scan_errors || []).length > 0
          ? h(
              'details',
              { style: { marginTop: 6 } },
              h('summary', { style: { cursor: 'pointer', color: COLOR_TERTIARY } }, '扫描异常（' + report.scan_errors.length + '）'),
              report.scan_errors.slice(0, 20).map(function (error, index) {
                return h(
                  'div',
                  { key: index, style: { color: COLOR_TERTIARY, marginTop: 2, wordBreak: 'break-all' } },
                  error,
                )
              }),
            )
          : null,
      )
    }

    function Header(props) {
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 } },
          h('span', { style: { color: COLOR_PRIMARY, display: 'flex' } }, HealthIcon(18)),
          h(
            'div',
            { style: { minWidth: 0 } },
            h('div', { style: { fontSize: 14, fontWeight: 600, color: COLOR_PRIMARY } }, '插件健康总览'),
            h(
              'div',
              { style: { fontSize: 11, color: COLOR_TERTIARY, marginTop: 2 } },
              props.scanned + ' 个已安装插件 · 只读检查',
            ),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: props.onRefresh,
            title: '重新读取报告',
            'aria-label': '刷新插件健康报告',
            style: {
              appearance: 'none',
              border: '1px solid ' + COLOR_BORDER,
              background: 'transparent',
              color: COLOR_SECONDARY,
              borderRadius: 6,
              padding: '4px 9px',
              fontSize: 12,
              cursor: 'pointer',
            },
            onMouseEnter: function (event) {
              event.currentTarget.style.background = COLOR_HOVER
            },
            onMouseLeave: function (event) {
              event.currentTarget.style.background = 'transparent'
            },
          },
          '刷新',
        ),
      )
    }

    function useReport(visible) {
      const [state, setState] = React.useState({ phase: 'loading', report: null, error: null })

      const load = React.useCallback(async function () {
        try {
          const response = await fetch(route(REPORT_PATH), {
            cache: 'no-store',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          const payload = await response.json()
          if (payload && payload.status === 'scanning') {
            setState({ phase: 'scanning', report: null, error: null })
            return
          }
          if (!payload || typeof payload !== 'object' || typeof payload.engine_status !== 'string') {
            throw new Error('报告格式不正确')
          }
          setState({ phase: 'ready', report: payload, error: null })
        } catch (error) {
          setState({ phase: 'error', report: null, error: String((error && error.message) || error) })
        }
      }, [])

      React.useEffect(
        function () {
          let stopped = false
          const tick = function () {
            if (!stopped) load()
          }
          tick()
          const timer = visible ? globalThis.setInterval(tick, REFRESH_MS) : null
          return function () {
            stopped = true
            if (timer !== null) globalThis.clearInterval(timer)
          }
        },
        [visible, load],
      )

      return [state, load]
    }

    function Panel(props) {
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
      const visible = info && info.tab ? info.tab.visible !== false : true
      const result = useReport(visible)
      const state = result[0]
      const reload = result[1]

      const container = {
        boxSizing: 'border-box',
        height: '100%',
        overflow: 'auto',
        padding: '14px 16px 18px',
        fontFamily: 'inherit',
        fontSize: 13,
        color: COLOR_PRIMARY,
        background: 'var(--dsw-alias-bg-base, transparent)',
      }

      if (state.phase === 'loading') {
        return h('div', { style: container }, h('div', { style: { color: COLOR_SECONDARY } }, '正在读取插件健康报告…'))
      }
      if (state.phase === 'scanning') {
        return h(
          'div',
          { style: container },
          h(Header, { scanned: '—', onRefresh: reload }),
          h('div', { style: { color: COLOR_SECONDARY, marginTop: 18 } }, '正在检查已安装插件，请稍候…'),
        )
      }
      if (state.phase === 'error' || !state.report) {
        return h(
          'div',
          { style: container },
          h(Header, { scanned: '—', onRefresh: reload }),
          h('div', { style: { color: COLOR_DANGER, marginTop: 18, lineHeight: 1.7 } }, '无法读取报告：' + state.error),
          h(
            'div',
            { style: { color: COLOR_TERTIARY, marginTop: 6, lineHeight: 1.7 } },
            '哨兵可能尚未就绪，或当前 DSH 形态不提供该 HTTP 路由。Agent 工具 plugin_health_report 仍然可用。',
          ),
        )
      }

      const report = state.report
      return h(
        'div',
        { style: container },
        h(Header, { scanned: report.scanned_packages, onRefresh: reload }),
        h(DamagedSection, { report: report }),
        h(UnknownSection, { report: report }),
        h(HealthySection, { report: report }),
        h(EngineFooter, { report: report }),
      )
    }

    let degradationReported = false

    function reportDegraded(ctx, error) {
      if (degradationReported) return
      degradationReported = true
      try {
        const detail = error ? String((error && error.message) || error) : 'sidebarRightTabs unavailable'
        fetch(route(DEGRADED_PATH), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'panel_register_failed', detail: detail.slice(0, 300) }),
        }).catch(function () {
          /* the tool surface still works */
        })
      } catch (postError) {
        /* never let the notification break the host page */
      }
    }

    function readService(ctx, key) {
      try {
        if (typeof ctx.get === 'function') {
          const value = ctx.get(key)
          if (value !== undefined && value !== null) return value
        }
        return ctx[key]
      } catch (error) {
        return undefined
      }
    }

    return {
      // Declaring both services lets Cordis wait for the sidebar to exist
      // instead of mistaking a startup race for an incompatible host. The
      // runtime guard below still covers a service that disappears or throws.
      inject: ['slots', 'sidebarRightTabs'],
      apply(ctx) {
        try {
          const tabs = readService(ctx, 'sidebarRightTabs')
          const slots = ctx.slots || readService(ctx, 'slots')
          if (!tabs || typeof tabs.register !== 'function' || !slots || typeof slots.register !== 'function') {
            reportDegraded(ctx)
            return
          }

          const install = function () {
            const disposers = []
            try {
              disposers.push(
                tabs.register({
                  id: PLUGIN_ID,
                  kind: TAB_KIND,
                  title: function () {
                    return '插件健康'
                  },
                  guide: [
                    {
                      id: 'health',
                      order: 30,
                      title: function () {
                        return '插件健康'
                      },
                      description: function () {
                        return '哪些插件坏了、坏在哪'
                      },
                      icon: function () {
                        return HealthIcon(20)
                      },
                    },
                  ],
                }),
              )
            } catch (error) {
              reportDegraded(ctx, error)
            }
            try {
              disposers.push(
                slots.inject('sidebar.right.pane.tab', function () {
                  return slots.register({ name: 'sidebar.right.pane.tab', key: PLUGIN_ID }, Panel)
                }),
              )
            } catch (error) {
              reportDegraded(ctx, error)
            }
            return function () {
              while (disposers.length > 0) {
                const dispose = disposers.pop()
                try {
                  if (typeof dispose === 'function') dispose()
                } catch (error) {
                  /* already disposed */
                }
              }
            }
          }

          if (typeof ctx.effect === 'function') ctx.effect(install)
          else install()
        } catch (error) {
          reportDegraded(ctx, error)
        }
      },
    }
  },
})
