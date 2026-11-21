/**
 * 保留与清理策略 —— **纯函数**，因为这里的每一条都是「删数据」的规则：
 * 写错会静默丢掉用户的星标或已读历史，而这类错误在浏览器里看不到、在日志里也不一定显形。
 * 抽出来之后，每条边界都有单测钉住。
 *
 * 三条规则（2026-10-06 用户确认）：
 *   ① 按源保留 maxItemsPerFeed 条：先删未读，再删已读，**星标永不自动删**；
 *   ② 按需正文缓存有**全局**字符上限（全部源共摊），超限时从最旧的开始清缓存（条目本身保留）；
 *   ③ 显式清理：只删「已读 + 未星标 + 未保持未读 + 早于阈值」的条目（按钮触发，不设定时器）。
 */

import { tableToText } from './article-text.js'

/** 一条记录在保留策略里被用到的字段。 */
export interface RetentionRow {
  readonly id: string
  readonly starred: boolean
  /** 「保持未读」：用户明确说了「别动它」，与星标同级保护 */
  readonly kept: boolean
  readonly read: boolean
  /** 排序用的时间（发布时间优先，缺则抓取时间）；ISO 字符串，按字典序即时间序。 */
  readonly recency: string
}

/**
 * 选出要被裁剪删除的条目 id（按源）。
 *
 * 两级：**先删未读**（它们是噪声），**再删已读**（历史，需要时才让位），
 * **星标与「保持未读」的条目一律不动**——两者都是用户明确说的「我要留着」。
 * 若全被它们占满，宁可超过上限也不删（返回的列表会短于需要量）。
 */
export function selectPrunable(rows: readonly RetentionRow[], maxItems: number): string[] {
  const overflow = rows.length - maxItems
  if (overflow <= 0) return []
  const byOldest = [...rows].sort((a, b) => a.recency.localeCompare(b.recency) || a.id.localeCompare(b.id))
  const protectedFromPrune = (row: RetentionRow): boolean => row.starred || row.kept
  const unread = byOldest.filter((row) => !protectedFromPrune(row) && !row.read)
  const read = byOldest.filter((row) => !protectedFromPrune(row) && row.read)
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
 *
 * ⚠️ **本函数的口径一直是「喂进来的全部条目」＝全局预算**（2026-10-11 核实）：
 * 清单里有几条、属于几个源，它都照单全收；「跨源」这件事由**调用方**保证（refresh.ts 的
 * capArticleCache 每轮按全库喂一次）。所以这里**不另开** selectGlobalArticleEvictions ——
 * 全仓已经有两对「同一判据两份实现」的教训（selectCleanup 的 SQL 副本、articleCharsOf 的
 * refresh 侧副本），再加一个同义的函数只会把分家的风险引回来。
 */
export function selectArticleEvictions(entries: readonly ArticleEntry[], maxChars: number): string[] {
  const total = entries.reduce((sum, entry) => sum + entry.chars, 0)
  // 守卫写成 !(maxChars > 0) 而不是 maxChars <= 0（2026-10-11 评审轮 1 修）：
  // NaN <= 0 是 false ⇒ 垃圾上限会**穿过**这个守卫；而 total <= NaN 同样是 false ⇒
  // 判定一路走进淘汰循环，把**全部**条目清空。改成「不是正数就当未配置」之后 NaN 被一并挡住。
  // 这不是新引入的洞（一直存在），但 Task 9 把闸门从「单源」改成「全库」之后，
  // 同一个洞的爆炸半径从一个源变成了**整库**——所以必须在这里堵死。
  if (!(maxChars > 0) || total <= maxChars) return []
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

/**
 * 正文缓存的字符数。**新旧两种存储形态都要算**。
 *
 * 为什么必须是共享实现（2026-10-07 修）：refresh.ts 的闸门原先自己写了一份、只统计
 * paragraphs，而现行缓存只写 blocks —— 于是每源字符数恒为 0，8M 上限形同虚设，
 * 正文缓存无界增长。index.ts 的清理侧本来就算对了两种形态，所以这两处收敛到这里。
 *
 * **表格走 `article-text.ts` 的 `tableToText`，不在这里另写一份行列遍历**（2026-11-21，R5 04）：
 * `table` 块既没有 `text` 也没有 `items`，只读那两个字段会把整张表算成 0 字符 ⇒ 一张大表格
 * 不占额度、淘汰口径失真。
 *
 * ⚠️ 为什么只给 `table` 加分支、不把整段换成 `blockToText`（本票实测的取舍）：`blockToText`
 * 对 `list` 用空格连接各项、对 `img` 返回 `alt`，而本函数现在是「各项长度直接相加、图片不计」。
 * 整体替换会**顺手改掉**这两个口径（列表每多一项 +1 字、图片 alt 从 0 变成非 0），那是本票
 * 范围外的行为变化，会让既有字符数与淘汰阈值一起漂移。所以这里保持既有语义，只把表格接到
 * 共享投影上 —— 「表格的行列怎么摊平」这件事仍然只有一份实现。
 */
export function articleCharsOf(
  article: { blocks?: Array<Record<string, unknown>>; paragraphs?: string[] } | undefined,
): number {
  if (article === undefined) return 0
  if (article.paragraphs !== undefined) return article.paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0)
  if (article.blocks === undefined) return 0
  return article.blocks.reduce((sum, block) => {
    // 表格没有 text / items，必须单独认；行列摊平复用共享投影（search-worker 与 SQL 侧同一条）
    if (block['kind'] === 'table') return sum + tableToText(block).length
    const text = block['text']
    if (typeof text === 'string') return sum + text.length
    const items = block['items']
    if (Array.isArray(items)) return sum + items.reduce((inner, item) => inner + String(item).length, 0)
    return sum
  }, 0)
}

/** 清理候选的形态：在保留字段之外还要知道有没有正文缓存，便于如实汇报释放量。 */
export interface CleanupRow extends RetentionRow {
  readonly articleChars: number
}

/**
 * 选出显式清理要删除的条目：**已读 + 未星标 + 未保持未读 + 早于阈值**。
 *
 * 四个条件缺一不可：未读的可能是还没看的（删了就没了），星标与「保持未读」是用户明确说
 * 「我要留着」的，晚于阈值的是近期历史（用户可能还要回看）。删除是**不可逆**的，所以判据刻意保守。
 *
 * ⚠️ **本函数是这条判据唯一的裁决者**（2026-11-14 收口；来由见 `.scratch/cleanup-criterion/issues/01-cleanup-criterion-ownership.md`）。
 *
 * 自持存储为了不把整张 items 表物化到 JS，仍会在 SQL 里先筛一遍
 * （`src/store-sqlite.ts` 的 `SELECT_CLEANUP_ROWS`）。但那份 SQL 只被允许做**成本筛选**
 * （`read_at IS NOT NULL AND recency < ?`），**不许替本函数决定保护条款**：星标与「保持未读」
 * 的过滤已从谓词里撤掉，改由这里裁决。
 *
 * 为什么这么切：两份实现「逐字等价」是一条没人守得住、也没人能证明的义务 —— 候选行的判据字段
 * 若按谓词回填（旧写法把 read / starred / kept 写死成 true / false / false），SQL 坏掉时本函数
 * 照样放行。2026-11-14 的隔离实验实测过：把 `kept_unread = 0` 放宽成 `>= 0`，
 * 一条 `kept_unread = 1` 的旧条目会进候选并被删，而纯函数用例一条都不会红。
 * 现在的义务只有一条**包含关系**：候选 ⊇ 本函数的判定集。SQL 少取 = 少清（可接受、有断言），
 * 多取 = 由本函数挡回去（有断言）。两侧都由 `tests/store-sqlite.test.mjs` 钉住。
 */
export function selectCleanup(rows: readonly CleanupRow[], cutoffIso: string): string[] {
  return rows
    .filter((row) => row.read && !row.starred && !row.kept && row.recency < cutoffIso)
    .map((row) => row.id)
}
