/**
 * 列表域的动作（阶段 4b 票据 06a：可见集合与选中）。
 *
 * 从 src/client/store.ts 搬出来的七个成员：visible / setFilter / setLayout / setMarkAllRange /
 * setShowUnread / select / selectRelative，连同它们共用的两个内部判据 inScope / relocateSelection。
 *
 * 为什么先切这一块：它们是**纯读 + 小状态** —— 不碰账目、不碰网络、不碰撤销窗口。
 * `visible()` 是 markRead / stepArticle / openNavCursor 的共同下游，所以它只留在这一个入口：
 * 仍在 store 里的调用方（applyOverview / openSelected / toggleStar …）一律调同一个实例，不在别处再算一份。
 *
 * 写入边界（见 store.ts 顶部的四块边界表）：这里只写 selectedId / filter / layout /
 * markAllRange / showUnread，feeds / tags 只读。
 */
import type { ItemView } from '../shared.js'
import type { Filter, MarkAllRange, ReaderState } from './store.js'

export interface ListActionHost {
  get: () => ReaderState
  set: (patch: Partial<ReaderState>) => void
  /** 切过滤是「关键动作」：要写视图记忆（persistView 的归属仍按票据 05 的裁定留在 store）。 */
  persistView: () => void
  /** 切过滤要清掉搜索结果 —— 搜索域只经它自己的 reset 入口，不在这里摸搜索的内部状态。 */
  resetSearch: () => void
}

export function createListActions(host: ListActionHost) {
  const { get, set, persistView, resetSearch } = host

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
    resetSearch()
  }

  /** 切视图密度。默认 list = 本插件既有的紧凑行为，所以切成 expanded 是「多显示」而不是改默认。 */
  const setLayout = (layout: ReaderState['layout']): void => { set({ layout }) }

  /** 切「全部标为已读」的时间范围。 */
  const setMarkAllRange = (markAllRange: MarkAllRange): void => { set({ markAllRange }) }

  /** 隐藏 / 显示未读计数（规格 §5 不变量 8）。只影响呈现，不动数据。 */
  const setShowUnread = (showUnread: boolean): void => { set({ showUnread }) }

  /** 纯选中：只挪光标，**不**标已读、不展开（要副作用请走 activate —— 「打开一条」的唯一触发点）。 */
  const select = (itemId: string): void => { set({ selectedId: itemId }) }

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
  }

  return {
    /** 挂在 ReaderStore 公开面上的动作（与搬走前同名同签名）。 */
    actions: { visible, setFilter, setLayout, setMarkAllRange, setShowUnread, select, selectRelative },
    /** 跨域入口：选中重落。nav-actions 与视图恢复共用，刻意不上 ReaderStore 的公开面。 */
    relocateSelection,
  }
}
