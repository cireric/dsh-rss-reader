/**
 * @dsh-external/dsh-rss-reader — client 半（M3 键盘面 + 未读徽标）。
 *
 * 入口只有侧栏图标 `sidebar.panellist`，点击切到主栏阅读器（该座位的 id 必须同名于
 * `main` 座位的 key，缺 main 条目点选即抛错）。
 *
 * 键盘：走 `ctx.shortcuts`——它的 `regions: ['page']` 保证焦点在输入框时不触发，
 * `resolve()` 返回 blocked 则拒绝执行；本插件用它实现「只有阅读器是当前焦点面时才响应」
 * （判定方式是阅读器根节点是否包含 document.activeElement，不依赖 layout 服务）。
 *
 * 状态放在 apply 里创建的共享 store 上（不是组件内部 state）：快捷键要能驱动同一份状态，
 * 未读徽标也要在没有面板时读它。
 *
 * 数据只经同源 HTTP 通道走主进程（见 shared.ts），浏览器半不直连存储。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Context as ClientContext } from 'cordis'
import { ROUTE_PATH, type FeedView, type ItemView, type Overview, type RpcResult } from '../shared.js'

export const inject = ['slots']

/** panellist 图标的 id 必须与 main 座位的 key 相同。 */
const PANEL_ID = 'dsh-rss-reader'
/** 阅读器根节点的标记：快捷键用它判断焦点是否在本面板内。 */
const ROOT_ATTR = 'data-dsh-rss-reader'
/** 「全部标记已读」的撤销窗口。 */
const UNDO_WINDOW_MS = 5000
/**
 * 加载指示的消抖阈值：刷新常常在毫秒级返回，立刻显示「刷新中」会闪一下。
 * 超过这个时长才把加载态画出来（handoff §8 记过这条教训）。
 */
const SLOW_LOADING_MS = 180

/** 面板内自带的样式：只用带前缀的类名，不碰宿主视觉 token。 */
const STYLE = `
.dsh-rss-btn { display:inline-flex; align-items:center; gap:6px; font:inherit; font-size:13px;
  padding:4px 10px; border-radius:6px; color:inherit; background:transparent; cursor:pointer;
  border:1px solid color-mix(in srgb, currentColor 22%, transparent);
  transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease; }
.dsh-rss-btn:hover:not(:disabled) { background: color-mix(in srgb, currentColor 10%, transparent);
  border-color: color-mix(in srgb, currentColor 35%, transparent); }
.dsh-rss-btn:active:not(:disabled) { background: color-mix(in srgb, currentColor 16%, transparent); }
.dsh-rss-btn:disabled { opacity:.55; cursor:default; }
.dsh-rss-btn--ghost { border-color:transparent; padding:2px 8px; }
.dsh-rss-spin { animation: dsh-rss-spin 800ms linear infinite; transform-origin:50% 50%; }
@keyframes dsh-rss-spin { to { transform: rotate(360deg); } }
.dsh-rss-bar { position:relative; height:2px; overflow:hidden; }
.dsh-rss-bar::after { content:''; position:absolute; top:0; bottom:0; width:35%;
  background:currentColor; opacity:.45; animation: dsh-rss-slide 1s ease-in-out infinite; }
@keyframes dsh-rss-slide { 0% { left:-35%; } 100% { left:100%; } }
`

/** 刷新图标：加载时整圈旋转，省掉额外的 spinner 元素。 */
function RefreshIcon({ spinning }: { spinning?: boolean }): ReactNode {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none" aria-hidden="true"
      className={spinning === true ? 'dsh-rss-spin' : undefined}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M13.6 2.2v3.2h-3.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

type Filter = 'all' | 'unread' | 'starred'

interface ReaderState {
  items: ItemView[]
  feeds: FeedView[]
  unread: number
  filter: Filter
  selectedId: string | undefined
  loading: boolean
  error: string | undefined
  /** 刚被「全部标记已读」的条目，供短时撤销 */
  undo: { ids: string[]; until: number } | undefined
}

/** 调一个端点并解信封；失败抛出 `code: message`，由面板渲染。 */
async function callRpc<T>(endpoint: string, payload?: unknown): Promise<T> {
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

/**
 * feed 正文（HTML 片段）→ 段落数组。
 *
 * 只做「块级标签换成换行 + 去掉其余标签 + 收敛空白」，全程当**文本**渲染，不注入 DOM：
 * 因此没有 XSS 面，也不需要 sanitizer 依赖。体积上限由存储层负责（Config.maxContentChars）。
 * 注意实体解码在解析层已经做过（htmlEntities），这里不重复处理。
 */
function toParagraphs(html: string | undefined): string[] {
  if (!html) return []
  const withBreaks = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/(p|div|li|h[1-6]|blockquote|tr|section|article|figure)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
  return withBreaks
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((line) => line !== '')
}

/** 右栏自建「正文」标签页：C 步只验证地基，A 步再接入正文抓取与渲染。 */
const ARTICLE_KIND = 'rssReaderArticle'
const ARTICLE_ID = 'dsh-rss-reader-article'

/** 右栏标签页记录里我们关心的字段（宿主是 TS，客户端运行时按形状取）。 */
interface ArticleTabLike {
  readonly id?: string
  readonly kind?: string
  readonly title?: string
  readonly navigation?: { readonly params?: { readonly url?: string; readonly title?: string } }
}

/** 右栏服务的最小面（可选依赖，用 ctx.get 判空，缺了也不影响阅读器本体）。 */
interface SidebarRightLike {
  active?: () => ArticleTabLike | undefined
  openTab?: (kind: string, options?: { params?: unknown }) => void
  close?: (tabId: string) => void
}

/**
 * 把右栏交互的成败回传宿主日志（**临时诊断**，A 步落地后删）。
 *
 * 为什么值得这一小段管道：右栏是我们完全看不见的浏览器侧行为，靠用户口述「点了没反应」
 * 无法定位——上一次就是这么卡住的。把 beforeKind/afterKind/error 落到我可以读的日志里，
 * 一次按键就能拿到硬证据。
 */
async function reportProbe(step: string, detail: Record<string, unknown>): Promise<void> {
  try {
    await callRpc('probe', { step, ...detail })
  } catch (error) {
    // 探针自身失败要可见，但绝不该影响用户操作
    console.warn('[dsh-rss-reader] 探针上报失败：' + String(error))
  }
}

/** 右栏标签页的标题 chip。 */
function ArticleTitle(props: { useTabInfo?: () => { tab: ArticleTabLike } }): ReactNode {
  const title = props.useTabInfo?.()?.tab?.navigation?.params?.title
  return <span>{typeof title === 'string' && title !== '' ? title : '正文'}</span>
}

/** 右栏标签页的正文体（C 步占位；A 步换成抽取后的正文）。 */
function ArticleBody(props: { useTabInfo?: () => { tab: ArticleTabLike } }): ReactNode {
  const url = props.useTabInfo?.()?.tab?.navigation?.params?.url
  return (
    <div style={{ padding: 16, fontSize: 13, lineHeight: 1.6 }}>
      <div style={{ opacity: 0.75 }}>右栏「正文」标签页已能打开——C 步地基验证中。</div>
      <div style={{ opacity: 0.6, marginTop: 6 }}>正文抓取与渲染在 A 步接入。</div>
      {typeof url === 'string' && url !== '' && (
        <div style={{ marginTop: 10, wordBreak: 'break-all' }}>
          <a href={url} target="_blank" rel="noreferrer">{url}</a>
        </div>
      )}
    </div>
  )
}

/** 解析右栏服务（可选依赖：拿不到就返回 undefined，不抛）。 */
function sidebarRightOf(ctx: ClientContext): SidebarRightLike | undefined {
  try {
    const get = (ctx as { get?: (name: string) => unknown }).get
    return typeof get === 'function' ? (get.call(ctx, 'sidebarRight') as SidebarRightLike | undefined) : undefined
  } catch {
    return undefined
  }
}

/** 阅读器根节点是否持有焦点——快捷键作用域的判据。 */
function readerFocused(): boolean {
  try {
    const root = document.querySelector('[' + ROOT_ATTR + ']')
    if (root === null) return false
    const active = document.activeElement
    return active !== null && root.contains(active)
  } catch {
    return false
  }
}

function createReaderStore(ctx: ClientContext) {
  let state: ReaderState = {
    items: [], feeds: [], unread: 0, filter: 'all',
    selectedId: undefined, loading: true, error: undefined, undo: undefined,
  }
  const listeners = new Set<() => void>()
  const emit = (): void => { for (const listener of listeners) listener() }
  const set = (patch: Partial<ReaderState>): void => { state = { ...state, ...patch }; emit() }
  const get = (): ReaderState => state

  /** 当前过滤下的可见条目——A/j/k 都只作用于它。 */
  const visible = (): ItemView[] => {
    if (state.filter === 'unread') return state.items.filter((item) => item.readAt === undefined)
    if (state.filter === 'starred') return state.items.filter((item) => item.starred)
    return state.items
  }

  const applyOverview = (overview: Overview): void => {
    const selected = state.selectedId
    const stillThere = selected !== undefined && overview.items.some((item) => item.id === selected)
    set({
      items: overview.items,
      feeds: overview.feeds,
      unread: overview.unread,
      loading: false,
      error: undefined,
      selectedId: stillThere ? selected : overview.items[0]?.id,
    })
  }

  const load = async (endpoint: 'overview' | 'refresh'): Promise<void> => {
    set({ loading: true })
    try {
      applyOverview(await callRpc<Overview>(endpoint))
    } catch (failure) {
      set({ loading: false, error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /** 就地改一条的本地镜像，避免每次操作都整份重取。 */
  const patchItem = (itemId: string, patch: Partial<ItemView>): void => {
    set({ items: state.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)) })
  }

  const markRead = async (itemId: string): Promise<void> => {
    if (state.items.find((item) => item.id === itemId)?.readAt !== undefined) return
    patchItem(itemId, { readAt: new Date().toISOString() })
    set({ unread: Math.max(0, state.unread - 1) })
    try {
      await callRpc('markRead', { itemIds: [itemId] })
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /**
   * j/k：**只移动选中，不标已读**（用户 2026-10-06 明确要求）。
   *
   * ⚠️ 这是对 Google Reader 的**有意偏离**——GR 里 j/k 扫过即标已读。别当 bug 改回去：
   * 已读只由「打开条目」触发（o / Enter / 鼠标点击）以及显式的 m。
   */
  const selectRelative = (delta: number): void => {
    const list = visible()
    if (list.length === 0) return
    const current = list.findIndex((item) => item.id === state.selectedId)
    const nextIndex = current < 0
      ? (delta > 0 ? 0 : list.length - 1)
      : Math.min(list.length - 1, Math.max(0, current + delta))
    const target = list[nextIndex]
    if (target === undefined) return
    set({ selectedId: target.id })
  }

  const openSelected = (): void => {
    const item = visible().find((entry) => entry.id === state.selectedId)
    if (item === undefined || item.link === '') return
    // 打开原站按已定方案走新标签页
    window.open(item.link, '_blank', 'noopener')
  }

  const toggleStar = async (): Promise<void> => {
    const item = visible().find((entry) => entry.id === state.selectedId)
    if (item === undefined) return
    patchItem(item.id, { starred: !item.starred })
    try {
      await callRpc('toggleStar', { itemId: item.id })
    } catch (failure) {
      patchItem(item.id, { starred: item.starred })
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  const toggleRead = async (): Promise<void> => {
    const item = visible().find((entry) => entry.id === state.selectedId)
    if (item === undefined) return
    if (item.readAt === undefined) {
      await markRead(item.id)
      return
    }
    patchItem(item.id, { readAt: undefined })
    set({ unread: state.unread + 1 })
    try {
      await callRpc('unmarkRead', { itemIds: [item.id] })
    } catch (failure) {
      patchItem(item.id, { readAt: item.readAt })
      set({ unread: Math.max(0, state.unread - 1), error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /** A：把**当前过滤下**的未读全部标为已读，留一个短时撤销窗口。 */
  const markAllRead = async (): Promise<void> => {
    const ids = visible().filter((item) => item.readAt === undefined).map((item) => item.id)
    if (ids.length === 0) return
    const stamp = new Date().toISOString()
    set({
      items: state.items.map((item) => (ids.includes(item.id) ? { ...item, readAt: stamp } : item)),
      unread: Math.max(0, state.unread - ids.length),
      undo: { ids, until: Date.now() + UNDO_WINDOW_MS },
    })
    try {
      const result = await callRpc<{ unread: number }>('markRead', { itemIds: ids })
      set({ unread: result.unread })
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  const undoMarkAll = async (): Promise<void> => {
    const undo = state.undo
    if (undo === undefined) return
    set({ undo: undefined })
    set({ items: state.items.map((item) => (undo.ids.includes(item.id) ? { ...item, readAt: undefined } : item)) })
    try {
      const result = await callRpc<{ unread: number }>('unmarkRead', { itemIds: undo.ids })
      set({ unread: result.unread })
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  return {
    subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    get, visible, load, markRead, selectRelative, openSelected, toggleStar, toggleRead, markAllRead, undoMarkAll,
    setFilter: (filter: Filter): void => { set({ filter }); const list = filter === 'all' ? state.items : state.items.filter((i) => (filter === 'unread' ? i.readAt === undefined : i.starred)); set({ selectedId: list[0]?.id }) },
    select: (itemId: string): void => { set({ selectedId: itemId }) },
  }
}

type ReaderStore = ReturnType<typeof createReaderStore>

/** 订阅 store 并强制重渲染。 */
function useReaderStore(store: ReaderStore): ReaderState {
  const [, force] = useState(0)
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store])
  return store.get()
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

function createReader(store: ReaderStore, ctx: ClientContext): () => ReactNode {
  return function Reader(): ReactNode {
    const state = useReaderStore(store)
    const [root, setRoot] = useState<HTMLDivElement | null>(null)
    const [expanded, setExpanded] = useState<string | undefined>(undefined)
    // 慢加载：只有超过 180ms 还在加载时才把「刷新中」画出来，避免毫秒级请求闪一下
    const [slowLoading, setSlowLoading] = useState(false)
    useEffect(() => {
      if (!state.loading) {
        setSlowLoading(false)
        return
      }
      const timer = setTimeout(() => setSlowLoading(true), SLOW_LOADING_MS)
      return () => clearTimeout(timer)
    }, [state.loading])

    // 打开面板即刷新（主进程侧有最小间隔节流），并把焦点收到列表上，键盘立即可用
    useEffect(() => {
      void store.load('refresh')
    }, [])
    useEffect(() => {
      root?.focus()
    }, [root])

    // 键盘流：挂在阅读器根节点上——根节点持有焦点，所以只在阅读器激活时响应，
    // 也不会截获别处的输入框。⚠️ 不走 ctx.shortcuts：平台规则禁止无修饰键的绑定
    // （configuration.ts:100 —— modifiers 为空或全为 shift 即 modifier-required，
    // registry.register 会直接 throw，实测会把整个 client 半炸掉）。
    useEffect(() => {
      if (root === null) return
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
        const run = (action: () => void): void => { event.preventDefault(); action() }
        switch (event.key) {
          case 'j': run(() => store.selectRelative(1)); break
          case 'k': run(() => store.selectRelative(-1)); break
          // Google Reader 的语义：o 展开/折叠（列表内），v 才开原站
          // o = 展开/折叠 + 标已读（已读的唯一自动触发点，另有显式的 m）
          case 'o': run(() => {
            const selected = store.get().selectedId
            if (selected === undefined) return
            setExpanded((current) => (current === selected ? undefined : selected))
            void store.markRead(selected)
          }); break
          case 'v': run(() => store.openSelected()); break
          // V：在同一会话的右栏打开该条链接（C 步地基验证；成败证据回传宿主日志）
          case 'V': run(() => {
            const selected = store.visible().find((entry) => entry.id === store.get().selectedId)
            if (selected === undefined || selected.link === '') return
            const detail: Record<string, unknown> = { url: selected.link }
            const sidebarRight = sidebarRightOf(ctx)
            detail.hasService = sidebarRight !== undefined
            if (sidebarRight === undefined) {
              void reportProbe('openTab-no-service', detail)
              return
            }
            try {
              detail.beforeKind = sidebarRight.active?.()?.kind ?? null
              sidebarRight.openTab?.(ARTICLE_KIND, { params: { url: selected.link, title: selected.title } })
              const after = sidebarRight.active?.()
              detail.afterKind = after?.kind ?? null
              detail.afterTabId = after?.id ?? null
            } catch (error) {
              detail.error = error instanceof Error ? error.message : String(error)
            }
            void reportProbe('openTab', detail)
          }); break
          // Esc：只在右栏当前正是本插件的「正文」标签页时才动作，避免抢弹层的 Esc
          case 'Escape': {
            const sidebarRight = sidebarRightOf(ctx)
            const active = sidebarRight?.active?.()
            if (sidebarRight?.close === undefined || active === undefined || active.kind !== ARTICLE_KIND) return
            const tabId = active.id
            if (tabId === undefined) return
            event.preventDefault()
            try {
              sidebarRight.close(tabId)
              void reportProbe('closeTab', { tabId, ok: true })
            } catch (error) {
              void reportProbe('closeTab', { tabId, ok: false, error: String(error) })
            }
            break
          }
          case 's': run(() => { void store.toggleStar() }); break
          case 'm': run(() => { void store.toggleRead() }); break
          case 'A': run(() => { void store.markAllRead() }); break
          default: break
        }
      }
      root.addEventListener('keydown', onKeyDown)
      return () => { root.removeEventListener('keydown', onKeyDown) }
    }, [root, store])

    const items = store.visible()
    const failing = state.feeds.filter((feed) => feed.lastFailure)
    const filters: Array<{ key: Filter; label: string }> = [
      { key: 'all', label: '全部' },
      { key: 'unread', label: '未读' },
      { key: 'starred', label: '星标' },
    ]

    return (
      <div ref={setRoot} tabIndex={0} {...{ [ROOT_ATTR]: '' }}
        style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 14, lineHeight: 1.55, outline: 'none' }}>
        <style>{STYLE}</style>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 20px', borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }}>
          <strong>RSS 阅读器</strong>
          <span style={{ opacity: 0.7 }}>{state.unread} 条未读 / {state.items.length} 条</span>
          <span style={{ display: 'flex', gap: 4, marginLeft: 8 }}>
            {filters.map((filter) => (
              <button key={filter.key} type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
                onClick={() => store.setFilter(filter.key)}
                style={{
                  fontWeight: state.filter === filter.key ? 600 : 400,
                  opacity: state.filter === filter.key ? 1 : 0.65,
                }}>
                {filter.label}
              </button>
            ))}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, opacity: 0.55 }}>j/k 移动（不标已读）· o 展开并已读 · v 开原站 · s 星标 · m 已读 · A 全部</span>
          <button type="button" className="dsh-rss-btn" disabled={state.loading}
            title="重新抓取所有订阅源（受最小间隔节流）"
            onClick={() => { void store.load('refresh') }}>
            <RefreshIcon spinning={slowLoading} />
            {slowLoading ? '刷新中…' : '刷新'}
          </button>
        </div>
        {slowLoading && <div className="dsh-rss-bar" aria-hidden="true" />}

        {state.error !== undefined && <div style={{ padding: '8px 20px', color: '#c0392b' }}>{state.error}</div>}
        {state.undo !== undefined && (
          <div style={{ padding: '6px 20px', fontSize: 12, background: 'color-mix(in srgb, currentColor 8%, transparent)' }}>
            已把 {state.undo.ids.length} 条标为已读 ·{' '}
            <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" onClick={() => { void store.undoMarkAll() }}>撤销</button>
          </div>
        )}
        {failing.length > 0 && (
          <div style={{ padding: '6px 20px', opacity: 0.75, fontSize: 12 }}>
            {failing.length} 个源抓取失败：{failing.map((feed) => feed.title + '（' + feed.lastFailure + '）').join('；')}
          </div>
        )}

        <div style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          opacity: slowLoading ? 0.6 : 1, transition: 'opacity 150ms ease',
        }}>
          {!state.loading && items.length === 0 && (
            <div style={{ padding: 20, opacity: 0.7 }}>
              {state.filter === 'starred' ? '还没有星标条目。' : state.filter === 'unread' ? '没有未读条目。' : '还没有条目。订阅源以存储域为准；可在 Config.feeds 里给种子，或用 OPML 导入（M4）。'}
            </div>
          )}
          {items.map((item) => {
            const isOpen = expanded === item.id
            const unread = item.readAt === undefined
            const selected = state.selectedId === item.id
            return (
              <div key={item.id} style={{ borderBottom: '1px solid color-mix(in srgb, currentColor 8%, transparent)' }}>
                <div role="button" tabIndex={0}
                  onClick={() => {
                    store.select(item.id)
                    setExpanded((current) => (current === item.id ? undefined : item.id))
                    void store.markRead(item.id)
                  }}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); store.select(item.id); setExpanded(item.id); void store.markRead(item.id) } }}
                  style={{
                    padding: '10px 20px', cursor: 'pointer', display: 'flex', gap: 10, alignItems: 'baseline',
                    background: selected ? 'color-mix(in srgb, currentColor 7%, transparent)' : 'transparent',
                  }}>
                  <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', flex: '0 0 auto', marginTop: 6, background: unread ? 'currentColor' : 'transparent' }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'block', fontWeight: unread ? 600 : 400, opacity: unread ? 1 : 0.7 }}>
                      {item.starred ? '★ ' : ''}{item.title || item.link || '(无标题)'}
                    </span>
                    <span style={{ display: 'block', fontSize: 12, opacity: 0.6, marginTop: 2 }}>
                      {item.feedTitle} · {relativeTime(item.publishedAt ?? item.fetchedAt)}
                    </span>
                    {isOpen && (
                      <span style={{ display: 'block', marginTop: 8, opacity: 0.85, fontSize: 13 }}>
                        {toParagraphs(item.summary).length === 0 && (
                          <span style={{ display: 'block', opacity: 0.7 }}>（此源只提供摘要，点下面到原站读全文）</span>
                        )}
                        {toParagraphs(item.summary).map((paragraph, index) => (
                          <span key={index} style={{ display: 'block', margin: index === 0 ? '0' : '0.6em 0 0' }}>{paragraph}</span>
                        ))}
                        {item.link !== '' && (
                          <a href={item.link} target="_blank" rel="noreferrer" style={{ fontSize: 12, display: 'inline-block', marginTop: 8 }}>打开原站 ↗</a>
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

/** 侧栏折叠按钮里的未读数（非交互）。 */
function Badge({ store }: { store: ReaderStore }): ReactNode {
  const state = useReaderStore(store)
  if (state.unread === 0) return null
  return <span title={state.unread + ' 条未读'} style={{ fontSize: 10 }}>{state.unread > 99 ? '99+' : state.unread}</span>
}

export function apply(ctx: ClientContext): void {
  const store = createReaderStore(ctx)
  const Reader = createReader(store, ctx)

  // 阅读器本体进主栏；id 必须与 panellist 图标的 id 相同，否则点图标会抛错
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: PANEL_ID },
    Reader,
  )), 'dsh-rss-reader: main panel')

  ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => 'RSS 阅读器' },
    ReaderIcon,
  )), 'dsh-rss-reader: panellist icon')

  // 未读徽标：数据源就是上面那个共享 store；启动先拉一次，之后每次面板刷新都会更新。
  // ⚠️ 这个座位是 single 且已被官方 DesktopUpdateIndicator 以**默认优先级 0** 占用；
  // slots 的规则是「同一 cell 同优先级的第二次注册直接抛错」（ui-slots:1134-1140），
  // 而「cell 内最低优先级的条目渲染」。故显式给 -1：既避开抛错，又让本插件渲染。
  ctx.effect(() => ctx.slots.inject('sidebar.toggle.badge', () => ctx.slots.register(
    { name: 'sidebar.toggle.badge', priority: -1 },
    () => <Badge store={store} />,
  )), 'dsh-rss-reader: unread badge')
  void store.load('overview')

}