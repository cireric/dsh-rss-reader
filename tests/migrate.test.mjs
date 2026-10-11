/**
 * 一次性迁移（Task 4）的行为钉子。
 *
 * 迁移是这次改造的**单向门**：跑完之后插件只认自持存储，而老文件是用户订阅在
 * config.json 之外的唯一副本。所以这里钉的不是「函数返回了什么」，而是四条不能破的保证：
 *
 * ① **认不出就响亮失败，绝不回落成空库**（Review Focus 1）：损坏 / 读不出来 / 别的插件的域文件
 *    一律抛错，且**老文件与库都保持原样**。「返回空订阅」在用户眼里就是「我的订阅全没了」。
 * ② **重入幂等**（Review Focus 3）：中断后重来不产生重复行，也不把整份老文件重放一遍
 *    （清理端点会把已读旧条目删成 0 行，只按 items 判会复活用户删掉的条目）。
 * ③ **老正文形态必须先折成 blocks**：库里没有存 paragraphs 的列，直接搬进去会被 store-sqlite
 *    当场拒绝；而「拒绝」是刻意的好行为 —— 静默丢掉正文才是坏事（brief 定稿加固 ①）。
 * ④ **老文件只读**：全程只 readFileSync，字节级不变（Global Constraints；备份脚本读的就是它）。
 *
 * 计数断言（feeds/items/cursors）之外，读回一律走 createSqliteStore：迁移「写对了」的判据是
 * **换新实现读得回同一份**，而不是它自己报了几行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrateSchema } from '../lib/storage/db.js'
import { readConfigFile, writeConfigFile } from '../lib/storage/config-file.js'
import { migrateFromDomainFile } from '../lib/storage/migrate.js'
import { createSqliteStore } from '../lib/store-sqlite.js'

const FEED_A = 'https://a.example/feed.xml'
const FEED_B = 'https://b.example/feed.xml'

/** 手工构造的小域文件：形状与存储域 single layout 的真实产物逐字段同形。 */
function domainContent(overrides = {}) {
  return {
    unit: { name: 'rss_reader', version: 1 },
    global: { navSelection: { kind: 'feed', feedId: FEED_A }, filter: 'unread', navVisible: false },
    tables: {
      feeds: {
        [FEED_A]: {
          url: FEED_A, title: '源 A', folder: '技术', etag: 'W/"7f-1"',
          lastModified: 'Wed, 08 Oct 2026 10:00:00 GMT', lastFetchedAt: '2026-10-11T09:00:00.000Z',
          contentRevision: 2, lastFailure: 'HTTP 500',
        },
        [FEED_B]: { url: FEED_B },
      },
      items: {
        // 用户状态齐全的一条：迁移后这些字段一个都不许丢
        'i-1': {
          feedId: FEED_A, title: '一', link: 'https://a.example/1',
          publishedAt: '2026-10-11T08:00:00.000Z', fetchedAt: '2026-10-11T09:00:00.000Z',
          readAt: '2026-10-11T10:00:00.000Z', starred: true, keptUnread: true, summary: '摘要',
        },
        // 新形态正文
        'i-2': {
          feedId: FEED_A, title: '二', link: 'https://a.example/2', fetchedAt: '2026-10-11T07:00:00.000Z',
          starred: false,
          article: { fetchedAt: '2026-10-11T09:30:00.000Z', revision: 2, title: '正文标题', frameable: true, blocks: [{ kind: 'p', text: '新形态' }] },
        },
        // **老形态**：只有 paragraphs、没有 blocks —— 迁移必须先过 normalizeLegacyArticle
        'i-3': {
          feedId: FEED_B, title: '三', link: 'https://b.example/1', fetchedAt: '2026-10-11T06:00:00.000Z',
          starred: false,
          article: { fetchedAt: '2026-10-11T06:30:00.000Z', paragraphs: ['第一段', '第二段'] },
        },
      },
      cursors: {
        [FEED_A]: { seen: ['i-1', 'i-2'], cursorAt: '2026-10-11T09:00:00.000Z' },
      },
    },
    ...overrides,
  }
}

/** 一个用例一套：内存库 + 临时目录里的老文件与 config.json 落点。 */
function harness(tag) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-migrate-' + tag + '-'))
  const db = openDatabase(':memory:')
  migrateSchema(db)
  const logs = []
  const domainPath = join(dir, 'rss_reader.json')
  const configPath = join(dir, 'config.json')
  return {
    dir, db, domainPath, configPath, logs,
    migrate: (override = {}) => migrateFromDomainFile({ domainPath, db, configPath, log: (message) => logs.push(message), ...override }),
    writeDomain: (content) => writeFileSync(domainPath, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n'),
    count: (table) => db.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n,
    store: () => createSqliteStore(db, configPath),
    config: () => JSON.parse(readFileSync(configPath, 'utf8')),
    cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

const CONFIG_FIELDS = { version: 1, feeds: Object.keys(domainContent().tables.feeds).length }

test('从域文件导入 feeds/items/cursors，并写出 config.json；老文件字节级不变', async () => {
  const h = harness('import')
  try {
    h.writeDomain(domainContent())
    const before = readFileSync(h.domainPath)

    const result = await h.migrate()
    assert.deepEqual(result, { feeds: 2, items: 3, cursors: 1, skipped: false })

    const store = h.store()
    // 订阅记录逐字段（etag / lastModified / contentRevision 丢了就是「迁移后第一轮全量重抓」）
    assert.deepEqual(store.feed(FEED_A), domainContent().tables.feeds[FEED_A])
    assert.deepEqual(store.feed(FEED_B), { url: FEED_B })
    assert.deepEqual(store.listFeeds().map(([id]) => id), [FEED_A, FEED_B], '键序就是订阅的自然顺序')

    // 条目：用户状态、摘要、正文逐字段读得回
    assert.deepEqual(store.item('i-1'), domainContent().tables.items['i-1'])
    assert.deepEqual(store.item('i-2').article, { fetchedAt: '2026-10-11T09:30:00.000Z', revision: 2, title: '正文标题', frameable: true, blocks: [{ kind: 'p', text: '新形态' }] })

    // 老正文形态：库里必须是 blocks，不许有 paragraphs（判据见文件头 ③）
    const legacy = store.item('i-3')
    assert.deepEqual(legacy.article.blocks, [{ kind: 'p', text: '第一段' }, { kind: 'p', text: '第二段' }], 'paragraphs 必须折成段落块')
    assert.equal(Object.hasOwn(legacy.article, 'paragraphs'), false, '老字段不许原样冻进库')
    assert.equal(h.count('texts'), 2, '只有带 article 的两条（i-2 新形态 / i-3 老形态）落正文行')
    assert.equal(h.db.prepare("SELECT COUNT(*) AS n FROM texts WHERE body LIKE '%paragraphs%'").get().n, 0)

    // 游标（去重窗口）不能丢：丢了下一轮会把整份 feed 当新内容重新导入成未读
    assert.deepEqual(store.cursor(FEED_A), { seen: ['i-1', 'i-2'], cursorAt: '2026-10-11T09:00:00.000Z' })

    // config.json 的另一半：订阅映射（完整记录）与视图偏好
    const config = readConfigFile(h.configPath)
    assert.equal(config.version, CONFIG_FIELDS.version)
    assert.deepEqual(Object.keys(config.feeds), [FEED_A, FEED_B])
    assert.deepEqual(config.feeds[FEED_A], domainContent().tables.feeds[FEED_A])
    assert.deepEqual(config.viewPreferences, domainContent().global)
    assert.deepEqual(store.viewPreferences(), domainContent().global, '迁移过来的视图记忆读得回同一份')

    // ★ 老文件只读：字节级不变（备份脚本读的就是这个路径）
    assert.deepEqual(readFileSync(h.domainPath), before, '迁移不许改写老文件')
  } finally { h.cleanup() }
})

test('重复运行幂等：第二次 skipped:true，行数与 config.json 都不变（不产生重复行）', async () => {
  const h = harness('twice')
  try {
    h.writeDomain(domainContent())
    assert.equal((await h.migrate()).skipped, false)
    const rows = { items: h.count('items'), texts: h.count('texts'), cursors: h.count('cursors') }
    const config = readFileSync(h.configPath)

    const second = await h.migrate()
    assert.deepEqual(second, { feeds: 0, items: 0, cursors: 0, skipped: true })
    assert.deepEqual({ items: h.count('items'), texts: h.count('texts'), cursors: h.count('cursors') }, rows, '行数必须原地不动')
    assert.equal(h.count('items'), 3)
    assert.deepEqual(readFileSync(h.configPath), config, '已经落地的那一份不许被重写')
  } finally { h.cleanup() }
})

test('已迁移之后老文件损坏/消失都不影响装载（幂等闸在「读文件」之前）', async () => {
  const h = harness('fast-path')
  try {
    h.writeDomain(domainContent())
    await h.migrate()
    // 迁移完成之后老文件怎么坏都不该让插件起不来 —— 它已经不再被读了
    h.writeDomain('{ 这不是 JSON')
    const again = await h.migrate()
    assert.deepEqual(again, { feeds: 0, items: 0, cursors: 0, skipped: true })
    assert.equal(h.count('items'), 3)
  } finally { h.cleanup() }
})

test('中断后重入：库里有条目而 config.json 缺失 ⇒ 只补配置，不重放条目（无重复行）', async () => {
  const h = harness('interrupted')
  try {
    h.writeDomain(domainContent())
    await h.migrate()
    // 模拟「库那份提交了、配置那份还没写」就中断：删掉 config.json，其余保持
    rmSync(h.configPath)

    const repaired = await h.migrate()
    assert.equal(repaired.skipped, true, '条目已经在库里，不算重新导入')
    assert.equal(repaired.items, 0)
    assert.deepEqual(Object.keys(h.config().feeds), [FEED_A, FEED_B], '订阅映射必须补回来 —— 否则界面上「订阅全没了」')
    assert.deepEqual(h.config().viewPreferences, domainContent().global)
    assert.equal(h.count('items'), 3, '条目不许被重放成重复行')
    assert.equal(h.count('cursors'), 1)
  } finally { h.cleanup() }
})

test('config.json 已在而条目被清理成 0 行 ⇒ 不重放：用户退订的源与删掉的条目不复活', async () => {
  const h = harness('no-resurrect')
  try {
    // 迁移完成过，之后用户退订了 B、清理端点把条目删干净 —— config.json 只留下 A
    writeConfigFile(h.configPath, { version: 1, feeds: { [FEED_A]: { url: FEED_A } }, viewPreferences: { navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true } })
    h.writeDomain(domainContent())

    const result = await h.migrate()
    assert.deepEqual(result, { feeds: 0, items: 0, cursors: 0, skipped: true })
    assert.equal(h.count('items'), 0, '清理掉的条目不许被老文件复活成未读')
    assert.deepEqual(Object.keys(h.config().feeds), [FEED_A], '退订的源不许复活')
  } finally { h.cleanup() }
})

test('config.json 写不进去时：库那份已经落地、老文件未动；补好之后重入只补配置', async () => {
  const h = harness('config-write-fail')
  try {
    h.writeDomain(domainContent())
    const before = readFileSync(h.domainPath)
    // 父目录不存在 ⇒ writeConfigFile 的 openSync(tmp,'wx') 必然失败（真实的「磁盘满 / 目录被删」形态）
    const blocked = join(h.dir, 'no-such-dir', 'config.json')

    await assert.rejects(
      () => h.migrate({ configPath: blocked }),
      '配置写不进去必须抛错：静默吞掉它，用户会得到一份「有数据但订阅列表是空的」库',
    )

    // ★ 顺序判据（与 store-sqlite 的 deleteFeed 同一类）：**先库后 config**，否则这一次失败会
    // 把已经做完的迁移整份丢掉，用户重试时白等一遍几万行的导入。
    // 反过来（config 先写）时这里会读到 0 行 —— 那才是「有订阅没数据」的形态。
    assert.equal(h.count('items'), 3, '库那份必须已经提交（先库）')
    assert.equal(h.count('cursors'), 1)
    assert.equal(existsSync(blocked), false, '配置没写成就不能有半份文件')
    assert.deepEqual(readFileSync(h.domainPath), before, '失败路径同样不许动老文件')

    // 重入：目录补好之后只补配置，不重放条目（闸门二）
    mkdirSync(join(h.dir, 'no-such-dir'))
    const repaired = await h.migrate({ configPath: blocked })
    assert.equal(repaired.skipped, true)
    assert.equal(h.count('items'), 3, '不许产生重复行')
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(blocked, 'utf8')).feeds), [FEED_A, FEED_B])
  } finally { h.cleanup() }
})

test('域文件不存在 ⇒ skipped:true，不建空库也不抛错（首次安装路径）', async () => {
  const h = harness('first-install')
  try {
    const result = await h.migrate()
    assert.deepEqual(result, { feeds: 0, items: 0, cursors: 0, skipped: true })
    assert.equal(h.count('items'), 0)
    assert.equal(h.count('cursors'), 0)
    assert.equal(existsSync(h.configPath), false, '没有可迁移的数据时不许写一份空订阅 —— 那会把「首次安装」与「迁完了但没源」搅成一件事')
    assert.ok(h.logs.some((message) => message.includes('跳过')), '走了首装路径要留痕（禁止静默）')
  } finally { h.cleanup() }
})

test('域文件损坏 ⇒ 抛错，老文件与库都保持原样（Review Focus 1）', async () => {
  const h = harness('corrupt')
  try {
    h.writeDomain('{ "unit": { "name": "rss_reader", "version": 1 }, "tables": { "feeds": {')
    const before = readFileSync(h.domainPath)

    await assert.rejects(
      () => h.migrate(),
      (error) => {
        assert.match(error.message, /rss_reader\.json/, '消息必须带路径，否则用户不知道去修哪份文件')
        return true
      },
      '损坏的域文件必须响亮失败，绝不许当成「没有订阅」',
    )
    assert.deepEqual(readFileSync(h.domainPath), before, '拒绝时不许动老文件')
    assert.equal(h.count('items'), 0)
    assert.equal(h.count('cursors'), 0)
    assert.equal(existsSync(h.configPath), false, '失败时不许留下半份 config.json')
  } finally { h.cleanup() }
})

test('域文件读不出来（路径是目录）⇒ 抛错，不回落成「首次安装」', async () => {
  const h = harness('unreadable')
  try {
    // EISDIR / EACCES / 越过 512 MiB 墙（spec §8）走的都是同一条：读不出来就是读不出来，
    // 把它当成「没有老文件」会静默建出一个空库 —— 用户看到的是订阅全没了
    mkdirSync(h.domainPath)
    await assert.rejects(
      () => h.migrate(),
      (error) => {
        assert.match(error.message, /rss_reader\.json/)
        return true
      },
    )
    assert.equal(h.count('items'), 0)
    assert.equal(existsSync(h.configPath), false)
  } finally { h.cleanup() }
})

test('域文件不是本插件的（unit.name 不匹配）⇒ 抛错，不误导入别人的数据', async () => {
  const h = harness('foreign')
  try {
    h.writeDomain(domainContent({ unit: { name: 'session_projcache', version: 1 } }))
    await assert.rejects(
      () => h.migrate(),
      (error) => {
        assert.match(error.message, /session_projcache/, '消息要说清读到的是谁的名字')
        return true
      },
      '别人的域文件形状完全不同，按本插件的形状解释它等于把别人的字段搬进来',
    )
    assert.equal(h.count('items'), 0)
    assert.equal(existsSync(h.configPath), false)
  } finally { h.cleanup() }
})

test('域版本不认识（unit.version ≠ 1）⇒ 抛错，不硬按 v1 解释', async () => {
  const h = harness('version')
  try {
    h.writeDomain(domainContent({ unit: { name: 'rss_reader', version: 2 } }))
    await assert.rejects(() => h.migrate(), (error) => {
      assert.match(error.message, /version/)
      return true
    })
    assert.equal(h.count('items'), 0)
  } finally { h.cleanup() }
})

test('global 为 null（域里「从未写过」的哨兵）⇒ config.json 不落 viewPreferences 键', async () => {
  const h = harness('null-global')
  try {
    h.writeDomain(domainContent({ global: null }))
    await h.migrate()
    const config = h.config()
    assert.equal(Object.hasOwn(config, 'viewPreferences'), false, 'null 是「没写过」，不是一份偏好')
    assert.deepEqual(h.store().viewPreferences().filter, 'all', '读侧照常回落到默认值')
  } finally { h.cleanup() }
})
