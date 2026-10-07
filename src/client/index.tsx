/**
 * @dsh-external/dsh-rss-reader — client 半（M3 键盘面 + 未读徽标）。
 *
 * 入口只有侧栏图标 `sidebar.panellist`，点击切到主栏阅读器（该座位的 id 必须同名于
 * `main` 座位的 key，缺 main 条目点选即抛错）。
 *
 * 键盘：**不走 `ctx.shortcuts`**（平台禁止无修饰键的绑定，见 keys.ts 注释），而是 `document` 级
 * 监听 + 输入框/弹层/不可见三重守卫：面板卸载即移除监听，所以只在阅读器挂载期生效。
 * 键位语义集中在 `src/keys.ts`（纯函数、有单测），滚动跟随在 `src/list-scroll.ts`（同）。
 *
 * 状态放在 apply 里创建的共享 store 上（不是组件内部 state）：快捷键要能驱动同一份状态，
 * 未读徽标也要在没有面板时读它。
 *
 * 数据只经同源 HTTP 通道走主进程（见 shared.ts），浏览器半不直连存储。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Context as ClientContext } from 'cordis'
import { ROUTE_PATH, type ArticlePayload, type CleanupResult, type FeedView, type ItemView, type OpmlExportResult, type OpmlImportResult, type Overview, type RpcResult } from '../shared.js'
import { resolveReaderKey } from '../keys.js'
import { nextScrollTop, scanTop, pageTop } from '../list-scroll.js'
import { pickInitialRender, nextRender } from '../article-view.js'

export const inject = ['slots']

/** panellist 图标的 id 必须与 main 座位的 key 相同。 */
const PANEL_ID = 'dsh-rss-reader'
/** 阅读器根节点的标记：快捷键用它判断焦点是否在本面板内。 */
const ROOT_ATTR = 'data-dsh-rss-reader'
/**
 * 正文「够不够当正文」的门槛（字符）。
 *
 * 与抽取层的 MIN_PARAGRAPH_CHARS 同源：低于它的内容在列表里读不出信息量，只会在视觉上
 * 冒充正文。实测 HN 的 feed 里 description 恒为 68 字符的 HTML，剥标签后只剩 "Comments"。
 */
const MIN_BODY_CHARS = 40

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

/** 按需正文的运行态（D 方案：V 进正文、Esc 回列表）。 */
interface ArticleState {
  itemId: string
  loading: boolean
  title?: string
  /** 结构化正文块（新）；与 paragraphs 互斥——后者是老缓存里的纯文本形态 */
  blocks?: Array<Record<string, unknown>>
  paragraphs?: string[]
  failure?: string
  /** 站点是否允许被嵌入（决定「原站视图」可不可用） */
  frameable?: boolean
  /** 抽取正文（阅读视图）还是原页（原站视图，iframe） */
  render?: 'reading' | 'original'
}

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
  /** 当前视图：列表 / 正文 / 订阅管理（订阅管理同样在主栏内切换，见 handoff §19） */
  view: 'list' | 'article' | 'feeds'
  /** 最近一次导入的报告（坏源要逐条列出，不能只报总数） */
  importReport: OpmlImportResult | undefined
  /** 订阅管理里的忙碌标记（导入要逐源抓取，可能数秒） */
  feedsBusy: boolean
  /** 一次性提示（如清理结果）：显示后由用户下一个动作清掉，不设定时器 */
  notice: string | undefined
  article: ArticleState | undefined
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


/**
 * 快捷键的守卫：焦点在输入框、可编辑区或弹层里时不响应。
 *
 * 为什么不再要求「阅读器持有焦点」：用户实测切到阅读器后必须先用鼠标点一下才能用快捷键——
 * 因为宿主在面板切换后并不把按键交给我们的节点。现在监听挂在 document 上（面板卸载即移除），
 * 于是「只有阅读器存在时才可能响应」由生命周期保证，而「别抢输入框的键」由本函数保证。
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  try {
    if (target.isContentEditable) return true
    if (target.closest('[role="dialog"], [aria-modal="true"], dialog') !== null) return true
    const tag = target.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  } catch {
    return false
  }
  return false
}

/**
 * 阅读器状态与动作。
 *
 * 刻意 `export`：客户端行为在浏览器里跑，我无法自测；导出来之后，测试可以直接驱动
 * 真实 store（喂桩 fetch / window.open），把「按 v 打开并标已读」这类**接线**钉住——
 * 历史上多次故障都出在接线上，而不是算法上。
 */
export function createReaderStore() {
  let state: ReaderState = {
    items: [], feeds: [], unread: 0, filter: 'all',
    selectedId: undefined, loading: true, error: undefined, undo: undefined,
    view: 'list', article: undefined, notice: undefined,
    importReport: undefined, feedsBusy: false,
  }
  const listeners = new Set<() => void>()
  const emit = (): void => { for (const listener of listeners) listener() }
  const set = (patch: Partial<ReaderState>): void => { state = { ...state, ...patch }; emit() }
  const get = (): ReaderState => state

  /**
   * 当前过滤下的可见条目——A/j/k 都只作用于它。
   *
   * **钉住当前选中项**：打开条目会立即标已读，若此时正处在「未读」筛选下，该条目会当场
   * 从列表消失——而你正要读的正是它（用户实测发现的体验 bug）。所以只要它还处于选中状态，
   * 就一并保留；一旦移开（j/k 或点击别处）就自然让位。
   *
   * 实现上是「按过滤条件保留，或 id 等于当前选中」——用整表过滤而不是「过滤后再插入」，
   * 这样保留下来的位置仍是原来的全局顺序，不会跳到列表首尾。
   */
  const visible = (): ItemView[] => {
    const selectedId = state.selectedId
    const matches = (item: ItemView): boolean => {
      if (item.id === selectedId) return true
      if (state.filter === 'unread') return item.readAt === undefined
      if (state.filter === 'starred') return item.starred
      return true
    }
    return state.items.filter(matches)
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
      const overview = await callRpc<Overview>(endpoint)
      applyOverview(overview)
      // 「按了刷新没反应」是本插件最早的体验投诉：界面从不说明发生了什么。
      // 这里如实区分——真抓了 / 被最小间隔节流（附上次完成时间）。
      if (endpoint === 'refresh') {
        const stamp = overview.refreshedAt === undefined ? '' : '（上次完成于 ' + relativeTime(overview.refreshedAt) + '）'
        set({
          notice: overview.refreshed === true
            ? '已重新抓取全部订阅源' + stamp
            : '距上次抓取不足最小间隔，本次未抓取' + stamp + ' —— 间隔可在 Config.minRefreshIntervalMs 调整（默认 10 分钟）',
        })
      }
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

  /**
   * v：用系统浏览器打开原站（新标签页）。
   *
   * **打开即视为已读**（用户 2026-10-06 定）：与内置详情页 `V`、列表点击三条路径保持一致——
   * 同一类动作（打开条目）语义相同，否则会出现「内置打开算已读、外部打开不算」这种只能靠
   * 读源码才发现的差异。GR 里的 `v`（view original）同样是阅读动作，不与已读语义冲突。
   */
  const openSelected = (): void => {
    const item = visible().find((entry) => entry.id === state.selectedId)
    if (item === undefined || item.link === '') return
    window.open(item.link, '_blank', 'noopener')
    void markRead(item.id)
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

  /**
   * 正文页的唯一真相来源：`article.itemId`。
   *
   * 这条路径同时负责：把该条目标已读（B1：显示即打开）、拉正文、按可嵌性决定默认视图。
   * ⚠️ 界面上任何地方都不要再从 `selectedId` 反推正文页内容——曾经链接取自 selectedId、
   * 内容取自 article.itemId，两者在"切换文章"时必然错位（iframe 载入新链接、可嵌性却来自旧站）。
   *
   * 先走宿主缓存（第二次打开不跑网络）；失败原因原样显示，不编造内容。
   */
  const loadArticle = async (itemId: string): Promise<void> => {
    const item = state.items.find((entry) => entry.id === itemId)
    if (item === undefined || item.link === '') return
    set({ view: 'article', selectedId: item.id, article: { itemId: item.id, loading: true } })
    void markRead(item.id)
    try {
      const result = await callRpc<ArticlePayload>('article', { itemId: item.id })
      // 期间用户可能已经换到别的条目：丢弃过期结果，避免把 A 的正文显示成 B 的
      if (state.article?.itemId !== item.id) return
      if (result.failure !== undefined) {
        set({ article: { itemId: item.id, loading: false, failure: result.failure } })
      } else {
        const frameable = result.frameable === true
        set({
          article: {
            itemId: item.id, loading: false, title: result.title,
            blocks: result.blocks,
            paragraphs: result.paragraphs ?? [],
            frameable,
            // 站点允许被嵌入就直接给原站原样页面，否则回落到抽取正文（决策在 article-view.ts）
            render: pickInitialRender(frameable),
          },
        })
      }
    } catch (error) {
      if (state.article?.itemId !== item.id) return
      set({ article: { itemId: item.id, loading: false, failure: error instanceof Error ? error.message : String(error) } })
    }
  }

  /** 打开当前选中的条目为正文（列表页的 V 走这里）。 */
  const openArticle = async (): Promise<void> => {
    const selectedId = state.selectedId
    if (selectedId === undefined) return
    await loadArticle(selectedId)
  }

  /**
   * 正文页里切上/下一条文章（B1：显示即打开，故也标已读）。
   *
   * - **在途防抖**：上一次抓取未结束时忽略后续按键，否则连按 j 会堆出一串请求（每条一次网络）；
   * - **边界停住**（不回列表）：避免"多按一下突然跳回列表"的意外；
   * - 作用范围是**当前过滤下的可见列表**，与列表页 j/k 一致（「未读」筛选下就不会跳到已读条目）。
   * @returns 是否真的切换了
   */
  /**
   * 正文页能否向该方向切换（**纯查询，不产生副作用**）。
   *
   * 单独抽出来的原因：界面上「上一条/下一条」按钮的禁用态必须与键盘的判断**完全一致**——
   * 各自算一遍迟早会出现「按钮灰着但键盘能切」或反之（本插件的标签/实现错位问题已有前例）。
   */
  const canStepArticle = (delta: number): boolean => {
    if (state.article?.loading === true) return false
    const list = visible()
    const index = list.findIndex((entry) => entry.id === state.article?.itemId)
    if (index < 0) return false
    return list[index + delta] !== undefined
  }

  const stepArticle = (delta: number): boolean => {
    if (!canStepArticle(delta)) return false
    const list = visible()
    const index = list.findIndex((entry) => entry.id === state.article?.itemId)
    const target = list[index + delta]
    if (target === undefined) return false
    void loadArticle(target.id)
    return true
  }

  const closeArticle = (): void => { set({ view: 'list' }) }

  /** 打开/关闭订阅管理视图。 */
  const toggleFeeds = (): void => { set({ view: state.view === 'feeds' ? 'list' : 'feeds' }) }

  /** 导出 OPML：拿到文本后交给浏览器下载（File System Access 不可用时退化为 blob 下载）。 */
  const exportOpml = async (): Promise<void> => {
    try {
      const result = await callRpc<OpmlExportResult>('opmlExport')
      const blob = new Blob([result.opml], { type: 'text/x-opml;charset=utf-8' })
      const href = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = 'dsh-rss-subscriptions.opml'
      anchor.click()
      URL.revokeObjectURL(href)
      set({ notice: '已导出 ' + result.feedCount + ' 个订阅（' + anchor.download + '）' })
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /** 导入 OPML：逐源抓取校验，坏源单独列出、不阻断其余（§3.1）。 */
  const importOpml = async (text: string): Promise<void> => {
    set({ feedsBusy: true, importReport: undefined })
    try {
      const report = await callRpc<OpmlImportResult>('opmlImport', { opml: text })
      set({ importReport: report, feedsBusy: false })
      await load('overview')
    } catch (failure) {
      set({ feedsBusy: false, error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /** 加单个源：同样先校验再落库，避免把网页当订阅。 */
  const addFeed = async (url: string): Promise<void> => {
    set({ feedsBusy: true, importReport: undefined })
    try {
      const report = await callRpc<OpmlImportResult>('addFeed', { url })
      set({ importReport: report, feedsBusy: false })
      await load('overview')
    } catch (failure) {
      set({ feedsBusy: false, error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /** 退订：连带删除该源条目（宿主侧执行），不可撤销，界面要二次确认。 */
  const removeFeed = async (url: string): Promise<void> => {
    try {
      const result = await callRpc<{ removed: number; items: number }>('removeFeed', { url })
      set({ notice: '已退订（连带删除 ' + result.items + ' 条条目）' })
      await load('overview')
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /**
   * 显式清理：删除「已读 + 未星标 + 早于阈值」的旧条目。
   *
   * 判据在宿主侧（`retention.ts` 的 selectCleanup，有单测）。客户端只负责发起与**如实回报**：
   * 删了 0 条也要说清是 0 条，而不是让用户以为按钮坏了。
   */
  const cleanup = async (): Promise<void> => {
    try {
      const result = await callRpc<CleanupResult>('cleanup')
      set({
        notice: result.deleted === 0
          ? '没有可清理的条目（只清「已读且未星标」且早于阈值的旧条目）'
          : '已清理 ' + result.deleted + ' 条旧条目，释放约 ' + Math.round(result.freedChars / 1024) + ' KB',
      })
      await load('overview')
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /** 在「抽取正文」与「原页」之间切换（仅站点允许被嵌时可切）。 */
  const toggleArticleRender = (): void => {
    const article = state.article
    if (article === undefined) return
    set({ article: { ...article, render: nextRender(article.render ?? 'reading', article.frameable === true) } })
  }

  return {
    subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    get, visible, load, markRead, selectRelative, openSelected, toggleStar, toggleRead, markAllRead, undoMarkAll,
    openArticle, closeArticle, toggleArticleRender, cleanup, stepArticle, canStepArticle,
    toggleFeeds, exportOpml, importOpml, addFeed, removeFeed,
    dismissNotice: (): void => { set({ notice: undefined }) },
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

function createReader(store: ReaderStore): () => ReactNode {
  return function Reader(): ReactNode {
    const state = useReaderStore(store)
    const [root, setRoot] = useState<HTMLDivElement | null>(null)
    const [listBox, setListBox] = useState<HTMLDivElement | null>(null)
    // 详情页阅读视图的滚动容器：空格翻页要作用在它上面
    const [articleBox, setArticleBox] = useState<HTMLDivElement | null>(null)
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

    // 跟随滚动：选中项超出可视区时才滚（j/k 走到边界后屏幕要跟着动——用户实测缺失）。
    // 位置计算在 src/list-scroll.ts 里，是纯函数且有单测；这里只负责量 DOM 并写入。
    useEffect(() => {
      if (listBox === null || state.view !== 'list') return
      const selected = state.selectedId
      if (selected === undefined) return
      const row = listBox.querySelector('[data-rss-row="' + selected + '"]')
      if (!(row instanceof HTMLElement)) return
      const target = nextScrollTop(listBox.scrollTop, listBox.clientHeight, row.offsetTop, row.offsetHeight)
      if (target !== listBox.scrollTop) listBox.scrollTop = target
    }, [listBox, state.selectedId, state.view])

    // 键盘流：挂在 document 上 + 输入框守卫。
    // 原实现挂在面板根节点并要求其持有焦点，导致「必须先点一下页面」才响应（用户实测）。
    // 挂 document 的代价是作用域变宽，因此用 isTypingTarget 挡住输入框/弹层；
    // 面板卸载时监听随 effect 清理一并移除，所以只有阅读器存在时才可能响应。
    // ⚠️ 不走 ctx.shortcuts：平台规则禁止无修饰键的绑定（configuration.ts:100 ——
    // modifiers 为空或全为 shift 即 modifier-required，register 会直接 throw，实测会炸掉整个 client 半）。
    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent): void => {
        if (isTypingTarget(event.target)) return
        // 宿主可能把非当前主栏面板保活在后台（ui-layout 的 retainMainPanels 就是这个意图）：
        // 面板没真正显示时不响应，否则你在对话里按 j/k 会去动一个看不见的列表。
        // 用 getClientRects().length 判可见：display:none 或未挂载时为 0，且不受定位方式影响。
        if (root === null || root.getClientRects().length === 0) return
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
        // 键位语义在 src/keys.ts（纯函数，宿主侧有单测）；这里只把动作落到 store 上
        // 空格的大小写不敏感，方向必须靠 shift 标志分辨（见 keys.ts 的单测）
        const action = resolveReaderKey(event.key, event.shiftKey)
        if (action === 'none') return
        const view = store.get().view
        const run = (act: () => void): void => { event.preventDefault(); act() }
        switch (action) {
          // 正文视图里 j/k 不移动：每次移动都意味着一次抓取，误按代价太高（Esc 回列表再移动）
          // j/k 按视图分流——同一个键始终是「换条目」，语义不因视图而变：
          //   列表页 → 移动选中（不标已读，用户 2026-10-06 定）
          //   正文页 → 切上/下一条文章（B1：显示即打开，故标已读；在途防抖、边界停住）
          case 'next':
            if (view === 'article') { run(() => { store.stepArticle(1) }); break }
            if (view !== 'list') return
            run(() => store.selectRelative(1))
            break
          case 'prev':
            if (view === 'article') { run(() => { store.stepArticle(-1) }); break }
            if (view !== 'list') return
            run(() => store.selectRelative(-1))
            break
          // Google Reader 语义：o 展开/折叠 + 标已读（已读的唯一自动触发点，另有显式的 m）
          case 'expand':
            // 只在列表页有意义：正文页按 o 曾会展开"背后那个看不见的列表"里的条目，
            // 表现为按 Esc 回列表后发现某行莫名展开（既存缺陷，2026-10-06 修）
            if (view !== 'list') return
            run(() => {
              const selected = store.get().selectedId
              if (selected === undefined) return
              setExpanded((current) => (current === selected ? undefined : selected))
              void store.markRead(selected)
            })
            break
          // n/p = 扫视：滚动视野但**不改变选中**（GR 原义：scroll without viewing）
          // 列表页滚列表，详情页滚文章——两处都是「只看不动」
          case 'scanNext':
          case 'scanPrev': {
            const direction: 1 | -1 = action === 'scanNext' ? 1 : -1
            const box = view === 'list' ? listBox : view === 'article' ? articleBox : null
            if (box === null) return
            run(() => {
              const row = box.querySelector('[data-rss-row]')
              const rowHeight = row instanceof HTMLElement ? row.offsetHeight : 48
              box.scrollTop = scanTop(box.scrollTop, rowHeight, box.scrollHeight - box.clientHeight, direction)
            })
            break
          }
          // 空格 / shift+空格 = 按一屏翻页（列表与详情页都适用）
          case 'pageDown':
          case 'pageUp': {
            const direction: 1 | -1 = action === 'pageDown' ? 1 : -1
            const box = view === 'list' ? listBox : view === 'article' ? articleBox : null
            if (box === null) return
            run(() => {
              box.scrollTop = pageTop(box.scrollTop, box.clientHeight, box.scrollHeight - box.clientHeight, direction)
            })
            break
          }
          case 'openExternal': run(() => store.openSelected()); break
          case 'openArticle': if (view !== 'list') return; run(() => { void store.openArticle() }); break
          case 'toggleRender': if (view !== 'article') return; run(() => store.toggleArticleRender()); break
          case 'manageFeeds': run(() => store.toggleFeeds()); break
          // Esc：从正文回到列表；列表态下不拦截（不抢弹层的 Esc）
          // Esc：正文 → 列表；订阅管理 → 列表。列表态不拦截（不抢弹层的 Esc）
          case 'back':
            if (view === 'article') { event.preventDefault(); store.closeArticle(); break }
            if (view === 'feeds') { event.preventDefault(); store.toggleFeeds(); break }
            return
          case 'star': run(() => { void store.toggleStar() }); break
          case 'toggleRead': run(() => { void store.toggleRead() }); break
          case 'markAll': run(() => { void store.markAllRead() }); break
          default: return
        }
      }
      document.addEventListener('keydown', onKeyDown)
      return () => { document.removeEventListener('keydown', onKeyDown) }
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
          <span style={{ fontSize: 11, opacity: 0.55 }}>j/k 移动 · n/p 扫视 · 空格翻页 · o 展开并已读 · V 读正文 · v 开原站 · s 星标 · m 已读 · A 全部 · F 订阅</span>
          <button type="button" className="dsh-rss-btn"
            title="订阅管理：导入/导出 OPML、加源、退订（F 键）"
            onClick={() => store.toggleFeeds()}>订阅</button>
          <button type="button" className="dsh-rss-btn" disabled={state.loading}
            title="删除「已读且未星标」的旧条目（阈值可在 Config.cleanupAfterDays 调，默认 30 天）"
            onClick={() => {
              if (window.confirm('清理已读的旧条目？\n\n只删除「已读 + 未星标 + 早于阈值」的条目，星标与未读的都会保留。此操作不可撤销。')) {
                void store.cleanup()
              }
            }}>清理旧条目</button>
          <button type="button" className="dsh-rss-btn" disabled={state.loading}
            title="重新抓取所有订阅源（受最小间隔节流）"
            onClick={() => { void store.load('refresh') }}>
            <RefreshIcon spinning={slowLoading} />
            {slowLoading ? '刷新中…' : '刷新'}
          </button>
        </div>
        {slowLoading && <div className="dsh-rss-bar" aria-hidden="true" />}

        {state.error !== undefined && <div style={{ padding: '8px 20px', color: '#c0392b' }}>{state.error}</div>}
        {state.notice !== undefined && (
          <div style={{ padding: '6px 20px', fontSize: 12, opacity: 0.8 }}>
            {state.notice}
            <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
              style={{ marginLeft: 8 }} onClick={() => store.dismissNotice()}>知道了</button>
          </div>
        )}
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

        {state.view === 'feeds' && (
          <FeedsView
            feeds={state.feeds}
            busy={state.feedsBusy}
            report={state.importReport}
            notice={state.notice}
            onImport={(text) => { void store.importOpml(text) }}
            onExport={() => { void store.exportOpml() }}
            onAdd={(url) => { void store.addFeed(url) }}
            onRemove={(url) => { void store.removeFeed(url) }}
            onBack={() => store.toggleFeeds()}
          />
        )}

        {state.view === 'article' && (
          <ArticleView
            article={state.article}
            link={state.items.find((entry) => entry.id === state.article?.itemId)?.link}
            onBack={() => store.closeArticle()}
            onToggleRender={() => store.toggleArticleRender()}
            setBox={setArticleBox}
            canPrev={store.canStepArticle(-1)}
            canNext={store.canStepArticle(1)}
            onPrev={() => { store.stepArticle(-1) }}
            onNext={() => { store.stepArticle(1) }}
          />
        )}

        <div ref={setListBox} style={{
          // position:relative 是必需的：row.offsetTop 以最近的定位祖先为参照，
          // 少了它量到的是相对页面/body 的位置，滚动计算会整体偏掉。
          position: 'relative',
          flex: 1, minHeight: 0, overflowY: 'auto',
          display: state.view === 'list' ? 'block' : 'none',
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
              <div key={item.id} data-rss-row={item.id}
                style={{ borderBottom: '1px solid color-mix(in srgb, currentColor 8%, transparent)' }}>
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
                        {(() => {
                          const paragraphs = toParagraphs(item.summary)
                          const bodyText = paragraphs.join(' ').trim()
                          // 「勉强算有正文」不该冒充正文：像 HN 那样 feed 里只有一串 Comments 链接时，
                          // 剥完标签只剩几个字符——与其显示一行孤零零的 "Comments"，不如如实说明。
                          if (bodyText.length < MIN_BODY_CHARS) {
                            return (
                              <span style={{ display: 'block', opacity: 0.7 }}>
                                {paragraphs.length === 0
                                  ? '（此源未提供正文，点下面到原站阅读）'
                                  : '（此源只提供标题与外链，正文在原站）'}
                              </span>
                            )
                          }
                          return paragraphs.map((paragraph, index) => (
                            <span key={index} style={{ display: 'block', margin: index === 0 ? '0' : '0.6em 0 0' }}>{paragraph}</span>
                          ))
                        })()}
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

/**
 * 订阅管理视图：导入 OPML（逐源校验、坏源逐条列出）、导出、加源、退订。
 *
 * 设计取舍：**坏源报告必须逐条可读**（§3.1 要求「坏源单独标注」），而不是只报「3 个失败」——
 * 用户需要知道具体是哪个源、为什么失败，才能决定改 URL 还是放弃。
 */
function FeedsView({ feeds, busy, report, notice, onImport, onExport, onAdd, onRemove, onBack }: {
  feeds: FeedView[]
  busy: boolean
  report: OpmlImportResult | undefined
  notice: string | undefined
  onImport: (text: string) => void
  onExport: () => void
  onAdd: (url: string) => void
  onRemove: (url: string) => void
  onBack: () => void
}): ReactNode {
  const [draft, setDraft] = useState('')
  const [fileError, setFileError] = useState<string | undefined>(undefined)

  const pickFile = (event: { target: { files?: ArrayLike<File> | null; value?: string } }): void => {
    const file = event.target.files?.[0]
    if (file === undefined || file === null) return
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      if (text.trim() === '') { setFileError('文件是空的'); return }
      setFileError(undefined)
      onImport(text)
    }
    reader.onerror = () => { setFileError('读取文件失败：' + String(reader.error ?? '未知原因')) }
    reader.readAsText(file)
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 22px 24px', fontSize: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" onClick={onBack}>← 返回列表（Esc）</button>
        <strong style={{ fontSize: 15 }}>订阅管理</strong>
        <span style={{ opacity: 0.6, fontSize: 12 }}>{feeds.length} 个源</span>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <label className="dsh-rss-btn" style={{ cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.55 : 1 }}>
          导入 OPML…
          <input type="file" accept=".opml,.xml,text/xml,text/x-opml" disabled={busy}
            style={{ display: 'none' }} onChange={pickFile} />
        </label>
        <button type="button" className="dsh-rss-btn" disabled={busy || feeds.length === 0} onClick={onExport}>导出 OPML</button>
        <span style={{ flex: 1 }} />
        <input value={draft} placeholder="或直接粘贴 feed 地址后回车" disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // 本插件的全局快捷键挂在 document 上，输入框里的键不该被它截走；
            // 这里的 stopPropagation 是**双保险**（守卫已按 target 判断，但回车提交不该外泄）
            if (event.key === 'Enter' && draft.trim() !== '') {
              event.stopPropagation()
              onAdd(draft.trim())
              setDraft('')
            }
          }}
          style={{ flex: '0 1 320px', fontSize: 13, padding: '4px 8px' }} />
      </div>

      {busy && <div style={{ opacity: 0.75, marginBottom: 8 }}>正在逐源抓取校验…（并发受限，源多时需要一会儿）</div>}
      {fileError !== undefined && <div style={{ color: '#c0392b', marginBottom: 8 }}>{fileError}</div>}
      {notice !== undefined && <div style={{ opacity: 0.85, marginBottom: 8 }}>{notice}</div>}

      {report !== undefined && (
        <div style={{ marginBottom: 14, padding: '10px 12px', background: 'color-mix(in srgb, currentColor 6%, transparent)', borderRadius: 6 }}>
          <div style={{ marginBottom: 6 }}>
            导入结果：新增 <strong>{report.added}</strong> 个，已存在 {report.existed} 个，
            校验失败 <strong style={{ color: report.failed.length > 0 ? '#c0392b' : 'inherit' }}>{report.failed.length}</strong> 个，
            文件内跳过 {report.skipped.length} 项
          </div>
          {report.failed.length > 0 && (
            <div style={{ fontSize: 12, color: '#c0392b' }}>
              <div style={{ marginBottom: 2 }}>以下源校验失败（未加入订阅，其余不受影响）：</div>
              {report.failed.map((row) => (
                <div key={row.url} style={{ wordBreak: 'break-all' }}>· {row.url} —— {row.reason}</div>
              ))}
            </div>
          )}
          {report.skipped.length > 0 && (
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
              <div style={{ marginBottom: 2 }}>文件里被跳过的条目：</div>
              {report.skipped.map((row, index) => (
                <div key={index}>· {row.title ?? '(无标题)'} —— {row.reason}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ borderTop: '1px solid color-mix(in srgb, currentColor 12%, transparent)' }}>
        {feeds.length === 0 && <div style={{ padding: '12px 0', opacity: 0.7 }}>还没有订阅源。可以用上面的「导入 OPML…」。</div>}
        {feeds.map((feed) => (
          <div key={feed.id} style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
            borderBottom: '1px solid color-mix(in srgb, currentColor 8%, transparent)',
          }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block' }}>{feed.title ?? feed.id}</span>
              <span style={{ display: 'block', fontSize: 11, opacity: 0.6, wordBreak: 'break-all' }}>
                {feed.id}{feed.lastFailure !== undefined ? ' · 上次失败：' + feed.lastFailure : ''}
              </span>
            </span>
            <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
              title="退订并删除该源的全部条目（不可撤销）"
              onClick={() => {
                if (window.confirm('退订该源并删除它的全部条目？\n\n' + feed.id + '\n\n此操作不可撤销。')) onRemove(feed.id)
              }}>退订</button>
          </div>
        ))}
      </div>
    </div>
  )
}

/** 阅读器内的正文视图（D 方案）：段落由宿主抽取后回传，这里只做排版。 */
/**
 * 段落判定：含换行的段落来自 <pre>（宿主抽取时保留内部换行）⇒ 按代码块渲染。
 * 这是为了解决「代码全变样」——等宽字体 + 保留缩进 + 横向可滚动，而不是当普通文字折行。
 */
function isCodeBlock(paragraph: string): boolean {
  return paragraph.includes('\n')
}

/** 阅读器内的正文视图（D 方案）：默认抽取正文，站点允许时可切「原站视图」看原样页面。 */
/**
 * 单个正文块的渲染。
 *
 * 之所以要分类型：用户反馈「图片不显示、样式变形」——根因是抽取层过去只回传纯文本段落，
 * 图片被整块丢弃、标题/列表/引用的语义也没了，客户端只能一律当段落排版。
 * 这里按块类型给语义化样式（图片限宽、列表留符号、引用加左边线、标题分级字号）。
 */
function ArticleBlockView({ block }: { block: Record<string, unknown> }): ReactNode {
  const kind = typeof block['kind'] === 'string' ? block['kind'] : 'p'
  const text = typeof block['text'] === 'string' ? block['text'] : ''

  if (kind === 'img') {
    const src = typeof block['src'] === 'string' ? block['src'] : ''
    if (src === '') return null
    const alt = typeof block['alt'] === 'string' ? block['alt'] : ''
    const caption = typeof block['caption'] === 'string' ? block['caption'] : ''
    return (
      <figure style={{ margin: '0 0 1.3em' }}>
        {/* loading=lazy：长文里的图片很多，一次性加载会拖慢首屏 */}
        <img src={src} alt={alt} loading="lazy"
          style={{ display: 'block', maxWidth: '100%', height: 'auto', borderRadius: 6 }} />
        {caption !== '' && (
          <figcaption style={{ fontSize: 13, opacity: 0.65, marginTop: 6, textAlign: 'center' }}>{caption}</figcaption>
        )}
      </figure>
    )
  }

  if (kind === 'pre') {
    return (
      <pre style={{
        margin: '0 0 1.1em', padding: '10px 12px', overflowX: 'auto',
        borderRadius: 6, fontSize: 13, lineHeight: 1.6,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        background: 'color-mix(in srgb, currentColor 6%, transparent)',
      }}>{text}</pre>
    )
  }

  if (kind === 'h') {
    const level = typeof block['level'] === 'number' ? block['level'] : 2
    const size = level <= 1 ? 22 : level === 2 ? 19 : level === 3 ? 17 : 16
    return (
      <div style={{ fontSize: size, fontWeight: 600, lineHeight: 1.4, margin: '1.4em 0 0.5em' }}>{text}</div>
    )
  }

  if (kind === 'list') {
    const ordered = block['ordered'] === true
    const items = Array.isArray(block['items']) ? block['items'] : []
    const ListTag = ordered ? 'ol' : 'ul'
    return (
      <ListTag style={{ margin: '0 0 1.1em', paddingLeft: '1.5em' }}>
        {items.map((entry, index) => <li key={index} style={{ marginBottom: '0.3em' }}>{String(entry)}</li>)}
      </ListTag>
    )
  }

  if (kind === 'quote') {
    return (
      <blockquote style={{
        margin: '0 0 1.1em', padding: '0.2em 0 0.2em 1em',
        borderLeft: '3px solid color-mix(in srgb, currentColor 25%, transparent)',
        opacity: 0.9,
      }}>{text}</blockquote>
    )
  }

  return <p style={{ margin: '0 0 1.05em' }}>{text}</p>
}

function ArticleView({ article, link, onBack, onToggleRender, setBox, canPrev, canNext, onPrev, onNext }: {
  article: ArticleState | undefined
  link: string | undefined
  onBack: () => void
  onToggleRender: () => void
  /** 阅读视图滚动容器的 ref 回调：空格翻页要作用在它上面（跨组件只能传进来） */
  setBox: (node: HTMLDivElement | null) => void
  /** 上/下一条是否可切（与键盘共用同一判定，见 canStepArticle） */
  canPrev: boolean
  canNext: boolean
  onPrev: () => void
  onNext: () => void
}): ReactNode {
  // 新缓存是结构化块；老缓存只有纯文本段落——把后者包成 p 块，走同一条渲染路径
  const blocks: Array<Record<string, unknown>> = article?.blocks !== undefined
    ? article.blocks
    : (article?.paragraphs ?? []).map((text) => ({ kind: 'p', text }))
  const original = article?.render === 'original'
  const frameable = article?.frameable === true

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px',
        borderBottom: '1px solid color-mix(in srgb, currentColor 12%, transparent)',
      }}>
        <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost" onClick={onBack}>← 返回列表（Esc）</button>
        <span style={{ flex: 1 }} />
        {/* 上/下一条：焦点进入 iframe 后键盘就收不到了（浏览器限制），这两个按钮是**唯一可用的切换手段**。
            标签里的键名与实际键位一致：详情页 j = 下一条、k = 上一条（n/p 是扫视，不换文章）。 */}
        <button type="button" className="dsh-rss-btn" disabled={!canPrev}
          title="上一条（k）" onClick={onPrev}>↑ 上一条</button>
        <button type="button" className="dsh-rss-btn" disabled={!canNext}
          title="下一条（j）" onClick={onNext}>↓ 下一条</button>
        <button type="button" className="dsh-rss-btn dsh-rss-btn--ghost"
          disabled={!frameable || article?.loading === true}
          title={frameable
            ? '在原站原样页面与抽取正文之间切换（R 切换；本页可直接按 R）'
            : '该站点通过 X-Frame-Options / CSP 禁止被嵌入，只能看抽取版或去原站'}
          onClick={onToggleRender}>
          {original ? '阅读视图（R）' : '原站视图（R）'}
        </button>
        {link !== undefined && link !== '' && (
          <a href={link} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>打开原站 ↗</a>
        )}
      </div>

      {article === undefined || article.loading ? (
        <div style={{ padding: '12px 22px', opacity: 0.7 }}>正在抓取并抽取原站正文…</div>
      ) : article.failure !== undefined ? (
        <div style={{ padding: '12px 22px', color: '#c0392b' }}>
          没能取到正文：{article.failure}
          <div style={{ opacity: 0.7, marginTop: 6, fontSize: 12 }}>可以按 Esc 回列表，或点右上角去原站阅读。</div>
        </div>
      ) : original && link !== undefined ? (
        // 原站视图：浏览器内嵌整页，样式/代码/交互全是原样（已被 X-Frame-Options 放行的站点才可用）
        <>
          <div style={{ padding: '4px 20px', fontSize: 11, opacity: 0.6 }}>
            原站视图：页面内的按键由原站接管，本插件的快捷键需先点回面板——或直接用上方按钮切回阅读视图
          </div>
          <iframe
            src={link}
            title={article.title ?? '原站视图'}
            style={{ flex: 1, minHeight: 0, width: '100%', border: 'none', background: '#fff' }}
          />
        </>
      ) : (
        // 阅读视图：限宽 + 加大行高（长文可读性）；每种块由 ArticleBlockView 给语义化样式
        <div ref={setBox} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 24px 32px' }}>
          <div style={{ maxWidth: 760, margin: '0 auto', fontSize: 16, lineHeight: 1.85 }}>
            {article.title !== undefined && (
              <div style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.4, marginBottom: 18 }}>{article.title}</div>
            )}
            {blocks.map((block, index) => <ArticleBlockView key={index} block={block} />)}
          </div>
        </div>
      )}
    </div>
  )
}

/** 侧栏折叠按钮里的未读数（非交互）。 */
function Badge({ store }: { store: ReaderStore }): ReactNode {
  const state = useReaderStore(store)
  if (state.unread === 0) return null
  return <span title={state.unread + ' 条未读'} style={{ fontSize: 10 }}>{state.unread > 99 ? '99+' : state.unread}</span>
}

export function apply(ctx: ClientContext): void {
  const store = createReaderStore()
  const Reader = createReader(store)

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