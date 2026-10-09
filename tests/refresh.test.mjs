/**
 * 刷新编排测试：用内存 store + 本地 HTTP 源，把三条不变式钉死。
 * 关键是第 6、7 条——它们是「去重不是归档」的那两个坑（见 docs/pitfalls.md §5.2）。
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
    allItems: () => [...items.entries()],
    deleteFeed: async (feedId) => { feeds.delete(feedId); cursors.delete(feedId) },
    saveItem: async (id, record) => { items.set(id, record) },
    deleteItem: async (id) => { items.delete(id) },
    listItems: (feedId) => [...items.entries()].filter(([, record]) => record.feedId === feedId),
  }
}

const LIMITS = { timeoutMs: 2000, maxBytes: 1_000_000, trustedTarget: true }
const BASE_OPTIONS = { limits: LIMITS, maxItemsPerFeed: 100, maxSeenPerFeed: 1000, maxContentChars: 100000, maxArticleCacheChars: 1000000, refreshConcurrency: 4 }

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
    const options = { limits: LIMITS, maxItemsPerFeed: 1, maxSeenPerFeed: 100, maxContentChars: 100000, maxArticleCacheChars: 1000000, refreshConcurrency: 1 }
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
test('裁剪保护星标：满上限时删未读，星标一条都不动', async () => {
  const store = memoryStore()
  const mk = (n) => ({ title: 't' + n, link: 'https://ex.test/' + n, guid: 'g' + n, date: 'Mon, 0' + n + ' Jan 2024 00:00:00 GMT' })
  // 同一台服务器、可变响应体：换服务器会换 feedId，裁剪也就换了对象（这个坑我踩过一次）
  let payload = rss([mk(1), mk(2), mk(3), mk(4)])
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(payload)
  }, async (base) => {
    const feedUrl = base + '/feed.xml'
    await refreshFeeds([feedUrl], store, { ...BASE_OPTIONS, maxItemsPerFeed: 4 })
    assert.equal(store.items.size, 4, '前置条件：先存满 4 条')

    // 把最旧的一条标为星标——它就是下轮最可能被裁的对象
    const oldest = [...store.items.entries()].sort((a, b) => (a[1].publishedAt ?? '').localeCompare(b[1].publishedAt ?? ''))[0][0]
    await store.saveItem(oldest, { ...store.items.get(oldest), starred: true })

    payload = rss([mk(1), mk(2), mk(3), mk(4), mk(5), mk(6)])
    await refreshFeeds([feedUrl], store, { ...BASE_OPTIONS, maxItemsPerFeed: 4 })

    assert.ok(store.items.has(oldest), '星标条目被裁剪删掉了 —— 这正是要防的回归')
    assert.equal(store.items.size, 4, '其余仍应裁到上限')
  })
})

test('正文缓存闸门：超限时清最旧的缓存，但条目本身与已读态保留', async () => {
  const store = memoryStore()
  const mk = (n) => ({ title: 't' + n, link: 'https://ex.test/' + n, guid: 'g' + n, date: 'Mon, 0' + n + ' Jan 2024 00:00:00 GMT' })
  const payload = rss([mk(1), mk(2), mk(3)])
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(payload)
  }, async (base) => {
    const feedUrl = base + '/feed.xml'
    await refreshFeeds([feedUrl], store, BASE_OPTIONS)
    const ids = [...store.items.keys()]
    assert.equal(ids.length, 3, '前置条件：三条')

    // 三条都挂正文缓存（各 1000 字符，共 3000），中间那条标已读、抓取时间居中
    for (const [index, id] of ids.entries()) {
      const record = store.items.get(id)
      await store.saveItem(id, {
        ...record,
        readAt: index === 1 ? '2024-06-01T00:00:00.000Z' : record.readAt,
        article: { fetchedAt: '2024-0' + (index + 1) + '-01T00:00:00.000Z', paragraphs: ['x'.repeat(1000)] },
      })
    }

    // 上限 1500 ⇒ 从最旧开始清两条，剩一条（1000 ≤ 1500）
    await refreshFeeds([feedUrl], store, { ...BASE_OPTIONS, maxArticleCacheChars: 1500 })

    const cached = [...store.items.values()].filter((r) => r.article !== undefined)
    assert.equal(cached.length, 1, '超限后应只剩一条缓存，实际 ' + cached.length + ' 条')
    assert.equal(store.items.size, 3, '清缓存不得删条目')
    const readOne = [...store.items.values()].find((r) => r.readAt === '2024-06-01T00:00:00.000Z')
    assert.ok(readOne !== undefined, '清缓存不得动已读态')
  })
})

test('正文缓存闸门：现行的 blocks 形态同样要被统计到（2026-10-07 修回归）', async () => {
  const store = memoryStore()
  const payload = rss(THREE_ITEMS)
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(payload)
  }, async (base) => {
    const feedUrl = base + '/feed.xml'
    await refreshFeeds([feedUrl], store, BASE_OPTIONS)
    const ids = [...store.items.keys()]
    assert.equal(ids.length, 3, '前置条件：三条')

    // **现行形态**：只写 blocks（index.ts 的 article 端点就是这样写的，paragraphs 已不再写入）。
    // 修复前闸门按 paragraphs 计字符 ⇒ 这里每条都算成 0 字符 ⇒ 永不触发，测试必须能抓到。
    for (const [index, id] of ids.entries()) {
      await store.saveItem(id, {
        ...store.items.get(id),
        article: {
          fetchedAt: '2024-0' + (index + 1) + '-01T00:00:00.000Z',
          revision: 2,
          blocks: [{ kind: 'p', text: 'x'.repeat(1000) }],
        },
      })
    }

    await refreshFeeds([feedUrl], store, { ...BASE_OPTIONS, maxArticleCacheChars: 1500 })

    const cached = [...store.items.values()].filter((r) => r.article !== undefined)
    assert.equal(cached.length, 1, 'blocks 形态也必须被闸门统计到；实际还剩 ' + cached.length + ' 条缓存')
    assert.equal(store.items.size, 3, '清缓存不得删条目')
  })
})

test('并发受控：同时在飞的抓取数不超过上限，且结果顺序与输入一致', async () => {
  const store = memoryStore()
  let inFlight = 0
  let peak = 0
  const slowFetch = async () => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 5))
    inFlight -= 1
    return { kind: 'ok', body: rss(THREE_ITEMS) }
  }
  const urls = Array.from({ length: 12 }, (_, i) => 'https://f' + i + '.test/feed')
  const outcomes = await refreshFeeds(urls, store, { ...BASE_OPTIONS, refreshConcurrency: 4, fetchFeedImpl: slowFetch })

  assert.equal(outcomes.length, 12, '每个输入都必须有结果，一个都不能少')
  assert.ok(peak >= 2, '并发峰值只有 ' + peak + ' —— 说明仍然是串行，并发没生效')
  assert.ok(peak <= 4, '并发峰值 ' + peak + ' 超过上限 4')
  assert.deepEqual(outcomes.map((o) => o.url), urls, '结果顺序必须与输入一致（并发不能打乱对应关系）')
})
test('正文回填的反面：源变短时不得用更短的正文覆盖更完整的正文', async () => {
  // 2026-10-07 变异测试发现的唯一真缺口：把 refresh.ts 里那句「只在更完整时才覆盖」的判定
  // 整个去掉，套件当时全绿 —— 说明这个方向从来没被断言过。
  const store = memoryStore()
  const item = { title: '一篇', link: 'https://ex.test/shrink', guid: 'g-shrink', date: 'Mon, 01 Jan 2024 00:00:00 GMT' }
  let description = '完整正文。'.repeat(300)
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(rss([{ ...item, description }]))
  }, async (base) => {
    const first = await refreshFeeds([base + '/feed.xml'], store, BASE_OPTIONS)
    assert.equal(first[0].added, 1)
    const itemId = [...store.items.keys()][0]
    const full = store.items.get(itemId).summary
    assert.equal(full, description, '前置条件：先存下完整正文')

    // 源改版/摘要化：同样的 guid，但正文变短了
    description = '短了。'
    const second = await refreshFeeds([base + '/feed.xml'], store, BASE_OPTIONS)
    assert.equal(second[0].added, 0, '已见过不该算新增')
    assert.equal(store.items.get(itemId).summary, full,
      '已存的完整正文不得被更短的版本覆盖：降级会静默丢掉用户本来能读到的内容')
  })
})
