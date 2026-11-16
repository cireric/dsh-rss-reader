/**
 * 阅读器的状态与数据通道（2026-10-07 从 index.tsx 拆出）。
 *
 * 这里只有状态与副作用，没有任何 JSX：对组件而言它是一个深模块 —— 组件只通过 get()/subscribe()
 * 与那几个动作方法使用它，不关心数据怎么来。拆出的直接理由见评审：原文件 1169 行、同时承担状态、
 * 列表、正文、订阅管理与键盘接线，任一改动都要动同一个文件。
 */
import { useEffect, useState } from 'react'
import { DEFAULT_READING_PREFERENCES, httpUrlOrEmpty, ROUTE_PATH, recencyOf, sanitizeViewPreferences, type ArticlePayload, type CleanupResult, type DiscoveryResult, type Endpoint, type FeedView, type FolderView, type ItemView, type OpmlExportResult, type OpmlImportResult, type Overview, type RpcResult, type SearchPage, type SearchQuery, type TagView, type DuplicateHintView, type ReadingPreferences, type UnreadAccount, type ViewPreferences } from '../shared.js'
import { createAccountMirror } from './account-mirror.js'

export type Filter = 'all' | 'unread' | 'starred'

/**
 * 导航选中：虚拟视图（跨源聚合）或某个具体订阅源。
 *
 * 与 Filter 是**两条正交的轴**且叠加生效（源 × 过滤），不是二选一 —— 所以这里不引入
 * 第四个「当前视图」概念：view 看面板、layout 看密度、filter 看全局过滤、navSelection 看导航选中。
 */
export type NavSelection =
  | { kind: 'virtual' }
  | { kind: 'feed'; feedId: string }
  | { kind: 'folder'; folder: string }
  | { kind: 'tag'; tagId: string }

/**
 * 导航**光标**：键盘在左栏那一列里现在停在哪一行。
 *
 * 与 NavSelection 是**两件事**（规格 §2.4 把 shift+n/p「移动」与 shift+o「打开」写成两行）：
 *  - 光标 = 「我看到的高亮在哪」——纯的，**不改变**任何过滤结果、不影响 selectedId；
 *  - navSelection = 「此刻哪个视图真的在生效」——只有「打开」（shift+o / 鼠标点击）才改它。
 *
 * 为什么必须拆开：第一版让 navSelection 同时兼任两者，于是 shift+n 走一行**就等于**打开它，
 * shift+o 实测只剩「取消」——规格 §2.4 的两行行为塌缩成一行，规格无从满足（2026-10-10 返工）。
 *
 * 行序与左栏渲染逐行对应：虚拟视图三行在前、订阅源在后（见 navRowsOf）。
 */
export type NavCursor =
  | { kind: 'filter'; filter: Filter }
  | { kind: 'feed'; feedId: string }
  | { kind: 'folder'; folder: string }
  | { kind: 'tag'; tagId: string }

/**
 * 虚拟视图三行：全部 / 未读 / 星标。
 *
 * 顶栏那组 filter 按钮与左栏导航的三行是**同一份东西**（左栏是顶栏的镜像），所以这个顺序只定义
 * 在这里一处：键盘光标的行序、顶栏按钮的顺序、左栏渲染的顺序都读它。三处各写一份迟早错位。
 */

import { createSearchActions } from './search-actions.js'
import { createTagActions } from './tag-actions.js'
import {
  navRowsOf, navCursorKey, nextExpandedOf, memorableSelectionOf, sameNavSelection, selectionExists, VIRTUAL_VIEWS,
} from './nav-model.js'
export { navRowsOf, navCursorKey, nextExpandedOf, VIRTUAL_VIEWS }

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
  /** 正文内容标识（M5 02）：进度按 (itemId, contentVersion) 记；缺省 = 老缓存/失败，不记进度 */
  contentVersion?: string
  /** 打开时该恢复到的位置（0..1）；缺省 = 从头读 */
  restoreRatio?: number
  /**
   * 站点是否允许被嵌入。**2026-10-08 起不再决定任何视图**：正文只走抽取视图，这个字段留作诊断
   * （能在界面/日志里说明「这个站禁嵌」）。真正内嵌原站页面的路径已整条删除，理由见 article-pane.tsx。
   */
  frameable?: boolean
}

export interface ReaderState {
  items: ItemView[]
  feeds: FeedView[]
  /** 文件夹目录（含空目录）。左栏行序、管理面板与文件夹范围都以它为准。 */
  folders: FolderView[]
  /** 标签目录（含空标签）。左栏筛选与编辑器的名称来源。 */
  tags: TagView[]
  unread: number
  filter: Filter
  selectedId: string | undefined
  loading: boolean
  error: string | undefined
  /** 刚被「全部标记已读」的条目，供短时撤销 */
  /** 一键已读的撤销条。窗口到期由 armUndoExpiry 的定时器负责，所以这里不需要存时间戳。 */
  undo: { ids: string[] } | undefined
  /** 当前视图：列表 / 正文 / 订阅管理（订阅管理同样在主栏内切换） */
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
  /**
   * 最近一次「发现候选」的结果（undefined = 没在挑）。它是**待确认**状态：候选在这里只是
   * 被展示，落库要等用户点某一条走 addFeed —— 取消就是清回 undefined，没有别的副作用。
   */
  discovery: DiscoveryResult | undefined
  /** 订阅管理里的忙碌标记（导入要逐源抓取，可能数秒） */
  feedsBusy: boolean
  /** 一次性提示（如清理结果）：显示后由用户下一个动作清掉，不设定时器 */
  notice: string | undefined
  article: ArticleState | undefined
  /** 导航选中（虚拟视图 / 某个具体源）。与 filter 叠加生效，见 NavSelection。 */
  navSelection: NavSelection
  /** 导航**光标**（左栏键盘高亮所在行）。与 navSelection 是两件事，见 NavCursor。 */
  navCursor: NavCursor
  foldedFolders: ReadonlySet<string>
  /**
   * 每源未读数（feedId → 该源未读数），来自 Overview.perFeedUnread（左栏角标的数据来源）。
   *
   * 必须由宿主下发而非从 items 派生：items 按 maxItemsShown 截断，派生出的各源之和会与
   * 顶栏总数对不上 —— 左栏角标靠「各源之和 === unread」这条守恒式自洽。
   */
  perFeedUnread: Record<string, number>
  /** 左栏显隐（任务 6 的 u 键接线用；默认显示，避免改动既有布局）。 */
  navVisible: boolean
  /**
   * 正文排版（M5 01）：字号 / 栏宽 / 主题。与上面的视图记忆同住一份 viewPreferences ——
   * 它是「上次看到哪儿」的同一族，不是另一套存储。
   */
  reading: ReadingPreferences
  /**
   * 跨源重复提示（M5 03）：itemId → 别的源里的同链接条目。
   *
   * 只在这一屏加载完之后**批量查一次**（不是每次渲染查）：这份 map 是查询结果，不是判据 ——
   * 判据在宿主（duplicates.ts 的 linkKeyOf + 跨源过滤），客户端只负责显示。
   */
  duplicates: Record<string, DuplicateHintView['others']>
  /**
   * 续页游标（Overview.nextCursor，keyset）：**原样**回带给下一次 overview 调用。
   *
   * 客户端不解释它的内容（格式 `"<recency>|<id>"` 由宿主定义，见 src/shared.ts 的 decodeCursor）——
   * 它只是一张「我读到哪儿了」的票据。缺省 = 已经到底，界面不再给「加载更多」的入口。
   */
  nextCursor: string | undefined
  /** 续页在途（防连点堆请求：每次请求都要过一次 SQL + 一次 feeds 文件读）。 */
  loadingMore: boolean
  search?: SearchQuery
  searchRevision: number
}

/**
 * 调一个端点并解信封；失败抛出 `code: message`，由面板渲染。
 *
 * endpoint 收的是 shared.ts 的 Endpoint（= ENDPOINT_NAMES 派生）：拼错名字从「运行时收一个
 * unknown-endpoint」变成**编译错误**。这是本文件与宿主之间唯一的那条 seam，值得有类型。
 */
async function browserRpc<T>(endpoint: Endpoint, payload?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(ROUTE_PATH, {
    method: 'POST',
    ...(signal === undefined ? {} : { signal }),
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
 * 阅读器状态与动作。
 *
 * 刻意 `export`：客户端行为在浏览器里跑，我无法自测；导出来之后，测试可以直接驱动
 * 真实 store（喂桩 fetch / window.open），把「按 v 打开并标已读」这类**接线**钉住——
 * 历史上多次故障都出在接线上，而不是算法上。
 */

/**
 * 客户端 store 的**显式依赖**（阶段 4 的真接缝）。
 *
 * 为什么要有它：`createReaderStore()` 此前收零参数，却偷偷用着 fetch / AbortController / setTimeout /
 * Date / Blob / document / window.open / console —— 于是四份测试沙箱各复制一遍这些桩，
 * 「换一次 overview 回包形状要改四个文件」。接缝画在构造处之后，测试只需喂一条假通道；
 * 浏览器里跑的时候用下面的 browserDeps（与改动前的行为逐条对应）。
 */
export interface ReaderStoreDeps {
  /** 与宿主的唯一通道。默认实现发 POST 到 ROUTE_PATH 并解信封。 */
  rpc: <T>(endpoint: Endpoint, payload?: unknown, signal?: AbortSignal) => Promise<T>
  /** 现在几点（毫秒）。默认 Date.now —— 测试可以冻结它。 */
  now: () => number
  /** 撤销窗口的定时器。默认全局 setTimeout。 */
  setTimeout: (handler: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  /** 打开外站（v 键）。默认 window.open(_blank, noopener)。 */
  open: (url: string) => void
  /** 触发文件下载（OPML 导出）。默认 Blob + <a download>。 */
  saveFile: (name: string, text: string, mime: string) => void
  /** 诊断输出。默认 console。 */
  log: (level: 'warn' | 'error', message: string, failure?: unknown) => void
  /** 搜索请求的取消器。默认真 AbortController。 */
  newAbortController: () => AbortController
}

/** 浏览器里的真实实现 —— 与接缝出现之前的行为逐条一致（没有任何新语义）。 */
const browserDeps: ReaderStoreDeps = {
  rpc: browserRpc,
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
  open: (url) => { window.open(url, '_blank', 'noopener') },
  saveFile: (name, text, mime) => {
    const blob = new Blob([text], { type: mime })
    const href = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = name
    anchor.click()
    URL.revokeObjectURL(href)
  },
  log: (level, message, failure) => {
    if (level === 'error') console.error(message, failure)
    else console.warn(message, failure)
  },
  newAbortController: () => new AbortController(),
}

/**
 * 读者 store。
 *
 * ## 四块的分界（阶段 4 票据 03 的第一份成文边界）
 *
 * 下面 48 个成员按**谁写谁的 state** 分四块。这不是目录结构，是写入权限表 —— 拆文件之前先把
 * 这条边界写清楚，否则拆出来的只是四个共享同一个 state 的碎片。
 *
 * | 域 | 拥有的 state | 动作 | 允许改别人的什么 |
 * |---|---|---|---|
 * | 列表 | `items` / `selectedId` / `nextCursor` / `loadingMore` / `filter` / `layout` / `markAllRange` | load / loadMore / visible / setFilter / setLayout / activate / selectRelative / markRead / toggleStar / toggleKeepUnread / toggleRead / markAllRead / undoMarkAll / cleanup / stepArticle | 只**读** feeds / tags；改账目一律经 account-mirror（回包整体覆盖） |
 * | 搜索 | `search` / `searchRevision` / `searchRequest` / `searchPages` | submitSearch / loadSearch / resetSearchPage | 借列表的 items / selectedId / nextCursor / loading 展示；**不许**改 filter |
 * | 订阅 | `feeds` / `folders` / `navSelection` / `navCursor` / `navVisible` / `foldedFolders` / `viewPreferences` | addFeed / removeFeed / importOpml / exportOpml / discover / createFolder / renameFolder / deleteFolder / moveFeedToFolder / selectNav / moveNavCursor / openNavCursor / toggleNav / toggleFolder | 改 navSelection 后必须走 persistView；退订只能经 `deleteSubscription` |
 * | 标签 | `tags` / 条目的 `tagIds` | createTag / renameTag / deleteTag / toggleItemTag | 乐观改 tagIds，失败回取当前页拉回真相（tagWrite 串行化 + tagEpoch 身份） |
 *
 * 共享的不止三样：`deps`（通道/时钟/opener）、`set`（唯一写入口）、`state`（只读快照），
 * 以及跨域入口 `listVersion`（列表与搜索共用，经 next/current 两个函数）、`reload`、`refreshDuplicateHints`。
 * 拆文件时的安全绳 = 现有 642 条测试；它们钉的是行为，不是文件位置。
 */
export function createReaderStore(overrides: Partial<ReaderStoreDeps> = {}) {
  const deps: ReaderStoreDeps = { ...browserDeps, ...overrides }
  let state: ReaderState = {
    items: [], feeds: [], folders: [], tags: [], unread: 0, filter: 'all',
    selectedId: undefined, loading: true, error: undefined, undo: undefined,
    view: 'list', layout: 'list', markAllRange: 'all', showUnread: true, article: undefined, notice: undefined,
    importReport: undefined, discovery: undefined, feedsBusy: false,
    navSelection: { kind: 'virtual' }, perFeedUnread: {}, navVisible: true,
    reading: DEFAULT_READING_PREFERENCES, duplicates: {},
    nextCursor: undefined, loadingMore: false, searchRevision: 0,
    // 光标初值 = 与初始 filter 一致的那一行（初始 filter 是 'all'，故就是「全部」那一行）：
    // 「我停在哪」与「此刻生效的是哪」在开局是同一行，之后才由 shift+n/p 与 shift+o 分开。
    navCursor: { kind: 'filter', filter: 'all' },
    foldedFolders: new Set<string>(),
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
  let undoExpiry: unknown
  const clearUndoExpiry = (): void => {
    if (undoExpiry !== undefined) {
      deps.clearTimeout(undoExpiry)
      undoExpiry = undefined
    }
  }
  const armUndoExpiry = (): void => {
    clearUndoExpiry()
    undoExpiry = deps.setTimeout(() => {
      undoExpiry = undefined
      set({ undo: undefined })
    }, UNDO_WINDOW_MS)
  }
  const get = (): ReaderState => state
  let listVersion = 0
  let overviewVersion = 0
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
  /**
   * 「源 + 过滤」双条件是否成立——两者相乘，不是二选一。
   *
   * 单独抽出来是因为它有第二个使用面：切视图后要把 selectedId 落到新列表第一条
   * （setFilter 的既有 precedent），那个判定必须与 visible() 用的**同一个**，否则迟早出现
   * 「列表里选着一个自己都看不见的条目」。
   */
  const inScope = (item: ItemView): boolean => {
    if (state.navSelection.kind === 'feed' && item.feedId !== state.navSelection.feedId) return false
    if (state.navSelection.kind === 'folder') {
      const feed = state.feeds.find((entry) => entry.id === item.feedId)
      if (feed?.folder !== state.navSelection.folder) return false
    }
    if (state.navSelection.kind === 'tag' && !(item.tagIds ?? []).includes(state.navSelection.tagId)) return false
    if ((state.filter === 'unread' || state.search?.read === 'unread') && item.readAt !== undefined) return false
    if (state.search?.read === 'read' && item.readAt === undefined) return false
    if ((state.filter === 'starred' || state.search?.starred) && !item.starred) return false
    return true
  }

  const visible = (): ItemView[] => {
    const selectedId = state.selectedId
    const matches = (item: ItemView): boolean => {
      if (item.id === selectedId) return true
      return inScope(item)
    }
    return state.items.filter(matches)
  }

  /**
   * 把 selectedId 落到当前作用域的第一条（沿用 setFilter 的既有 precedent）。
   *
   * 不做这一步就会出现「列表空了但还选着一个看不见的条目」，此时按 j/k 毫无反应。
   */
  const relocateSelection = (): void => { set({ selectedId: state.items.filter(inScope)[0]?.id }) }

  /**
   * 切换全局过滤（顶栏那组按钮 / 左栏虚拟视图三行 / 键盘打开虚拟视图行都走它）。
   *
   * 光标同步（2026-10-10 任务 6 返工）：换 filter 就是「当前项换了一行」，光标跟着落到那一行，
   * 否则键盘接着 shift+n 会从旧位置跳。**无条件同步**是一条规则、没有特例：光标只表示「我停在哪行」，
   * 而「哪一行此刻生效」由 selected 标记独立表达（选着源时它仍亮在源那一行 —— 规格 §2.1 的叠加）。
   */
  const setFilter = (filter: Filter): void => {
    set({ filter, navCursor: { kind: 'filter', filter } })
    relocateSelection()
    persistView()
    searchActions.reset()
  }

  /**
   * 拉一次跨源重复提示（M5 03）。
   *
   * **一次 load 一次**：把这一屏的条目 id 一起发过去，宿主按 link_key 批量查 ——
   * 客户端不做「每次渲染扫全库」，也不为每条单独发请求。
   * 失败只留痕不弹错：提示是附加信息，不该让列表红一次。
   */
  const refreshDuplicateHints = (): void => {
    const itemIds = state.items.slice(0, 200).map((item) => item.id)
    if (itemIds.length === 0) {
      if (Object.keys(state.duplicates).length > 0) set({ duplicates: {} })
      return
    }
    void deps.rpc<{ hints?: DuplicateHintView[] }>('duplicateHints', { itemIds })
      .then((result) => {
        const next: Record<string, DuplicateHintView['others']> = {}
        for (const hint of result.hints ?? []) next[hint.itemId] = hint.others
        set({ duplicates: next })
      })
      .catch((failure: unknown) => {
        deps.log('warn', '[rss-reader] 跨源重复提示查询失败，本次不显示', failure)
      })
  }


  const applyOverview = (overview: Overview): void => {
    const selected = state.selectedId
    const stillThere = selected !== undefined && overview.items.some((item) => item.id === selected)
    // 文件夹可能在别的面板里被删/改名；选中项失效时回落虚拟视图，与「源被退订」同一条规则。
    const tags = overview.tags ?? []
    const missing = !selectionExists(state.navSelection, overview.feeds, overview.folders, tags)
    set({
      items: overview.items,
      feeds: overview.feeds,
      folders: overview.folders,
      tags,
      unread: overview.unread,
      perFeedUnread: overview.perFeedUnread,
      // 第一页的游标由宿主给（缺省 = 这一页就是全部）。整份重取时它必须**跟着换掉**：
      // 沿用旧游标会让下一页从旧快照的边界开始，追加出一段不连续的历史。
      nextCursor: overview.nextCursor,
      loading: false,
      error: undefined,
      selectedId: stillThere ? selected : undefined,
      ...(missing
        ? { navSelection: { kind: 'virtual' }, filter: 'all', navCursor: { kind: 'filter', filter: 'all' } }
        : {}),
    })
    if (missing) persistView()
    refreshDuplicateHints()
    // 兜底走 relocateSelection 而不是「取 items[0]」：后者不含源条件，选源状态下按 r 刷新
    // 会把选中项送到源外（那一刻 visible() 里没有它，j/k 直接失灵）。
    if (!stillThere) relocateSelection()
  }

  /**
   * 视图记忆（两列布局任务 7）：把「上次看到哪儿」从宿主存储域读回来。
   *
   * 三件事必须一起成立，所以它们挨着放：
   *
   *  ① **读回来的东西一律不可信** —— 走 shared.ts 的 sanitizeViewPreferences，形状认不出就回落默认，
   *     绝不抛错（存储里可能是旧版本写的、也可能是别的写入者塞的）。已退订的源在这里回落：
   *     判据用**刚下发的 feeds 表**，所以恢复发生在 applyOverview 之后（那时才看得见在订的源）。
   *  ② **恢复不写盘**：一挂载就把读到的值写回去，等于每次打开面板都写一次同一个值 —— 白热存储，
   *     还会把「读」和「写」两条路径耦合成环（读到的旧值刚好覆盖掉用户刚做的动作）。
   *  ③ **用户的手势优先**：恢复是异步的，用户在它到达之前按了 u / 点了源，就不能再拿旧记忆盖掉
   *     他的手势（touched 标志）。否则表现为「按了没反应，过一会儿自己弹回去」。
   */
  let viewRestored = false
  let viewTouched = false
  /** 写盘串行化：记忆按用户动作的先后收敛，不能让两个在飞的请求乱序落库（后发的先到 ⇒ 记忆回退）。 */
  let viewWriteChain: Promise<void> = Promise.resolve()

  /**
   * 就地把恢复值落到 state。
   *
   * 刻意**直接 set**，不走 setFilter / selectNav：那三个动作会触发写盘，而恢复本身不该写盘（见上）。
   * 光标按既有规则同步到「生效的那一行」——与鼠标点源、shift+o 打开源行同一条，恢复不会引入新规则。
   */
  const applyRestoredView = (raw: unknown): void => {
    viewRestored = true
    if (viewTouched) return
    const knownFeeds = new Set(state.feeds.map((feed) => feed.id))
    const knownFolders = new Set(state.folders.map((folder) => folder.name))
    // 标签目录此时已经在手：恢复发生在 overview 落地之后（见 load 的顺序），所以这里能判「标签还在不在」。
    const knownTags = new Set(state.tags.map((tag) => tag.id))
    const prefs = sanitizeViewPreferences(
      raw,
      (feedId) => knownFeeds.has(feedId),
      (folder) => knownFolders.has(folder),
      (tagId) => knownTags.has(tagId),
    )
    set({
      navSelection: prefs.navSelection,
      filter: prefs.filter,
      navVisible: prefs.navVisible,
      reading: prefs.reading,
      navCursor: prefs.navSelection.kind === 'feed'
        ? { kind: 'feed', feedId: prefs.navSelection.feedId }
        : prefs.navSelection.kind === 'folder'
          ? { kind: 'folder', folder: prefs.navSelection.folder }
          : prefs.navSelection.kind === 'tag'
            ? { kind: 'tag', tagId: prefs.navSelection.tagId }
            : { kind: 'filter', filter: prefs.filter },
    })
    relocateSelection()
  }

  /**
   * 落盘当前视图偏好（**只在关键动作时调**，见三个动作方法）。
   *
   * 为什么不做防抖定时器：被记的是「选中的导航项 / filter / 左栏显隐」，它们只在**离散的用户动作**
   * 里变（点源、点 filter、按 u），一次动作一次写，本来就不存在「每按一次键都写」的量。
   * 而移动光标（shift+n/p）是唯一高频的那个，它**刻意不记**（见 NavCursor 注释：那是焦点，不是「看到哪儿」）。
   * 加一个定时器反而要给面板引入常驻资源（验收要求卸载不留残余），收益为零。
   */
  const persistView = (): void => {
    viewTouched = true
    const preferences: ViewPreferences = {
      navSelection: memorableSelectionOf(state.navSelection),
      filter: state.filter,
      navVisible: state.navVisible,
      reading: state.reading,
    }
    viewWriteChain = viewWriteChain
      .then(() => deps.rpc('saveViewPreferences', { preferences }))
      // 写盘失败要有可见后果（AGENTS.md 禁空 catch）：进 error 让面板说出来。
      // 界面状态不回滚 —— 它与「能不能记住」是两件事，把左栏再翻回去只会让用户更困惑。
      .then(() => {}, (failure: unknown) => {
        set({ error: failure instanceof Error ? failure.message : String(failure) })
      })
  }

  /**
   * 改正文排版偏好（M5 01）。
   *
   * 落的是**整份** state（persistView 的老规矩），不是只把 reading 发过去：写侧是「整份覆盖」，
   * 只发一个字段会让 sanitize 把另外三项当作缺失而回落默认 —— 表现为「改完字号，选中的源和未读筛选没了」。
   * 一次点击一次写：这些控件都是离散动作，与 setFilter 同族，不需要防抖定时器。
   */
  const setReading = (patch: Partial<ReadingPreferences>): void => {
    set({ reading: { ...state.reading, ...patch } })
    persistView()
  }

  /**
   * 读一次记忆（**只读，不应用**）。
   *
   * 与应用分开的理由：未知源要按刚下发的 feeds 表校验，所以读必须早于 overview、应用必须晚于它。
   * 读失败只警告不打断面板 —— 读不到就按默认态用（记忆是锦上添花，不该让它挡住条目流）。
   * 但**不许静默**：浏览器里 console 是本插件唯一可见的通道，静默会让「记忆怎么不恢复」无从查起。
   */
  const readViewPreferences = async (): Promise<unknown> => {
    try {
      const result = await deps.rpc<{ preferences?: unknown }>('viewPreferences')
      return result?.preferences
    } catch (failure) {
      deps.log('warn', '[rss-reader] 读取视图记忆失败，本次按默认态使用', failure)
      return undefined
    }
  }

  const load = async (endpoint: 'overview' | 'refresh'): Promise<void> => {
    const version = ++overviewVersion
    if (state.search) {
      ++listVersion
      searchActions.abort()
      set({ nextCursor: undefined, loadingMore: false })
    }
    set({ loading: true })
    try {
      // 恢复必须在 feeds 表到手之后生效（未知源要回落），所以**先读、后应用**：
      // 读一次拿到记忆，等 overview 落地再按在订的源校验。两次 load 并发时也只读一次。
      const preferences = viewRestored ? undefined : await readViewPreferences()
      // 文件夹浏览必须把范围带给宿主：由 SQL 先筛成员再限页，客户端拿到的才是这个文件夹的
      // 一页，而不是「跨源首页里恰好属于成员的那几条」。
      const scopePayload = state.navSelection.kind === 'folder'
        ? { folder: state.navSelection.folder }
        : state.navSelection.kind === 'tag'
          ? { tagId: state.navSelection.tagId }
          : undefined
      const overview = await deps.rpc<Overview>(endpoint, scopePayload)
      if (version !== overviewVersion) return
      if (state.search) {
        const tags = overview.tags ?? []
        const missing = !selectionExists(state.navSelection, overview.feeds, overview.folders, tags)
        set({
          feeds: overview.feeds, folders: overview.folders, tags,
          unread: overview.unread, perFeedUnread: overview.perFeedUnread,
          ...(missing ? { navSelection: { kind: 'virtual' }, filter: 'all', navCursor: { kind: 'filter', filter: 'all' } } : {}),
        })
        if (missing) persistView()
      } else {
        applyOverview(overview)
      }
      if (!viewRestored) applyRestoredView(preferences)
      // 用新游标重查已加载的页数，刷新插入的新条目不会挤掉整个阅读窗口。
      if (state.search) await searchActions.load(undefined, searchActions.loadedPages())
      // 「按了刷新没反应」是本插件最早的体验投诉：界面从不说明发生了什么。
      // 这里如实区分——真抓了 / 被最小间隔节流（附上次完成时间）。
      if (endpoint === 'refresh') {
        const stamp = overview.refreshedAt === undefined ? '' : '（上次完成于 ' + relativeTime(overview.refreshedAt) + '）'
        const run = overview.refresh
        // 「本轮尝试 X/Y」只在这一轮**真的发起**时才说。被节流 / 并入在途各有各的说法：
        // 把它们说成「本轮 0/Y」会让人以为订阅全挂了（M4 02 的验收项：不能显示成新一轮）。
        set({
          notice: run === undefined
            ? (overview.refreshed === true ? '本轮订阅源抓取已结束' + stamp : '本次未发起新抓取' + stamp)
            : run.outcome === 'ran'
              ? '本轮尝试 ' + run.attempted + '/' + run.total + ' 个源' + stamp
              : run.outcome === 'throttled'
                ? '本轮未发起抓取：距上次完成不足最小间隔' + (run.waitMs === undefined ? '' : '，还需等 ' + Math.ceil(run.waitMs / 1000) + ' 秒') + stamp
                : run.outcome === 'in-flight'
                  ? '已有一轮刷新在跑，本次并入等它结束（没有发起新一轮）'
                  : '插件尚未就绪，本次未刷新',
        })
      }
    } catch (failure) {
      if (version !== overviewVersion) return
      set({
        ...(searchActions.inFlight() === true ? {} : { loading: false }),
        error: failure instanceof Error ? failure.message : String(failure),
      })
    }
  }

  /** 就地改一条的本地镜像，避免每次操作都整份重取。 */
  const patchItem = (itemId: string, patch: Partial<ItemView>): void => {
    set({ items: state.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)) })
  }

  /**
   * 拿**宿主回包的那份账**整体覆盖本地未读账（unread + perFeedUnread）。
   *
   * ⚠️ 为什么是整体覆盖、而不是「按本地看得见的条目做增量」——这是本文件最容易踩回去的一个坑，
   * 也是任务 9 实测复现的缺陷本体：客户端只拿得到 maxItemsShown（默认 300）条 items，而宿主按
   * 每源 maxItemsPerFeed（默认 500）条的**全量表**记账（src/config.ts）。本地增量只能覆盖
   * 「本地看得见的那几条」，一旦有**本地看不见的漂移**（另一个面板/标签页标掉了某些条目），
   * 增量就把那份过期基线原样留下 ⇒ 左栏各源之和 ≠ 顶栏总未读（幽灵未读，两个数都是真实渲染的）。
   *
   * 所以标读端点**必须回 perFeedUnread**（src/shared.ts 的 UnreadAccount），客户端照单全收：
   * 这与任务 1 拒绝「客户端从 items 派生 perFeedUnread」是同一条理由 —— 口径只能由宿主给。
   * 乐观更新仍由调用方先做（手感），回包到达时以宿主为准纠正。
   */
  const applyAccount = (account: UnreadAccount): void => {
    set({ unread: account.unread, perFeedUnread: account.perFeedUnread })
  }
  /**
   * 取下一页（keyset 续页）。**不是**「重新拉一次」：它是把宿主给的下一批**追加**到列表尾部。
   *
   * ⚠️ 这一页同样**只接收回包、不从 items 派生账目**（与 applyOverview / applyAccount 同一条不变量）：
   * 账目以宿主回包为准整体覆盖。若在这里改成「按追加后的 items 重算 perFeedUnread」，客户端又一次
   * 拿截断视图当真相 —— 那是任务 9 实测的幽灵未读（左栏各源之和 ≠ 顶栏总未读），只是换到第二页才
   * 发作，反而更难查（上面 applyAccount 记的就是这条路）。第一页与第 N 页走**同一个** applyAccount，
   * 不变量才不会在翻页处破掉。
   *
   * 缺游标 = 已经到底：直接返回，不发请求（宿主会把缺省 cursor 当成第一页，那会让列表原地重复 300 条）。
   */
  const loadMore = async (): Promise<void> => {
    const cursor = state.nextCursor
    if (cursor === undefined || state.loadingMore) return
    if (state.search) {
      if (!state.loading) await searchActions.load(cursor)
      return
    }
    const version = listVersion
    set({ loadingMore: true })
    try {
      const overview = await deps.rpc<Overview>('overview', {
        cursor,
        ...(state.navSelection.kind === 'folder' ? { folder: state.navSelection.folder } : {}),
        ...(state.navSelection.kind === 'tag' ? { tagId: state.navSelection.tagId } : {}),
      })
      if (version !== listVersion) return
      // 追加拼在**当前** state 上（不是闭包里那份快照）：请求在途时用户可能已经标读/加星，
      // 用发请求前的 items 覆盖会把那些本地动作抹掉。
      set({ items: [...state.items, ...overview.items], nextCursor: overview.nextCursor })
      applyAccount(overview)
      set({ loadingMore: false, error: undefined })
    } catch (failure) {
      if (version !== listVersion) return
      set({ loadingMore: false, error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /**
   * **仅供乐观更新**：按本批「本地看得见、且确实被标掉」的条目增量调整本地镜像，让角标从按下那一刻
   * 就动起来。它**不是**账目的真相来源 —— 真相只在宿主回包里（见 applyAccount）。
   *
   * 键域 = 宿主下发的键（0 未读的源也必须留键）；对不上号的 id（不在 items 里、或其源无键）跳过，
   * 不猜源、不造键。回包一到就被整体覆盖，所以这里算少/算错都不会留在界面上。
   */
  const shiftPerFeedUnread = (ids: readonly string[], delta: number): Record<string, number> => {
    const next: Record<string, number> = { ...state.perFeedUnread }
    for (const id of ids) {
      const feedId = state.items.find((item) => item.id === id)?.feedId
      if (feedId === undefined || next[feedId] === undefined) continue
      next[feedId] = Math.max(0, next[feedId] + delta)
    }
    return next
  }

  /**
   * 六个动作共用「乐观 → RPC → 覆盖 / 回滚」管线（失败统一回滚，2026-10-16 拍板）。
   * 动作 × 行为的判据之家在 src/client/account-mirror.ts 头部 —— 这里只留守卫与载荷组装。
   */
  const mirror = createAccountMirror({
    callRpc: deps.rpc,
    applyAccount,
    fail: (failure) => { set({ error: failure instanceof Error ? failure.message : String(failure) }) },
  })

  const markRead = async (itemId: string): Promise<void> => {
    const target = state.items.find((item) => item.id === itemId)
    if (target?.readAt !== undefined) return
    // 快照在按下前取：失败回滚 = 恢复到「动作没发生」（account-mirror 不变量 ②——
    // 不用反向增量：Math.max 夹到 0 的减量没法用加法精确还原）
    const stamp = new Date(deps.now()).toISOString()
    const beforeUnread = state.unread
    const beforePerFeed = state.perFeedUnread
    await mirror.run({
      endpoint: 'markRead',
      payload: { itemIds: [itemId] },
      optimistic: () => {
        patchItem(itemId, { readAt: stamp })
        // 左栏角标（perFeedUnread）与顶栏总数（unread）是同一条守恒式的两边——各源之和 === unread。
        // 只减 unread 会让界面自相矛盾：角标还写着 3、顶栏已经 2（index.tsx:374 与 :385 分读两处）。
        // 宿主侧 unread 由 countUnread 重算，客户端这一侧的每源账目必须跟着一起补。
        set(target === undefined
          ? { unread: Math.max(0, state.unread - 1) }
          : {
            unread: Math.max(0, state.unread - 1),
            perFeedUnread: {
              ...state.perFeedUnread,
              [target.feedId]: Math.max(0, (state.perFeedUnread[target.feedId] ?? 0) - 1),
            },
          })
      },
      rollback: () => {
        patchItem(itemId, { readAt: target?.readAt })
        set({ unread: beforeUnread, perFeedUnread: beforePerFeed })
      },
    })
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
  /**
   * 「打开一条」= 选中 + 标已读。**已读的唯一自动触发点**：行点击 / Enter / Space / o / v / 正文加载。
   *
   * 展开状态不进 store（2026-10-15 键盘路由轮的裁决 Q2），调用方用 nextExpandedOf 决定它。
   * 为什么收成一个动作：此前五个入口各拼一遍「选中 + 展开 + 标已读」，其中行内 Enter 那一版
   * 把展开写成了「恒展开」—— 同一条规则写五遍，迟早有一个版本不一样。
   */
  const activate = (itemId: string): void => {
    set({ selectedId: itemId })
    void markRead(itemId)
  }

  const openSelected = (): void => {
    const item = visible().find((entry) => entry.id === state.selectedId)
    if (item === undefined) return
    // 历史行可能带脏 link（修复前落库的 javascript:）：window.open 前过 shared.ts 的唯一白名单。
    // 认不出就当「无链接」——不打开新窗口、也不标已读（动作没发生）。
    const href = httpUrlOrEmpty(item.link)
    if (href === '') return
    deps.open(href)
    activate(item.id)
  }

  const toggleStar = async (): Promise<void> => {
    const item = visible().find((entry) => entry.id === state.selectedId)
    if (item === undefined) return
    await mirror.run({
      endpoint: 'toggleStar',
      payload: { itemId: item.id },
      // 此前 await 不接返回值，回包里的 unread / perFeedUnread 整个被丢 —— 现在由管线统一落账（不变量 ①）
      optimistic: () => { patchItem(item.id, { starred: !item.starred }) },
      // 回滚用按下前的快照，不是「再翻转一次」：并发窗口里两次翻转未必回到原值
      rollback: () => { patchItem(item.id, { starred: item.starred }) },
    })
  }

  /**
   * 切换「保持未读」（规格 §3.3）。
   *
   * 接收显式 id：这条链接挂在每个条目下方，点的那一行未必是当前选中的那一行。
   */
  const toggleKeepUnread = async (itemId: string): Promise<void> => {
    const item = state.items.find((entry) => entry.id === itemId)
    if (item === undefined) return
    await mirror.run({
      endpoint: 'toggleKeepUnread',
      payload: { itemId },
      optimistic: () => { patchItem(itemId, { keptUnread: item.keptUnread !== true }) },
      rollback: () => { patchItem(itemId, { keptUnread: item.keptUnread }) },
    })
  }

  const toggleRead = async (): Promise<void> => {
    const item = visible().find((entry) => entry.id === state.selectedId)
    if (item === undefined) return
    if (item.readAt === undefined) {
      await markRead(item.id)
      return
    }
    const beforeUnread = state.unread
    const beforePerFeed = state.perFeedUnread
    await mirror.run({
      endpoint: 'unmarkRead',
      payload: { itemIds: [item.id] },
      optimistic: () => {
        patchItem(item.id, { readAt: undefined })
        // 同上：取消已读要把这条账加回**它所属源**，否则角标会比顶栏少一
        set({
          unread: state.unread + 1,
          perFeedUnread: { ...state.perFeedUnread, [item.feedId]: (state.perFeedUnread[item.feedId] ?? 0) + 1 },
        })
      },
      rollback: () => {
        patchItem(item.id, { readAt: item.readAt })
        set({ unread: beforeUnread, perFeedUnread: beforePerFeed })
      },
    })
  }

  /** A：把**当前过滤下**的未读全部标为已读，留一个短时撤销窗口。 */
  const markAllRead = async (): Promise<void> => {
    // **保持未读的条目要活下来**（规格 §3.3）——这正是 kept-unread 的存在理由。本地乐观更新与请求
    // 两处都要跳过；宿主侧也会按 skipKept 再挡一次（客户端列表只是快照）。
    const days = RANGE_DAYS[state.markAllRange]
    const before = days === undefined ? undefined : new Date(deps.now() - days * 24 * 3600 * 1000).toISOString()
    const ids = visible()
      .filter((item) => item.readAt === undefined && item.keptUnread !== true)
      // 范围阈值同样判两次：这里决定乐观更新与名单，宿主那边再按 before 挡一次
      .filter((item) => before === undefined || recencyOf(item) < before)
      .map((item) => item.id)
    if (ids.length === 0) return
    const stamp = new Date(deps.now()).toISOString()
    const beforeUnread = state.unread
    const beforePerFeed = state.perFeedUnread
    const beforeItems = state.items
    // 连按两次 A、第二次失败时，第一条的撤销窗口还没走完 —— 回滚必须恢复「按下前」的 undo。
    // 不需要身份 CAS：A2 的 beforeUndo 在按下那一刻就是 A1 的条目（undo 是单槽），快照恢复
    // 天然还原它；真正的并发风险在 undoMarkAll 那一侧（见其 rollback 注释）。
    const beforeUndo = state.undo
    await mirror.run({
      endpoint: 'markRead',
      payload: { itemIds: ids, skipKept: true, before },
      optimistic: () => {
        set({
          items: state.items.map((item) => (ids.includes(item.id) ? { ...item, readAt: stamp } : item)),
          unread: Math.max(0, state.unread - ids.length),
          // 乐观更新也要带上每源账目：否则从按下 A 到宿主回包之间，左栏角标停在旧数上。
          // 基线用宿主下发的那份（含截断之外的账），只按本批 ids 增量减。
          perFeedUnread: shiftPerFeedUnread(ids, -1),
          undo: { ids },
        })
        armUndoExpiry()
      },
      // 失败 = 动作没发生：界面（含撤销窗口）整体回到按下前 —— 挂着一条回不去的撤销，
      // 按了只会再吃一次错；恢复出撤销条则必须重新武装定时器（否则常驻，见 undoMarkAll）。
      // 恢复出的窗口从恢复时刻重新计 5s：state 刻意不存时间戳，恢复剩余秒数得先改数据形状。
      rollback: () => {
        set({ items: beforeItems, unread: beforeUnread, perFeedUnread: beforePerFeed, undo: beforeUndo })
        if (beforeUndo === undefined) clearUndoExpiry()
        else armUndoExpiry()
      },
    })
  }

  const undoMarkAll = async (): Promise<void> => {
    const undo = state.undo
    if (undo === undefined) return
    const beforeUnread = state.unread
    const beforePerFeed = state.perFeedUnread
    const beforeItems = state.items
    await mirror.run({
      endpoint: 'unmarkRead',
      payload: { itemIds: undo.ids },
      optimistic: () => {
        clearUndoExpiry()
        set({ undo: undefined })
        set({
          items: state.items.map((item) => (undo.ids.includes(item.id) ? { ...item, readAt: undefined } : item)),
          perFeedUnread: shiftPerFeedUnread(undo.ids, 1),
        })
      },
      // 失败 = 撤销没发生：undo 条恢复并重新武装 5 秒窗口 —— 只把 undo 塞回 state 而不定时器，
      // 恢复出来的撤销条会**常驻**（「5 秒撤销窗口」名存实亡，正是 2026-10-07 修过的缺陷）。
      // 身份 CAS（状态谓词式）：仅当撤销条仍是「本动作清掉后的空态」才恢复 —— 在飞窗口里
      // 更晚的 A 已写下自己的条目时，不许拿本动作那个旧 batch 的条目盖掉它（撤销条是单槽资源，
      // 恢复旧 batch 会把 A2 的撤销入口整个换掉；交错用例 C3「撤销在飞」看守这条）。
      // markAllRead 一侧不需要 CAS：undo 是单槽，A2 的 beforeUndo 按下时就是 A1 的条目。
      rollback: () => {
        set({ items: beforeItems, unread: beforeUnread, perFeedUnread: beforePerFeed })
        if (state.undo === undefined) {
          set({ undo: { ids: undo.ids } })
          armUndoExpiry()
        }
      },
    })
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
    activate(item.id)
    try {
      const result = await deps.rpc<ArticlePayload>('article', { itemId: item.id })
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
            contentVersion: result.contentVersion,
            restoreRatio: result.progress,
          },
        })
      }
    } catch (error) {
      if (state.article?.itemId !== item.id) return
      set({ article: { itemId: item.id, loading: false, failure: error instanceof Error ? error.message : String(error) } })
    }
  }

  /**
   * 记一次阅读进度（M5 02）。
   *
   * 只在「切换文章 / 关闭正文 / 组件卸载」时调 —— **滚动本身不写盘**：逐帧写会把库写热，
   * 而进度只要在离开这篇时是对的。失败只记录不弹错：进度是锦上添花，把它升成 error 条
   * 会让「每切一篇红一次」比丢一次进度更烦人。
   */
  const saveArticleProgress = (itemId: string, contentVersion: string, ratio: number): void => {
    void deps.rpc('saveReadingProgress', { itemId, contentVersion, ratio }).catch((failure: unknown) => {
      deps.log('warn', '[rss-reader] 阅读进度保存失败（不影响继续阅读；下一次切换会再写一次）', failure)
    })
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

  /**
   * 切导航选中（左栏点源 / 任务 6 的键位都走这里）。
   *
   * 再选中同一个源 = **取消选中**：左栏里点亮的项再点一次回到聚合视图，这条与既有
   * 「点同一项收起」的直觉一致，也让键盘路径不用再单独给一个「回到全部」的键。
   *
   * 切回虚拟视图时把 filter 归位到 'all'：否则「虚拟视图 = 某个残留过滤」会变成与 filter
   * 并存的第二套过滤状态——界面上只看得到 filter 顶栏，用户无从知道还有一层。
   */
  const selectNav = (next: NavSelection): void => {
    const current = state.navSelection
    const cancelled = sameNavSelection(current, next)
    if (cancelled || next.kind === 'virtual') {
      // 退出源/文件夹作用域时把光标带回「生效的那一行」：navSelection 变回 virtual、filter 归 'all'，
      // 生效的就是「全部」，光标留在刚开过的那个源/文件夹上会与左栏高亮自相矛盾。
      set({ navSelection: { kind: 'virtual' }, filter: 'all', navCursor: { kind: 'filter', filter: 'all' } })
    } else if (next.kind === 'feed') {
      set({ navSelection: next, navCursor: { kind: 'feed', feedId: next.feedId } })
    } else if (next.kind === 'folder') {
      set({ navSelection: next, navCursor: { kind: 'folder', folder: next.folder } })
    } else {
      set({ navSelection: next, navCursor: { kind: 'tag', tagId: next.tagId } })
    }
    relocateSelection()
    persistView()
    searchActions.reset()
    // 文件夹/标签范围必须由宿主先筛再分页：进入/退出/切换范围时重取一页。
    const scopeChanged = current.kind === 'folder' || next.kind === 'folder'
      || current.kind === 'tag' || next.kind === 'tag'
    if (!state.search && scopeChanged) void load('overview')
  }

  /**
   * 移动导航光标（规格 §2.4 的 shift+n / shift+p）——**只动光标**。
   *
   * 这是本函数存在的全部理由：它**必须不碰** navSelection / filter / selectedId。
   * 第一版把「移动」与「打开」合成一步（移动即 selectNav），于是 shift+o 只剩「取消」，
   * 规格 §2.4 的两行行为塌缩成一行（2026-10-10 返工）。
   *
   * 边界：到头/到尾**夹住不动**（不绕回）。光标一开始就不在表里（选中的源刚被退订）时退回表首，
   * 而不是静默不动 —— 停在一个不存在的行上会让之后每一键都毫无反应。
   */
  const moveNavCursor = (delta: 1 | -1): void => {
    const rows = navRowsOf(state.feeds, state.foldedFolders, state.folders.map((folder) => folder.name), state.tags)
    if (rows.length === 0) return
    const at = rows.findIndex((row) => navCursorKey(row) === navCursorKey(state.navCursor))
    const from = at < 0 ? 0 : at
    const next = rows[Math.min(rows.length - 1, Math.max(0, from + delta))]
    if (next === undefined || navCursorKey(next) === navCursorKey(state.navCursor)) return
    set({ navCursor: next })
  }

  /**
   * 打开光标所在行（规格 §2.4 的 shift+o）——**等同点击它**，所以逐行复用鼠标那条动作：
   *   - 源行     → selectNav（含「再选同源 = 取消」的既有裁决，键盘路径原样继承）；
   *   - 虚拟视图行 → setFilter（顶栏那组按钮的同一个入口，左栏三行是它的镜像）。
   *
   * 刻意**不**自作主张「打开虚拟视图行就退出源作用域」：鼠标点左栏那个「未读」行也只走 setFilter，
   * 选着源时两处都会变成「源 × filter 叠加」（规格 §2.1 / 任务 2 的裁决）。
   * 「等同点击」这句话要成立，键盘就不能比鼠标多做一步。
   */
  const toggleFolder = (folder: string): void => {
    const foldedFolders = new Set(state.foldedFolders)
    if (foldedFolders.has(folder)) foldedFolders.delete(folder)
    else foldedFolders.add(folder)
    set({ foldedFolders, navCursor: { kind: 'folder', folder } })
  }

  const openNavCursor = (): void => {
    const cursor = state.navCursor
    if (cursor.kind === 'folder') { toggleFolder(cursor.folder); return }
    if (cursor.kind === 'tag') { selectNav({ kind: 'tag', tagId: cursor.tagId }); return }
    if (cursor.kind === 'feed') { selectNav({ kind: 'feed', feedId: cursor.feedId }); return }
    setFilter(cursor.filter)
  }

  /** 左栏显隐（任务 6 的 u 键接线用）。左栏曾经收起过是用户会期待的「重开后还是那样」，故一并记忆。 */
  const toggleNav = (): void => {
    set({ navVisible: !state.navVisible })
    persistView()
  }

  const toggleFeeds = (): void => { set({ view: state.view === 'feeds' ? 'list' : 'feeds' }) }

  /** 导出 OPML：拿到文本后交给浏览器下载（File System Access 不可用时退化为 blob 下载）。 */
  const exportOpml = async (): Promise<void> => {
    try {
      const result = await deps.rpc<OpmlExportResult>('opmlExport')
      const name = 'dsh-rss-subscriptions.opml'
      deps.saveFile(name, result.opml, 'text/x-opml;charset=utf-8')
      set({ notice: '已导出 ' + result.feedCount + ' 个订阅（' + name + '）' })
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /** 导入 OPML：逐源抓取校验，坏源单独列出、不阻断其余（§3.1）。 */
  const importOpml = async (text: string): Promise<void> => {
    set({ feedsBusy: true, importReport: undefined })
    try {
      const report = await deps.rpc<OpmlImportResult>('opmlImport', { opml: text })
      set({ importReport: report, feedsBusy: false })
      await load('overview')
    } catch (failure) {
      set({ feedsBusy: false, error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /**
   * 只发现、不订阅：拿到候选清单后等用户挑（宿主侧零写入，见 endpoints.ts 的 discoverFeeds）。
   * 失败只写 error —— 候选列表保持上一次的样子会让人以为「刚才那次没发生」，所以先清空再请求。
   */
  const discover = async (url: string): Promise<void> => {
    set({ feedsBusy: true, discovery: undefined, importReport: undefined, error: undefined })
    try {
      const result = await deps.rpc<DiscoveryResult>('discoverFeeds', { url })
      set({ feedsBusy: false, discovery: result })
    } catch (failure) {
      set({ feedsBusy: false, error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /** 取消挑选：清掉候选，不写任何订阅。 */
  const clearDiscovery = (): void => { set({ discovery: undefined }) }

  /** 加单个源：同样先校验再落库，避免把网页当订阅。 */
  const addFeed = async (url: string): Promise<void> => {
    set({ feedsBusy: true, importReport: undefined })
    try {
      const report = await deps.rpc<OpmlImportResult>('addFeed', { url })
      // 落库成功即收掉候选清单：用户已经在清单里做过选择，留着它只会让人怀疑「到底加了没」。
      set({ importReport: report, feedsBusy: false, discovery: undefined })
      await load('overview')
    } catch (failure) {
      set({ feedsBusy: false, error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /** 退订：连带删除该源条目（宿主侧执行），不可撤销，界面要二次确认。 */
  const removeFeed = async (url: string): Promise<void> => {
    try {
      const result = await deps.rpc<{ removed: number; items: number }>('removeFeed', { url })
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
      const result = await deps.rpc<CleanupResult>('cleanup')
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

  /**
   * 文件夹管理动作（M2 03）。所有动作都遵循同一条「错误可恢复」规则：
   * 先等宿主确认，成功了才改 state；失败只写 error，原有选择/列表/输入一律不动。
   */
  const applyFolders = (folders: FolderView[]): void => { set({ folders }) }

  const createFolder = async (name: string): Promise<void> => {
    try {
      const result = await deps.rpc<{ folders: FolderView[] }>('createFolder', { name })
      applyFolders(result.folders)
      set({ notice: '已创建文件夹「' + name.trim() + '」' })
      await load('overview')
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  const renameFolder = async (from: string, to: string): Promise<void> => {
    try {
      const result = await deps.rpc<{ folders: FolderView[] }>('renameFolder', { from, to })
      // 当前正在浏览这个文件夹：范围必须跟着迁移，否则右栏会变成一个不存在的名字。
      const selected = state.navSelection.kind === 'folder' && state.navSelection.folder === from
      applyFolders(result.folders)
      if (selected) {
        set({ navSelection: { kind: 'folder', folder: to.trim() }, navCursor: { kind: 'folder', folder: to.trim() } })
        persistView()
      }
      set({ notice: '已把文件夹「' + from + '」改名为「' + to.trim() + '」' })
      await load('overview')
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  const deleteFolder = async (name: string): Promise<void> => {
    try {
      const result = await deps.rpc<{ folders: FolderView[]; detached: number }>('deleteFolder', { name })
      const selected = state.navSelection.kind === 'folder' && state.navSelection.folder === name
      const cursorOnIt = state.navCursor.kind === 'folder' && state.navCursor.folder === name
      applyFolders(result.folders)
      if (selected) {
        // 删除当前文件夹：回到跨源列表（与「源被退订」同一条回落规则）。
        set({ navSelection: { kind: 'virtual' }, filter: 'all', navCursor: { kind: 'filter', filter: 'all' } })
        persistView()
      } else if (cursorOnIt) {
        set({ navCursor: { kind: 'filter', filter: state.filter } })
      }
      set({ notice: '已删除文件夹「' + name + '」，' + result.detached + ' 个订阅变为未分类' })
      await load('overview')
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  const moveFeedToFolder = async (feedId: string, folder: string | undefined): Promise<void> => {
    try {
      const result = await deps.rpc<{ folders: FolderView[] }>('moveFeedToFolder', {
        feedId,
        // 协议里 null 才是「移出到未分类」；undefined 会被 JSON 丢掉，宿主看不到这个键。
        folder: folder ?? null,
      })
      applyFolders(result.folders)
      set({ notice: folder === undefined ? '已把订阅移出分类' : '已把订阅移到「' + folder + '」' })
      await load('overview')
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  /** 标签写入串行队列：频繁点击时按点击顺序发 setItemTags，最后一次覆盖即为服务端结果。 */
  // 标签域（四个动作 + 写盘队列 + 失败代数）已搬进 src/client/tag-actions.ts ——
  // 按边界表，它们只碰 tags 与条目的 tagIds，共享 get / set / rpc 三样。
  const tagActions = createTagActions({
    get, set, rpc: deps.rpc, log: deps.log, persistView, reload: () => load('overview'),
  })

  // 搜索域工厂放在最后：与标签域同形（const，不是 let | undefined），调用点不必写 ?. ——
  // 否则任一路径在赋值前触发就整段静默 no-op，而编译器不会提醒（2026-11-15 评审指出）。
  const searchActions = createSearchActions({
    get, set, rpc: deps.rpc, newAbortController: deps.newAbortController,
    nextListVersion: () => ++listVersion,
    currentListVersion: () => listVersion,
    reload: () => load('overview'),
    refreshDuplicateHints,
  })

  return {
    subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    get, visible, load, loadMore, submitSearch: (query?: SearchQuery) => searchActions.submit(query), markRead, activate, selectRelative, openSelected, toggleStar, toggleKeepUnread, toggleRead, markAllRead, undoMarkAll,
    setLayout, setMarkAllRange, setShowUnread, refreshCount, setReading,
    openArticle, closeArticle, cleanup, stepArticle, canStepArticle, saveArticleProgress,
    toggleFeeds, exportOpml, importOpml, addFeed, removeFeed, discover, clearDiscovery,
    dismissNotice: (): void => { set({ notice: undefined }) },
    setFilter,
    select: (itemId: string): void => { set({ selectedId: itemId }) },
    selectNav,
    moveNavCursor,
    openNavCursor,
    toggleNav, toggleFolder,
    createFolder, renameFolder, deleteFolder, moveFeedToFolder,
    ...tagActions,
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

