/**
 * M2 05：标签持久化与 v1→v2 迁移的磁盘判据。
 *
 * 为什么单独一个文件：这里同时钉两件容易互相掩盖的事 ——
 *  ① **迁移**只允许加表，旧 items/texts/cursors 一行都不能变，失败必须连版本号一起回滚；
 *  ② **标签生命周期**用稳定 id 绑定，改名保关联、删标签不碰文章、删文章/清理级联清关联。
 *
 * 迁移夹具是真实 v1 表形状（tests/fixtures/rss-storage-v1.sql），不是当前 DDL 的复制品。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, migrateSchema, SCHEMA_VERSION } from '../lib/storage/db.js'
import { writeConfigFile } from '../lib/storage/config-file.js'
import { createSqliteStore } from '../lib/store-sqlite.js'
import { TagError } from '../lib/tags.js'
import { repairIdentities } from '../lib/identity-repair.js'

const V1_SQL = readFileSync(new URL('./fixtures/rss-storage-v1.sql', import.meta.url), 'utf8')
const FEED = 'https://tag.example/feed.xml'
const TIME = '2026-10-20T12:00:00.000Z'

function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), 'rss-tag-' + tag + '-'))
}

/** 造一个真实 v1 库：fixture 建表 + 一条已读星标条目/正文/游标。 */
function makeV1(tag, extra) {
  const dir = tempDir(tag)
  const path = join(dir, 'rss.db')
  const db = new DatabaseSync(path)
  try {
    db.exec(V1_SQL)
    db.prepare('INSERT INTO items (id, feed_id, title, link, fetched_at, read_at, starred, kept_unread) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('item-1', FEED, '旧文章', 'https://tag.example/1', TIME, TIME, 1, 1)
    db.prepare('INSERT INTO texts (item_id, body, revision, frameable, title, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('item-1', JSON.stringify([{ kind: 'p', text: '旧正文' }]), 2, 0, '旧标题', TIME)
    db.prepare('INSERT INTO cursors (feed_id, seen, cursor_at) VALUES (?, ?, ?)')
      .run(FEED, JSON.stringify(['item-1']), TIME)
    if (extra !== undefined) db.exec(extra)
  } finally {
    db.close()
  }
  return { dir, path }
}

function snapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return {
      version: db.prepare('PRAGMA user_version').get().user_version,
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name),
      items: db.prepare('SELECT * FROM items ORDER BY id').all(),
      texts: db.prepare('SELECT * FROM texts ORDER BY item_id').all(),
      cursors: db.prepare('SELECT * FROM cursors ORDER BY feed_id').all(),
    }
  } finally { db.close() }
}

function freshStore(tag) {
  const dir = tempDir(tag)
  const configPath = join(dir, 'config.json')
  writeConfigFile(configPath, { version: 1, feeds: { [FEED]: { url: FEED, title: 'T' } } })
  const db = openDatabase(join(dir, 'rss.db'))
  migrateSchema(db)
  const store = createSqliteStore(db, configPath)
  // cleanup 绑定返回对象上的 db：重启用例会换掉 db，闭包捕获旧句柄会二次 close。
  const ctx = { dir, configPath, db, store, cleanup: () => { ctx.db.close(); rmSync(dir, { recursive: true, force: true }) } }
  return ctx
}

const tagNames = (tags) => tags.map((tag) => tag.name).sort()
const tagIds = (tags) => tags.reduce((acc, tag) => ({ ...acc, [tag.name]: tag.id }), {})

test('v1→v2 升级：只加标签表，条目/正文/游标/阅读状态原样保留，重启幂等', () => {
  const { dir, path } = makeV1('upgrade')
  try {
    const before = snapshot(path)
    const db = openDatabase(path)
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1, '打开 v1 允许，但尚未升级')
      migrateSchema(db)
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
      const after = snapshot(path)
      assert.deepEqual(after.items, before.items, '升级不得改任何条目（含已读/星标/保持未读）')
      assert.deepEqual(after.texts, before.texts, '升级不得改正文缓存')
      assert.deepEqual(after.cursors, before.cursors, '升级不得改去重窗口')
      assert.ok(after.tables.includes('tags') && after.tables.includes('item_tags'), '两张标签表必须建出来')
      migrateSchema(db)
      assert.equal(snapshot(path).version, SCHEMA_VERSION, '已升级库上 migrateSchema 是空操作')
    } finally { db.close() }

    const reopened = openDatabase(path)
    try {
      migrateSchema(reopened)
      assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION, '重启后仍能打开 v2')
    } finally { reopened.close() }

    const db2 = openDatabase(path)
    try {
      const store = createSqliteStore(db2, join(dir, 'config.json'))
      assert.deepEqual(store.listTags(), [], '升级后的库可以正常写/读标签接口')
      const item = store.item('item-1')
      assert.equal(item.readAt, TIME, '已读状态在升级后仍可读')
      assert.equal(item.starred, true, '星标在升级后仍可读')
    } finally { db2.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('升级失败回滚：版本与新建 DDL 一起回滚，旧表数据不动，修复冲突后可重试', () => {
  const { dir, path } = makeV1('rollback', 'CREATE TABLE tags (legacy TEXT);')
  try {
    const before = snapshot(path)
    const db = openDatabase(path)
    try {
      assert.throws(() => migrateSchema(db), /升级失败|v1→v2/)
      const afterFail = snapshot(path)
      assert.equal(afterFail.version, 1, '失败必须把版本留在 v1')
      assert.deepEqual(afterFail.items, before.items, '失败不得动旧条目')
      assert.equal(afterFail.tables.includes('item_tags'), false, '失败的迁移不得留下半张 item_tags')
    } finally { db.close() }

    // 模拟运维修掉冲突表后重启重试。
    const repair = new DatabaseSync(path)
    try { repair.exec('DROP TABLE tags') } finally { repair.close() }
    const retry = openDatabase(path)
    try {
      migrateSchema(retry)
      assert.equal(retry.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION, '可安全重试')
      assert.deepEqual(snapshot(path).items, before.items, '重试成功后旧条目仍原样')
    } finally { retry.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('标签 CRUD：空标签可见、改名保 id 与关联、删标签不影响文章与阅读状态', async () => {
  const h = freshStore('crud')
  try {
    const { store, db } = h
    await store.saveItem('item-1', {
      feedId: FEED, title: '文章', link: 'https://tag.example/1', fetchedAt: TIME,
      readAt: TIME, starred: true, keptUnread: true,
    })
    const a = await store.createTag('  甲  ')
    const b = await store.createTag('乙')
    assert.equal(a.name, '甲', '新名称去首尾空白')
    await assert.rejects(() => store.createTag('甲'), (error) => error instanceof TagError && error.code === 'conflict')
    await assert.rejects(() => store.createTag('   '), (error) => error instanceof TagError && error.code === 'bad-request')

    const renamed = await store.renameTag(a.id, '甲改')
    assert.equal(renamed.id, a.id, '改名保留稳定 id')
    const duplicate = await store.createTag('重复名')
    await assert.rejects(
      () => store.renameTag(a.id, '重复名'),
      (error) => error instanceof TagError && error.code === 'conflict',
      '改名撞已有名称同样必须 conflict',
    )
    assert.equal(store.listTags().find((tag) => tag.id === a.id).name, '甲改', '失败改名不改原名称')
    await store.deleteTag(duplicate.id)
    await store.setItemTags('item-1', [a.id, b.id, a.id])
    let itemTags = await store.itemTags('item-1')
    assert.deepEqual(tagNames(itemTags), ['乙', '甲改'], '重复关联去重，改名后关联仍指向原 id')

    const empty = await store.createTag('空标签')
    const tagsBeforeDelete = store.listTags()
    assert.deepEqual(tagNames(tagsBeforeDelete), ['乙', '空标签', '甲改'].sort())
    assert.equal(tagsBeforeDelete.find((tag) => tag.id === empty.id).itemCount, 0, '空标签仍然可见')

    await store.deleteTag(b.id)
    itemTags = await store.itemTags('item-1')
    assert.deepEqual(tagNames(itemTags), ['甲改'], '删标签只清关联')
    const item = store.item('item-1')
    assert.equal(item.readAt, TIME, '删标签不改阅读状态')
    assert.equal(item.starred, true)
    assert.equal(item.keptUnread, true)
    await assert.rejects(() => store.deleteTag(b.id), (error) => error instanceof TagError && error.code === 'not-found')

    // 删文章时 item_tags 级联清掉；标签本身保留（空标签可继续用）。
    await store.deleteItem('item-1')
    assert.equal(store.listTags().find((tag) => tag.id === a.id).itemCount, 0, '删文章后标签仍在且计数归零')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM item_tags WHERE item_id = ?').get('item-1').n, 0, '关联级联清除')
  } finally { h.cleanup() }
})

test('setItemTags 幂等且混合无效请求不留下部分关联', async () => {
  const h = freshStore('set')
  try {
    const { store } = h
    await store.saveItem('item-1', { feedId: FEED, title: '文章', link: 'https://tag.example/1', fetchedAt: TIME, starred: false })
    const a = await store.createTag('A')
    const b = await store.createTag('B')
    await store.setItemTags('item-1', [a.id])
    assert.deepEqual(tagNames(await store.itemTags('item-1')), ['A'])

    await assert.rejects(
      () => store.setItemTags('item-1', [b.id, 'missing-tag']),
      (error) => error instanceof TagError && error.code === 'not-found',
    )
    assert.deepEqual(tagNames(await store.itemTags('item-1')), ['A'], '混合无效请求不得改掉已有 A')

    await assert.rejects(
      () => store.setItemTags('missing-item', [a.id]),
      (error) => error instanceof TagError && error.code === 'not-found',
    )
    await store.setItemTags('item-1', [b.id, b.id])
    assert.deepEqual(tagNames(await store.itemTags('item-1')), ['B'], '覆盖写入 + 重复 id 去重')
    await store.setItemTags('item-1', [])
    assert.deepEqual(await store.itemTags('item-1'), [], '空数组表示清空')
  } finally { h.cleanup() }
})

test('改名与关联重启后仍按稳定 id 恢复', async () => {
  const h = freshStore('reopen')
  try {
    await h.store.saveItem('item-1', {
      feedId: FEED, title: '文章', link: 'https://tag.example/1', fetchedAt: TIME, starred: false,
    })
    const tag = await h.store.createTag('旧名')
    await h.store.renameTag(tag.id, '新名')
    await h.store.setItemTags('item-1', [tag.id])

    h.db.close()
    h.db = openDatabase(join(h.dir, 'rss.db'))
    h.store = createSqliteStore(h.db, h.configPath)
    const tags = await h.store.itemTags('item-1')
    assert.deepEqual(tags.map((entry) => [entry.id, entry.name]), [[tag.id, '新名']], '重启后 id 与关联都保持')
    assert.equal(h.store.listTags().find((entry) => entry.id === tag.id).name, '新名')
  } finally { h.cleanup() }
})

test('身份修复合并：幸存条目保留两侧标签并去重，loser 的关联不丢', async () => {
  const h = freshStore('identity')
  try {
    const { store } = h
    await store.saveItem('a', {
      feedId: FEED, title: '同一篇', link: 'https://tag.example/same', fetchedAt: TIME,
      readAt: TIME, starred: true,
    })
    await store.saveItem('b', {
      feedId: FEED, title: '同一篇', link: 'https://tag.example/same', fetchedAt: TIME, starred: false,
    })
    const x = await store.createTag('X')
    const y = await store.createTag('Y')
    const z = await store.createTag('Z')
    await store.setItemTags('a', [x.id, y.id])
    await store.setItemTags('b', [y.id, z.id])

    const result = await repairIdentities(store)
    assert.deepEqual(result, { merged: 1, groups: 1 })
    assert.equal(store.item('b'), undefined, 'loser 已删除')
    assert.deepEqual(tagNames(await store.itemTags('a')), ['X', 'Y', 'Z'], '并集去重，两侧标签都保留')
    assert.deepEqual(store.listTags().map((tag) => [tag.name, tag.itemCount]).sort(), [['X', 1], ['Y', 1], ['Z', 1]])
    assert.equal(store.item('a').readAt, TIME, '合并保留阅读状态')
    assert.equal(store.item('a').starred, true, '合并保留星标')
  } finally { h.cleanup() }
})
