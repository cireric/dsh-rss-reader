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
    // 原子读改写（ReaderStore 契约的一部分）：fn 在写入槽位看到当前记录，见 src/store.ts 的注释
    updateItem: async (id, fn) => { items.set(id, fn(items.get(id))) },
    deleteItem: async (id) => { items.delete(id) },
    listItems: (feedId) => [...items.entries()].filter(([, record]) => record.feedId === feedId),
    allItems: () => [...items.entries()],
    listFeeds: () => [...feeds.entries()],
    /**
     * 与自持实现同形（Task 5 的三条 SQL 取数方法）。
     *
     * 桩也必须守**同一条契约**：unreadPerFeed 先按传进来的键铺 0（0 未读的源留键）、
     * listCleanupCandidates 把 SQL 谓词多守的「保持未读不删」一并实现 —— 桩与实现各写一套
     * 语义，测出来的就只是桩的理解（docs/pitfalls.md 二、2.5 / 2.6）。
     */
    unreadPerFeed: (feedIds) => {
      const unread = {}
      for (const feedId of feedIds) unread[feedId] = 0
      for (const record of items.values()) {
        if (unread[record.feedId] === undefined || record.readAt !== undefined) continue
        unread[record.feedId] += 1
      }
      return unread
    },
    listRecent: (limit) => {
      if (limit <= 0) return []
      const rows = [...items.entries()]
      rows.sort(([idA, a], [idB, b]) => {
        const byTime = (b.publishedAt ?? b.fetchedAt).localeCompare(a.publishedAt ?? a.fetchedAt)
        return byTime !== 0 ? byTime : idA.localeCompare(idB)
      })
      return rows.slice(0, limit)
    },
    listCleanupCandidates: (cutoffIso) => {
      const rows = []
      for (const [id, record] of items.entries()) {
        const recency = record.publishedAt ?? record.fetchedAt
        // 判据 = retention.ts 的 selectCleanup（已读 + 未星标 + 早于阈值）另加「保持未读」保护
        if (record.readAt === undefined || record.starred || record.keptUnread === true) continue
        if (recency >= cutoffIso) continue
        rows.push({
          id, starred: false, kept: false, read: true, recency,
          articleChars: 0, summaryChars: record.summary?.length ?? 0,
        })
      }
      return rows
    },
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

/**
 * 失败标记必须只反映**最近一次**结果（契约见 src/domain.ts:28「最近一次失败原因；成功后清掉」）。
 *
 * 用户实测的病象：横幅一直写「月光博客（HTTP 502）」，而日志里该源连续十几次都是 not-modified ——
 * 即 502 只出现过一次、之后一路成功，标记却再没人清。根因是 304 分支用 `{...previous}` 写回，
 * 把旧的 lastFailure 一起带了回来。两条用例把「304 也是成功」这条钉住（200 那条防回归）。
 */
test('失败标记只反映最近一次：先 500 失败、再 304 成功 ⇒ 标记必须清掉', async () => {
  const store = memoryStore()
  let first = true
  await withServer((req, res) => {
    if (first) {
      first = false
      res.writeHead(500)
      res.end('boom')
      return
    }
    res.writeHead(304)
    res.end()
  }, async (base) => {
    const url = base + '/feed.xml'
    const [failed] = await refreshFeeds([url], store, BASE_OPTIONS)
    assert.equal(failed.status, 'failed', '前置条件：第一次失败')
    assert.match(store.feed(url).lastFailure, /500/, '前置条件：失败原因已记录')

    const [recovered] = await refreshFeeds([url], store, BASE_OPTIONS)
    assert.equal(recovered.status, 'not-modified', '前置条件：第二次是 304（源说内容没变）')
    assert.equal(store.feed(url).lastFailure, undefined,
      '304 也是成功：失败标记必须清掉 —— 否则「502 一闪而过、之后一路 304」的源会永远挂着失败横幅（用户实测）')
    assert.ok(store.feed(url).lastFetchedAt, '304 仍要记抓取时间')
  })
})

test('失败标记只反映最近一次：先 500 失败、再 200 成功 ⇒ 标记必须清掉', async () => {
  const store = memoryStore()
  let first = true
  await withServer((req, res) => {
    if (first) {
      first = false
      res.writeHead(500)
      res.end('boom')
      return
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(rss(THREE_ITEMS))
  }, async (base) => {
    const url = base + '/feed.xml'
    const [failed] = await refreshFeeds([url], store, BASE_OPTIONS)
    assert.equal(failed.status, 'failed', '前置条件：第一次失败')

    const [recovered] = await refreshFeeds([url], store, BASE_OPTIONS)
    assert.equal(recovered.status, 'added', '前置条件：第二次成功拿到内容')
    assert.equal(store.feed(url).lastFailure, undefined, '成功之后不该再显示上一次的失败原因')
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

/* ================= 丢失更新：刷新期间的写不得覆盖并发写入（2026-10-10） ================= */

/**
 * 让**下一次**对 `id` 的写入在其「窗口内」先落一次并发写（把 readAt 写进去）。
 *
 * 为什么用注入而不是真实并发：这两处的窗口只有一个微任务（读与构造之间没有 await），
 * 真实并发无法稳定复现；而缺陷的判据是明确的 —— 写入必须**合并进当前记录**，
 * 不许用写入前那份快照整体覆盖。注入把「窗口内有人写」变成确定性调度。
 *
 * ⚠️ 注入发生在写入方法内部、落盘之前：
 *   saveItem 那种「payload 早已定稿」的写法照样会把它盖掉；
 *   updateItem 的 fn 看到的则是含 readAt 的当前值 —— 这正是两者的分水岭。
 */
function armConcurrentRead(store, id, readAt) {
  let armed = true
  const inject = (target) => {
    if (!armed || target !== id) return
    armed = false
    const record = store.items.get(id)
    if (record !== undefined) store.items.set(id, { ...record, readAt })
  }
  const originalSave = store.saveItem
  const originalUpdate = store.updateItem
  store.saveItem = async (itemId, record) => { inject(itemId); return originalSave(itemId, record) }
  store.updateItem = async (itemId, fn) => { inject(itemId); return originalUpdate(itemId, fn) }
}

const RACE_READ_AT = '2024-06-01T00:00:00.000Z'

test('正文回填期间并发标已读：不得用旧快照整体写回（丢失更新）', async () => {
  const store = memoryStore()
  const item = { title: '一篇', link: 'https://ex.test/race-backfill', guid: 'g-race-backfill', date: 'Mon, 01 Jan 2024 00:00:00 GMT' }
  let description = '短摘要'
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(rss([{ ...item, description }]))
  }, async (base) => {
    await refreshFeeds([base + '/feed.xml'], store, BASE_OPTIONS)
    const itemId = [...store.items.keys()][0]
    assert.equal(store.items.get(itemId).readAt, undefined, '前置条件：该条目未读')

    // 回填这一次写的窗口内，用户把它标成已读（真机上由详情页切换/点击触发）
    armConcurrentRead(store, itemId, RACE_READ_AT)
    description = '完整正文。'.repeat(300)
    await refreshFeeds([base + '/feed.xml'], store, BASE_OPTIONS)

    assert.equal(store.items.get(itemId).summary, description, '前置条件：回填确实发生了')
    assert.equal(store.items.get(itemId).readAt, RACE_READ_AT,
      '回填不得抹掉窗口期内写入的已读态 —— 用户数据被并发写覆盖，正是详情页丢已读的同一类缺陷')
  })
})

test('正文缓存淘汰期间并发标已读：不得用旧快照整体写回（丢失更新）', async () => {
  const store = memoryStore()
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(rss(THREE_ITEMS))
  }, async (base) => {
    const feedUrl = base + '/feed.xml'
    await refreshFeeds([feedUrl], store, BASE_OPTIONS)
    const ids = [...store.items.keys()]
    assert.equal(ids.length, 3)

    // 三条都挂正文缓存（各 1000 字符），抓取时间递增 ⇒ 淘汰从最旧开始（见 selectArticleEvictions）
    for (const [index, id] of ids.entries()) {
      const record = store.items.get(id)
      await store.saveItem(id, {
        ...record,
        article: { fetchedAt: '2024-0' + (index + 1) + '-01T00:00:00.000Z', paragraphs: ['x'.repeat(1000)] },
      })
    }
    const oldest = ids[0]
    assert.ok(store.items.get(oldest).article !== undefined, '前置条件：最旧那条有正文缓存')

    // 淘汰这一次写的窗口内，用户把它标成已读
    armConcurrentRead(store, oldest, RACE_READ_AT)
    await refreshFeeds([feedUrl], store, { ...BASE_OPTIONS, maxArticleCacheChars: 1500 })

    assert.equal(store.items.get(oldest).article, undefined, '前置条件：最旧那条的缓存已被淘汰')
    assert.equal(store.items.get(oldest).readAt, RACE_READ_AT,
      '淘汰缓存只能去掉 article，不得抹掉窗口期内写入的已读态（丢失更新）')
  })
})


/* ================= 正文缓存闸门：全局预算（2026-10-11 任务 9） ================= */

/**
 * 起三个源各一条，各自挂 1000 字符的正文缓存，抓取时间**逐源递进**（源 1 最旧）。
 * 返回 [[feedUrl, itemId] × 3]。
 *
 * 为什么用三个**独立**的 HTTP 源而不是一个源里三条：分家的缺陷正落在「跨源」这一层 ——
 * 单源的用例在按源清算的旧实现下全绿，只有真的让三个源各背一份预算才抓得到。
 */
async function seedThreeFeedsWithArticle(store) {
  const seeded = []
  for (const n of [1, 2, 3]) {
    const item = { title: 't' + n, link: 'https://ex.test/g' + n, guid: 'g' + n, date: 'Mon, 0' + n + ' Jan 2024 00:00:00 GMT' }
    const pair = await withServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml' })
      res.end(rss([item]))
    }, async (base) => {
      const feedUrl = base + '/feed.xml'
      const [outcome] = await refreshFeeds([feedUrl], store, BASE_OPTIONS)
      assert.equal(outcome.added, 1, '前置条件：每个源各抓到一条')
      const itemId = [...store.items.entries()].find(([, record]) => record.feedId === feedUrl)[0]
      seeded.push([feedUrl, itemId])
      return [feedUrl, itemId]
    })
    void pair
  }
  for (const [index, [, itemId]] of seeded.entries()) {
    await store.saveItem(itemId, {
      ...store.items.get(itemId),
      article: { fetchedAt: '2024-0' + (index + 1) + '-01T00:00:00.000Z', paragraphs: ['x'.repeat(1000)] },
    })
  }
  return seeded
}

const cachedIds = (store) =>
  [...store.items.entries()].filter(([, record]) => record.article !== undefined).map(([id]) => id)

test('全局预算：每源都没超上限，但合计超了 ⇒ 必须跨源清（按源清算的漏网形态）', async () => {
  const store = memoryStore()
  const feeds = await seedThreeFeedsWithArticle(store)
  assert.equal(cachedIds(store).length, 3, '前置条件：三个源各有一条正文缓存')

  // 每源 1000 字符，上限 1500：按**每源**算，任一源都没超（1000 < 1500）⇒ 逐源清算一条都不清。
  // 全局预算下合计 3000 > 1500 ⇒ 清到只剩一条。
  await refreshFeeds(feeds.map(([url]) => url), store, { ...BASE_OPTIONS, maxArticleCacheChars: 1500 })

  assert.equal(cachedIds(store).length, 1,
    '合计超上限就得清：按源清算会让三个源各留一份，合计是上限的两倍')
  assert.equal(store.items.size, 3, '清缓存不得删条目')
})

test('全局预算：清掉的是跨源最旧的那条，不能只盯着清单里的某一个源', async () => {
  const store = memoryStore()
  const feeds = await seedThreeFeedsWithArticle(store)
  const [oldestUrl, oldestId] = feeds[0]
  const [, newestId] = feeds[2]

  await refreshFeeds(feeds.map(([url]) => url), store, { ...BASE_OPTIONS, maxArticleCacheChars: 1500 })

  const survivors = cachedIds(store)
  assert.equal(survivors.length, 1)
  assert.ok(!survivors.includes(oldestId),
    '源 ' + oldestUrl + ' 的缓存抓取时间最旧 ⇒ 第一个被清，跨源清算必须看得见别的源')
  assert.ok(survivors.includes(newestId), '最新的那条必须留下')
})

test('全局预算：合计在预算内时一条都不清（清缓存是降级，不该在没必要时发生）', async () => {
  const store = memoryStore()
  const feeds = await seedThreeFeedsWithArticle(store)
  await refreshFeeds(feeds.map(([url]) => url), store, { ...BASE_OPTIONS, maxArticleCacheChars: 5000 })
  assert.equal(cachedIds(store).length, 3, '合计 3000 ≤ 预算 5000 ⇒ 不动任何一条')
  assert.equal(store.items.size, 3)
})

test('全局预算：上限 <= 0 表示未配置，一条都不清（不是「整份清空」）', async () => {
  const store = memoryStore()
  const feeds = await seedThreeFeedsWithArticle(store)
  await refreshFeeds(feeds.map(([url]) => url), store, { ...BASE_OPTIONS, maxArticleCacheChars: 0 })
  assert.equal(cachedIds(store).length, 3,
    '上限 0 视为未配置：把用户的正文缓存整份清空是静默丢数据，不是限流')
  await refreshFeeds(feeds.map(([url]) => url), store, { ...BASE_OPTIONS, maxArticleCacheChars: -1 })
  assert.equal(cachedIds(store).length, 3, '负上限同理')
})
