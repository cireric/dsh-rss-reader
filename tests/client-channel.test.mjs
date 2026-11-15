/**
 * 假通道自身的判据（票据 02b 的验收项 3：编排逻辑必须有单测）。
 *
 * 为什么这条单测值得存在：通道被三份测试共用，它的「挂起 / 失败 / 归一化」一旦坏了，
 * 表现是**用它的用例静默变弱**（比如挂起没真扣住，于是「迟到的回包不能覆盖」根本测不到）。
 * 所以它自己也要有判据，而不是只靠「下游全绿」间接证明。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFakeChannel } from './helpers/client-channel.mjs'

test('假通道：script 命中即失败，消息可定制', async () => {
  const channel = createFakeChannel({ overview: { items: [] }, script: [{ when: () => true, message: 'injected' }] })
  await assert.rejects(() => channel.rpc('overview', {}), /injected/)
})

test('假通道：hold 真的扣住请求，release(Error) 才失败', async () => {
  const channel = createFakeChannel({
    overview: { items: [] },
    script: [{ when: ({ endpoint }) => endpoint === 'markRead', hold: true }],
  })
  const pending = channel.rpc('markRead', { itemIds: ['a'] })
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(channel.heldCount, 1, '请求必须真的被扣住 —— 否则「在途」类用例根本测不到')
  assert.equal(channel.release(new Error('injected')), 1)
  await assert.rejects(() => pending, /injected/)
  assert.equal(channel.heldCount, 0)
})

test('假通道：payload 过一次 JSON —— 与真实通道同样跨 realm', async () => {
  const channel = createFakeChannel({ overview: { items: [] }, request: (endpoint, payload) => payload })
  const input = { nested: { value: 1 } }
  const echoed = await channel.rpc('echo', input)
  assert.deepEqual(echoed, input)
  assert.notEqual(echoed, input, '处理器拿到的必须是副本（真通道是序列化过去、反序列化回来）')
})

test('假通道：overview 按游标分派，并记录回带的游标', async () => {
  const channel = createFakeChannel({
    overview: { items: ['p1'], pages: { C1: { items: ['p2'] } } },
  })
  assert.deepEqual(await channel.rpc('overview', {}), { items: ['p1'], pages: { C1: { items: ['p2'] } } })
  assert.deepEqual(await channel.rpc('overview', { cursor: 'C1' }), { items: ['p2'] })
  assert.deepEqual(channel.pageCalls, [undefined, 'C1'])
  await assert.rejects(() => channel.rpc('overview', { cursor: 'nope' }), /没有为游标/)
})
