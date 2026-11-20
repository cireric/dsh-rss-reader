/**
 * 端点入参契约（阶段 5，ADR-0003）。
 *
 * 为什么单独一个文件：
 *  · 表驱动那三条**不经 handler**（直接 safeParse `ENDPOINTS[name].payload`），验的是「声明」这一层本身；
 *  · 端到端那条用一个**碰一下就炸**的 store 替身，证明坏入参在触达 store 之前就被拒 ——
 *    信封（bad-request）与「没有副作用」是同一件事的两面。
 *
 * 契约表按**客户端实际会发的形状**写，不照抄 schema：schema 改坏了，这里应当红。
 * 零入参端点的 valid 故意塞一个多余键：`noPayload` 的语义是「接受并忽略」，要钉住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatch, ENDPOINTS } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'
import { ENDPOINT_NAMES } from '../lib/shared.js'

/** 只要 handler 真的跑起来并碰 store，就立刻炸 —— 坏入参用例据此证明「没有触达」。 */
const EXPLODING_STORE = new Proxy({}, {
  get() { throw new Error('坏入参不该触达 store') },
})

const dispatchOf = () => createDispatch({
  config: Config({}),
  log: () => {},
  ready: () => EXPLODING_STORE,
  refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
  lastRefreshCompletedAt: () => undefined,
  articleAttempts: new Map(),
})

/** 一行 = 一个端点的入参契约：最小合法 payload + 必须被拒的样本。 */
const CONTRACTS = {
  searchItems: {
    valid: { text: '地球' },
    invalid: [
      {},
      { text: '' },
      { text: '字'.repeat(121) },
      { text: 'x', from: '2026-02-30' },
      { text: 'x', from: '2026-05-02', to: '2026-05-01' },
      { text: 'x', cursor: 'a'.repeat(2049) },
    ],
  },
  overview: {
    valid: { folder: 'tech', cursor: null },
    alsoValid: [null],
    invalid: [
      { folder: 'a', tagId: 'b' },
      { folder: 5 },
      { tagId: '' },
      { cursor: 5 },
    ],
  },
  refresh: {
    valid: { folder: null },
    alsoValid: [null],
    invalid: [{ folder: 'a', tagId: 'b' }, { folder: 5 }],
  },
  markRead: {
    valid: { itemIds: ['a'], skipKept: true, before: '2026-01-01T00:00:00.000Z' },
    invalid: [
      {},
      { itemIds: [] },
      { itemIds: 'a' },
      { itemIds: ['a'], skipKept: 'yes' },
      { itemIds: ['a'], before: 5 },
    ],
  },
  unmarkRead: {
    valid: { itemIds: ['a'] },
    invalid: [{}, { itemIds: [] }, { itemIds: 'a' }],
  },
  article: {
    valid: { itemId: 'a' },
    invalid: [{}, { itemId: 5 }, { itemId: '' }],
  },
  duplicateHints: {
    valid: {},
    invalid: [{ itemIds: 'a' }, { itemIds: [1] }],
  },
  saveReadingProgress: {
    valid: { itemId: 'a', contentVersion: 'v1', ratio: 0.5 },
    invalid: [
      { itemId: 'a', contentVersion: 'v1' },
      { itemId: '', contentVersion: 'v1', ratio: 0.5 },
      { itemId: 'a', contentVersion: 'v1', ratio: '0.5' },
    ],
  },
  opmlExport: { valid: { anything: 1 }, invalid: [] },
  opmlImport: {
    valid: { opml: '<opml/>' },
    invalid: [{}, { opml: 5 }],
  },
  discoverFeeds: {
    valid: { url: 'https://example.com/feed.xml' },
    invalid: [{}, { url: '   ' }, { url: 5 }],
  },
  addFeed: {
    // 空串仍走 ok + failed（金标准）：形状声明只管「是不是字符串」。
    valid: { url: '' },
    invalid: [{}, { url: 5 }],
  },
  removeFeed: {
    valid: { url: 'https://example.com/feed.xml' },
    invalid: [{}, { url: '' }, { url: 5 }],
  },
  cleanup: { valid: { anything: 1 }, invalid: [] },
  toggleKeepUnread: {
    valid: { itemId: 'a' },
    invalid: [{}, { itemId: '' }],
  },
  viewPreferences: { valid: { anything: 1 }, invalid: [] },
  saveViewPreferences: {
    valid: { preferences: {} },
    invalid: [{}],
  },
  listFolders: { valid: { anything: 1 }, invalid: [] },
  createFolder: {
    valid: { name: 'tech' },
    invalid: [{}, { name: 5 }],
  },
  renameFolder: {
    valid: { from: 'a', to: 'b' },
    invalid: [{ from: 'a' }, { to: 'b' }, { from: 1, to: 'b' }],
  },
  deleteFolder: {
    valid: { name: 'tech' },
    invalid: [{}, { name: 5 }],
  },
  moveFeedToFolder: {
    valid: { feedId: 'f', folder: null },
    invalid: [
      { feedId: 'f' },
      { feedId: '', folder: null },
      { feedId: 'f', folder: 5 },
    ],
  },
  reorderFeeds: {
    // 空数组合法（= 什么都没点名 ⇒ 不写盘）；坏样本只验形状，未知 id 由 store 归一而不是这里拒绝。
    valid: { ids: [] },
    alsoValid: [{ ids: ['https://a.example/feed.xml'] }],
    invalid: [{}, { ids: 'f1' }, { ids: [1] }],
  },
  listTags: { valid: { anything: 1 }, invalid: [] },
  createTag: {
    valid: { name: 'tag' },
    invalid: [{}, { name: 5 }],
  },
  renameTag: {
    valid: { id: 't', name: 'tag2' },
    invalid: [{ id: 't' }, { name: 'tag2' }, { id: 1, name: 'tag2' }],
  },
  deleteTag: {
    valid: { id: 't' },
    invalid: [{}, { id: 5 }],
  },
  setItemTags: {
    valid: { itemId: 'i', tagIds: [] },
    invalid: [
      { itemId: 'i' },
      { itemId: 'i', tagIds: 'x' },
      { itemId: 'i', tagIds: [1] },
    ],
  },
  toggleStar: {
    valid: { itemId: 'a' },
    invalid: [{}, { itemId: 5 }, { itemId: '' }],
  },
}

test('入参声明：全部端点都有 payload，表与名字表一致', () => {
  assert.deepEqual(Object.keys(ENDPOINTS).sort(), [...ENDPOINT_NAMES].sort())
  assert.deepEqual(Object.keys(CONTRACTS).sort(), [...ENDPOINT_NAMES].sort(), '契约表必须覆盖全部端点')
  for (const name of ENDPOINT_NAMES) {
    assert.ok(ENDPOINTS[name].payload, name + ' 缺少 payload 声明')
  }
  for (const [name, contract] of Object.entries(CONTRACTS)) {
    if (contract.invalid.length === 0) continue
    assert.ok((ENDPOINTS[name].invalidMessage ?? '').length > 0, name + ' 有坏入参路径却没有 invalidMessage')
  }
})

test('入参声明：每个端点的最小合法 payload 都能通过', () => {
  for (const [name, contract] of Object.entries(CONTRACTS)) {
    for (const valid of [contract.valid, ...(contract.alsoValid ?? [])]) {
      const result = ENDPOINTS[name].payload.safeParse(valid)
      assert.equal(result.success, true,
        name + ' 的合法 payload 被拒：' + JSON.stringify(valid) + ' → ' + (result.success ? '' : JSON.stringify(result.error.issues)))
    }
  }
})

test('入参声明：每条坏样本都被拒，并给出字段路径', () => {
  let checked = 0
  for (const [name, contract] of Object.entries(CONTRACTS)) {
    for (const bad of contract.invalid) {
      const result = ENDPOINTS[name].payload.safeParse(bad)
      assert.equal(result.success, false, name + ' 放过了坏样本 ' + JSON.stringify(bad))
      assert.ok(result.error.issues.length > 0, name + ' 的坏样本没有 issue')
      assert.ok(result.error.issues.every((issue) => Array.isArray(issue.path)), name + ' 的 issue 没有路径')
      checked += 1
    }
  }
  // 67 是契约表的当前条数（R3 02 的 reorderFeeds 带 3 条负例：64 + 3）；
  // 删样本、或新增端点忘了配负例，都必须在这里显形。
  assert.equal(checked, 67, '坏样本条数变了（当前 ' + checked + '）—— 检查契约表是否漏了必填字段')
})

test('坏入参：每个接 payload 的端点，第一条坏样本都经 dispatch 回 bad-request', async () => {
  const dispatch = dispatchOf()
  const covered = []
  for (const [endpoint, contract] of Object.entries(CONTRACTS)) {
    if (contract.invalid.length === 0) continue
    covered.push(endpoint)
    const bad = contract.invalid[0]
    const result = await dispatch(endpoint, bad)
    assert.equal(result.ok, false, endpoint + ' 的第一条坏样本被放行：' + JSON.stringify(bad))
    assert.equal(result.error.code, 'bad-request',
      endpoint + ' 的第一条坏样本没有走统一信封（' + JSON.stringify(bad) + '）')
  }
  // R3 02 加了 reorderFeeds（有负例且经 dispatch 验过），所以接 payload 的端点从 23 变 24。
  assert.equal(covered.length, 24, '接 payload 的端点应当是 24 个，实际 ' + covered.length)
})

test('坏入参：统一 bad-request 信封、details.issues 指出字段，且不触达 store', async () => {
  const dispatch = dispatchOf()
  const cases = [
    ['saveViewPreferences', {}, 'preferences'],
    ['saveReadingProgress', { itemId: 'a', contentVersion: 'v1' }, 'ratio'],
    ['markRead', { itemIds: 'x' }, 'itemIds'],
    ['toggleStar', { itemId: 5 }, 'itemId'],
    ['toggleStar', { itemId: '' }, 'itemId'],
    ['overview', { folder: 'f', tagId: 't' }, ''],
  ]
  for (const [endpoint, payload, field] of cases) {
    const result = await dispatch(endpoint, payload)
    const label = endpoint + ' ' + JSON.stringify(payload)
    assert.equal(result.ok, false, label + ' 必须失败')
    assert.equal(result.error.code, 'bad-request', label + ' 的失败码')
    assert.equal(typeof result.error.message, 'string', label + ' 缺 message')
    assert.ok(result.error.message.length > 0, label + ' 的 message 是空的')
    const issues = result.error.details.issues
    assert.ok(Array.isArray(issues) && issues.length > 0, label + ' 的 details.issues 必须是非空数组')
    if (field !== '') {
      assert.ok(issues.some((issue) => issue.path.join('.') === field), label + ' 的 issue 必须指出 ' + field)
    }
  }
})
