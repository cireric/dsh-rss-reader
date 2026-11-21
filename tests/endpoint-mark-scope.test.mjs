/**
 * `markRead` 的范围标读（ADR-0008）：宿主在**库全量**上按
 * 「范围 × 过滤 × 显示窗 × before × 未读且非保持未读」求值。
 *
 * 为什么这组必须有：A 原先由客户端在 `state.items`（已加载页）上求值，源里有 19 条未读
 * 但已加载页 0 条时，A 的候选是 0（2026-11-21 真机）。判据必须钉在**宿主**这一层，
 * 客户端夹具再真也只是模拟。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'
import { deps } from './helpers/reader-store-memory.mjs'
import { createMemoryStore } from '../lib/memory-store.js'

const A = 'https://a.example/feed'
const B = 'https://b.example/feed'
const READ = '2026-01-02T00:00:00.000Z'

function item(feedId, over = {}) {
  return {
    feedId,
    title: '标题',
    link: 'https://example.com/' + feedId,
    publishedAt: '2026-01-01T00:00:00.000Z',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    starred: false,
    ...over,
  }
}

async function fresh() {
  const store = createMemoryStore()
  store.feeds.set(A, { url: A, title: 'A' })
  store.feeds.set(B, { url: B, title: 'B' })
  return { store, config: Config({}) }
}

async function mark(store, config, payload) {
  const dispatch = createDispatch(deps(store, config))
  const result = await dispatch('markRead', payload)
  assert.equal(result.ok, true, 'markRead 应当成功：' + JSON.stringify(result))
  return result.value
}

/** 未读判据只看 readAt 缺省（与宿主同一条）。 */
const isUnread = (store, id) => store.items.get(id).readAt === undefined

test('范围标读：只标该源，回包带被标 id 供撤销', async () => {
  const { store, config } = await fresh()
  await store.saveItem('a1', item(A))
  await store.saveItem('a2', item(A, { keptUnread: true }))
  await store.saveItem('b1', item(B))
  const reply = await mark(store, config, { feedId: A, skipKept: true })
  assert.deepEqual(reply.ids, ['a1'], '只标 A 源里未读且非保持未读的那条')
  assert.equal(reply.changed, 1)
  assert.equal(isUnread(store, 'a1'), false, 'a1 必须已读')
  assert.equal(isUnread(store, 'a2'), true, '保持未读必须活下来')
  assert.equal(isUnread(store, 'b1'), true, 'B 源的条目不碰')
})

test('范围标读：all + before 只标早于阈值的条目', async () => {
  const { store, config } = await fresh()
  // publishedAt 缺席 ⇒ recency 退到 fetchedAt（与宿主 recencyOf 同一口径）。
  await store.saveItem('old', item(A, { publishedAt: undefined, fetchedAt: '2026-01-01T00:00:00.000Z' }))
  await store.saveItem('recent', item(A, { publishedAt: undefined, fetchedAt: '2026-06-01T00:00:00.000Z' }))
  const reply = await mark(store, config, { all: true, before: '2026-03-01T00:00:00.000Z' })
  assert.deepEqual(reply.ids, ['old'], '新于阈值的不标')
  assert.equal(isUnread(store, 'recent'), true)
})

test('范围标读：dryRun 只数不写（确认框的 N）', async () => {
  const { store, config } = await fresh()
  await store.saveItem('a1', item(A))
  await store.saveItem('a2', item(A))
  await store.saveItem('b1', item(B))
  const reply = await mark(store, config, { feedId: A, dryRun: true })
  assert.equal(reply.count, 2, 'A 源有 2 条未读')
  assert.equal(isUnread(store, 'a1'), true, 'dryRun 不许落库')
  assert.equal(isUnread(store, 'a2'), true, 'dryRun 不许落库')
})

test('范围标读：starred 过滤只标星标的未读', async () => {
  const { store, config } = await fresh()
  await store.saveItem('star', item(A, { starred: true }))
  await store.saveItem('plain', item(A))
  const reply = await mark(store, config, { all: true, starred: true })
  assert.deepEqual(reply.ids, ['star'])
  assert.equal(isUnread(store, 'plain'), true, '未星标的不标')
})

test('范围标读：显示窗只认 publishedAt（无日期永不进窗）', async () => {
  const { store, config } = await fresh()
  await store.saveItem('in', item(A, { publishedAt: '2026-11-20T10:00:00.000Z' }))
  await store.saveItem('out', item(A, { publishedAt: '2026-11-19T10:00:00.000Z' }))
  await store.saveItem('nodate', item(A, { publishedAt: undefined }))
  const reply = await mark(store, config, {
    all: true, from: '2026-11-20T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z',
  })
  assert.deepEqual(reply.ids, ['in'], '窗外的与无日期的都不标')
})

test('范围标读：文件夹只标成员源；标签只标带该标签的条目', async () => {
  const { store, config } = await fresh()
  await store.saveItem('a1', item(A))
  await store.saveItem('b1', item(B))
  await store.createFolder('news')
  await store.moveFeedToFolder(A, 'news')
  const folderReply = await mark(store, config, { folder: 'news' })
  assert.deepEqual(folderReply.ids, ['a1'], '文件夹只含 A 源')

  await store.saveItem('a2', item(A))
  const tag = await store.createTag('重要')
  await store.setItemTags('a2', [tag.id])
  const tagReply = await mark(store, config, { tagId: tag.id })
  assert.deepEqual(tagReply.ids, ['a2'], '标签只标带标签的条目')
})

test('范围标读：不存在的源 / 文件夹 / 标签响亮失败（不静默标 0 条）', async () => {
  const { store, config } = await fresh()
  const dispatch = createDispatch(deps(store, config))
  for (const payload of [{ feedId: 'nope' }, { folder: 'nope' }, { tagId: 'nope' }]) {
    const result = await dispatch('markRead', payload)
    assert.equal(result.ok, false, JSON.stringify(payload) + ' 必须失败')
    assert.equal(result.error.code, 'not-found', JSON.stringify(payload) + ' 的失败码')
  }
})
