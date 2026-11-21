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
