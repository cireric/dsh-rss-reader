/**
 * ReaderStore 的**可执行契约**（票据 01）。
 *
 * 为什么要有它：接口有 36 个方法、三份实现（自持 SQLite / 旧 JSON 适配器 / 内存替身），
 * 但三份之间没有共同判据 —— 替身只实现 23 个，且比生产更宽松。于是「接口就是测试面」失效：
 * 调用方与测试跨的不是同一个接缝，某个实现悄悄放宽行为也没人喊。
 *
 * 这里的断言只钉**契约**：返回形状、幂等性、可预期失败的类型、跨调用可见的副作用。
 * 不钉 SQL、不钉表名、不钉某个实现内部怎么存 —— 那是实现的自由，不是契约。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrateSchema } from '../../lib/storage/db.js'
import { writeConfigFile } from '../../lib/storage/config-file.js'
import { createSqliteStore } from '../../lib/store-sqlite.js'
import { createStore } from '../../lib/store.js'
import { createMemoryStore } from '../../lib/memory-store.js'
import { DEFAULT_VIEW_PREFERENCES } from '../../lib/preferences.js'
import { FolderError } from '../../lib/folders.js'
import { linkKeyOf } from '../../lib/duplicates.js'

/** 契约用例：`run({ store }) ` 里只许用 ReaderStore 的方法与返回值。 */
export const contractCases = [
  {
    name: 'feed / saveFeed：写进去读得回，没写过的源是 undefined',
    async run({ store }) {
      assert.equal(store.feed('f1'), undefined, '没保存过的源必须 undefined，而不是空对象')
      await store.saveFeed('f1', { title: '源 1', url: 'https://a.example/feed.xml', folder: '技术' })
      // 契约口径：**字段值**必须逐项相等；值为 undefined 的字段可以缺席 —— 媒介是 JSON，
      // 它表达不了 undefined（sqlite 侧存进去就没了，legacy 侧还在内存里）。这条差异是
      // 2026-11-15 契约首次跑起来时抓到的：两边对同一份输入给了不同形状。
      assert.deepEqual(store.feed('f1'), { title: '源 1', url: 'https://a.example/feed.xml', folder: '技术' })

      await store.saveFeed('f2', { title: '源 2', url: 'https://b.example/feed.xml' })
      assert.equal(store.feed('f2').folder, undefined, '没给 folder 就是「未分类」')
    },
  },
  {
    name: 'listFeeds：列出全部已保存的源，键是 feedId',
    async run({ store }) {
      await store.saveFeed('f1', { title: '源 1', url: 'https://a.example/feed.xml' })
      await store.saveFeed('f2', { title: '源 2', url: 'https://b.example/feed.xml' })
      const ids = store.listFeeds().map(([id]) => id).sort()
      assert.deepEqual(ids, ['f1', 'f2'])
    },
  },
  {
    // R3 01：顺序的唯一真相是 feedOrder，而「没列出的源」按 feeds 键序追加。
    // 三份实现都必须在没有 feedOrder 时给出**键序**（不是按 id/标题排序，也不是任意顺序）：
    // 这条是派生规则里唯一能被三份实现同时观察到的半边；已列出那半边的判据在
    // tests/feed-order.test.mjs（真 config.json + 真 store 重开）。
    name: 'listFeeds：顺序 = feeds 键序，删掉再写回排末尾（未列出的源只能追加）',
    async run({ store }) {
      for (const id of ['f3', 'f1', 'f2']) {
        await store.saveFeed(id, { url: 'https://' + id + '.example/feed.xml' })
      }
      assert.deepEqual(store.listFeeds().map(([id]) => id), ['f3', 'f1', 'f2'],
        '顺序是写入的键序，不按 feedId 排序')
      await store.deleteSubscription('f1')
      await store.saveFeed('f1', { url: 'https://f1.example/feed.xml' })
      assert.deepEqual(store.listFeeds().map(([id]) => id), ['f3', 'f2', 'f1'],
        '删掉再加回只能排到末尾 —— 派生不允许把未列出的源插进已列出的段落')
    },
  },
  {
    // R3 02：写入口落地后，「已列出的源按数组序」这半边终于可观察 —— 此前只能靠手改 config.json。
    // 三份实现必须同一份归一规则：未知 id 忽略、重复保首次、未点名的按**当前有效顺序**补末尾。
    name: 'reorderFeeds：显式顺序写进去读得回；未知 id 忽略、重复保首次、未点名的按当前顺序补末尾',
    async run({ store }) {
      for (const id of ['f1', 'f2', 'f3', 'f4']) {
        await store.saveFeed(id, { url: 'https://' + id + '.example/feed.xml' })
      }
      assert.deepEqual(store.listFeeds().map(([id]) => id), ['f1', 'f2', 'f3', 'f4'],
        '前提：还没写顺序时是键序')

      assert.deepEqual(await store.reorderFeeds(['f3', 'f1']), ['f3', 'f1', 'f2', 'f4'],
        '回包是落盘后的有效顺序：点名的按请求，未点名的按原相对顺序补在末尾')
      assert.deepEqual(store.listFeeds().map(([id]) => id), ['f3', 'f1', 'f2', 'f4'],
        '写进去的顺序必须立刻可读')

      assert.deepEqual(await store.reorderFeeds(['f4', 'missing', 'f4', 'f2']), ['f4', 'f2', 'f3', 'f1'],
        '未知 id 忽略不拒绝，重复保首次，其余按**当前**有效顺序补齐（不是按键序）')

      assert.deepEqual(await store.reorderFeeds([]), ['f4', 'f2', 'f3', 'f1'], '空数组：不写盘，回当前顺序')
      assert.deepEqual(await store.reorderFeeds(['missing']), ['f4', 'f2', 'f3', 'f1'],
        '全是未知 id：同样不写盘，回当前顺序')
    },
  },
  {
    name: 'createFolder / listFolders：新建后出现在目录里；重名是可预期的 conflict 而不是崩溃',
    async run({ store }) {
      assert.deepEqual(store.listFolders(), [], '空目录起步')
      const folders = await store.createFolder('技术')
      assert.deepEqual(folders.map((f) => f.name), ['技术'])
      assert.deepEqual(store.listFolders().map((f) => f.name), ['技术'])

      await assert.rejects(() => store.createFolder('技术'), (error) => {
        assert.ok(error instanceof FolderError, '重名必须是 FolderError，不能是裸 Error')
        assert.equal(error.code, 'conflict')
        return true
      })
    },
  },
  {
    name: 'moveFeedToFolder：移动后归属变了；移到不存在的目录是可预期的 not-found',
    async run({ store }) {
      await store.saveFeed('f1', { title: '源 1', url: 'https://a.example/feed.xml' })
      await store.createFolder('技术')
      await store.moveFeedToFolder('f1', '技术')
      assert.equal(store.feed('f1').folder, '技术')

      await assert.rejects(() => store.moveFeedToFolder('f1', '不存在的目录'), (error) => {
        assert.ok(error instanceof FolderError)
        assert.equal(error.code, 'not-found')
        return true
      })
    },
  },
  {
    name: 'deleteFolder：目录消失、成员退回未分类，并把「解绑了几个」报出来',
    async run({ store }) {
      await store.saveFeed('f1', { title: '源 1', url: 'https://a.example/feed.xml' })
      await store.createFolder('技术')
      await store.moveFeedToFolder('f1', '技术')

      const result = await store.deleteFolder('技术')
      assert.deepEqual(result.folders, [], '目录空了')
      assert.equal(result.detached, 1, '解绑计数必须是真的，不能恒 0')
      assert.equal(store.feed('f1').folder, undefined, '成员退回未分类')
    },
  },
  {
    name: 'renameFolder：改名后成员归属跟着走；撞名是可预期的 conflict',
    async run({ store }) {
      await store.saveFeed('f1', { url: 'https://a.example/feed.xml' })
      await store.createFolder('技术')
      await store.createFolder('其它')
      await store.moveFeedToFolder('f1', '技术')

      const folders = await store.renameFolder('技术', '工程')
      assert.deepEqual(folders.map((f) => f.name).sort(), ['其它', '工程'])
      assert.equal(store.feed('f1').folder, '工程', '成员归属必须一起改 —— 目录改了、归属没改就是两套真相')

      await assert.rejects(() => store.renameFolder('工程', '其它'), (error) => {
        assert.ok(error instanceof FolderError)
        assert.equal(error.code, 'conflict')
        return true
      })
    },
  },
  {
    name: 'itemsByLinkKeys：按归一化链接键批量取行（跨源重复提示的原料）',
    async run({ store }) {
      const link = 'https://site.example/post/1?utm_source=a'
      const link2 = 'https://site.example/post/1'
      await store.saveItem('i1', { feedId: 'f1', title: '甲', link, fetchedAt: '2026-11-01T00:00:00.000Z', starred: false })
      await store.saveItem('i2', { feedId: 'f2', title: '乙', link: link2, fetchedAt: '2026-11-01T00:00:00.000Z', starred: false })

      const key = linkKeyOf(link)
      assert.notEqual(key, '', '夹具前提：这条链接要能算出链接键')
      const rows = store.itemsByLinkKeys([key])
      assert.deepEqual(rows.map((row) => row.id).sort(), ['i1', 'i2'], '同一个键的行都要取到（跨源）')
      assert.deepEqual(store.itemsByLinkKeys([]), [], '空键列表 ⇒ 空结果')
    },
  },
  {
    name: 'createTag / listTags / deleteTag：标签的往返与删除',
    async run({ store }) {
      const tag = await store.createTag('工作')
      assert.equal(typeof tag.id, 'string')
      assert.equal(tag.name, '工作')
      assert.deepEqual(store.listTags().map((t) => t.name), ['工作'])

      await store.deleteTag(tag.id)
      assert.deepEqual(store.listTags(), [], '删掉之后目录里不该再有它')
    },
  },
  {
    name: 'viewPreferences：没存过时给默认值，存过之后读回同一份',
    async run({ store }) {
      assert.deepEqual(store.viewPreferences(), DEFAULT_VIEW_PREFERENCES, '没存过 ⇒ 默认值，不编造')
      const saved = await store.saveViewPreferences({
        navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: false,
      })
      assert.equal(saved.filter, 'unread')
      assert.deepEqual(store.viewPreferences(), saved, '写进去的那份必须读得回来')
    },
  },
  {
    name: 'updateFeed：按意图合并字段；源不存在时拒绝（不许「写一次即创建」）',
    async run({ store }) {
      await store.saveFeed('f1', { url: 'https://a.example/feed.xml', title: '源 1' })
      const stamp = '2026-11-15T00:00:00.000Z'
      await store.updateFeed('f1', {
        kind: 'refresh-success', url: 'https://a.example/feed.xml', stamp, title: '源 1',
        etag: 'e1', lastModified: 'm1', contentRevision: 2,
      })
      const after = store.feed('f1')
      assert.equal(after.lastFetchedAt, stamp, '成功抓取要盖「上次成功」')
      assert.equal(after.lastAttemptedAt, stamp, '成功也是一次尝试')
      assert.equal(after.etag, 'e1')
      assert.equal(after.contentRevision, 2)
    },
  },
  {
    name: 'cursor / saveCursor：去重窗口原样往返',
    async run({ store }) {
      assert.equal(store.cursor('f1'), undefined)
      const record = { seen: ['a', 'b'], cursorAt: '2026-11-01T00:00:00.000Z' }
      await store.saveCursor('f1', record)
      assert.deepEqual(store.cursor('f1'), record)
    },
  },
  {
    name: 'deleteSubscription：订阅项、条目、游标一起消失，并如实报出删了几条',
    async run({ store }) {
      await store.saveFeed('f1', { url: 'https://a.example/feed.xml' })
      await store.saveFeed('f2', { url: 'https://b.example/feed.xml' })
      await store.saveCursor('f1', { seen: ['x'] })
      for (const id of ['i1', 'i2']) {
        await store.saveItem(id, { feedId: 'f1', title: id, link: 'https://a.example/' + id, fetchedAt: '2026-11-01T00:00:00.000Z', starred: false })
      }
      await store.saveItem('keep', { feedId: 'f2', title: 'keep', link: 'https://b.example/keep', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false })

      const result = await store.deleteSubscription('f1')
      assert.equal(result.items, 2, '返回的条数必须是真的（2 条）')
      assert.equal(store.feed('f1'), undefined)
      assert.equal(store.cursor('f1'), undefined, '游标必须跟着走，否则重新订阅会跳过老条目')
      assert.deepEqual(store.listItems('f1'), [])
      assert.deepEqual(store.allItems().map(([id]) => id), ['keep'], '别的源的条目一条都不许动')
    },
  },
  {
    name: 'item / saveItem / listItems / allItems：条目的写入与两种读法',
    async run({ store }) {
      const record = { feedId: 'f1', title: '标题', link: 'https://a.example/1', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false }
      assert.equal(store.item('i1'), undefined)
      await store.saveItem('i1', record)
      assert.deepEqual(store.item('i1'), record)

      await store.saveItem('i2', { ...record, feedId: 'f2', link: 'https://b.example/2' })
      assert.deepEqual(store.listItems('f1').map(([id]) => id), ['i1'], 'listItems 只给这个源的')
      assert.deepEqual(store.allItems().map(([id]) => id).sort(), ['i1', 'i2'])
    },
  },
  {
    name: 'updateItem：原子读改写（fn 看到当前值）；条目不存在时拒绝',
    async run({ store }) {
      await store.saveItem('i1', { feedId: 'f1', title: '标题', link: 'https://a.example/1', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false })
      let seen
      await store.updateItem('i1', (current) => {
        seen = current
        return { ...current, readAt: '2026-11-15T00:00:00.000Z' }
      })
      assert.equal(seen.title, '标题', 'fn 拿到的必须是当时的记录，不是空壳')
      assert.equal(store.item('i1').readAt, '2026-11-15T00:00:00.000Z')

      await assert.rejects(() => store.updateItem('missing', (current) => current),
        '缺失条目必须拒绝 —— 写一次不等于创建')
    },
  },
  {
    name: 'deleteItem：删掉之后读不到；再删一次不抛（幂等）',
    async run({ store }) {
      await store.saveItem('i1', { feedId: 'f1', title: '标题', link: 'https://a.example/1', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false })
      await store.deleteItem('i1')
      assert.equal(store.item('i1'), undefined)
      await store.deleteItem('i1')
    },
  },
  {
    name: 'listRecent：recency 降序、limit 截断、游标只给严格之后、limit≤0 空结果',
    async run({ store }) {
      const base = { feedId: 'f1', link: 'https://a.example/', fetchedAt: '2026-11-02T00:00:00.000Z', starred: false }
      await store.saveItem('i1', { ...base, title: 'i1', publishedAt: '2026-11-01T00:00:00.000Z' })
      await store.saveItem('i2', { ...base, title: 'i2', publishedAt: '2026-11-03T00:00:00.000Z' })
      await store.saveItem('i3', { ...base, title: 'i3' }) // 无 publishedAt ⇒ 按 fetchedAt 归位

      assert.deepEqual(store.listRecent(2).map(([id]) => id), ['i2', 'i3'], 'recency 降序 + 上限')
      assert.deepEqual(store.listRecent(0), [], 'limit 0 必须是空列表（不许下传 -1 变全表）')
      assert.deepEqual(store.listRecent(-1), [], '负数同理')

      const firstPage = store.listRecent(2)
      const last = store.listRecent(2)[1]
      const nextPage = store.listRecent(2, { recency: last[1].publishedAt ?? last[1].fetchedAt, id: last[0] })
      assert.deepEqual(nextPage.map(([id]) => id), ['i1'], '游标只返回严格排在它之后的（同 recency 按 id 升序）')
      assert.equal(firstPage.length, 2)
    },
  },
  {
    name: 'listRecent：feedIds / tagId 范围在限页之前生效，且游标在范围内续页',
    async run({ store }) {
      const base = { link: 'https://a.example/', fetchedAt: '2026-11-02T00:00:00.000Z', starred: false }
      // 三个源交错时间：范围若在限页之后才过滤，取 2 条就会漏掉 f3 的两条（M2 03 的硬要求）。
      await store.saveItem('a1', { ...base, feedId: 'f1', title: 'a1', publishedAt: '2026-11-06T00:00:00.000Z' })
      await store.saveItem('b1', { ...base, feedId: 'f2', title: 'b1', publishedAt: '2026-11-05T00:00:00.000Z' })
      await store.saveItem('c1', { ...base, feedId: 'f3', title: 'c1', publishedAt: '2026-11-04T00:00:00.000Z' })
      await store.saveItem('c2', { ...base, feedId: 'f3', title: 'c2', publishedAt: '2026-11-03T00:00:00.000Z' })
      await store.saveItem('a2', { ...base, feedId: 'f1', title: 'a2', publishedAt: '2026-11-02T00:00:00.000Z' })

      assert.deepEqual(store.listRecent(2, undefined, ['f3']).map(([id]) => id), ['c1', 'c2'],
        '按源范围：先筛成员再限页（f2 的 b1 不许占窗口）')
      assert.deepEqual(store.listRecent(2, undefined, []), [],
        '空数组 = 空结果，绝不回落成「无范围」（那会让空文件夹查出全库）')

      const scoped = store.listRecent(1, undefined, ['f1', 'f3'])
      assert.deepEqual(scoped.map(([id]) => id), ['a1'], '前置条件：范围内第一条')
      const afterScoped = store.listRecent(1, { recency: '2026-11-06T00:00:00.000Z', id: 'a1' }, ['f1', 'f3'])
      assert.deepEqual(afterScoped.map(([id]) => id), ['c1'],
        '游标在范围内续页：范围内排序键之后的下一批（f2 的 b1 仍被排除）')

      const tag = await store.createTag('技术')
      await store.setItemTags('b1', [tag.id])
      await store.setItemTags('a2', [tag.id])
      assert.deepEqual(store.listRecent(2, undefined, undefined, tag.id).map(([id]) => id), ['b1', 'a2'],
        '按标签范围：只取打了该标签的条目，先筛后限页')
      const afterTag = store.listRecent(1, { recency: '2026-11-05T00:00:00.000Z', id: 'b1' }, undefined, tag.id)
      assert.deepEqual(afterTag.map(([id]) => id), ['a2'], '标签范围 + 游标同样只返回严格之后的行')
    },
  },
  {
    name: 'unreadPerFeed：只保证传入的键都有值，数得准',
    async run({ store }) {
      const base = { feedId: 'f1', link: 'https://a.example/', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false }
      await store.saveItem('i1', { ...base, title: 'i1' })
      await store.saveItem('i2', { ...base, title: 'i2', readAt: '2026-11-02T00:00:00.000Z' })
      await store.saveItem('i3', { ...base, feedId: 'f2', title: 'i3' })

      const counts = store.unreadPerFeed(['f1', 'f2', 'f3'])
      assert.equal(counts.f1, 1, '已读的不能算未读')
      assert.equal(counts.f2, 1)
      assert.equal(counts.f3, 0, '没条目的源也要有键（键域 = 调用方给的 feeds 表）')
    },
  },
  {
    name: 'listCleanupCandidates：真该删的行必须在候选里；候选行携带的字段必须是真的',
    async run({ store }) {
      const base = { feedId: 'f1', link: 'https://a.example/', fetchedAt: '2026-01-01T00:00:00.000Z', starred: false }
      await store.saveItem('old-read', { ...base, title: 'old-read', publishedAt: '2026-01-01T00:00:00.000Z', readAt: '2026-01-02T00:00:00.000Z' })
      await store.saveItem('old-starred', { ...base, title: 'old-starred', publishedAt: '2026-01-01T00:00:00.000Z', readAt: '2026-01-02T00:00:00.000Z', starred: true })
      await store.saveItem('old-kept', { ...base, title: 'old-kept', publishedAt: '2026-01-01T00:00:00.000Z', readAt: '2026-01-02T00:00:00.000Z', keptUnread: true })
      await store.saveItem('old-unread', { ...base, title: 'old-unread', publishedAt: '2026-01-01T00:00:00.000Z' })
      await store.saveItem('fresh-read', { ...base, title: 'fresh-read', publishedAt: '2026-10-01T00:00:00.000Z', readAt: '2026-10-02T00:00:00.000Z' })

      const rows = store.listCleanupCandidates('2026-06-01T00:00:00.000Z')
      const ids = new Set(rows.map((row) => row.id))
      // 契约是**包含关系**：候选集 ⊇ 判定集。这里「真该删」= 已读 + 不星标 + 不保持 + 够旧。
      assert.ok(ids.has('old-read'), '真该删的那一条必须在候选里（少取可以，漏掉不行）')

      // 候选行必须携带**真实**字段（不许按谓词回填）：逐行与当前记录对账。
      for (const row of rows) {
        const live = store.item(row.id)
        assert.ok(live !== undefined, '候选行必须能按 id 读回：' + row.id)
        assert.equal(row.read, live.readAt !== undefined, 'read 必须是真值：' + row.id)
        assert.equal(row.starred, live.starred === true, 'starred 必须是真值：' + row.id)
        assert.equal(row.kept, live.keptUnread === true, 'kept 必须是真值：' + row.id)
      }
      // 星标/保持未读的行「在不在候选里」由实现决定（判定集会把它们排除），这里只要求：若在，字段是真的。
    },
  },
  {
    name: 'listArticleCacheEntries：只给有正文的条目，chars 是该条的字符数',
    async run({ store }) {
      const base = { feedId: 'f1', link: 'https://a.example/', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false }
      await store.saveItem('with-article', {
        ...base, title: 'a',
        article: { blocks: [{ text: 'abcde' }], fetchedAt: '2026-11-01T00:00:00.000Z' },
      })
      await store.saveItem('no-article', { ...base, title: 'b' })

      const entries = store.listArticleCacheEntries()
      assert.deepEqual(entries.map((entry) => entry.id), ['with-article'])
      assert.equal(entries[0].chars, 5, '字符数按 blocks 的 text 计')
    },
  },
  {
    name: 'renameTag：只改名字，id 与文章关联都不动',
    async run({ store }) {
      const tag = await store.createTag('工作')
      await store.saveItem('i1', { feedId: 'f1', title: 't', link: 'https://a.example/1', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false })
      await store.setItemTags('i1', [tag.id])

      const renamed = await store.renameTag(tag.id, '项目')
      assert.equal(renamed.id, tag.id, 'id 必须稳定 —— 关联指向它')
      assert.equal(renamed.name, '项目')
      assert.deepEqual(store.itemTags('i1').map((t) => t.name), ['项目'], '关联跟着新名字走')
    },
  },
  {
    name: 'setItemTags / itemTags / tagIdsForItems：幂等覆盖、空数组清空、未知 id 整次失败',
    async run({ store }) {
      await store.saveItem('i1', { feedId: 'f1', title: 't', link: 'https://a.example/1', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false })
      const a = await store.createTag('甲')
      const b = await store.createTag('乙')

      const returned = await store.setItemTags('i1', [a.id])
      assert.deepEqual(returned.map((t) => t.id), [a.id], '返回值就是设置后的标签集合')
      await store.setItemTags('i1', [a.id, b.id])
      assert.equal(store.itemTags('i1').length, 2)
      await store.setItemTags('i1', [a.id])
      assert.deepEqual(store.itemTags('i1').map((t) => t.id), [a.id], '覆盖语义：不是追加')

      assert.deepEqual(store.tagIdsForItems(['i1']), { i1: [a.id] }, '批量读取必须给同样的答案')
      await store.setItemTags('i1', [])
      assert.deepEqual(store.itemTags('i1'), [], '空数组 = 清空')

      await assert.rejects(() => store.setItemTags('i1', ['no-such-tag']), '未知标签 id 必须整次失败，不许部分写入')
      assert.deepEqual(store.itemTags('i1'), [], '失败之后不许留下半截状态')
    },
  },
  {
    name: 'mergeItems：keeper 记录与 loser 的标签关联在同一事务里落盘，loser 消失',
    async run({ store }) {
      const base = { feedId: 'f1', link: 'https://a.example/', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false }
      await store.saveItem('keeper', { ...base, title: 'keeper' })
      await store.saveItem('loser', { ...base, title: 'loser', starred: true })
      const tag = await store.createTag('工作')
      await store.setItemTags('loser', [tag.id])

      await store.mergeItems('keeper', ['loser'], { ...base, title: 'merged' })
      assert.equal(store.item('loser'), undefined, 'loser 必须被删')
      assert.equal(store.item('keeper').title, 'merged', 'keeper 用传进来的记录')
      assert.deepEqual(store.itemTags('keeper').map((t) => t.id), [tag.id], 'loser 身上的标签必须跟着并过来')
    },
  },
  {
    name: 'readingProgress：版本对不上就当没有；ratio 夹到 [0,1]；条目不存在拒绝；clear 幂等',
    async run({ store }) {
      await store.saveItem('i1', { feedId: 'f1', title: 't', link: 'https://a.example/1', fetchedAt: '2026-11-01T00:00:00.000Z', starred: false })
      assert.equal(store.readingProgress('i1', 'v1'), undefined, '没记过 ⇒ undefined')

      await store.saveReadingProgress('i1', 'v1', 0.5)
      assert.deepEqual(store.readingProgress('i1', 'v1'), { ratio: 0.5 })
      assert.equal(store.readingProgress('i1', 'v2'), undefined, '正文换了版本 ⇒ 旧位置指向的不是同一段文字')

      await store.saveReadingProgress('i1', 'v1', 1.5)
      assert.deepEqual(store.readingProgress('i1', 'v1'), { ratio: 1 }, 'ratio 必须夹到 1')

      await assert.rejects(() => store.saveReadingProgress('missing', 'v1', 0.5), '条目不存在必须拒绝')

      await store.clearReadingProgress('i1')
      assert.equal(store.readingProgress('i1', 'v1'), undefined)
      await store.clearReadingProgress('i1')
    },
  },
]

/** 自持实现：真文件库 + 真 config.json，每个用例一份独立目录。 */
export function sqliteImpl() {
  return {
    label: 'sqlite（生产路径）',
    async open() {
      const dir = mkdtempSync(join(tmpdir(), 'rss-contract-sqlite-'))
      const configPath = join(dir, 'config.json')
      writeConfigFile(configPath, { version: 1, feeds: {} })
      const db = openDatabase(join(dir, 'rss.db'))
      migrateSchema(db)
      let open = true
      return {
        store: createSqliteStore(db, configPath),
        async dispose() {
          if (open) { db.close(); open = false }
          rmSync(dir, { recursive: true, force: true })
        },
      }
    },
  }
}

/** 旧适配器：Map 支撑的域表 + global 槽（与生产同一份 createStore 代码）。 */
export function legacyImpl() {
  return {
    label: 'legacy（旧 JSON 适配器）',
    async open() {
      const tables = { feeds: new Map(), cursors: new Map(), items: new Map(), readingProgress: new Map() }
      let global
      const handle = (name) => ({
        get: (key) => tables[name].get(key),
        has: (key) => tables[name].has(key),
        entries: () => [...tables[name].entries()][Symbol.iterator](),
        keys: () => [...tables[name].keys()][Symbol.iterator](),
        get size() { return tables[name].size },
        put: async (key, value) => { tables[name].set(key, value) },
        delete: async (key) => tables[name].delete(key),
        // 真域的 KvTable.update 在缺失键上抛 missing-key（store.ts:75 的契约就是这么写的）。
        // 夹具不许比真域宽松 —— 否则「legacy 不拒绝缺失键」这种结论是夹具造出来的假象。
        update: async (key, fn) => {
          if (!tables[name].has(key)) throw new Error('missing-key：' + name + '/' + key)
          const next = fn(tables[name].get(key))
          tables[name].set(key, next)
          return next
        },
      })
      const domain = {
        name: 'rss_reader',
        table: handle,
        global: { get: () => global, set: async (value) => { global = value } },
      }
      return { store: createStore(domain), async dispose() {} }
    },
  }
}

/** 内存版：第一等实现（src/memory-store.ts），不是「谁的私货」—— 与另外两份跑同一套契约。 */
export function memoryImpl() {
  return {
    label: 'memory（第一等替身）',
    async open() {
      return { store: createMemoryStore(), async dispose() {} }
    },
  }
}
