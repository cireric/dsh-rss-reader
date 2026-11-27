/**
 * 阅读器的状态与数据通道（2026-10-07 从 index.tsx 拆出）。
 *
 * 这里只有状态与副作用，没有任何 JSX：对组件而言它是一个深模块 —— 组件只通过 get()/subscribe()
 * 与那几个动作方法使用它，不关心数据怎么来。拆出的直接理由见评审：原文件 1169 行、同时承担状态、
 * 列表、正文、订阅管理与键盘接线，任一改动都要动同一个文件。
 */
import { useEffect, useState } from 'react'
import { ROUTE_PATH, type DiscoveryResult, type Endpoint, type ExploreRouteView, type FeedView, type FolderView, type ItemView, type OpmlImportResult, type RpcResult, type RsshubSettingsSnapshot, type SearchQuery, type SettingsSnapshot, type TagView, type DuplicateHintView, type TranslateInfo } from '../shared.js'
import { DEFAULT_READING_PREFERENCES, DEFAULT_VIEW_PREFERENCES, sanitizeViewPreferences, validListScrollTop } from '../preferences.js'
import type { ReadingPreferences, ViewPreferences } from '../preferences.js'
import { clampScrollTop } from '../list-scroll.js'
import type { DisplayWindowRange } from '../display-window.js'
import type { UnreadSplit } from '../unread.js'
import { DEFAULT_TARGET_LANGUAGE, type TargetLanguage } from '../translate-copy.js'
import { RpcError } from './rpc-error.js'
import type { TranslateConfirmRequest, TranslationEntry, TranslationMode } from './translate-state.js'

// 翻译状态与 RpcError 的对外导出面保留在这里：既有组件 / 测试仍从 store 取它们；
// 实现已经搬到叶子模块（2026-11-26 评审修复，消除 store ↔ translate-actions 的运行时循环）。
export { RpcError } from './rpc-error.js'
export {
  hasTranslations, nextTranslationMode, TRANSLATION_MODES,
  type TranslationBatchFailure, type TranslateConfirmRequest, type TranslationEntry, type TranslationMode,
} from './translate-state.js'

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
import { createSettingsActions, type TranslateRouteSettingsPatch } from './settings-actions.js'
import { createExploreActions } from './explore-actions.js'
import { createTagActions } from './tag-actions.js'
import { createTranslateActions } from './translate-actions.js'
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

/**
 * 探索域的整份状态（R8b 04）。`view: 'explore'` 时存在，关闭视图即整份丢弃（D14：不持久化）。
 *
 * 为什么用一个对象而不是散在 ReaderState 上：q / 筛选 / 分页 / 表单草稿彼此同生共死 ——
 * 关掉探索必须一起消失，散字段会让「清了一半」成为可达状态。
 */
export interface ExploreState {
  /** 已加载的路由行（分页**累计**，不是当前页）。 */
  items: ExploreRouteView[]
  /** 生效中的搜索词（空串 = 不生效）。表单里的输入草稿归组件局部，不在这里。 */
  q: string
  /** 单选分类（undefined = 不筛）；再点同类由视图翻译成 undefined。 */
  category: string | undefined
  /** 站点钻取（undefined = 全表）。 */
  namespace: string | undefined
  /** 整张目录的分类（宿主下发，供筛选项）。 */
  categories: string[]
  siteTotal: number | undefined
  routeTotal: number | undefined
  /** 当前筛选命中的路由数（与目录口径分开，D13）。 */
  matched: number | undefined
  loading: boolean
  loadingMore: boolean
  /** 目录取数失败的一句话（原样展示，不伪装成空列表）。 */
  error: string | undefined
  /** 续页游标：缺省 = 已到底。 */
  nextCursor: string | undefined
  /** 正在填参数的路由（undefined = 没选）。 */
  selected: ExploreRouteView | undefined
  /** 参数草稿（name → 值）。 */
  draft: Record<string, string>
  /**
   * 选中这条路由时，官方 example 是否真的反推出至少一个值（spec §4.5）。
   *
   * 只在 `selectExploreRoute` 那一刻按 `prefillValues` 的结果定死：它是「实例给没给样本」
   * 的事实，不该随用户往输入框里敲字变化。false + 模板有参数 ⇒ 表单提示「按官方文档填写」。
   */
  prefilled: boolean
  /** 本地拦下的缺失必填参数名（点名用，不是唯一防线）。 */
  missing: string[]
  /** 宿主拼好的地址；undefined = 还没拼 / 表单已改。 */
  builtUrl: string | undefined
  building: boolean
  adding: boolean
  /** 「已添加 ✓」回执（D6：不关视图、不清表单）。 */
  receipt: string | undefined
}

export interface ReaderState {
  items: ItemView[]
  feeds: FeedView[]
  /** 文件夹目录（含空目录）。左栏行序、管理面板与文件夹范围都以它为准。 */
  folders: FolderView[]
  /** 标签目录（含空标签）。左栏筛选与编辑器的名称来源。 */
  tags: TagView[]
  unread: number
  /**
   * 未读三联拆分（R1 04）：**只在宿主回包给了它时存在**，整份覆盖、客户端不推导、不做增量。
   *
   * 缺席（旧宿主 / 不带 todayFrom 的请求）= 顶栏回落到「全局 X 条未读」；`undefined` 与
   * 「0/0/0」是两件事，别用 `?? {0,0,0}` 把它抹平。
   */
  unreadSplit: UnreadSplit | undefined
  filter: Filter
  selectedId: string | undefined
  loading: boolean
  error: string | undefined
  /** 刚被「全部标记已读」的条目，供短时撤销 */
  /** 一键已读的撤销条。窗口到期由 armUndoExpiry 的定时器负责，所以这里不需要存时间戳。 */
  undo: { ids: string[] } | undefined
  /** 当前视图：列表 / 正文 / 订阅管理 / 设置（后两者同样在主栏内切换） */
  view: 'list' | 'article' | 'feeds' | 'settings' | 'explore'
  /**
   * 条目流的**视图密度**（GR 的两视图）：expanded 含条目描述/正文摘录，list 只有标题行。
   * 注意与上面的 view 是两条正交的轴：view 决定「看哪个面板」，layout 决定「条目流怎么排」。
   */
  layout: 'list' | 'expanded'
  /** 「全部标为已读」的时间范围，见 MarkAllRange */
  markAllRange: MarkAllRange
  /**
   * 显示窗档位（R1-03）：全部 / 今天 / 近 3 天 / 近 7 天。
   *
   * **不持久化**（spec 决策 1）：它不在 ViewPreferences 里，面板卸载时由 flushViewMemory 复位成
   * `all` —— 重开面板看到的是稳定的默认视图。它是**视野**设置，不是范围：切源 / 文件夹 / 标签
   * 与过滤三连都不读写它，它也不读写 markAllRange。
   */
  displayWindow: DisplayWindowRange
  /**
   * 当前账目（`unread` / `perFeedUnread` / `unreadSplit`）**属于哪个档位**（R1 评审 P1）。
   *
   * 账目是宿主按某个窗口算出来的一份快照，不是「永远对应当前视野」的事实：切档后
   * `displayWindow` 立刻变了，新档第一页却还在路上。两者不一致期间，界面上的任何数字都可能是
   * 另一个窗口的数（「今天 <全部未读> 条」就是这么来的），所以顶栏 / 左栏角标 / 侧栏徽标
   * 一律不显示，等回包把这份标记推到新档位（见 index.tsx 的 pending 文案）。
   *
   * 初值 `all` 不是猜测：store 的第一笔账来自挂载时的 refresh（默认档位就是「全部」）。
   */
  accountWindow: DisplayWindowRange
  /**
   * 是否显示未读计数（规格 §5 不变量 8：**未读计数可隐藏**）。默认显示 = 既有行为。
   * R11 05 起它不再只是内存状态：初值由视图记忆恢复，改动经 setShowUnread → persistView 落盘（D27.2）。
   */
  showUnread: boolean
  /**
   * 设置页的生效值快照（R11 01）：`undefined` = 还没取到（正在取 / 读失败）。
   *
   * 与 `view === 'settings'` 分开：关掉页面再打开时沿用上一份，避免先闪一屏空值。
   */
  settings: SettingsSnapshot | undefined
  /** 设置页取数失败的一句话（与全局 error 分开：设置页自己要能说明为什么空着）。 */
  settingsError: string | undefined
  /**
   * RSSHub 实例池快照（R15 01）：设置页的池子列表与探索入口的可见性共用这一份。
   * 它来自 `rsshubSettings` 端点（config.json），与 settings.json 的标量快照是两处数据。
   */
  rsshubSettings: RsshubSettingsSnapshot | undefined
  /** 实例池取数失败的一句话（分区内展示，不把整页打成错误）。 */
  rsshubSettingsError: string | undefined
  /** 探索视图的整份状态（`view: 'explore'` 时存在；关闭即丢弃，D14）。 */
  explore: ExploreState | undefined
  /** 启动时的读侧告警（坏文件隔离 / 坏值忽略）是否已被本次会话关掉（D17）。 */
  settingsWarningDismissed: boolean
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
  /**
   * 内存译文（R7 01）：键 = `${itemId}:${contentVersion}:${target}`。
   *
   * 刻意不落盘、不进 viewPreferences：刷新 / 热重载即丢（spec D9 / D11）。切条目、切面板
   * 不丢 —— 它挂在 store 上而不是组件 state 上。
   */
  translations: ReadonlyMap<string, TranslationEntry>
  /**
   * 两态（R7 03）。它是**全局面板内**的显示偏好，不持久化：刷新即回原文。
   * 有译文时正文面默认用它（动作层在全新一场开始时置 'parallel'）；没有译文时
   * 正文面按 'original' 渲染且不显示切换器 —— 判据在渲染层，本字段不表达「有没有译文」。
   */
  translationMode: TranslationMode
  /** 可用性探测结果（R7 02）：面板加载时探一次；undefined = 还没探到（按钮先不渲染）。 */
  translationInfo: TranslateInfo | undefined
  /**
   * 首次外发确认框的待确认内容（R7 06 / spec §4.2）：undefined = 没有框。
   *
   * 放 store 而不是 ArticleView 的 `useState`：`t` 键与工具栏按钮必须走**同一个**请求入口
   * （键盘路径不经过组件），确认态跟着 store 才能在两条入口之间保持一致。
   * 取消 / 离开正文时清空，不写 settings、不发 rpc。
   */
  translateConfirm: TranslateConfirmRequest | undefined
  /**
   * 翻译目标语言（R7 02 / spec §5.3）：与 `viewPreferences.translateTarget` 同一份状态。
   * 正文工具栏「译」旁边的裸下拉是唯一入口（2026-11-26 从设置页 / Aa 面板迁来）；
   * 切换只影响新译文，旧译文按语言分键保留。
   */
  translateTarget: TargetLanguage
  /**
   * 正在飞的那一批的块下标（R7 优化：翻译中的 loading 指示）。
   *
   * `key` 是这一篇的译文键：切条目 / 换语言后旧场次的占位不该画到新正文上，渲染层按 key 比对。
   * `undefined` = 没有在飞的批（空闲 / 已停）。
   */
  translatePending: { readonly key: string; readonly indices: readonly number[] } | undefined
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
 * 调一个端点并解信封；失败抛出 `RpcError`，由面板渲染。
 *
 * endpoint 收的是 shared.ts 的 Endpoint（= ENDPOINT_NAMES 派生）：拼错名字从「运行时收一个
 * unknown-endpoint」变成**编译错误**。这是本文件与宿主之间唯一的那条 seam，值得有类型。
 *
 * 仅供 05 的测试接缝导出：测试要直接喂一个失败信封，断言 `details.reason` 确实进了 Error。
 */
export async function browserRpc<T>(endpoint: Endpoint, payload?: unknown, signal?: AbortSignal): Promise<T> {
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
  if (error === undefined || typeof error.code !== 'string' || typeof error.message !== 'string') {
    throw new Error('通道返回了非预期形状')
  }
  // details 在 wire 上必填；但旧宿主 / 手写桩可能省掉它。缺省成空对象，不让「读 reason」
  // 在客户端抛 TypeError —— 那会把一次可读的失败变成整块面板的错误。
  const details = typeof error.details === 'object' && error.details !== null ? error.details : {}
  throw new RpcError(error.code, error.message, details)
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
 * 下面这些成员按**谁写谁的 state** 分四块。这不是目录结构，是写入权限表 —— 拆文件之前先把
 * 这条边界写清楚，否则拆出来的只是四个共享同一个 state 的碎片。
 *
 * | 域 | 拥有的 state | 动作 | 允许改别人的什么 |
 * |---|---|---|---|
 * | 列表 | `items` / `selectedId` / `nextCursor` / `loadingMore` / `filter` / `layout` / `markAllRange` / `displayWindow` / `accountWindow` / `undo`（账目 `unread` / `perFeedUnread` 由 account-mirror 的回包整体覆盖；`accountWindow` 标记这份账属于哪个档位） | load / loadMore / visible / setFilter / setWindow / setLayout / activate / selectRelative / markRead / toggleStar / toggleKeepUnread / toggleRead / markAllRead / undoMarkAll / cleanup / stepArticle / openArticle / retryArticle / rememberListScrollTop / takeListScrollTop | 只**读** feeds / tags；改账目一律经 account-mirror（回包整体覆盖）。**跨域写入逐条登记在此**：① setFilter 同步 `navCursor`（光标跟着过滤走，2026-10-10 的既有规则）；② overview 整份落地（applyOverview 与 load 的搜索分支）把 feeds / folders / tags 按宿主快照原样写回；③ 选中项失效时 applyOverview / load 把 navSelection + navCursor 回落虚拟视图（与「源被退订」同一条规则）；④ 正文动作（openArticle / retryArticle / stepArticle）写 `view` / `article` —— 这两份是跨域呈现状态，不归任何一块私有；⑤ setFilter / setWindow 经 leaveTransientViews 写 `view` / `article`（切过滤 / 切档退出正文与设置页） |
 * | 搜索 | `search` / `searchRevision` / `searchRequest` / `searchPages` | submitSearch / loadSearch / resetSearchPage | 借列表的 items / selectedId / nextCursor / loading 展示；**不许**改 filter |
 * | 订阅 | `feeds` / `folders` / `discovery` / `feedsBusy` / `importReport` / `navSelection` / `navCursor` / `navVisible` / `foldedFolders` / `viewPreferences`（**deleteFolder 例外**：删掉当前所在文件夹时会把 `filter` 回落成 `all`，这条跨域写入登记在此） | addFeed / removeFeed / moveFeedOrder / importOpml / exportOpml / discover / createFolder / renameFolder / deleteFolder / moveFeedToFolder / selectNav / moveNavCursor / openNavCursor / toggleNav / toggleFolder / flushViewMemory | 改 navSelection 后必须走 persistView；**整份覆盖写必须带上当下的 selectedId**（否则一次普通导航就抹掉阅读位置）；选中 / j/k / 打开条目经 300ms 去抖写手记 lastItemId，面板卸载时 flush；退订只能经 `deleteSubscription`；selectNav 经列表域的 leaveTransientViews 写 `view` / `article`（切作用域退出正文与设置页） |
 * | 标签 | `tags` / 条目的 `tagIds` | createTag / renameTag / deleteTag / toggleItemTag | 乐观改 tagIds，失败回取当前页拉回真相（tagWrite 串行化 + tagEpoch 身份） |
| 设置 | `settings` / `settingsError` / `settingsWarningDismissed` / `rsshubSettings` / `rsshubSettingsError` | loadSettings / loadRsshubSettings / openSettings / closeSettings / toggleSettings / dismissSettingsWarning | 只调 `settings` / `rsshubSettings` 两个端点取快照；`view: 'settings'` 是跨域呈现状态，与列表 / 订阅域同一条规则（左栏导航 / 切过滤 / 切档经列表域入口退出） |
| 探索 | `explore`（目录页累计行 / q + category + namespace / loading / error / 表单草稿 / 回执 / 拼好的地址） | openExplore / closeExplore / setExploreQuery / loadMoreExplore / selectExploreRoute / setExploreDraftValue / buildExploreAddress / addExploreSubscription | 订阅只经 `addFeed`（订阅域入口），自己只写 `explore`；`view: 'explore'` 与设置页同一条跨域规则（左栏导航 / 切过滤 / 切档经列表域入口退出）；拼地址只调宿主端点，模板判据读 `explore-template.ts` |
 *
 * `view` / `article` 是跨域呈现状态：列表的 openArticle / retryArticle / closeArticle 与 setFilter、
 * 搜索的 submitSearch、导航的 selectNav（经列表域入口）、toggleFeeds 与设置域的 open/closeSettings
 * 都会写 —— 它不属于任何一块的私有 state。
 *
 * 列表滚动位置（R2-02）的 `lastListScrollTop` / `restoredListScrollTop` / `listScrollTouched` 是列表域的
 * **模块内**值：刻意不进 state、不触发渲染；`rememberListScrollTop` 与选中共享同一个 300ms 去抖写手，
 * `flushViewMemory` 一次把两者都落盘。`takeListScrollTop` 按当前可滚范围夹取后只交出恢复值一次
 * （取过即清空）；`flushViewMemory` 同时是「面板卸载 = 会话结束」的复位入口。
 *
 * 共享的不止三样：`deps`（通道/时钟/opener）、`set`（唯一写入口）、`state`（只读快照），
 * 以及跨域入口 `listVersion`（列表与搜索共用，经 next/current 两个函数）、`reload`、`refreshDuplicateHints`。
 * 拆文件时的安全绳 = 现有测试套件；它们钉的是行为，不是文件位置。
 */
export function createReaderStore(overrides: Partial<ReaderStoreDeps> = {}) {
  const deps: ReaderStoreDeps = { ...browserDeps, ...overrides }
  let state: ReaderState = {
    items: [], feeds: [], folders: [], tags: [], unread: 0, unreadSplit: undefined, filter: 'all',
    selectedId: undefined, loading: true, error: undefined, undo: undefined,
    view: 'list', layout: 'list', markAllRange: 'all', displayWindow: 'all', accountWindow: 'all', showUnread: DEFAULT_VIEW_PREFERENCES.showUnread, settings: undefined, settingsError: undefined, rsshubSettings: undefined, rsshubSettingsError: undefined, settingsWarningDismissed: false, explore: undefined, article: undefined, translations: new Map(), translationMode: 'original', translationInfo: undefined, translateConfirm: undefined, translateTarget: DEFAULT_TARGET_LANGUAGE, translatePending: undefined, notice: undefined,
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
  const set = (patch: Partial<ReaderState>): void => {
    state = { ...state, ...patch }
    /**
     * 探索状态是视图私有的（R8b 04 / D14）：凡是把 view 移出 explore 的写入，都整份丢弃。
     *
     * 为什么放在唯一写入口而不是只写在 closeExplore 里：Esc 之外还有工具栏的设置 / F（订阅管理）
     * 两条离开路径；只在 Esc 清会让「关闭即清掉」只在一个入口成立，旧目录与表单草稿会一直占着内存。
     */
    if (state.view !== 'explore' && state.explore !== undefined) state = { ...state, explore: undefined }
    emit()
  }

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
   *  ③ **用户的手势优先**：恢复是异步的，用户在它到达之前按了 u / 点了源 / 选了行 / 滚了列表，
   *     就不能再拿旧记忆盖掉他的手势（touched 标志）。否则表现为「按了没反应，过一会儿自己弹回去」。
   *  ④ **写盘是整份覆盖**：阅读位置（R2-01）必须由写入口从**当下** state 取 selectedId，
   *     调用方不许自己拼一份 —— 少带这一位，一次普通的切过滤/切左栏就会把记忆抹掉。
   */
  let viewRestored = false
  let viewTouched = false
  /**
   * 列表滚动位置（R2-02）：**刻意停在模块内**，不进 React state。
   *
   * 滚动事件一秒几十次；进 state 就会每次重渲染整个阅读器，而且没有任何界面需要读它。
   * 它只作为整份视图偏好的一位被写盘（见 viewPreferencesNow），所以状态越少越好。
   */
  let lastListScrollTop: number | undefined
  /**
   * 待恢复的滚动位置：applyRestoredView 交接、面板首屏后 take 一次即清空。
   *
   * 为什么不在 applyRestoredView 里直接写 DOM：恢复那一刻列表可能还没画出来（items 刚落地、
   * React 尚未提交），容器量不到几何；滚动必须在首屏渲染完成后由面板执行。
   */
  let restoredListScrollTop: number | undefined
  /**
   * 本会话里用户是否已经滚过列表。取恢复值时据此放弃旧滚动位置。
   *
   * 注意它与「整份恢复让位」不是同一条判据：滚动同时也会置 `viewTouched`（见
   * rememberListScrollTop），因为迟到的选中恢复会通过「跟随选中」再次把视口拉走。
   * 本标志只负责「取恢复值」这一条路径，便于把两件事分别读懂。
   */
  let listScrollTouched = false
  /** 写盘串行化：记忆按用户动作的先后收敛，不能让两个在飞的请求乱序落库（后发的先到 ⇒ 记忆回退）。 */
  let viewWriteChain: Promise<void> = Promise.resolve()

  /**
   * 阅读位置的去抖窗口（R2-01）。
   *
   * 为什么选中要防抖、而导航不用：j/k 一秒钟能按十几次，逐次写盘只会把域写热；
   * 导航动作是离散的（点一次源/过滤/按一次 u），本来就不存在「每按一次键都写」的量。
   * 窗口与撤销窗口共用 deps.setTimeout/clearTimeout 这条既有接缝 —— 测试要能看见「窗口多长、
   * 写了几次」，而不是靠真等 350ms 赌机器速度。
   */
  const VIEW_WRITE_DEBOUNCE_MS = 300
  /** 待写定时器的句柄。undefined = 没有待写值（flushViewMemory 据此判断「不制造空写」）。 */
  let pendingViewWrite: unknown

  const cancelPendingViewWrite = (): void => {
    if (pendingViewWrite === undefined) return
    deps.clearTimeout(pendingViewWrite)
    pendingViewWrite = undefined
  }

  /**
   * 拼一份可落盘的视图快照。
   *
   * **整份覆盖写**：lastItemId 直接取当下 selectedId，不接受调用方传值 —— 写入口只有这一处，
   * 才能保证「任何一个 navigation 动作都不会把阅读位置落下」。没有选中项时不写这个键（不是写空串）。
   */
  const viewPreferencesNow = (): ViewPreferences => {
    const preferences: ViewPreferences = {
      navSelection: memorableSelectionOf(state.navSelection),
      filter: state.filter,
      navVisible: state.navVisible,
      showUnread: state.showUnread,
      translateTarget: state.translateTarget,
      reading: state.reading,
    }
    if (state.selectedId !== undefined) preferences.lastItemId = state.selectedId
    if (lastListScrollTop !== undefined) preferences.lastListScrollTop = lastListScrollTop
    return preferences
  }

  /** 真正发一次整份写（调用方负责已经取消待写定时器）。 */
  const writeView = (): void => {
    const preferences = viewPreferencesNow()
    viewWriteChain = viewWriteChain
      .then(() => deps.rpc('saveViewPreferences', { preferences }))
      // 写盘失败要有可见后果（AGENTS.md 禁空 catch）：进 error 让面板说出来。
      // 界面状态不回滚 —— 它与「能不能记住」是两件事，把左栏再翻回去只会让用户更困惑。
      .then(() => {}, (failure: unknown) => {
        set({ error: failure instanceof Error ? failure.message : String(failure) })
      })
  }

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
      showUnread: prefs.showUnread,
      translateTarget: prefs.translateTarget,
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
    // 阅读位置（R2-01）：先按既有规则落到当前作用域第一条，再尝试改选上次那一行。
    // **直接 set，不走 select()**：select 会置「用户已动手」并排一次写盘，而恢复既不是手势、
    // 也不该产生写请求（读一次面板不写盘是既有承诺）。
    // 不在当前页就不选中，也**不额外取数**：条目已被清理时面板照常打开，不翻页去找一条不存在的记忆。
    if (prefs.lastItemId !== undefined) {
      const remembered = state.items.some((item) => item.id === prefs.lastItemId)
        ? prefs.lastItemId
        : undefined
      set({ selectedId: remembered })
    }
    // 列表滚动位置（R2-02）：只交接给「取一次就清空」的入口 —— 写回 DOM 必须等首屏列表渲染完成，
    // 那一刻容器才有真实几何（见 takeListScrollTop 与面板里的 useLayoutEffect）。
    if (prefs.lastListScrollTop !== undefined) restoredListScrollTop = prefs.lastListScrollTop
  }

  /**
   * 落盘当前视图偏好（**只在关键动作时调**，见三个动作方法）。
   *
   * 为什么导航不防抖：被记的是「选中的导航项 / filter / 左栏显隐」，它们只在**离散的用户动作**
   * 里变（点源、点 filter、按 u），一次动作一次写，本来就不存在「每按一次键都写」的量。
   * 而移动光标（shift+n/p）是唯一高频的那个，它**刻意不记**（见 NavCursor 注释：那是焦点，不是「看到哪儿」）。
   * 阅读位置（选中项）是另一类：j/k 会成串发生，所以它走 scheduleViewWrite 的 300ms 去抖，
   * 由本函数在关键动作里先取消待写、再整份写一次（避免同一次动作写两遍）。
   */
  const persistView = (): void => {
    viewTouched = true
    // 这一次马上要落的整份写已经包含当下的选中项，定时器再补一枪就是重复写。
    cancelPendingViewWrite()
    writeView()
  }

  /**
   * 安排一次 300ms 去抖写（**只排程**，不置「用户已动手」）。
   *
   * 置 `viewTouched` 的责任留给调用方：rememberSelection / rememberListScrollTop 都是
   * 「用户真的动手了」的入口，各自先置标志再排程；本函数只保证选中与滚动共用同一个
   * 去抖窗口（只该有一个写手），避免任一入口需要「排程但不让位」这种特例。
   */
  const scheduleViewWrite = (): void => {
    // 重新计时而不是叠加：连续 j/k / 连续滚动只在停下来 300ms 后写一次。
    cancelPendingViewWrite()
    pendingViewWrite = deps.setTimeout(() => {
      pendingViewWrite = undefined
      writeView()
    }, VIEW_WRITE_DEBOUNCE_MS)
  }

  /**
   * 选中变化（纯选中 / j/k / 打开条目）走这里：置「用户已动手」并安排一次 300ms 去抖写。
   *
   * 为什么选中也要置 touched：恢复是异步的，若用户已经按 j 换了行而恢复仍无条件覆盖，
   * 表现就是「按了 j，过一会儿选中自己弹回上次那一行」。这条手势判据与 u / 点源共用同一个标志。
   */
  const rememberSelection = (): void => {
    viewTouched = true
    scheduleViewWrite()
  }

  /**
   * 记录列表滚动位置（R2-02）：只改模块内的值并排一次去抖写。
   *
   * **不 set**：滚动若进 React state，每帧都会重渲染整个阅读器；界面没有任何一处读这个值。
   * 认不出的值直接忽略（validListScrollTop 与 sanitizeViewPreferences 共用同一条判据），
   * 不制造一次空写。与上次记下的值相同也跳过 —— 恢复时程序化写 scrollTop 会让浏览器派发
   * 一次 scroll 事件；这一条让「读回来的值」不会被当成用户手势再写回去一遍。
   *
   * 值真的变化时置 viewTouched：滚动也是用户手势。否则恢复还在路上时用户先滚了列表，
   * 迟到的选中恢复仍会把选中换到旧记忆那一行 —— 「跟随选中」随后又把视口拉走，用户的滚动
   * 等于白做（实现决策 8 在 R2 修复轮按此收口：选择/导航/滚动都算「已动手」）。
   */
  const rememberListScrollTop = (top: number): void => {
    const value = validListScrollTop(top)
    if (value === undefined) return
    if (value === lastListScrollTop) return
    lastListScrollTop = value
    listScrollTouched = true
    viewTouched = true
    scheduleViewWrite()
  }

  /**
   * 取一次恢复的滚动位置（R2-02）：**取过即清空**，且用户已经自己滚过就放弃。
   *
   * 面板在列表首屏渲染完成后调用一次，并把返回值**直接**写进容器 scrollTop。
   * 夹取在这里完成而不是留给面板：`lastListScrollTop` 必须是夹取后的值 —— 真浏览器会为
   * 「把 scrollTop 写成夹取后的值」派发一次 scroll，若模块里记的是未夹取的原值（如 9999 → 2700），
   * 监听器会把这次程序化写回当成用户滚动，排出一次纯属恢复副作用的写盘（用户故事 12）。
   * 面板因此不再自己夹 —— 两份夹取迟早会漂移。
   */
  const takeListScrollTop = (maxTop: number): number | undefined => {
    const saved = restoredListScrollTop
    restoredListScrollTop = undefined
    if (saved === undefined || listScrollTouched) return undefined
    const clamped = clampScrollTop(saved, maxTop)
    lastListScrollTop = clamped
    return clamped
  }

  /**
   * 面板卸载时调用：有待写值就立刻落一次，没有就什么都不做。
   *
   * 为什么必须存在：去抖窗口 300ms，读者完全可能选完一行、或滚到一个位置后立刻关面板 ——
   * 那一刻的位置也得记住。写手同时管选中项与列表滚动位置（R2-02），所以 flush 一次两样都带走。
   * 为什么「没有待写值不许写」：每次打开/关闭面板都写一次同样的值只会白热存储；恢复本身也不写盘，
   * 所以「没有手势 → 零写请求」这条既有承诺在卸载路径上同样成立。
   *
   * **卸载 = 会话结束**：写完待写值后必须把恢复状态整组复位。宿主只在 apply() 里建一次 store，
   * 面板切走再回来是组件卸载后重挂、store 不重建 —— 若 viewRestored 停在 true，第二次挂载
   * 的 load 就再也不会读记忆；viewTouched 停在 true 会让它即使读到也整份放弃；待恢复的滚动
   * 位置与 listScrollTouched 也会让滚动恢复永远取不到值。复位放在 flush 里是因为它就是
   * 「面板卸载」的唯一入口（真实面板与测试都走这里）。
   *
   * 显示窗档位也在这一组里：它**不持久化**（spec 决策 1），重开面板必须回到「全部」。
   * 只复位档位、不动 items / 账目 —— 下一次挂载的 refresh 会按新的档位重取，顺手把账目换回来。
   */
  const flushViewMemory = (): void => {
    if (pendingViewWrite !== undefined) {
      cancelPendingViewWrite()
      writeView()
    }
    viewRestored = false
    viewTouched = false
    listScrollTouched = false
    restoredListScrollTop = undefined
    if (state.displayWindow !== 'all') set({ displayWindow: 'all' })
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
  const { actions: listActions, relocateSelection, leaveTransientViews } = createListActions({
    get, set, persistView, rpc: deps.rpc, log: deps.log,
    now: deps.now, setTimeout: deps.setTimeout, clearTimeout: deps.clearTimeout, open: deps.open,
    rememberSelection,
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
    leaveTransientViews,
  })

  const feedActions = createFeedActions({ get, set, rpc: deps.rpc, reload: () => listActions.load('overview') })

  // 设置域（R11 01）：只读快照 + 视图开关。写路径是 02 票的 saveSettings。
  const settingsActions = createSettingsActions({ get, set, rpc: deps.rpc, log: deps.log })

  // 翻译域（R7 01）：只写 translations；正文块本身归 article，动作只读不写。
  // R7 06：首次外发确认标记复用设置域的保存串行链（走 saveSettings 的 patch，不新开端点）。
  const translateActions = createTranslateActions({
    get, set, rpc: deps.rpc, log: deps.log, persistView,
    saveNoticeAck: async () => (await settingsActions.saveSetting('translateNoticeAck', true)).ok,
  })

  /**
   * 翻译路由保存（R7 02）：复用设置域的串行链，成功后**立刻**重探可用性 ——
   * 宿主的 30s 缓存在 saveSettings 成功时失效，客户端这份也要马上换成新结论，
   * 否则设置页刚选完模型，文章面的「译」按钮要等下一次面板加载才出现。
   */
  const saveTranslateRoute = async (patch: TranslateRouteSettingsPatch): Promise<Awaited<ReturnType<typeof settingsActions.saveTranslateRoute>>> => {
    const result = await settingsActions.saveTranslateRoute(patch)
    if (result.ok) await translateActions.loadTranslateInfo()
    return result
  }

  // 探索域（R8b 04）：订阅只经 feedActions.addFeed（唯一入口），探索自己不碰 feeds 真相。
  const exploreActions = createExploreActions({
    get, set, rpc: deps.rpc, addFeed: feedActions.addFeed,
  })

  return {
    subscribe: (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    get, submitSearch: (query?: SearchQuery) => searchActions.submit(query),
    refreshCount, setReading,
    /** 面板卸载时落一次待写的阅读位置与列表滚动位置（没有待写值时不写）。 */
    flushViewMemory,
    /** 列表滚动位置（R2-02）：只改模块内的值 + 300ms 去抖写，不触发渲染。 */
    rememberListScrollTop,
    /** 取一次恢复的滚动位置（按传入的最大可滚位置夹取）；取过即清空，用户已滚过则放弃。 */
    takeListScrollTop,
    ...navActions, ...opmlActions, ...feedActions,
    dismissNotice: (): void => { set({ notice: undefined }) },
    ...listActions,
    ...folderActions,
    ...tagActions,
    ...settingsActions,
    saveTranslateRoute,
    ...translateActions,
    ...exploreActions,
  }
}

export type ReaderStore = ReturnType<typeof createReaderStore>

/** 订阅 store 并强制重渲染。 */
export function useReaderStore(store: ReaderStore): ReaderState {
  const [, force] = useState(0)
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store])
  return store.get()
}

