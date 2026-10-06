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
