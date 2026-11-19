/**
 * 阅读器的状态与数据通道（2026-10-07 从 index.tsx 拆出）。
 *
 * 这里只有状态与副作用，没有任何 JSX：对组件而言它是一个深模块 —— 组件只通过 get()/subscribe()
 * 与那几个动作方法使用它，不关心数据怎么来。拆出的直接理由见评审：原文件 1169 行、同时承担状态、
 * 列表、正文、订阅管理与键盘接线，任一改动都要动同一个文件。
 */
import { useEffect, useState } from 'react'
import { ROUTE_PATH, type DiscoveryResult, type Endpoint, type FeedView, type FolderView, type ItemView, type OpmlImportResult, type RpcResult, type SearchQuery, type TagView, type DuplicateHintView } from '../shared.js'
import { DEFAULT_READING_PREFERENCES, sanitizeViewPreferences } from '../preferences.js'
import type { ReadingPreferences, ViewPreferences } from '../preferences.js'

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

import { createFolderActions } from './folder-actions.js'
import { createFeedActions } from './feed-actions.js'
import { createListActions } from './list-actions.js'
import { createNavActions } from './nav-actions.js'
import { createOpmlActions } from './opml-actions.js'
import { createSearchActions } from './search-actions.js'
import { createTagActions } from './tag-actions.js'
import {
  navRowsOf, navCursorKey, nextExpandedOf, memorableSelectionOf, VIRTUAL_VIEWS,
} from './nav-model.js'
export { navRowsOf, navCursorKey, nextExpandedOf, VIRTUAL_VIEWS }

/**
 * 「全部标为已读」的时间范围（规格 §3.3 的 panic button：可选择「只把**早于**某个时间范围的条目标为
 * 已读」）。默认 all = 全量，也就是改动前的行为 —— 不选就什么都没变。
 */
export type MarkAllRange = 'all' | 'day' | 'week' | 'month'

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
   * 客户端不解释它的内容（格式 `"<recency>|<id>"` 由宿主定义，见 src/cursor.ts 的 decodeCursor）——
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

export { relativeTime } from './relative-time.js'

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
 * 下面 49 个成员按**谁写谁的 state** 分四块。这不是目录结构，是写入权限表 —— 拆文件之前先把
 * 这条边界写清楚，否则拆出来的只是四个共享同一个 state 的碎片。
 *
 * | 域 | 拥有的 state | 动作 | 允许改别人的什么 |
 * |---|---|---|---|
 * | 列表 | `items` / `selectedId` / `nextCursor` / `loadingMore` / `filter` / `layout` / `markAllRange` / `undo`（账目 `unread` / `perFeedUnread` 由 account-mirror 的回包整体覆盖） | load / loadMore / visible / setFilter / setLayout / activate / selectRelative / markRead / toggleStar / toggleKeepUnread / toggleRead / markAllRead / undoMarkAll / cleanup / stepArticle / openArticle / retryArticle | 只**读** feeds / tags；改账目一律经 account-mirror（回包整体覆盖）。**跨域写入逐条登记在此**：① setFilter 同步 `navCursor`（光标跟着过滤走，2026-10-10 的既有规则）；② overview 整份落地（applyOverview 与 load 的搜索分支）把 feeds / folders / tags 按宿主快照原样写回；③ 选中项失效时 applyOverview / load 把 navSelection + navCursor 回落虚拟视图（与「源被退订」同一条规则）；④ 正文动作（openArticle / retryArticle / stepArticle）写 `view` / `article` —— 这两份是跨域呈现状态，不归任何一块私有 |
 * | 搜索 | `search` / `searchRevision` / `searchRequest` / `searchPages` | submitSearch / loadSearch / resetSearchPage | 借列表的 items / selectedId / nextCursor / loading 展示；**不许**改 filter |
 * | 订阅 | `feeds` / `folders` / `discovery` / `feedsBusy` / `importReport` / `navSelection` / `navCursor` / `navVisible` / `foldedFolders` / `viewPreferences`（**deleteFolder 例外**：删掉当前所在文件夹时会把 `filter` 回落成 `all`，这条跨域写入登记在此） | addFeed / removeFeed / importOpml / exportOpml / discover / createFolder / renameFolder / deleteFolder / moveFeedToFolder / selectNav / moveNavCursor / openNavCursor / toggleNav / toggleFolder | 改 navSelection 后必须走 persistView；退订只能经 `deleteSubscription` |
 * | 标签 | `tags` / 条目的 `tagIds` | createTag / renameTag / deleteTag / toggleItemTag | 乐观改 tagIds，失败回取当前页拉回真相（tagWrite 串行化 + tagEpoch 身份） |
 *
 * `view` / `article` 是跨域呈现状态：列表的 openArticle / retryArticle / closeArticle、搜索的 submitSearch、
 * 导航的 toggleFeeds 都会写 `view` —— 它不属于任何一块的私有 state。
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

  const get = (): ReaderState => state
  let listVersion = 0
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

  /**
   * 视图记忆（两列布局任务 7）：把「上次看到哪儿」从宿主存储域读回来。
   *
   * 三件事必须一起成立，所以它们挨着放：
   *
   *  ① **读回来的东西一律不可信** —— 走 preferences.ts 的 sanitizeViewPreferences，形状认不出就回落默认，
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

  /**
   * 刷新未读计数（规格 §5 不变量 8 的 r 键）。
   *
   * 走的是 overview（宿主把已收集的条目与计数回给我们），**不触发抓取** —— 这正是规格不变量 1
   * 的区分：「Refresh 只更新本地视图，抓取由服务端按自己的节奏做」。
   */
  const refreshCount = async (): Promise<void> => { await listActions.load('overview') }

  /** 把宿主回包的目录落到 state（文件夹四动作已搬进 src/client/folder-actions.ts，仍共用这里）。 */
  const applyFolders = (folders: FolderView[]): void => { set({ folders }) }

  // 文件夹四动作已搬进 src/client/folder-actions.ts。
  // 标签域（四个动作 + 写盘队列 + 失败代数）已搬进 src/client/tag-actions.ts ——
  // 按边界表，它们只碰 tags 与条目的 tagIds，共享 get / set / rpc 三样。
  const tagActions = createTagActions({
    get, set, rpc: deps.rpc, log: deps.log, persistView, reload: () => listActions.load('overview'),
  })

  // 搜索域工厂放在最后：与标签域同形（const，不是 let | undefined），调用点不必写 ?. ——
  // 否则任一路径在赋值前触发就整段静默 no-op，而编译器不会提醒（2026-11-15 评审指出）。
  const searchActions = createSearchActions({
    get, set, rpc: deps.rpc, newAbortController: deps.newAbortController,
    nextListVersion: () => ++listVersion,
    currentListVersion: () => listVersion,
    reload: () => listActions.load('overview'),
    refreshDuplicateHints,
  })

  // 列表域工厂：setFilter 要清搜索结果（reset 只能经搜索域的入口），所以建在搜索域之后；
  // 导航域又反过来借它的 setFilter / relocateSelection —— 工厂之间只传闭包，不含执行期副作用。
  const { actions: listActions, relocateSelection } = createListActions({
    get, set, persistView, rpc: deps.rpc, log: deps.log,
    now: deps.now, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout, open: deps.open,
    search: searchActions,
    nextListVersion: () => ++listVersion,
    currentListVersion: () => listVersion,
    viewMemory: { restored: () => viewRestored, read: readViewPreferences, apply: applyRestoredView },
    refreshDuplicateHints,
  })

  // OPML 域放在最后（const，与搜索/标签同形）。
  const opmlActions = createOpmlActions({
    set, rpc: deps.rpc, saveFile: deps.saveFile, reload: () => listActions.load('overview'),
  })

  const folderActions = createFolderActions({
    get, set, rpc: deps.rpc, applyFolders,
    reload: () => listActions.load('overview'),
    persistView,
  })

  const navActions = createNavActions({
    get, set, reload: () => listActions.load('overview'), persistView, relocateSelection, searchActions,
    setFilter: listActions.setFilter,
  })

  const feedActions = createFeedActions({ set, rpc: deps.rpc, reload: () => listActions.load('overview') })

  return {
    subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    get, submitSearch: (query?: SearchQuery) => searchActions.submit(query),
    refreshCount, setReading,
    ...navActions, ...opmlActions, ...feedActions,
    dismissNotice: (): void => { set({ notice: undefined }) },
    ...listActions,
    ...folderActions,
    ...tagActions,
  }
}

export type ReaderStore = ReturnType<typeof createReaderStore>

/** 订阅 store 并强制重渲染。 */
export function useReaderStore(store: ReaderStore): ReaderState {
  const [, force] = useState(0)
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store])
  return store.get()
}

