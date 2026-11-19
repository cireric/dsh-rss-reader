/**
 * 导航动作（阶段 4b 票据 05 的第三切片）。
 *
 * 六个动作：selectNav / moveNavCursor / openNavCursor / toggleNav / toggleFolder / toggleFeeds。
 * （toggleFeeds 写的是列表域的 `view`，但它与导航折叠共用一个入口，跟着这一族搬；已导出，调用点未变。）
 * 它们写 navSelection / navCursor / navVisible / foldedFolders，并在需要时经 host 的
 * persistView 记住选中（票据里那条「persistView 归谁」的待定项，按共享模块处理：由 host 注入）。
 */
import type { NavCursor, NavSelection, ReaderStoreDeps, ReaderState } from './store.js'
import { navCursorKey, navRowsOf, sameNavSelection } from './nav-model.js'

export interface NavActionHost {
  get: () => ReaderState
  set: (patch: Partial<ReaderState>) => void
  reload: () => Promise<void>
  persistView: () => void
  relocateSelection: () => void
  searchActions: { reset: () => void }
  /** 虚拟视图那一行要切 filter（selectNav 的回退路径用）。 */
  setFilter: (filter: 'all' | 'unread' | 'starred') => void
  /** 切作用域前退出正文：`view` / `article` 由列表域的 leaveArticleForScope 收回（见 list-actions）。 */
  leaveArticleForScope: () => void
}

export function createNavActions(host: NavActionHost) {
  const { get, set, reload, persistView, relocateSelection, searchActions, setFilter, leaveArticleForScope } = host

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
    // 正文视图下切源 / 文件夹 / 标签（含「再选同一个 = 取消选中」这条分支）也是切作用域：
    // 先退出正文，否则右栏会继续显示一篇已经不属于新作用域的旧文章。搜索提交另有自己的回列表写法。
    leaveArticleForScope()
    const current = get().navSelection
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
    if (!get().search && scopeChanged) void reload()
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
    const rows = navRowsOf(get().feeds, get().foldedFolders, get().folders.map((folder) => folder.name), get().tags)
    if (rows.length === 0) return
    const at = rows.findIndex((row) => navCursorKey(row) === navCursorKey(get().navCursor))
    const from = at < 0 ? 0 : at
    const next = rows[Math.min(rows.length - 1, Math.max(0, from + delta))]
    if (next === undefined || navCursorKey(next) === navCursorKey(get().navCursor)) return
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
    const foldedFolders = new Set(get().foldedFolders)
    if (foldedFolders.has(folder)) foldedFolders.delete(folder)
    else foldedFolders.add(folder)
    set({ foldedFolders, navCursor: { kind: 'folder', folder } })
  }

  const openNavCursor = (): void => {
    const cursor = get().navCursor
    if (cursor.kind === 'folder') { toggleFolder(cursor.folder); return }
    if (cursor.kind === 'tag') { selectNav({ kind: 'tag', tagId: cursor.tagId }); return }
    if (cursor.kind === 'feed') { selectNav({ kind: 'feed', feedId: cursor.feedId }); return }
    setFilter(cursor.filter)
  }

  /** 左栏显隐（任务 6 的 u 键接线用）。左栏曾经收起过是用户会期待的「重开后还是那样」，故一并记忆。 */
  const toggleNav = (): void => {
    set({ navVisible: !get().navVisible })
    persistView()
  }

  /** 打开/关闭订阅管理视图（票据 05 搬家时这条注释留在了 store.ts 的 setLayout 头上，06a 顺手归位）。 */
  const toggleFeeds = (): void => { set({ view: get().view === 'feeds' ? 'list' : 'feeds' }) }

  /** 导出 OPML：拿到文本后交给浏览器下载（File System Access 不可用时退化为 blob 下载）。 */
  // OPML 导入/导出已搬进 src/client/opml-actions.ts（它们不碰 UI 状态，先于订阅域其余部分搬）。

  /**
   * 只发现、不订阅：拿到候选清单后等用户挑（宿主侧零写入，见 endpoints.ts 的 discoverFeeds）。
   * 失败只写 error —— 候选列表保持上一次的样子会让人以为「刚才那次没发生」，所以先清空再请求。
   */

  return { selectNav, moveNavCursor, openNavCursor, toggleNav, toggleFolder, toggleFeeds }
}
