/**
 * 刷新编排测试：用内存 store + 本地 HTTP 源，把三条不变式钉死。
 * 关键是第 6、7 条——它们是交接件 §8「去重不是归档」的那两个坑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { refreshFeeds } from '../lib/refresh.js'

function memoryStore() {
  const feeds = new Map()
  const cursors = new Map()
  const items = new Map()
  return {
    feeds,
    cursors,
    items,
    feed: (id) => feeds.get(id),
    saveFeed: async (id, record) => { feeds.set(id, record) },
    cursor: (id) => cursors.get(id),
    saveCursor: async (id, record) => { cursors.set(id, record) },
    item: (id) => items.get(id),
    saveItem: async (id, record) => { items.set(id, record) },
    deleteItem: async (id) => { items.delete(id) },
    listItems: (feedId) => [...items.entries()].filter(([, record]) => record.feedId === feedId),
  }
}

const LIMITS = { timeoutMs: 2000, maxBytes: 1_000_000 }
const BASE_OPTIONS = { limits: LIMITS, maxItemsPerFeed: 100, maxSeenPerFeed: 1000, maxContentChars: 100000 }

async function withServer(handler, run) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    return await run('http://127.0.0.1:' + port)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function rss(items) {
  const body = items.map((item) =>
    '<item><title>' + item.title + '</title><link>' + item.link + '</link><guid>' +
    item.guid + '</guid><pubDate>' + item.date + '</pubDate>' +
    (item.description === undefined ? '' : '<description><![CDATA[' + item.description + ']]></description>') +
    '</item>').join('')
  return '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>' +
    '<title>测试源</title>' + body + '</channel></rss>'
}

const THREE_ITEMS = [
  { title: '第一篇', link: 'https://ex.test/1', guid: 'g1', date: 'Mon, 01 Jan 2024 00:00:00 GMT' },
  { title: '第二篇', link: 'https://ex.test/2', guid: 'g2', date: 'Tue, 02 Jan 2024 00:00:00 GMT' },
  { title: '第三篇', link: 'https://ex.test/3', guid: 'g3', date: 'Wed, 03 Jan 2024 00:00:00 GMT' },
]

function serveFeed(items) {
  return (req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(rss(items))
  }
}

test('首次抓取：条目入库、游标记 id、源状态记标题', async () => {
  const store = memoryStore()
  await withServer(serveFeed(THREE_ITEMS), async (base) => {
    const outcomes = await refreshFeeds([base + '/feed.xml'], store, BASE_OPTIONS)
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0].status, 'added')
    assert.equal(outcomes[0].added, 3)

    assert.equal(store.items.size, 3)
    const cursor = store.cursor(base + '/feed.xml')
    assert.equal(cursor.seen.length, 3)
    assert.equal(store.feed(base + '/feed.xml').title, '测试源')

    // 两侧都排序再比：中文串的字典序按 UTF-16 码点，手写顺序不可靠
    const titles = store.cursor(base + '/feed.xml').seen.map((id) => store.items.get(id).title).sort()
    assert.deepEqual(titles, ['第三篇', '第二篇', '第一篇'].sort(), '三个条目 id 都要进去重窗口')

    const sample = store.items.get(store.cursor(base + '/feed.xml').seen[0])
    assert.equal(sample.readAt, undefined, '新条目必须是未读')
    assert.equal(sample.starred, false)
  })
})

test('重复抓取同一份 feed：不重复入库、不重复变未读', async () => {
  const store = memoryStore()
  await withServer(serveFeed(THREE_ITEMS), async (base) => {
    await refreshFeeds([base + '/feed.xml'], store, BASE_OPTIONS)
    const second = await refreshFeeds([base + '/feed.xml'], store, BASE_OPTIONS)
    assert.equal(second[0].added, 0, '同一条目第二次抓取必须一条都不新增')
    assert.equal(store.items.size, 3)
  })
})

test('304 走 not-modified：不发全量重抓，只更新抓取时间', async () => {
  const store = memoryStore()
  let hits = 0
  await withServer((req, res) => {
    hits += 1
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml', etag: '"v1"' })
    res.end(rss(THREE_ITEMS))
  }, async (base) => {
    await refreshFeeds([base + '/feed.xml'], store, BASE_OPTIONS)
    const again = await refreshFeeds([base + '/feed.xml'], store, BASE_OPTIONS)
    assert.equal(again[0].status, 'not-modified')
    assert.equal(again[0].added, 0)
    assert.equal(hits, 2)
    assert.ok(store.feed(base + '/feed.xml').lastFetchedAt, '304 也要记下抓取时间')
  })
})

test('单源失败就地降级，不阻断其余源', async () => {
  const store = memoryStore()
  await withServer((req, res) => {
    if (req.url === '/bad.xml') {
      res.writeHead(500)
      res.end('boom')
      return
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(rss(THREE_ITEMS))
  }, async (base) => {
    const outcomes = await refreshFeeds([base + '/bad.xml', base + '/good.xml'], store, BASE_OPTIONS)
    const byStatus = Object.fromEntries(outcomes.map((o) => [o.url, o.status]))
    assert.equal(byStatus[base + '/bad.xml'], 'failed')
    assert.equal(byStatus[base + '/good.xml'], 'added', '坏源不能拖累好源')
    assert.match(store.feed(base + '/bad.xml').lastFailure, /500/)
    assert.equal(store.items.size, 3)
  })
})

test('保留量裁剪：只留最新的 N 条', async () => {
  const store = memoryStore()
  await withServer(serveFeed(THREE_ITEMS), async (base) => {
    await refreshFeeds([base + '/feed.xml'], store, { ...BASE_OPTIONS, maxItemsPerFeed: 2 })
    assert.equal(store.items.size, 2)
    const titles = [...store.items.values()].map((record) => record.title).sort()
    assert.deepEqual(titles, ['第三篇', '第二篇'], '被裁掉的必须是最旧的一条')
  })
})

test('已读态在重复抓取后必须保持（有 readAt 就不得回退成未读）', async () => {
  const store = memoryStore()
  await withServer(serveFeed(THREE_ITEMS), async (base) => {
    await refreshFeeds([base + '/feed.xml'], store, BASE_OPTIONS)
    const itemId = [...store.items.keys()][0]
    const record = store.items.get(itemId)
    await store.saveItem(itemId, { ...record, readAt: '2024-06-01T00:00:00.000Z' })

    await refreshFeeds([base + '/feed.xml'], store, BASE_OPTIONS)

    const after = store.items.get(itemId)
    assert.ok(after, '已读条目不得因重新抓取而消失')
    assert.equal(after.readAt, '2024-06-01T00:00:00.000Z', '已读态必须原样保留')
  })
})

test('去重窗口与保留量解耦：条目被裁掉后不得重新抓成新条目', async () => {
  const store = memoryStore()
  await withServer(serveFeed(THREE_ITEMS), async (base) => {
    const options = { limits: LIMITS, maxItemsPerFeed: 1, maxSeenPerFeed: 100, maxContentChars: 100000 }
    await refreshFeeds([base + '/feed.xml'], store, options)
    assert.equal(store.items.size, 1)

    const again = await refreshFeeds([base + '/feed.xml'], store, options)
    assert.equal(again[0].added, 0, '滚出保留量≠滚出去重窗口：不得重新变成未读')
    assert.equal(store.items.size, 1)
  })
})

test('正文回填：正文变长的已见过条目要更新，且已读态与新增计数都不受影响', async () => {
  const store = memoryStore()
  const item = { title: '一篇', link: 'https://ex.test/long', guid: 'g-long', date: 'Mon, 01 Jan 2024 00:00:00 GMT' }
  let description = '短摘要'
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(rss([{ ...item, description }]))
  }, async (base) => {
    const first = await refreshFeeds([base + '/feed.xml'], store, BASE_OPTIONS)
    assert.equal(first[0].added, 1)
    const itemId = [...store.items.keys()][0]
    assert.equal(store.items.get(itemId).summary, '短摘要')

    // 用户把它标成已读
    await store.saveItem(itemId, { ...store.items.get(itemId), readAt: '2024-06-01T00:00:00.000Z' })

    // 源换了更完整的正文（同一 guid ⇒ 同一个条目 id）
    description = '完整正文。'.repeat(300)
    const second = await refreshFeeds([base + '/feed.xml'], store, BASE_OPTIONS)

    assert.equal(second[0].added, 0, '回填不该被算成新增条目')
    assert.equal(store.items.size, 1, '不该多出一个条目（id 派生必须稳定）')
    const after = store.items.get(itemId)
    assert.equal(after.summary, description, '正文必须被回填')
    assert.equal(after.readAt, '2024-06-01T00:00:00.000Z', '回填绝不能动已读态')
  })
})

test('正文上限：超长正文被截断并留下标记', async () => {
  const store = memoryStore()
  const long = 'X'.repeat(200)
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(rss([{ title: 'a', link: 'https://ex.test/a', guid: 'g1', date: 'Mon, 01 Jan 2024 00:00:00 GMT', description: long }]))
  }, async (base) => {
    await refreshFeeds([base + '/feed.xml'], store, { ...BASE_OPTIONS, maxContentChars: 50 })
    const record = [...store.items.values()][0]
    assert.match(record.summary, /已截断/, '超长正文必须被截断并标注')
    assert.ok(record.summary.length < long.length, '截断后必须更短')
  })
})

test('正文升级：内容版本落后时，该源第一轮必须绕开条件请求（否则永远回填不了）', async () => {
  const store = memoryStore()
  const conditionalHeaders = []
  const item = { title: '一篇', link: 'https://ex.test/u', guid: 'g-u', date: 'Mon, 01 Jan 2024 00:00:00 GMT', description: '正文'.repeat(200) }
  await withServer((req, res) => {
    conditionalHeaders.push(req.headers['if-none-match'] ?? null)
    if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304); res.end(); return }
    res.writeHead(200, { 'content-type': 'application/rss+xml', etag: '"v1"' })
    res.end(rss([item]))
  }, async (base) => {
    const feedId = base + '/feed.xml'
    await refreshFeeds([feedId], store, BASE_OPTIONS)
    assert.equal(store.feed(feedId).contentRevision, 2, '抓取成功后必须写内容版本')

    // 模拟旧数据：清掉版本号但保留 etag
    await store.saveFeed(feedId, { ...store.feed(feedId), contentRevision: undefined })
    await refreshFeeds([feedId], store, BASE_OPTIONS)

    assert.deepEqual(conditionalHeaders, [null, null], '升级轮不得带 If-None-Match（否则只拿到 304）')
    assert.equal(store.feed(feedId).contentRevision, 2, '升级轮结束后要写回版本号，避免每轮都全量')

    // 第三轮恢复正常的条件请求
    await refreshFeeds([feedId], store, BASE_OPTIONS)
    assert.deepEqual(conditionalHeaders, [null, null, '"v1"'], '升级完成后必须回到增量抓取')
  })
})

test('非法 URL 记为该源失败，不抛异常', async () => {
  const store = memoryStore()
  const outcomes = await refreshFeeds(['不是 URL'], store, BASE_OPTIONS)
  assert.equal(outcomes[0].status, 'failed')
  assert.match(outcomes[0].reason, /不是合法 URL/)
})