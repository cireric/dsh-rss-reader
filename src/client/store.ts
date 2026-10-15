/**
 * 阅读器的状态与数据通道（2026-10-07 从 index.tsx 拆出）。
 *
 * 这里只有状态与副作用，没有任何 JSX：对组件而言它是一个深模块 —— 组件只通过 get()/subscribe()
 * 与那几个动作方法使用它，不关心数据怎么来。拆出的直接理由见评审：原文件 1169 行、同时承担状态、
 * 列表、正文、订阅管理与键盘接线，任一改动都要动同一个文件。
 */
import { useEffect, useState } from 'react'
import { ROUTE_PATH, recencyOf, sanitizeViewPreferences, type ArticlePayload, type CleanupResult, type Endpoint, type FeedView, type ItemView, type OpmlExportResult, type OpmlImportResult, type Overview, type RpcResult, type UnreadAccount, type ViewPreferences } from '../shared.js'

export type Filter = 'all' | 'unread' | 'starred'

/**
 * 导航选中：虚拟视图（跨源聚合）或某个具体订阅源。
 *
 * 与 Filter 是**两条正交的轴**且叠加生效（源 × 过滤），不是二选一 —— 所以这里不引入
 * 第四个「当前视图」概念：view 看面板、layout 看密度、filter 看全局过滤、navSelection 看导航选中。
 */
export type NavSelection = { kind: 'virtual' } | { kind: 'feed'; feedId: string }

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
export type NavCursor = { kind: 'filter'; filter: Filter } | { kind: 'feed'; feedId: string }

/**
 * 虚拟视图三行：全部 / 未读 / 星标。
 *
 * 顶栏那组 filter 按钮与左栏导航的三行是**同一份东西**（左栏是顶栏的镜像），所以这个顺序只定义
 * 在这里一处：键盘光标的行序、顶栏按钮的顺序、左栏渲染的顺序都读它。三处各写一份迟早错位。
 */
export const VIRTUAL_VIEWS: ReadonlyArray<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'unread', label: '未读' },
  { key: 'starred', label: '星标' },
]

/**
 * 左栏导航的行序：虚拟视图三行 + 订阅源。
 *
 * 顺序即**界面顺序**（feed-nav.tsx 自上而下渲染的就是它），键盘上下移动必须与眼睛看到的那一列
 * 同序 —— 换个顺序不影响单步移动，但会让「按一下 shift+n 跳到不相邻的那一行」。
 */
export function navRowsOf(feeds: ReadonlyArray<Pick<FeedView, 'id'>>): NavCursor[] {
  return [
    ...VIRTUAL_VIEWS.map((view): NavCursor => ({ kind: 'filter', filter: view.key })),
    ...feeds.map((feed): NavCursor => ({ kind: 'feed', feedId: feed.id })),
  ]
}

/** 光标 → 行 id；与 feed-nav.tsx 的 `data-rss-nav-row` 逐字同构（`filter:<key>` / `feed:<id>`）。 */
export function navCursorKey(cursor: NavCursor): string {
  return cursor.kind === 'filter' ? 'filter:' + cursor.filter : 'feed:' + cursor.feedId
}

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
  /** 订阅管理里的忙碌标记（导入要逐源抓取，可能数秒） */
  feedsBusy: boolean
  /** 一次性提示（如清理结果）：显示后由用户下一个动作清掉，不设定时器 */
  notice: string | undefined
  article: ArticleState | undefined
  /** 导航选中（虚拟视图 / 某个具体源）。与 filter 叠加生效，见 NavSelection。 */
  navSelection: NavSelection
  /** 导航**光标**（左栏键盘高亮所在行）。与 navSelection 是两件事，见 NavCursor。 */
  navCursor: NavCursor
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
   * 续页游标（Overview.nextCursor，keyset）：**原样**回带给下一次 overview 调用。
   *
   * 客户端不解释它的内容（格式 `"<recency>|<id>"` 由宿主定义，见 src/shared.ts 的 decodeCursor）——
   * 它只是一张「我读到哪儿了」的票据。缺省 = 已经到底，界面不再给「加载更多」的入口。
   */
  nextCursor: string | undefined
  /** 续页在途（防连点堆请求：每次请求都要过一次 SQL + 一次 feeds 文件读）。 */
  loadingMore: boolean
}

/**
 * 调一个端点并解信封；失败抛出 `code: message`，由面板渲染。
 *
 * endpoint 收的是 shared.ts 的 Endpoint（= ENDPOINT_NAMES 派生）：拼错名字从「运行时收一个
 * unknown-endpoint」变成**编译错误**。这是本文件与宿主之间唯一的那条 seam，值得有类型。
 */
async function callRpc<T>(endpoint: Endpoint, payload?: unknown): Promise<T> {
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
    navSelection: { kind: 'virtual' }, perFeedUnread: {}, navVisible: true,
    nextCursor: undefined, loadingMore: false,
    // 光标初值 = 与初始 filter 一致的那一行（初始 filter 是 'all'，故就是「全部」那一行）：
    // 「我停在哪」与「此刻生效的是哪」在开局是同一行，之后才由 shift+n/p 与 shift+o 分开。
    navCursor: { kind: 'filter', filter: 'all' },
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
  /**
   * 「源 + 过滤」双条件是否成立——两者相乘，不是二选一。
   *
   * 单独抽出来是因为它有第二个使用面：切视图后要把 selectedId 落到新列表第一条
   * （setFilter 的既有 precedent），那个判定必须与 visible() 用的**同一个**，否则迟早出现
   * 「列表里选着一个自己都看不见的条目」。
   */
  const inScope = (item: ItemView): boolean => {
    if (state.navSelection.kind === 'feed' && item.feedId !== state.navSelection.feedId) return false
    if (state.filter === 'unread') return item.readAt === undefined
    if (state.filter === 'starred') return item.starred
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
  }

  const applyOverview = (overview: Overview): void => {
    const selected = state.selectedId
    const stillThere = selected !== undefined && overview.items.some((item) => item.id === selected)
    set({
      items: overview.items,
      feeds: overview.feeds,
      unread: overview.unread,
      perFeedUnread: overview.perFeedUnread,
      // 第一页的游标由宿主给（缺省 = 这一页就是全部）。整份重取时它必须**跟着换掉**：
      // 沿用旧游标会让下一页从旧快照的边界开始，追加出一段不连续的历史。
      nextCursor: overview.nextCursor,
      loading: false,
      error: undefined,
      selectedId: stillThere ? selected : undefined,
    })
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
    const known = new Set(state.feeds.map((feed) => feed.id))
    const prefs = sanitizeViewPreferences(raw, (feedId) => known.has(feedId))
    set({
      navSelection: prefs.navSelection,
      filter: prefs.filter,
      navVisible: prefs.navVisible,
      navCursor: prefs.navSelection.kind === 'feed'
        ? { kind: 'feed', feedId: prefs.navSelection.feedId }
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
      navSelection: state.navSelection.kind === 'feed'
        ? { kind: 'feed', feedId: state.navSelection.feedId }
        : { kind: 'virtual' },
      filter: state.filter,
      navVisible: state.navVisible,
    }
    viewWriteChain = viewWriteChain
      .then(() => callRpc('saveViewPreferences', { preferences }))
      // 写盘失败要有可见后果（AGENTS.md 禁空 catch）：进 error 让面板说出来。
      // 界面状态不回滚 —— 它与「能不能记住」是两件事，把左栏再翻回去只会让用户更困惑。
      .then(() => {}, (failure: unknown) => {
        set({ error: failure instanceof Error ? failure.message : String(failure) })
      })
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
      const result = await callRpc<{ preferences?: unknown }>('viewPreferences')
      return result?.preferences
    } catch (failure) {
      console.warn('[rss-reader] 读取视图记忆失败，本次按默认态使用', failure)
      return undefined
    }
  }

  const load = async (endpoint: 'overview' | 'refresh'): Promise<void> => {
    set({ loading: true })
    try {
      // 恢复必须在 feeds 表到手之后生效（未知源要回落），所以**先读、后应用**：
      // 读一次拿到记忆，等 overview 落地再按在订的源校验。两次 load 并发时也只读一次。
      const preferences = viewRestored ? undefined : await readViewPreferences()
      const overview = await callRpc<Overview>(endpoint)
      applyOverview(overview)
      if (!viewRestored) applyRestoredView(preferences)
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
    set({ loadingMore: true })
    try {
      const overview = await callRpc<Overview>('overview', { cursor })
      // 追加拼在**当前** state 上（不是闭包里那份快照）：请求在途时用户可能已经标读/加星，
      // 用发请求前的 items 覆盖会把那些本地动作抹掉。
      set({ items: [...state.items, ...overview.items], nextCursor: overview.nextCursor })
      applyAccount(overview)
      set({ loadingMore: false, error: undefined })
    } catch (failure) {
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

  const markRead = async (itemId: string): Promise<void> => {
    const target = state.items.find((item) => item.id === itemId)
    if (target?.readAt !== undefined) return
    patchItem(itemId, { readAt: new Date().toISOString() })
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
    try {
      // 宿主回包带着每源账目，落地时以它为准 —— 本地那笔只是乐观镜像
      applyAccount(await callRpc<UnreadAccount>('markRead', { itemIds: [itemId] }))
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
    // 同上：取消已读要把这条账加回**它所属源**，否则角标会比顶栏少一
    set({
      unread: state.unread + 1,
      perFeedUnread: { ...state.perFeedUnread, [item.feedId]: (state.perFeedUnread[item.feedId] ?? 0) + 1 },
    })
    try {
      // 同 markRead：撤销也以宿主回包为准（截断场景下本地增量看不见的账由回包纠正）
      applyAccount(await callRpc<UnreadAccount>('unmarkRead', { itemIds: [item.id] }))
    } catch (failure) {
      patchItem(item.id, { readAt: item.readAt })
      set({
        unread: Math.max(0, state.unread - 1),
        perFeedUnread: { ...state.perFeedUnread, [item.feedId]: Math.max(0, (state.perFeedUnread[item.feedId] ?? 0) - 1) },
        error: failure instanceof Error ? failure.message : String(failure),
      })
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
      // 乐观更新也要带上每源账目：否则从按下 A 到宿主回包之间，左栏角标停在旧数上。
      // 基线用宿主下发的那份（含截断之外的账），只按本批 ids 增量减。
      perFeedUnread: shiftPerFeedUnread(ids, -1),
      undo: { ids },
    })
    armUndoExpiry()
    try {
      // 回包里同时有 unread 与 perFeedUnread（宿主按全量表算的真值），整体覆盖本地那份乐观镜像：
      // 只覆盖 unread 会把「本地看不见的外部漂移」留在 perFeedUnread 里 ⇒ 幽灵未读（任务 9 实测）。
      const result = await callRpc<UnreadAccount>('markRead', { itemIds: ids, skipKept: true, before })
      applyAccount(result)
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
    }
  }

  const undoMarkAll = async (): Promise<void> => {
    const undo = state.undo
    if (undo === undefined) return
    clearUndoExpiry()
    set({ undo: undefined })
    set({
      items: state.items.map((item) => (undo.ids.includes(item.id) ? { ...item, readAt: undefined } : item)),
      perFeedUnread: shiftPerFeedUnread(undo.ids, 1),
    })
    try {
      // 同上：撤销同样以宿主回包为准（否则会把外部漂移那部分凭空加回去）
      applyAccount(await callRpc<UnreadAccount>('unmarkRead', { itemIds: undo.ids }))
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
    const cancelled = next.kind === 'feed' && current.kind === 'feed' && current.feedId === next.feedId
    if (cancelled || next.kind === 'virtual') {
      // 退出源作用域时把光标带回「生效的那一行」：navSelection 变回 virtual、filter 归 'all'，
      // 生效的就是「全部」，光标留在刚开过的那个源上会与左栏高亮自相矛盾
      // （读者看到源行还停着光标，可右栏已经是聚合视图）。
      set({ navSelection: { kind: 'virtual' }, filter: 'all', navCursor: { kind: 'filter', filter: 'all' } })
    } else {
      set({ navSelection: next, navCursor: { kind: 'feed', feedId: next.feedId } })
    }
    relocateSelection()
    persistView()
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
    const rows = navRowsOf(state.feeds)
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
  const openNavCursor = (): void => {
    const cursor = state.navCursor
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
    get, visible, load, loadMore, markRead, selectRelative, openSelected, toggleStar, toggleKeepUnread, toggleRead, markAllRead, undoMarkAll,
    setLayout, setMarkAllRange, setShowUnread, refreshCount,
    openArticle, closeArticle, cleanup, stepArticle, canStepArticle,
    toggleFeeds, exportOpml, importOpml, addFeed, removeFeed,
    dismissNotice: (): void => { set({ notice: undefined }) },
    setFilter,
    select: (itemId: string): void => { set({ selectedId: itemId }) },
    selectNav,
    moveNavCursor,
    openNavCursor,
    toggleNav,
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

