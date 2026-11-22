/**
 * M2 02：文件夹目录与变更接口的**磁盘行为**判据。
 *
 * 这些用例只回答一个问题：把 `config.json` 关掉再打开，用户看到的目录与归属是不是刚才那一下？
 * 所以每个关键动作后都从磁盘重读（`readConfigFile` / 重开 store），而不是断言内存里的返回值 ——
 * 「内存对了、盘上没写」正是本票据最容易静默失败的形态。
 *
 * 覆盖票据点名的那组：旧配置派生、空目录重启、改名碰撞、删除目录、移动出入、配置写入失败；
 * 以及「刷新 / 订阅写入 / 偏好保存 / 退订都不得丢目录」这条横切不变量。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrateSchema } from '../lib/storage/db.js'
import { readConfigFile, writeConfigFile } from '../lib/storage/config-file.js'
import { createSqliteStore } from '../lib/store-sqlite.js'
import { FolderError } from '../lib/folders.js'
import { DEFAULT_READING_PREFERENCES } from '../lib/preferences.js'

/** 每个用例一份独立目录：真文件 config.json + 文件库 rss.db（重启判据要能关掉再开）。 */
function fresh(tag, feeds = {}, rawConfig) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-folder-' + tag + '-'))
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
  // 显式跟踪是否还开着：不写空 catch —— 关闭失败必须让人看见（AGENTS.md 的硬约束）。
  if (ctx.open) {
    ctx.db.close()
    ctx.open = false
  }
  rmSync(ctx.dir, { recursive: true, force: true })
}

const asFolderError = (code) => (error) => error instanceof FolderError && error.code === code

test('旧配置没有 folders 字段：目录从 feed.folder 派生，读取不改写文件', () => {
  const feedA = 'https://a.example/feed.xml'
  const feedB = 'https://b.example/feed.xml'
  const feedC = 'https://c.example/feed.xml'
  const raw = JSON.stringify({
    version: 1,
    feeds: {
      [feedA]: { url: feedA, title: 'A', folder: '技术' },
      [feedB]: { url: feedB, title: 'B', folder: '技术/子组' },
      [feedC]: { url: feedC, title: 'C' },
    },
  }, null, 2) + '\n'
  const ctx = fresh('legacy', {}, raw)
  try {
    const config = readConfigFile(ctx.configPath)
    assert.deepEqual(config.folders, ['技术', '技术/子组'], '旧配置的目录必须由现有订阅派生')
    assert.equal(readFileSync(ctx.configPath, 'utf8'), raw, '读取旧配置不得顺手改写文件')
    assert.deepEqual(ctx.store.listFolders(), [
      { name: '技术', feedIds: [feedA] },
      { name: '技术/子组', feedIds: [feedB] },
    ], '成员按 config.json 的订阅顺序')
  } finally { dispose(ctx) }
})

test('配置版本策略：v1 可选 folders 与成员分组取并集，写入不升版本', async () => {
  const feedId = 'https://a.example/feed.xml'
  const raw = JSON.stringify({
    version: 1,
    folders: ['显式空目录'],
    feeds: { [feedId]: { url: feedId, folder: '成员分组' } },
  })
  const ctx = fresh('version', {}, raw)
  try {
    const config = readConfigFile(ctx.configPath)
    assert.equal(config.version, 1, '沿用 v1：可选字段不是升版本的理由')
    assert.deepEqual(config.folders, ['显式空目录', '成员分组'], '显式目录在前，成员分组按订阅顺序补齐')

    await ctx.store.createFolder('新目录')
    const disk = readConfigFile(ctx.configPath)
    assert.equal(disk.version, 1, '写入后版本仍是 1')
    assert.deepEqual(disk.folders, ['显式空目录', '成员分组', '新目录'], '三条都落盘（含空目录）')
  } finally { dispose(ctx) }
})

test('空文件夹可创建，并在重启后保留（目录不是 feed.folder 的派生物）', async () => {
  const ctx = fresh('empty')
  try {
    await ctx.store.createFolder('  空目录  ')
    assert.deepEqual(ctx.store.listFolders(), [{ name: '空目录', feedIds: [] }], '新名称去首尾空白')
    assert.deepEqual(readConfigFile(ctx.configPath).folders, ['空目录'], '空目录必须落进 config.json')

    const reopened = reopen(ctx)
    assert.deepEqual(reopened.listFolders(), [{ name: '空目录', feedIds: [] }], '重启后空目录仍在')
  } finally { dispose(ctx) }
})

test('名称校验：空白、超长、重复精确拒绝；80 码点边界按 Unicode 计', async () => {
  const ctx = fresh('names')
  try {
    await assert.rejects(() => ctx.store.createFolder('   '), asFolderError('bad-request'), '空白名必须拒绝')
    await assert.rejects(() => ctx.store.createFolder('x'.repeat(81)), asFolderError('bad-request'), '81 字符必须拒绝')
    await ctx.store.createFolder('  Tech  ')
    assert.deepEqual(ctx.store.listFolders().map((folder) => folder.name), ['Tech'], '新名称去首尾空白')
    await assert.rejects(() => ctx.store.createFolder(' Tech '), asFolderError('conflict'), '去空白后同名必须拒绝')
    await ctx.store.createFolder('tech')
    assert.deepEqual(ctx.store.listFolders().map((folder) => folder.name), ['Tech', 'tech'], '重复按精确名称比较（区分大小写）')

    const emoji80 = '😀'.repeat(80)
    await ctx.store.createFolder(emoji80)
    await assert.rejects(() => ctx.store.createFolder('😀'.repeat(81)), asFolderError('bad-request'),
      '长度按 Unicode 码点计：80 个 emoji 是 80 个字符，81 个才超限（不能按 UTF-16 单元算）')
  } finally { dispose(ctx) }
})

test('改名原子更新目录与成员归属，重启后一致；碰撞拒绝且不改盘', async () => {
  const feedId = 'https://a.example/feed.xml'
  const record = {
    url: feedId,
    title: 'A',
    folder: '旧名',
    etag: 'W/"e1"',
    lastModified: 'Wed, 08 Oct 2026 10:00:00 GMT',
    lastFetchedAt: '2026-10-11T09:00:00.000Z',
    lastAttemptedAt: '2026-10-11T09:00:00.000Z',
    contentRevision: 2,
    lastFailure: 'HTTP 500',
  }
  const ctx = fresh('rename', { [feedId]: record })
  try {
    await ctx.store.createFolder('另一个')
    await ctx.store.renameFolder('旧名', '新名')

    const disk = readConfigFile(ctx.configPath)
    assert.deepEqual(disk.folders, ['新名', '另一个'], '目录项改名')
    assert.equal(disk.feeds[feedId].folder, '新名', '订阅归属同步改名')
    // 刷新元数据一个都不许在改名时丢：它们是条件请求与调度排序键，丢了不会有任何报错
    for (const field of ['etag', 'lastModified', 'lastFetchedAt', 'lastAttemptedAt', 'contentRevision', 'lastFailure']) {
      assert.deepEqual(disk.feeds[feedId][field], record[field], '改名不得丢 ' + field)
    }

    const reopened = reopen(ctx)
    assert.deepEqual(reopened.listFolders(), [
      { name: '新名', feedIds: [feedId] },
      { name: '另一个', feedIds: [] },
    ], '重启后目录与归属一致')

    const before = readFileSync(ctx.configPath, 'utf8')
    await assert.rejects(() => reopened.renameFolder('新名', '另一个'), asFolderError('conflict'), '目标名已存在必须拒绝')
    assert.equal(readFileSync(ctx.configPath, 'utf8'), before, '改名碰撞不得留下半写文件')
    await reopened.renameFolder('新名', '新名')
    assert.deepEqual(readConfigFile(ctx.configPath).folders, ['新名', '另一个'], '改到同名是幂等空操作')
  } finally { dispose(ctx) }
})

test('删除文件夹只解除分类：订阅、条目、已读/星标/保持未读都在', async () => {
  const feedId = 'https://a.example/feed.xml'
  const otherId = 'https://b.example/feed.xml'
  const ctx = fresh('delete', {
    [feedId]: { url: feedId, title: 'A', folder: '开发', etag: '"keep"', lastFetchedAt: '2026-10-11T09:00:00.000Z' },
    [otherId]: { url: otherId, title: 'B' },
  })
  try {
    await ctx.store.createFolder('保留的空目录')
    await ctx.store.saveItem('item-1', {
      feedId,
      title: '文章',
      link: 'https://a.example/1',
      fetchedAt: '2026-10-11T10:00:00.000Z',
      readAt: '2026-10-11T11:00:00.000Z',
      starred: true,
      keptUnread: true,
      article: { fetchedAt: '2026-10-11T10:30:00.000Z', blocks: [{ kind: 'p', text: '正文' }] },
    })

    const result = await ctx.store.deleteFolder('开发')
    assert.equal(result.detached, 1, '解除 1 个订阅的分类')
    assert.deepEqual(result.folders.map((folder) => folder.name), ['保留的空目录'])

    const disk = readConfigFile(ctx.configPath)
    assert.deepEqual(disk.folders, ['保留的空目录'], '目录项被删除，空目录保留')
    assert.equal(disk.feeds[feedId].folder, undefined, '成员归属清空')
    assert.equal(disk.feeds[feedId].etag, '"keep"', '订阅的抓取元数据原样保留')
    assert.equal(disk.feeds[otherId].url, otherId, '其它订阅不受影响')

    const item = ctx.store.item('item-1')
    assert.ok(item, '删除文件夹不得删条目')
    assert.equal(item.readAt, '2026-10-11T11:00:00.000Z', '已读状态保留')
    assert.equal(item.starred, true, '星标保留')
    assert.equal(item.keptUnread, true, '保持未读保留')
    assert.deepEqual(item.article.blocks, [{ kind: 'p', text: '正文' }], '正文缓存保留')

    const reopened = reopen(ctx)
    assert.equal(reopened.feed(feedId).folder, undefined, '重启后仍是未分类')
    assert.ok(reopened.item('item-1'), '重启后条目仍在')
    await assert.rejects(() => reopened.deleteFolder('开发'), asFolderError('not-found'), '重复删除明确失败')
  } finally { dispose(ctx) }
})

test('移动出入：进目录、同位置幂等、目标/源缺失失败、移出清字段', async () => {
  const feedId = 'https://a.example/feed.xml'
  const ctx = fresh('move', { [feedId]: { url: feedId, title: 'A' } })
  try {
    await ctx.store.createFolder('A')
    await ctx.store.createFolder('B')

    assert.deepEqual(await ctx.store.moveFeedToFolder(feedId, 'A'), [
      { name: 'A', feedIds: [feedId] },
      { name: 'B', feedIds: [] },
    ])
    await ctx.store.moveFeedToFolder(feedId, 'A')
    assert.equal(readConfigFile(ctx.configPath).feeds[feedId].folder, 'A', '重复移入同一位置保持幂等')

    await assert.rejects(() => ctx.store.moveFeedToFolder(feedId, '不存在'), asFolderError('not-found'))
    assert.equal(readConfigFile(ctx.configPath).feeds[feedId].folder, 'A', '目标不存在时归属不变')
    await assert.rejects(() => ctx.store.moveFeedToFolder('https://missing.example/feed.xml', 'A'), asFolderError('not-found'))

    await ctx.store.moveFeedToFolder(feedId, undefined)
    assert.equal(readConfigFile(ctx.configPath).feeds[feedId].folder, undefined, '移到未分类清除 feed.folder')
    assert.deepEqual(ctx.store.listFolders(), [
      { name: 'A', feedIds: [] },
      { name: 'B', feedIds: [] },
    ], '移出后目录项仍在（可再移入）')

    const reopened = reopen(ctx)
    assert.equal(reopened.feed(feedId).folder, undefined, '重启后仍为未分类')
    assert.equal(reopened.listFolders().length, 2, '重启后两个空目录都在')
  } finally { dispose(ctx) }
})

test('配置写入失败：操作响亮抛错，原文件一个字节不动', {
  skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'root 下权限位不生效' : false,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-folder-writefail-'))
  const locked = join(dir, 'locked')
  mkdirSync(locked)
  const configPath = join(locked, 'config.json')
  writeConfigFile(configPath, { version: 1, feeds: { 'https://a.example/feed.xml': { url: 'https://a.example/feed.xml' } } })
  const db = openDatabase(join(dir, 'rss.db'))
  migrateSchema(db)
  const store = createSqliteStore(db, configPath)
  const before = readFileSync(configPath, 'utf8')
  try {
    chmodSync(locked, 0o500)
    try {
      await assert.rejects(() => store.createFolder('新目录'), /写订阅文件/, '目录不可写时必须抛错')
    } finally {
      chmodSync(locked, 0o700)
    }
    assert.equal(readFileSync(configPath, 'utf8'), before, '写入失败不得留下半截配置')
    assert.deepEqual(readConfigFile(configPath).folders, [])
  } finally {
    chmodSync(locked, 0o700)
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('横切不变量：刷新、订阅写入、偏好保存、退订都不得丢目录', async () => {
  const feedA = 'https://a.example/feed.xml'
  const feedB = 'https://b.example/feed.xml'
  const ctx = fresh('preserve', {
    [feedA]: { url: feedA, title: 'A', folder: '旧分组' },
    [feedB]: { url: feedB, title: 'B' },
  })
  try {
    await ctx.store.createFolder('空目录')
    await ctx.store.updateFeed(feedA, {
      kind: 'refresh-success',
      url: feedA,
      stamp: '2026-10-12T10:00:00.000Z',
      title: 'A2',
      etag: '"v2"',
      lastModified: 'Wed, 08 Oct 2026 10:00:00 GMT',
      contentRevision: 2,
    })
    assert.deepEqual(readConfigFile(ctx.configPath).folders, ['旧分组', '空目录'], '刷新写入保留目录')

    await ctx.store.saveViewPreferences({ navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: false })
    assert.deepEqual(readConfigFile(ctx.configPath).folders, ['旧分组', '空目录'], '偏好保存保留目录')

    await ctx.store.saveFeed('https://c.example/feed.xml', { url: 'https://c.example/feed.xml' })
    assert.deepEqual(readConfigFile(ctx.configPath).folders, ['旧分组', '空目录'], '订阅写入保留目录')

    await ctx.store.deleteSubscription(feedB)
    assert.deepEqual(readConfigFile(ctx.configPath).folders, ['旧分组', '空目录'], '退订保留目录')

    const disk = readConfigFile(ctx.configPath)
    assert.equal(disk.feeds[feedA].folder, '旧分组', '刷新不得把归属改掉')
    assert.equal(disk.feeds[feedA].title, 'A2', '刷新元数据照常写入')
  } finally { dispose(ctx) }
})

test('config.json 的 folders 形状不对时响亮失败（不把坏目录当「没有目录」）', () => {
  const ctx = fresh('badfolders')
  try {
    const cases = [
      ['不是数组', JSON.stringify({ version: 1, feeds: {}, folders: 'x' })],
      ['元素不是字符串', JSON.stringify({ version: 1, feeds: {}, folders: [1] })],
      ['空白名称', JSON.stringify({ version: 1, feeds: {}, folders: ['  '] })],
    ]
    for (const [label, raw] of cases) {
      writeFileSync(ctx.configPath, raw)
      assert.throws(
        () => readConfigFile(ctx.configPath),
        (error) => error.message.includes(ctx.configPath),
        label + '：必须抛错并带上路径',
      )
    }
  } finally { dispose(ctx) }
})

test('视图记忆可保存文件夹选中；文件夹删除后回落虚拟视图', async () => {
  const feedId = 'https://a.example/feed.xml'
  const ctx = fresh('folder-prefs', { [feedId]: { url: feedId, folder: '技术' } })
  try {
    await ctx.store.saveViewPreferences({
      navSelection: { kind: 'folder', folder: '技术' }, filter: 'unread', navVisible: false,
    })
    assert.deepEqual(ctx.store.viewPreferences(), {
      navSelection: { kind: 'folder', folder: '技术' }, filter: 'unread', navVisible: false, showUnread: true,
      reading: DEFAULT_READING_PREFERENCES,
    }, '文件夹选中项必须能持久化并读回')

    await ctx.store.deleteFolder('技术')
    assert.deepEqual(ctx.store.viewPreferences().navSelection, { kind: 'virtual' },
      '目录里已不存在的文件夹不能让记忆继续指向它')
  } finally { dispose(ctx) }
})
