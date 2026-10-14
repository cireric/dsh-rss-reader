/**
 * SQLite 版 ReaderStore（Task 3）：窄接口一字不改，只换实现。
 *
 * **为什么必须有它**：旧实现（`src/store.ts` 的 `createStore`）站在存储域上，而域是
 * 「整份进内存 + 每次写整份重写」的模型 —— 一源 500 条标已读要 4312 ms（实测，Task 1 基线），
 * 因为 500 次 `saveItem` 就是 500 次整份 JSON 重写。本文件把同一个接口落到 `node:sqlite` 上，
 * 所以 `refresh.ts` / `endpoints.ts` 的编排一行都不用改。
 *
 * **落点分两处，按 spec §4.1**：条目 / 正文 / 去重窗口进 `rss.db`（这里）；订阅映射与视图偏好
 * 留在 `config.json` —— 它是用户订阅的**唯一**可备份副本（spec §9.2），而条目与正文可再生。
 * 所以 `saveFeed` / `listFeeds` / `viewPreferences` 读写的都是同一份文件：两处各存一份订阅
 * 迟早会分家，而那正是「备份里少了一半源」这类问题的来源。
 *
 * **不 import `src/store.ts` 的运行时依赖**：它顶层 import 了
 * `@deepseek-ai/dsh-storage-domain`，而本模块走的是自持路径 —— 真 import 会把那个包留在
 * 「不用它却还依赖它」的状态（Task 8 才摘装配）。`import type` 编译后整行消失（可核
 * `lib/store-sqlite.js`），接口仍由 tsc 在本文件内**结构比对**，签名字眼一字不差依旧是编译器保证的。
 *
 * **行与正文同生同死**：正文进 `texts` 表（spec §11.2），每次写入都在**一个事务**里先写 items
 * 行、再写正文行 —— 「行在、正文没在」这种半写状态在这条路径上不可能出现。
 *
 * @param db 已 `openDatabase` 且 `migrateSchema` 过的库。没建表会被当场拒绝（见下方版本握手）：
 *   顺序颠倒若延迟到第一次写入才炸，症状是「插件装载成功、第一条订阅却存不进去」。
 * @param configPath `config.json` 的落点。订阅映射与视图偏好同在那一份文件里。
 */
import type { DatabaseSync, SQLOutputValue, StatementSync } from 'node:sqlite'
import {
  cursorRecordSchema,
  feedRecordSchema,
  itemRecordSchema,
  type ArticleRecord,
  type CursorRecord,
  type FeedRecord,
  type ItemRecord,
} from './domain.js'
import { readConfigFile, writeConfigFile, type ReaderConfigFile } from './storage/config-file.js'
import { SCHEMA_VERSION } from './storage/db.js'
import { sanitizeViewPreferences, type Cursor } from './shared.js'
import type { CleanupCandidate, ReaderStore } from './store.js'
import type { ArticleEntry } from './retention.js'

/** 事务里的保存点名。写成常量即可：db 是单连接，嵌套只发生在同一个连接上。 */
const SAVEPOINT = 'rss_store_write'

/** 行里的一个值 → 必填文本。类型不合就响亮抛错：`String(null)` 会静默得到 'null' 这种假数据。 */
function requiredText(value: SQLOutputValue, column: string): string {
  if (typeof value !== 'string') {
    throw new Error('订阅库里 ' + column + ' 的值是 ' + describe(value) + '，不是文本：库被外部改动过？')
  }
  return value
}

/** 行里的一个值 → 可选文本；SQL 的 NULL 与「记录里没这个字段」在这里合流成 undefined。 */
function optionalText(value: SQLOutputValue, column: string): string | undefined {
  if (value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error('订阅库里 ' + column + ' 的值是 ' + describe(value) + '，不是文本：库被外部改动过？')
  }
  return value
}

function optionalNumber(value: SQLOutputValue, column: string): number | undefined {
  if (value === null) return undefined
  if (typeof value !== 'number') {
    throw new Error('订阅库里 ' + column + ' 的值是 ' + describe(value) + '，不是数字：库被外部改动过？')
  }
  return value
}

/**
 * 行里的一个值 → 布尔。
 *
 * 只认 0 / 1：SQLite 没有布尔类型，而「读到一个 2 就当成 false」是**静默**的错误答案
 * （星标看起来丢了、条目看起来已读）。整数列由本模块独占写入，所以非 0/1 只可能是外部改动。
 */
function booleanAt(value: SQLOutputValue, column: string): boolean {
  if (value === 1) return true
  if (value === 0) return false
  throw new Error('订阅库里 ' + column + ' 的值是 ' + describe(value) + '，不是 0/1：库被外部改动过？')
}

/** 错误消息里的人话描述。刻意不用 JSON.stringify：它在 bigint 上会抛，把诊断本身变成异常。 */
function describe(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return 'array'
  if (ArrayBuffer.isView(value)) return 'bytes'
  return typeof value
}

/** 可选布尔 → 列值（true=1 / false=0 / 缺席=NULL）。三个状态都要能表达，缺一不可。 */
const optionalFlag = (value: boolean | undefined): number | null =>
  value === undefined ? null : (value ? 1 : 0)

/**
 * 读路径的 select：一次带出 items 行与它的正文行（LEFT JOIN，没有正文就是 NULL 列）。
 *
 * 排序键用 `i.recency`（生成列 = COALESCE(published_at, fetched_at)，见 storage/db.ts 的 DDL），
 * 而**不是** `i.published_at`：publishedAt 是可选字段，直接对 published_at 排序会让缺发布时间的
 * 条目落进 SQL 的 NULL 段（SQLite 中 NULL 最小），列表顺序与迁移前不一致（Review Focus 2）。
 */
const ITEM_SELECT = `
  SELECT i.id                   AS id,
         i.feed_id              AS feed_id,
         i.title                AS title,
         i.link                 AS link,
         i.published_at         AS published_at,
         i.fetched_at           AS fetched_at,
         i.summary              AS summary,
         i.read_at              AS read_at,
         i.starred              AS starred,
         i.kept_unread          AS kept_unread,
         i.article_failure      AS article_failure,
         t.body                 AS article_body,
         t.revision             AS article_revision,
         t.frameable            AS article_frameable,
         t.title                AS article_title,
         t.fetched_at           AS article_fetched_at
  FROM items i
  LEFT JOIN texts t ON t.item_id = i.id`

/** 排序：recency 降序 + id 升序（src/endpoints.ts:80-83 的原语义，逐字一致）。 */
const ITEM_ORDER = ' ORDER BY i.recency DESC, i.id ASC'

const SELECT_ITEM = ITEM_SELECT + ' WHERE i.id = ?'
const SELECT_ITEM_BY_FEED = ITEM_SELECT + ' WHERE i.feed_id = ?' + ITEM_ORDER
const SELECT_ALL_ITEMS = ITEM_SELECT + ITEM_ORDER

/**
 * 跨源最近 N 条（Task 5）。排序键与 ITEM_ORDER 逐字相同（recency 降序 + id 升序），
 * 所以执行计划是 i2 索引上的有界扫描 —— 而不是「读回 10 万行再 slice(0, 300)」。
 *
 * LIMIT 走绑定参数：调用方传负数时**在 JS 侧短路成空列表**（store.ts 的契约），
 * 绝不能下传 —— SQLite 把 `LIMIT -1` 当「无上限」，那正好把整表读回来。
 */
const SELECT_RECENT = ITEM_SELECT + ITEM_ORDER + ' LIMIT ?'

/**
 * 续页（keyset 分页，Task 6）：**严格排在游标之后**的那批。
 *
 * ⚠️ 谓词**必须**写成 `recency < ? OR (recency = ? AND id > ?)`，**不许**用行值比较
 * `(i.recency, i.id) < (?, ?)`：SQLite 把行值比较按字典序展开成
 * `recency < r0 OR (recency = r0 AND id < id0)`，而同 recency 内我们需要的是 `id > id0`
 * —— 方向反了。`实测`（spec §10.3）：6 行每页 2 条时行值形式返回 `a d e f`
 * （`a` 重复、`c` 漏掉），OR 形式返回 `c d e f`（正确）。而 recency 打平是**常态**：
 * 同一轮抓取的条目共享 fetchedAt。
 *
 * 计划是 `SCAN items USING COVERING INDEX i2`（**不是** SEARCH）：OR 让 SQLite 放弃索引定位，
 * 退化为沿覆盖索引顺序扫描 + LIMIT 提前终止 ⇒ O(页深)。代价被「覆盖索引、无需回表、
 * 取满即停」压到毫秒级（`实测`：10 万行翻底 334 页共 493 ms，零重复零遗漏）。若日后把页大小
 * 从 300 调到 3000，末页成本按比例放大，届时要重测（spec §10.3）。
 */
const SELECT_RECENT_AFTER = ITEM_SELECT + ' WHERE i.recency < ? OR (i.recency = ? AND i.id > ?)' + ITEM_ORDER + ' LIMIT ?'

/**
 * 每源未读（Task 5）：`GROUP BY feed_id` + `COUNT(*)`，未读判据 `read_at IS NULL`。
 *
 * `read_at IS NULL` 就是 JS 侧 `readAt === undefined`（shared.ts 的 isUnread）在 SQL 里的说法：
 * 写路径把可选字段一律写成 NULL（见 writeItem），所以这两者是同一件事的两种写法。
 * 只保证「传进来的键都有值」——已退订源的残留条目也会被数进来，键域判定由拿到 feeds 表的
 * 调用方做（见 store.ts 的 unreadPerFeed 契约）。
 *
 * `COUNT(*)` 在 node:sqlite 下返回 number（实测；本仓库用不到 2^53 以上的计数）。
 */
const SELECT_UNREAD_PER_FEED = 'SELECT feed_id AS feed_id, COUNT(*) AS unread FROM items WHERE read_at IS NULL GROUP BY feed_id'

/** 释放量原料：候选的 id 逐条取摘要与正文，**不带** items 行的其余列（几千条候选下差别可观）。 */
const SELECT_ITEM_CHARS = 'SELECT i.recency AS recency, i.summary AS summary, t.body AS body FROM items i LEFT JOIN texts t ON t.item_id = i.id WHERE i.id = ?'

/**
 * 正文缓存闸门的**清算原料**（Task 9）：只取 id、正文行是否存在、以及排序键 fetched_at。
 *
 * ⚠️ **绝不能改用 allItems()**：那条会把每份 body 都解出来留在 JS 堆里 ——
 * `实测` 10 万条 × 8.8 KB 时堆峰值 **1865 MB**，而 spec §9.3 的验收线是 ≤ 300 MB。
 * 这里 body 只在 `articleCharsFromBody` 里逐条 parse 一次、用完即弃，堆上不留副本。
 *
 * 用**内连接**（`JOIN texts`）而不是 LEFT JOIN + IS NOT NULL：效果一样（只有真有正文的行进名单，
 * 与调用方「只把带 article 的条目喂给 selectArticleEvictions」逐字同义），但少一层过滤谓词。
 */
const SELECT_ARTICLE_CACHE_ENTRIES =
  'SELECT i.id AS id, t.body AS body, t.fetched_at AS article_fetched_at'
  + ' FROM items i JOIN texts t ON t.item_id = i.id'

/**
 * 清理候选（Task 5）：一条 SQL 选完。
 *
 * ⚠️ **这是 `retention.ts` 的 `selectCleanup`（判据的定义处）的第二实现，不是第二口径**。
 * 四项都在这里重述：前三项（已读 `read_at IS NOT NULL`、未星标 `starred = 0`、早于阈值
 * `recency < ?`）逐条照抄 `selectCleanup`；**第四项 `kept_unread = 0` 比它更窄** ——
 * 用户对「保持未读」说的是「别动它」，与星标同级，而 `selectCleanup` 是纯判据、不含这条
 * （所以它写在 store.ts 的 listCleanupCandidates 契约里）。
 * 于是最终删除集 = 本谓词 ∩ `selectCleanup`（`endpoints.ts` 的 `cleanup` 把候选喂回判据复跑）。
 *
 * 谓词里的每一列都直接对应记录的字段（readAt→read_at、starred、keptUnread→kept_unread、
 * recencyOf(record)→生成列 recency），所以它确实与 selectCleanup 是同一件事的两种写法 ——
 * 而「两份实现没有被改分家」由 `tests/store-sqlite.test.mjs` 的两条钉住：
 *   · 「listCleanupCandidates：候选集由 SQL 选出，且与 selectCleanup 的判据对得上（唯一口径不漂）」
 *     在同一夹具上断言集合关系（候选集 == selectCleanup 的集合，除 kept 那一条外逐字相等）；
 *   · 「…排序、聚合与筛选真的写在 SQL 里」用正则断言 `read_at IS NOT NULL` / `starred = 0` /
 *     `kept_unread = 0` / `recency < ?` 真的出现在这条 SQL 文本里。
 * **改判据时两处都要改，改完重跑这两条。**
 *
 * 三条保护列**照 items 行直接读**（不 JOIN texts）：texts 的读列只用于释放量，
 * 而清理的候选往往几千条，正文是不该在这一步就搬进内存的那部分（那是「按需读行」的全部意义）。
 */
const SELECT_CLEANUP_IDS = [
  'SELECT i.id AS id FROM items i',
  ' WHERE i.read_at IS NOT NULL AND i.starred = 0 AND i.kept_unread = 0 AND i.recency < ?',
].join('')

/**
 * 写 items 行。用 ON CONFLICT DO UPDATE 而不是 INSERT OR REPLACE。
 *
 * ⚠️ **这条选择在当前结构下是等价变异**（差分实测，2026-10-11）：REPLACE 的语义是「先删旧行
 * 再插新行」，而 texts.item_id 上有 ON DELETE CASCADE，看着会把正文级联删掉 —— 但
 * `writeItem` 在同一次调用、同一个事务里紧接着就调 `writeArticle`，级联删掉的正文行**当场
 * 被写回**。对 9 步操作序列（写带正文 → 覆写不带 → 再写带 → 两次 update → 两次 delete →
 * 另一条 save+update）逐条比对可观测状态（store 读回的记录 + 两表行数）：两种写法的输出
 * **逐字节相同**。按 AGENTS.md「等价变异不入门槛」，门槛里**没有**这一条。
 *
 * 仍然这么写，是因为差值会在将来显形：一旦有人把 `writeArticle` 挪到 `UPSERT_ITEM` **之前**
 * （或让它们分处两个事务），REPLACE 就会把刚写好的正文删掉，而那时没有任何断言会翻红。
 * 「不制造只能在特定语句顺序下才成立的正确性」，代价是一个 ON CONFLICT 子句。
 *
 * kept_unread 刻意**不**保留旧值：本方法（与旧的 items.put 一样）语义是**整条覆盖**，
 * 缺席即「没有保持未读」。改成「同源保留」看着更安全，实际会让 endpoints.ts:364 的
 * 「取消保持未读」（saveItem + 省略该字段）静默失效。需要合并进当前记录的场景一律走 updateItem。
 */
const UPSERT_ITEM = `
  INSERT INTO items (id, feed_id, title, link, published_at, fetched_at, summary, read_at, starred, kept_unread, article_failure)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    feed_id         = excluded.feed_id,
    title           = excluded.title,
    link            = excluded.link,
    published_at    = excluded.published_at,
    fetched_at      = excluded.fetched_at,
    summary         = excluded.summary,
    read_at         = excluded.read_at,
    starred         = excluded.starred,
    kept_unread     = excluded.kept_unread,
    article_failure = excluded.article_failure`

/**
 * 写正文行。body 存 article.blocks 的 JSON 文本，另外四列各存 articleRecord 的一个字段
 * （spec §11.2 规定的 body + revision/frameable/title）。
 *
 * ⚠️ article.fetchedAt 在参考 schema 里**没有对应列**，而它是 articleRecord 的必填字段。
 * 这里另加一列 texts.fetched_at 存它，理由与 spec 保留 revision/frameable/title 完全相同：
 * refresh.ts:118 的 record.article?.fetchedAt 是正文缓存淘汰的**排序键**，缺了整表退化成不可判。
 * 另起一列而不是塞进 body，是免得「正文」这个概念出现两种形状。
 */
const UPSERT_TEXT = `
  INSERT INTO texts (item_id, body, revision, frameable, title, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(item_id) DO UPDATE SET
    body       = excluded.body,
    revision   = excluded.revision,
    frameable  = excluded.frameable,
    title      = excluded.title,
    fetched_at = excluded.fetched_at`

const DELETE_TEXT = 'DELETE FROM texts WHERE item_id = ?'
const DELETE_ITEM = 'DELETE FROM items WHERE id = ?'
const SELECT_CURSOR = 'SELECT * FROM cursors WHERE feed_id = ?'
const UPSERT_CURSOR = `
  INSERT INTO cursors (feed_id, seen, cursor_at) VALUES (?, ?, ?)
  ON CONFLICT(feed_id) DO UPDATE SET seen = excluded.seen, cursor_at = excluded.cursor_at`
const DELETE_CURSOR = 'DELETE FROM cursors WHERE feed_id = ?'

/** items 行（含 LEFT JOIN 出来的正文列）→ ItemRecord。 */
function toItemRecord(row: Record<string, SQLOutputValue>): ItemRecord {
  const record: Record<string, unknown> = {
    feedId: requiredText(row.feed_id, 'items.feed_id'),
    title: requiredText(row.title, 'items.title'),
    link: requiredText(row.link, 'items.link'),
    fetchedAt: requiredText(row.fetched_at, 'items.fetched_at'),
    starred: booleanAt(row.starred, 'items.starred'),
  }
  // 可选字段一律「有值才落键」：readAt === undefined 就是本仓库对「未读」的定义
  // （src/shared.ts:62 的 isUnread）。写一个 undefined 值的键会让 .strict() 的读侧校验
  // 与 isUnread 同时失准 —— 表现是「所有条目看起来都读过了」或反过来。
  const publishedAt = optionalText(row.published_at, 'items.published_at')
  if (publishedAt !== undefined) record.publishedAt = publishedAt
  const summary = optionalText(row.summary, 'items.summary')
  if (summary !== undefined) record.summary = summary
  const readAt = optionalText(row.read_at, 'items.read_at')
  if (readAt !== undefined) record.readAt = readAt
  const articleFailure = optionalText(row.article_failure, 'items.article_failure')
  if (articleFailure !== undefined) record.articleFailure = articleFailure
  // 0 与 NULL 都表示「没有保持未读」——旧实现里该字段是可选布尔，缺省即未保持
  if (row.kept_unread === 1 || row.kept_unread === 0) {
    if (booleanAt(row.kept_unread, 'items.kept_unread')) record.keptUnread = true
  } else if (row.kept_unread !== null) {
    booleanAt(row.kept_unread, 'items.kept_unread') // 非 0/1/NULL 一律响亮抛错
  }

  if (row.article_body !== null) {
    const article: Record<string, unknown> = {
      fetchedAt: requiredText(row.article_fetched_at, 'texts.fetched_at'),
      // body 就是 blocks 的 JSON 文本；解析失败会抛 —— 那是**响亮**的失败，好过编造空正文
      blocks: JSON.parse(requiredText(row.article_body, 'texts.body')),
    }
    const revision = optionalNumber(row.article_revision, 'texts.revision')
    if (revision !== undefined) article.revision = revision
    const articleTitle = optionalText(row.article_title, 'texts.title')
    if (articleTitle !== undefined) article.title = articleTitle
    if (row.article_frameable !== null) {
      article.frameable = booleanAt(row.article_frameable, 'texts.frameable')
    }
    record.article = article
  }
  // 与 domain.ts 的 rebuildItem 同一先例：按 schema 的字段表逐字段搬运之后，断言「搬出来的
  // 就是 ItemRecord」。不用 as any（本仓库硬约束），而 shape 与 itemRecordSchema 的同名性
  // 由 tests/store-sqlite.test.mjs 的 safeParse 逐条把守。
  return record as ItemRecord
}

/**
 * 正文缓存的字符数 —— 与 src/retention.ts 的 articleCharsOf 同口径（blocks 里 text / items 的
 * 字符数之和）。
 *
 * 为什么不 import articleCharsOf 再套一层：它的入参是**解析后的** articleRecord，而这里手上是
 * texts.body 的 JSON 文本。为了复用它得先解出整份 article（含 blocks 数组）再调它 —— 那正是
 * 「按需读行」要避免的搬运。两处的口径由 tests/store-sqlite.test.mjs 的对账测试钉住
 * （带正文的候选：SQL 侧算出的 articleChars 必须等于 articleCharsOf(记录里的 article)）。
 *
 * body 解析失败**响亮抛错**，不编造 0：那会让「释放了 0 字符」这个数字变成谎话。
 */
function articleCharsFromBody(body: string): number {
  const blocks: unknown = JSON.parse(body)
  if (!Array.isArray(blocks)) {
    throw new Error('订阅库里 texts.body 不是数组：库被外部改动过？值 = ' + describe(blocks))
  }
  let sum = 0
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const fields = block as Record<string, unknown>
    if (typeof fields['text'] === 'string') { sum += fields['text'].length; continue }
    if (Array.isArray(fields['items'])) {
      for (const item of fields['items']) sum += String(item).length
    }
  }
  return sum
}

/** 候选行 → 释放量原料（正文列缺席即「没有缓存」，与 articleCharsOf(undefined) === 0 同义）。 */
function articleCharsFromRow(row: Record<string, SQLOutputValue>): number {
  const body = row.body
  if (body === null) return 0
  return articleCharsFromBody(requiredText(body, 'texts.body'))
}

/** cursors 行 → CursorRecord。seen 列是 id 窗口的 JSON 文本（spec §2 的漏项表）。 */
function toCursorRecord(row: Record<string, SQLOutputValue>): CursorRecord {
  const record: Record<string, unknown> = {
    seen: JSON.parse(requiredText(row.seen, 'cursors.seen')),
  }
  const cursorAt = optionalText(row.cursor_at, 'cursors.cursor_at')
  if (cursorAt !== undefined) record.cursorAt = cursorAt
  return record as CursorRecord
}

/**
 * 订阅映射的读写全落在这两个小函数上（读侧唯一的形状保证点）。
 *
 * 为什么不缓存整份 config：`saveFeed` 每次都要「读 → 改一处 → 原子写回」，
 * 内存副本一旦过期就会把别的写者（用户的 OPML 导入、另一个面板）刚写的源静默回退掉。
 * 文件很小（200 源量级），重读比一致性便宜。
 */
function readFeeds(configPath: string): Record<string, FeedRecord> {
  return readConfigFile(configPath).feeds
}

/** 整份订阅映射读出来后交 `change` 改，再原子写回；`change` 返回新的整份映射（删源就是删掉一个键）。 */
function writeFeeds(
  configPath: string,
  change: (feeds: Record<string, FeedRecord>) => Record<string, FeedRecord>,
): void {
  const current: ReaderConfigFile = readConfigFile(configPath)
  writeConfigFile(configPath, { ...current, feeds: change(current.feeds) })
}

export function createSqliteStore(db: DatabaseSync, configPath: string): ReaderStore {
  // 版本握手：store 的每个方法都假定表在。顺序颠倒（先建 store、后 migrateSchema）若不在构造
  // 时就拦下，症状是「插件装载成功、第一次刷新才失败」——那时用户已经白等了一轮网络。
  const onDisk = db.prepare('PRAGMA user_version').get()?.user_version
  if (onDisk !== SCHEMA_VERSION) {
    throw new Error(
      'SQLite 存储没建表或格式版本不对（user_version = ' + describe(onDisk) + '，本版要 ' +
        SCHEMA_VERSION + '）：必须先 openDatabase 再 migrateSchema，最后才 createSqliteStore。',
    )
  }

  /**
   * 语句缓存。SQL 文本都是常量，所以「按文本查表」就是「按用途查缓存」。
   *
   * **刻意懒编译**：不在构造时把所有语句 prepare 一遍。这样「读路径到底发了哪条 SQL」在运行期
   * 是可观测的（tests/store-sqlite.test.mjs 包一层 db.prepare 就能录到），而
   * 「listItems 是不是真的走 WHERE feed_id = ?」正是本任务唯一无法用行为断言的判据。
   */
  const statements = new Map<string, StatementSync>()
  const sql = (text: string): StatementSync => {
    let statement = statements.get(text)
    if (statement === undefined) {
      statement = db.prepare(text)
      statements.set(text, statement)
    }
    return statement
  }

  /**
   * 把一次写包成一个事务。
   *
   * **先看 isTransaction**：db.exec('BEGIN') 在已有事务里会抛
   * 「cannot start a transaction within a transaction」——于是「调用方自己开了事务」
   * （当年 Task 4 的迁移就是单事务批量写）会把一次正常写入变成崩溃。已在事务里就**不提交**：
   * 提交权属于开事务的那个人。
   *
   * **还要 SAVEPOINT**：SQLite 里没有「内层失败不影响外层」这回事 —— 一条写语句失败只中止
   * **当前语句**，外层事务照常活着，于是库里会留下「行写进去了、正文没写」的半截状态。
   * SAVEPOINT 让失败精确回滚到这次写的开头（外层事务与它之前的写都保住）。
   * 回滚也失败时必须与原错误一起抛出：吞掉它等于留下一个说不清的坏库（本仓库禁止空 catch）。
   */
  function runInTransaction(write: () => void): void {
    const nested = db.isTransaction
    if (!nested) db.exec('BEGIN')
    db.exec('SAVEPOINT ' + SAVEPOINT)
    try {
      write()
    } catch (error) {
      try {
        db.exec('ROLLBACK TO ' + SAVEPOINT)
        db.exec('RELEASE ' + SAVEPOINT)
      } catch (rollbackError) {
        let outer = ''
        if (!nested) {
          try {
            db.exec('ROLLBACK')
          } catch (outerError) {
            // 连外层都没回滚掉：三个错误一起带出去，绝不在这里吞掉（禁止空 catch 的硬约束）
            outer = '；外层回滚错误：' + String(outerError)
          }
        }
        throw new Error(
          '写入失败且回滚也失败：' + String(error) + '；回滚错误：' + String(rollbackError) + outer,
          { cause: error },
        )
      }
      if (!nested) db.exec('ROLLBACK')
      throw error
    }
    db.exec('RELEASE ' + SAVEPOINT)
    if (!nested) db.exec('COMMIT')
  }

  /**
   * 写正文行；article 缺席（或没有 blocks）就把正文行删掉。
   *
   * 「没有 blocks」单独判一次：article.blocks 是可选字段，而 texts.body 是 NOT NULL ——
   * 一条只有 fetchedAt 的 articleRecord 没有可存的正文。本仓库**没有任何调用方会造**这种记录
   * （写正文的调用方一律带 blocks；domain.ts 的 normalizeLegacyArticle 是唯一会产生老形状的地方），
   * 所以这里选择「当作没有正文」，而不是编造一个空 blocks 糊过去（禁止编造数据）。
   *
   * ⚠️ **老形态（只有 paragraphs、没有 blocks）一律响亮拒绝**：`itemRecordSchema` 允许它，
   * 但库里的正文列存的是 blocks，写下去只会得到一个「有 items 行、正文行被删掉」的条目 ——
   * 用户重开时正文**静默消失**，而没有任何断言会翻红。转换只有一个口径（domain.ts 的
   * `normalizeLegacyArticle`），本模块不另抄一份。
   * 那个形状只剩「存储域年代的老数据」一种来路，而搬它进来的一次性迁移已下线（老文件已删）——
   * 这条守卫因此是**兼容读的保险**，不再有正常调用方会撞上它。
   */
  function writeArticle(itemId: string, article: ArticleRecord | undefined): void {
    if (article !== undefined && article.blocks === undefined && article.paragraphs !== undefined) {
      throw new Error(
        '拒绝写入老形态的正文缓存（只有 paragraphs、没有 blocks）：条目 ' + itemId + '。' +
          '库里没有存 paragraphs 的列，直写会让正文静默消失。请先过 domain.ts 的 normalizeLegacyArticle，' +
          '再调用 saveItem / updateItem。',
      )
    }
    if (article === undefined || article.blocks === undefined) {
      sql(DELETE_TEXT).run(itemId)
      return
    }
    sql(UPSERT_TEXT).run(
      itemId,
      JSON.stringify(article.blocks),
      article.revision ?? null,
      optionalFlag(article.frameable),
      article.title ?? null,
      article.fetchedAt,
    )
  }

  /** 整条覆盖一行 items + 它的正文。saveItem 与 updateItem 共用，免得两处列映射各写一份。 */
  function writeItem(itemId: string, record: ItemRecord): void {
    sql(UPSERT_ITEM).run(
      itemId,
      record.feedId,
      record.title,
      record.link,
      record.publishedAt ?? null,
      record.fetchedAt,
      record.summary ?? null,
      record.readAt ?? null,
      record.starred ? 1 : 0,
      record.keptUnread === true ? 1 : 0,
      record.articleFailure ?? null,
    )
    writeArticle(itemId, record.article)
  }

  /** 「这个源还在订吗」——视图偏好的选中态要用它。手上有订阅映射就是这里能给判据的唯一理由。 */
  const isKnownFeed = (feedId: string): boolean => readFeeds(configPath)[feedId] !== undefined

  return {
    /**
     * 读一条订阅。**config.json 读不出来时这里抛错**（readConfigFile 的既定语义）：
     * 返回 undefined 在用户眼里就是「这个源不存在了」，而它其实只是一次解析失败。
     */
    feed: (feedId) => readFeeds(configPath)[feedId],

    saveFeed: async (feedId, record) => {
      // 写侧过一遍形状校验：旧实现靠域设施的 zod 兜底，换实现不该把这个保证丢掉。
      // 认不出的记录若原样进文件，之后每次读都要再兜一次 —— 那就是「存储里攒着垃圾，只是被读侧遮住」。
      const safe = feedRecordSchema.parse(record)
      writeFeeds(configPath, (feeds) => ({ ...feeds, [feedId]: safe }))
    },

    cursor: (feedId) => {
      const row = sql(SELECT_CURSOR).get(feedId)
      return row === undefined ? undefined : toCursorRecord(row)
    },

    saveCursor: async (feedId, record) => {
      const safe = cursorRecordSchema.parse(record)
      runInTransaction(() => {
        sql(UPSERT_CURSOR).run(feedId, JSON.stringify(safe.seen), safe.cursorAt ?? null)
      })
    },

    deleteFeed: async (feedId) => {
      // 与旧实现逐条一致：只删源记录与它的游标，**不删条目**（条目由调用方一并删，
      // 见 src/store.ts:16 与 endpoints.ts 的 removeFeed）。在这里顺手多删会让「退订」
      // 变成一次看不见的批量删数据。
      //
      // **顺序是「先写 config、后删游标」，不能反过来**：两者落在不同介质上（文件 vs 库），
      // 中间失败无法共同回滚。反过来时若 config 写不进去（文件损坏/磁盘满），用户看到的是
      // 「源还在订阅列表里、游标却没了」——下一轮刷新会把整份 feed 当新内容重新导入成未读。
      // 这个顺序下最坏只是一条孤儿游标，无害。
      writeFeeds(configPath, (feeds) => {
        const next = { ...feeds }
        delete next[feedId]
        return next
      })
      runInTransaction(() => {
        sql(DELETE_CURSOR).run(feedId)
      })
    },

    item: (itemId) => {
      const row = sql(SELECT_ITEM).get(itemId)
      return row === undefined ? undefined : toItemRecord(row)
    },

    saveItem: async (itemId, record) => {
      const safe = itemRecordSchema.parse(record)
      runInTransaction(() => {
        writeItem(itemId, safe)
      })
    },

    /**
     * 原子读改写（src/store.ts:21-31 就是这条接口存在的原因）。
     *
     * 读与写必须落在**同一个事务**里：分成两次执行时，「读完到写回」之间插进来的并发写会被整条
     * 覆盖 —— 那正是 2026-10-10 用户实测的「详情页逐篇读，已读状态丢失」。
     * node:sqlite 是本进程内的**同步** API，而 db 是单连接：一个 runInTransaction 期间不可能有
     * 别的 JS 代码插进来，所以「读到的就是写回的基准」始终成立，不需要额外的锁。
     *
     * 缺失键**拒绝**而不是顺手创建：调用方应先确认条目在（src/store.ts:29）。
     */
    updateItem: async (itemId, fn) => {
      runInTransaction(() => {
        const row = sql(SELECT_ITEM).get(itemId)
        if (row === undefined) {
          throw new Error(
            'updateItem 拒绝：条目 ' + itemId + ' 不在库里。本接口的语义是「改一条已有的记录」，' +
              '不负责创建（src/store.ts:29）：调用方要先确认它在，而不是用「写一次就等于创建」蒙混过去。',
          )
        }
        const next = itemRecordSchema.parse(fn(toItemRecord(row)))
        writeItem(itemId, next)
      })
    },

    deleteItem: async (itemId) => {
      // 显式删两表，不把正确性押在 PRAGMA foreign_keys 的默认值上（spec §11.2 的注释同此意）。
      // 幂等：删一个不存在的键不是错误（旧实现同样是 no-op）。
      runInTransaction(() => {
        sql(DELETE_TEXT).run(itemId)
        sql(DELETE_ITEM).run(itemId)
      })
    },

    /**
     * 每源列表。WHERE feed_id = ? 是**扫描族的结构性修复**（spec §3.1）：旧实现遍历整表再在
     * JS 里过滤，200 源 × 10 万行下每轮刷新要 3 × 源数次全表扫描。这里把源条件交给 SQL 走 i1 索引。
     */
    listItems: (feedId) =>
      sql(SELECT_ITEM_BY_FEED).all(feedId).map((row) => {
        const itemId = requiredText(row.id, 'items.id')
        return [itemId, toItemRecord(row)] as [string, ItemRecord]
      }),

    /**
     * 全表读取。**保留无条件读整表是有意的**：accountOf / cleanup / buildOverview 现在都靠它
     * （spec §3.1 的另外三处扫描），Task 5 才把它们换成 SQL 聚合 —— 换掉之前若在这里顺手
     * 「优化」，只会让那三处的口径与 SQL 分家。
     *
     * ⚠️ 常驻/每轮路径不许用它代替 listArticleCacheEntries：它会把每份正文都解出来留在堆里
     * （`实测` 10 万条 × 8.8 KB ⇒ 堆峰值 1865 MB，超 spec §9.3 的 300 MB 验收线 6.2 倍）。
     */
    allItems: () =>
      sql(SELECT_ALL_ITEMS).all().map((row) => {
        const itemId = requiredText(row.id, 'items.id')
        return [itemId, toItemRecord(row)] as [string, ItemRecord]
      }),

    /**
     * 正文缓存闸门的清算原料（Task 9）：每条带缓存的条目只给 { id, chars, fetchedAt }。
     *
     * `chars` 走 articleCharsFromRow —— 与 listCleanupCandidates 的 articleChars、也与
     * retention.ts 的 articleCharsOf **同口径**，三处一致由 tests/store-sqlite.test.mjs 的
     * 对账用例钉住。parse 失败响亮抛出，不编造 0。
     */
    listArticleCacheEntries: () => {
      const entries: ArticleEntry[] = []
      // ⚠️ **必须 iterate()，不许 all()**：`all()` 会把 10 万行正文一次性物化成
      // `实测` 堆峰值 1865 MB（allItems 路径）/ 922 MB（只取 body 这条）——
      // 而 spec §9.3 的验收线是常驻内存 ≤ 300 MB。iterate() 逐行给，堆上同时只有一份 body。
      // `实测` 同夹具（200 源 × 500 条 × 8.8 KB）：堆峰值 **60.4 MB**、耗时 458 ms（验收线 300 MB 内）。
      for (const row of sql(SELECT_ARTICLE_CACHE_ENTRIES).iterate()) {
        entries.push({
          id: requiredText(row.id, 'items.id'),
          chars: articleCharsFromRow(row),
          fetchedAt: requiredText(row.article_fetched_at, 'texts.fetched_at'),
        })
      }
      return entries
    },

    /**
     * 每源未读（Task 5）：**SQL 侧聚合**，不再把整张 items 表物化到 JS 再数一遍。
     *
     * 传进来的键先铺 0，再把 SQL 数出来的覆盖上去 —— 顺序不能反。调用方按 feeds 表铺 0，
     * 而 `GROUP BY feed_id` 只返回**有未读行的**源：直接拿它当账目，未读为 0 的源会从回包里
     * 消失（界面上表现为左栏那一行的角标变成空白）。
     */
    unreadPerFeed: (feedIds) => {
      const unread: Record<string, number> = {}
      for (const feedId of feedIds) unread[feedId] = 0
      for (const row of sql(SELECT_UNREAD_PER_FEED).all()) {
        const feedId = requiredText(row.feed_id, 'items.feed_id')
        // 只认传进来的键：已退订源的残留条目照样被 SQL 数出来，但账目上没有它的位置
        if (unread[feedId] === undefined) continue
        unread[feedId] = optionalNumber(row.unread, 'COUNT(*)') ?? 0
      }
      return unread
    },

    /**
     * 跨源最近 limit 条（Task 5）：排序键与上限都交给 SQL，走 i2 索引。
     *
     * limit ≤ 0 **在 JS 侧短路**：SQLite 把 `LIMIT -1` 当「无上限」，下传等于把整表读回来 ——
     * 那是静默的性能悬崖（结果看着还挺对）。非整数上限交给 SQLite 响亮报
     * 「datatype mismatch」，不在这里悄悄取整。
     */
    listRecent: (limit, cursor) => {
      if (limit <= 0) return []
      const rows = cursor === undefined
        ? sql(SELECT_RECENT).all(limit)
        : sql(SELECT_RECENT_AFTER).all(cursor.recency, cursor.recency, cursor.id, limit)
      return rows.map((row) => {
        const itemId = requiredText(row.id, 'items.id')
        return [itemId, toItemRecord(row)] as [string, ItemRecord]
      })
    },

    /**
     * 清理候选（Task 5）：一条 SQL 按判据选出 id，再用**一条**点读把每条的释放量原料补齐。
     *
     * 为什么补齐只读一列：候选常常几千条，而释放量只需要 articleChars + summaryChars。
     * 逐条走 item()（把正文块一起读出来）会在这一步把正文搬进内存 —— 与「按需读行」相反。
     * 正文缓存的字符数与 articleCharsOf **同口径**（blocks 里 text/items 的字符数之和；
     * 库里只存 blocks 形态，parse 失败会被 SQLite/json 响亮抛出，不编造 0）。
     */
    listCleanupCandidates: (cutoffIso) => {
      const ids = sql(SELECT_CLEANUP_IDS).all(cutoffIso).map((row) => requiredText(row.id, 'items.id'))
      return ids.map((id) => {
        const row = sql(SELECT_ITEM_CHARS).get(id)
        if (row === undefined) {
          throw new Error('清理候选 ' + id + ' 在补齐释放量时消失了：候选集与库里不一致（另一写者并发删了它？）')
        }
        return {
          id,
          // 谓词已经保证这三项（保持未读那条是本实现比 selectCleanup 多守的），照实回填即可
          starred: false,
          kept: false,
          read: true,
          recency: requiredText(row.recency, 'items.recency'),
          articleChars: articleCharsFromRow(row),
          summaryChars: optionalText(row.summary, 'items.summary')?.length ?? 0,
        }
      })
    },

    /**
     * 全部订阅源。顺序 = config.json 里 feeds 映射的键序（新订阅追加在末尾）：
     * 界面左栏就按这个顺序渲染，而它是用户订阅的自然顺序，也是他能在文件里核对到的那一份。
     */
    listFeeds: () => Object.entries(readFeeds(configPath)),

    /**
     * 读视图偏好。**读侧一律过 sanitizeViewPreferences**（src/store.ts:41-45 的承诺）：
     * 媒介里可能是别的版本写的、也可能被改坏，把垃圾透给调用方去兜 —— 兜底散在调用方迟早漏一处。
     * 已退订的源由 isKnownFeed 判掉、回落虚拟视图而**不抛错**：面板打不开比丢一次记忆更糟。
     */
    viewPreferences: () => sanitizeViewPreferences(readConfigFile(configPath).viewPreferences, isKnownFeed),

    /**
     * 写视图偏好。先把 config.json 读出来（读不出来就抛 —— **绝不能**拿一个空 feeds 覆盖它，
     * 那是用户仅有的订阅副本），再把归一后的偏好与文件的其余内容一起写回。
     */
    saveViewPreferences: async (preferences) => {
      const safe = sanitizeViewPreferences(preferences, isKnownFeed)
      const current: ReaderConfigFile = readConfigFile(configPath)
      writeConfigFile(configPath, { ...current, viewPreferences: safe })
      return safe
    },
  }
}
