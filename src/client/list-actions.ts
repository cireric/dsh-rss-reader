/**
 * 列表域的动作（阶段 4b 票据 06a/06b/06c：可见集合、账目管线、取数与正文）。
 *
 * 06a 搬进来七个成员：visible / setFilter / setLayout / setMarkAllRange / setShowUnread / select /
 * selectRelative，连同它们共用的两个内部判据 inScope / relocateSelection。
 * 06b 搬进来六个走 account-mirror 的动作（markRead / toggleStar / toggleKeepUnread / toggleRead /
 * markAllRead / undoMarkAll）与它们共用的 5000ms 撤销窗口（身份 CAS 在 undoMarkAll 的回滚里），
 * 外加两个直接下游 activate / openSelected（「打开即已读」与 v 键）。
 * 06c 搬进来取数与分页（load / loadMore / cleanup）和正文动作（openArticle / retryArticle /
 * stepArticle / canStepArticle / closeArticle / saveArticleProgress，以及它们内部的 loadArticle）——
 * 这一块是所有域的汇合点，所以最后搬。
 *
 * 为什么按这个顺序切：06a 是纯读 + 小状态；06b 的六个动作共用一条「乐观 → RPC → 覆盖 / 回滚」
 * 管线，拆到两个文件会让「失败统一回滚」的判据跨文件各说各话；06c 同时依赖前两块与搜索域，
 * 放最后才不会「同时移动地基和墙」。
 *
 * 写入边界（见 store.ts 顶部的四块边界表）：拥有 items / selectedId / nextCursor / loadingMore /
 * filter / layout / markAllRange / undo；账目 unread / perFeedUnread / unreadSplit 与它们的档位标记
 * accountWindow 只由账目回包整份覆盖（applyAccount / applyOverview），其中 applyAccount 会丢弃
 * 与当前档位不一致的过期回包。feeds / tags 只读，**唯一例外**是 overview 整份落地（applyOverview
 * 与 load 的搜索分支按宿主快照原样写回目录，已在边界表登记）。
 */
import { httpUrlOrEmpty, type ArticlePayload, type CleanupResult, type ItemView, type Overview } from '../shared.js'
import type { UnreadAccount } from '../unread.js'
import { recencyOf } from '../cursor.js'
import type { DisplayWindowRange } from '../display-window.js'
import { createAccountMirror } from './account-mirror.js'
import { selectionExists } from './nav-model.js'
import { relativeTime } from './relative-time.js'
import { displayWindowRequestOf, type DisplayWindowRequest } from './window-control.js'
import type { Filter, MarkAllRange, ReaderState, ReaderStoreDeps } from './store.js'

/** 「全部标记已读」的撤销窗口（跟着 undo 状态走，所以在列表域这一侧）。 */
const UNDO_WINDOW_MS = 5000

/** 「全部标为已读」的四个范围对应的天数；all = 不设阈值（MarkAllRange 类型本身是公开面，留在 store.ts）。 */
const RANGE_DAYS: Record<MarkAllRange, number | undefined> = { all: undefined, day: 1, week: 7, month: 30 }

export interface ListActionHost {
  get: () => ReaderState
  /** 与宿主的唯一通道（账目动作、取数与正文都走它）。 */
  rpc: ReaderStoreDeps['rpc']
  set: (patch: Partial<ReaderState>) => void
  /** 切过滤是「关键动作」：要写视图记忆（persistView 的归属仍按票据 05 的裁定留在 store）。 */
  persistView: () => void
  /**
   * 阅读位置（R2-01）：纯选中 / j/k / 打开条目都算「用户已动手」，并安排一次 300ms 去抖写。
   *
   * 为什么不是一个纯标志：这些动作和「恢复」共用 touched 判据（恢复不得覆盖用户刚选的行），
   * 而写入又要防抖 —— 两件事必须在同一处发生，否则迟早出现「置了标志却没记住位置」。
   */
  rememberSelection: () => void
  /** 搜索域：setFilter 的 reset 与 load / loadMore 的搜索分支共用同一组入口。 */
  search: {
    reset: () => void
    load: (cursor?: string, pages?: number) => Promise<void>
    abort: () => void
    loadedPages: () => number
    inFlight: () => boolean
  }
  /** 共享列表版本号（搜索域也用它判过期；只有 load 的搜索分支会 ++）。 */
  nextListVersion: () => number
  currentListVersion: () => number
  /** 视图记忆：读 / 应用 / 「是否已恢复」三件事都留在 store（与 persistView 同族）。 */
  viewMemory: {
    restored: () => boolean
    read: () => Promise<unknown>
    apply: (raw: unknown) => void
  }
  /** 跨源重复提示：overview 落地后批量查一次（搜索域也用同一份实现）。 */
  refreshDuplicateHints: () => void
  /** 诊断输出（阅读进度保存失败只记录，不弹错）。 */
  log: ReaderStoreDeps['log']
  /** 现在几点（毫秒）：readAt 时间戳与「全部标已读」的范围阈值都用它。 */
  now: () => number
  /** 撤销窗口的定时器（与 store 的 deps 同一份，测试可以捕获而不真排程）。 */
  setTimeout: (handler: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  /** 外部浏览器打开（v 键）。 */
  open: (url: string) => void
}

export function createListActions(host: ListActionHost) {
  const {
    get, set, rpc, persistView, rememberSelection, search, nextListVersion, currentListVersion, viewMemory,
    refreshDuplicateHints, log, now, setTimeout, clearTimeout, open,
  } = host

  /**
   * 「源 + 过滤」双条件是否成立——两者相乘，不是二选一。
   *
   * 单独抽出来是因为它有第二个使用面：切视图后要把 selectedId 落到新列表第一条
   * （setFilter 的既有 precedent），那个判定必须与 visible() 用的**同一个**，否则迟早出现
   * 「列表里选着一个自己都看不见的条目」。
   */
  const inScope = (item: ItemView): boolean => {
    const state = get()
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
    const state = get()
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
  const relocateSelection = (): void => {
    const state = get()
    set({ selectedId: state.items.filter(inScope)[0]?.id })
  }

  /**
   * 切作用域必须退出「临时呈现视图」（正文 / 设置页）—— `selectNav` / `setFilter` / `setWindow`
   * 共用的唯一入口。
   *
   * **病象**：正在看正文时点另一个源 / 文件夹 / 标签，或切「未读 / 星标」过滤，右栏仍停在上一篇——
   * 它已经不属于当前作用域，读者看到的是「作用域变了、内容却没变」的自相矛盾。设置页同理：
   * 左栏点了没反应，用户只会认为坏了（spec D21）。
   *
   * **根因**：这几个动作只改作用域状态，没人收回跨域呈现状态 `view` / `article`。两样必须一起清：
   * 正文面的唯一真相是 `article.itemId`，只把 `view` 改回列表会留下旧 `article`，而在途的正文回包
   * 仍会命中 `loadArticle` 的 `get().article?.itemId` 守卫，把一篇已经离开作用域的文章重新画回来。
   *
   * **为什么名字不叫 leaveArticleForScope**：R11 01 起它还要收设置页；叫「退出正文」会让下一个人
   * 在 settings 分支上误以为这里只该管 article。设置页没有「内容快照」要清（`settings` 保留着，
   * 下次进入先用旧值再刷新），所以只需把 view 落回列表。
   *
   * **边界**：只接这三个入口。视图恢复、Esc 关闭（`closeArticle`）与搜索提交各有自己的语义，
   * 不要顺手接上来 —— 关闭正文后保留 `article` 是阅读进度落盘要用的。
   */
  const leaveTransientViews = (): void => {
    const view = get().view
    if (view === 'article') set({ view: 'list', article: undefined })
    else if (view === 'settings') set({ view: 'list' })
  }

  /**
   * 切换全局过滤（顶栏那组按钮 / 左栏虚拟视图三行 / 键盘打开虚拟视图行都走它）。
   *
   * 光标同步（2026-10-10 任务 6 返工）：换 filter 就是「当前项换了一行」，光标跟着落到那一行，
   * 否则键盘接着 shift+n 会从旧位置跳。**无条件同步**是一条规则、没有特例：光标只表示「我停在哪行」，
   * 而「哪一行此刻生效」由 selected 标记独立表达（选着源时它仍亮在源那一行 —— 规格 §2.1 的叠加）。
   */
  const setFilter = (filter: Filter): void => {
    // 换过滤也是换作用域：正文里切「未读 / 星标」必须回列表，旧文章不属于新过滤。
    leaveTransientViews()
    set({ filter, navCursor: { kind: 'filter', filter } })
    relocateSelection()
    persistView()
    search.reset()
  }

  /** 切视图密度。默认 list = 本插件既有的紧凑行为，所以切成 expanded 是「多显示」而不是改默认。 */
  const setLayout = (layout: ReaderState['layout']): void => { set({ layout }) }

  /** 切「全部标为已读」的时间范围。 */
  const setMarkAllRange = (markAllRange: MarkAllRange): void => { set({ markAllRange }) }

  /**
   * 隐藏 / 显示未读计数（规格 §5 不变量 8）。只影响呈现，不动数据。
   *
   * R11 05 / D27.2：它不再是纯内存状态 —— 搬进设置页后必须记住，所以改完就整份落一次盘
   * （persistView 带上当下 showUnread，与 navVisible / reading 同属一份视图记忆）。
   * 这里仍是离散动作（点一下复选框），不需要防抖。
   */
  const setShowUnread = (showUnread: boolean): void => {
    set({ showUnread })
    persistView()
  }

  /** 纯选中：只挪光标，**不**标已读、不展开（要副作用请走 activate —— 「打开一条」的唯一触发点）。 */
  const select = (itemId: string): void => {
    set({ selectedId: itemId })
    // 阅读位置（R2-01）：纯选中也是「用户已动手」——迟到的恢复不许覆盖它，且这次选择要被记住。
    rememberSelection()
  }

  /**
   * j/k：**只移动选中，不标已读**（用户 2026-10-06 明确要求）。
   *
   * ⚠️ 这是对 Google Reader 的**有意偏离**——GR 里 j/k 扫过即标已读。别当 bug 改回去：
   * 已读只由「打开条目」触发（o / Enter / 鼠标点击）以及显式的 m。
   */
  const selectRelative = (delta: number): void => {
    const state = get()
    const list = visible()
    if (list.length === 0) return
    const current = list.findIndex((item) => item.id === state.selectedId)
    const nextIndex = current < 0
      ? (delta > 0 ? 0 : list.length - 1)
      : Math.min(list.length - 1, Math.max(0, current + delta))
    const target = list[nextIndex]
    if (target === undefined) return
    set({ selectedId: target.id })
    rememberSelection()
  }

  // ── 账目管线与撤销窗口（票据 06b）─────────────────────────────────────────────
  // 六个动作共用「乐观 → RPC → 覆盖 / 回滚」，判据之家在 src/client/account-mirror.ts 头部；
  // 这里只留守卫与载荷组装。六个动作与撤销窗口必须住在同一个文件：把「失败统一回滚」拆到两处，
  // 判据就会跨文件各说各话（票据 06b 的验收项）。

  /**
   * 撤销窗口的定时器。
   *
   * 2026-10-07 修：原先只往 state.undo.until 写了个时间戳，全仓没有任何地方读它，于是
   * 「5 秒撤销窗口」名存实亡——撤销条一直挂着，想撤多久撤多久（README 承诺的是 5 秒）。
   */
  let undoExpiry: unknown
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

  /** 就地改一条的本地镜像，避免每次操作都整份重取。 */
  const patchItem = (itemId: string, patch: Partial<ItemView>): void => {
    set({ items: get().items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)) })
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
   * 所以标读端点**必须回 perFeedUnread**（unread.ts 的 UnreadAccount），客户端照单全收：
   * 这与任务 1 拒绝「客户端从 items 派生 perFeedUnread」是同一条理由 —— 口径只能由宿主给。
   * 乐观更新仍由调用方先做（手感），回包到达时以宿主为准纠正。
   */
  const applyAccount = (account: UnreadAccount, window: DisplayWindowRange): void => {
    // 账目跟着窗口走（R1 评审 P1）：`window` 是**发请求那一刻**的档位。回包在途时用户可能已经
    // 切到别的档位，这份账就只描述旧窗口 —— 整份丢弃，不能拿它填新窗口的顶栏和角标。
    // 顶栏 / 左栏 / 侧栏在「未对齐」期间由 index.tsx 统一显示 pending（见 ReaderState.accountWindow）。
    if (window !== get().displayWindow) return
    // unreadSplit 也整份覆盖（R1 04）：回包缺席 ⇒ state 里也缺席（不沿用上一份）。
    // 客户端绝不本地推导三分、也不按动作做增量 —— 那是「拿截断视图当真相」的同一类错误。
    set({
      unread: account.unread,
      perFeedUnread: account.perFeedUnread,
      unreadSplit: account.unreadSplit,
      accountWindow: window,
    })
  }

  /**
   * **仅供乐观更新**：按本批「本地看得见、且确实被标掉」的条目增量调整本地镜像，让角标从按下那一刻
   * 就动起来。它**不是**账目的真相来源 —— 真相只在宿主回包里（见 applyAccount）。
   *
   * 键域 = 宿主下发的键（0 未读的源也必须留键）；对不上号的 id（不在 items 里、或其源无键）跳过，
   * 不猜源、不造键。回包一到就被整体覆盖，所以这里算少/算错都不会留在界面上。
   */
  const shiftPerFeedUnread = (ids: readonly string[], delta: number): Record<string, number> => {
    const state = get()
    const next: Record<string, number> = { ...state.perFeedUnread }
    for (const id of ids) {
      const feedId = state.items.find((item) => item.id === id)?.feedId
      if (feedId === undefined || next[feedId] === undefined) continue
      next[feedId] = Math.max(0, next[feedId] + delta)
    }
    return next
  }

  /**
   * 发请求那一刻的档位 + wire 字段 —— 客户端**唯一**的窗口载荷构造器入口（R1-03，spec 决策 15 / 28）。
   *
   * 列表取数（overview / refresh）、续页与账目动作三处都只经它取 `from` / `to`；账目镜像在发请求前
   * 把同一份字段并进动作载荷。边界算术仍归 src/display-window.ts，本函数只做「档位 + 现在 → 载荷」。
   *
   * 为什么连档位一起返回（R1 评审 P1）：回包落地时要用**发请求时**的档位判断这份账属于谁，
   * 所以档位和载荷必须同一次取出（见 window-control.ts 的 DisplayWindowRequest）。
   * 每次请求现取 `now`：跨零点后下一次取数用新的「今天」，面板不为它设定时器（spec 决策 7）。
   */
  const windowRequest = (): DisplayWindowRequest =>
    displayWindowRequestOf(get().displayWindow, new Date(now()))

  /**
   * 六个动作共用「乐观 → RPC → 覆盖 / 回滚」管线（失败统一回滚，2026-10-16 拍板）。
   * 动作 × 行为的判据之家在 src/client/account-mirror.ts 头部 —— 这里只留守卫与载荷组装。
   */
  const mirror = createAccountMirror({
    callRpc: rpc,
    windowRequest,
    applyAccount,
    fail: (failure) => { set({ error: failure instanceof Error ? failure.message : String(failure) }) },
  })

  const markRead = async (itemId: string): Promise<void> => {
    const target = get().items.find((item) => item.id === itemId)
    if (target?.readAt !== undefined) return
    // 快照在按下前取：失败回滚 = 恢复到「动作没发生」（account-mirror 不变量 ②——
    // 不用反向增量：Math.max 夹到 0 的减量没法用加法精确还原）
    const stamp = new Date(now()).toISOString()
    const beforeUnread = get().unread
    const beforePerFeed = get().perFeedUnread
    await mirror.run({
      endpoint: 'markRead',
      payload: { itemIds: [itemId] },
      optimistic: () => {
        patchItem(itemId, { readAt: stamp })
        // 左栏角标（perFeedUnread）与顶栏总数（unread）是同一条守恒式的两边——各源之和 === unread。
        // 只减 unread 会让界面自相矛盾：角标还写着 3、顶栏已经 2（index.tsx:374 与 :385 分读两处）。
        // 宿主侧 unread 由 countUnread 重算，客户端这一侧的每源账目必须跟着一起补。
        set(target === undefined
          ? { unread: Math.max(0, get().unread - 1) }
          : {
            unread: Math.max(0, get().unread - 1),
            perFeedUnread: {
              ...get().perFeedUnread,
              [target.feedId]: Math.max(0, (get().perFeedUnread[target.feedId] ?? 0) - 1),
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
   * 「打开一条」= 选中 + 标已读。**已读的唯一自动触发点**：行点击 / Enter / Space / o / v / 正文加载。
   *
   * 展开状态不进 store（2026-10-15 键盘路由轮的裁决 Q2），调用方用 nextExpandedOf 决定它。
   * 为什么收成一个动作：此前五个入口各拼一遍「选中 + 展开 + 标已读」，其中行内 Enter 那一版
   * 把展开写成了「恒展开」—— 同一条规则写五遍，迟早有一个版本不一样。
   */
  const activate = (itemId: string): void => {
    set({ selectedId: itemId })
    // 打开条目也是「用户已动手」：它既可能发生在恢复到达之前（选中必须让给用户），
    // 也要被记进阅读位置 —— 正文里关面板时，flush 靠的就是这一次选中。
    rememberSelection()
    void markRead(itemId)
  }

  /**
   * v：用系统浏览器打开原站（新标签页）。
   *
   * **打开即视为已读**（用户 2026-10-06 定）：与内置详情页 `V`、列表点击三条路径保持一致——
   * 同一类动作（打开条目）语义相同，否则会出现「内置打开算已读、外部打开不算」这种只能靠
   * 读源码才发现的差异。GR 里的 `v`（view original）同样是阅读动作，不与已读语义冲突。
   */
  const openSelected = (): void => {
    const item = visible().find((entry) => entry.id === get().selectedId)
    if (item === undefined) return
    // 历史行可能带脏 link（修复前落库的 javascript:）：window.open 前过 shared.ts 的唯一白名单。
    // 认不出就当「无链接」——不打开新窗口、也不标已读（动作没发生）。
    const href = httpUrlOrEmpty(item.link)
    if (href === '') return
    open(href)
    activate(item.id)
  }

  const toggleStar = async (): Promise<void> => {
    const item = visible().find((entry) => entry.id === get().selectedId)
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
    const item = get().items.find((entry) => entry.id === itemId)
    if (item === undefined) return
    await mirror.run({
      endpoint: 'toggleKeepUnread',
      payload: { itemId },
      optimistic: () => { patchItem(itemId, { keptUnread: item.keptUnread !== true }) },
      rollback: () => { patchItem(itemId, { keptUnread: item.keptUnread }) },
    })
  }

  const toggleRead = async (): Promise<void> => {
    const item = visible().find((entry) => entry.id === get().selectedId)
    if (item === undefined) return
    if (item.readAt === undefined) {
      await markRead(item.id)
      return
    }
    const beforeUnread = get().unread
    const beforePerFeed = get().perFeedUnread
    await mirror.run({
      endpoint: 'unmarkRead',
      payload: { itemIds: [item.id] },
      optimistic: () => {
        patchItem(item.id, { readAt: undefined })
        // 同上：取消已读要把这条账加回**它所属源**，否则角标会比顶栏少一
        set({
          unread: get().unread + 1,
          perFeedUnread: { ...get().perFeedUnread, [item.feedId]: (get().perFeedUnread[item.feedId] ?? 0) + 1 },
        })
      },
      rollback: () => {
        patchItem(item.id, { readAt: item.readAt })
        set({ unread: beforeUnread, perFeedUnread: beforePerFeed })
      },
    })
  }

  /**
   * A 的候选名单与范围阈值 —— **唯一判据**（2026-11-21）。
   *
   * 为什么必须抽出来：确认框要显示「将标记 N 条」，markAllRead 要发同一批 id。两处各写一遍
   * 筛选条件，等下一次改语义（比如 keptUnread 或范围口径）就会静默分家：确认框说 12 条、
   * 实际标 9 条，而没有任何用例能同时看见两处（ADR-0001：判据只有一个裁决者）。
   *
   * **保持未读的条目要活下来**（规格 §3.3）——这正是 kept-unread 的存在理由。本地乐观更新与请求
   * 两处都要跳过；宿主侧也会按 skipKept 再挡一次（客户端列表只是快照）。
   */
  /** A 的范围阈值（早于 X）：`markAllPlan` 与范围标读共用这一条推导。 */
  const beforeOf = (range: MarkAllRange): string | undefined => {
    const days = RANGE_DAYS[range]
    return days === undefined ? undefined : new Date(now() - days * 24 * 3600 * 1000).toISOString()
  }

  const markAllPlan = (range: MarkAllRange = get().markAllRange): { ids: string[]; before: string | undefined } => {
    const before = beforeOf(range)
    const ids = visible()
      .filter((item) => item.readAt === undefined && item.keptUnread !== true)
      // 范围阈值同样判两次：这里决定乐观更新与名单，宿主那边再按 before 挡一次
      .filter((item) => before === undefined || recencyOf(item) < before)
      .map((item) => item.id)
    return { ids, before }
  }

  /**
   * A 的范围（ADR-0008）。`undefined` = 搜索态 —— 搜索结果由查询决定，不是库的一个范围，
   * 只能按已加载的 itemIds 快照标（行为与本轮之前逐字相同）。
   * 虚拟视图（全部/未读/星标）用 `all: true`：整个库按显示窗与过滤求值。
   */
  const markAllScopeOf = (state: ReaderState):
    | { feedId: string } | { folder: string } | { tagId: string } | { all: true } | undefined => {
    if (state.search !== undefined) return undefined
    const nav = state.navSelection
    if (nav.kind === 'feed') return { feedId: nav.feedId }
    if (nav.kind === 'folder') return { folder: nav.folder }
    if (nav.kind === 'tag') return { tagId: nav.tagId }
    return { all: true }
  }

  /**
   * 确认框的条数（ADR-0008）：范围路径问宿主（`dryRun`，只数不写），搜索态用本地快照。
   *
   * 为什么不复用 `markAllPlan().ids.length`：那份快照只看得见已加载页 —— 正是「源里 19 条未读
   * 却显示 0 条」的由来。条数必须与宿主真正要标的集合同源，否则确认框会说谎。
   */
  const countMarkAllCandidates = async (): Promise<number | undefined> => {
    const state = get()
    const scope = markAllScopeOf(state)
    if (scope === undefined) return markAllPlan(state.markAllRange).ids.length
    const before = beforeOf(state.markAllRange)
    const request = displayWindowRequestOf(state.displayWindow, new Date(now()))
    const reply = await rpc<{ count?: number }>('markRead', {
      ...scope,
      skipKept: true,
      ...(state.filter === 'starred' ? { starred: true } : {}),
      ...(before === undefined ? {} : { before }),
      dryRun: true,
      ...request.payload,
    })
    return reply?.count
  }

  /** A：把**当前列表**的未读全部标为已读，留一个短时撤销窗口。 */
  const markAllRead = async (): Promise<void> => {
    const state = get()
    const scope = markAllScopeOf(state)
    const before = beforeOf(state.markAllRange)
    const starred = state.filter === 'starred'

    if (scope !== undefined) {
      // 范围路径（ADR-0008）：候选由宿主在库全量上求值，客户端只给条件。
      // 乐观更新只覆盖**已加载**的可见条目（读者眼前的那批），其余由宿主处理；
      // 撤销条的 id 集合等回包 —— 只有宿主知道它到底改了哪些（可能上千条）。
      const beforeItems = get().items
      const beforeUnread = get().unread
      const beforePerFeed = get().perFeedUnread
      const stamp = new Date(now()).toISOString()
      const optimisticIds = visible()
        .filter((item) => item.readAt === undefined && item.keptUnread !== true)
        .filter((item) => before === undefined || recencyOf(item) < before)
        .map((item) => item.id)
      const reply = await mirror.run({
        endpoint: 'markRead',
        payload: {
          ...scope,
          skipKept: true,
          ...(starred ? { starred: true } : {}),
          ...(before === undefined ? {} : { before }),
        },
        optimistic: () => {
          if (optimisticIds.length === 0) return
          // 乐观更新只覆盖**已加载**的可见条目：读者眼前先变，未加载的由宿主处理。
          // 账目也按这一批当场减 —— 左栏角标要跟手；回包随后按宿主全量整体覆盖（不变量 ①）。
          set({
            items: get().items.map((item) => (optimisticIds.includes(item.id) ? { ...item, readAt: stamp } : item)),
            unread: Math.max(0, get().unread - optimisticIds.length),
            perFeedUnread: shiftPerFeedUnread(optimisticIds, -1),
          })
        },
        rollback: () => { set({ items: beforeItems, unread: beforeUnread, perFeedUnread: beforePerFeed }) },
      })
      if (reply === undefined) return
      const ids = reply.ids ?? []
      if (ids.length === 0) { set({ undo: undefined }); clearUndoExpiry(); return }
      set({ undo: { ids: [...ids] } })
      armUndoExpiry()
      return
    }

    const { ids } = markAllPlan(state.markAllRange)
    if (ids.length === 0) return
    const stamp = new Date(now()).toISOString()
    const beforeUnread = get().unread
    const beforePerFeed = get().perFeedUnread
    const beforeItems = get().items
    // 连按两次 A、第二次失败时，第一条的撤销窗口还没走完 —— 回滚必须恢复「按下前」的 undo。
    // 不需要身份 CAS：A2 的 beforeUndo 在按下那一刻就是 A1 的条目（undo 是单槽），快照恢复
    // 天然还原它；真正的并发风险在 undoMarkAll 那一侧（见其 rollback 注释）。
    const beforeUndo = get().undo
    await mirror.run({
      endpoint: 'markRead',
      payload: { itemIds: ids, skipKept: true, before },
      optimistic: () => {
        set({
          items: get().items.map((item) => (ids.includes(item.id) ? { ...item, readAt: stamp } : item)),
          unread: Math.max(0, get().unread - ids.length),
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
    const undo = get().undo
    if (undo === undefined) return
    const beforeUnread = get().unread
    const beforePerFeed = get().perFeedUnread
    const beforeItems = get().items
    await mirror.run({
      endpoint: 'unmarkRead',
      payload: { itemIds: undo.ids },
      optimistic: () => {
        clearUndoExpiry()
        set({ undo: undefined })
        set({
          items: get().items.map((item) => (undo.ids.includes(item.id) ? { ...item, readAt: undefined } : item)),
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
        if (get().undo === undefined) {
          set({ undo: { ids: undo.ids } })
          armUndoExpiry()
        }
      },
    })
  }

  // ── 取数、分页与正文（票据 06c：所有域的汇合点）───────────────────────────────
  // load / loadMore 是本域唯一的网络入口，也是订阅域 / 搜索域 reload 的共同下游；
  // 文章取数（openArticle / stepArticle）与 cleanup 都挂在这条链上，所以一起搬、不另开文件。

  /**
   * 把宿主下发的一整份 overview 落到 state。
   *
   * 跨域写入登记（见 store.ts 的边界表）：这里会整份写 feeds / folders / tags —— 那是**宿主快照原样
   * 落地**，不是客户端编的；除此之外列表域对它们只读。
   *
   * `window` = 发这次请求那一刻的档位（不是回包后的 state.displayWindow）：账目与列表都属于这个
   * 窗口，落地时把 `accountWindow` 一起推过去，顶栏才知道现在的数字是哪个档位的（R1 评审 P1）。
   */
  const applyOverview = (overview: Overview, window: DisplayWindowRange): void => {
    const state = get()
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
      accountWindow: window,
      // 拆分同样整份覆盖：宿主没给（不带 todayFrom 的旧形状）就清成缺席，不许留着上一份。
      unreadSplit: overview.unreadSplit,
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

  /** 列表取数的版本号：两次 load 并发时只让最后一次落地（与搜索域的 listVersion 各管各的）。 */
  let overviewVersion = 0

  const load = async (endpoint: 'overview' | 'refresh'): Promise<void> => {
    const version = ++overviewVersion
    const state = get()
    if (state.search) {
      nextListVersion()
      search.abort()
      set({ nextCursor: undefined, loadingMore: false })
    } else {
      // 整份重取 = 旧列表的续页作废（R1-03）：切档时必须让在途的 loadMore 落地时版本不符而丢弃，
      // 顺手补上「切源 / 文件夹时在途续页把旧范围条目追加进新列表」的既有缺口。
      // 先递增版本再清 loadingMore：两个动作之间没有 await，loadMore 不可能插进来抓到一个仍有效的组合。
      // 搜索分支不在这里递增 —— 它有自己的 nextListVersion 调用（loadSearch 每页都会递增），
      // 重复递增会让搜索页互相判过期。
      //
      // 刻意只在 overview（整份列表重取）时清 nextCursor：refresh 期间列表仍展示旧页，
      // 旧游标本身不会造成错误；它的在途续页由版本号丢弃，新的 loadMore 由界面上的
      // state.loading 禁用挡住。切档要「新档从第一页开始」，那是 setWindow 自己的显式清空。
      nextListVersion()
      set(endpoint === 'overview'
        ? { nextCursor: undefined, loadingMore: false }
        : { loadingMore: false })
    }
    set({ loading: true })
    try {
      // 恢复必须在 feeds 表到手之后生效（未知源要回落），所以**先读、后应用**：
      // 读一次拿到记忆，等 overview 落地再按在订的源校验。并发两次 load 会各读一次（版本号只让
      // 最后一次落地）—— 这里没有「只读一次」的保证，别把注释当承诺。
      const preferences = viewMemory.restored() ? undefined : await viewMemory.read()
      // 三种范围都必须把范围带给宿主：由 SQL 先筛再限页，客户端拿到的才是这个范围的一页，
      // 而不是「跨源首页里恰好属于它的那几条」。源范围同样如此（R14）—— 低产源的条目可能
      // 全在全局第一页之外，靠客户端过滤只会显示 0–2 条。
      const scopeSelection = get().navSelection
      const scopePayload = scopeSelection.kind === 'feed'
        ? { feedId: scopeSelection.feedId }
        : scopeSelection.kind === 'folder'
          ? { folder: scopeSelection.folder }
          : scopeSelection.kind === 'tag'
            ? { tagId: scopeSelection.tagId }
            : undefined
      // 窗口与范围正交（ADR-0004 的 2026-11-19 修订）：refresh 也带窗口，否则按一次刷新就把
      // 视图从「今天」悄悄放回「全部」。载荷只由唯一构造器产出，这里不写 from / to。
      //
      // 档位与载荷在**发 rpc 前一起取**（R1 评审 P1）：回包落地时用这份档位标记账目，绝不能
      // 在回包后再读 displayWindow —— 中间切过档就会把旧档的账记到新档名下。
      const request = windowRequest()
      const overview = await rpc<Overview>(endpoint, { ...(scopePayload ?? {}), ...request.payload })
      if (version !== overviewVersion) return
      const searching = get().search
      if (searching) {
        const tags = overview.tags ?? []
        const nav = get().navSelection
        const missing = !selectionExists(nav, overview.feeds, overview.folders, tags)
        set({
          feeds: overview.feeds, folders: overview.folders, tags,
          unread: overview.unread, perFeedUnread: overview.perFeedUnread, unreadSplit: overview.unreadSplit,
          // 搜索分支同样整份落地账目：标记必须与这份账的请求档位一致（搜索期间控件禁用，
          // 但 refresh / 挂载仍可能走这里，不能用回包后的 state 去猜）。
          accountWindow: request.window,
          ...(missing ? { navSelection: { kind: 'virtual' }, filter: 'all', navCursor: { kind: 'filter', filter: 'all' } } : {}),
        })
        if (missing) persistView()
      } else {
        applyOverview(overview, request.window)
      }
      if (!viewMemory.restored()) {
        viewMemory.apply(preferences)
        // 恢复出的范围可能不是「跨源」：刚才那一页是按恢复前的虚拟视图取的（全局第一页），
        // 恢复成源 / 文件夹 / 标签后必须按新范围重取一次。否则这些范围只能看见「全局第一页里
        // 恰好属于它的那几条」—— 正是 R14 的病象在「重开面板」这条路径上的复现。
        if (!get().search && get().navSelection.kind !== 'virtual') {
          void load(endpoint === 'refresh' ? 'overview' : endpoint)
          return
        }
      }
      // 用新游标重查已加载的页数，刷新插入的新条目不会挤掉整个阅读窗口。
      if (get().search) await search.load(undefined, search.loadedPages())
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
        ...(search.inFlight() === true ? {} : { loading: false }),
        error: failure instanceof Error ? failure.message : String(failure),
      })
    }
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
    const state = get()
    const cursor = state.nextCursor
    if (cursor === undefined || state.loadingMore) return
    if (state.search) {
      if (!state.loading) await search.load(cursor)
      return
    }
    const version = currentListVersion()
    set({ loadingMore: true })
    try {
      const nav = get().navSelection
      // 续页与第一页必须带**同一份**窗口字段；只给第一页带窗会让第 2 页从错误边界续起。
      // 档位同样在发请求前取：这一页的账属于它，回包晚到 applyAccount 会按它判断是否落地。
      const request = windowRequest()
      const overview = await rpc<Overview>('overview', {
        cursor,
        // 续页必须带与第一页**同一份**范围：源的续页带 feedId，文件夹带 folder，标签带 tagId。
        ...(nav.kind === 'feed' ? { feedId: nav.feedId } : {}),
        ...(nav.kind === 'folder' ? { folder: nav.folder } : {}),
        ...(nav.kind === 'tag' ? { tagId: nav.tagId } : {}),
        ...request.payload,
      })
      // 版本不符 = 期间发生了一次整份重取（切档 / 切源 / 刷新）：这一页属于旧列表，整包丢弃。
      // 不清 loadingMore 是安全的 —— 触发版本变化的那次 load 已经在开头把它清掉了。
      if (version !== currentListVersion()) return
      // 追加拼在**当前** state 上（不是闭包里那份快照）：请求在途时用户可能已经标读/加星，
      // 用发请求前的 items 覆盖会把那些本地动作抹掉。
      set({ items: [...get().items, ...overview.items], nextCursor: overview.nextCursor })
      applyAccount(overview, request.window)
      set({ loadingMore: false, error: undefined })
    } catch (failure) {
      if (version !== currentListVersion()) return
      set({ loadingMore: false, error: failure instanceof Error ? failure.message : String(failure) })
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
    const item = get().items.find((entry) => entry.id === itemId)
    if (item === undefined || item.link === '') return
    set({ view: 'article', selectedId: item.id, article: { itemId: item.id, loading: true } })
    activate(item.id)
    try {
      const result = await rpc<ArticlePayload>('article', { itemId: item.id })
      // 期间用户可能已经换到别的条目：丢弃过期结果，避免把 A 的正文显示成 B 的
      if (get().article?.itemId !== item.id) return
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
      if (get().article?.itemId !== item.id) return
      set({ article: { itemId: item.id, loading: false, failure: error instanceof Error ? error.message : String(error) } })
    }
  }

  /**
   * 重试抓取当前正文页的那一篇（R4-B4）。
   *
   * 取 `article.itemId` 而不是 `selectedId`：正文页的唯一真相是 article.itemId —— 列表选中项
   * 可能已经被别的入口（点击 / j/k / 搜索刷新）换到另一条，那就是「重试抓了别的文章」的错位。
   * 请求仍走 loadArticle：冷却期等失败由宿主回包的 failure 原样显示，不在这里吞掉或改写。
   */
  const retryArticle = (): void => {
    const itemId = get().article?.itemId
    if (itemId === undefined) return
    void loadArticle(itemId)
  }

  /**
   * 记一次阅读进度（M5 02）。
   *
   * 只在「切换文章 / 关闭正文 / 组件卸载」时调 —— **滚动本身不写盘**：逐帧写会把库写热，
   * 而进度只要在离开这篇时是对的。失败只记录不弹错：进度是锦上添花，把它升成 error 条
   * 会让「每切一篇红一次」比丢一次进度更烦人。
   */
  const saveArticleProgress = (itemId: string, contentVersion: string, ratio: number): void => {
    void rpc('saveReadingProgress', { itemId, contentVersion, ratio }).catch((failure: unknown) => {
      log('warn', '[rss-reader] 阅读进度保存失败（不影响继续阅读；下一次切换会再写一次）', failure)
    })
  }

  /** 打开当前选中的条目为正文（列表页的 V 走这里）。 */
  const openArticle = async (): Promise<void> => {
    const selectedId = get().selectedId
    if (selectedId === undefined) return
    await loadArticle(selectedId)
  }

  /**
   * 正文页能否向该方向切换（**纯查询，不产生副作用**）。
   *
   * 单独抽出来的原因：界面上「上一条/下一条」按钮的禁用态必须与键盘的判断**完全一致**——
   * 各自算一遍迟早会出现「按钮灰着但键盘能切」或反之（本插件的标签/实现错位问题已有前例）。
   */
  const canStepArticle = (delta: number): boolean => {
    const article = get().article
    if (article?.loading === true) return false
    const list = visible()
    const index = list.findIndex((entry) => entry.id === article?.itemId)
    if (index < 0) return false
    return list[index + delta] !== undefined
  }

  /**
   * 正文页里切上/下一条文章（B1：显示即打开，故也标已读）。
   *
   * - **在途防抖**：上一次抓取未结束时忽略后续按键，否则连按 j 会堆出一串请求（每条一次网络）；
   * - **边界停住**（不回列表）：避免"多按一下突然跳回列表"的意外；
   * - 作用范围是**当前过滤下的可见列表**，与列表页 j/k 一致（「未读」筛选下就不会跳到已读条目）。
   * @returns 是否真的切换了
   */
  const stepArticle = (delta: number): boolean => {
    if (!canStepArticle(delta)) return false
    const list = visible()
    const article = get().article
    const index = list.findIndex((entry) => entry.id === article?.itemId)
    const target = list[index + delta]
    if (target === undefined) return false
    void loadArticle(target.id)
    return true
  }

  const closeArticle = (): void => { set({ view: 'list' }) }

  /**
   * 清理预演（R11 04 / spec D27.1）：只问宿主「如果现在执行会删多少」，**一条都不删**。
   *
   * 与 cleanup 共用同一个端点与同一份窗口构造器，只多带一个 `dryRun: true` —— 计数与删
   * 绝不能是两套实现（GLOSSARY「裁决者只有一个」）。这里刻意不重载 overview、不改列表：
   * 预演之后数据没变，重载只会制造一次无意义的取数；确认框也由设置页决定，不在这里弹。
   *
   * 0 条时就地把「没有可清理的条目」交给全局 notice：这是**用户动作的结果**，与后续
   * 是否执行无关。失败走全局 error 并返回 undefined —— 调用方只按计数决定弹不弹框。
   */
  const cleanupPreview = async (): Promise<CleanupResult | undefined> => {
    try {
      const result = await rpc<CleanupResult>('cleanup', { ...windowRequest().payload, dryRun: true })
      if (result.deleted === 0) {
        set({ notice: '没有可清理的条目（只清「已读且未星标」且早于阈值的旧条目）' })
      }
      return result
    } catch (failure) {
      set({ error: failure instanceof Error ? failure.message : String(failure) })
      return undefined
    }
  }

  /**
   * 显式清理：删除「已读 + 未星标 + 早于阈值」的旧条目。
   *
   * 判据在宿主侧（`retention.ts` 的 selectCleanup，有单测）。客户端只负责发起与**如实回报**：
   * 删了 0 条也要说清是 0 条，而不是让用户以为按钮坏了。
   *
   * R11 04 起这条动作只由设置页的确认框触发；预演（cleanupPreview）用的是同一份判据，
   * 本动作保持「取窗口 → cleanup → 如实回报 → 重载 overview」不变。
   */
  const cleanup = async (): Promise<void> => {
    try {
      // cleanup 不走账目镜像（它回包里的账不落地，随后整份重载 overview），但窗口必须从同一个
      // 构造器来 —— 否则清理之后的左栏角标会被这次写端点打回全量（spec 决策 15）。
      const result = await rpc<CleanupResult>('cleanup', windowRequest().payload)
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
   * 切时间范围档位（R1-03，spec 决策 23）：**一次整份重取**，不是本地过滤。
   *
   * 顺序刻意如此：
   *  1. 先退出正文 —— 档位是一次作用域切换，右栏还停在上一篇就自相矛盾；阅读进度由
   *     ArticleView 的卸载清理照常落盘，不受影响（与 setFilter / selectNav 同一条规则）；
   *  2. 立即清空 items / 游标 / 选中并清 loadingMore：新档第一页落地前不能继续展示旧档条目，
   *     也不能让「加载更多」拿旧游标发请求；
   *  3. load('overview') 在开头递增列表版本号，在途续页因此整包丢弃（切源时的那处既有缺口一并修好）。
   *
   * **账目不清、accountWindow 也不动**（R1 评审 P1）：旧账留着，但它仍标着旧档位 —— 顶栏 / 左栏 /
   * 侧栏据此显示「正在统计…」而不是把旧窗口的数字挂在新的档位名下。新档第一页落地时
   * applyOverview 才把账目连同 accountWindow 一起换成新窗口的那份。
   *
   * 搜索进行中一律 no-op：搜索有自己的日期筛选（UTC 日界，ADR-0005 明确并存），窗口在搜索里
   * 没有对应物。UI 已把控件禁用并说明原因；动作层再挡一次，避免「切窗顺手退出搜索」把两条语义
   * 塞进一个动作（spec 决策 27）。
   *
   * 不写视图记忆：档位**不持久化**（spec 决策 1），重开面板由 store.flushViewMemory 复位到全部。
   */
  const setWindow = async (displayWindow: DisplayWindowRange): Promise<void> => {
    const state = get()
    if (state.search !== undefined) return
    if (state.displayWindow === displayWindow) return
    leaveTransientViews()
    set({ displayWindow, items: [], selectedId: undefined, nextCursor: undefined, loadingMore: false })
    await load('overview')
  }

  return {
    /** 挂在 ReaderStore 公开面上的动作（与搬走前同名同签名）。 */
    actions: {
      visible, setFilter, setWindow, setLayout, setMarkAllRange, setShowUnread, select, selectRelative,
      markRead, activate, openSelected, toggleStar, toggleKeepUnread, toggleRead, markAllPlan, countMarkAllCandidates, markAllRead, undoMarkAll,
      load, loadMore, cleanup, cleanupPreview, openArticle, retryArticle, closeArticle, stepArticle, canStepArticle, saveArticleProgress,
    },
    /** 跨域入口：选中重落。nav-actions 与视图恢复共用，刻意不上 ReaderStore 的公开面。 */
    relocateSelection,
    /** 跨域入口：切作用域前退出正文 / 设置页。setFilter 与 setWindow 在同文件直调，nav-actions 的 selectNav 经 host 注入。 */
    leaveTransientViews,
  }
}
