import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Config } from '../lib/config.js'
import { createDispatch } from '../lib/endpoints.js'
import { createSearch } from '../lib/search.js'
import { writeConfigFile } from '../lib/storage/config-file.js'
import { openDatabase, migrateSchema } from '../lib/storage/db.js'
import { createSqliteStore } from '../lib/store-sqlite.js'

test('本地搜索跨页稳定，按源、日期、星标和已读筛选，并只查当前缓存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-search-test-'))
  const path = join(dir, 'rss.db')
  const configFile = join(dir, 'config.json')
  const db = openDatabase(path)
  const search = createSearch(path)
  try {
    migrateSchema(db)
    const feed = 'https://example.test/feed'
    const other = 'https://example.test/other'
    writeConfigFile(configFile, { version: 1, feeds: {
      [feed]: { url: feed, title: '甲' }, [other]: { url: other, title: '乙' },
    } })
    const store = createSqliteStore(db, configFile)
    const dispatch = createDispatch({
      config: Config({ maxItemsShown: 1 }), log: assert.fail, ready: () => store,
      refreshNow: () => assert.fail('搜索不能触发刷新'), lastRefreshCompletedAt: () => undefined,
      articleAttempts: new Map(), searchItems: search.run,
    })
    const insert = db.prepare('INSERT INTO items (id, feed_id, title, link, fetched_at, summary, read_at, starred) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    const time = '2026-10-20T12:00:00.000Z'
    for (let index = 0; index < 32; index++) {
      insert.run('item-' + String(index).padStart(2, '0'), feed, '支付 Alpha', 'https://example.test/article', time, null, null, 0)
    }
    insert.run('body', other, 'Alpha', 'https://example.test/body', time, null, time, 1)
    insert.run('miss', feed, 'Alpha', 'https://example.test/miss', time, null, null, 0)
    insert.run('orphan', 'removed', '支付 Alpha', 'https://example.test/orphan', time, null, null, 0)
    db.prepare('INSERT INTO texts (item_id, body, fetched_at) VALUES (?, ?, ?)').run(
      'body', JSON.stringify([{ kind: 'p', text: '支付 100%' }, { kind: 'img', src: 'https://example.test/image-only' }]), time,
    )
    const request = async (payload) => {
      const result = await dispatch('searchItems', payload)
      assert.equal(result.ok, true, JSON.stringify(result))
      return result.value
    }
    const first = await request({ text: '支付 ALPHA' })
    const next = await request({ text: '支付 ALPHA', cursor: first.nextCursor })
    assert.equal(first.items.length, 30)
    assert.deepEqual([...first.items, ...next.items].map(({ id }) => id), [
      'body', ...Array.from({ length: 32 }, (_, i) => 'item-' + String(i).padStart(2, '0')),
    ])
    assert.equal(next.nextCursor, undefined)
    const filtered = { text: '支付 100%', feedIds: [other], read: 'read', starred: true, from: '2026-10-20', to: '2026-10-20' }
    assert.deepEqual((await request(filtered)).items.map(({ id }) => id), ['body'])
    db.prepare('UPDATE items SET published_at = ? WHERE id = ?').run('2026-10-19T12:00:00.000Z', 'body')
    assert.deepEqual((await request(filtered)).items, [])
    assert.deepEqual((await request({ ...filtered, from: '2026-10-19', to: '2026-10-19' })).items.map(({ id }) => id), ['body'])
    db.prepare('UPDATE items SET published_at = NULL WHERE id = ?').run('body')
    for (const patch of [{ feedIds: [feed] }, { read: 'unread' }, { to: '2026-10-19', from: undefined }, { text: 'image-only' }]) {
      assert.deepEqual((await request({ ...filtered, ...patch })).items, [])
    }
    assert.equal((await dispatch('searchItems', { text: '其他', cursor: first.nextCursor })).error.code, 'bad-request')
    const manyTerms = Array.from({ length: 60 }, (_, index) => String.fromCodePoint(0x4e00 + index)).join(' ')
    assert.deepEqual((await request({ text: manyTerms })).items, [])
    for (const text of ['', '字'.repeat(121)]) {
      assert.equal((await dispatch('searchItems', { text })).error.code, 'bad-request')
    }
    assert.equal(db.prepare('SELECT read_at FROM items WHERE id = ?').get('item-00').read_at, null)
    db.prepare('DELETE FROM texts WHERE item_id = ?').run('body')
    assert.deepEqual((await request(filtered)).items, [])
    db.prepare('DELETE FROM items WHERE id IN (?, ?)').run('item-28', 'item-29')
    const afterDeletion = await request({ text: '支付 ALPHA', cursor: first.nextCursor })
    assert.deepEqual(afterDeletion.items.map(({ id }) => id), ['item-30', 'item-31'])
    assert.equal(afterDeletion.nextCursor, undefined)
  } finally {
    await search.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * —— 表格里的词能被搜索命中（R5 04）——
 *
 * 搜索投影跑在 **worker 线程**里，独立解析 `texts.body` 的 JSON（故意不 import articleCharsOf：
 * 那条路径会把整份 article 解出来，与「按需读行」冲突）。所以它必须自己认 `table` 块 ——
 * 否则新块类型一进来，表里的词就搜不到了，而这件事没有任何界面信号。
 */
test('搜索：表格里的词能命中（投影不再只看 text / items）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-search-table-'))
  const path = join(dir, 'rss.db')
  const configFile = join(dir, 'config.json')
  const db = openDatabase(path)
  const search = createSearch(path)
  try {
    migrateSchema(db)
    const feed = 'https://example.test/feed'
    writeConfigFile(configFile, { version: 1, feeds: { [feed]: { url: feed, title: '甲' } } })
    const store = createSqliteStore(db, configFile)
    const dispatch = createDispatch({
      config: Config({ maxItemsShown: 10 }), log: assert.fail, ready: () => store,
      refreshNow: () => assert.fail('搜索不能触发刷新'), lastRefreshCompletedAt: () => undefined,
      articleAttempts: new Map(), searchItems: search.run,
    })
    const time = '2026-10-20T12:00:00.000Z'
    db.prepare('INSERT INTO items (id, feed_id, title, link, fetched_at) VALUES (?, ?, ?, ?, ?)')
      .run('t1', feed, '参数对照', 'https://example.test/t1', time)
    db.prepare('INSERT INTO texts (item_id, body, fetched_at) VALUES (?, ?, ?)').run('t1', JSON.stringify([
      { kind: 'p', text: '正文里没有那个词。' },
      { kind: 'table', header: ['参数', '标称值'], rows: [['额定功率', '5W']] },
    ]), time)

    const request = async (payload) => {
      const result = await dispatch('searchItems', payload)
      assert.equal(result.ok, true, JSON.stringify(result))
      return result.value
    }
    // 表头里的词、单元格里的词都要能命中（只读 text / items 的实现两处都搜不到）
    const headerHit = await request({ text: '标称值' })
    assert.deepEqual(headerHit.items.map((entry) => entry.id), ['t1'], '表头里的词必须能命中')
    const cellHit = await request({ text: '额定功率' })
    assert.deepEqual(cellHit.items.map((entry) => entry.id), ['t1'], '单元格里的词必须能命中')
  } finally {
    // 必须 close 掉 worker，否则 node:test 的进程不会退出（实测：漏了这句会把整套挂住 60s+）
    await search.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * —— 按作者搜索（R12 05）——
 *
 * 作者是第四路谓词，与标题 / 摘要 / 正文并列；它与既有三路共用同一个「按词选择 lower」的决定
 * （非 ASCII 词走 JS 小写、其余走 SQLite lower），并且仍然只做字面子串命中。分页语义不变：
 * 作者不是筛选条件、不进游标围栏，命中原因不同的条目混在一页时也不重不漏。
 */
test('搜索：作者名命中，与标题 / 摘要 / 正文混合时分页稳定（非 ASCII 大写作者）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-search-author-'))
  const path = join(dir, 'rss.db')
  const configFile = join(dir, 'config.json')
  const db = openDatabase(path)
  const search = createSearch(path)
  try {
    migrateSchema(db)
    const feed = 'https://example.test/feed'
    writeConfigFile(configFile, { version: 1, feeds: { [feed]: { url: feed, title: '甲' } } })
    const store = createSqliteStore(db, configFile)
    const dispatch = createDispatch({
      config: Config({ maxItemsShown: 10 }), log: assert.fail, ready: () => store,
      refreshNow: () => assert.fail('搜索不能触发刷新'), lastRefreshCompletedAt: () => undefined,
      articleAttempts: new Map(), searchItems: search.run,
    })
    const insert = db.prepare(`INSERT INTO items (id, feed_id, title, link, fetched_at, summary, author)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    const time = '2026-10-20T12:00:00.000Z'
    const expected = []
    // 三种既有命中原因 + 作者命中交错，共 36 条（超过一页 30 条）：任一命中原因掉队都会让分页并集缺行。
    for (let index = 0; index < 12; index++) {
      const suffix = String(index).padStart(2, '0')
      const authorHit = 'author-' + suffix
      insert.run(authorHit, feed, '无关标题', 'https://example.test/a' + suffix, time, '无关摘要', '张三')
      expected.push(authorHit)
      const titleHit = 'title-' + suffix
      insert.run(titleHit, feed, '张三 的手记', 'https://example.test/t' + suffix, time, '无关摘要', '作者乙')
      expected.push(titleHit)
      const summaryHit = 'summary-' + suffix
      insert.run(summaryHit, feed, '无关标题', 'https://example.test/s' + suffix, time, '张三 说过的话', null)
      expected.push(summaryHit)
    }
    // 无作者条目：搜索作者名不得报错，也不得被 NULL 误命中。
    insert.run('miss', feed, '无关标题', 'https://example.test/miss', time, '无关摘要', null)
    // 非 ASCII 大写作者：词里的 ä 走 rss_search_lower（JS Unicode 小写）；写死 SQLite lower 时这里搜不到。
    insert.run('umlaut', feed, 'Umlaut 手记', 'https://example.test/umlaut', time, '无关摘要', 'Änne')
    expected.sort()

    const request = async (payload) => {
      const result = await dispatch('searchItems', payload)
      assert.equal(result.ok, true, JSON.stringify(result))
      return result.value
    }
    const first = await request({ text: '张三' })
    const second = await request({ text: '张三', cursor: first.nextCursor })
    const ids = [...first.items, ...second.items].map(({ id }) => id)
    assert.equal(first.items.length, 30)
    assert.deepEqual(ids, expected, '作者命中与标题 / 摘要命中的并集必须不重不漏')
    assert.equal(new Set(ids).size, ids.length, '分页不得重复')
    assert.equal(second.nextCursor, undefined)
    assert.equal(first.items.find(({ id }) => id === 'author-00').author, '张三', '搜索结果要带作者原值')
    assert.equal(first.items.find(({ id }) => id === 'summary-00').author, undefined, '无作者条目不伪造作者')
    assert.equal(db.prepare('SELECT read_at FROM items WHERE id = ?').get('author-00').read_at, null, '搜索不改变读态')

    const umlaut = await request({ text: 'ä' })
    assert.deepEqual(umlaut.items.map(({ id }) => id), ['umlaut'])
    assert.equal(umlaut.items[0].author, 'Änne', '作者按原样返回（只归一化空白，不做大小写变换）')
    assert.deepEqual((await request({ text: '不存在的词' })).items, [], 'NULL 作者不得误命中')
  } finally {
    await search.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 搜索是第二条读路径：外部改库留下的 `''` / 纯空白必须在 worker 里也落成 undefined，
 * 否则搜索结果行会出现空段、工具输出会是 "" 而不是 null（R12 决策 20 / 验收 21）。
 */
test('搜索：外部改库留下的空串作者读成 undefined（与列表同一份归一化）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-search-author-empty-'))
  const path = join(dir, 'rss.db')
  const configFile = join(dir, 'config.json')
  const db = openDatabase(path)
  const search = createSearch(path)
  try {
    migrateSchema(db)
    const feed = 'https://example.test/feed'
    writeConfigFile(configFile, { version: 1, feeds: { [feed]: { url: feed, title: '甲' } } })
    const store = createSqliteStore(db, configFile)
    const dispatch = createDispatch({
      config: Config({ maxItemsShown: 10 }), log: assert.fail, ready: () => store,
      refreshNow: () => assert.fail('搜索不能触发刷新'), lastRefreshCompletedAt: () => undefined,
      articleAttempts: new Map(), searchItems: search.run,
    })
    const time = '2026-10-20T12:00:00.000Z'
    const insert = db.prepare(`INSERT INTO items (id, feed_id, title, link, fetched_at, author)
      VALUES (?, ?, ?, ?, ?, ?)`)
    // 绕过 store / schema 的直写（模拟外部工具改库）：空串与纯空白都不是「有作者」。
    insert.run('blank', feed, '正文命中 一', 'https://example.test/blank', time, '')
    insert.run('spaces', feed, '正文命中 二', 'https://example.test/spaces', time, '   ')
    insert.run('normal', feed, '正文命中 三', 'https://example.test/normal', time, '张三')
    const result = await dispatch('searchItems', { text: '正文命中' })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value.items.map(({ id, author }) => [id, author]), [
      ['blank', undefined], ['normal', '张三'], ['spaces', undefined],
    ])
  } finally {
    await search.close()
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
