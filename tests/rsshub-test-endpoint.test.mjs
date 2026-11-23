/**
 * `testRsshub` 端点（R8a 01，spec §4.1 / §4.6 / §7 A11）。
 *
 * 为什么注入 `fetchImpl`：探活的三种失败（超时 / 非 2xx / 非 JSON）都要能在无网络环境里
 * 稳定复现，而且必须能看见宿主传给 fetch 层的 limits ——「不带 trustedTarget」是 A9 的
 * 安全边界，不能只靠读代码相信。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config } from '../lib/config.js'
import { createDispatch } from '../lib/endpoints.js'
import { createMemoryStore } from '../lib/memory-store.js'

/** 一份与生产同形的 dispatch；fetchImpl 是唯一被替换的出网层。 */
function harness(fetchImpl, config = {}) {
  const store = createMemoryStore()
  const dispatch = createDispatch({
    config: Config({ timeoutMs: 4321, maxBytes: 2048, ...config }),
    log: () => {},
    ready: () => store,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
    fetchImpl,
  })
  return { dispatch }
}

/** 桩抓取：记录每次调用的入参，回一个预设结果。 */
function stubFetch(result) {
  const calls = []
  const impl = async (url, validators, limits) => {
    calls.push({ url, validators, limits })
    return result
  }
  return { calls, impl }
}

const OK_JSON = { kind: 'ok', body: '{"rules":[{"source":"/","target":"/zhihu/hot"}]}', finalUrl: '' }

test('testRsshub 通过：请求 {base}/api/radar/rules/zhihu.com，200 + 非空 JSON 即 passed，且不带 trustedTarget', async () => {
  const stub = stubFetch(OK_JSON)
  const h = harness(stub.impl)
  const result = await h.dispatch('testRsshub', { base: ' https://rsshub.example/ ' })
  assert.equal(result.ok, true, '探活本身是成功调用（结果在 passed 字段里）')
  assert.equal(result.value.passed, true, '非空 JSON 必须判通过')
  assert.match(result.value.message, /通过/, '通过时要有可展示的结论')
  assert.equal(stub.calls.length, 1, '只探一次')
  assert.equal(stub.calls[0].url, 'https://rsshub.example/api/radar/rules/zhihu.com',
    '地址必须按归一后的源站拼接（入参的尾斜杠不许拼成 //）')
  assert.deepEqual(stub.calls[0].validators, {}, '探活不带条件请求头')
  assert.deepEqual(stub.calls[0].limits, { timeoutMs: 4321, maxBytes: 2048 },
    'limits 只有超时与体积；trustedTarget 缺省 = false（内网实例会被拒，A9）')
})

test('testRsshub 非 2xx：回可读的 HTTP 原因，不抛错、不判通过', async () => {
  const stub = stubFetch({ kind: 'failed', reason: 'HTTP 503' })
  const h = harness(stub.impl)
  const result = await h.dispatch('testRsshub', { base: 'https://rsshub.example' })
  assert.equal(result.ok, true, '探测失败仍是成功的请求（页面要在原地显示原因）')
  assert.equal(result.value.passed, false)
  assert.match(result.value.message, /HTTP 503/, '原因里必须带真实状态码')
})

test('testRsshub 超时：把 fetch 层的超时原因原样带给人看', async () => {
  const stub = stubFetch({ kind: 'failed', reason: '超时（4321ms）' })
  const h = harness(stub.impl)
  const result = await h.dispatch('testRsshub', { base: 'https://rsshub.example' })
  assert.equal(result.value.passed, false)
  assert.match(result.value.message, /超时/, '超时要有可读原因')
})

test('testRsshub 非 JSON / 空 body：都不算通过', async () => {
  for (const body of ['<html>not json</html>', '   ', '']) {
    const stub = stubFetch({ kind: 'ok', body, finalUrl: 'https://rsshub.example/api/radar/rules/zhihu.com' })
    const h = harness(stub.impl)
    const result = await h.dispatch('testRsshub', { base: 'https://rsshub.example' })
    assert.equal(result.value.passed, false, '这份 body 不许判通过：' + JSON.stringify(body))
    assert.ok(result.value.message.length > 0, '失败必须给可读原因')
  }
})

test('testRsshub 未配置 / 非法地址：回可读原因且不发请求', async () => {
  const stub = stubFetch(OK_JSON)
  const h = harness(stub.impl)
  for (const [base, pattern] of [
    ['', /未配置/],
    ['https://rsshub.example/api', /不合法/],
    ['ftp://rsshub.example', /不合法/],
  ]) {
    const result = await h.dispatch('testRsshub', { base })
    assert.equal(result.ok, true, '地址问题不是请求形状错误：' + base)
    assert.equal(result.value.passed, false, '地址问题不许判通过：' + base)
    assert.match(result.value.message, pattern, '原因要能直接显示：' + base)
  }
  assert.equal(stub.calls.length, 0, '地址没通过判据时一次网络请求都不许发')
})

test('testRsshub 私网实例：默认 fetchFeed 在出网前就拒绝（只支持公网实例，A9 的同一判据）', async () => {
  const store = createMemoryStore()
  const dispatch = createDispatch({
    config: Config({}),
    log: () => {},
    ready: () => store,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
    // 刻意不注入 fetchImpl：走真实 fetchFeed，验证「不带 trustedTarget」的默认判据。
  })
  const result = await dispatch('testRsshub', { base: 'http://127.0.0.1:1200' })
  assert.equal(result.ok, true)
  assert.equal(result.value.passed, false, '私网实例不许判通过')
  assert.match(result.value.message, /内网/, '原因要说清是内网地址被拒')
})

test('testRsshub 入参形状：base 必须是字符串，缺键回 bad-request', async () => {
  const stub = stubFetch(OK_JSON)
  const h = harness(stub.impl)
  for (const bad of [{}, { base: 5 }, { base: null }]) {
    const result = await h.dispatch('testRsshub', bad)
    assert.equal(result.ok, false, '坏形状必须被拒：' + JSON.stringify(bad))
    assert.equal(result.error.code, 'bad-request')
  }
  assert.equal(stub.calls.length, 0)
})
