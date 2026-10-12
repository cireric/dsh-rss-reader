/**
 * 刷新编排测试：用内存 store + 本地 HTTP 源，把三条不变式钉死。
 * 关键是第 6、7 条——它们是「去重不是归档」的那两个坑（见 docs/pitfalls.md §5.2）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refreshFeeds, selectStalestFeeds } from '../lib/refresh.js'
import { Config, apply } from '../lib/index.js'

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
    /**
     * 清算原料（src/store.ts 的契约）：**只交出这三样，正文不许跟着出来**。
     * 桩也必须守这条 —— 否则测的其实是「桩自己把正文摊开了」，
     * 而生产实现恰恰是为了不让正文进堆才单列这条方法（docs/pitfalls.md 二、2.6）。
     */
    listArticleCacheEntries: () => {
      const entries = []
      for (const [itemId, record] of items.entries()) {
        if (record.article === undefined) continue
        const chars = (record.article.paragraphs ?? []).reduce((sum, paragraph) => sum + paragraph.length, 0)
          + (record.article.blocks ?? []).reduce((sum, block) => {
            const text = block.text
            if (typeof text === 'string') return sum + text.length
            const listItems = block.items
            if (Array.isArray(listItems)) return sum + listItems.reduce((inner, i) => inner + String(i).length, 0)
            return sum
          }, 0)
        entries.push({ id: itemId, chars, fetchedAt: record.article.fetchedAt ?? '' })
      }
      return entries
    },
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
    await withServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml' })
      res.end(rss([item]))
    }, async (base) => {
      const feedUrl = base + '/feed.xml'
      const [outcome] = await refreshFeeds([feedUrl], store, BASE_OPTIONS)
      assert.equal(outcome.added, 1, '前置条件：每个源各抓到一条')
      const itemId = [...store.items.entries()].find(([, record]) => record.feedId === feedUrl)[0]
      seeded.push([feedUrl, itemId])
    })
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


/**
 * ── 刷新调度：按陈旧度取源（2026-10-11 任务 10）────────────────────────────────────
 *
 * 病象：每一轮都抓**全部**源。200 源 / 并发 5 / 单源超时 15s ⇒ 最坏一轮 200 × 15 ÷ 5 = 600s
 * （spec §3、§6）。修法是把「这一轮抓哪些源」交给陈旧度排序，每轮只抓最旧的 K 个。
 *
 * **有界默认值之所以安全，唯一理由是「排序按陈旧度」**：这一轮没被选中的源，下一轮一定是
 * 最旧的那批，所以它一定会在有限轮次内被选中 —— 没有任何源会被永久跳过。
 * 下面第三条用例钉的就是这条旋转不变式（也是本任务真正的验收点，不是「选出 K 个」这个动作）。
 */

test('selectStalestFeeds：按 lastFetchedAt 升序取最旧的 K 个，未抓过的排最前（无限陈旧）', () => {
  const feeds = [
    ['c', { url: 'c', lastFetchedAt: '2026-10-03T00:00:00.000Z' }],
    ['a', { url: 'a' }],
    ['b', { url: 'b', lastFetchedAt: '2026-10-01T00:00:00.000Z' }],
    ['d', { url: 'd', lastFetchedAt: '2026-10-02T00:00:00.000Z' }],
  ]

  assert.deepEqual(selectStalestFeeds(feeds, 2), ['a', 'b'],
    '未抓过的（a）必须先于所有抓过的：没抓过 = 无限陈旧')
  assert.deepEqual(selectStalestFeeds(feeds, 3), ['a', 'b', 'd'], '再往上是抓取时间最早的')
  assert.equal(selectStalestFeeds(feeds, 1).length, 1, 'limit=1 只给一个')
  assert.deepEqual(selectStalestFeeds([], 5), [], '没有源就返回空（不得凭空造 id）')
})

test('selectStalestFeeds：limit ≥ 源数时返回全部，一个都不许丢', () => {
  const feeds = [
    ['a', { url: 'a' }],
    ['b', { url: 'b', lastFetchedAt: '2026-10-01T00:00:00.000Z' }],
    ['c', { url: 'c', lastFetchedAt: '2026-10-02T00:00:00.000Z' }],
  ]
  const all = selectStalestFeeds(feeds, 3)
  assert.deepEqual([...all].sort(), ['a', 'b', 'c'], 'limit 恰好等于源数 ⇒ 全部（相等也不许裁）')
  assert.equal(selectStalestFeeds(feeds, 99).length, 3, 'limit 更大 ⇒ 全部，不得返回 undefined 或重复 id')
  assert.equal(new Set(selectStalestFeeds(feeds, 99)).size, 3, '不得重复同一个源')
})

test('selectStalestFeeds：上限 <= 0 视为「未配置」⇒ 返回全部，不许解读成「一个都不抓」', () => {
  // 为什么是「全部」而不是「空」：空 = 每一轮都不抓任何源 ⇒ 所有源永久停更，
  // 那是**静默的全量停摆**，比「上限没配上」这句话严重得多（与 maxArticleCacheChars ≤ 0
  // 同一条纪律：非法上限一律回落到安全那一边，不制造破坏性行为）。
  const feeds = [
    ['a', { url: 'a' }],
    ['b', { url: 'b', lastFetchedAt: '2026-10-01T00:00:00.000Z' }],
  ]
  // 断言**具体是哪些 id**（不只是长度）：这条守卫内部一旦换了顺序（比如把「非法上限」那半
  // 挪到别的分支里），只断言长度的版本照样绿 —— 它看不见「谁被返回了」。
  const all = ['a', 'b']
  assert.deepEqual(selectStalestFeeds(feeds, 0), all, '0 不许解释成「这一轮一个都不抓」')
  assert.deepEqual(selectStalestFeeds(feeds, -1), all, '负上限同理')
  assert.deepEqual(selectStalestFeeds(feeds, Number.NaN), all, 'NaN 上限同样回落到安全侧')
  assert.deepEqual(selectStalestFeeds(feeds, Number.POSITIVE_INFINITY), all, '无穷大上限同理')
})

test('陈旧度调度的饥饿不变式：源数 > K 时，连续轮次内每个源都会被选中（旋转覆盖全部）', () => {
  // 这条是本任务的核心判据：**有界默认值**只有在「没被选中的下一轮必被选中」时才成立。
  // 5 个源、K=2：一轮全抓的实现会一次抓 5 个，而这条用例要求每一轮 ≤ 2 ——
  // 于是「有界」与「不饿死」必须同时成立，缺一条都翻红。
  const ids = ['a', 'b', 'c', 'd', 'e']
  let feeds = ids.map((id) => [id, { url: id }])
  const seen = new Set()
  for (let round = 0; round < 3; round += 1) {
    const picked = selectStalestFeeds(feeds, 2)
    assert.ok(picked.length <= 2, '第 ' + round + ' 轮最多抓 K=2 个，实际 ' + picked.length)
    for (const id of picked) seen.add(id)
    // 抓取成功：被选中的源拿到本轮时间戳（未被选中的保持原样 = 下一轮更旧）
    feeds = feeds.map(([id, record]) => picked.includes(id)
      ? [id, { ...record, lastFetchedAt: '2026-10-11T00:00:0' + round + '.000Z' }]
      : [id, record])
  }
  assert.deepEqual([...seen].sort(), ids,
    'K=2 抓 5 个源，3 轮内必须覆盖全部 —— 只要有一个源永远选不中，有界默认值就不能接受')
})


/**
 * 起 count 个各含一条的本地源；hits 记录**实际收到请求的源编号**。
 * 为什么每个源一台服务器：请求落在哪台服务器上就是「哪个源被抓了」的直接证据。
 */
async function startFeedServers(count, hits) {
  const started = []
  for (let n = 1; n <= count; n += 1) {
    const server = createServer((_req, res) => {
      hits.push(n)
      res.writeHead(200, { 'content-type': 'application/rss+xml' })
      res.end(rss([{
        title: '第' + n + '源', link: 'https://ex.test/f' + n, guid: 'g' + n,
        date: 'Mon, 01 Jan 2024 00:00:00 GMT',
      }]))
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    started.push({ server, url: 'http://127.0.0.1:' + server.address().port + '/feed.xml' })
  }
  return started
}

/**
 * 真装配：让 `refreshNow` 在真存储（真 sqlite + 真 config.json）上跑起来。
 *
 * 为什么非走到这一层：判据是「一轮最多抓 K 个源」，而 K 是在 `refreshNow` 里读的配置。
 * 只在 `tests/` 里断言 `selectStalestFeeds` 挑对了 K 个，恰恰漏掉本任务最可能失效的一段 ——
 * 「挑出来的子集有没有真的交给 `refreshFeeds`」（挑选对了却没接线 = 200 源照样一轮全抓）。
 * 仓库里有过「全套测试全绿而插件在 DSH 里是坏的」，所以这条接线必须有断言看着。
 *
 * $DSH_HOME 同时设 USERPROFILE：本机实际装的那个 storage-paths 实现优先读 USERPROFILE
 * （%USERPROFILE%\\.dsh），官方那版读 $DSH_HOME —— 两个实现都要落到同一个临时目录，
 * 判据才是「刷新调度」而不是「这台机器装的是哪个版本的路径算法」。用例结束一律复原。
 */
async function withRealRefresh(feedsPerRound, run) {
  const home = mkdtempSync(join(tmpdir(), 'rss-refresh-round-'))
  const savedHome = process.env.DSH_HOME
  const savedUserProfile = process.env.USERPROFILE
  process.env.DSH_HOME = home
  process.env.USERPROFILE = home
  const hits = []
  const disposers = []
  let handler
  let started = []
  try {
    started = await startFeedServers(3, hits)
    const ctx = {
      logger: { info: () => {}, warn: () => {} },
      effect: (callback) => { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
      webServer: { register: (route) => { handler = route.handler; return () => { handler = undefined } } },
      connection: { requestRejection: () => undefined },
    }
    apply(ctx, {
      feeds: started.map((entry) => entry.url),
      // 0 = 不节流（默认 10 分钟会把第二轮拦掉）；启动刷新保持开启，第一轮就发生在 apply 里
      minRefreshIntervalMs: 0,
      refreshOnStart: true,
      timeoutMs: 5000,
      refreshFeedsPerRound: feedsPerRound,
    })
    // 等启动那一轮真的跑完：判据是本插件自己写的那行「刷新完成」（log() 在 refreshOne 全部
    // 返回之后同步落盘）。轮询 config.json 或 sleep 都是在赌时间，而这条是**因果信号**。
    await waitForCompletedRounds(home, 1)
    return await run({ hits, handler, home })
  } finally {
    // 清理失败必须有可见后果：空 catch 正是本仓库记过的事故形状（吞掉失败 ⇒ 域句柄泄漏）。
    // 这里不 rethrow —— 在 finally 里抛会顶掉真正的断言失败，反而更难查。
    for (const dispose of disposers) {
      try { await dispose() } catch (error) { console.error('清理装配失败（不影响断言）：', error) }
    }
    for (const entry of started) await new Promise((resolve) => entry.server.close(resolve))
    rmSync(home, { recursive: true, force: true })
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    if (savedUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedUserProfile
  }
}

/**
 * 等 `rounds` 轮刷新**跑完落库**：数当天日志里的「刷新完成」行。
 *
 * 为什么不用 sleep：这台机器上跑测试时启动刷新可能还没落完，sleep 的时长就是在赌机器速度
 * （本仓库记过 sleep 型断言的坑）。为什么不用 config.json 的 lastFetchedAt：K=1 时一轮只
 * 抓一个源，等「全部源都有时间戳」要等到第 3 轮，信号是错的。
 */
function waitForCompletedRounds(home, rounds) {
  const root = join(home, 'storages', 'rss-reader')
  return (async () => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      let done = 0
      try {
        for (const name of readdirSync(root)) {
          if (!name.startsWith('reader-') || !name.endsWith('.log')) continue
          done += readFileSync(join(root, name), 'utf8').split('刷新完成').length - 1
        }
      } catch (error) {
        // 日志目录还没建出来是启动早期的正常状态，不是失败；其余错误必须可见
        if (error?.code !== 'ENOENT') console.error('读刷新日志失败：', error)
      }
      if (done >= rounds) return
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error('等 ' + rounds + ' 轮刷新完成超时（20s）—— 刷新很可能压根没跑起来')
  })()
}

/** 通过插件的真 HTTP 路由触发一轮 refresh（与客户端走的是同一条路）。 */
async function requestRefresh(handler) {
  const request = {
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ endpoint: 'refresh', payload: {} })) },
  }
  const response = { status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body } }
  await handler(request, response)
  return response
}

test('refreshNow 每轮只抓 refreshFeedsPerRound 个源，且下一轮换一批（接线 + 旋转）', async () => {
  await withRealRefresh(1, async ({ hits, handler, home }) => {
    assert.deepEqual(hits, [1], 'K=1 的第一轮只许抓一个源，实际 ' + JSON.stringify(hits))
    assert.equal(typeof handler, 'function', '前置条件：HTTP 路由必须注册上，否则第二轮无从触发')

    // requestRefresh 是 await 到底的（dispatch → refreshNow → await inFlight），
    // 所以它返回时这一轮已经落完库，hits 是稳定的。
    const response = await requestRefresh(handler)
    assert.equal(response.status, 200, 'refresh 端点应当正常返回')
    assert.deepEqual(hits, [1, 2],
      '第二轮必须抓**另一个**源（第一轮抓过的已不再最旧）；' +
      '若这里变成 [1,1,1] 就是「总是抓同一个源」，与本任务的不变式正相反')

    // 第三轮再换一个：三轮覆盖三个源 = 旋转真的在转
    await requestRefresh(handler)
    assert.deepEqual(hits, [1, 2, 3], '第三轮抓到最后一个没抓过的源')

    const feeds = JSON.parse(readFileSync(join(home, 'storages', 'rss-reader', 'config.json'), 'utf8')).feeds ?? {}
    assert.equal(Object.keys(feeds).length, 3, '整整三轮下来，三个源都必须还在订阅表里（不许因为没被选中而被丢）')
    assert.equal(hits.length, 3, '三轮恰好三次请求：既没漏抓也没把没选中的源捎上')
  })
})


test('refreshFeedsPerRound 的默认值必须是个具体条数（0 / Infinity = 把「一轮 600s」放回来）', () => {
  // 这条守的不是「20」这个数，而是**缺陷不许以默认值的形式复现**：selectStalestFeeds 把
  // 0 / NaN 解读成「未配置 ⇒ 抓全部」（安全侧），所以默认值一旦被改成 0 或 Infinity，
  // 全量抓取就悄悄回来了，而所有别的用例都照样绿 —— 那是本任务最容易被回退的形态。
  const parsed = Config({ feeds: [] })
  assert.ok(Number.isFinite(parsed.refreshFeedsPerRound), '默认值必须有限，不得是 Infinity')
  assert.ok(parsed.refreshFeedsPerRound > 0, '默认值必须 > 0；0 在调度里等于「每轮抓全部」')
  // 改动这个数 = 产品决策（见 src/config.ts 的注释：20 是起点值）。改了就同步改这里，
  // 让「默认调度有多宽」这件事在 diff 里看得见，而不是藏在一个 schema 字面量里。
  assert.equal(parsed.refreshFeedsPerRound, 20, '默认每轮 20 源；要改就带着实测证据一起改')
})

/**
 * ── 失败源不得饿死健康源（2026-10-11 修复轮 1，评审实测抓出的真缺陷）─────────────────
 *
 * 病象：调度若只看「上次成功抓取」（lastFetchedAt），**永久失败**的源永远拿不到那个时间戳，
 * 于是永远钉在「无限陈旧」那一端。这类源一旦 ≥ 每轮上限 K，每一轮选中的就是同一批失败源，
 * 所有健康源从此再也抓不到 —— 连 force 也救不回来（force 只绕节流、不绕轮转）。
 *
 * 下面第一条是纯函数层的复刻（含每轮的写规则）：它把 S ≥ K 这个形状直接钉死；
 * 第二条走真装配（真 sqlite + 真 config.json + 真 HTTP 路由 + 3 台真源，其中 1 台恒 500），
 * 证明「修法真的接在失败分支上」—— 纯函数层怎么改都测不到这一点。
 */
test('永久失败的源不得饿死健康源：S ≥ K 时每一轮都还能抓到新的健康源（复刻真实写规则）', () => {
  /**
   * 复刻 refreshOne 的写规则：选中的源**无论成败都盖 lastAttemptedAt**，只有成功才盖 lastFetchedAt。
   * 键一律照 selectStalestFeeds 的口径取，不另写一套 —— 否则测的只是这份复刻自己的理解。
   */
  const drive = (total, failing, limit, rounds) => {
    const ids = Array.from({ length: total }, (_, index) => 'f' + index)
    const broken = new Set(ids.slice(0, failing))
    let feeds = ids.map((id) => [id, { url: id }])
    const covered = new Set()
    for (let round = 0; round < rounds; round += 1) {
      const picked = selectStalestFeeds(feeds, limit)
      assert.ok(picked.length <= limit, '第 ' + round + ' 轮不得超过上限 K=' + limit)
      const stamp = '2026-10-12T00:' + String(round).padStart(2, '0') + ':00.000Z'
      feeds = feeds.map(([id, record]) => {
        if (!picked.includes(id)) return [id, record]
        if (broken.has(id)) return [id, { ...record, lastAttemptedAt: stamp }]
        covered.add(id)
        return [id, { ...record, lastFetchedAt: stamp, lastAttemptedAt: stamp }]
      })
    }
    return covered.size
  }

  // 形状一：S ≥ K（20 个永久失败 / K=20）。这正是旧排序键下「每一轮选中同一批失败源」的形状。
  assert.equal(drive(200, 20, 20, 60), 180,
    '20 个永久失败 + K=20：60 轮内 180 个健康源必须全部被抓到（旧实现是 0/180 的永久停摆）')
  // 形状二：源数刚好 3、1 个永久失败、K=1 —— 真装配用例用的就是这个形状
  assert.equal(drive(3, 1, 1, 10), 2,
    '3 源 / 1 个永久失败 / K=1：10 轮内另外 2 个健康源必须都被抓到（旧实现是 0/2）')
  // 形状三：失败源少于 K ⇒ 旧实现也能过（防这条新判据把「本来就行」的情形测反）
  assert.equal(drive(200, 5, 20, 60), 195, '5 个永久失败 / K=20：健康源同样要全覆盖')
  // 形状四：0 个失败 ⇒ 健康路径回归（与恢复全绿那条用例同形）
  assert.equal(drive(200, 0, 20, 20), 200, '没有失败源时，20 轮覆盖全部 200 个')
})

test('真装配：1 个源恒 500 时，K=1 的轮转仍能摸到另外两个健康源（失败分支必须盖尝试时间）', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rss-refresh-broken-'))
  const savedHome = process.env.DSH_HOME
  const savedUserProfile = process.env.USERPROFILE
  process.env.DSH_HOME = home
  process.env.USERPROFILE = home
  const hits = []
  const disposers = []
  let handler
  let broken /** 第一台服务器恒 500 */
  let healthy = [] /** ⚠️ 必须自己关：startFeedServers 只负责起（关是调用方的事，见 withRealRefresh） */
  try {
    broken = createServer((_req, res) => { hits.push('broken'); res.writeHead(500); res.end('boom') })
    await new Promise((resolve) => broken.listen(0, '127.0.0.1', resolve))
    const brokenUrl = 'http://127.0.0.1:' + broken.address().port + '/feed.xml'
    healthy = await startFeedServers(2, hits)
    const ctx = {
      logger: { info: () => {}, warn: () => {} },
      effect: (callback) => { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose); return dispose },
      webServer: { register: (route) => { handler = route.handler; return () => { handler = undefined } } },
      connection: { requestRejection: () => undefined },
    }
    // 失败源**放在最前**：它因此是「从未尝试过」那批里最靠前的，第一轮必然被选中并失败。
    // 若失败分支不盖尝试时间，它之后每一轮都还是最旧的 ⇒ 永久霸占 K=1 的窗口。
    apply(ctx, {
      feeds: [brokenUrl, ...healthy.map((entry) => entry.url)],
      minRefreshIntervalMs: 0,
      refreshOnStart: true,
      timeoutMs: 5000,
      refreshFeedsPerRound: 1,
    })
    await waitForCompletedRounds(home, 1)
    assert.deepEqual(hits, ['broken'], '第一轮：失败源最旧，先抓它（且它失败了）')

    await requestRefresh(handler)
    assert.deepEqual(hits, ['broken', 1],
      '第二轮必须换人：失败的尝试也要盖尝试时间，否则它会永远霸占 K=1 的窗口')
    await requestRefresh(handler)
    assert.deepEqual(hits, ['broken', 1, 2], '第三轮抓到第二个健康源 —— 两个健康源 3 轮内全覆盖')
    await requestRefresh(handler)
    assert.equal(hits[3], 'broken', '第四轮回到失败源（它是这三个里最久没试过的）—— 失败源同样不被饿死')
  } finally {
    for (const dispose of disposers) {
      try { await dispose() } catch (error) { console.error('清理装配失败（不影响断言）：', error) }
    }
    if (broken !== undefined) await new Promise((resolve) => broken.close(resolve))
    for (const entry of healthy) await new Promise((resolve) => entry.server.close(resolve))
    rmSync(home, { recursive: true, force: true })
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    if (savedUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = savedUserProfile
  }
})

