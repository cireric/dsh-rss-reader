/**
 * R12 票据 01：v5 的 `items.author` 列 —— 新库与四条老库路径都必须有它。
 *
 * 这一组判据只关心「库结构 + 升级不发生损坏」，不关心谁写作者（那是刷新/存储票的事）。
 * 造库纪律按 spec 验收 4：v1 用静态 fixture；v2/v3/v4 先按当前 schema 建库，再把那一版
 * **还没有的东西**真的拆掉（含 `author` 列），迁移前断言列不存在 —— 只改 `user_version` 的
 * 「旧库」会让这条断言空转，而那正是初稿漏掉三条升级分支时测试仍然全绿的原因。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase, migrateSchema, SCHEMA_VERSION } from '../lib/storage/db.js'
import { createSqliteStore } from '../lib/store-sqlite.js'
import { writeConfigFile } from '../lib/storage/config-file.js'
import { linkKeyOf } from '../lib/duplicates.js'

const V1_SQL = readFileSync(new URL('./fixtures/rss-storage-v1.sql', import.meta.url), 'utf8')
const VERIFY_BACKUP = new URL('../scripts/verify-backup.mjs', import.meta.url).pathname
const FEED = 'https://migrate.example/feed.xml'
const LINK = 'https://migrate.example/old?utm_source=x#top'
const TIME = '2026-10-21T08:00:00.000Z'

/** 迁移对账用的业务列：刻意显式列，`*` 会把新列（author）算成「旧条目被改了」。 */
const ITEM_COLUMNS = [
  'id', 'feed_id', 'title', 'link', 'published_at', 'fetched_at',
  'summary', 'read_at', 'starred', 'kept_unread', 'article_failure', 'recency',
]

function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), 'rss-author-migrate-' + tag + '-'))
}

/** 表不存在时返回 undefined（v1 没有 tags / reading_progress，缺表是正常的）。 */
function tableRows(db, table, orderBy) {
  const present = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  if (present === undefined) return undefined
  return db.prepare('SELECT * FROM ' + table + ' ORDER BY ' + orderBy).all()
}

/** 只读对账快照：迁移前后逐项比较「旧数据有没有被动过」。 */
function snapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const itemColumns = db.prepare('PRAGMA table_info(items)').all().map((column) => column.name)
    return {
      version: db.prepare('PRAGMA user_version').get().user_version,
      itemColumns,
      authors: itemColumns.includes('author')
        ? db.prepare('SELECT id, author FROM items ORDER BY id').all()
        : undefined,
      items: db.prepare('SELECT ' + ITEM_COLUMNS.join(', ') + ' FROM items ORDER BY id').all(),
      linkKeys: itemColumns.includes('link_key')
        ? db.prepare('SELECT id, link_key FROM items ORDER BY id').all()
        : undefined,
      texts: db.prepare('SELECT * FROM texts ORDER BY item_id').all(),
      cursors: db.prepare('SELECT * FROM cursors ORDER BY feed_id').all(),
      tags: tableRows(db, 'tags', 'id'),
      itemTags: tableRows(db, 'item_tags', 'item_id, tag_id'),
      progress: tableRows(db, 'reading_progress', 'item_id'),
      indexes: db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' ORDER BY name").all(),
    }
  } finally {
    db.close()
  }
}

/**
 * 造一个**真的**目标版本老库：
 * - v1：静态 fixture（tests/fixtures/rss-storage-v1.sql），它本来就没有 author 列；
 * - v2/v3/v4：先按当前 schema 建库，再拆掉那一版还没有的对象，最后才盖目标版本章。
 *   拆的顺序是 v5（author）→ v4（link_key/i3）→ v3（reading_progress）→ v2。
 */
function makeLegacy(version, tag) {
  const dir = tempDir(tag)
  const path = join(dir, 'rss.db')
  const configPath = join(dir, 'config.json')
  writeConfigFile(configPath, { version: 1, feeds: { [FEED]: { url: FEED, title: '源 A' } } })

  if (version === 1) {
    const db = new DatabaseSync(path)
    try {
      db.exec(V1_SQL)
      db.prepare(
        'INSERT INTO items (id, feed_id, title, link, published_at, fetched_at, summary, read_at, starred, kept_unread, article_failure) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('old-1', FEED, '旧文章', LINK, TIME, TIME, '旧摘要', TIME, 1, 1, '旧的抓取失败')
      db.prepare('INSERT INTO texts (item_id, body, revision, frameable, title, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('old-1', JSON.stringify([{ kind: 'p', text: '旧正文' }]), 2, 0, '旧标题', TIME)
      db.prepare('INSERT INTO cursors (feed_id, seen, cursor_at) VALUES (?, ?, ?)')
        .run(FEED, JSON.stringify(['old-1']), TIME)
    } finally {
      db.close()
    }
    return { dir, path, configPath }
  }

  const db = openDatabase(path)
  try {
    migrateSchema(db)
    // 先真的拆回目标版本 —— 这一段是本文件存在的理由：只改版本章的「旧库」会让迁移测试空转。
    db.exec('ALTER TABLE items DROP COLUMN author')
    if (version <= 3) {
      db.exec('DROP INDEX i3')
      db.exec('ALTER TABLE items DROP COLUMN link_key')
    }
    if (version === 2) db.exec('DROP TABLE reading_progress')

    const columns = [
      'id', 'feed_id', 'title', 'link', 'published_at', 'fetched_at',
      'summary', 'read_at', 'starred', 'kept_unread', 'article_failure',
    ]
    const values = ['old-1', FEED, '旧文章', LINK, TIME, TIME, '旧摘要', TIME, 1, 1, '旧的抓取失败']
    if (version === 4) {
      // link_key 是 v4 的派生列：v2/v3 里连列都不该有（v4 那一行用来验「升级不重算」）。
      columns.push('link_key')
      values.push(linkKeyOf(LINK))
    }
    db.prepare(
      'INSERT INTO items (' + columns.join(', ') + ') VALUES (' + columns.map(() => '?').join(', ') + ')',
    ).run(...values)
    db.prepare('INSERT INTO texts (item_id, body, revision, frameable, title, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('old-1', JSON.stringify([{ kind: 'p', text: '旧正文' }]), 2, 0, '旧标题', TIME)
    db.prepare('INSERT INTO cursors (feed_id, seen, cursor_at) VALUES (?, ?, ?)')
      .run(FEED, JSON.stringify(['old-1']), TIME)
    // v2 起有标签：标签关联必须原样保留（验收 8）
    db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)').run('tag-1', '技术', TIME)
    db.prepare('INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?)').run('old-1', 'tag-1')
    if (version >= 3) {
      db.prepare('INSERT INTO reading_progress (item_id, version, ratio, updated_at) VALUES (?, ?, ?, ?)')
        .run('old-1', 'rev-2', 0.42, TIME)
    }
    db.exec('PRAGMA user_version = ' + version)
  } finally {
    db.close()
  }
  return { dir, path, configPath }
}

/** 把老库升到 v5 并返回打开着的句柄（调用方负责关）。 */
function upgrade(path) {
  const db = openDatabase(path)
  try {
    migrateSchema(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

test('全新库建表即含 author 列（可空、无默认值）', () => {
  const db = openDatabase(':memory:')
  try {
    migrateSchema(db)
    const column = db.prepare('PRAGMA table_info(items)').all().find((candidate) => candidate.name === 'author')
    assert.ok(
      column !== undefined,
      'items 必须有 author 列：新库只走 BASE_SCHEMA_DDL，缺它等于功能在新装用户那里完全不存在',
    )
    assert.equal(column.type, 'TEXT', 'author 存的是 feed 给的原始字符串')
    assert.equal(column.notnull, 0, 'author 必须可空：无作者条目就是 NULL，不是空串')
    assert.equal(column.dflt_value, null, '不许有默认值：默认值会把「不知道」写成某个值（迁移不回填的同一条纪律）')
  } finally {
    db.close()
  }
})

// 四条路径各自一个 test、名字写成字面量（不走循环拼接）：失败时必须一眼看出是哪一版漏了列，
// 变异表的 judgeTests 也要求名字是字面量才能做「测试名漂移」校验。
// 版本号写死 5 是有意的 —— 改物理版本就必须重看这四条路径（spec 决策 5）。
function assertUpgradePath(version) {
  const legacy = makeLegacy(version, 'up' + version)
  try {
    const before = snapshot(legacy.path)
    assert.equal(before.version, version, '前置条件：夹具的版本章')
    assert.equal(
      before.itemColumns.includes('author'),
      false,
      `前置条件：v${version} 夹具必须真的没有 author 列（只改 user_version 的「旧库」会让本用例空转）`,
    )
    assert.equal(before.authors, undefined, '前置条件：迁移前连读 author 的 SQL 都不该成立')

    const db = upgrade(legacy.path) // v4 在 openDatabase 的版本闸就被检查：可升级集合漏 4 会当场抛
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5, '升完必须盖成 v5')
    } finally {
      db.close()
    }

    const after = snapshot(legacy.path)
    assert.ok(
      after.itemColumns.includes('author'),
      `v${version}→v5 后 items.author 必须存在：缺列时 ITEM_SELECT 里的 i.author 会 no such column（老库打不开）`,
    )
    assert.deepEqual(
      after.authors.map((row) => [row.id, row.author]),
      before.items.map((row) => [row.id, null]),
      '旧行的 author 必须全部是 NULL：迁移只加列、不回填（ADR-0009）',
    )
    assert.deepEqual(after.items, before.items, '升级不得改任何条目（含已读/星标/保持未读/摘要/发布时间）')
    assert.deepEqual(after.texts, before.texts, '升级不得改正文缓存')
    assert.deepEqual(after.cursors, before.cursors, '升级不得改去重窗口')
    if (version >= 2) {
      assert.deepEqual(after.tags, before.tags, '标签本身不得被升级改动')
      assert.deepEqual(after.itemTags, before.itemTags, '标签关联必须原样保留')
    }
    if (version >= 3) {
      assert.deepEqual(after.progress, before.progress, '阅读进度必须原样保留')
    }
    if (version === 4) {
      assert.deepEqual(after.linkKeys, before.linkKeys, 'link_key 是 v4 的派生列，升级不得重算/改动')
    } else {
      assert.equal(
        after.linkKeys[0].link_key,
        linkKeyOf(LINK),
        `v${version}→v5 必须把 v4 的 link_key 回填到位`,
      )
    }

    // 幂等：升完再跑一次不报错、不改数据
    const again = openDatabase(legacy.path)
    try {
      migrateSchema(again)
      assert.equal(again.prepare('PRAGMA user_version').get().user_version, 5)
    } finally {
      again.close()
    }
    assert.deepEqual(snapshot(legacy.path), after, '已是 v5 的库再迁移必须是无操作')
  } finally {
    rmSync(legacy.dir, { recursive: true, force: true })
  }
}

test('迁移 v1→v5：author 列出现、旧行全 NULL、其余列逐项相等、user_version = 5', () => assertUpgradePath(1))
test('迁移 v2→v5：author 列出现、旧行全 NULL、其余列逐项相等、user_version = 5', () => assertUpgradePath(2))
test('迁移 v3→v5：author 列出现、旧行全 NULL、其余列逐项相等、user_version = 5', () => assertUpgradePath(3))
test('迁移 v4→v5：author 列出现、旧行全 NULL、其余列逐项相等、user_version = 5', () => assertUpgradePath(4))

test('迁移幂等：已是 v5 的库再跑 migrateSchema 不报错、不改数据', () => {
  const dir = tempDir('idempotent')
  try {
    const db = openDatabase(join(dir, 'rss.db'))
    try {
      migrateSchema(db)
      db.prepare('INSERT INTO items (id, feed_id, title, link, fetched_at, starred) VALUES (?, ?, ?, ?, ?, 1)')
        .run('item-1', FEED, '标题', LINK, TIME)
    } finally {
      db.close()
    }
    const before = snapshot(join(dir, 'rss.db'))
    const reopened = openDatabase(join(dir, 'rss.db'))
    try {
      migrateSchema(reopened)
      migrateSchema(reopened)
      assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 5)
    } finally {
      reopened.close()
    }
    assert.deepEqual(snapshot(join(dir, 'rss.db')), before, '重复迁移不许改任何东西（插件每次装载都会走一遍）')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('迁移后能读条目：四条老库路径 listItems() / item() 不抛 no such column', () => {
  for (const version of [1, 2, 3, 4]) {
    const legacy = makeLegacy(version, 'read' + version)
    try {
      const db = upgrade(legacy.path)
      try {
        const store = createSqliteStore(db, legacy.configPath)
        // 这是验收 4 的行为面判据：列存在但读路径炸掉，用户看到的仍是「老库打不开」。
        assert.deepEqual(
          store.listItems(FEED).map(([itemId]) => itemId),
          ['old-1'],
          `v${version}→v5 后 listItems() 必须能读`,
        )
        const item = store.item('old-1')
        assert.ok(item !== undefined, `v${version}→v5 后 item() 必须能读`)
        assert.equal(item.title, '旧文章')
        assert.equal(item.readAt, TIME, '已读状态原样')
        assert.equal(item.starred, true, '星标原样')
        assert.equal(item.keptUnread, true, '保持未读原样')
        assert.equal(item.author, undefined, '旧行没有作者：读回 undefined，不是空串')
      } finally {
        db.close()
      }
    } finally {
      rmSync(legacy.dir, { recursive: true, force: true })
    }
  }
})

test('author 列不引入新索引：v5 与 v4 的索引集合相同', () => {
  const legacy = makeLegacy(4, 'index')
  try {
    const before = snapshot(legacy.path)
    const db = upgrade(legacy.path)
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5)
    } finally {
      db.close()
    }
    const after = snapshot(legacy.path)
    assert.deepEqual(
      after.indexes,
      before.indexes,
      '验收 18：加 author 列不许带新索引 —— instr(...) 全表扫描用不上索引，加了只是写放大',
    )
  } finally {
    rmSync(legacy.dir, { recursive: true, force: true })
  }
})

test('v5 的库通过 verify-backup 校验（版本上界自动跟随 SCHEMA_VERSION）', () => {
  const legacy = makeLegacy(1, 'verify')
  try {
    const db = upgrade(legacy.path)
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5)
    } finally {
      db.close()
    }
    const result = spawnSync(process.execPath, [VERIFY_BACKUP, legacy.dir], { encoding: 'utf8' })
    assert.equal(result.status, 0, 'v5 必须落在校验器支持的 1..SCHEMA_VERSION 区间，实际 stderr：' + result.stderr)
    assert.match(
      result.stdout,
      new RegExp('库版本 ' + SCHEMA_VERSION + '（本版支持 1\\.\\.' + SCHEMA_VERSION),
      '校验器必须把 v5 认成当前版本（它从 SCHEMA_VERSION 取上界，不需要改脚本）',
    )
    assert.match(result.stdout, /可以恢复/)
  } finally {
    rmSync(legacy.dir, { recursive: true, force: true })
  }
})
