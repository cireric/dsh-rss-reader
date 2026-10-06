/**
 * @dsh-external/dsh-rss-reader — client 半（M2 阅读面）。
 *
 * 入口一个：`sidebar.panellist` 图标。宿主这个座位**没有「开右栏」的口子**（注册项只有
 * id/order/label），图标在架构上绑死主栏——因此图标指向的 `main` 面板做成**转发器**：
 * 一挂载就把阅读器开进右栏（`ctx.sidebarRight.openTab`），再把主栏让回默认对话
 * （`ctx.layout.selectPanel(null)`）。用户看到的即是「点图标 → 阅读器出现在可开合的右栏」。
 *
 * 数据只经 Connection RPC 走主进程（references/connection-rpc.md），浏览器半不直连存储。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Context as ClientContext } from 'cordis'
import { ROUTE_PATH, type ItemView, type Overview, type RpcResult } from '../shared.js'

export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'layout']

/** 本实现在标签页系统里的身份：body 与 chip 标题都注册在它下面。 */
const TAB_ID = '@dsh-external/dsh-rss-reader/tab'
/** 本实现独占的标签页类型。 */
const TAB_KIND = 'rssReader'
/** panellist 图标的 id 必须与 main 座位的 key 相同。 */
const PANEL_ID = 'dsh-rss-reader'

/** 调一个端点并解信封；失败抛出 \`code: message\`，由面板渲染。 */
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
function plainText(html: string | undefined, limit = 240): string {
  if (!html) return ''
  const text = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length > limit ? text.slice(0, limit) + '…' : text
}

/**
 * 主栏座位用的转发器。
 *
 * 宿主的 `sidebar.panellist` 座位没有「开右栏」的口子（注册项只有 id/order/label），
 * 图标在架构上绑死主栏。所以：图标照常切到本面板，本面板一挂载就把阅读器开进**右栏**，
 * 再把主栏让回对话——用户看到的就是「点图标 → 阅读器出现在可开合的右栏里」。
 * 转发失败也不至于白屏：给出手动按钮兜底。
 */
function ReaderLauncher(ctx: ClientContext): () => ReactNode {
  return function Launcher(): ReactNode {
    useEffect(() => {
      try {
        ctx.sidebarRight.openTab(TAB_KIND)
        // null = 主栏回到默认的 conversation 面板
        ;(ctx as unknown as { layout: { selectPanel: (id: unknown) => void } }).layout.selectPanel(null)
      } catch (failure) {
        // 让出去失败就留在本面板，用户仍能用下面的按钮
        ctx.logger?.warn?.('[dsh-rss-reader] 转发到右栏失败：' + String(failure))
      }
    }, [])
    return (
      <div style={{ padding: 16, opacity: 0.8 }}>
        <div>RSS 阅读器已开在右侧栏。</div>
        <button type="button" style={{ marginTop: 8, fontSize: 12, padding: '2px 8px', cursor: 'pointer' }}
          onClick={() => ctx.sidebarRight.openTab(TAB_KIND)}>
          在右栏打开
        </button>
      </div>
    )
  }
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
 * 阅读面组件工厂：闭包持有 client ctx 以便调 RPC。
 * @param ctx - 浏览器半上下文。
 * @returns 可重复注册到多个座位的组件。
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
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 13, lineHeight: 1.5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }}>
          <strong style={{ fontSize: 13 }}>RSS</strong>
          <span style={{ opacity: 0.7 }}>{overview ? overview.unread + ' 条未读 / ' + items.length + ' 条' : '加载中…'}</span>
          <span style={{ flex: 1 }} />
          <button type="button" disabled={busy} onClick={() => { void load('refresh') }}
            style={{ fontSize: 12, padding: '2px 8px', cursor: busy ? 'default' : 'pointer' }}>
            {busy ? '刷新中' : '刷新'}
          </button>
        </div>

        {error !== undefined && (
          <div style={{ padding: '8px 12px', color: '#c0392b', borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }}>{error}</div>
        )}
        {failing.length > 0 && (
          <div style={{ padding: '6px 12px', opacity: 0.75 }}>
            {failing.length} 个源抓取失败：{failing.map((feed) => feed.title + '（' + feed.lastFailure + '）').join('；')}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {!busy && items.length === 0 && (
            <div style={{ padding: 12, opacity: 0.7 }}>还没有条目。订阅源以存储域为准；可在 Config.feeds 里给种子，或用 OPML 导入（M4）。</div>
          )}
          {items.map((item) => {
            const isOpen = expanded === item.id
            const unread = item.readAt === undefined
            return (
              <div key={item.id} style={{ borderBottom: '1px solid color-mix(in srgb, currentColor 8%, transparent)' }}>
                <div role="button" tabIndex={0}
                  onClick={() => { void toggle(item) }}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void toggle(item) } }}
                  style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', flex: '0 0 auto', marginTop: 5, background: unread ? 'currentColor' : 'transparent', opacity: unread ? 0.85 : 0 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: unread ? 600 : 400, opacity: unread ? 1 : 0.72, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: isOpen ? 'normal' : 'nowrap' }}>{item.title || item.link || '(无标题)'}</span>
                    <span style={{ display: 'block', fontSize: 11, opacity: 0.6, marginTop: 2 }}>
                      {item.feedTitle} · {relativeTime(item.publishedAt ?? item.fetchedAt)}
                    </span>
                  </span>
                </div>
                {isOpen && (
                  <div style={{ padding: '0 12px 10px 26px', opacity: 0.85 }}>
                    {plainText(item.summary) !== '' && <div>{plainText(item.summary)}</div>}
                    {item.link !== '' && (
                      <a href={item.link} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>打开原站 ↗</a>
                    )}
                  </div>
                )}
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
  const Launcher = ReaderLauncher(ctx)

  // ① 右栏标签页：类型（stage 1）→ body（stage 2）→ chip 标题
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    priority: 'builtin',
    title: () => 'RSS 阅读器',
  }), 'dsh-rss-reader: tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: TAB_ID },
    Reader,
  )), 'dsh-rss-reader: tab body')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab.title', key: TAB_ID },
    () => <span>RSS 阅读器</span>,
  )), 'dsh-rss-reader: tab chip title')

  // ② 侧栏图标（panellist）：该座位必须同名注册一个 main 面板，否则点选即抛错。
  // 这里把 main 面板做成转发器——挂载即把阅读器开进右栏，并把主栏让回对话。
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PANEL_ID },
    Launcher,
  )), 'dsh-rss-reader: main panel (launcher)')

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => 'RSS 阅读器' },
    ReaderIcon,
  )), 'dsh-rss-reader: panellist icon')
}