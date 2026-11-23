/**
 * R9 02：归档页回溯的宿主编排（spec §4.3–4.8，验收 A3 / A5–A13）。
 *
 * 全部用例都用内存 store + 抓取桩件：这里要钉的是**编排语义**（抓哪几篇、间隔多少、
 * 失败是否继续、上限与 deadline 怎么停、写进库里的字段），不是真实站点的版式。
 * 唯一一条走真实抓取层的是 A12：文章页私网拒绝必须由 fetch 层自己给出，不能在测试里
 * 再写一套「私网判断」（那样测的只是测试自己的规则）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createMemoryStore } from '../lib/memory-store.js'
import { Config } from '../lib/config.js'
import { backfillHistory, BackfillError } from '../lib/backfill.js'
import { deriveItemId } from '../lib/feed/item-id.js'
import { EXTRACTOR_REVISION } from '../lib/article.js'

const FEED_ID = 'https://feed.example.com/atom.xml'
const ARCHIVE_URL = 'https://feed.example.com/archives.html'

/** 已有条目的链接形态样本（3 条，恰好过 deriveLinkFilter 的下限）。 */
const SAMPLE_LINKS = [
  'https://feed.example.com/blog/2026/11/post-a.html',
  'https://feed.example.com/blog/2026/11/post-b.html',
  'https://feed.example.com/blog/2026/11/post-c.html',
]

function archivePage(links) {
  return '<!doctype html><html><body>' + links.map((href) => '<a href="' + href + '">文章</a>').join('\n') + '</body></html>'
}

/** 归档页抓取桩：记录调用的 URL / limits，回固定 HTML（finalUrl 默认等于入参）。 */
function archiveStub(links, options = {}) {
  const calls = []
  const impl = async (url, validators, limits) => {
    calls.push({ url, validators, limits })
    return { kind: 'ok', body: archivePage(links), finalUrl: options.finalUrl ?? url }
  }
  impl.calls = calls
  return impl
}

/** 文章页抓取桩：按 URL 回结果；未登记的 URL 回 404（并记录每一次调用，用来断言次数与顺序）。 */
function articleStub(results) {
  const calls = []
  const impl = async (url, limits) => {
    calls.push({ url, limits })
    const result = results[url]
    if (result === undefined) return { kind: 'failed', reason: 'HTTP 404' }
    return typeof result === 'function' ? result() : result
  }
  impl.calls = calls
  return impl
}

function okArticle(title, publishedAt, overrides = {}) {
  return {
    kind: 'ok',
    title,
    blocks: [{ kind: 'p', text: '正文内容' }],
    frameable: true,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    ...overrides,
  }
}

/** 一个带 3 条样本的源；样本的发布时间彼此不同，便于断言排序。 */
function makeStore(sampleLinks = SAMPLE_LINKS) {
  const store = createMemoryStore()
  store.feeds.set(FEED_ID, { url: FEED_ID, title: '示例源' })
  for (const [index, link] of sampleLinks.entries()) {
    store.items.set('seed-' + index, {
      feedId: FEED_ID,
      title: '已有文章 ' + index,
      link,
      publishedAt: '2026-11-01T0' + index + ':00:00.000Z',
      fetchedAt: '2026-11-01T00:00:00.000Z',
      starred: false,
    })
  }
  return store
}

const config = (overrides = {}) => Config({ maxItemsPerFeed: 100, ...overrides })

/* ==================== A5 / A6：日期 ==================== */

test('A5/A6 日期：抓到的 publishedAt 原样入库；没有发布日期的候选跳过并逐条报「无发布日期」', async () => {
  const store = makeStore()
  const dated = 'https://feed.example.com/blog/2020/01/dated.html'
  const undated = 'https://feed.example.com/blog/2020/02/undated.html'
  const archive = archiveStub([dated, undated])
  const articles = articleStub({
    [dated]: okArticle('有日期的文章', '2020-01-02T16:00:00.000Z'),
    [undated]: okArticle('没有日期的文章', undefined),
  })

  const report = await backfillHistory(
    { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 10 },
    { store, config: config(), fetchFeedImpl: archive, fetchArticleImpl: articles },
  )

  assert.equal(report.added, 1)
  assert.equal(report.attempted, 2)
  assert.deepEqual(report.failures, [{ url: undated, reason: '无发布日期' }],
    '没有发布日期的候选必须逐条进失败清单，且理由说清楚是缺日期')
  assert.equal(
    store.item(deriveItemId(FEED_ID, { link: dated }))?.publishedAt,
    '2020-01-02T16:00:00.000Z',
    '日期必须原样写入（不是抓取时间）',
  )
  assert.equal(store.item(deriveItemId(FEED_ID, { link: undated })), undefined, '无日期的条目绝不能用抓取时间顶替入库')
})

test('A5 排序：条目按 publishedAt 落在列表的正确位置，不是全堆顶部', async () => {
  const store = makeStore()
  const newest = 'https://feed.example.com/blog/2026/12/newest.html'
  const middle = 'https://feed.example.com/blog/2025/06/middle.html'
  const oldest = 'https://feed.example.com/blog/2020/01/oldest.html'
  const articles = articleStub({
    [newest]: okArticle('最新', '2026-12-01T00:00:00.000Z'),
    [middle]: okArticle('中间', '2025-06-01T00:00:00.000Z'),
    [oldest]: okArticle('最老', '2020-01-01T00:00:00.000Z'),
  })

  await backfillHistory(
    { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 10 },
    { store, config: config(), fetchFeedImpl: archiveStub([newest, middle, oldest]), fetchArticleImpl: articles },
  )

  const order = store.listRecent(10).map(([itemId]) => itemId)
  assert.equal(order[0], deriveItemId(FEED_ID, { link: newest }), '最新的一篇应排在顶部')
  assert.ok(
    order.indexOf(deriveItemId(FEED_ID, { link: oldest })) > order.indexOf('seed-0'),
    '2020 年的回溯条目必须排在已有的 2026-11 条目之后（不是全堆顶部）',
  )
})

/* ==================== A13：入库字段 ==================== */

test('A13 入库字段：未读、未星标、无 summary/author，正文缓存 revision 正确，link 是候选地址', async () => {
  const store = makeStore()
  const url = 'https://feed.example.com/blog/2020/01/kept.html'
  const blocks = [{ kind: 'p', text: '缓存下来的正文' }]
  const articles = articleStub({ [url]: okArticle('缓存标题', '2020-01-03T00:00:00.000Z', { blocks, frameable: false }) })

  const report = await backfillHistory(
    { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 10 },
    {
      store,
      // 上限与正文体积单独给值：顺手钉「文章页用 articleMaxBytes、归档页用 maxBytes」。
      config: config({ timeoutMs: 1234, maxBytes: 1111, articleMaxBytes: 5678 }),
      fetchFeedImpl: archiveStub([url]),
      fetchArticleImpl: articles,
    },
  )

  assert.equal(report.added, 1)
  const itemId = deriveItemId(FEED_ID, { link: url })
  const record = store.item(itemId)
  assert.ok(record !== undefined)
  assert.equal(record.link, url, 'link 存候选地址（不换成重定向落点）')
  assert.equal(record.title, '缓存标题')
  assert.equal(record.readAt, undefined, '回溯条目必须是未读（D5）')
  assert.equal(record.starred, false)
  assert.equal(record.summary, undefined, '不写 summary')
  assert.equal(record.author, undefined, '不写 author')
  assert.equal(record.article.revision, EXTRACTOR_REVISION, '正文缓存必须挂当前抽取器版本')
  assert.equal(record.article.title, '缓存标题')
  assert.deepEqual(record.article.blocks, blocks)
  assert.equal(record.article.frameable, false)
  assert.equal(store.unreadPerFeed([FEED_ID])[FEED_ID], 4, '未读数必须 +1（3 条样本 + 1 条回溯）')

  // 归档页与文章页各自的上限：归档页带 trustedTarget，文章页不带（SSRF 边界，spec §4.7）。
  assert.deepEqual(articles.calls[0].limits, { timeoutMs: 1234, maxBytes: 5678 })
})

/* ==================== A7：重复执行 ==================== */

test('A7 重复执行：第二次 added=0、attempted=0，文章抓取次数不增加', async () => {
  const store = makeStore()
  const first = 'https://feed.example.com/blog/2020/01/first.html'
  const second = 'https://feed.example.com/blog/2020/02/second.html'
  // 第三条是已有样本的协议变体：同文键应判成同一篇，第一次运行就不该抓它。
  const variant = 'http://feed.example.com/blog/2026/11/post-a.html'
  const archive = archiveStub([first, variant, second])
  const articles = articleStub({
    [first]: okArticle('第一篇', '2020-01-01T00:00:00.000Z'),
    [second]: okArticle('第二篇', '2020-02-01T00:00:00.000Z'),
  })
  const deps = { store, config: config(), fetchFeedImpl: archive, fetchArticleImpl: articles }

  const one = await backfillHistory({ feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 10 }, deps)
  assert.equal(one.added, 2)
  assert.equal(one.existing, 1, '协议变体命中的是已有条目')
  assert.equal(one.attempted, 2)
  assert.equal(articles.calls.length, 2)

  const two = await backfillHistory({ feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 10 }, deps)
  assert.equal(two.added, 0)
  assert.equal(two.attempted, 0, '已存在的候选在抓取前就被同文键跳过')
  assert.equal(two.existing, 3)
  assert.equal(articles.calls.length, 2, '第二次运行不许再发任何文章请求')
})

/* ==================== A8：单篇失败继续 ==================== */

test('A8 单篇失败继续：HTTP 404 与超时各记一条，其余照常入库且不重试', async () => {
  const store = makeStore()
  const okOne = 'https://feed.example.com/blog/2020/01/ok-1.html'
  const notFound = 'https://feed.example.com/blog/2020/02/404.html'
  const timeout = 'https://feed.example.com/blog/2020/03/timeout.html'
  const okTwo = 'https://feed.example.com/blog/2020/04/ok-2.html'
  const articles = articleStub({
    [okOne]: okArticle('第一篇', '2020-01-01T00:00:00.000Z'),
    [notFound]: { kind: 'failed', reason: 'HTTP 404' },
    [timeout]: { kind: 'failed', reason: '超时（15000ms）' },
    [okTwo]: okArticle('第二篇', '2020-04-01T00:00:00.000Z'),
  })

  const report = await backfillHistory(
    { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 10 },
    { store, config: config(), fetchFeedImpl: archiveStub([okOne, notFound, timeout, okTwo]), fetchArticleImpl: articles },
  )

  assert.equal(report.attempted, 4)
  assert.equal(report.added, 2)
  assert.deepEqual(report.failures, [
    { url: notFound, reason: 'HTTP 404' },
    { url: timeout, reason: '超时（15000ms）' },
  ], '失败清单必须逐条保留 URL 与原因')
  for (const url of [okOne, notFound, timeout, okTwo]) {
    assert.equal(articles.calls.filter((call) => call.url === url).length, 1, url + ' 只允许请求一次（不重试）')
  }
})

/* ==================== A9：300ms 串行间隔 ==================== */

test('A9 请求间隔：第一篇立即抓，之后每次前等 300ms，且严格串行', async () => {
  const store = makeStore()
  const urls = [
    'https://feed.example.com/blog/2020/01/a.html',
    'https://feed.example.com/blog/2020/02/b.html',
    'https://feed.example.com/blog/2020/03/c.html',
  ]
  const events = []
  const sleep = async (ms) => { events.push('sleep:' + ms) }
  const fetchArticleImpl = async (url) => {
    events.push('fetch:' + url)
    return okArticle('文章', '2020-01-01T00:00:00.000Z')
  }

  const report = await backfillHistory(
    { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 10 },
    { store, config: config(), fetchFeedImpl: archiveStub(urls), fetchArticleImpl, sleep },
  )

  assert.equal(report.attempted, 3)
  assert.deepEqual(events, [
    'fetch:' + urls[0],
    'sleep:300',
    'fetch:' + urls[1],
    'sleep:300',
    'fetch:' + urls[2],
  ], '第一篇不等待；之后每篇前恰好 300ms，且 sleep 与 fetch 严格交替')
})

/* ==================== A10：每源上限余量 ==================== */

test('A10 headroom：余量 H < 请求篇数 ⇒ 只抓 H 篇，stoppedBy=limit 且 remaining 报差', async () => {
  const store = makeStore() // 已有 3 条
  const urls = [
    'https://feed.example.com/blog/2020/01/a.html',
    'https://feed.example.com/blog/2020/02/b.html',
    'https://feed.example.com/blog/2020/03/c.html',
    'https://feed.example.com/blog/2020/04/d.html',
    'https://feed.example.com/blog/2020/05/e.html',
  ]
  const articles = articleStub(Object.fromEntries(urls.map((url, index) =>
    [url, okArticle('文章 ' + index, '2020-01-0' + (index + 1) + 'T00:00:00.000Z')])))
  const report = await backfillHistory(
    { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 5 },
    { store, config: config({ maxItemsPerFeed: 5 }), fetchFeedImpl: archiveStub(urls), fetchArticleImpl: articles },
  )

  assert.equal(report.attempted, 2, '余量 = 5 − 3 = 2')
  assert.equal(report.added, 2)
  assert.equal(report.stoppedBy, 'limit')
  assert.equal(report.remaining, 3)
  assert.equal(articles.calls.length, 2)
})

test('A10 余量为零：拒绝并零请求零写入', async () => {
  const store = makeStore() // 已有 3 条
  const archive = archiveStub(['https://feed.example.com/blog/2020/01/a.html'])
  const articles = articleStub({})

  await assert.rejects(
    backfillHistory(
      { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 5 },
      { store, config: config({ maxItemsPerFeed: 3 }), fetchFeedImpl: archive, fetchArticleImpl: articles },
    ),
    (error) => {
      assert.ok(error instanceof BackfillError, '必须是预期失败（BackfillError）')
      assert.equal(error.code, 'conflict')
      assert.match(error.message, /保留上限/)
      return true
    },
  )
  assert.equal(archive.calls.length, 0, '余量为零时连归档页都不该读')
  assert.equal(articles.calls.length, 0)
  assert.equal(store.items.size, 3, '零写入')
})

/* ==================== A11：120s deadline ==================== */

test('A11 deadline：假时钟推进到 120s 后不再发起新请求，stoppedBy=deadline 且 remaining>0', async () => {
  const store = makeStore()
  const urls = [
    'https://feed.example.com/blog/2020/01/a.html',
    'https://feed.example.com/blog/2020/02/b.html',
    'https://feed.example.com/blog/2020/03/c.html',
    'https://feed.example.com/blog/2020/04/d.html',
    'https://feed.example.com/blog/2020/05/e.html',
  ]
  const start = Date.parse('2026-01-01T00:00:00.000Z')
  let clock = 0
  const now = () => new Date(start + clock)
  const sleep = async (ms) => { clock += ms }
  const fetchArticleImpl = async () => {
    clock += 50_000 // 每篇抓取 50s：第 4 篇前刚好越过 120s
    return okArticle('文章', '2020-01-01T00:00:00.000Z')
  }

  const report = await backfillHistory(
    { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 10 },
    { store, config: config(), fetchFeedImpl: archiveStub(urls), fetchArticleImpl, sleep, now },
  )

  assert.equal(report.attempted, 3, '第 4 篇在 deadline 检查处被拦下')
  assert.equal(report.stoppedBy, 'deadline')
  assert.ok(report.remaining > 0)
  assert.equal(report.remaining, 2)
})

/* ==================== A3：样本不足 ==================== */

test('A3 样本不足：少于 3 条已有条目 ⇒ bad-request，零归档请求、零文章请求、零写入', async () => {
  const store = createMemoryStore()
  store.feeds.set(FEED_ID, { url: FEED_ID, title: '新源' })
  for (const index of [0, 1]) {
    store.items.set('seed-' + index, {
      feedId: FEED_ID,
      title: '只有两条',
      link: SAMPLE_LINKS[index],
      fetchedAt: '2026-11-01T00:00:00.000Z',
      starred: false,
    })
  }
  const archive = archiveStub(['https://feed.example.com/blog/2020/01/a.html'])
  const articles = articleStub({})

  await assert.rejects(
    backfillHistory(
      { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 10 },
      { store, config: config(), fetchFeedImpl: archive, fetchArticleImpl: articles },
    ),
    (error) => {
      assert.ok(error instanceof BackfillError)
      assert.equal(error.code, 'bad-request')
      assert.match(error.message, /样本不足/)
      return true
    },
  )
  assert.equal(archive.calls.length, 0, '样本判定在出网之前，拒绝时不许读归档页')
  assert.equal(articles.calls.length, 0)
  assert.equal(store.items.size, 2)
})

/* ==================== 归档页读取失败 ==================== */

test('归档页读取失败 ⇒ bad-request 可读原因，且零文章请求', async () => {
  const store = makeStore()
  const articles = articleStub({})
  const archive = async () => ({ kind: 'failed', reason: 'HTTP 502' })

  await assert.rejects(
    backfillHistory(
      { feedId: FEED_ID, archiveUrl: ARCHIVE_URL, limit: 10 },
      { store, config: config(), fetchFeedImpl: archive, fetchArticleImpl: articles },
    ),
    (error) => {
      assert.ok(error instanceof BackfillError)
      assert.equal(error.code, 'bad-request')
      assert.match(error.message, /读取归档页失败：HTTP 502/)
      return true
    },
  )
  assert.equal(articles.calls.length, 0)
})

/* ==================== A12：文章页私网拒绝（真实抓取层） ==================== */

test('A12 私网：归档页按可信目标放行，文章页 127.0.0.1 被真实抓取层拒绝并进失败清单', async () => {
  let archiveHits = 0
  const server = createServer((request, response) => {
    archiveHits += 1
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end('<!doctype html><html><body><a href="/blog/2020/01/old.html">旧文</a></body></html>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = 'http://127.0.0.1:' + port
  try {
    const store = createMemoryStore()
    store.feeds.set(FEED_ID, { url: FEED_ID, title: '内网站点' })
    for (const index of [0, 1, 2]) {
      store.items.set('seed-' + index, {
        feedId: FEED_ID,
        title: '已有 ' + index,
        link: base + '/blog/2026/11/post-' + index + '.html',
        fetchedAt: '2026-11-01T00:00:00.000Z',
        starred: false,
      })
    }

    // 不注入任何抓取实现：归档页走真实 fetchFeed（trustedTarget=true 才进得来），
    // 文章页走真实 fetchArticle（不该出网，由地址策略直接拒）。
    const report = await backfillHistory(
      { feedId: FEED_ID, archiveUrl: base + '/archives.html', limit: 5 },
      { store, config: config({ timeoutMs: 1000 }) },
    )

    assert.equal(archiveHits, 1, '归档页确实被读取：私网目标按 addFeed 同一策略放行')
    assert.equal(report.attempted, 1)
    assert.equal(report.added, 0)
    assert.equal(report.failures.length, 1)
    assert.match(report.failures[0].reason, /内网/, '文章页指向 127.0.0.1 必须由抓取层拒绝')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
