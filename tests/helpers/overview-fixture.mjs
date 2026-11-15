/**
 * 宿主 overview 回包的**唯一桩工厂**（阶段 4 验收项：换一次回包形状，只改一处）。
 *
 * 为什么单独一份：四个测试文件各自拼过一份 overview，键域规则（perFeedUnread 的键**严格等于**
 * feeds 表，0 未读的源也留 0）就在四处各写一遍 —— 而这条规则是宿主契约（src/shared.ts 的注释即
 * 契约原文），客户端会无条件使用它。散着写的结果是「角标空白 vs 角标 0」这类无法从界面分辨的差异。
 *
 * 契约要点（改这个函数前先读一遍 src/shared.ts 的 Overview 注释）：
 *  - `perFeedUnread` 先按 feeds 表铺 0，再给未读条目 +1；
 *  - 已退订源的条目可能还在 items 里，但那种源不该出现在键域里；
 *  - `unread` 是总数（与 perFeedUnread 之和一致）。
 */
export function overviewStub({ items = [], feeds, folders = [], tags = [], refreshed = false } = {}) {
  const table = feeds ?? [...new Set(items.map((entry) => entry.feedId))].map((feedId) => ({ id: feedId, title: feedId }))
  const perFeedUnread = {}
  for (const feed of table) perFeedUnread[feed.id] = 0
  for (const entry of items) {
    if (entry.readAt === undefined && entry.feedId in perFeedUnread) perFeedUnread[entry.feedId] += 1
  }
  return {
    feeds: table,
    items,
    folders,
    tags,
    unread: items.filter((entry) => entry.readAt === undefined).length,
    perFeedUnread,
    refreshed,
  }
}
