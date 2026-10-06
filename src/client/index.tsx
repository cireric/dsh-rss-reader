/**
 * @dsh-external/dsh-rss-reader — client 半（M2 阅读面）。
 *
 * 入口只有侧栏图标 `sidebar.panellist`，点击即切到主栏阅读器：该座位的 id 必须同名于
 * `main` 座位的 key（缺 main 条目点选即抛错），所以这里成对注册，阅读器就渲染在 main 面板。
 *
 * 曾试过「图标 → 开进右栏标签页」（把 main 面板做成转发器），实测在你环境里转发不生效、
 * 只留下一个点了没反应的兜底按钮，已按用户要求整体移除（2026-10-06）。
 *
 * 数据只经同源 HTTP 通道走主进程（见 shared.ts），浏览器半不直连存储。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Context as ClientContext } from 'cordis'
import { ROUTE_PATH, type ItemView, type Overview, type RpcResult } from '../shared.js'

export const inject = ['slots']

/** panellist 图标的 id 必须与 main 座位的 key 相同。 */
const PANEL_ID = 'dsh-rss-reader'

/** 调一个端点并解信封；失败抛出 `code: message`，由面板渲染。 */
async function callRpc<T>(endpoint: string, payload?: unknown): Promise<T> {
  // 同源 fetch：宿主用自己的 web server 承载这条路由，并套了 connection 的准入检查
  const response = await fetch(ROUTE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, payload: payload ?? null }),
  })
  if (!response.ok) throw new Error('HTTP ' + response.status)
  const result = (await response.json()) as RpcResult<T>
  if (result?.ok) return result.value
  const error = result?.error
  throw new Error(error ? error.code + ': ' + error.message : '通道返回了非预期形状')
}

/** 相对时间：列表里最需要一眼看懂的就是「多久以前」。 */
function relativeTime(iso: string | undefined): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const minutes = Math.round((Date.now() - then) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return minutes + ' 分钟前'
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours + ' 小时前'
  const days = Math.round(hours / 24)
  if (days < 30) return days + ' 天前'
  return new Date(then).toISOString().slice(0, 10)
}

/** 摘要可能是 HTML 片段；列表里只当纯文本看，不注入 DOM。 */
function plainText(html: string | undefined, limit = 400): string {
  if (!html) return ''
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

function ReaderIcon({ size = 16, active = false }: { size?: number; active?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ opacity: active ? 1 : 0.72 }}>
      <circle cx="3.6" cy="12.4" r="1.6" fill="currentColor" />
      <path d="M2 7.2A6.8 6.8 0 0 1 8.8 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M2 2.6A11.4 11.4 0 0 1 13.4 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

/**
 * 阅读面组件：跨源合并的时间倒序条目流，点击展开摘要与原站链接并标记已读。
 * @returns 注册进 main 座位的组件。
 */
function createReader(ctx: ClientContext): () => ReactNode {
  return function Reader(): ReactNode {
    const [overview, setOverview] = useState<Overview | undefined>(undefined)
    const [error, setError] = useState<string | undefined>(undefined)
    const [busy, setBusy] = useState(false)
    const [expanded, setExpanded] = useState<string | undefined>(undefined)

    const load = useCallback(async (endpoint: 'overview' | 'refresh'): Promise<void> => {
      setBusy(true)
      setError(undefined)
      try {
        setOverview(await callRpc<Overview>(endpoint))
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      } finally {
        setBusy(false)
      }
    }, [])

    // 打开面板即刷新；主进程侧有最小间隔节流，这里无脑调用即可
    useEffect(() => {
      void load('refresh')
    }, [load])

    const toggle = useCallback(async (item: ItemView): Promise<void> => {
      setExpanded((current) => (current === item.id ? undefined : item.id))
      if (item.readAt !== undefined) return
      try {
        await callRpc('markRead', { itemId: item.id })
        setOverview((current) => {
          if (!current) return current
          return {
            ...current,
            items: current.items.map((entry) => (entry.id === item.id ? { ...entry, readAt: new Date().toISOString() } : entry)),
            unread: Math.max(0, current.unread - 1),
          }
        })
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    }, [])

    const feeds = overview?.feeds ?? []
    const failing = feeds.filter((feed) => feed.lastFailure)
    const items = overview?.items ?? []

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 14, lineHeight: 1.55 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }}>
          <strong>RSS 阅读器</strong>
          <span style={{ opacity: 0.7 }}>{overview ? overview.unread + ' 条未读 / ' + items.length + ' 条' : '加载中…'}</span>
          <span style={{ flex: 1 }} />
          <button type="button" disabled={busy} onClick={() => { void load('refresh') }}
            style={{ fontSize: 13, padding: '3px 10px', cursor: busy ? 'default' : 'pointer' }}>
            {busy ? '刷新中' : '刷新'}
          </button>
        </div>

        {error !== undefined && (
          <div style={{ padding: '8px 20px', color: '#c0392b' }}>{error}</div>
        )}
        {failing.length > 0 && (
          <div style={{ padding: '6px 20px', opacity: 0.75, fontSize: 12 }}>
            {failing.length} 个源抓取失败：{failing.map((feed) => feed.title + '（' + feed.lastFailure + '）').join('；')}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {!busy && items.length === 0 && (
            <div style={{ padding: 20, opacity: 0.7 }}>还没有条目。订阅源以存储域为准；可在 Config.feeds 里给种子，或用 OPML 导入（M4）。</div>
          )}
          {items.map((item) => {
            const isOpen = expanded === item.id
            const unread = item.readAt === undefined
            return (
              <div key={item.id} style={{ borderBottom: '1px solid color-mix(in srgb, currentColor 8%, transparent)' }}>
                <div role="button" tabIndex={0}
                  onClick={() => { void toggle(item) }}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void toggle(item) } }}
                  style={{ padding: '10px 20px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'baseline' }}>
                  <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', flex: '0 0 auto', marginTop: 6, background: unread ? 'currentColor' : 'transparent' }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: unread ? 600 : 400, opacity: unread ? 1 : 0.7 }}>{item.title || item.link || '(无标题)'}</span>
                    <span style={{ display: 'block', fontSize: 12, opacity: 0.6, marginTop: 2 }}>
                      {item.feedTitle} · {relativeTime(item.publishedAt ?? item.fetchedAt)}
                    </span>
                    {isOpen && (
                      <span style={{ display: 'block', marginTop: 8, opacity: 0.85, fontSize: 13 }}>
                        {plainText(item.summary) !== '' && <span style={{ display: 'block' }}>{plainText(item.summary)}</span>}
                        {item.link !== '' && (
                          <a href={item.link} target="_blank" rel="noreferrer" style={{ fontSize: 12, display: 'inline-block', marginTop: 6 }}>打开原站 ↗</a>
                        )}
                      </span>
                    )}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    )
  }
}

export function apply(ctx: ClientContext): void {
  const Reader = createReader(ctx)

  // 阅读器本体进主栏；id 必须与 panellist 图标的 id 相同，否则点图标会抛错
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PANEL_ID },
    Reader,
  )), 'dsh-rss-reader: main panel')

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => 'RSS 阅读器' },
    ReaderIcon,
  )), 'dsh-rss-reader: panellist icon')
}
