/**
 * M3 02 只读工具的行为钉子。
 *
 * 这里钉的是**工具层自己的判定**（参数校验、上限、游标栅栏、cached 原因、只读面、订阅归属），
 * 不是搜索匹配算法 —— 后者归 search.test.mjs（真 worker + 真 SQL）。因此 searchItems 在这一层
 * 是桩：桩只负责「按调用方给的条件回一页」，并且**把收到的 query 原样记下来**给断言看。
 *
 * 只读是**可证伪**的，不是注释里的承诺：用例把 fetch 换成必抛的桩、把 store 的写方法换成必抛的桩，
 * 再跑三个工具 —— 任何一处偷偷出网/写库都会当场翻红（ticket: 「假出网和写入探针」）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { freshStore } from './helpers/reader-store-memory.mjs'
import { EXTRACTOR_REVISION } from '../lib/article.js'
import {
  ARTICLE_MAX_CHARS, FAILURE_MAX_CHARS, FEEDS_MAX, FOLDERS_MAX, LABEL_MAX_CHARS, SEARCH_DEFAULT_ITEMS,
  SEARCH_MAX_ITEMS, SNIPPET_MAX_CHARS, TAGS_MAX, TITLE_MAX_CHARS, URL_MAX_CHARS, registerReadTools,
} from '../lib/tools.js'

/** 注册桩 ctx：只实现 tools.register，disposer 会真的把工具从表里摘掉。 */
function mount(deps) {
  const registered = new Map()
  const ctx = {
    tools: {
      register(definition) {
        assert.equal(registered.has(definition.name), false, '同名工具不得重复注册：' + definition.name)
        registered.set(definition.name, definition)
        return () => { registered.delete(definition.name) }
      },
    },
  }
  registerReadTools(ctx, deps)
  return registered
}

/** 一页搜索结果（ItemView 形状）。 */
const hit = (overrides = {}) => ({
  id: 'item-1',
  feedId: 'https://feed.example/rss',
  feedTitle: '探针源',
  title: '标题',
  link: 'https://feed.example/post/1',
  fetchedAt: '2026-11-01T00:00:00.000Z',
  starred: false,
  ...overrides,
})

/** 记录 searchItems 收到的 query/feeds/limit，并按需回一页。 */
function searchStub(page = { items: [] }) {
  const calls = []
  return {
    calls,
    run: async (query, feeds, limit, signal) => {
      calls.push({ query, feeds, limit, signal })
      return page
    },
  }
}

const signal = new AbortController().signal
const exec = { signal }

test('注册：三个工具挂在**传入的** ctx.tools 上，disposer 撤销后真的没了', () => {
  const { store } = freshStore('tools-reg')
  const registered = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(definition) {
        assert.equal(registered.has(definition.name), false, '同名工具不得重复注册：' + definition.name)
        registered.set(definition.name, definition)
        const dispose = () => { registered.delete(definition.name) }
        disposers.push(dispose)
        return dispose
      },
    },
  }
  registerReadTools(ctx, { ready: () => store, searchItems: searchStub().run })

  assert.deepEqual([...registered.keys()].sort(), ['rss_list_feeds', 'rss_read_article', 'rss_search'])
  for (const [name, definition] of [...registered]) {
    assert.equal(typeof definition.description, 'string', name + ' 必须有模型可见的描述')
    assert.ok(definition.description.length > 0, name + ' 的描述不能是空串')
    assert.equal(definition.parameters.type, 'object', name + ' 的参数根必须是对象')
    assert.equal(definition.parameters.additionalProperties, false, name + ' 的参数根必须封闭')
    assert.equal(typeof definition.output.schema, 'object', name + ' 必须声明 output.schema')
    assert.equal(typeof definition.output.render, 'function', name + ' 必须声明 output.render')
    assert.equal(typeof definition.execute, 'function', name + ' 必须声明 execute')
  }

  // 断言必须打到「撤销之后」这个状态：只断言注册过，等于没测注销。
  assert.equal(disposers.length, 3, '三个工具都要把注册拿到的 disposer 交给宿主')
  for (const dispose of disposers) dispose()
  assert.equal(registered.size, 0, 'disposer 撤销后注册表必须真的空掉')

  // 撤销后再注册一次仍成立（宿主热重载走的就是「先解绑再重绑」）
  const again = mount({ ready: () => store, searchItems: searchStub().run })
  for (const name of ['rss_search', 'rss_list_feeds', 'rss_read_article']) {
    assert.equal(again.has(name), true, name + ' 注销后可以重新注册')
  }
})

test('rss_search：默认 10 条、超过 30 夹到 30、非法 limit 响亮失败', async () => {
  const { store } = freshStore('tools-limit')
  await store.saveFeed('https://feed.example/rss', { url: 'https://feed.example/rss', title: '探针源' })
  const stub = searchStub()
  const registered = mount({ ready: () => store, searchItems: stub.run })
  const search = registered.get('rss_search')

  await search.execute({ query: 'x' }, exec)
  assert.equal(stub.calls.at(-1).limit, SEARCH_DEFAULT_ITEMS, '不传 limit 时默认 10 条（PRD §8.2）')

  await search.execute({ query: 'x', limit: 99 }, exec)
  assert.equal(stub.calls.at(-1).limit, SEARCH_MAX_ITEMS, '超过硬上限必须夹到 30，而不是照单全收')

  for (const bad of [0, -1, 1.5, '5']) {
    await assert.rejects(search.execute({ query: 'x', limit: bad }, exec), /limit 必须是正整数/, 'limit=' + String(bad) + ' 必须被拒')
  }
})

test('rss_search：筛选条件原样进查询，结果按 PRD §8.2 的字段表投影', async () => {
  const { store } = freshStore('tools-proj')
  await store.saveFeed('https://feed.example/rss', { url: 'https://feed.example/rss', title: '探针源' })
  const longSummary = 'A'.repeat(SNIPPET_MAX_CHARS + 40)
  const stub = searchStub({ items: [hit({ summary: longSummary, readAt: '2026-11-02T00:00:00.000Z' })] })
  const registered = mount({ ready: () => store, searchItems: stub.run })

  const page = await registered.get('rss_search').execute({
    query: '关键字', feedId: 'https://feed.example/rss', unread: true, starred: true, since: '2026-01-01', limit: 5,
  }, exec)

  const call = stub.calls.at(-1)
  assert.deepEqual(
    { text: call.query.text, feedId: call.query.feedId, read: call.query.read, starred: call.query.starred, from: call.query.from },
    { text: '关键字', feedId: 'https://feed.example/rss', read: 'unread', starred: true, from: '2026-01-01' },
    '四个筛选必须落到 SearchQuery 的同名字段上',
  )
  assert.deepEqual(call.feeds, [['https://feed.example/rss', '探针源']], '搜索必须只在这份源表范围内跑')
  assert.equal(call.signal, signal, '必须把调用方的取消信号传下去')

  assert.equal(page.count, 1)
  const item = page.items[0]
  assert.equal(item.itemId, 'item-1')
  assert.equal(item.url, 'https://feed.example/post/1', '必须带原文链接（PRD §8.2）')
  assert.equal(item.feedTitle, '探针源')
  assert.equal(item.readAt, '2026-11-02T00:00:00.000Z')
  assert.equal(item.starred, false)
  assert.equal([...item.snippet].length, SNIPPET_MAX_CHARS, '片段必须截到上限')
  assert.equal(item.snippetTruncated, true, '截断过就必须如实标记')
})

test('rss_search：游标必须被查询条件栅栏住，换条件续页响亮失败', async () => {
  const { store } = freshStore('tools-cursor')
  await store.saveFeed('https://feed.example/rss', { url: 'https://feed.example/rss', title: '探针源' })
  const stub = searchStub({ items: [], nextCursor: '2026-11-01T00:00:00.000Z|item-9' })
  const registered = mount({ ready: () => store, searchItems: stub.run })
  const search = registered.get('rss_search')

  const first = await search.execute({ query: 'a' }, exec)
  assert.ok(first.nextCursor, '有下一页时必须回 nextCursor')
  assert.ok(first.nextCursor.includes(':'), '游标必须带查询条件的栅栏前缀')

  await search.execute({ query: 'a', cursor: first.nextCursor }, exec)
  assert.equal(stub.calls.at(-1).query.cursor, '2026-11-01T00:00:00.000Z|item-9', '续页时必须把栅栏前缀剥掉再传下去')

  await assert.rejects(
    search.execute({ query: 'b', cursor: first.nextCursor }, exec),
    /分页游标与当前搜索条件不匹配/,
  )
  await assert.rejects(search.execute({ query: 'a', cursor: 'garbage' }, exec), /分页游标与当前搜索条件不匹配/)
})

test('rss_search：未知源 id / 非真实日期 / 超长关键词都在查询前被拒', async () => {
  const { store } = freshStore('tools-args')
  await store.saveFeed('https://feed.example/rss', { url: 'https://feed.example/rss', title: '探针源' })
  const stub = searchStub()
  const search = mount({ ready: () => store, searchItems: stub.run }).get('rss_search')
  const before = stub.calls.length

  await assert.rejects(search.execute({ feedId: 'https://nope.example/rss' }, exec), /未知的订阅源 id/)
  await assert.rejects(search.execute({ since: '2026/01/01' }, exec), /真实存在的 YYYY-MM-DD/)
  // 形状合法但不存在的那一天：Date.parse 会悄悄滚到 3 月 2 日，必须当场拒（2026-11-13 审查发现）
  await assert.rejects(search.execute({ since: '2026-02-30' }, exec), /真实存在的 YYYY-MM-DD/)
  await assert.rejects(search.execute({ since: '2026-13-01' }, exec), /真实存在的 YYYY-MM-DD/)
  await assert.rejects(search.execute({ query: 'x'.repeat(121) }, exec), /query 过长/)
  assert.equal(stub.calls.length, before, '参数不合法时一次搜索都不许发出去')
})

test('rss_search：类型错误的参数明确失败，绝不退回全库查询', async () => {
  const { store } = freshStore('tools-types')
  await store.saveFeed('https://feed.example/rss', { url: 'https://feed.example/rss', title: '探针源' })
  const stub = searchStub()
  const search = mount({ ready: () => store, searchItems: stub.run }).get('rss_search')
  const before = stub.calls.length

  for (const [args, pattern] of [
    [{ query: 123 }, /query 必须是字符串/],
    [{ feedId: 42 }, /feedId 必须是字符串/],
    [{ feedId: '' }, /feedId 不能是空字符串/],
    [{ feedId: '   ' }, /feedId 不能是空字符串/],
    [{ unread: 'yes' }, /unread 必须是布尔值/],
    [{ starred: 1 }, /starred 必须是布尔值/],
    [{ since: 20260101 }, /since 必须是字符串/],
    [{ cursor: [] }, /cursor 必须是字符串/],
  ]) {
    await assert.rejects(search.execute(args, exec), pattern, JSON.stringify(args) + ' 必须被拒')
  }
  assert.equal(stub.calls.length, before, '类型错误时一次搜索都不许发出去（这是「退回全库」的入口）')
})

test('rss_read_article：四种 cached:false 各有可解释原因，命中时给正文并截断', async () => {
  const { store } = freshStore('tools-article')
  await store.saveFeed('https://feed.example/rss', { url: 'https://feed.example/rss', title: '探针源' })
  const base = { feedId: 'https://feed.example/rss', title: '标题', link: 'https://feed.example/post/1', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false }
  await store.saveItem('missing-cache', { ...base, articleFailure: '原站 404' })
  await store.saveItem('never-cached', base)
  await store.saveItem('stale', { ...base, article: { fetchedAt: '2026-10-01T00:00:00.000Z', revision: EXTRACTOR_REVISION - 1, blocks: [{ kind: 'p', text: '旧正文' }] } })
  await store.saveItem('cached', { ...base, article: { fetchedAt: '2026-11-01T00:00:00.000Z', revision: EXTRACTOR_REVISION, blocks: [{ kind: 'p', text: '正文一' }, { kind: 'h', level: 2, text: '小节' }] } })
  const longText = 'x'.repeat(ARTICLE_MAX_CHARS + 10)
  await store.saveItem('huge', { ...base, article: { fetchedAt: '2026-11-01T00:00:00.000Z', revision: EXTRACTOR_REVISION, blocks: [{ kind: 'p', text: longText }] } })

  const read = mount({ ready: () => store, searchItems: searchStub().run }).get('rss_read_article')

  assert.equal((await read.execute({ itemId: 'nope' }, exec)).cached, false, '不存在的条目必须是 cached:false，不能抛错冒充「没有这篇」')
  assert.match((await read.execute({ itemId: 'nope' }, exec)).reason, /条目不存在/)

  const failed = await read.execute({ itemId: 'missing-cache' }, exec)
  assert.equal(failed.cached, false)
  assert.match(failed.reason, /原站 404/, '上次失败的原因必须回给模型，而不是一句「没有缓存」')

  const cold = await read.execute({ itemId: 'never-cached' }, exec)
  assert.equal(cold.cached, false)
  assert.match(cold.reason, /尚未缓存正文/)

  const stale = await read.execute({ itemId: 'stale' }, exec)
  assert.equal(stale.cached, false)
  assert.match(stale.reason, /已过期/)

  const ok = await read.execute({ itemId: 'cached' }, exec)
  assert.equal(ok.cached, true)
  assert.equal(ok.url, 'https://feed.example/post/1', '正文结果必须保留原文链接')
  assert.match(ok.text, /正文一/)
  assert.match(ok.text, /## 小节/, '标题块要还原成 markdown 标题')

  const huge = await read.execute({ itemId: 'huge' }, exec)
  assert.equal(huge.truncated, true, '超长正文必须标 truncated')
  assert.equal([...huge.text].length, ARTICLE_MAX_CHARS)
  assert.equal(huge.chars, ARTICLE_MAX_CHARS + 10, 'chars 报的是截断前的真实长度')
})

test('rss_read_article：退订源的残留条目不得泄漏标题、链接或正文', async () => {
  const { store } = freshStore('tools-orphan')
  // 只留条目、不留源 —— 这正是「退订只删源与游标，条目成孤儿」的真机形状。
  await store.saveItem('orphan', {
    feedId: 'https://gone.example/rss', title: '退订源的旧标题', link: 'https://gone.example/post/1',
    fetchedAt: '2026-11-01T00:00:00.000Z', starred: false,
    article: { fetchedAt: '2026-11-01T00:00:00.000Z', revision: EXTRACTOR_REVISION, blocks: [{ kind: 'p', text: '退订源的旧正文' }] },
  })
  const read = mount({ ready: () => store, searchItems: searchStub().run }).get('rss_read_article')

  const page = await read.execute({ itemId: 'orphan' }, exec)
  assert.equal(page.cached, false, '孤儿条目一律不许算作缓存命中')
  assert.match(page.reason, /已退订/)
  assert.equal('title' in page, false, '退订源的标题不许回给模型')
  assert.equal('url' in page, false, '退订源的链接不许回给模型')
  assert.equal('text' in page, false, '退订源的正文不许回给模型')
  assert.deepEqual(Object.keys(page).sort(), ['cached', 'itemId', 'reason'], '只留 itemId + 原因，元数据一个都不带')
})

test('rss_list_feeds：三个目录各自成信封（total / truncated / items），带未读与健康', async () => {
  const { store } = freshStore('tools-feeds')
  await store.saveFeed('https://a.example/rss', { url: 'https://a.example/rss', title: 'A 源', folder: '组', lastFetchedAt: '2026-11-01T00:00:00.000Z' })
  await store.saveFeed('https://b.example/rss', { url: 'https://b.example/rss', lastFailure: '超时' })
  await store.saveItem('i1', { feedId: 'https://a.example/rss', title: 't', link: 'https://a.example/1', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false })
  const tag = await store.createTag('标签一')

  const page = await mount({ ready: () => store, searchItems: searchStub().run }).get('rss_list_feeds').execute({}, exec)
  assert.deepEqual(Object.keys(page).sort(), ['feeds', 'folders', 'tags'], '顶层就是三个目录信封')
  assert.equal(page.feeds.total, 2)
  assert.equal(page.feeds.truncated, false)

  const [a, b] = page.feeds.items
  assert.equal(a.title, 'A 源')
  assert.equal(a.folder, '组')
  assert.equal(a.unread, 1, '每源未读必须按 feeds 表口径算')
  assert.equal(b.title, 'https://b.example/rss', '缺标题时回落成 id，而不是空白')
  assert.equal(b.lastFailure, '超时', '健康信息要透出来')
  assert.deepEqual(page.folders.items, [{ name: '组', feedCount: 1 }])
  assert.equal(page.folders.total, 1)
  assert.deepEqual(page.tags.items.map(t => t.name), ['标签一'])
  assert.equal(page.tags.items[0].id, tag.id)
})

test('rss_list_feeds：大目录按预算截断并如实报告（不静默丢源/目录/标签）', async () => {
  // 源表用最小只读桩：真 store 每条 saveFeed 都要整份重写 config.json，305 条要 1.7 s，
  // 而这条用例只关心「超限怎么办」，不关心落盘。
  const feeds = Array.from({ length: FEEDS_MAX + 5 }, (_, index) => ['https://f' + index + '.example/rss', { url: 'https://f' + index + '.example/rss', title: '源' + index }])
  const store = {
    listFeeds: () => feeds,
    unreadPerFeed: () => ({}),
    listFolders: () => Array.from({ length: FOLDERS_MAX + 3 }, (_, index) => ({ name: '夹' + index, feedIds: [] })),
    listTags: () => Array.from({ length: TAGS_MAX + 3 }, (_, index) => ({ id: 't' + index, name: '签' + index, createdAt: '2026-01-01T00:00:00.000Z' })),
    feed: () => undefined,
    item: () => undefined,
  }
  const page = await mount({ ready: () => store, searchItems: searchStub().run }).get('rss_list_feeds').execute({}, exec)

  assert.equal(page.feeds.total, FEEDS_MAX + 5, 'total 报的是真实源数，不是截断后的条数')
  assert.equal(page.feeds.items.length, FEEDS_MAX, '返回条数必须夹在上限上')
  assert.equal(page.feeds.truncated, true, '截断过就必须如实标记 —— 静默丢源等于让模型少看见 5 个订阅')

  assert.equal(page.folders.total, FOLDERS_MAX + 3)
  assert.equal(page.folders.items.length, FOLDERS_MAX)
  assert.equal(page.folders.truncated, true)

  assert.equal(page.tags.total, TAGS_MAX + 3)
  assert.equal(page.tags.items.length, TAGS_MAX)
  assert.equal(page.tags.truncated, true)
})

test('可变长字段按预算截断并逐字段标记（标题、源标题、链接、失败原因）', async () => {
  const longTitle = 'T'.repeat(TITLE_MAX_CHARS + 20)
  const longLabel = 'L'.repeat(LABEL_MAX_CHARS + 20)
  const longUrl = 'https://feed.example/' + 'u'.repeat(3000)
  const longFailure = 'F'.repeat(FAILURE_MAX_CHARS + 20)
  const store = {
    listFeeds: () => [
      ['https://feed.example/rss', { url: 'https://feed.example/rss', title: longLabel, folder: longLabel, lastFailure: longFailure }],
    ],
    unreadPerFeed: () => ({}),
    listFolders: () => [{ name: longLabel, feedIds: ['https://feed.example/rss'] }],
    listTags: () => [{ id: 't1', name: longLabel, createdAt: '2026-01-01T00:00:00.000Z' }],
    feed: () => ({ url: 'https://feed.example/rss', title: 'x' }),
    item: (id) => (id === 'long'
      ? {
        feedId: 'https://feed.example/rss', title: longTitle, link: longUrl, fetchedAt: '2026-11-01T00:00:00.000Z', starred: false,
        article: { fetchedAt: '2026-11-01T00:00:00.000Z', revision: EXTRACTOR_REVISION, blocks: [{ kind: 'p', text: '正文' }] },
      }
      : undefined),
  }
  const registered = mount({ ready: () => store, searchItems: searchStub({ items: [hit({ title: longTitle, feedTitle: longLabel, link: longUrl })] }).run })

  const feeds = await registered.get('rss_list_feeds').execute({}, exec)
  const feed = feeds.feeds.items[0]
  assert.equal([...feed.title].length, LABEL_MAX_CHARS)
  assert.equal(feed.titleTruncated, true, '源标题截断必须标记')
  assert.equal([...feed.folder].length, LABEL_MAX_CHARS)
  assert.equal(feed.folderTruncated, true, '文件夹名截断必须标记')
  assert.equal([...feed.lastFailure].length, FAILURE_MAX_CHARS)
  assert.equal(feed.lastFailureTruncated, true, '失败原因截断必须标记')
  assert.equal(feeds.folders.items[0].nameTruncated, true, '目录名同样受预算约束')
  assert.equal(feeds.tags.items[0].nameTruncated, true, '标签名同样受预算约束')

  const search = await registered.get('rss_search').execute({ query: 'x' }, exec)
  const item = search.items[0]
  assert.equal([...item.title].length, TITLE_MAX_CHARS)
  assert.equal(item.titleTruncated, true, '条目标题截断必须标记')
  assert.equal([...item.url].length, URL_MAX_CHARS)
  assert.equal(item.urlTruncated, true, '链接截断必须标记（截断后的链接已不可用）')

  const article = await registered.get('rss_read_article').execute({ itemId: 'long' }, exec)
  assert.equal([...article.title].length, TITLE_MAX_CHARS)
  assert.equal(article.titleTruncated, true)
  assert.equal(article.urlTruncated, true)
})

test('只读面：三个工具都不出网、不写库', async () => {
  const { store } = freshStore('tools-readonly')
  await store.saveFeed('https://feed.example/rss', { url: 'https://feed.example/rss', title: '探针源' })
  await store.saveItem('i1', {
    feedId: 'https://feed.example/rss', title: 't', link: 'https://feed.example/l', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false,
    article: { fetchedAt: '2026-11-01T00:00:00.000Z', revision: EXTRACTOR_REVISION, blocks: [{ kind: 'p', text: '正文' }] },
  })
  const writes = []
  const guarded = new Proxy(store, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^(save|update|delete|create|rename|move|merge|set)/.test(property)) {
        return (...args) => { writes.push([property, args]); throw new Error('工具不许写库：' + property) }
      }
      return Reflect.get(target, property, receiver)
    },
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('工具不许出网') }
  try {
    const registered = mount({ ready: () => guarded, searchItems: searchStub({ items: [hit()] }).run })
    await registered.get('rss_search').execute({ query: 'x' }, exec)
    await registered.get('rss_list_feeds').execute({}, exec)
    await registered.get('rss_read_article').execute({ itemId: 'i1' }, exec)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.deepEqual(writes, [], '三个只读工具一次写库都不许发生：' + JSON.stringify(writes))
})

test('未就绪：store 还没打开时三个工具都响亮失败，不返回空列表冒充结果', async () => {
  const registered = mount({ ready: () => undefined, searchItems: searchStub().run })
  for (const name of ['rss_search', 'rss_list_feeds', 'rss_read_article']) {
    const args = name === 'rss_read_article' ? { itemId: 'x' } : {}
    await assert.rejects(registered.get(name).execute(args, exec), /尚未就绪/, name + ' 必须报未就绪')
  }
})
