/**
 * 阅读器的状态与数据通道（2026-10-07 从 index.tsx 拆出）。
 *
 * 这里只有状态与副作用，没有任何 JSX：对组件而言它是一个深模块 —— 组件只通过 get()/subscribe()
 * 与那几个动作方法使用它，不关心数据怎么来。拆出的直接理由见评审：原文件 1169 行、同时承担状态、
 * 列表、正文、订阅管理与键盘接线，任一改动都要动同一个文件。
 */
import { useEffect, useState } from 'react'
import { ROUTE_PATH, recencyOf, type ArticlePayload, type CleanupResult, type FeedView, type ItemView, type OpmlExportResult, type OpmlImportResult, type Overview, type RpcResult } from '../shared.js'

export type Filter = 'all' | 'unread' | 'starred'

/**
 * 「全部标为已读」的时间范围（规格 §3.3 的 panic button：可选择「只把**早于**某个时间范围的条目标为
 * 已读」）。默认 all = 全量，也就是改动前的行为 —— 不选就什么都没变。
 */
export type MarkAllRange = 'all' | 'day' | 'week' | 'month'
const RANGE_DAYS: Record<MarkAllRange, number | undefined> = { all: undefined, day: 1, week: 7, month: 30 }

/** 按需正文的运行态（D 方案：V 进正文、Esc 回列表）。 */
export interface ArticleState {
  itemId: string
  loading: boolean
  title?: string
  /** 结构化正文块（新）；与 paragraphs 互斥——后者是老缓存里的纯文本形态 */
  blocks?: Array<Record<string, unknown>>
  paragraphs?: string[]
  failure?: string
  /**
   * 站点是否允许被嵌入。**2026-10-08 起不再决定任何视图**：正文只走抽取视图，这个字段留作诊断
   * （能在界面/日志里说明「这个站禁嵌」）。真正内嵌原站页面的路径已整条删除，理由见 article-pane.tsx。
   */
  frameable?: boolean
}

export interface ReaderState {
  items: ItemView[]
  feeds: FeedView[]
  unread: number
  filter: Filter
  selectedId: string | undefined
  loading: boolean
  error: string | undefined
  /** 刚被「全部标记已读」的条目，供短时撤销 */
  /** 一键已读的撤销条。窗口到期由 armUndoExpiry 的定时器负责，所以这里不需要存时间戳。 */
  undo: { ids: string[] } | undefined
  /** 当前视图：列表 / 正文 / 订阅管理（订阅管理同样在主栏内切换，见 handoff §19） */
  view: 'list' | 'article' | 'feeds'
  /**
   * 条目流的**视图密度**（GR 的两视图）：expanded 含条目描述/正文摘录，list 只有标题行。
   * 注意与上面的 view 是两条正交的轴：view 决定「看哪个面板」，layout 决定「条目流怎么排」。
   */
  layout: 'list' | 'expanded'
  /** 「全部标为已读」的时间范围，见 MarkAllRange */
  markAllRange: MarkAllRange
  /** 是否显示未读计数（规格 §5 不变量 8：**未读计数可隐藏**）。默认显示 = 既有行为。 */
  showUnread: boolean
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
export function relativeTime(iso: string | undefined): string {
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
    view: 'list', layout: 'list', markAllRange: 'all', showUnread: true, article: undefined, notice: undefined,
    importReport: undefined, feedsBusy: false,
  }
  const listeners = new Set<() => void>()
  const emit = (): void => { for (const listener of listeners) listener() }
  const set = (patch: Partial<ReaderState>): void => { state = { ...state, ...patch }; emit() }

  /**
   * 撤销窗口的定时器。
   *
   * 2026-10-07 修：原先只往 state.undo.until 写了个时间戳，全仓没有任何地方读它，于是
   * 「5 秒撤销窗口」名存实亡——撤销条一直挂着，想撤多久撤多久（README 承诺的是 5 秒）。
   */
  let undoExpiry: ReturnType<typeof setTimeout> | undefined
  const clearUndoExpiry = (): void => {
    if (undoExpiry !== undefined) {
      clearTimeout(undoExpiry)
      undoExpiry = undefined
    }
  }
  const armUndoExpiry = (): void => {
    clearUndoExpiry()
    undoExpiry = setTimeout(() => {
      undoExpiry = undefined
      set({ undo: undefined })
    }, UNDO_WINDOW_MS)
  }
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

  /**
   * 切换「保持未读」（规格 §3.3）。
   *
   * 接收显式 id：这条链接挂在每个条目下方，点的那一行未必是当前选中的那一行。
   */
  const toggleKeepUnread = async (itemId: string): Promise<void> => {
    const item = state.items.find((entry) => entry.id === itemId)
    if (item === undefined) return
    const next = item.keptUnread !== true
    patchItem(itemId, { keptUnread: next })
    try {
      await callRpc('toggleKeepUnread', { itemId })
    } catch (failure) {
      patchItem(itemId, { keptUnread: item.keptUnread })
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
    // **保持未读的条目要活下来**（规格 §3.3）——这正是 kept-unread 的存在理由。本地乐观更新与请求
    // 两处都要跳过；宿主侧也会按 skipKept 再挡一次（客户端列表只是快照）。
    const days = RANGE_DAYS[state.markAllRange]
    const before = days === undefined ? undefined : new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
    const ids = visible()
      .filter((item) => item.readAt === undefined && item.keptUnread !== true)
      // 范围阈值同样判两次：这里决定乐观更新与名单，宿主那边再按 before 挡一次
      .filter((item) => before === undefined || recencyOf(item) < before)
      .map((item) => item.id)
    if (ids.length === 0) return
    const stamp = new Date().toISOString()
    set({
      items: state.items.map((item) => (ids.includes(item.id) ? { ...item, readAt: stamp } : item)),
      unread: Math.max(0, state.unread - ids.length),
      undo: { ids },
    })
    armUndoExpiry()
    try {
      const result = await callRpc<{ unread: number }>('markRead', { itemIds: ids, skipKept: true, before })
      set({ unread: result.unread })
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  const undoMarkAll = async (): Promise<void> => {
    const undo = state.undo
    if (undo === undefined) return
    clearUndoExpiry()
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
  /** 切视图密度。默认 list = 本插件既有的紧凑行为，所以切成 expanded 是「多显示」而不是改默认。 */
  const setLayout = (layout: ReaderState['layout']): void => { set({ layout }) }

  /** 切「全部标为已读」的时间范围。 */
  const setMarkAllRange = (markAllRange: MarkAllRange): void => { set({ markAllRange }) }

  /** 隐藏 / 显示未读计数（规格 §5 不变量 8）。只影响呈现，不动数据。 */
  const setShowUnread = (showUnread: boolean): void => { set({ showUnread }) }

  /**
   * 刷新未读计数（规格 §5 不变量 8 的 r 键）。
   *
   * 走的是 overview（宿主把已收集的条目与计数回给我们），**不触发抓取** —— 这正是规格不变量 1
   * 的区分：「Refresh 只更新本地视图，抓取由服务端按自己的节奏做」。
   */
  const refreshCount = async (): Promise<void> => { await load('overview') }

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

  return {
    subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    get, visible, load, markRead, selectRelative, openSelected, toggleStar, toggleKeepUnread, toggleRead, markAllRead, undoMarkAll,
    setLayout, setMarkAllRange, setShowUnread, refreshCount,
    openArticle, closeArticle, cleanup, stepArticle, canStepArticle,
    toggleFeeds, exportOpml, importOpml, addFeed, removeFeed,
    dismissNotice: (): void => { set({ notice: undefined }) },
    setFilter: (filter: Filter): void => { set({ filter }); const list = filter === 'all' ? state.items : state.items.filter((i) => (filter === 'unread' ? i.readAt === undefined : i.starred)); set({ selectedId: list[0]?.id }) },
    select: (itemId: string): void => { set({ selectedId: itemId }) },
  }
}

export type ReaderStore = ReturnType<typeof createReaderStore>

/** 「全部标记已读」的撤销窗口（跟着 undo 状态走，所以在 store 这一侧）。 */
const UNDO_WINDOW_MS = 5000

/** 订阅 store 并强制重渲染。 */
export function useReaderStore(store: ReaderStore): ReaderState {
  const [, force] = useState(0)
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store])
  return store.get()
}

