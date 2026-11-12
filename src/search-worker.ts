import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import { decodeCursor, encodeCursor, recencyOf, type ItemView, type SearchPage, type SearchQuery } from './shared.js'

const db = new DatabaseSync(workerData, { readOnly: true })
const port = parentPort
if (!port) throw new Error('搜索必须在独立线程运行')

// 以原始正文作为缓存键，正文被替换或淘汰后，旧投影不可能重新成为候选。
const projections = new Map<string, string>()
let cachedChars = 0
db.function('rss_search_text', { deterministic: true }, (body) => {
  if (typeof body !== 'string') return ''
  const cached = projections.get(body)
  if (cached !== undefined) return cached
  const blocks: unknown = JSON.parse(body)
  if (!Array.isArray(blocks)) throw new Error('缓存正文格式无效')
  const value = blocks.flatMap((block: unknown) => {
    if (block === null || typeof block !== 'object') return []
    if ('kind' in block && block.kind === 'img') {
      return ['alt', 'caption'].flatMap((field) => {
        const text = (block as Record<string, unknown>)[field]
        return typeof text === 'string' ? [text] : []
      })
    }
    if ('items' in block && Array.isArray(block.items)) return block.items.filter((item) => typeof item === 'string')
    return 'text' in block && typeof block.text === 'string' ? [block.text] : []
  }).join('\n').toLowerCase()
  const size = body.length + value.length
  const budget = 32 * 1024 * 1024
  if (size <= budget) {
    while (cachedChars + size > budget) {
      const oldest = projections.keys().next().value
      if (oldest === undefined) break
      cachedChars -= oldest.length + (projections.get(oldest)?.length ?? 0)
      projections.delete(oldest)
    }
    projections.set(body, value)
    cachedChars += size
  }
  return value
})
db.function('rss_search_lower', { deterministic: true }, (value) => typeof value === 'string' ? value.toLowerCase() : '')

let activeFlag: Int32Array | undefined
db.function('rss_search_active', () => {
  if (activeFlag && Atomics.load(activeFlag, 0)) throw new Error('搜索已取消')
  return 1
})

type Job = { id: number; query: SearchQuery; feeds: Array<[string, string]>; limit: number; flag: Int32Array }

function search({ query, feeds, limit, flag }: Job): SearchPage {
  const titles = new Map(feeds)
  if (!titles.size || Atomics.load(flag, 0)) return { items: [] }
  const terms = [...new Set(query.text.toLowerCase().split(/\s+/u))].sort((a, b) => b.length - a.length)
  const params: Record<string, string | number> = { limit: limit + 1 }
  const predicates = terms.map((term, index) => {
    const key = 'term' + index
    params[key] = term
    // 中文和 ASCII 查询可先走 SQLite 的原生匹配。其余词仍用 Unicode 小写。
    const lower = /[^\x00-\x7f\p{Script=Han}]/u.test(term) ? 'rss_search_lower' : 'lower'
    return `(instr(${lower}(i.title), :${key}) > 0 OR instr(${lower}(i.summary), :${key}) > 0
      OR CASE WHEN t.body IS NOT NULL THEN instr(rss_search_text(t.body), :${key}) > 0 ELSE 0 END)`
  })
  // SQLite 的 CASE 会短路。先检查较长的词，跳过已经无法满足 AND 的正文匹配。
  const match = predicates.reduceRight((rest, predicate) => `CASE WHEN ${predicate} THEN ${rest} ELSE 0 END`, '1')
  const where = []
  if (query.feedId !== undefined) {
    where.push('i.feed_id = :feed')
    params.feed = query.feedId
  } else {
    where.push('i.feed_id IN (SELECT value FROM json_each(:feeds))')
    params.feeds = JSON.stringify([...titles.keys()])
  }
  if (query.tagId !== undefined) {
    where.push('EXISTS (SELECT 1 FROM item_tags it WHERE it.item_id = i.id AND it.tag_id = :tag)')
    params.tag = query.tagId
  }
  if (query.read === 'read') where.push('i.read_at IS NOT NULL')
  if (query.read === 'unread') where.push('i.read_at IS NULL')
  if (query.starred) where.push('i.starred = 1')
  if (query.from) {
    where.push('i.recency >= :from')
    params.from = query.from
  }
  if (query.to) {
    where.push('i.recency <= :to')
    params.to = query.to + 'T23:59:59.999Z'
  }
  const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor)
  if (cursor) {
    where.push('i.recency <= :recency AND (i.recency < :recency OR (i.recency = :recency AND i.id > :id))')
    params.recency = cursor.recency
    params.id = cursor.id
  }
  // 用 CASE 固定取消检查的顺序，即使没有任何匹配也会检查共享标记。
  const rows = db.prepare(`SELECT i.id, i.feed_id, i.title, i.link, i.published_at, i.fetched_at,
    i.read_at, i.starred, i.kept_unread, i.summary
    FROM items i INDEXED BY ${query.feedId === undefined ? 'i2' : 'i1'}
    LEFT JOIN texts t ON t.item_id = i.id
    WHERE ${where.join(' AND ')} AND CASE WHEN rss_search_active() THEN (${match}) ELSE 0 END
    ORDER BY i.recency DESC, i.id ASC LIMIT :limit`).all(params)
  const items: ItemView[] = []
  for (const row of rows.slice(0, limit)) {
    const { id, feed_id, title, link, published_at, fetched_at, read_at, starred, kept_unread, summary } = row
    if (typeof id !== 'string' || typeof feed_id !== 'string' || typeof title !== 'string'
      || typeof link !== 'string' || typeof fetched_at !== 'string') throw new Error('搜索条目格式无效')
    const feedTitle = titles.get(feed_id)
    if (feedTitle === undefined) throw new Error('搜索条目所属源无效')
    items.push({ id, feedId: feed_id, feedTitle, title, link, fetchedAt: fetched_at,
      publishedAt: typeof published_at === 'string' ? published_at : undefined,
      readAt: typeof read_at === 'string' ? read_at : undefined,
      summary: typeof summary === 'string' ? summary : undefined,
      starred: starred === 1, keptUnread: kept_unread === 1 || undefined })
  }
  // 列表行的标签编辑需要每行当前 tag id；一页一次批量查询，不在渲染路径逐条查。
  if (items.length > 0) {
    const tagMap = new Map<string, string[]>()
    const tagRows = db.prepare(
      'SELECT item_id, tag_id FROM item_tags WHERE item_id IN (SELECT value FROM json_each(?)) ORDER BY item_id, tag_id',
    ).all(JSON.stringify(items.map((entry) => entry.id)))
    for (const row of tagRows) {
      if (typeof row.item_id !== 'string' || typeof row.tag_id !== 'string') throw new Error('标签关联格式无效')
      const list = tagMap.get(row.item_id) ?? []
      list.push(row.tag_id)
      tagMap.set(row.item_id, list)
    }
    for (const item of items) item.tagIds = tagMap.get(item.id) ?? []
  }
  if (rows.length > limit) {
    const last = items[items.length - 1]
    return { items, nextCursor: encodeCursor({ recency: recencyOf(last), id: last.id }) }
  }
  return { items }
}

port.on('message', (job: Job) => {
  activeFlag = job.flag
  try {
    port.postMessage({ id: job.id, page: search(job) })
  } catch (error) {
    port.postMessage({ id: job.id, error: String(error) })
  } finally {
    activeFlag = undefined
  }
})
