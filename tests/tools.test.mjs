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
  SEARCH_MAX_ITEMS, SNIPPET_MAX_CHARS, TAGS_MAX, TITLE_MAX_CHARS, URL_MAX_CHARS, registerAgentTools,
} from '../lib/tools.js'

/**
 * 注册桩 ctx：`tools.register` 会记住 disposer，`on` 会记住监听器。
 * 返回值是「工具名 → 定义」的 Map，并额外挂 `disposers` / `listeners` 两个数组
 * （Map 上挂属性是测试夹具的省事写法，不是生产契约）。
 */
function mount(deps) {
  const registered = new Map()
  const disposers = []
  const listeners = []
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
    on(event, handler) {
      const entry = { event, handler }
      listeners.push(entry)
      return () => {
        const index = listeners.indexOf(entry)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
  }
  registerAgentTools(ctx, deps)
  registered.disposers = disposers
  registered.listeners = listeners
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

test('注册：四个工具挂在**传入的** ctx.tools 上，disposer 撤销后真的没了', () => {
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
    on: () => () => {},
  }
  registerAgentTools(ctx, { ready: () => store, searchItems: searchStub().run })

  assert.deepEqual([...registered.keys()].sort(), ['rss_list_feeds', 'rss_read_article', 'rss_search', 'rss_update_item'])
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
  assert.equal(disposers.length, 4, '四个工具都要把注册拿到的 disposer 交给宿主')
  for (const dispose of disposers) dispose()
  assert.equal(registered.size, 0, 'disposer 撤销后注册表必须真的空掉')

  // 撤销后再注册一次仍成立（宿主热重载走的就是「先解绑再重绑」）
  const again = mount({ ready: () => store, searchItems: searchStub().run })
  // 写入的逐次审批监听器也在同一个 ctx 上：重新装载必须重新挂上，且只有一个（不留残余门禁）
  assert.equal(again.listeners.length, 1)
  assert.equal(again.listeners[0].event, 'tools/pre-execute')
  for (const name of ['rss_search', 'rss_list_feeds', 'rss_read_article', 'rss_update_item']) {
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

test('rss_search：摘要带 author（有值字符串 / 无值 null / 超长截断并标记）', async () => {
  const { store } = freshStore('tools-author')
  await store.saveFeed('https://feed.example/rss', { url: 'https://feed.example/rss', title: '探针源' })
  const longAuthor = '作'.repeat(LABEL_MAX_CHARS + 20)
  const stub = searchStub({
    items: [hit({ author: '张三' }), hit({ id: 'item-2' }), hit({ id: 'item-3', author: longAuthor })],
  })
  const search = mount({ ready: () => store, searchItems: stub.run }).get('rss_search')
  const page = await search.execute({ query: 'x' }, exec)

  const [named, anonymous, long] = page.items
  assert.equal(named.author, '张三', '有作者时摘要必须带字符串作者')
  assert.equal('authorTruncated' in named, false, '没截断就不许凭空多一个标记')
  // 「没有作者」与「没有这个字段」对模型是两件事：前者 null，后者会让模型以为工具不提供作者。
  assert.equal('author' in anonymous, true, 'author 键本身必须存在')
  assert.equal(anonymous.author, null, '无作者时必须是 null，不是 undefined / 空串')
  assert.equal([...long.author].length, LABEL_MAX_CHARS, '作者超长按 label 预算截断')
  assert.equal(long.authorTruncated, true, '截断过就必须如实标记')
})

test('rss_search：工具描述写明命中面含作者（否则模型不知道可以按作者检索）', () => {
  const description = mount({ ready: () => undefined, searchItems: searchStub().run }).get('rss_search').description
  assert.match(description, /author/i, '描述必须写明作者也参与匹配，实际：' + description)
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

test('rss_read_article：base 元数据带 author（有值 / null）——搜索看到作者，读正文不能丢', async () => {
  const { store } = freshStore('tools-article-author')
  await store.saveFeed('https://feed.example/rss', { url: 'https://feed.example/rss', title: '探针源' })
  const base = { feedId: 'https://feed.example/rss', title: '标题', link: 'https://feed.example/post/1', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false }
  await store.saveItem('named', {
    ...base,
    author: '张三',
    article: { fetchedAt: '2026-11-01T00:00:00.000Z', revision: EXTRACTOR_REVISION, blocks: [{ kind: 'p', text: '正文' }] },
  })
  await store.saveItem('anonymous', base)
  const read = mount({ ready: () => store, searchItems: searchStub().run }).get('rss_read_article')

  const named = await read.execute({ itemId: 'named' }, exec)
  assert.equal(named.cached, true)
  assert.equal(named.author, '张三', '命中缓存的正文结果也必须带作者')

  // 没有作者时同样要显式给 null：缺键会让模型以为工具不提供作者（与摘要同一条形状）。
  const anonymous = await read.execute({ itemId: 'anonymous' }, exec)
  assert.equal('author' in anonymous, true, 'author 键本身必须存在')
  assert.equal(anonymous.author, null, '无作者时必须是 null')
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

test('rss_list_feeds：源行序 = listFeeds() 的返回序，工具不再按 id/标题排一次', async () => {
  // 宿主已经按 feedOrder 派生好顺序：feeds 的**键序**是 a、b，但 listFeeds 返回 b、a。
  // 工具若顺手再 sort 一次（或按文件夹重组），模型看到的目录就会和用户在左栏排的顺序分家。
  const store = {
    listFeeds: () => [
      ['b', { url: 'https://b.example/rss', title: 'B 源' }],
      ['a', { url: 'https://a.example/rss', title: 'A 源' }],
    ],
    unreadPerFeed: () => ({}),
    listFolders: () => [],
    listTags: () => [],
    feed: () => undefined,
    item: () => undefined,
  }
  const page = await mount({ ready: () => store, searchItems: searchStub().run }).get('rss_list_feeds').execute({}, exec)
  assert.deepEqual(page.feeds.items.map((row) => row.id), ['b', 'a'],
    '行序必须原样跟随宿主 listFeeds（非键序 b、a），不能由工具重新排序')
  assert.deepEqual(page.feeds.items.map((row) => row.title), ['B 源', 'A 源'])
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

test('rss_update_item：setRead / setStarred 显式动作生效，重复调用状态不变（幂等，不是 toggle）', async () => {
  const { store } = freshStore('tools-write')
  await store.saveFeed('https://feed.example/rss', { url: 'https://feed.example/rss', title: '探针源' })
  await store.saveItem('i1', {
    feedId: 'https://feed.example/rss', title: 't', link: 'https://feed.example/1', fetchedAt: '2026-11-01T00:00:00.000Z',
    starred: false, keptUnread: true,
    article: { fetchedAt: '2026-11-01T00:00:00.000Z', revision: EXTRACTOR_REVISION, blocks: [{ kind: 'p', text: '正文' }] },
  })
  const write = mount({ ready: () => store, searchItems: searchStub().run }).get('rss_update_item')

  const read = await write.execute({ itemId: 'i1', setRead: true }, exec)
  assert.equal(read.changed, true)
  assert.equal(typeof read.readAt, 'string', 'setRead:true 必须落一个时间戳')
  const stamped = store.item('i1')
  assert.equal(stamped.keptUnread, undefined, '标为已读要按规格清掉 kept-unread')

  // 幂等：再来一次不许刷新时间戳（重复请求状态一致）
  const again = await write.execute({ itemId: 'i1', setRead: true }, exec)
  assert.equal(again.changed, false, '已读条目再标已读必须是 no-op')
  assert.equal(again.readAt, read.readAt, '时间戳不许被重写')

  const starred = await write.execute({ itemId: 'i1', setStarred: true }, exec)
  assert.equal(starred.starred, true)
  assert.equal(store.item('i1').starred, true)

  const unstar = await write.execute({ itemId: 'i1', setStarred: false }, exec)
  assert.equal(unstar.starred, false, 'setStarred 是显式设值，不是反转')

  const unread = await write.execute({ itemId: 'i1', setRead: false }, exec)
  assert.equal(unread.readAt, null)
  assert.equal(store.item('i1').readAt, undefined, '取消已读 = 去掉 readAt（不是写 null）')

  // 正文缓存与其它字段必须原样还在
  const after = store.item('i1')
  assert.equal(after.article?.blocks?.[0]?.text, '正文', '写状态不许动正文缓存')
  assert.equal(after.title, 't')
})

test('rss_update_item：无动作 / 非布尔 / 未知条目 / 退订源条目一律拒绝', async () => {
  const { store } = freshStore('tools-write-bad')
  await store.saveFeed('https://feed.example/rss', { url: 'https://feed.example/rss', title: '探针源' })
  await store.saveItem('i1', { feedId: 'https://feed.example/rss', title: 't', link: 'https://l', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false })
  await store.saveItem('orphan', { feedId: 'https://gone.example/rss', title: 't', link: 'https://l', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false })
  const write = mount({ ready: () => store, searchItems: searchStub().run }).get('rss_update_item')

  await assert.rejects(write.execute({ itemId: 'i1' }, exec), /至少提供 setRead 或 setStarred/)
  await assert.rejects(write.execute({ itemId: 'i1', setRead: 'true' }, exec), /setRead 必须是布尔值/)
  await assert.rejects(write.execute({ itemId: 'i1', setStarred: 1 }, exec), /setStarred 必须是布尔值/)
  await assert.rejects(write.execute({ setRead: true }, exec), /itemId 必填/)
  await assert.rejects(write.execute({ itemId: 42, setRead: true }, exec), /itemId 必须是字符串/)
  await assert.rejects(write.execute({ itemId: 'nope', setRead: true }, exec), /条目不存在/)
  await assert.rejects(write.execute({ itemId: 'orphan', setRead: true }, exec), /已退订/, '退订源的残留条目不许被写')
  // 拒绝之后库里的状态一个字节都不该变
  assert.equal(store.item('i1').readAt, undefined)
  assert.equal(store.item('orphan').readAt, undefined)
})

test('写工具的逐次审批：pre-execute 只对本工具 ask，其它工具必须放行（waterfall 不许漏 next）', async () => {
  const { store } = freshStore('tools-approval')
  const registered = mount({ ready: () => store, searchItems: searchStub().run })
  assert.equal(registered.listeners.length, 1, '审批钩子只有一个入口')
  const listener = registered.listeners[0]
  assert.equal(listener.event, 'tools/pre-execute')

  let nextCalled = false
  const ask = await listener.handler(
    { name: 'rss_update_item', callId: 'c1', arguments: { itemId: 'i-42', setRead: true } },
    () => { nextCalled = true; return Promise.resolve({ kind: 'allow' }) },
  )
  assert.equal(ask.kind, 'ask', '写工具每次调用都必须走 ask')
  assert.match(ask.reason, /i-42/, '审批理由要带上是哪一条，人才知道自己在批什么')
  assert.equal(nextCalled, false, 'ask 是短路，绝不能再去调 next()')

  const pass = await listener.handler(
    { name: 'rss_search', callId: 'c2', arguments: {} },
    () => Promise.resolve({ kind: 'allow' }),
  )
  assert.deepEqual(pass, { kind: 'allow' }, '非写工具必须原样放行 —— 漏一句 next 就是全站工具闸死')
})

/**
 * 模型读到的正文里必须有表格与链接（R5 05）。
 *
 * 为什么这条必须落在工具层：`rss_read_article` 回给模型的是 **Markdown**，而统计/搜索读的是
 * `article-text.ts` 的纯文本投影 —— 两个口径**刻意不合并**（spec 决策 11）。于是「表格块加进来了」
 * 这件事对纯文本侧自动生效，对模型侧却要显式补分支：漏了它，模型读到的正文里整张表凭空消失，
 * 而所有其它测试照样绿（模型看不到的内容没有任何界面信号）。
 *
 * 旧块（标题 / 列表 / 代码围栏 / 段落）的输出形态由既有用例逐字节守着，这里只补新块。
 */
test('rss_read_article：表格摊成 Markdown 表格，带 runs 的块按 runs 摊平且链接成 [文字](href)', async () => {
  const { store } = freshStore('tools-markdown')
  await store.saveFeed('https://feed.example/rss', { url: 'https://feed.example/rss', title: '探针源' })
  const base = { feedId: 'https://feed.example/rss', title: '标题', link: 'https://feed.example/post/1', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false }
  await store.saveItem('rich', {
    ...base,
    article: {
      fetchedAt: '2026-11-01T00:00:00.000Z',
      revision: EXTRACTOR_REVISION,
      blocks: [
        { kind: 'table', header: ['参数', '标称值'], rows: [['额定功率', '5W'], ['输入电压', '220V']] },
        // 带 runs 的段落：link 必须渲染成 `[文字](href)`，其余 kind 只要文字（模型读不了样式）
        {
          kind: 'p',
          text: '详见官方文档。',
          runs: [
            { kind: 'text', text: '详见' },
            { kind: 'link', text: '官方文档', href: 'https://ex.test/docs' },
            { kind: 'text', text: '。' },
          ],
        },
        { kind: 'p', text: '纯文本段落', runs: [{ kind: 'strong', text: '纯文本段落' }] },
      ],
    },
  })
  const read = mount({ ready: () => store, searchItems: searchStub().run }).get('rss_read_article')
  const page = await read.execute({ itemId: 'rich' }, exec)

  assert.equal(page.cached, true)
  assert.ok(page.text.includes('| 参数 | 标称值 |'), '表头必须是 Markdown 表格行，实际：' + page.text)
  assert.ok(page.text.includes('| 额定功率 | 5W |'), '单元格必须是 Markdown 表格行，实际：' + page.text)
  assert.ok(page.text.includes('| --- | --- |'), 'Markdown 表格必须有分隔行（否则渲染不成表格），实际：' + page.text)
  assert.ok(page.text.includes('[官方文档](https://ex.test/docs)'), '链接必须渲染成 [文字](href)，实际：' + page.text)
  assert.ok(page.text.includes('纯文本段落'), 'strong run 的文字必须保留（模型读不了加粗，但文字不能丢）')
  assert.ok(!page.text.includes('{'), '正文里不许出现 JSON 形状的 runs 残留')
})

test('rss_read_article：列表项里的链接也摊成 [文字](地址)（不只是段落）', async () => {
  // 审查实测抓到的缺口：段落走 runs 摊平能带地址，而列表分支只读 items（纯文本投影，不含 href），
  // 于是同一个模型读到的段落有地址、列表没地址。列表项的链接在 itemRuns 里。
  const { store } = freshStore('tools-list-link')
  await store.saveFeed('https://feed.example/rss', { url: 'https://feed.example/rss', title: '探针源' })
  const base = { feedId: 'https://feed.example/rss', title: '标题', link: 'https://feed.example/post/1', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false }
  const long = '列表项文字足够长以便通过四十字符门槛的判断，这里再加一些文字凑够长度。'
  await store.saveItem('listlink', {
    ...base,
    article: {
      fetchedAt: '2026-11-01T00:00:00.000Z',
      revision: EXTRACTOR_REVISION,
      blocks: [{
        kind: 'list',
        ordered: false,
        items: ['详见文档。' + long],
        itemRuns: [[
          { kind: 'text', text: '详见' },
          { kind: 'link', text: '文档', href: 'https://ex.test/doc' },
          { kind: 'text', text: '。' + long },
        ]],
      }],
    },
  })
  const read = mount({ ready: () => store, searchItems: searchStub().run }).get('rss_read_article')
  const page = await read.execute({ itemId: 'listlink' }, exec)
  assert.ok(page.text.includes('[文档](https://ex.test/doc)'),
    '列表项的链接地址必须进模型正文，实际：' + page.text)
})

test('rss_read_article：itemRuns 与 items 长度对不上时整份退回纯文本', async () => {
  // 与客户端同一条判据（要么都缺席、要么等长同序）：对不上就整份退回，不许「能对上的就渲染」，
  // 那会让同一列表里有的行带地址、有的不带，而模型无从知道为什么。
  const { store } = freshStore('tools-list-mismatch')
  await store.saveFeed('https://feed.example/rss', { url: 'https://feed.example/rss', title: '探针源' })
  const base = { feedId: 'https://feed.example/rss', title: '标题', link: 'https://feed.example/post/1', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false }
  const long = '列表项文字足够长以便通过四十字符门槛的判断，这里再加一些文字凑够长度。'
  await store.saveItem('badlist', {
    ...base,
    article: {
      fetchedAt: '2026-11-01T00:00:00.000Z',
      revision: EXTRACTOR_REVISION,
      blocks: [{
        kind: 'list', ordered: false, items: ['甲' + long, '乙' + long],
        itemRuns: [[{ kind: 'link', text: '甲', href: 'https://ex.test/a' }]],
      }],
    },
  })
  const read = mount({ ready: () => store, searchItems: searchStub().run }).get('rss_read_article')
  const page = await read.execute({ itemId: 'badlist' }, exec)
  assert.ok(!page.text.includes('https://ex.test/a'), '长度对不上时不许把那一组硬套到第一项上')
  assert.match(page.text, /甲/, '内容本身仍在（退回纯文本）')
})
