/**
 * 保留与清理策略 —— **纯函数**，因为这里的每一条都是「删数据」的规则：
 * 写错会静默丢掉用户的星标或已读历史，而这类错误在浏览器里看不到、在日志里也不一定显形。
 * 抽出来之后，每条边界都有单测钉住。
 *
 * 三条规则（2026-10-06 用户确认）：
 *   ① 按源保留 maxItemsPerFeed 条：先删未读，再删已读，**星标永不自动删**；
 *   ② 按需正文缓存有字符上限，超限时从最旧的开始清缓存（条目本身保留）；
 *   ③ 显式清理：只删「已读 + 未星标 + 早于阈值」的条目（按钮触发，不设定时器）。
 */

/** 一条记录在保留策略里被用到的字段。 */
export interface RetentionRow {
  readonly id: string
  readonly starred: boolean
  readonly read: boolean
  /** 排序用的时间（发布时间优先，缺则抓取时间）；ISO 字符串，按字典序即时间序。 */
  readonly recency: string
}

/**
 * 选出要被裁剪删除的条目 id（按源）。
 *
 * 两级：**先删未读**（它们是噪声），**再删已读**（历史，需要时才让位），
 * **星标条目一律不动**——星标是用户明确的「我要留着」。若全被星标占满，
 * 宁可超过上限也不删（返回的列表会短于需要量）。
 */
export function selectPrunable(rows: readonly RetentionRow[], maxItems: number): string[] {
  const overflow = rows.length - maxItems
  if (overflow <= 0) return []
  const byOldest = [...rows].sort((a, b) => a.recency.localeCompare(b.recency) || a.id.localeCompare(b.id))
  const unread = byOldest.filter((row) => !row.starred && !row.read)
  const read = byOldest.filter((row) => !row.starred && row.read)
  return [...unread, ...read].slice(0, overflow).map((row) => row.id)
}

/** 缓存条目在超限统计里的形态。 */
export interface ArticleEntry {
  readonly id: string
  /** 正文纯文本总字符数。 */
  readonly chars: number
  readonly fetchedAt: string
}

/**
 * 正文缓存超限时，选出要清掉缓存的条目（**只清缓存，条目本身保留**）。
 *
 * 从最旧的抓取记录开始清，直到总量降到上限之内。清掉之后用户再打开该条会重新抓一次，
 * 语义上是「降级」而不是「丢失」——这是可以接受的代价，所以不需要额外确认。
 */
export function selectArticleEvictions(entries: readonly ArticleEntry[], maxChars: number): string[] {
  const total = entries.reduce((sum, entry) => sum + entry.chars, 0)
  if (maxChars <= 0 || total <= maxChars) return []
  const byOldest = [...entries].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt) || a.id.localeCompare(b.id))
  const evicted: string[] = []
  let remaining = total
  for (const entry of byOldest) {
    if (remaining <= maxChars) break
    evicted.push(entry.id)
    remaining -= entry.chars
  }
  return evicted
}

/** 清理候选的形态：在保留字段之外还要知道有没有正文缓存，便于如实汇报释放量。 */
export interface CleanupRow extends RetentionRow {
  readonly articleChars: number
}

/**
 * 选出显式清理要删除的条目：**已读 + 未星标 + 早于阈值**。
 *
 * 三个条件缺一不可：未读的可能是还没看的（删了就没了），星标的是用户明确要留的，
 * 晚于阈值的是近期历史（用户可能还要回看）。删除是**不可逆**的，所以判据刻意保守。
 */
export function selectCleanup(rows: readonly CleanupRow[], cutoffIso: string): string[] {
  return rows
    .filter((row) => row.read && !row.starred && row.recency < cutoffIso)
    .map((row) => row.id)
}
