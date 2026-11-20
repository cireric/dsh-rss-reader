/**
 * 订阅源顺序的语义（R3）：**纯函数**，输入输出都是 config.json 的形状。
 *
 * 为什么单独成模块：顺序的唯一真相是 `config.json` 的 `feedOrder` 数组，而三份 store 实现
 * （自持 SQLite / 旧适配器 / 内存替身）都要把「这份数组 + feeds 映射」解释成同一个顺序。
 * 规则留在适配器里就必然出现三种方言 —— 替身比生产宽松，用替身测出来的绿就不算数
 * （与 `src/folders.ts` 同一分工：规则在纯模块、读写在适配器）。
 *
 * `feedOrder` 只记录**用户排过**的 id；没列出的源（新订阅、OPML 刚导入的）永远按 `feeds`
 * 的键序追加到末尾，不会插进用户已经排好的段落。认不出的 id 与空串在派生时丢弃：
 * 它们不是格式错误（退订后残留、手改留下垃圾都算正常形态），读侧不该因此打不开面板。
 */
import type { FeedRecord } from './domain.js'

/** 「列出的 id」的归一：丢空串与未知 id、重复保首次。派生与重排共用这一条，别各写一遍。 */
function listedFeedIds(order: readonly string[], feeds: Record<string, FeedRecord>): string[] {
  const listed: string[] = []
  const seen = new Set<string>()
  for (const feedId of order) {
    // 空串与未知 id 都不是格式错（读侧不为它们报错），但在顺序里没有意义。
    if (feedId === '' || !Object.hasOwn(feeds, feedId) || seen.has(feedId)) continue
    seen.add(feedId)
    listed.push(feedId)
  }
  return listed
}

/**
 * 有效顺序：已列出的 id 按数组顺序（重复保首次）→ 未列出的按 `feeds` 键序追加 → 未知 id 丢弃。
 *
 * 返回值只含 `feeds` 里真实存在的那些 id，长度恒等于 `Object.keys(feeds).length`：
 * 「顺序」是**同一批订阅的排列**，不是另一份订阅清单。
 */
export function deriveFeedOrder(
  order: readonly string[] | undefined,
  feeds: Record<string, FeedRecord>,
): string[] {
  const listed = listedFeedIds(order ?? [], feeds)
  const seen = new Set(listed)
  for (const feedId of Object.keys(feeds)) {
    if (seen.has(feedId)) continue
    seen.add(feedId)
    listed.push(feedId)
  }
  return listed
}

/**
 * 重排：请求里的 id 归一（去重、丢未知 / 空串）后 + 其余按**当前有效顺序**补齐。
 *
 * 返回 `undefined` 表示「归一后一个 id 都不剩」（空数组，或全是未知 id）：调用方据此**不写盘**，
 * 回当前顺序 —— 「什么都没点名」不该把 `feedOrder` 物化出来（与读侧「缺省不物化」同一条纪律）。
 *
 * 结果总是**完整的一份**（长度 = feeds 键数），不是只落请求里那一段：只落前缀的话，未提到的
 * 那批下次要靠键序重新推导，而键序可能已被一次退订重写 —— 同一份顺序就长出了两个来源。
 */
export function reorderFeedOrder(
  order: readonly string[] | undefined,
  feeds: Record<string, FeedRecord>,
  requested: readonly string[],
): string[] | undefined {
  const named = listedFeedIds(requested, feeds)
  if (named.length === 0) return undefined
  const seen = new Set(named)
  return [...named, ...deriveFeedOrder(order, feeds).filter((feedId) => !seen.has(feedId))]
}

/**
 * 退订时把该 id 从顺序里摘掉（R3 04）：**其余元素一格不动**，同一 id 的出现全部清掉。
 *
 * 为什么单独成函数：三份 store 的 `deleteSubscription` 都要做这一件事，各写一遍迟早出现
 * 「生产过滤了、内存替身忘了」。重复项一并清掉而不是只删首次：读侧本来就只认首次，
 * 留下的第二份是永远派不上用场的垃圾（验收要求「文件里不再含该 id」）。
 *
 * 只在 `order` 已存在时调用 —— 从未排过顺序（缺省）时退订不得物化这个键。
 */
export function withoutFeedOrder(order: readonly string[], feedId: string): string[] {
  return order.filter((entry) => entry !== feedId)
}

/**
 * 与 {@link deriveFeedOrder} 同一个顺序的 `[feedId, record]` 列表 —— store 的 `listFeeds()` 直接回它。
 *
 * 独立成函数只是为了让三份实现都只写一行，避免各自再写一遍 map 而把「顺序从哪来」的判定
 * 又散出去一份。
 */
export function orderedFeedEntries(
  order: readonly string[] | undefined,
  feeds: Record<string, FeedRecord>,
): Array<[string, FeedRecord]> {
  return deriveFeedOrder(order, feeds).map((feedId) => [feedId, feeds[feedId]] as [string, FeedRecord])
}
