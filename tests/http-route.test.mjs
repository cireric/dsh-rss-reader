/**
 * HTTP 传输壳的契约（2026-10-15 H2 Task 2：从 src/index.ts 的 apply 闭包搬进 endpoints.ts）。
 *
 * 这一层是**传输**，不是端点语义：准入检查 → 方法检查 → 读 body → 交给 dispatch → 写信封。
 * 它此前只活在 apply 闭包内（index.ts:310-366），要测它只能走 apply 并造假宿主；
 * 搬出来之后，本文件用**真 node:http server** 直接驱动它——没有假 ctx、没有 process.env 改写。
 *
 * 刻意**不在**本 module 的：路由注册（ctx.webServer.register）与热重载撞 duplicate prefix
 * 时的响亮失败（它依赖 ctx，留在 index.ts）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHttpHandler } from '../lib/endpoints.js'

/** 起一个真 server；handler 由 opts 装配。调用方在 finally 里关。 */
async function serve(opts) {
  const seen = []
  const dispatch = opts.dispatch ?? (async (endpoint) => { seen.push(endpoint); return { ok: true, value: { endpoint } } })
  const handler = createHttpHandler(dispatch, {
    requestRejection: opts.requestRejection ?? (() => undefined),
  })
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = 'http://127.0.0.1:' + server.address().port + '/'
  return {
    url, seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('HTTP 壳：准入未过 → 401/403，且不碰 dispatch', async () => {
  const s = await serve({ requestRejection: () => 401 })
  try {
    const r = await fetch(s.url, { method: 'POST', body: JSON.stringify({ endpoint: 'overview', payload: {} }) })
    assert.equal(r.status, 401)
    assert.equal(await r.text(), 'unauthorized')
    assert.deepEqual(s.seen, [], '准入没过就不许进 dispatch')

    const f = await serve({ requestRejection: () => 403 })
    try {
      const rf = await fetch(f.url, { method: 'POST', body: '{}' })
      assert.equal(await rf.text(), 'forbidden', '403 的文案逐字保留')
    } finally { await f.close() }
  } finally { await s.close() }
})

test('HTTP 壳：非 POST → 405 method not allowed', async () => {
  const s = await serve({})
  try {
    const r = await fetch(s.url, { method: 'GET' })
    assert.equal(r.status, 405)
    assert.equal(await r.text(), 'method not allowed')
  } finally { await s.close() }
})

test('HTTP 壳：转发 endpoint 与 payload 给 dispatch（缺省成空串与 undefined）', async () => {
  const s = await serve({})
  try {
    const r = await fetch(s.url, { method: 'POST', body: JSON.stringify({ endpoint: 'markRead', payload: { itemIds: ['x'] } }) })
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), /application\/json/)
    const body = await r.json()
    assert.equal(body.ok, true)
    assert.deepEqual(s.seen, ['markRead'])

    // 完全没有 endpoint 字段 ⇒ String(undefined ?? '') = '' ⇒ dispatch 收到空串（不是 undefined）
    const empty = await fetch(s.url, { method: 'POST', body: JSON.stringify({}) })
    assert.equal(empty.status, 200)
    assert.deepEqual(s.seen, ['markRead', ''], '缺省端点必须落成空串，由 dispatch 回 unknown-endpoint')
  } finally { await s.close() }
})

test('HTTP 壳：dispatch 抛错或 body 超限 → bad-request 信封（不抛到连接层）', async () => {
  const boom = await serve({ dispatch: async () => { throw new Error('boom') } })
  try {
    const r = await fetch(boom.url, { method: 'POST', body: JSON.stringify({ endpoint: 'overview' }) })
    assert.equal(r.status, 200, '失败也要走 200 信封——调用方按 code 分支，不按 HTTP 状态')
    const body = await r.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, 'bad-request')
    assert.match(body.error.message, /boom/)
  } finally { await boom.close() }

  const big = await serve({})
  try {
    const r = await fetch(big.url, { method: 'POST', body: JSON.stringify({ endpoint: 'overview', pad: 'x'.repeat(300 * 1024) }) })
    assert.equal(r.status, 200)
    const body = await r.json()
    assert.equal(body.ok, false, '超过 256 KiB 的 body 必须响亮拒绝，不许静默截断')
    assert.equal(body.error.code, 'bad-request')
    assert.deepEqual(big.seen, [], 'body 没过就不许进 dispatch')
  } finally { await big.close() }
})