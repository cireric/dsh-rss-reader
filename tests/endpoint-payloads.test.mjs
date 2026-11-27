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

/**
 * 显示窗的合法样本与坏样本（R1 02）：overview / refresh 与五个带账端点共用**同一段**声明，
 * 所以坏样本也必须是同一组。五个带账端点各自再写一遍窗口负例，是为了让「某个端点漏挂
 * windowShape / windowRule」在这里当场显形 —— zod 默认丢弃未知键，只测合法样本是测不出来的。
 */
const WINDOW_FROM = '2026-11-20T00:00:00.000Z'
const WINDOW_TO = '2026-11-21T00:00:00.000Z'
const withWindow = (payload) => ({ ...payload, from: WINDOW_FROM, to: WINDOW_TO, todayFrom: WINDOW_FROM })
const windowBadSamples = (payload) => [
  { ...payload, from: WINDOW_FROM },
  { ...payload, to: WINDOW_TO },
  { ...payload, from: WINDOW_TO, to: WINDOW_FROM },
  { ...payload, from: '2026-11-20T00:00:00Z', to: WINDOW_TO },
  { ...payload, from: '2026-11-20T00:00:00.000+08:00', to: WINDOW_TO },
  { ...payload, from: '2026-11-20', to: WINDOW_TO },
  { ...payload, todayFrom: '2026-11-20' },
]

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
    // R1 显示窗：窗口三字段是可选的；合法样本同时钉「三个字段一起给」这条路。
    // R14：源范围（feedId）与 folder / tagId 一样是宿主范围。
    alsoValid: [null, { feedId: 'https://a.example/feed.xml' }, {
      from: '2026-11-20T00:00:00.000Z',
      to: '2026-11-21T00:00:00.000Z',
      todayFrom: '2026-11-20T00:00:00.000Z',
    }],
    invalid: [
      { folder: 'a', tagId: 'b' },
      { feedId: 'a', folder: 'b' },
      { feedId: 'a', tagId: 'b' },
      { feedId: '' },
      { feedId: 5 },
      { folder: 5 },
      { tagId: '' },
      { cursor: 5 },
      // 窗口（ADR-0005 决定 2 / 3）：缺一半、空区间、以及三种会让字符串比较错位的形态。
      { from: '2026-11-20T00:00:00.000Z' },
      { to: '2026-11-21T00:00:00.000Z' },
      { from: '2026-11-21T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' },
      { from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00.000Z' },
      { from: '2026-11-20T00:00:00.000+08:00', to: '2026-11-21T00:00:00.000Z' },
      { from: '2026-11-20', to: '2026-11-21T00:00:00.000Z' },
      { todayFrom: '2026-11-20' },
    ],
  },
  refresh: {
    valid: { folder: null },
    alsoValid: [null, { feedId: 'https://a.example/feed.xml' }, {
      from: '2026-11-20T00:00:00.000Z',
      to: '2026-11-21T00:00:00.000Z',
      todayFrom: '2026-11-20T00:00:00.000Z',
    }],
    invalid: [
      { folder: 'a', tagId: 'b' },
      { feedId: 'a', folder: 'b' },
      { feedId: '' },
      { folder: 5 },
      // refresh 回的是同一页 + 同一份账：不带窗口会在按刷新时把视图悄悄放回全部，
      // 所以它接受**同一段**窗口字段，坏样本与 overview 逐条对齐。
      { from: '2026-11-20T00:00:00.000Z' },
      { to: '2026-11-21T00:00:00.000Z' },
      { from: '2026-11-21T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' },
      { from: '2026-11-20T00:00:00Z', to: '2026-11-21T00:00:00.000Z' },
      { from: '2026-11-20T00:00:00.000+08:00', to: '2026-11-21T00:00:00.000Z' },
      { from: '2026-11-20', to: '2026-11-21T00:00:00.000Z' },
      { todayFrom: '2026-11-20' },
    ],
  },
  markRead: {
    valid: { itemIds: ['a'], skipKept: true, before: '2026-01-01T00:00:00.000Z' },
    alsoValid: [
      withWindow({ itemIds: ['a'] }),
      // ADR-0008：范围标读 / 全库标读 / dryRun 只数
      { feedId: 'https://a.example/feed', skipKept: true },
      { folder: 'news', dryRun: true },
      { tagId: 'tag-1', starred: true },
      { all: true, before: '2026-01-01T00:00:00.000Z' },
    ],
    invalid: [
      {},
      { itemIds: [] },
      { itemIds: 'a' },
      { itemIds: ['a'], skipKept: 'yes' },
      { itemIds: ['a'], before: 5 },
      // 选择器必须恰好一个：两个范围 / 范围+all / itemIds+范围 / itemIds+dryRun 都是坏入参
      { feedId: 'a', folder: 'b' },
      { feedId: 'a', all: true },
      { itemIds: ['a'], all: true },
      { itemIds: ['a'], dryRun: true },
      { skipKept: true },
      ...windowBadSamples({ itemIds: ['a'] }),
    ],
  },
  unmarkRead: {
    valid: { itemIds: ['a'] },
    alsoValid: [withWindow({ itemIds: ['a'] })],
    invalid: [{}, { itemIds: [] }, { itemIds: 'a' }, ...windowBadSamples({ itemIds: ['a'] })],
  },
  article: {
    valid: { itemId: 'a' },
    invalid: [{}, { itemId: 5 }, { itemId: '' }],
  },
  // R9 02：回溯的入参。limit 缺省 20；0 / 51 / 非整数 / 非数字都在声明层拒绝，
  // 归档页只收 http(s)（用户填错协议重试也不会变，属于坏入参）。
  backfillHistory: {
    valid: { feedId: 'https://a.example/feed.xml', archiveUrl: 'https://a.example/archives', limit: 10 },
    alsoValid: [
      { feedId: 'f', archiveUrl: 'http://a.example/archives' },
      { feedId: 'f', archiveUrl: 'https://a.example/archives', limit: 50 },
    ],
    invalid: [
      {},
      { feedId: '', archiveUrl: 'https://a.example/archives' },
      { feedId: 'f', archiveUrl: '' },
      { feedId: 'f' },
      { feedId: 'f', archiveUrl: 'not a url' },
      { feedId: 'f', archiveUrl: 'ftp://a.example/archives' },
      { feedId: 'f', archiveUrl: 'https://a.example/archives', limit: 0 },
      { feedId: 'f', archiveUrl: 'https://a.example/archives', limit: 51 },
      { feedId: 'f', archiveUrl: 'https://a.example/archives', limit: 1.5 },
      { feedId: 'f', archiveUrl: 'https://a.example/archives', limit: '10' },
    ],
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
  cleanup: {
    // 零业务入参：多余键照旧接受（旧语义），null / 缺省也接受；窗口字段则必须合法。
    valid: { anything: 1 },
    alsoValid: [null, {}, withWindow({ anything: 1 })],
    invalid: windowBadSamples({}),
  },
  toggleKeepUnread: {
    valid: { itemId: 'a' },
    alsoValid: [withWindow({ itemId: 'a' })],
    invalid: [{}, { itemId: '' }, ...windowBadSamples({ itemId: 'a' })],
  },
  // R11 01：settings 是零入参读端点（noPayload 接受并忽略 payload）。
  settings: { valid: { anything: 1 }, invalid: [] },
  // R11 02：写端点。patch / resetToDefaults 二选一；每个值走 settings-schema 的同一份范围判据。
  saveSettings: {
    valid: { patch: { refreshFeedsPerRound: 7 } },
    alsoValid: [
      { patch: { refreshFeedsPerRound: 0 } },
      { patch: { refreshFeedsPerRound: 7, cleanupAfterDays: 45 } },
      // R8a 01：带类型的键表 —— 字符串键与数字键走同一份 parseTunableValue。
      { patch: { rsshubBase: 'https://rsshub.example' } },
      { patch: { rsshubBase: '' } },
      // D4.1 的 Partial 允许空对象：空 patch = 无操作成功（不是坏入参）。
      { patch: {} },
      { resetToDefaults: true },
    ],
    invalid: [
      {},
      { patch: { refreshFeedsPerRound: -1 } },
      { patch: { refreshFeedsPerRound: 1000 } },
      { patch: { refreshFeedsPerRound: '7' } },
      { patch: { refreshFeedsPerRound: 7.5 } },
      { patch: { rsshubBase: 'ftp://rsshub.example' } },
      { patch: { rsshubBase: 'https://rsshub.example/api' } },
      { patch: { refreshFeedsPerRound: 7 }, resetToDefaults: true },
      { resetToDefaults: false },
    ],
  },
  // R8a 01：探活入参只有 base（形状归声明，地址合法性归 handler 的唯一判据）。
  testRsshub: {
    valid: { base: 'https://rsshub.example' },
    alsoValid: [{ base: '' }],
    invalid: [{}, { base: 5 }, { base: null }],
  },
  // R8b 03：探索的两个只读端点。`limit` 的默认 / 上限是展示偏好，夹取在 handler（spec §4.3），
  // 声明这一层只判正整数；三筛与游标都只是字符串 / 缺省。
  exploreCatalog: {
    valid: {},
    alsoValid: [
      null,
      { q: 'github', category: 'programming', namespace: 'github', limit: 30, cursor: 'x' },
    ],
    invalid: [
      { q: 5 },
      { category: 5 },
      { namespace: 5 },
      { limit: 0 },
      { limit: 1.5 },
      { limit: '30' },
      { cursor: 5 },
    ],
  },
  // namespace / path 非空是形状；「未知站点 / 未知路由是 404」读目录，归 handler（ADR-0003）。
  exploreBuildUrl: {
    valid: { namespace: 'github', path: '/branches/:user/:repo', values: {} },
    invalid: [
      {},
      { namespace: '', path: '/branches/:user/:repo', values: {} },
      { namespace: 'github', path: '', values: {} },
      { namespace: 'github', path: '/branches/:user/:repo' },
      { namespace: 'github', path: '/branches/:user/:repo', values: { user: 5 } },
    ],
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
    alsoValid: [withWindow({ itemId: 'a' })],
    invalid: [{}, { itemId: 5 }, { itemId: '' }, ...windowBadSamples({ itemId: 'a' })],
  },
  // R7 02：可用性探测是零参端点（浏览器通道把缺省序列化成 null）；传数组 / 原始值仍是坏入参。
  translateInfo: {
    valid: {},
    alsoValid: [null],
    invalid: [[], 'x'],
  },
  // R7 01：翻译一批。形状只判「目标语言在表内 / id 是 b+下标 / 文本非空 / id 不重复」；
  // 批大小与总字符的完整边界留给 05（票面明确拆分）。`title` 是可选的独立字段。
  translateBatch: {
    valid: { target: 'zh-CN', title: '标题', items: [{ id: 'b0', text: 'Hello' }] },
    alsoValid: [{ target: 'ja', items: [{ id: 'b2', text: 'テキスト' }] }],
    invalid: [
      {},
      { target: 'zh-CN', items: [] },
      { target: 'xx', items: [{ id: 'b0', text: 'Hello' }] },
      { target: 'zh-CN', items: [{ id: 'x', text: 'Hello' }] },
      { target: 'zh-CN', items: [{ id: 'b0', text: '   ' }] },
      { target: 'zh-CN', items: [{ id: 'b0', text: 'a' }, { id: 'b0', text: 'b' }] },
      { target: 'zh-CN', items: [{ id: 'b0', text: 'a' }], title: 5 },
    ],
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
  // 116 = R1 01 时的 81 + R1 02 给五个带账端点各补的 7 条窗口负例。
  // 121 = 116 + ADR-0008 给 markRead 补的 5 条选择器负例（两个范围 / 范围+all / ids+all / ids+dryRun / 空选择器）。
  // 129 = 121 + R11 02 的 saveSettings 8 条负例（二选一 / 越界 / 非整数 / 非数字 / 非白名单键）；
  // 空 patch 在 R11 评审 P3 后是合法的空操作，不再是负例。
  // 133 = 129 + R8a 01 的 testRsshub 3 条负例（缺 base / 非字符串 / null）+ saveSettings 的
  // rsshubBase 2 条坏样本（ftp 协议 / 带 path）；原来那条「rsshubBase 是未知键」的负例已随
  // 键表扩容变成合法样本。删样本、或新增端点忘了配负例，都必须在这里显形。
  // 143 = 133 + R9 02 的 backfillHistory 10 条负例（缺字段 / 空串 / 非 URL / 非 http(s) /
  // limit 0 / 51 / 非整数 / 非数字）。
  // 149 = 143 + R14 的 feedId 6 条负例（overview 4：feed+各范围互斥 / 空串 / 非字符串；
  // refresh 2：feed+folder 互斥 / 空串）。
  // 161 = 149 + R8b 03 的 exploreCatalog 7 条（三筛与游标非字符串、limit 非正整数）+ exploreBuildUrl
  // 的 5 条（缺字段 / 空 namespace / 空 path / 缺 values / values 非字符串表）。
  // 168 = 161 + R7 01 的 translateBatch 7 条（缺 target / 空 items / 目标语言不在表内 /
  // id 不是 b+下标 / 文本全空白 / id 重复 / title 非字符串）。
  // 170 = 168 + R7 02 的 translateInfo 2 条（数组 / 原始值不是对象）。
  assert.equal(checked, 170, '坏样本条数变了（当前 ' + checked + '）—— 检查契约表是否漏了必填字段')
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
  // R1 02 给 cleanup 补了窗口负例（它原本是零入参、无负例），所以现在是 25。
  // R11 02 加了 saveSettings（有负例且经 dispatch 验过）：25 → 26。
  // R8a 01 加了 testRsshub（有负例且经 dispatch 验过）：26 → 27。
  // R9 02 加了 backfillHistory（有负例且经 dispatch 验过）：27 → 28。
  // R8b 03 加了 exploreCatalog / exploreBuildUrl（都有负例且经 dispatch 验过）：28 → 30。
  // R7 01 加了 translateBatch（有负例且经 dispatch 验过）：30 → 31。
  // R7 02 加了 translateInfo（零参端点，坏样本经 dispatch 验过）：31 → 32。
  assert.equal(covered.length, 32, '接 payload 的端点应当是 32 个，实际 ' + covered.length)
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
