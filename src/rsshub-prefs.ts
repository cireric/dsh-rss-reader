/**
 * RSSHub 用户偏好的**唯一裁决者**（R15 06 / 07 / ADR-0001）。
 *
 * 为什么单独成模块：`hiddenNamespaces` 的归一化曾在三处各写一份 —— 读侧（config-file）、
 * 写侧（rsshub-settings）、检索侧（explore-catalog）的 trim / 去重 / 排序各不相同，于是
 * 「保存时接受、重启后换了个顺序」或「设置页显示 3 项、实际只有 2 个站点」这类分家无法从
 * 任何单点发现。`hideNsfw` 的默认值同型（散在主机与客户端四处），改一处忘一处时默认行为
 * 会随入口不同。把这两条判据 + 实例池上限收到这里，其余位置只 import，不准复制。
 *
 * 本模块是**纯函数 + 常量**，不依赖 node 内建，host 与 client 都可直接 import。
 */

/**
 * `hideNsfw` 的默认值（spec §4.2.3：默认隐藏 NSFW）。
 *
 * 读侧缺字段、设置层初值、端点缺省、客户端开关初值都从这里取 —— 一处改成 false 就是全局
 * 改成 false，不会出现「设置页显示隐藏、探索页却放行」的双口径。
 */
export const DEFAULT_HIDE_NSFW = true

/**
 * `hideNsfw` 的生效值：**只有显式 `false` 才关闭隐藏**。
 *
 * 不用 `value ?? DEFAULT_HIDE_NSFW` 的字面写法，是因为该判据的语义在探索目录里本来就是
 * 「缺省 / 认不出的值都回到默认隐藏」；合并成同一句后，直接调 API 传 null 与传 undefined
 * 也不会把 nsfw 放出来（与 `filter.hideNsfw !== false` 的既有行为逐字一致）。
 */
export function effectiveHideNsfw(value: unknown): boolean {
  return value !== false
}

/**
 * 实例池上限（spec §4.1.1：>5 条拒绝保存）。
 *
 * 读侧只用它发告警（读侧不替用户删数据），写侧与客户端按钮用同一份拒绝。
 */
export const RSSHUB_INSTANCE_MAX = 5

/**
 * 隐藏列表归一化：**trim → 丢空串 / 非字符串 → 去重 → 稳定排序**。
 *
 * 取三处旧实现里最严的一份：
 *  - 读侧只 trim、不去重、不排序；
 *  - 写侧 trim + 去重、不排序；
 *  - 检索侧 trim + 去重 + 排序。
 *
 * 排序是游标栅栏的要求：`['a','b']` 与 `['b','a']` 筛出同一份列表，游标必须互相认；
 * 用码位序而不是 localeCompare —— 后者的结果依赖运行环境的 ICU 语言，缓存/游标会漂。
 *
 * 非数组（手改 config / 旧回包漂移）按空列表处理：宁可回到「不隐藏」，也不把垃圾值当站点名。
 */
export function normalizeHiddenNamespaces(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const names = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim()
    if (trimmed !== '') names.add(trimmed)
  }
  return [...names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}
