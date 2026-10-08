/**
 * 条目稳定 id —— 已读态（readAt）绑在它上面。
 *
 * 交接件 §8「去重不是归档」：去重集合会滚出窗口，已读态不能跟着丢，
 * 因此 id 必须是**同一 feed、同一条目在任意次重复抓取下的同一取值**。
 *
 * 派生优先级：feed 自带的 id/guid → 永久链接 → 标题+发布时间的哈希。
 * 前缀 feedId 是为了让同一篇文章出现在两个订阅源时各自保有独立的已读态。
 */
import { createHash } from 'node:crypto'

export interface ItemIdSource {
  /** feed 自带的 guid / Atom id（第一优先） */
  id?: string
  link?: string
  title?: string
  publishedAt?: string
}

export function deriveItemId(feedId: string, item: ItemIdSource): string {
  const basis = item.id?.trim() || item.link?.trim() || `${item.title ?? ''}|${item.publishedAt ?? ''}`
  return createHash('sha1').update(`${feedId}|${basis}`).digest('hex').slice(0, 32)
}

/**
 * 一次响应内的身份解析 —— 规格 §5 不变量 2 的兜底分支。
 *
 * 判据原文：「条目身份是派生的：id → URL → 属性签名（**同一响应内 id/URL 重复即视为不可信**）」。
 * 逐条派生（deriveItemId）在源撒谎时会**静默丢数据**：两条不同的文章共用一个 guid 时，它们的条目
 * id 会撞在一起，后写的那条覆盖前一条。
 *
 * 所以这里以「一次响应」为单位再查一遍：
 * - 撞车且 URL 不同 ⇒ **不信源给的 id**，退一级按 URL 重算（没有 URL 就落到标题+时间的签名）；
 * - 撞车且 URL 也相同 ⇒ 源里本就是同一条被列了两遍，保持同一个 id 交给下游去重。
 *
 * 返回与输入等长的 id 数组，以及「因为不可信而换了派生依据」的条数（供上层记日志）。
 */
export function resolveItemIds(feedId: string, items: readonly ItemIdSource[]): { ids: string[]; untrusted: number } {
  const ids = items.map((item) => deriveItemId(feedId, item))
  const groups = new Map<string, number[]>()
  for (const [index, id] of ids.entries()) {
    const group = groups.get(id)
    if (group === undefined) groups.set(id, [index])
    else group.push(index)
  }
  let untrusted = 0
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const links = new Set(group.map((index) => items[index].link?.trim() ?? ''))
    if (links.size < 2) continue
    untrusted += group.length
    for (const index of group) {
      const item = items[index]
      ids[index] = deriveItemId(feedId, { link: item.link, title: item.title, publishedAt: item.publishedAt })
    }
  }
  return { ids, untrusted }
}
