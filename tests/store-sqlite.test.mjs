/**
 * SQLite 版 ReaderStore（Task 3）的行为钉子。
 *
 * 这些断言钉的是「这份存储能不能顶替旧实现」，不是实现细节：
 * - 列表取数必须**把源条件交给 SQL**（spec §3.1 的扫描族修复）。旧实现是「遍历整表再过滤」，
 *   200 源 × 10 万行下每轮刷新 3 × 源数次全表扫描。行为层看不出差别，所以这里钉 prepared SQL 的
 *   形状 —— 用时延或计数都不可靠（一个把全表读回来再过滤的实现同样「快」）。
 * - 缺 publishedAt 的条目必须按 fetchedAt 归位（Review Focus 2）。直接对 published_at 排序会让
 *   它落进 SQL 的 NULL 段（SQLite 中 NULL 最小），列表顺序与迁移前不一致，且**没有任何断言会翻红**。
 * - updateItem 必须是**原子读改写**，fn 看到的是库里的当前值（Review Focus 4）。本仓库为
 *   「先取快照 → await 网络 → 整体写回」付过三次学费（src/store.ts:21-31 的注释）。
 * - 可选字段缺席时必须是**键缺席**，不是 null / undefined 值的键：记录形状由 .strict() 的 zod
 *   管着，而 readAt === undefined 是「未读」的唯一定义（src/shared.ts:62）。
 *
 * 每条读回的记录都再过一遍 itemRecordSchema —— strict 会把「多带了一列」（feed_id / recency）
 * 当场判死，比逐个字段断言更难骗过。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrateSchema, SCHEMA_VERSION } from '../lib/storage/db.js'
import { writeConfigFile } from '../lib/storage/config-file.js'
import { createSqliteStore } from '../lib/store-sqlite.js'
import { feedRecordSchema, itemRecordSchema } from '../lib/domain.js'
import { articleCharsOf, selectCleanup } from '../lib/retention.js'
import { countUnreadPerFeed, recencyOf } from '../lib/shared.js'

const tempDir = (tag) => mkdtempSync(join(tmpdir(), 'rss-store-' + tag + '-'))

/** 每个用例一个全新的内存库 + 一个临时 config.json 落点。 */
function freshStore(tag) {
  const dir = tempDir(tag)
  const db = openDatabase(':memory:')
  migrateSchema(db)
  return { store: createSqliteStore(db, join(dir, 'config.json')), db, configPath: join(dir, 'config.json'), dir }
}

/** 断言读回来的记录合 ItemRecord（strict）——多带一列就会在这里翻红。 */
function assertItem(record, label) {
  const parsed = itemRecordSchema.safeParse(record)
  assert.equal(
    parsed.success,
    true,
    label + ' 必须合 ItemRecord（strict）：' + (parsed.success ? '' : parsed.error.message),
  )
  return record
}

/** 造一条最小可用条目。省略的可选字段**不进对象** —— 这就是「缺席」的形状。 */
const item = (feedId, overrides = {}) => ({
  feedId,
  title: '标题',
  link: 'https://site.example/post/1',
  fetchedAt: '2026-10-11T10:00:00.000Z',
  starred: false,
  ...overrides,
})

test('建 store 先做版本握手：没盖章的库当场响亮失败，不许等第一次写入才发现（顺序颠倒）', () => {
  const dir = tempDir('noschema')
  try {
    const db = openDatabase(':memory:') // 刻意不 migrateSchema
    assert.throws(
      () => createSqliteStore(db, join(dir, 'config.json')),
      (error) => error.message.includes(String(SCHEMA_VERSION)),
      '未建表的库上必须报出期望的版本号；否则「忘调 migrateSchema」会一路延迟到第一次写入才炸',
    )
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listItems 只返回该源的条目，且源条件是真的写在 SQL 里（spec §3.1 的扫描族修复）', async () => {
  const { store, db, dir } = freshStore('listitems')
  try {
    for (const key of ['a-0', 'a-1']) await store.saveItem(key, item('feed-a'))
    for (const key of ['b-0', 'b-1']) await store.saveItem(key, item('feed-b'))

    // 语句是**首次使用时**才 prepare 的，所以在这里包一层就能录到读路径的真实 SQL。
    // 若实现改成「构造时预编译」，本条会因 captured 为空而翻红 —— 那是刻意的：
    // 预编译会让「读路径到底是什么 SQL」变成不可观测的东西。
    const captured = []
    const realPrepare = db.prepare.bind(db)
    db.prepare = (sql) => { captured.push(sql); return realPrepare(sql) }
    try {
      const a = store.listItems('feed-a')
      const b = store.listItems('feed-b')
      assert.deepEqual(a.map(([id]) => id).sort(), ['a-0', 'a-1'], '必须只返该源的条目')
      assert.deepEqual(b.map(([id]) => id).sort(), ['b-0', 'b-1'])
      store.allItems()
      store.item('a-0')
    } finally {
      delete db.prepare
    }

    const reads = captured.filter((sql) => /FROM items/i.test(sql))
    assert.ok(reads.length >= 3, '三种读路径都该有自己的语句，实际录到：' + JSON.stringify(reads))
    for (const sql of reads.filter((s) => s.includes('feed_id = ?'))) {
      assert.match(sql, /ORDER BY[\s\S]*recency DESC[\s\S]*id ASC/, '每源列表必须走同一套排序键：' + sql)
    }
    assert.ok(
      reads.some((sql) => /WHERE\s+i?\.?feed_id\s*=\s*\?/.test(sql)),
      'listItems 必须是 WHERE feed_id = ?；在 JS 里过滤等于把扫描族原样留下（spec §3.1）。实际录到：' + JSON.stringify(reads),
    )
    assert.ok(
      reads.some((sql) => /WHERE\s+i?\.?id\s*=\s*\?/.test(sql)),
      'item() 必须按键定位：' + JSON.stringify(reads),
    )
    assert.ok(
      reads.some((sql) => !/WHERE/.test(sql)),
      'allItems() 是唯一允许无条件读整表的那一个：' + JSON.stringify(reads),
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('allItems / listItems 按 recency 降序 + id 升序；缺 publishedAt 的行按 fetchedAt 归位（Review Focus 2）', async () => {
  const { store, db, dir } = freshStore('order')
  try {
    // 刻意纠缠：no-pub 的 recency 必须等于它的 fetchedAt，落在这两条 published 之间
    await store.saveItem('mid', item('f1', { publishedAt: '2026-10-01T00:00:00.000Z' }))
    await store.saveItem('no-pub', item('f1', { fetchedAt: '2026-10-05T00:00:00.000Z' }))
    await store.saveItem('new', item('f1', { publishedAt: '2026-10-09T00:00:00.000Z' }))
    await store.saveItem('tie-b', item('f2', { publishedAt: '2026-10-09T00:00:00.000Z' }))
    await store.saveItem('tie-a', item('f2', { publishedAt: '2026-10-09T00:00:00.000Z' }))
    await store.saveItem('old', item('f2', { publishedAt: '2026-09-01T00:00:00.000Z' }))

    assert.deepEqual(
      store.allItems().map(([id]) => id),
      ['new', 'tie-a', 'tie-b', 'no-pub', 'mid', 'old'],
      '排序必须是 recency = publishedAt ?? fetchedAt 降序、同 recency 内 id 升序（src/endpoints.ts:80-83）',
    )
    assert.deepEqual(store.listItems('f2').map(([id]) => id), ['tie-a', 'tie-b', 'old'], '每源列表走同一套排序键')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unreadPerFeed：与 shared.ts 的唯一口径在同一夹具上逐键相等，且键域 = 传入的 feeds 表（Ruling P-6）', async () => {
  const { store, db, dir } = freshStore('unread-per-feed')
  try {
    // A：2 未读 / 1 已读；B 全部已读（0 未读 ⇒ 键必须在、值为 0）；
    // X 是**已退订**的残留源（不传进 feedIds ⇒ 不许出现在账目里）
    await store.saveItem('a-1', item('feed-a'))
    await store.saveItem('a-2', item('feed-a'))
    await store.saveItem('a-3', item('feed-a', { readAt: '2026-10-11T12:00:00.000Z' }))
    await store.saveItem('b-1', item('feed-b', { readAt: '2026-10-11T12:00:00.000Z' }))
    await store.saveItem('x-1', item('feed-x'))

    const feedIds = ['feed-a', 'feed-b']
    const fromSql = store.unreadPerFeed(feedIds)
    // ★ 唯一口径对账：SQL 里的 read_at IS NULL 必须与 shared.ts 的 isUnread 得出同一个答案。
    // 这条不变式在本仓库漂过两次（键域、unread 口径各一次），且每次都表现为「两个数各自自洽、
    // 合起来对不上」——只有在同一夹具上逐键对账才看得见。
    assert.deepEqual(
      fromSql,
      countUnreadPerFeed(feedIds, store.allItems().map(([, record]) => record)),
      'SQL 账目必须与 shared.ts 的 countUnreadPerFeed 逐键相等（不许另立一份口径）',
    )
    assert.deepEqual(fromSql, { 'feed-a': 2, 'feed-b': 0 },
      '0 未读的源必须留键（值为 0）——缺键在左栏表现为「角标空白」而不是「角标 0」')
    assert.equal(Object.prototype.hasOwnProperty.call(fromSql, 'feed-x'), false,
      '已退订源的残留条目不许进账（键域严格 = 传进来的 feeds 表）')
    assert.deepEqual(store.unreadPerFeed([]), {}, '空键域 ⇒ 空账目，而不是「全表所有源」')
    assert.deepEqual(store.unreadPerFeed(['feed-b']), { 'feed-b': 0 }, '只传一个全已读的源，键也必须在')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listRecent：按 recency 降序 + id 升序取前 N 条，与 allItems 的前缀逐字相等（语义不变）', async () => {
  const { store, db, dir } = freshStore('list-recent')
  try {
    // 与 allItems 那条同样的纠缠夹具：缺 publishedAt 的行必须按 fetchedAt 归位（Review Focus 2）
    await store.saveItem('mid', item('f1', { publishedAt: '2026-10-01T00:00:00.000Z' }))
    await store.saveItem('no-pub', item('f1', { fetchedAt: '2026-10-05T00:00:00.000Z' }))
    await store.saveItem('new', item('f1', { publishedAt: '2026-10-09T00:00:00.000Z' }))
    await store.saveItem('tie-b', item('f2', { publishedAt: '2026-10-09T00:00:00.000Z' }))
    await store.saveItem('tie-a', item('f2', { publishedAt: '2026-10-09T00:00:00.000Z' }))
    await store.saveItem('old', item('f2', { publishedAt: '2026-09-01T00:00:00.000Z' }))

    const all = store.allItems()
    assert.deepEqual(store.listRecent(3).map(([id]) => id), ['new', 'tie-a', 'tie-b'],
      '新的列表取数必须与「全表排序后截断」逐条相同（改的是取数方式，不是语义）')
    assert.deepEqual(store.listRecent(2).map(([id]) => id), all.slice(0, 2).map(([id]) => id),
      'limit 取的是**前缀**：不许因为走了索引就换了相对顺序')
    assert.deepEqual(store.listRecent(100).map(([id]) => id), all.map(([id]) => id), 'limit 超过总量 ⇒ 与 allItems 全等')
    assert.deepEqual(store.listRecent(0), [], 'limit 0 ⇒ 空列表')
    assert.deepEqual(store.listRecent(-1), [], '负数上限 ⇒ 空列表，而不是 SQLite 的「无上限」（那等于把整表读回来）')
    assertItem(store.listRecent(1)[0][1], 'listRecent 的记录')
    assert.deepEqual(store.listRecent(1)[0][1], store.item('new'), '同一套读路径：记录形状必须与 item() 逐字段相同')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listCleanupCandidates：候选集由 SQL 选出，且与 selectCleanup 的判据对得上（唯一口径不漂）', async () => {
  const { store, db, dir } = freshStore('cleanup-candidates')
  try {
    const read = '2026-10-11T12:00:00.000Z'
    await store.saveItem('old-read', item('f1', { publishedAt: '2026-01-01T00:00:00.000Z', readAt: read }))
    await store.saveItem('old-unread', item('f1', { publishedAt: '2026-01-01T00:00:00.000Z' }))
    await store.saveItem('old-starred', item('f1', { publishedAt: '2026-01-01T00:00:00.000Z', readAt: read, starred: true }))
    await store.saveItem('old-kept', item('f1', { publishedAt: '2026-01-01T00:00:00.000Z', readAt: read, keptUnread: true }))
    await store.saveItem('recent-read', item('f1', { publishedAt: '2026-10-11T00:00:00.000Z', readAt: read }))
    const cutoff = '2026-06-01T00:00:00.000Z'

    const candidates = store.listCleanupCandidates(cutoff)
    assert.deepEqual(candidates.map((row) => row.id), ['old-read'],
      '候选 = 已读 + 未星标 + 未保持未读 + 早于阈值（read_at IS NOT NULL AND starred = 0 AND kept_unread = 0 AND recency < ?）')
    // 候选行必须自带判据字段（供调用方复跑 selectCleanup）与释放量原料（免得为每条候选再点读一次）
    assert.deepEqual(
      Object.keys(candidates[0]).sort(),
      ['articleChars', 'id', 'kept', 'read', 'recency', 'starred', 'summaryChars'],
      '候选行要把判据字段与释放量原料一次带齐',
    )
    assert.deepEqual(store.listCleanupCandidates('1970-01-01T00:00:00.000Z'), [],
      '阈值之前没有候选 ⇒ 空集（不是「全表」）')

    // 释放量原料里的 articleChars 是**第二处**实现（库里存的是 texts.body 的 JSON 文本，
    // 而 retention.ts 的 articleCharsOf 吃的是解析后的 articleRecord），两处口径必须对账 ——
    // 不对账的话「释放约 X KB」会悄悄与实际不符（客户端直接显示这个数）。
    await store.saveItem('old-with-body', item('f1', {
      publishedAt: '2026-01-01T00:00:00.000Z',
      readAt: read,
      summary: '摘要摘',
      article: {
        fetchedAt: read,
        blocks: [{ kind: 'p', text: '正文正文正' }, { kind: 'list', items: ['一', '二二'] }],
      },
    }))
    const withBody = store.listCleanupCandidates(cutoff).find((row) => row.id === 'old-with-body')
    assert.equal(withBody.articleChars, articleCharsOf(store.item('old-with-body').article),
      '正文缓存的字符数必须与 retention.ts 的 articleCharsOf 同口径（两处实现要对得上）')
    assert.equal(withBody.articleChars, 5 + 3, 'blocks 里 text 与 items 的字符数都要算进去')
    assert.equal(withBody.summaryChars, 3, '摘要同样占字节，释放量要如实算进去')

    // 与唯一口径对账：候选集是 selectCleanup 判据的**子集**（宁可保守，不许比判据更宽），
    // 且被它排除的那批并回来正好等于判据的集合（不许比判据更窄）。
    const rows = store.allItems().map(([id, record]) => ({
      id,
      starred: record.starred,
      kept: record.keptUnread === true,
      read: record.readAt !== undefined,
      recency: recencyOf(record),
      articleChars: 0,
    }))
    const doomed = selectCleanup(rows, cutoff).sort()
    assert.deepEqual(
      doomed.filter((id) => id !== 'old-kept'),
      store.listCleanupCandidates(cutoff).map((row) => row.id).sort(),
      '除「保持未读」外，候选集必须与 selectCleanup 的集合逐字相等',
    )
    assert.ok(doomed.includes('old-kept'),
      'selectCleanup 单独算会把「已读 + 保持未读」也算进去 —— SQL 谓词多守的一条正是这里（见谓词的 kept_unread = 0）')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listRecent / unreadPerFeed / listCleanupCandidates 的排序、聚合与筛选真的写在 SQL 里（扫描族归零）', async () => {
  const { store, db, dir } = freshStore('scan-removal')
  try {
    await store.saveItem('a-1', item('feed-a', { publishedAt: '2026-10-01T00:00:00.000Z' }))
    await store.saveItem('b-1', item('feed-b'))

    // 语句是**首次使用时**才 prepare 的（刻意懒编译），所以包一层就能录到这三条读路径的真实 SQL。
    // 行为层看不出「排序/聚合/筛选到底在哪一侧做」——只有 SQL 形状能钉住（spec §3.1 的扫描族归零）。
    const captured = []
    const realPrepare = db.prepare.bind(db)
    db.prepare = (text) => { captured.push(text); return realPrepare(text) }
    let reads
    try {
      store.listRecent(1)
      store.unreadPerFeed(['feed-a', 'feed-b'])
      store.listCleanupCandidates('2026-06-01T00:00:00.000Z')
      reads = captured.filter((text) => /FROM items/i.test(text))
    } finally {
      delete db.prepare
    }

    assert.ok(
      reads.some((text) => /ORDER BY[\s\S]*recency DESC[\s\S]*id ASC/.test(text) && /LIMIT \?/.test(text)),
      'listRecent 必须把排序键与上限交给 SQL：' + JSON.stringify(reads),
    )
    assert.ok(
      reads.some((text) => /GROUP BY\s+i?\.?feed_id/.test(text) && /read_at IS NULL/.test(text)),
      'unreadPerFeed 必须是 SQL 侧聚合，且未读判据是 read_at IS NULL（与 isUnread 同口径）：' + JSON.stringify(reads),
    )
    assert.ok(
      reads.some((text) => /read_at IS NOT NULL/.test(text) && /starred = 0/.test(text)
        && /kept_unread = 0/.test(text) && /recency < \?/.test(text)),
      '清理候选必须是 SQL 侧筛选（否则「点一次清理 = 一次全表遍历」原样留下）：' + JSON.stringify(reads),
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('item 把 texts 的正文按 blocks 还原；没有正文时 article 键缺席', async () => {
  const { store, db, dir } = freshStore('item')
  try {
    const blocks = [{ kind: 'p', text: '第一段' }, { kind: 'img', src: 'https://x/y.png' }]
    await store.saveItem('with-article', item('f1', {
      article: { fetchedAt: '2026-10-11T11:00:00.000Z', revision: 2, title: '正文标题', frameable: true, blocks },
    }))
    await store.saveItem('bare', item('f1'))

    // body 是 blocks 的 JSON 文本（另外三列各存一个字段）—— 库里能直接看出结构
    const stored = JSON.parse(db.prepare('SELECT body FROM texts WHERE item_id = ?').get('with-article').body)
    assert.deepEqual(stored, blocks)

    assert.deepEqual(
      assertItem(store.item('with-article'), '带正文的条目').article,
      { fetchedAt: '2026-10-11T11:00:00.000Z', revision: 2, title: '正文标题', frameable: true, blocks },
      '读回来必须逐字段等于写进去的 articleRecord',
    )
    const bare = assertItem(store.item('bare'), '无正文的条目')
    assert.equal(Object.hasOwn(bare, 'article'), false, '没有正文时 article 必须是键缺席（.strict() 不许 undefined 键）')
    assert.equal(store.item('missing'), undefined, '不存在的条目返回 undefined，不是抛错')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saveItem 覆盖整条；可选字段缺席时不留 null / undefined 键（.strict() 与 isUnread 都靠它）', async () => {
  const { store, db, dir } = freshStore('saveitem')
  try {
    await store.saveItem('i-1', item('f1', {
      publishedAt: '2026-10-01T00:00:00.000Z',
      summary: '摘要',
      readAt: '2026-10-11T12:00:00.000Z',
      keptUnread: true,
      starred: true,
      articleFailure: 'HTTP 500',
    }))
    const full = assertItem(store.item('i-1'), '整条')
    assert.deepEqual(Object.keys(full).sort(), [
      'articleFailure', 'feedId', 'fetchedAt', 'keptUnread', 'link', 'publishedAt', 'readAt', 'starred', 'summary', 'title',
    ].sort())
    assert.equal(full.keptUnread, true, 'keptUnread 是布尔，不许变成 1/0')

    // 整条覆盖：这一次只带必填字段，上面那些可选字段必须**连同键一起**消失
    await store.saveItem('i-1', item('f1'))
    const replaced = assertItem(store.item('i-1'), '覆盖后的条目')
    assert.deepEqual(
      Object.keys(replaced).sort(),
      ['feedId', 'fetchedAt', 'link', 'starred', 'title'],
      '缺席的可选字段不许留 null / undefined 值的键：readAt === undefined 是「未读」的唯一判据（src/shared.ts:62）',
    )
    assert.equal(replaced.readAt, undefined, '被覆盖掉的 readAt 必须真的回到 undefined')
    const row = db.prepare('SELECT published_at, summary, read_at, kept_unread, article_failure FROM items WHERE id = ?').get('i-1')
    assert.deepEqual({ ...row }, { published_at: null, summary: null, read_at: null, kept_unread: 0, article_failure: null })
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saveItem 覆盖已有条目时正文不被级联删掉（ON CONFLICT DO UPDATE，而不是 INSERT OR REPLACE）', async () => {
  const { store, db, dir } = freshStore('upsert')
  try {
    await store.saveItem('i-1', item('f1', { article: { fetchedAt: '2026-10-11T11:00:00.000Z', blocks: [{ kind: 'p', text: 'x' }] } }))
    // 重写同一条但不带正文 —— 正文属于本条，语义是「清掉正文」
    await store.saveItem('i-1', item('f1'))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM texts').get().n, 0, '不带正文的重写必须清掉正文行')

    // 再写回正文：这时 items 行**已存在**。INSERT OR REPLACE 会先删旧行，
    // 而 texts.item_id 上是 ON DELETE CASCADE —— 刚写的正文会被静默删掉，读回来只剩 items 行。
    await store.saveItem('i-1', item('f1', { article: { fetchedAt: '2026-10-11T13:00:00.000Z', blocks: [{ kind: 'p', text: 'y' }] } }))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM texts').get().n, 1, '重写已有条目时正文必须留下')
    assert.deepEqual(store.item('i-1').article.blocks, [{ kind: 'p', text: 'y' }])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('拒绝写入老形态正文（只有 paragraphs）：不许静默把正文丢掉（兼容读的保险，不再有正常调用方）', async () => {
  const { store, db, dir } = freshStore('legacy-article')
  try {
    // 库里没有存 paragraphs 的列。若「没有 blocks 就当作没有正文」，这条写入会成功落地，
    // 而用户在详情页看到的是正文凭空消失 —— 没有任何断言会翻红的那类失败。
    // 转换口径只有 domain.ts 的 normalizeLegacyArticle 一处。搬老形状进来的那次迁移已下线
    // （老域文件也从真机删了）⇒ 本用例守的是「写侧不许把老形状静默丢掉」这道保险本身。
    await store.saveItem('legacy', item('f1', {
      article: { fetchedAt: '2026-10-11T11:00:00.000Z', paragraphs: ['第一段', '第二段'] },
    })).then(
      () => assert.fail('老形态正文必须被拒绝，不能让正文静默消失'),
      (error) => assert.match(error.message, /legacy/, '拒绝的消息必须报出是哪个条目'),
    )
    assert.equal(store.item('legacy'), undefined, '被拒绝的写入不许留下半条记录')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM texts').get().n, 0)

    // 规范化成 blocks 之后就是合法输入（正常路径不受影响）
    await store.saveItem('legacy', item('f1', {
      article: { fetchedAt: '2026-10-11T11:00:00.000Z', blocks: [{ kind: 'p', text: '第一段' }] },
    }))
    assert.deepEqual(store.item('legacy').article.blocks, [{ kind: 'p', text: '第一段' }])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deleteItem 幂等，且正文不留孤儿', async () => {
  const { store, db, dir } = freshStore('delete')
  try {
    await store.saveItem('i-1', item('f1', { article: { fetchedAt: '2026-10-11T11:00:00.000Z', blocks: [] } }))
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM texts').get().n, 1)
    await store.deleteItem('i-1')
    assert.equal(store.item('i-1'), undefined)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM texts').get().n, 0, '正文必须随条目一起消失（不押在 pragma 默认值上，显式删两表）')
    await store.deleteItem('i-1') // 幂等：第二次不是错误
    assert.equal(store.item('i-1'), undefined)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updateItem 是原子读改写：窗口期内并发写进去的 readAt / 星标不被旧快照抹掉（Review Focus 4）', async () => {
  const { store, db, dir } = freshStore('update')
  try {
    const staleSnapshot = item('f1')
    await store.saveItem('i-1', staleSnapshot)
    // 窗口期内用户标了已读、加了星（这两件事发生在「刷新开始取快照」之后、「刷新写回」之前）
    await store.saveItem('i-1', { ...staleSnapshot, readAt: '2026-10-11T12:00:00.000Z', starred: true })

    let seenInSlot = null
    await store.updateItem('i-1', (current) => {
      seenInSlot = current
      return { ...current, summary: '新摘要' }
    })

    const after = assertItem(store.item('i-1'), '更新后的条目')
    assert.equal(seenInSlot.readAt, '2026-10-11T12:00:00.000Z', 'fn 看到的必须是**库里的当前值**，不是调用方手上的快照')
    assert.equal(after.readAt, '2026-10-11T12:00:00.000Z', 'readAt 被抹掉了 —— 这正是 2026-10-10 用户实测的「已读丢失」')
    assert.equal(after.starred, true, '星标同样不能被抹掉')
    assert.equal(after.summary, '新摘要')

    // 反向再来一次：本次改造必须让任意顺序的合并都收敛
    await store.saveItem('i-2', item('f1'))
    await store.updateItem('i-2', (current) => ({ ...current, summary: 's' }))
    await store.saveItem('i-2', { ...store.item('i-2'), readAt: '2026-10-11T13:00:00.000Z' })
    await store.updateItem('i-2', (current) => ({ ...current, starred: true }))
    assert.deepEqual(
      { summary: store.item('i-2').summary, readAt: store.item('i-2').readAt, starred: store.item('i-2').starred },
      { summary: 's', readAt: '2026-10-11T13:00:00.000Z', starred: true },
    )
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updateItem 对缺失键拒绝：写一次不等于创建（src/store.ts:29）', async () => {
  const { store, db, dir } = freshStore('update-missing')
  try {
    await assert.rejects(
      () => store.updateItem('never-existed', (current) => ({ ...current, starred: true })),
      (error) => {
        assert.match(error.message, /never-existed/, '拒绝的消息必须报出是哪个键，否则调用方无从排查')
        return true
      },
    )
    assert.equal(store.item('never-existed'), undefined, '被拒绝的更新不许顺手建出一条记录')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('updateItem 中途失败时整条回滚：行与正文都不留半截（禁止半写状态）', async () => {
  const { store, db, dir } = freshStore('update-rollback')
  try {
    await store.saveItem('i-1', item('f1', { readAt: '2026-10-11T12:00:00.000Z', summary: '旧摘要' }))
    // fn 返回的正文里塞一个循环引用：正文序列化在行更新**之后**、同一个事务里发生，
    // 所以这里验证的是「行也被一起收回」，不是「什么都没开始写」。
    const circular = { kind: 'p' }
    circular.self = circular
    await assert.rejects(
      () => store.updateItem('i-1', (current) => ({ ...current, summary: '新摘要', article: { fetchedAt: 'x', blocks: [circular] } })),
      '序列化失败必须抛出去（本仓库禁止空 catch），且不许把库留在半写状态',
    )
    const after = assertItem(store.item('i-1'), '回滚后的条目')
    assert.equal(after.summary, '旧摘要', '行更新必须被回滚')
    assert.equal(after.readAt, '2026-10-11T12:00:00.000Z', '用户状态必须原样还在')
    assert.equal(Object.hasOwn(after, 'article'), false)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM texts').get().n, 0, '回滚必须连正文行一起收回')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listFeeds / feed / saveFeed / deleteFeed 与旧实现同形（条件请求字段一个都不能丢）', async () => {
  const { store, db, dir } = freshStore('feeds')
  try {
    const record = {
      url: 'https://a.example/feed.xml',
      title: 'A',
      folder: '技术',
      etag: 'W/"7f-1"',
      lastModified: 'Wed, 08 Oct 2026 10:00:00 GMT',
      lastFetchedAt: '2026-10-11T09:00:00.000Z',
      contentRevision: 2,
      lastFailure: 'HTTP 500',
    }
    await store.saveFeed('https://a.example/feed.xml', record)
    await store.saveFeed('https://b.example/feed.xml', { url: 'https://b.example/feed.xml' })

    // 这几项丢了就是「迁移后第一轮全量重抓 + 摘要回填空转」，且没有任何断言会翻红
    assert.deepEqual(store.feed('https://a.example/feed.xml'), record)
    assert.equal(feedRecordSchema.safeParse(store.feed('https://a.example/feed.xml')).success, true)
    assert.equal(store.feed('https://c.example/feed.xml'), undefined)
    assert.deepEqual(
      store.listFeeds().map(([id]) => id),
      ['https://a.example/feed.xml', 'https://b.example/feed.xml'],
      'listFeeds 的键就是归一化后的 URL（src/store.ts:37）',
    )
    assert.equal(store.listFeeds().every(([, feed]) => feedRecordSchema.safeParse(feed).success), true)
    assert.deepEqual(Object.keys(store.feed('https://b.example/feed.xml')), ['url'], '只填了 url 的源，其余字段键缺席')

    // 退订：删源记录与它的游标；条目由调用方一并删（src/store.ts:16）
    await store.saveItem('i-1', item('https://a.example/feed.xml'))
    await store.saveCursor('https://a.example/feed.xml', { seen: ['i-1'], cursorAt: '2026-10-11T09:00:00.000Z' })
    await store.deleteFeed('https://a.example/feed.xml')
    assert.equal(store.feed('https://a.example/feed.xml'), undefined)
    assert.equal(store.cursor('https://a.example/feed.xml'), undefined)
    assert.notEqual(store.item('i-1'), undefined, '条目不在 deleteFeed 的职责里（旧实现同样不删，改它会变成静默删数据）')
    assert.deepEqual(store.listFeeds().map(([id]) => id), ['https://b.example/feed.xml'])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('deleteFeed 先写 config、后删游标：config 写不进去时游标必须还在（跨介质顺序）', async () => {
  const { store, db, configPath, dir } = freshStore('deletefeed-order')
  try {
    const feedId = 'https://a.example/feed.xml'
    await store.saveFeed(feedId, { url: feedId })
    await store.saveCursor(feedId, { seen: ['i-1'], cursorAt: '2026-10-11T09:00:00.000Z' })
    const before = readFileSync(configPath, 'utf8')

    // 让 config.json 变成一个**目录**：readConfigFile 会 EISDIR，写入更不可能成功。
    // 于是 writeFeeds 一定抛错 —— 而它**在什么时候**抛，正是本条的判据。
    rmSync(configPath)
    mkdirSync(configPath)

    await assert.rejects(
      () => store.deleteFeed(feedId),
      'config.json 写不进去时必须抛错，不许静默当成「退订成功」（用户以为退订了，源其实还在）',
    )

    // ★ 顺序判据：config 那一步失败了，那么**排在它后面**的删游标就绝不能已经发生。
    // 两者落在不同介质上（文件 vs 库），中间失败没有共同回滚 —— 所以顺序本身就是正确性。
    // 反过来的话这里会读到 undefined，用户看到的是「源还在订阅列表里、游标却没了」：
    // 下一轮刷新会把整份 feed 当新内容重新导入成未读。
    assert.notEqual(
      store.cursor(feedId),
      undefined,
      '跨介质写入的失败必须停在 config 这一步：游标还在，这次退订是一次干净的 no-op，重试即可',
    )

    // 源记录同理：配置是订阅的唯一副本，一次失败的退订不许让它少一个源
    rmSync(configPath, { recursive: true, force: true })
    writeFileSync(configPath, before)
    assert.notEqual(store.feed(feedId), undefined, '失败的退订不许动订阅映射')
    assert.deepEqual(store.listFeeds().map(([id]) => id), [feedId])

    // 正常路径不受影响：config 恢复成可写文件后，退订照样成功
    await store.deleteFeed(feedId)
    assert.equal(store.feed(feedId), undefined)
    assert.equal(store.cursor(feedId), undefined)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cursor 的 seen 是 JSON 文本；saveCursor 覆盖，缺 cursorAt 时键缺席', async () => {
  const { store, db, dir } = freshStore('cursors')
  try {
    await store.saveCursor('f1', { seen: ['a', 'b'], cursorAt: '2026-10-11T09:00:00.000Z' })
    assert.deepEqual(store.cursor('f1'), { seen: ['a', 'b'], cursorAt: '2026-10-11T09:00:00.000Z' })
    // 列里存 JSON 文本而不是拆行（spec §2 的漏项表：拆行会换来百万行表）
    assert.equal(typeof db.prepare('SELECT seen FROM cursors WHERE feed_id = ?').get('f1').seen, 'string')

    await store.saveCursor('f1', { seen: ['c'] })
    assert.deepEqual(store.cursor('f1'), { seen: ['c'] }, '缺 cursorAt 时不许留 undefined 键')
    await store.saveCursor('f2', { seen: [] })
    assert.deepEqual(store.cursor('f2'), { seen: [] }, '空窗口是合法值（新源第一轮之前）')
    assert.equal(store.cursor('f3'), undefined)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('viewPreferences 读侧一定给可信形状：坏值逐字段回落，已退订的源回落虚拟视图且不抛错', async () => {
  const { store, db, configPath, dir } = freshStore('prefs-read')
  try {
    await store.saveFeed('https://a.example/feed.xml', { url: 'https://a.example/feed.xml' })
    // 媒介里塞的是「别的版本写的 / 被改坏的」值 —— 一律不可信
    writeConfigFile(configPath, {
      version: 1,
      feeds: { 'https://a.example/feed.xml': { url: 'https://a.example/feed.xml' } },
      viewPreferences: {
        navSelection: { kind: 'feed', feedId: 'https://a.example/feed.xml' },
        filter: 'nonsense',
        navVisible: 'yes',
        junk: 1,
      },
    })
    assert.deepEqual(
      store.viewPreferences(),
      { navSelection: { kind: 'feed', feedId: 'https://a.example/feed.xml' }, filter: 'all', navVisible: true },
      '认不出的 filter / navVisible 必须**逐字段**回落（一项坏不该抹掉另两项的记忆），且不许把 junk 透出去',
    )

    // 已退订的源：回落虚拟视图，**不抛错**（src/store.ts:44 的契约）
    writeConfigFile(configPath, {
      version: 1,
      feeds: {},
      viewPreferences: { navSelection: { kind: 'feed', feedId: 'https://gone.example/feed.xml' }, filter: 'unread', navVisible: false },
    })
    assert.deepEqual(
      store.viewPreferences(),
      { navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: false },
      '退订的源必须回落虚拟视图，而不是让面板打不开（另两项记忆仍要保住）',
    )

    writeConfigFile(configPath, { version: 1, feeds: {}, viewPreferences: 'not-an-object' })
    assert.deepEqual(store.viewPreferences(), { navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true }, '垃圾一律给默认值，不抛错')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('调用方自己开着事务时写入不崩、且不替调用方提交（当年 Task 4 的迁移就是单事务批量写）', async () => {
  const { store, db, dir } = freshStore('nested')
  try {
    // 批量导入会在一个事务里连续写几万条：store 若在这里再发一次 BEGIN，SQLite 会直接抛
    // 「cannot start a transaction within a transaction」——一次正常的批量写入变成崩溃。
    db.exec('BEGIN')
    await store.saveItem('n-1', item('f1'))
    await store.saveItem('n-2', item('f1'))
    assert.ok(db.isTransaction, 'store 不许替调用方提交：提交权属于开事务的那个人')
    // 调用方决定回滚：store 写进去的行必须一起消失
    db.exec('ROLLBACK')
    assert.equal(store.item('n-1'), undefined, '外层回滚必须连 store 的写一起收回，否则迁移失败会留下半份数据')
    assert.equal(store.item('n-2'), undefined)

    // 提交路径同理
    db.exec('BEGIN')
    await store.saveItem('n-3', item('f1'))
    db.exec('COMMIT')
    assert.notEqual(store.item('n-3'), undefined)
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('外层事务里的一次失败只回滚它自己：调用方之前的写必须活着（SAVEPOINT 的全部意义）', async () => {
  const { store, db, dir } = freshStore('nested-savepoint')
  try {
    await store.saveItem('keep', item('f1'))
    db.exec('BEGIN')
    await store.saveItem('first', item('f1'))
    // 中间一次写入失败（fn 返回的正文序列化不了）：SQLite 里一条语句失败**不会**中止外层事务，
    // 没有 SAVEPOINT 时库里会留下「行写进去了、正文没写」的半截状态
    const circular = { kind: 'p' }
    circular.self = circular
    await assert.rejects(() =>
      store.updateItem('first', (current) => ({ ...current, article: { fetchedAt: 'x', blocks: [circular] } })),
    )
    await store.saveItem('second', item('f1'))
    assert.ok(db.isTransaction, '失败的那次写入不许把调用方的事务一起带走')
    assert.equal(store.item('first').article, undefined, '半截的正文必须被收回')
    db.exec('COMMIT')

    assert.notEqual(store.item('keep'), undefined, '事务之前的写不该被牵连')
    assert.notEqual(store.item('first'), undefined, '同事务里之前的写必须活着')
    assert.notEqual(store.item('second'), undefined, '失败之后同事务的写照样要能落库')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saveViewPreferences 写前校验并落 config.json，且不碰订阅映射；config.json 读不出来时响亮失败', async () => {
  const { store, db, configPath, dir } = freshStore('prefs-write')
  try {
    await store.saveFeed('https://a.example/feed.xml', { url: 'https://a.example/feed.xml', title: 'A' })
    const saved = await store.saveViewPreferences({
      navSelection: { kind: 'feed', feedId: 'https://a.example/feed.xml' },
      filter: 'starred',
      navVisible: false,
      junk: 1,
    })
    assert.deepEqual(
      saved,
      { navSelection: { kind: 'feed', feedId: 'https://a.example/feed.xml' }, filter: 'starred', navVisible: false },
      '返回值必须是归一后的形状（调用方直接拿它进 state）',
    )
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.deepEqual(onDisk.viewPreferences, saved, '落库的也必须是归一后的形状（坏值攒在媒介里只是被读侧遮住了）')
    assert.equal(onDisk.version, 1)
    assert.deepEqual(Object.keys(onDisk.feeds), ['https://a.example/feed.xml'], '写偏好不许动订阅映射')

    // 指向已退订的源：归一成虚拟视图，而不是把无效选中写进媒介
    const again = await store.saveViewPreferences({ navSelection: { kind: 'feed', feedId: 'https://gone.example/feed.xml' }, filter: 'all', navVisible: true })
    assert.deepEqual(again.navSelection, { kind: 'virtual' })
    assert.deepEqual(store.viewPreferences(), again, '写完必须读得回同一份')
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(configPath, 'utf8')).feeds), ['https://a.example/feed.xml'])

    // config.json 损坏（版本不认）时必须响亮失败，而不是把订阅映射当成空的重写一遍
    writeFileSync(configPath, JSON.stringify({ version: 2, feeds: {} }))
    await assert.rejects(
      () => store.saveViewPreferences({ filter: 'all' }),
      (error) => error.message.includes(configPath),
      'config.json 读不出来时不许落库 —— 那会把用户仅有的订阅副本覆盖成空',
    )
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')), { version: 2, feeds: {} }, '拒绝时不许动原文件')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listArticleCacheEntries：只交出 { id, chars, fetchedAt }，且 chars 与 articleCharsOf 同口径', async () => {
  const { store, db, dir } = freshStore('article-cache-entries')
  try {
    const at = '2026-10-11T10:00:00.000Z'
    await store.saveItem('no-body', item('feed-a'))
    await store.saveItem('b-1', item('feed-a', {
      fetchedAt: '2026-10-01T00:00:00.000Z',
      article: { fetchedAt: '2026-09-01T00:00:00.000Z', blocks: [{ kind: 'p', text: '五个字符' }] },
    }))
    await store.saveItem('b-2', item('feed-b', {
      fetchedAt: '2026-10-02T00:00:00.000Z',
      article: {
        fetchedAt: '2026-09-02T00:00:00.000Z',
        blocks: [{ kind: 'p', text: '一二三' }, { kind: 'list', items: ['四个字', 'x'] }],
      },
    }))

    const entries = store.listArticleCacheEntries()
    assert.deepEqual(entries.map((e) => e.id).sort(), ['b-1', 'b-2'],
      '只有真有缓存的行进名单（没有正文的条目不进），且跨源都在')

    // ⚠️ **字段集就是内存契约**：闸门每轮跑一次，而 allItems() 会把每份正文都留在堆里
    // （实测 10 万条 × 8.8 KB ⇒ 堆峰值 1865 MB，超 spec §9.3 的 300 MB 验收线 6.2 倍）。
    // 任何多出来的字段（尤其是 article / summary）都会把那份峰值带回来，所以这条钉死形状。
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['chars', 'fetchedAt', 'id'],
        '清算原料只允许这三个字段：多带一个就可能把正文搬回堆里')
    }

    // chars 是**第二处**实现（库里是 texts.body 的 JSON 文本，articleCharsOf 吃的是解析后的
    // articleRecord）—— 与唯一口径对账，判据同 listCleanupCandidates 的 articleChars。
    for (const entry of entries) {
      assert.equal(entry.chars, articleCharsOf(store.item(entry.id).article),
        entry.id + '：chars 必须与 retention.ts 的 articleCharsOf 同口径')
    }
    assert.equal(entries.find((e) => e.id === 'b-1').chars, 4)
    assert.equal(entries.find((e) => e.id === 'b-2').chars, 3 + 3 + 1, 'blocks 里 text 与 items 都要算')
    assert.equal(entries.find((e) => e.id === 'b-1').fetchedAt, '2026-09-01T00:00:00.000Z',
      '排序键必须是正文的抓取时间（texts.fetched_at），不是条目的 fetched_at')

    // 清掉一条缓存后它必须立刻退出名单（闸门不能对着已经清掉的条目反复点名）
    await store.updateItem('b-1', (cur) => ({ ...cur, article: undefined }))
    assert.deepEqual(store.listArticleCacheEntries().map((e) => e.id), ['b-2'])
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * texts.fetched_at 是 NOT NULL（2026-10-11 终检评审 C1）。
 *
 * 为什么值得单独一条：读侧三处（item / listItems / allItems）都走
 * `requiredText(row.article_fetched_at, 'texts.fetched_at')`，而 DDL 原先允许 NULL ——
 * 一条 NULL 行会让**三条读路径同时抛**。本版自己的写入口写不出它（articleRecordSchema.fetchedAt
 * 是必填），所以「不可达」是这份判断的全部理由；可库里是用户数据，手工改库 / 别的写者都能造出
 * 那一行。两条断言各钉一半：
 *  ① 声明 = NOT NULL（PRAGMA table_info）——这是约束本身；
 *  ② 往**真库**里直插一行 NULL ⇒ 必须抛（「NULL 写不进去」是可执行的，不是注释里的主张）；
 *  ③ 正向对照：读路径确实把这一列交出来（否则 ①② 守的就是一列没人用的数据）。
 */
test('texts.fetched_at 声明 NOT NULL：NULL 写不进去，且读路径确实消费这一列', async () => {
  const { store, db, dir } = freshStore('texts-not-null')
  try {
    const column = db.prepare('PRAGMA table_info(texts)').all().find((entry) => entry.name === 'fetched_at')
    assert.equal(column.notnull, 1,
      'texts.fetched_at 必须 NOT NULL：读侧走 requiredText，NULL 会让 item/listItems/allItems 一起抛')

    await store.saveItem('has-body', item('feed-a', {
      article: { fetchedAt: '2026-09-01T00:00:00.000Z', blocks: [{ kind: 'p', text: '正文' }] },
    }))

    // ② 约束是活的：绕开 store 直插 NULL 也要被库本身挡下
    assert.throws(
      () => db.prepare('INSERT INTO texts(item_id, body, fetched_at) VALUES (?, ?, ?)').run('orphan', '[]', null),
      /NOT NULL/i,
      'texts.fetched_at 上的 NOT NULL 必须真的生效：NULL 行写不进去（否则读侧 requiredText 迟早抛）')

    // ③ 正向对照：读路径真的消费这一列（item 读回 article.fetchedAt）
    assert.equal(store.item('has-body').article.fetchedAt, '2026-09-01T00:00:00.000Z',
      'item() 必须把 texts.fetched_at 交出来 —— 它是正文缓存淘汰的排序键')
  } finally {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})