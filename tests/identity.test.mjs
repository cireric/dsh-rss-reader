/**
 * 身份分叉的回归测试（2026-10-09）。
 *
 * 病象：列表里同一篇文章上下两条。实测本机库里 162 条里 40 组（爱范儿 20、云风 15、土木坛子 5），
 * 每组两条**同一 feedId、同一 link**、只是 id 不同；老的那条带已读态、新的那条未读。
 *
 * 根因：条目身份按「源 id → 链接 → 标题签名」派生，而**依据本身会变**——
 * 爱范儿把 guid 从 `https://www.ifanr.com/?p=1682933&utm_...`（WordPress 短链形态）改成了永久链接
 * `https://www.ifanr.com/1682933&utm_...`，同一引擎的 tumutanzi 是 `?p=17644` → `/archives/17644`，
 * 云风 (Atom) 是 entry id 换了写法。依据一变，同一篇文章就派生出第二个身份，带着「没见过」进库。
 *
 * 这些断言全部走**真实产物**（lib/refresh.js + lib/identity-repair.js），喂桩 HTTP 源，
 * 与用户实际跑的路径一致。修复前它们必须见红——「分叉」这条断言就是量尺。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { refreshFeeds } from '../lib/refresh.js'
import { repairIdentities, duplicateGroups, mergeItemRecords } from '../lib/identity-repair.js'

function memoryStore() {
  const feeds = new Map()
  const cursors = new Map()
  const items = new Map()
  return {
    feeds, cursors, items,
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
    listFeeds: () => [...feeds.entries()],
  }
}

const LIMITS = { timeoutMs: 2000, maxBytes: 1_000_000, trustedTarget: true }
const OPTIONS = { limits: LIMITS, maxItemsPerFeed: 100, maxSeenPerFeed: 1000, maxContentChars: 100000, maxArticleCacheChars: 1000000, refreshConcurrency: 2 }

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

/** 与真实源同形的 RSS：guid 与 link 是同一篇文章的两种写法（爱范儿 / 土木坛子就是这么变的）。 */
function rssWithGuid(guid, link, title) {
  return '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>源</title>'
    + '<item><title>' + title + '</title><link>' + link + '</link>'
    + '<guid isPermaLink="false">' + guid + '</guid>'
    + '<pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item></channel></rss>'
}

test('分叉回归：源把 guid 换成同一篇文章的另一种写法 ⇒ 不得变成两条（用户实测的病象）', async () => {
  const store = memoryStore()
  let payload = rssWithGuid('https://ex.test/?p=1682933&utm_source=rss', 'https://ex.test/1682933?utm_source=rss', '一篇文章')
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(payload)
  }, async (base) => {
    const feedUrl = base + '/feed.xml'
    const first = await refreshFeeds([feedUrl], store, OPTIONS)
    assert.equal(first[0].added, 1, '前置条件：先存下一条')
    const originalId = [...store.items.keys()][0]
    // 用户读了它
    await store.saveItem(originalId, { ...store.items.get(originalId), readAt: '2024-06-01T00:00:00.000Z' })

    // 源改了 guid 写法（链接不变）——这正是爱范儿/土木坛子做过的事
    payload = rssWithGuid('https://ex.test/1682933', 'https://ex.test/1682933?utm_source=rss', '一篇文章')
    const second = await refreshFeeds([feedUrl], store, OPTIONS)

    assert.equal(second[0].added, 0, '同一篇文章换了个身份写法，绝不是「新增一条」')
    assert.equal(store.items.size, 1, '列表里出现第二条就是用户看到的重复（实测 40 组）')
    assert.equal(store.items.get(originalId).readAt, '2024-06-01T00:00:00.000Z', '认回老身份时已读态必须还在')
    assert.equal(second[0].reclaimed, 1, '「认回老身份」要如实报出来：它是源改过身份依据的唯一信号')
  })
})

test('分叉回归：链接换了但 guid 没变（utm 增删）⇒ 同样不得新增一条', async () => {
  const store = memoryStore()
  let payload = rssWithGuid('tag:ex.test,2024:post-1', 'https://ex.test/1?utm_source=rss', '同一篇')
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(payload)
  }, async (base) => {
    const feedUrl = base + '/feed.xml'
    await refreshFeeds([feedUrl], store, OPTIONS)
    const itemId = [...store.items.keys()][0]

    payload = rssWithGuid('tag:ex.test,2024:post-1', 'https://ex.test/1', '同一篇')
    const second = await refreshFeeds([feedUrl], store, OPTIONS)

    assert.equal(second[0].added, 0)
    assert.equal(store.items.size, 1)
    assert.equal(store.items.get(itemId).link, 'https://ex.test/1?utm_source=rss', '已存条目不被改写（链接是历史事实）')
  })
})

test('分叉回归：guid 整条消失（退到链接派生）也不得变成两条', async () => {
  const store = memoryStore()
  let payload = rssWithGuid('g-1', 'https://ex.test/a', '一篇')
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(payload)
  }, async (base) => {
    const feedUrl = base + '/feed.xml'
    await refreshFeeds([feedUrl], store, OPTIONS)
    const itemId = [...store.items.keys()][0]

    payload = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>源</title>'
      + '<item><title>一篇</title><link>https://ex.test/a</link>'
      + '<pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item></channel></rss>'
    const second = await refreshFeeds([feedUrl], store, OPTIONS)

    assert.equal(second[0].added, 0, 'guid 没了但链接还在 ⇒ 还是同一条')
    assert.equal(store.items.size, 1)
    assert.ok(store.items.has(itemId))
  })
})

test('撞车兜底仍生效，且被认回的那条不被同响应里的另一条挤掉（不变量 2 与认回身份的交互）', async () => {
  const store = memoryStore()
  const dupGuid = 'https://ex.test/?p=1'
  let payload = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>源</title>'
    + '<item><title>A</title><link>https://ex.test/a</link><guid>' + dupGuid + '</guid>'
    + '<pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item></channel></rss>'
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(payload)
  }, async (base) => {
    const feedUrl = base + '/feed.xml'
    await refreshFeeds([feedUrl], store, OPTIONS)
    const knownId = [...store.items.keys()][0]

    // 源开始撒谎：两条不同文章共用一个 guid（其中 A 是我们已见过的）
    payload = '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>源</title>'
      + '<item><title>A</title><link>https://ex.test/a</link><guid>' + dupGuid + '</guid>'
      + '<pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>'
      + '<item><title>B</title><link>https://ex.test/b</link><guid>' + dupGuid + '</guid>'
      + '<pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate></item></channel></rss>'
    const second = await refreshFeeds([feedUrl], store, OPTIONS)

    assert.equal(second[0].untrusted, 1, '只有真的新条目 B 该按链接重算；A 有据可查不该被一起挤掉')
    assert.ok(store.items.has(knownId), 'A 必须还在原来的身份上——被挤掉等于用户已读态又一次分叉')
    assert.equal(second[0].added, 1, 'B 是新条目')
    assert.equal(store.items.size, 2)
  })
})

test('身份不得被抢：源拿老文章的 guid 发新文章 ⇒ 新文章必须换身份，不许顶掉老条目', async () => {
  const store = memoryStore()
  let payload = rssWithGuid('g-post-1', 'https://ex.test/old', '老文章')
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(payload)
  }, async (base) => {
    const feedUrl = base + '/feed.xml'
    await refreshFeeds([feedUrl], store, OPTIONS)
    const oldId = [...store.items.keys()][0]
    await store.saveItem(oldId, { ...store.items.get(oldId), readAt: '2024-06-01T00:00:00.000Z' })

    // 源复用同一个 guid 发了一篇**不同的**文章（时间与标题都对不上）
    payload = rssWithGuid('g-post-1', 'https://ex.test/new', '全新文章')
      .replace('Mon, 01 Jan 2024 00:00:00 GMT', 'Fri, 01 Mar 2024 00:00:00 GMT')
    const second = await refreshFeeds([feedUrl], store, OPTIONS)

    assert.equal(second[0].added, 1, '新文章是新条目')
    assert.equal(store.items.size, 2, '两条都要在：老文章不许被新文章顶掉')
    assert.equal(store.items.get(oldId).title, '老文章', '老条目的内容不许被新文章覆盖')
    assert.equal(store.items.get(oldId).readAt, '2024-06-01T00:00:00.000Z', '老条目的已读态更不许丢')
    const fresh = [...store.items.entries()].find(([id]) => id !== oldId)[1]
    assert.equal(fresh.title, '全新文章')
    assert.equal(fresh.link, 'https://ex.test/new')
  })
})

test('旁证：guid 没变、只是链接变了 ⇒ 仍然认回，不新增（旁证不能把正常认回也挡掉）', async () => {
  const store = memoryStore()
  let payload = rssWithGuid('g-stable', 'https://ex.test/a?utm_source=rss', '同一篇')
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(payload)
  }, async (base) => {
    const feedUrl = base + '/feed.xml'
    await refreshFeeds([feedUrl], store, OPTIONS)
    const itemId = [...store.items.keys()][0]

    payload = rssWithGuid('g-stable', 'https://ex.test/a', '同一篇')
    const second = await refreshFeeds([feedUrl], store, OPTIONS)

    assert.equal(second[0].added, 0, '时间与标题都对得上 ⇒ 是同一条，必须认回')
    assert.equal(store.items.size, 1)
    assert.ok(store.items.has(itemId))
  })
})

test('身份修复：同源同链接的重复被合并，用户状态与正文一律保住', async () => {
  const store = memoryStore()
  const feedId = 'https://ex.test/feed'
  await store.saveFeed(feedId, { url: feedId })
  // 老条目（已读 + 有正文 + 有发布日），新条目（未读、摘要更长、无正文）
  await store.saveItem('old-id', {
    feedId, title: '一篇文章', link: 'https://ex.test/1', publishedAt: '2024-01-01T00:00:00.000Z',
    summary: '短', fetchedAt: '2024-01-01T00:00:00.000Z', readAt: '2024-06-01T00:00:00.000Z', starred: false,
    article: { fetchedAt: '2024-06-02T00:00:00.000Z', revision: 2, blocks: [{ kind: 'p', text: '正文' }] },
  })
  await store.saveItem('new-id', {
    feedId, title: '一篇文章', link: 'https://ex.test/1', publishedAt: '2024-01-01T00:00:00.000Z',
    summary: '更完整的一段摘要', fetchedAt: '2024-09-01T00:00:00.000Z', starred: true,
  })

  const result = await repairIdentities(store)

  assert.equal(result.merged, 1, '两条重复要合并成一条')
  assert.equal(result.groups, 1)
  assert.equal(store.items.size, 1, '幸存者只剩一条')
  const survivor = store.items.get('old-id')
  assert.ok(survivor, '幸存者是最早的那条（用户状态的原始承载者）')
  assert.equal(survivor.readAt, '2024-06-01T00:00:00.000Z', '已读态不能丢')
  assert.equal(survivor.starred, true, '星标取或：两条里任意一条星标过就得留住')
  assert.deepEqual(survivor.article, { fetchedAt: '2024-06-02T00:00:00.000Z', revision: 2, blocks: [{ kind: 'p', text: '正文' }] }, '正文缓存不能丢')
  assert.equal(survivor.summary, '更完整的一段摘要', '摘要取更完整的一份')
})

test('身份修复：幂等，再跑一次无事可做（每次打开域都会跑）', async () => {
  const store = memoryStore()
  const feedId = 'https://ex.test/feed'
  await store.saveFeed(feedId, { url: feedId })
  for (const [id, fetchedAt] of [['a', '2024-01-01T00:00:00.000Z'], ['b', '2024-02-01T00:00:00.000Z']]) {
    await store.saveItem(id, { feedId, title: 't', link: 'https://ex.test/same', fetchedAt, starred: false })
  }
  const first = await repairIdentities(store)
  const second = await repairIdentities(store)
  assert.equal(first.merged, 1)
  assert.equal(second.merged, 0, '第二次必须无事可做——否则每次打开域都在改用户数据')
  assert.equal(second.groups, 0)
})

test('身份修复：跨源同链接不算重复（同一文章订阅了两个源，各有独立已读态）', async () => {
  const store = memoryStore()
  await store.saveFeed('https://a.test/feed', { url: 'https://a.test/feed' })
  await store.saveFeed('https://b.test/feed', { url: 'https://b.test/feed' })
  await store.saveItem('a1', { feedId: 'https://a.test/feed', title: 't', link: 'https://post.test/1', fetchedAt: '2024-01-01T00:00:00.000Z', starred: false })
  await store.saveItem('b1', { feedId: 'https://b.test/feed', title: 't', link: 'https://post.test/1', fetchedAt: '2024-01-01T00:00:00.000Z', starred: false })

  const result = await repairIdentities(store)

  assert.equal(result.merged, 0, '跨源同链接是两个订阅各自的条目，不是重复')
  assert.equal(store.items.size, 2)
})

test('身份修复：链接为空的条目不参与合并（否则一堆空链接会被揉成一条）', async () => {
  const rows = [
    { id: 'a', link: '', fetchedAt: '2024-01-01T00:00:00.000Z' },
    { id: 'b', link: '   ', fetchedAt: '2024-01-02T00:00:00.000Z' },
    { id: 'c', link: 'https://ex.test/1', fetchedAt: '2024-01-03T00:00:00.000Z' },
    { id: 'd', link: 'https://ex.test/1', fetchedAt: '2024-01-04T00:00:00.000Z' },
  ]
  const groups = duplicateGroups(rows)
  assert.equal(groups.length, 1, '只有真实链接那一组算重复')
  assert.deepEqual(groups[0], ['c', 'd'], '组内最早的在前（幸存者判据），与输入顺序无关')
})

test('身份修复：幸存者判据与遍历顺序无关（同刻按 id 定序）', async () => {
  const rows = [
    { id: 'zzz', link: 'https://ex.test/1', fetchedAt: '2024-01-01T00:00:00.000Z' },
    { id: 'aaa', link: 'https://ex.test/1', fetchedAt: '2024-01-01T00:00:00.000Z' },
  ]
  assert.deepEqual(duplicateGroups(rows)[0], ['aaa', 'zzz'], '同一时刻的并列必须有个确定的裁决')
  assert.deepEqual(duplicateGroups([...rows].reverse())[0], ['aaa', 'zzz'], '换一种遍历顺序，结果必须一样')
})

test('身份修复：保持未读按「或」合并，并在没有任何一条保持时不留 false 键', async () => {
  const base = { feedId: 'f', title: 't', link: 'l', fetchedAt: '2024-01-01T00:00:00.000Z', starred: false }
  const kept = mergeItemRecords({ ...base }, { ...base, keptUnread: true })
  assert.equal(kept.keptUnread, true, '任意一条保持未读，合并后就要保持')

  const plain = mergeItemRecords({ ...base }, { ...base })
  assert.ok(!('keptUnread' in plain), '谁都没保持时不该落下 false 键（缺省即「未保持」）')
})

test('身份修复：拿到正文后旧的失败原因要清掉（两者互斥）', () => {
  const base = { feedId: 'f', title: 't', link: 'l', fetchedAt: '2024-01-01T00:00:00.000Z', starred: false }
  const ok = mergeItemRecords(
    { ...base, article: { fetchedAt: '2024-02-01T00:00:00.000Z', revision: 2, blocks: [{ kind: 'p', text: 'x' }] } },
    { ...base, articleFailure: '抓取失败' },
  )
  assert.equal(ok.articleFailure, undefined, '已有正文时不该还挂着失败原因')
  assert.ok(ok.article !== undefined)
})
