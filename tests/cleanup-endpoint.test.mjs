/**
 * cleanup 端点：判据在**更宽的候选集**上真的执行了一次（票据 03 的欠账）。
 *
 * 为什么单独一个文件：这条用例要回答的问题与「端点注册表」（名字/信封/未就绪守卫）不同 ——
 * 它问的是「受保护的条目会不会被删」。放在注册表文件里会让两个职责纠缠。
 *
 * 为什么这里敢用内存实现：2026-11-15 起它是**第一等实现**（src/memory-store.ts，由 tsc 盯着，
 * 并通过 ReaderStore 的整套契约）。而且它产出的候选**比判定集宽**（只成本过滤已读+够旧），
 * 正好是这条用例要的形状 —— 用 sqlite 也一样，但内存实现能把「候选里到底有什么」摆明。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryStore } from '../lib/memory-store.js'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'

const FEED_ID = 'https://feed0.example.com/atom.xml'

function makeStore() {
  const store = createMemoryStore()
  const old = '2020-01-01T00:00:00.000Z'
  const base = { feedId: FEED_ID, title: '标题', fetchedAt: old, starred: false }
  store.items.set('old-read', { ...base, link: 'https://site.example/1', publishedAt: old, readAt: '2020-02-01T00:00:00.000Z' })
  store.items.set('old-starred', { ...base, link: 'https://site.example/2', publishedAt: old, readAt: '2020-02-01T00:00:00.000Z', starred: true })
  store.items.set('old-kept', { ...base, link: 'https://site.example/3', publishedAt: old, readAt: '2020-02-01T00:00:00.000Z', keptUnread: true })
  store.items.set('old-unread', { ...base, link: 'https://site.example/4', publishedAt: old })
  const now = new Date().toISOString()
  store.items.set('fresh-read', { ...base, link: 'https://site.example/5', publishedAt: now, readAt: now })
  return store
}

function makeDispatch(store) {
  return createDispatch({
    config: Config({}),
    log: () => {},
    ready: () => store,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
  })
}

test('cleanup：更宽的候选集上判据仍然生效 —— 星标 / 保持未读 / 未读 / 未到期的一条都不许删', async () => {
  const store = makeStore()
  const dispatch = makeDispatch(store)

  // 前置：候选必须真的**比判定集宽**（受保护的行也在里面）—— 否则这条用例测不到它想测的东西。
  const candidates = store.listCleanupCandidates(new Date(Date.now() - 30 * 86400_000).toISOString())
  const candidateIds = candidates.map((row) => row.id).sort()
  assert.deepEqual(candidateIds, ['old-kept', 'old-read', 'old-starred'],
    '候选 = 已读且够旧（含受保护的两条）；未读与未到期的都不进来')

  const result = await dispatch('cleanup', {})
  assert.equal(result.ok, true, 'cleanup 必须成功：' + JSON.stringify(result))
  assert.equal(result.value.deleted, 1, '只有 old-read 该被删')

  assert.equal(store.items.has('old-read'), false, '该删的必须删掉')
  for (const id of ['old-starred', 'old-kept', 'old-unread', 'fresh-read']) {
    assert.ok(store.items.has(id), id + ' 必须活下来 —— 判据要在端点这一层真的执行')
  }
})

// ── R11 04：清理预演（spec D27.1 / 验收 C19）────────────────────────────────
//
// 预演必须是**同一条判据的只读运行**：候选、cutoff、释放量与真正执行共用 selectCleanup，
// 唯一区别是「删不删、写哪条日志」。所以这里不只断言回包的 N，还要逐条比对预演前后的
// 条目与读态 —— 只要预演动了任何一条，用户点一次「立即清理」就会先丢一次数据。

/** 预演前后的完整快照：id 顺序 + 每条的读态 / 星标 / 保持未读。 */
function snapshotOf(store) {
  return [...store.items.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, record]) => [id, record.readAt, record.starred === true, record.keptUnread === true])
}

test('R11 04 cleanup dryRun：不删任何条目、读态逐条不变，计数 / 释放量 / 阈值与随后执行一致', async () => {
  const store = makeStore()
  // 给唯一该删的那条加摘要，释放量才有非零原料（内存实现的 summaryChars 直接取摘要长度）。
  store.items.set('old-read', { ...store.items.get('old-read'), summary: '旧摘要' })
  const logs = []
  const dispatch = createDispatch({
    config: Config({}),
    log: (line) => logs.push(line),
    ready: () => store,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
  })

  const before = snapshotOf(store)
  const preview = await dispatch('cleanup', { dryRun: true })
  assert.equal(preview.ok, true, 'dryRun 预演必须成功：' + JSON.stringify(preview))
  assert.equal(preview.value.dryRun, true, '预演回包必须标记 dryRun: true')
  assert.equal(preview.value.deleted, 1, '预演要告诉用户「如果现在执行会删多少」')
  assert.ok(preview.value.freedChars > 0, '释放量必须来自同一份候选原料')
  assert.deepEqual(snapshotOf(store), before, '预演不许删除条目，也不许改任何读态')
  assert.deepEqual([...store.items.keys()].sort(), ['fresh-read', 'old-kept', 'old-read', 'old-starred', 'old-unread'],
    '预演前后条目数不变')
  assert.ok(logs.some((line) => line.includes('预演：将清理 1 条')), '预演日志必须说「将清理 N 条」')
  assert.ok(!logs.some((line) => line.includes('清理：删除')), '预演绝不许写「清理：删除」')

  // 同一条 store 上立刻执行：删掉的就是预演数出来的那一条，N 与释放量必须一致。
  const executed = await dispatch('cleanup', {})
  assert.equal(executed.ok, true, '执行必须成功：' + JSON.stringify(executed))
  assert.equal(executed.value.dryRun, false, '非预演回包必须标记 dryRun: false')
  assert.equal(executed.value.deleted, preview.value.deleted, '预演计数与执行结果必须一致')
  assert.equal(executed.value.freedChars, preview.value.freedChars, '预演释放量与执行结果必须一致')
  // 两次调用各自按 Date.now() 算 cutoff，跨毫秒边界会差 1ms；判据是「同一个阈值语义」，
  // 不是同一个字符串 —— 允许一点点时钟漂移，但绝不允许两套阈值公式。
  assert.ok(Math.abs(Date.parse(executed.value.cutoff) - Date.parse(preview.value.cutoff)) < 1000,
    '预演与执行必须用同一条清理天数阈值（只有毫秒级时钟差）')
  assert.equal(store.items.has('old-read'), false, '执行才真的删除')
  assert.ok(logs.some((line) => line.includes('清理：删除 1 条')), '执行日志仍要说「清理：删除」')
})

test('R11 04 cleanup dryRun：0 条时不删、不报删除日志，回包 deleted = 0', async () => {
  const store = makeStore()
  // 去掉唯一该删的那条 ⇒ 候选里只剩受保护的条目。
  store.items.delete('old-read')
  const logs = []
  const dispatch = createDispatch({
    config: Config({}),
    log: (line) => logs.push(line),
    ready: () => store,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
  })
  const before = snapshotOf(store)

  const preview = await dispatch('cleanup', { dryRun: true })
  assert.equal(preview.ok, true)
  assert.equal(preview.value.dryRun, true)
  assert.equal(preview.value.deleted, 0, '没有可清理的条目时必须是 0，不能把受保护的算进来')
  assert.equal(preview.value.freedChars, 0)
  assert.deepEqual(snapshotOf(store), before, '0 条的预演同样不许动任何条目')
  assert.ok(logs.some((line) => line.includes('预演：将清理 0 条')))
  assert.ok(!logs.some((line) => line.includes('清理：删除')))
})
