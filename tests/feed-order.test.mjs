/**
 * R3 01：订阅源顺序的唯一真相是 `config.json` 的 `feedOrder`。
 *
 * 这些用例回答两类问题：把文件关掉再打开，顺序还是不是用户排的那一份；以及「没排过」的旧配置
 * 会不会被一次无关写入悄悄变成「排过」。派生规则是纯函数，所以先用边界把规则钉死，再用真
 * config.json + 真 SQLite store 钉读写两侧。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrateSchema } from '../lib/storage/db.js'
import { readConfigFile, writeConfigFile } from '../lib/storage/config-file.js'
import { createSqliteStore } from '../lib/store-sqlite.js'
import { deriveFeedOrder } from '../lib/feed-order.js'

const A = 'https://a.example/feed.xml'
const B = 'https://b.example/feed.xml'
const C = 'https://c.example/feed.xml'
const D = 'https://d.example/feed.xml'

/** 最小 FeedRecord：url 是必填项，其余字段与顺序判定无关。 */
const record = (id) => ({ url: id, title: id })
const feedsOf = (...ids) => Object.fromEntries(ids.map((id) => [id, record(id)]))

/** 每个用例一份独立目录：真文件 config.json + 真 SQLite 库（重启判据要能关掉再开）。 */
function fresh(tag, rawConfig, feeds = feedsOf(A, B, C)) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-feed-order-' + tag + '-'))
  const configPath = join(dir, 'config.json')
  if (rawConfig !== undefined) writeFileSync(configPath, rawConfig)
  else writeConfigFile(configPath, { version: 1, feeds })
  const dbPath = join(dir, 'rss.db')
  const db = openDatabase(dbPath)
  migrateSchema(db)
  const ctx = { dir, configPath, dbPath, db, open: true, store: createSqliteStore(db, configPath) }
  return ctx
}

/** 模拟「插件重启」：关连接、重开同一个库与同一份配置。 */
function reopen(ctx) {
  ctx.db.close()
  ctx.open = false
  ctx.db = openDatabase(ctx.dbPath)
  migrateSchema(ctx.db)
  ctx.open = true
  ctx.store = createSqliteStore(ctx.db, ctx.configPath)
  return ctx.store
}

function dispose(ctx) {
  // 不写空 catch：关闭失败必须让人看见（AGENTS.md 的硬约束）。
  if (ctx.open) {
    ctx.db.close()
    ctx.open = false
  }
  rmSync(ctx.dir, { recursive: true, force: true })
}

const idsOf = (entries) => entries.map(([feedId]) => feedId)
const rawConfigWith = (feeds, extra = {}) => JSON.stringify({ version: 1, feeds, ...extra }, null, 2) + '\n'

test('派生：已列出的按数组序，未列出的按 feeds 键序追加；未知 id 与空串丢弃，重复保首次', () => {
  const feeds = feedsOf(A, B, C, D)
  assert.deepEqual(deriveFeedOrder([C, A], feeds), [C, A, B, D], '已列出的顺序优先，其余按 feeds 键序追加')
  assert.deepEqual(deriveFeedOrder([C, 'missing', A, C, ''], feeds), [C, A, B, D], '未知/空串丢弃，重复保首次')
  assert.deepEqual(deriveFeedOrder(undefined, feeds), [A, B, C, D], '没配置 ⇒ 键序')
  assert.deepEqual(deriveFeedOrder([], feeds), [A, B, C, D], '空数组 ⇒ 键序（明确没有排过）')
  assert.deepEqual(deriveFeedOrder(['missing'], feeds), [A, B, C, D], '全是未知 id ⇒ 键序，不丢源')
  assert.deepEqual(deriveFeedOrder([B], {}), [], '没有源 ⇒ 空')
})

test('手改 feedOrder（故意与键序不同）后：读入与关掉重开都按它，且读取不改写文件', () => {
  const raw = rawConfigWith(feedsOf(A, B, C), { feedOrder: [C, A] })
  const ctx = fresh('read', raw)
  try {
    assert.deepEqual(idsOf(ctx.store.listFeeds()), [C, A, B], '读侧按 feedOrder 派生')
    assert.deepEqual(readConfigFile(ctx.configPath).feedOrder, [C, A], '读出来的数组保持原样（不排序、不去重）')
    assert.equal(readFileSync(ctx.configPath, 'utf8'), raw, '读取不得顺手改写文件')

    const reopened = reopen(ctx)
    assert.deepEqual(idsOf(reopened.listFeeds()), [C, A, B], '关掉重开（同一份 config.json 重建 store）后顺序保持')
    assert.equal(readFileSync(ctx.configPath, 'utf8'), raw, '重开也不得改写文件')
  } finally { dispose(ctx) }
})

test('feedOrder 里的未知 id 与空串：读入不报错、派生丢弃、文件一字不改', () => {
  const raw = rawConfigWith(feedsOf(A, B, C), { feedOrder: ['', 'https://gone.example/feed.xml', C] })
  const ctx = fresh('unknown', raw)
  try {
    assert.deepEqual(idsOf(ctx.store.listFeeds()), [C, A, B], '只认 feeds 里真实存在的 id')
    assert.equal(readFileSync(ctx.configPath, 'utf8'), raw, '不认识的 id 不是格式错，读侧不改写文件')
  } finally { dispose(ctx) }
})

test('feedOrder: [] 是合法值：读入不报错，顺序回落到键序', () => {
  const raw = rawConfigWith(feedsOf(A, B), { feedOrder: [] })
  const ctx = fresh('empty-order', raw)
  try {
    assert.deepEqual(readConfigFile(ctx.configPath).feedOrder, [], '空数组必须原样读回（它是「明确没排过」）')
    assert.deepEqual(idsOf(ctx.store.listFeeds()), [A, B], '空数组 ⇒ 键序')
    assert.equal(readFileSync(ctx.configPath, 'utf8'), raw, '读取不改写')
  } finally { dispose(ctx) }
})

test('feedOrder 不是字符串数组：装载响亮失败、消息带路径，绝不返回空订阅', () => {
  const badValues = ['"a,b"', '[1,2]', '["https://a.example/feed.xml",1]', '{}', 'null']
  for (const bad of badValues) {
    const ctx = fresh('bad-' + Buffer.from(bad).toString('hex').slice(0, 8), rawConfigWith(feedsOf(A), { feedOrder: JSON.parse(bad) }))
    try {
      assert.throws(() => readConfigFile(ctx.configPath), (error) => {
        assert.match(error.message, /feedOrder/, '错误必须点名 feedOrder')
        assert.ok(error.message.includes(ctx.configPath), '错误消息必须带路径：' + error.message)
        return true
      }, '坏形状 ' + bad + ' 必须抛错')
      assert.throws(() => ctx.store.listFeeds(), /feedOrder/, 'store 读侧也必须抛，绝不返回空订阅')
    } finally { dispose(ctx) }
  }
})

test('旧配置没有 feedOrder：保存视图偏好 / 刷新写回 / 文件夹写入之后，文件里仍然没有这个键', async () => {
  const ctx = fresh('legacy', undefined, feedsOf(A, B))
  const gone = () => !Object.hasOwn(JSON.parse(readFileSync(ctx.configPath, 'utf8')), 'feedOrder')
  try {
    assert.ok(gone(), '前提：夹具写出来的旧配置没有 feedOrder')
    assert.deepEqual(idsOf(ctx.store.listFeeds()), [A, B], '没排过 ⇒ 键序')

    await ctx.store.saveViewPreferences({ navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: false })
    assert.ok(gone(), '保存视图偏好不得把「没排过」物化成「排过」')

    await ctx.store.updateFeed(A, {
      kind: 'refresh-success', url: A, stamp: '2026-11-20T00:00:00.000Z', title: 'A',
    })
    assert.ok(gone(), '刷新写回 lastFetchedAt 也不得凭空生成 feedOrder')

    await ctx.store.createFolder('技术')
    assert.ok(gone(), '文件夹写入同样不得生成 feedOrder')
    assert.deepEqual(idsOf(ctx.store.listFeeds()), [A, B])
  } finally { dispose(ctx) }
})

test('已有 feedOrder：一次无关写入既不能丢掉它，也不能改变它', async () => {
  const raw = rawConfigWith(feedsOf(A, B, C), { feedOrder: [C, A] })
  const ctx = fresh('preserve', raw)
  try {
    await ctx.store.saveViewPreferences({ navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: false })
    assert.deepEqual(readConfigFile(ctx.configPath).feedOrder, [C, A], '保存视图偏好必须原样带上顺序')
    await ctx.store.updateFeed(C, { kind: 'refresh-success', url: C, stamp: '2026-11-20T00:00:00.000Z', title: 'C' })
    assert.deepEqual(readConfigFile(ctx.configPath).feedOrder, [C, A], '刷新写回也必须原样带上顺序')
    assert.deepEqual(idsOf(ctx.store.listFeeds()), [C, A, B])
  } finally { dispose(ctx) }
})

test('文件夹成员数组保持键序（只当集合用）：源顺序只在 listFeeds 派生', () => {
  const raw = rawConfigWith(
    { [A]: { ...record(A), folder: '技术' }, [B]: { ...record(B), folder: '技术' }, [C]: record(C) },
    { feedOrder: [C, B, A] },
  )
  const ctx = fresh('folder-set', raw)
  try {
    assert.deepEqual(idsOf(ctx.store.listFeeds()), [C, B, A], '展示顺序跟随 feedOrder')
    assert.deepEqual(ctx.store.listFolders(), [{ name: '技术', feedIds: [A, B] }],
      'FolderView.feedIds 仍是 config.json 键序：它只当集合用，不是第二份展示顺序')
  } finally { dispose(ctx) }
})
