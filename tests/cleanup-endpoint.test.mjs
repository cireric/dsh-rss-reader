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
