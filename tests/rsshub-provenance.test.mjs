/**
 * R15 02：订阅来源 `rsshub { namespace, path, instance? }` 的落库、合并与识别（spec §4.1.3 / §4.1.5）。
 *
 * 这组用例盯的是**字段一旦写下就不能悄悄消失**：
 *  - `feedRecordSchema` 是 strict：新字段必须显式加，否则 config.json 读写当场翻红；
 *  - `upsert-subscription` 的字段白名单漏了它，重复导入 OPML / 重新添加会抹掉来源（folder 同型事故）；
 *  - `refresh-success` / `refresh-not-modified` 是逐字段重建：漏了它，每刷新一次来源字段消失一次；
 *  - 老记录靠 origin 命中实例池识别，首次成功刷新后补写字段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { feedRecordSchema } from '../lib/domain.js'
import { readConfigFile, writeConfigFile } from '../lib/storage/config-file.js'
import { applyFeedIntent } from '../lib/feed-intent.js'
import { refreshFeeds } from '../lib/refresh.js'
import { openDatabase, migrateSchema } from '../lib/storage/db.js'
import { createSqliteStore } from '../lib/store-sqlite.js'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'
import { createRsshubSettings } from '../lib/rsshub-settings.js'
import { strictMemoryStore } from './helpers/reader-store-memory.mjs'

const PROVENANCE = { namespace: 'github', path: '/github/branches/DIYgod/RSSHub', instance: 'https://hub.example' }

test('FeedRecord.rsshub：strict schema 接受来源字段（instance 可缺省），config.json 读写往返不丢', () => {
  const url = 'https://hub.example/github/branches/DIYgod/RSSHub'
  const record = { url, title: '仓库分支', rsshub: PROVENANCE }
  const parsed = feedRecordSchema.safeParse(record)
  assert.equal(parsed.success, true, '不会 schema：' + (parsed.success ? '' : parsed.error.message))
  assert.deepEqual(parsed.data.rsshub, PROVENANCE, '三字段原样通过')

  assert.equal(feedRecordSchema.safeParse({ url, rsshub: { namespace: 'baoyu', path: '/baoyu/blog' } }).success, true,
    'instance 是可选字段：识别得出 namespace/path 就能落库')

  const dir = mkdtempSync(join(tmpdir(), 'rss-rsshub-provenance-'))
  const path = join(dir, 'config.json')
  try {
    writeConfigFile(path, { version: 1, feeds: { [url]: record, 'https://site.example/feed.xml': { url: 'https://site.example/feed.xml' } } })
    const read = readConfigFile(path)
    assert.deepEqual(read.feeds[url].rsshub, PROVENANCE, '写盘再读回必须保留来源字段（漏进 schema 会被 strict 拒或读侧丢）')
    assert.equal(Object.hasOwn(read.feeds['https://site.example/feed.xml'], 'rsshub'), false,
      '老记录没有来源字段时保持键缺席，不许物化成 undefined')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FeedRecord.rsshub：多余键、空 namespace / path 都被 strict schema 拒绝', () => {
  const url = 'https://hub.example/baoyu/blog'
  assert.equal(feedRecordSchema.safeParse({ url, rsshub: { namespace: 'baoyu', path: '/baoyu/blog', extra: 1 } }).success, false,
    '来源对象必须是 .strict()：认不出的键不许静默吞掉')
  assert.equal(feedRecordSchema.safeParse({ url, rsshub: { namespace: '', path: '/baoyu/blog' } }).success, false,
    'namespace 必须有值（min(1)）')
  assert.equal(feedRecordSchema.safeParse({ url, rsshub: { namespace: 'baoyu', path: '' } }).success, false,
    'path 必须是拼好的具体路径（min(1)）')
  assert.equal(feedRecordSchema.safeParse({ url, rsshub: { namespace: 'baoyu', path: '/baoyu/blog', instance: 42 } }).success, false,
    'instance 只接受字符串')
})

// ── feed-intent：字段白名单与逐字段重建（本票最容易出的错）──────────────────

const URL = 'https://hub.example/github/branches/DIYgod/RSSHub'

test('upsert-subscription：重复添加 / OPML 重导不抹掉已记录的来源（与 folder 同型的事故）', () => {
  const previous = { url: URL, title: '旧标题', rsshub: PROVENANCE }
  const merged = applyFeedIntent(previous, {
    kind: 'upsert-subscription', url: URL, title: '新标题', folder: undefined,
  })
  assert.deepEqual(merged.rsshub, PROVENANCE, 'intent 没带来源时（如池子被清空后重导）必须沿用旧字段')
  assert.equal(merged.title, '新标题', '其余字段的既有合并语义不变')

  const created = applyFeedIntent(undefined, {
    kind: 'upsert-subscription', url: URL, title: '新源', folder: undefined, rsshub: PROVENANCE,
  })
  assert.deepEqual(created.rsshub, PROVENANCE, '新源按 intent 写入来源')

  const other = { namespace: 'baoyu', path: '/baoyu/blog', instance: 'https://other.example' }
  const kept = applyFeedIntent(previous, {
    kind: 'upsert-subscription', url: URL, title: undefined, folder: undefined, rsshub: other,
  })
  assert.deepEqual(kept.rsshub, PROVENANCE, '已记录的来源是历史事实：重复导入不许被新的识别结果覆盖')
})

test('refresh-success / refresh-not-modified：逐字段重建的新对象必须显式带上 rsshub（新值优先，否则沿用）', () => {
  const previous = { url: URL, title: '旧标题', rsshub: PROVENANCE, etag: 'e', lastModified: 'm' }
  const success = applyFeedIntent(previous, {
    kind: 'refresh-success', url: URL, stamp: '2026-11-28T00:00:00.000Z',
    title: '新标题', etag: 'e2', lastModified: 'm2', contentRevision: 2,
  })
  assert.deepEqual(success.rsshub, PROVENANCE, '200 逐字段重建漏了它 ⇒ 每刷新一次来源字段消失一次')

  const notModified = applyFeedIntent(previous, {
    kind: 'refresh-not-modified', url: URL, stamp: '2026-11-28T00:00:00.000Z', contentRevision: 2,
  })
  assert.deepEqual(notModified.rsshub, PROVENANCE, '304 也是逐字段重建，同样必须带上')

  const fresh = { namespace: 'baoyu', path: '/baoyu/blog', instance: 'https://hub2.example' }
  const switched = applyFeedIntent(previous, {
    kind: 'refresh-success', url: URL, stamp: '2026-11-28T00:00:00.000Z',
    title: undefined, etag: undefined, lastModified: undefined, contentRevision: 2, rsshub: fresh,
  })
  assert.deepEqual(switched.rsshub, fresh, 'intent 给了新来源（票 03 的实际成功实例）时以新值为准')

  const failure = applyFeedIntent(previous, {
    kind: 'refresh-failure', url: URL, stamp: '2026-11-28T00:00:00.000Z', reason: 'HTTP 503',
  })
  assert.deepEqual(failure.rsshub, PROVENANCE, '失败意图展开 previous，来源原样保留')
})

// ── 端点写入点：addFeed / opmlImport（池从 ctx.rsshubSettings 取）────────────────

const rssOf = (title) => '<?xml version="1.0"?><rss version="2.0"><channel><title>' + title
  + '</title><item><title>a</title><link>https://site.example/a</link><guid>g-' + title
  + '</guid></item></channel></rss>'

async function rssServer(routes) {
  const server = createServer((req, res) => {
    const title = routes[req.url]
    if (title === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('no')
      return
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(rssOf(title))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    origin: 'http://127.0.0.1:' + address.port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function makeDispatch(feeds = {}, instances = []) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-rsshub-provenance-endpoint-'))
  const configPath = join(dir, 'config.json')
  writeConfigFile(configPath, {
    version: 1,
    feeds,
    ...(instances.length === 0 ? {} : { rsshub: { instances, hiddenNamespaces: [], hideNsfw: true } }),
  })
  const db = openDatabase(':memory:')
  migrateSchema(db)
  const store = createSqliteStore(db, configPath)
  const config = Config({ timeoutMs: 3000, importConcurrency: 2 })
  const control = createRsshubSettings({ config, configPath, log: () => {} })
  const dispatch = createDispatch({
    config,
    log: () => {},
    ready: () => store,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
    rsshubSettings: control,
  })
  return {
    dispatch, store, configPath, control,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test('addFeed：实例池 origin 上的地址落库时写入来源；非 RSSHub 源不写', async () => {
  const instance = await rssServer({ '/github/branches/DIYgod/RSSHub': '仓库分支' })
  const native = await rssServer({ '/feed.xml': '原生源' })
  const h = makeDispatch({}, [instance.origin])
  try {
    const radarUrl = instance.origin + '/github/branches/DIYgod/RSSHub'
    let result = await h.dispatch('addFeed', { url: radarUrl })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(h.store.feed(radarUrl).rsshub,
      { namespace: 'github', path: '/github/branches/DIYgod/RSSHub', instance: instance.origin },
      'Radar 添加（拼好的具体路径）必须带来源；path 不是模板')

    const nativeUrl = native.origin + '/feed.xml'
    result = await h.dispatch('addFeed', { url: nativeUrl })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(h.store.feed(nativeUrl).rsshub, undefined, '不在池里的 origin 不许被标成 RSSHub（不按路径猜）')
  } finally {
    await instance.close(); await native.close(); h.cleanup()
  }
})

test('opmlImport：导入时写入来源；池子清空后重复导入不抹掉已记录的字段（upsert 白名单）', async () => {
  const instance = await rssServer({ '/baoyu/blog': '阮一峰' })
  const h = makeDispatch({}, [instance.origin])
  try {
    const url = instance.origin + '/baoyu/blog'
    const opml = '<opml version="2.0"><body><outline text="博客">'
      + '<outline text="阮一峰" type="rss" xmlUrl="' + url + '"/></outline></body></opml>'
    let result = await h.dispatch('opmlImport', { opml })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(h.store.feed(url).rsshub,
      { namespace: 'baoyu', path: '/baoyu/blog', instance: instance.origin }, 'OPML 新源同样算 RSSHub 源')

    // 池子被清空（用户关掉 RSSHub）后再导入同一份 OPML：重复导入不是新的识别，来源不许消失。
    h.control.save({ instances: [] })
    result = await h.dispatch('opmlImport', { opml })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(h.store.feed(url).rsshub,
      { namespace: 'baoyu', path: '/baoyu/blog', instance: instance.origin },
      '已记录的来源是历史事实：池子空了也不许被 upsert 抹掉')
  } finally {
    await instance.close(); h.cleanup()
  }
})

// ── 刷新补写：老记录经首次成功（200 / 304）后补上来源（A7）──────────────────

const REFRESH_OPTIONS = {
  limits: { timeoutMs: 2000, maxBytes: 1_000_000, trustedTarget: true },
  maxItemsPerFeed: 100, maxSeenPerFeed: 1000, maxContentChars: 100000,
  maxArticleCacheChars: 1000000, refreshConcurrency: 2,
}

test('refreshFeeds：无字段的老记录 origin 命中实例池，首次 200 成功后补写来源（A7）', async () => {
  const instance = await rssServer({ '/baoyu/blog': '博客' })
  const native = await rssServer({ '/feed.xml': '原生源' })
  try {
    const store = strictMemoryStore()
    const rsshubUrl = instance.origin + '/baoyu/blog'
    const nativeUrl = native.origin + '/feed.xml'
    await store.saveFeed(rsshubUrl, { url: rsshubUrl, title: '博客' })
    await store.saveFeed(nativeUrl, { url: nativeUrl, title: '原生源' })

    const outcomes = await refreshFeeds([rsshubUrl, nativeUrl], store, { ...REFRESH_OPTIONS, instances: [instance.origin] })
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ['added', 'added'])
    assert.deepEqual(store.feed(rsshubUrl).rsshub,
      { namespace: 'baoyu', path: '/baoyu/blog', instance: instance.origin },
      '刷新成功是补写来源的写入点：不迁移 URL、不丢已读，只补字段')
    assert.equal(store.feed(nativeUrl).rsshub, undefined, '非 RSSHub 源零变化：不许被标来源')
  } finally {
    await instance.close(); await native.close()
  }
})

test('refreshFeeds：304 也是成功，同样补写/保留来源；池子为空时已有字段不许丢', async () => {
  const instance = await rssServer({ '/baoyu/blog': '博客' })
  try {
    const url = instance.origin + '/baoyu/blog'
    const store = strictMemoryStore()
    await store.saveFeed(url, { url, title: '博客', etag: 'W/"v1"' })

    const outcomes = await refreshFeeds([url], store, { ...REFRESH_OPTIONS, instances: [instance.origin] })
    assert.equal(outcomes[0].status, 'added')

    // 第二轮：源回 304（服务端忽略条件请求也返回 200？这里用桩 fetch 精确表达 304 分支）
    const store304 = strictMemoryStore()
    await store304.saveFeed(url, { url, title: '博客', etag: 'W/"v1"' })
    const notModified = await refreshFeeds([url], store304, {
      ...REFRESH_OPTIONS,
      instances: [instance.origin],
      fetchFeedImpl: async () => ({ kind: 'not-modified', etag: 'W/"v1"', lastModified: undefined }),
    })
    assert.equal(notModified[0].status, 'not-modified')
    assert.deepEqual(store304.feed(url).rsshub,
      { namespace: 'baoyu', path: '/baoyu/blog', instance: instance.origin },
      '304 逐字段重建同样要带上来源，否则第二轮就消失')

    // 池子清空后再刷新成功：已有字段优先（历史事实），不许被「池里没有」抹掉。
    const storeKept = strictMemoryStore()
    const rec = { namespace: 'baoyu', path: '/baoyu/blog', instance: 'https://old.example' }
    await storeKept.saveFeed(url, { url, title: '博客', rsshub: rec })
    await refreshFeeds([url], storeKept, { ...REFRESH_OPTIONS, instances: [] })
    assert.deepEqual(storeKept.feed(url).rsshub, rec, '池子为空时沿用 previous.rsshub')
  } finally {
    await instance.close()
  }
})

test('overview wire：来源由宿主下发（老记录按 origin 识别）；非 RSSHub 源没有这个字段', async () => {
  const instance = 'https://hub.example'
  const rsshubUrl = instance + '/baoyu/blog'
  const nativeUrl = 'https://site.example/feed.xml'
  const h = makeDispatch({
    [rsshubUrl]: { url: rsshubUrl, title: '博客' },
    [nativeUrl]: { url: nativeUrl, title: '原生源' },
  }, [instance])
  try {
    const result = await h.dispatch('overview', {})
    assert.equal(result.ok, true, JSON.stringify(result))
    const byId = new Map(result.value.feeds.map((feed) => [feed.id, feed]))
    assert.deepEqual(byId.get(rsshubUrl).rsshub,
      { namespace: 'baoyu', path: '/baoyu/blog', instance },
      '老记录不改库、不改 URL，也能在界面上被识别为 RSSHub 源')
    assert.equal(Object.hasOwn(byId.get(nativeUrl), 'rsshub'), false, 'wire 上非 RSSHub 源保持键缺席')
  } finally { h.cleanup() }
})
