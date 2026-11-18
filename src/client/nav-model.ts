/**
 * 导航域的**纯模型**（阶段 4 票据 03 的第一刀）。
 *
 * 从 src/client/store.ts 抽出来的：左栏行序、行键、展开规则、选中投影、选中是否存在。
 * 它们全是纯函数 —— 不碰 state、不碰 React、不碰网络，因此可以在任何测试里直接驱动
 * （nav-selection / scroll-dom / keyboard-routing 已经这么用了）。
 *
 * 为什么不拆得更细：这些函数共享同一套词汇（NavCursor / NavSelection / VIRTUAL_VIEWS），
 * 拆成五个文件只会让「改一处要开五个文件」。一个文件一个域。
 */
import type { Filter, NavCursor, NavSelection } from './store.js'
import type { FeedView, FolderView, TagView } from '../shared.js'
import type { ViewPreferences } from '../preferences.js'

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
export function navRowsOf(
  feeds: ReadonlyArray<Pick<FeedView, 'id' | 'folder'>>,
  foldedFolders: ReadonlySet<string>,
  folderNames: readonly string[] = [],
  tags: ReadonlyArray<Pick<TagView, 'id' | 'name'>> = [],
): NavCursor[] {
  // 显式目录先入表：空文件夹只能靠它出现（feeds 里没有成员可派生）。
  const folders = new Map<string, string[]>()
  for (const name of folderNames) {
    if (!folders.has(name)) folders.set(name, [])
  }
  const unfiled: NavCursor[] = []
  for (const { id, folder } of feeds) {
    if (!folder) {
      unfiled.push({ kind: 'feed', feedId: id })
      continue
    }
    const group = folders.get(folder)
    if (group) group.push(id)
    else folders.set(folder, [id])
  }
  const rows: NavCursor[] = VIRTUAL_VIEWS.map((view) => ({ kind: 'filter', filter: view.key }))
  for (const [folder, ids] of folders) {
    rows.push({ kind: 'folder', folder })
    if (foldedFolders.has(folder)) continue
    for (const feedId of ids) rows.push({ kind: 'feed', feedId })
  }
  // 标签行排在最后：它们是跨源的分类轴，与「源行」同级但不参与文件夹折叠。
  return [...rows, ...unfiled, ...tags.map((tag) => ({ kind: 'tag' as const, tagId: tag.id }))]
}

/**
 * 「再按一次同一个 = 收起」：展开态只有这两种取值（o / Enter / Space / 点击共用）。
 *
 * 规则放在这里而不是三处各写一遍：2026-11-14 之前行内的 Enter 走的是「恒展开」，与 o 键的
 * toggle 不一致 —— 而本仓库当作功能基准的 GR 规范里 o 与 enter 是同一条
 * （docs/google-reader-feature-spec.md:211「o / enter | open/close item」）。
 */
export function nextExpandedOf(current: string | undefined, itemId: string): string | undefined {
  return current === itemId ? undefined : itemId
}

/** 光标和 DOM 使用同一行键，避免折叠后两者的行序分叉。 */
export function navCursorKey(cursor: NavCursor): string {
  if (cursor.kind === 'folder') return 'folder:' + cursor.folder
  if (cursor.kind === 'tag') return 'tag:' + cursor.tagId
  return cursor.kind === 'filter' ? 'filter:' + cursor.filter : 'feed:' + cursor.feedId
}

/**
 * 选中 → **可落盘的形状**（唯一一处投影）。
 *
 * 为什么是函数而不是嵌套三元：投影与 NavSelection 是同一条概念的两半，写成三元时新增一种 kind
 * 会静默落进 else —— tag 就这么被丢进 virtual 过（按标签筛选生效、落盘写成「全部」，
 * 还覆盖掉上次记住的源）。换成穷尽 switch 后，加第五种 kind 是**编译错误**。
 */
export function memorableSelectionOf(selection: NavSelection): ViewPreferences['navSelection'] {
  switch (selection.kind) {
    case 'virtual': return { kind: 'virtual' }
    case 'feed': return { kind: 'feed', feedId: selection.feedId }
    case 'folder': return { kind: 'folder', folder: selection.folder }
    case 'tag': return { kind: 'tag', tagId: selection.tagId }
  }
}

/** 「再选同一个 = 取消」的判据；folder 与 feed 各按自己的键比较。 */
export function sameNavSelection(a: NavSelection, b: NavSelection): boolean {
  if (a.kind === 'virtual' || b.kind === 'virtual') return a.kind === b.kind
  if (a.kind === 'feed' && b.kind === 'feed') return a.feedId === b.feedId
  if (a.kind === 'folder' && b.kind === 'folder') return a.folder === b.folder
  if (a.kind === 'tag' && b.kind === 'tag') return a.tagId === b.tagId
  return false
}

/** 选中的源/文件夹是否还在刚下发的目录里；virtual 永远在。 */
export function selectionExists(
  selection: NavSelection,
  feeds: ReadonlyArray<Pick<FeedView, 'id'>>,
  folders: ReadonlyArray<Pick<FolderView, 'name'>>,
  tags: ReadonlyArray<Pick<TagView, 'id'>> = [],
): boolean {
  if (selection.kind === 'virtual') return true
  if (selection.kind === 'feed') return feeds.some((feed) => feed.id === selection.feedId)
  if (selection.kind === 'tag') return tags.some((tag) => tag.id === selection.tagId)
  return folders.some((folder) => folder.name === selection.folder)
}
