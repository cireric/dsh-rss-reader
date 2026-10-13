/**
 * 自持存储骨架（Task 2）的行为钉子。
 *
 * 这些都不是实现细节，而是「这份存储能不能信」的判据：
 * - 落点必须是 <home>/storages/rss-reader，且 $DSH_HOME 的解析委托官方实现
 *   （src/index.ts:119 手抄过一份，纯空白 $DSH_HOME 下两者不等价）；
 * - 目录 0700 / 文件 0600：里面是用户的订阅与已读态；
 * - 版本握手只能响亮失败——静默降级或重建会让已读态/星标无声消失；
 * - config.json 损坏时必须抛错，不能返回空订阅：那在用户眼里就是「订阅全没了」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { storageRoot, ensureStorageRoot } from '../lib/storage/paths.js'
import { openDatabase, migrateSchema, SCHEMA_VERSION } from '../lib/storage/db.js'
import { readConfigFile, writeConfigFile } from '../lib/storage/config-file.js'

/** 每个用例一个独立临时目录；调用方负责在 finally 里删掉它。 */
const tempDir = (tag) => mkdtempSync(join(tmpdir(), 'rss-skeleton-' + tag + '-'))

test('storageRoot 落在 <home>/storages/rss-reader，且三段优先级跟随 resolveDshHome', () => {
  const saved = process.env.DSH_HOME
  try {
    delete process.env.DSH_HOME
    assert.equal(storageRoot('/tmp/home-a'), '/tmp/home-a/storages/rss-reader', '显式参数必须压过环境变量')

    process.env.DSH_HOME = '/tmp/home-b'
    assert.equal(storageRoot(), '/tmp/home-b/storages/rss-reader', '没有显式参数时用 $DSH_HOME')
    assert.equal(storageRoot('/tmp/home-a'), '/tmp/home-a/storages/rss-reader', '显式参数仍压过 $DSH_HOME')

    // 纯空白 = 未设置。这条是「委托 resolveDshHome」的判别式：
    // 手抄版 process.env.DSH_HOME || join(homedir(), '.dsh') 会把它当路径用，
    // 得到 '   /storages/...' 这种相对路径（落到 CWD 上）。
    for (const blank of ['', '   ', '\t']) {
      process.env.DSH_HOME = blank
      assert.equal(
        storageRoot(),
        join(homedir(), '.dsh', 'storages', 'rss-reader'),
        JSON.stringify(blank) + ' 应当视为未设置，回落 ~/.dsh',
      )
    }

    delete process.env.DSH_HOME
    assert.equal(storageRoot(), join(homedir(), '.dsh', 'storages', 'rss-reader'))
    // '~' 展开也走官方实现，不自己拼
    assert.equal(storageRoot('~/cfg'), join(homedir(), 'cfg', 'storages', 'rss-reader'))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('ensureStorageRoot 递归建出 0700 目录，且可重复调用', () => {
  const base = tempDir('mkdir')
  try {
    const root = join(base, 'nested', 'storages', 'rss-reader')
    ensureStorageRoot(root)
    assert.equal(statSync(root).mode & 0o777, 0o700, '存储根必须 0700')
    assert.equal(statSync(join(base, 'nested')).mode & 0o777, 0o700, '中间目录同样 0700')
    ensureStorageRoot(root) // 插件每次装载都会调，必须幂等
    assert.equal(statSync(root).mode & 0o777, 0o700)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('ensureStorageRoot 建不出目录时抛错，消息带路径，不回落临时目录（父路径是普通文件）', () => {
  const base = tempDir('notdir')
  try {
    const blocker = join(base, 'blocker')
    writeFileSync(blocker, 'x')
    const root = join(blocker, 'storages', 'rss-reader')
    assert.throws(
      () => ensureStorageRoot(root),
      (error) => error.message.includes(root),
      '消息必须带上要建的路径，否则用户不知道去改哪里',
    )
    // 不回落：既没有偷偷建到别处，也没有把失败咽下去
    assert.equal(existsSync(root), false)
    assert.deepEqual(readdirSync(base), ['blocker'], '失败时不得在别处留下新目录')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('ensureStorageRoot 对不可写父目录抛错，消息带路径，不静默降级（Review Focus 5）', {
  skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'root 下权限位不生效' : false,
}, () => {
  const base = tempDir('eacces')
  const readonly = join(base, 'readonly')
  try {
    mkdirSync(readonly, { mode: 0o500 })
    const root = join(readonly, 'storages', 'rss-reader')
    assert.throws(
      () => ensureStorageRoot(root),
      (error) => error.message.includes(root),
      'DSH_HOME 不可写时必须响亮失败并说明路径，不许回落临时目录',
    )
    assert.equal(existsSync(root), false)
  } finally {
    chmodSync(readonly, 0o700)
    rmSync(base, { recursive: true, force: true })
  }
})

test('openDatabase 建库为 0600、WAL、busy_timeout=5000，migrateSchema 才盖版本章', () => {
  const base = tempDir('open')
  const root = join(base, 'storages', 'rss-reader')
  ensureStorageRoot(root)
  const dbPath = join(root, 'rss.db')
  const db = openDatabase(dbPath)
  try {
    // 实测（Node v24.19）：new DatabaseSync(path) 建出的文件是 0644（umask 支配），
    // 预建 open(path,'wx',0o600) 才是 0600；-wal/-shm 随主库继承 0600。
    assert.equal(statSync(dbPath).mode & 0o777, 0o600, '库文件必须 0600')
    assert.equal(statSync(dbPath + '-wal').mode & 0o777, 0o600, 'WAL 边车必须继承 0600')
    assert.equal(statSync(dbPath + '-shm').mode & 0o777, 0o600, 'SHM 边车必须继承 0600')

    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal', '必须真的开在 WAL 上')
    assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000, '并发写要靠 busy_timeout 排队')

    assert.equal(SCHEMA_VERSION, 1, '物理布局版本是对外契约，改它必须同时想迁移')
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0, 'migrateSchema 之前不许盖章')
    migrateSchema(db)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
    migrateSchema(db) // 幂等：每次装载都会走一遍
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
  } finally {
    db.close()
    rmSync(base, { recursive: true, force: true })
  }
})

test('migrateSchema 对「既不是空库也不是当前版本」的库同样拒绝建表（不许覆盖陌生库）', () => {
  const db = openDatabase(':memory:')
  try {
    // openDatabase 已经挡住了磁盘上的这种库（构造不出来），但内存库与将来的多版本迁移
    // 都可能走到这里；命令层必须自己再拦一道，不能靠调用方先做过检查。
    db.exec('PRAGMA user_version = 7')
    assert.throws(
      () => migrateSchema(db),
      (error) => error.message.includes('7'),
      '不认识的版本必须拒绝并报出它，而不是把库覆盖成半成品',
    )
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7, '拒绝时不得改写版本')
    assert.throws(() => db.prepare('SELECT 1 FROM items').get(), /no such table/, '拒绝时不得建表')
  } finally {
    db.close()
  }
})

test('openDatabase 拒绝更高版本的库：响亮失败、消息带路径、不降级不重建', () => {
  const base = tempDir('toonew')
  const root = join(base, 'storages', 'rss-reader')
  ensureStorageRoot(root)
  const dbPath = join(root, 'rss.db')
  {
    const seed = openDatabase(dbPath)
    try {
      migrateSchema(seed)
      seed.exec('PRAGMA user_version = 99')
    } finally {
      seed.close()
    }
  }
  assert.throws(
    () => openDatabase(dbPath),
    (error) => error.message.includes(dbPath),
    '未来版本建的库必须响亮失败并带上路径，让用户知道是哪个文件',
  )
  // 拒绝的副作用只有「没打开」：库本身必须原样留在 99，不许被降级或重建
  const check = new DatabaseSync(dbPath)
  try {
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99, '拒绝时不得改写库版本')
  } finally {
    check.close()
  }
  rmSync(base, { recursive: true, force: true })
})

test('openDatabase 能重开已经建好的库（第二次装载不许把好库当坏库拒绝）', () => {
  const base = tempDir('reopen')
  const root = join(base, 'storages', 'rss-reader')
  ensureStorageRoot(root)
  const dbPath = join(root, 'rss.db')
  try {
    const first = openDatabase(dbPath)
    try {
      migrateSchema(first)
    } finally {
      first.close()
    }

    // 插件每次装载都会重开这个库。上面那道「拒绝不认识的版本」的闸一旦写成「非 0 即拒」，
    // **第一次装好的库第二次就再也打不开** —— 用户看到的是「重启之后订阅全没了」，
    // 而本机数据其实完好。这条断言就是那次重启。
    const second = openDatabase(dbPath)
    try {
      assert.equal(
        second.prepare('PRAGMA user_version').get().user_version,
        SCHEMA_VERSION,
        '重开已经建好的库必须成功',
      )
      migrateSchema(second) // 已建好的库上必须是**无操作**（装载路径每次都会走一遍）
      assert.equal(second.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
      assert.equal(second.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0, '表必须还在')
    } finally {
      second.close()
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('migrateSchema 物化 items/texts/cursors，recency = COALESCE(published_at, fetched_at)', () => {
  const db = openDatabase(':memory:')
  try {
    migrateSchema(db)
    const insert = db.prepare(
      'INSERT INTO items(id, feed_id, title, link, published_at, fetched_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    insert.run('no-pub', 'feed-1', 't', 'l', null, '2026-10-11T10:00:00.000Z')
    insert.run('has-pub', 'feed-1', 't', 'l', '2026-09-01T00:00:00.000Z', '2026-10-11T10:00:00.000Z')

    // spec §10：排序键是 publishedAt ?? fetchedAt。缺发布时间的条目不许落进 SQL 的 NULL 段
    // （SQLite 里 NULL 最小，列表顺序会与迁移前不一致）。
    const recencyOf = db.prepare('SELECT recency FROM items WHERE id = ?')
    assert.equal(recencyOf.get('no-pub').recency, '2026-10-11T10:00:00.000Z')
    assert.equal(recencyOf.get('has-pub').recency, '2026-09-01T00:00:00.000Z')

    // 正文另表 + 级联：删条目不得留下孤儿正文
    db.prepare('INSERT INTO texts(item_id, body, revision, frameable, title, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('no-pub', 'body', 2, 1, 't', '2026-10-11T10:00:00.000Z')
    db.prepare('DELETE FROM items WHERE id = ?').run('no-pub')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM texts').get().n, 0, '正文必须随条目级联删除')

    // 去重窗口表在同一份 schema 里（spec §4.1：rss.db 含去重窗口）
    db.prepare('INSERT INTO cursors(feed_id, seen, cursor_at) VALUES (?, ?, ?)')
      .run('feed-1', JSON.stringify(['id-1']), '2026-10-11T10:00:00.000Z')

    // 两个索引都在：i1 服务每源列表/未读，i2 服务跨源 top-N 与 keyset 分页（spec §10.3）
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('i1', 'i2') ORDER BY name")
      .all().map((row) => row.name)
    assert.deepEqual(names, ['i1', 'i2'])

    // texts.fetched_at 必须 NOT NULL（2026-10-11 终检评审 C1）：
    // 读侧三处（item / listItems / allItems）都走 requiredText，而 DDL 原先允许 NULL
    // ⇒ 一条 NULL 行会让这三处**全都抛**。本版自己的写入口写不出它
    //（articleRecordSchema.fetchedAt 必填），所以这里查声明；
    // 「NULL 真的写不进去」的可执行判据在 tests/store-sqlite.test.mjs 的同名用例里。
    const fetchedAtColumn = db.prepare('PRAGMA table_info(texts)').all().find((column) => column.name === 'fetched_at')
    assert.equal(fetchedAtColumn.notnull, 1,
      'texts.fetched_at 必须声明 NOT NULL —— 读侧走 requiredText，NULL 行会让读路径整条抛')
  } finally {
    db.close()
  }
})

test('writeConfigFile 原子写 + 0600，readConfigFile 逐字段回读（含条件请求与内容版本）', () => {
  const base = tempDir('config')
  const root = join(base, 'storages', 'rss-reader')
  ensureStorageRoot(root)
  const configPath = join(root, 'config.json')
  try {
    // 这里刻意带上 etag / contentRevision / lastFetchedAt / lastFailure：
    // 它们丢了就是「迁移后第一轮全量重抓 + 摘要回填空转」，而且没有任何断言会翻红。
    const value = {
      version: 1,
      feeds: {
        'https://a.example/feed.xml': {
          url: 'https://a.example/feed.xml',
          title: 'A',
          folder: '技术',
          etag: 'W/"7f-1"',
          lastModified: 'Wed, 08 Oct 2026 10:00:00 GMT',
          contentRevision: 2,
          lastFetchedAt: '2026-10-11T09:00:00.000Z',
        },
        'https://b.example/feed.xml': {
          url: 'https://b.example/feed.xml',
          lastFailure: 'HTTP 500',
        },
      },
      viewPreferences: { mode: 'list', folder: '技术' },
    }
    writeConfigFile(configPath, value)
    assert.equal(statSync(configPath).mode & 0o777, 0o600, 'config.json 必须 0600')
    assert.deepEqual(readConfigFile(configPath), value)
    assert.deepEqual(readdirSync(root), ['config.json'], '原子写不得留下临时文件')

    // 覆写：整份替换、权限不因替换而放宽、依旧不留残留
    writeConfigFile(configPath, { version: 1, feeds: {} })
    assert.equal(statSync(configPath).mode & 0o777, 0o600)
    const reread = readConfigFile(configPath)
    assert.deepEqual(reread.feeds, {})
    assert.equal(reread.version, 1)
    assert.equal(reread.viewPreferences, undefined)
    assert.deepEqual(readdirSync(root), ['config.json'])
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('readConfigFile 对损坏/形状不对/版本不认的 config.json 一律抛错，不返回空订阅', () => {
  const base = tempDir('corrupt')
  const configPath = join(base, 'config.json')
  try {
    const cases = [
      ['截断的 JSON', '{ "version": 1, "feeds": {'],
      ['根不是对象', '[]'],
      ['feeds 不是映射（而是 URL 列表）', JSON.stringify({ version: 1, feeds: ['https://a.example/feed.xml'] })],
      ['缺 feeds（我们自己写的文件必然有它）', JSON.stringify({ version: 1 })],
      ['某条记录不是对象', JSON.stringify({ version: 1, feeds: { 'https://a.example/feed.xml': 'https://a.example/feed.xml' } })],
      ['未来版本（不许硬按 v1 读）', JSON.stringify({ version: 2, feeds: {} })],
    ]
    for (const [label, text] of cases) {
      writeFileSync(configPath, text)
      assert.throws(
        () => readConfigFile(configPath),
        (error) => error.message.includes(configPath),
        label + '：必须抛错并带上路径，静默返回空订阅在用户眼里就是「订阅全没了」',
      )
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('readConfigFile 只把 ENOENT 当「从未写过」；路径是个目录同样必须抛错', () => {
  const base = tempDir('eisdir')
  try {
    // 「读不到」不等于「没有」：只有 ENOENT 才是新装。把 EISDIR 也当空订阅，
    // 会让一次路径写错表现为「订阅全没了」，而实际文件还在原地。
    mkdirSync(join(base, 'a-directory'))
    assert.throws(
      () => readConfigFile(join(base, 'a-directory')),
      (error) => error.message.includes(join(base, 'a-directory')),
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('readConfigFile 对从未写过的文件返回空订阅（首次安装，不是「订阅丢了」）', () => {
  const base = tempDir('fresh')
  try {
    const config = readConfigFile(join(base, 'config.json'))
    assert.deepEqual(config.feeds, {})
    assert.equal(config.version, 1)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
