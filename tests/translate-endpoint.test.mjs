/**
 * translateBatch 端点（R7 01，spec §5.1 / §4.7 / 验收 8）。
 *
 * 全部用 `createDispatch` + 假 `translateServices`：这条链路的宿主侧不读库、不认条目 id，
 * 所以桩 store 只需要存在（端点若碰它，说明纯函数式契约被破坏了）。假 llm 的 `stream()`
 * 返回异步块序列，超时用例用「永不 resolve 的流 + 20ms deadline」——不 sleep 60 秒。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'
import { maxTokensFor } from '../lib/translate.js'

const STORE = {}

function dispatchWith({ services, deadlineMs } = {}) {
  // R7 02 起可用性 / 路由探测要求「目录里确有默认路由」：回落到会话默认时
  // modelCatalog().default 必须存在（spec §4.4）。这里给所有用例一份最小会话目录；
  // 单测要覆盖「没有默认路由」时在 services 里显式传 sessionController 覆盖它。
  const withSession = {
    sessionController: { modelCatalog: async () => ({ default: { provider: 'p', model: 'm' } }) },
    ...services,
  }
  return createDispatch({
    config: Config({}),
    log: () => {},
    ready: () => STORE,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
    ...(services === undefined ? {} : { translateServices: () => withSession }),
    ...(deadlineMs === undefined ? {} : { translateDeadlineMs: deadlineMs }),
  })
}

/** 假 llm：记录收到的 GenerateOptions，按给定块序列流式返回；never = 之后永不结束。 */
function fakeLlm(chunks, { never = false } = {}) {
  const calls = []
  return {
    calls,
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm', reasoning: { efforts: [{ id: 'low' }] } }],
    stream(options) {
      calls.push(options)
      return (async function* stream() {
        for (const chunk of chunks) yield chunk
        if (never) await new Promise(() => {})
      })()
    },
  }
}

const route = () => ({ currentSelection: () => ({ provider: 'p', model: 'm' }) })

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...[...text].reduce((parts, char) => {
      const last = parts[parts.length - 1]
      if (last !== undefined && last.length < 8) last.push(char)
      else parts.push([char])
      return parts
    }, []).map((part) => ({ type: 'text-delta', index: 0, text: part.join('') })),
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

const PAYLOAD = {
  target: 'zh-CN',
  title: 'Hello',
  items: [
    { id: 'b0', text: 'Hello' },
    { id: 'b2', text: 'World' },
  ],
}

test('maxTokensFor：max(4000, min(ceil(chars/4)*4+1200, 64000))', () => {
  assert.equal(maxTokensFor(0), 4000)
  assert.equal(maxTokensFor(1234), 4000)
  assert.equal(maxTokensFor(4000), 5200)
  assert.equal(maxTokensFor(100000), 64000)
})

test('正常返回：模型流拼成 JSON 后按 b 下标还原，回包带 model / title / items', async () => {
  const reply = JSON.stringify({
    title: '你好',
    items: [{ id: 'b0', text: '你好世界' }, { id: 'b2', text: '世界' }],
  })
  const llm = fakeLlm(textChunks(reply))
  const dispatch = dispatchWith({ services: { llm, agentDefaultModel: route() } })
  const result = await dispatch('translateBatch', PAYLOAD)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.value, {
    model: 'm',
    title: '你好',
    items: [{ id: 'b0', text: '你好世界' }, { id: 'b2', text: '世界' }],
  })
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].provider, 'p')
  assert.equal(llm.calls[0].model, 'm')
  assert.match(llm.calls[0].system, /Simplified Chinese/, 'prompt 必须使用语言表的英文语言名')
  const prompt = llm.calls[0].messages[0].content[0].text
  // 2026-11-25 真机实测：适配器会丢掉 system，所以指令必须在 user 消息里，payload 放最后。
  assert.match(prompt, /You are a translation engine/)
  assert.match(prompt, /Output JSON only/, 'user 消息必须明确只输出 JSON、不要解释')
  assert.match(prompt, /b0/)
  assert.match(prompt, /World/)
  assert.ok(prompt.indexOf('Output JSON only') < prompt.indexOf('{"title":"Hello"'), '指令在 payload 之前，payload 放最后')
  assert.ok(prompt.trimEnd().endsWith('}]}'), 'payload 之后不许再跟说明文字')
  assert.equal(typeof llm.calls[0].maxTokens, 'number')
})

test('编号错位（回包多出 b9）⇒ 整批失败，绝不把错位译文贴到别的段落', async () => {
  const reply = JSON.stringify({
    items: [{ id: 'b0', text: '你好世界' }, { id: 'b9', text: '错位' }],
  })
  const llm = fakeLlm(textChunks(reply))
  const dispatch = dispatchWith({ services: { llm, agentDefaultModel: route() } })
  const result = await dispatch('translateBatch', PAYLOAD)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'translate-failed')
  assert.equal(result.error.details.reason, 'empty')
  assert.equal(result.error.message, '模型没有返回可用译文')
})

test('空返回（流里没有文本）⇒ translate-failed / empty', async () => {
  const llm = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }])
  const dispatch = dispatchWith({ services: { llm, agentDefaultModel: route() } })
  const result = await dispatch('translateBatch', PAYLOAD)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'translate-failed')
  assert.equal(result.error.details.reason, 'empty')
})

test('没有 llm 服务 ⇒ translate-failed / unavailable（不是插件加载失败）', async () => {
  const dispatch = dispatchWith({ services: { agentDefaultModel: route() } })
  const result = await dispatch('translateBatch', PAYLOAD)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'translate-failed')
  assert.equal(result.error.details.reason, 'unavailable')
  assert.equal(result.error.message, '模型未挂载或无可用路由')
})

test('60s deadline 可注入：永不结束的流在 20ms 后回 timeout，而不是挂住', async () => {
  const llm = fakeLlm([], { never: true })
  const dispatch = dispatchWith({ services: { llm, agentDefaultModel: route() }, deadlineMs: 20 })
  const started = Date.now()
  const result = await dispatch('translateBatch', PAYLOAD)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'translate-failed')
  assert.equal(result.error.details.reason, 'timeout')
  assert.equal(result.error.message, '超时（60s）')
  assert.ok(Date.now() - started < 1000, '必须真的按注入的 deadline 返回，不能等 60s')
})

test('输出被截断（finish=max-tokens）⇒ translate-failed / truncated', async () => {
  const partial = '{"items":[{"id":"b0","text":"你好'
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: partial },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ])
  const dispatch = dispatchWith({ services: { llm, agentDefaultModel: route() } })
  const result = await dispatch('translateBatch', PAYLOAD)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'translate-failed')
  assert.equal(result.error.details.reason, 'truncated')
})

test('入参拒绝：空 items / 重复 id 一律 bad-request，且不触达模型', async () => {
  const llm = fakeLlm(textChunks('{}'))
  const dispatch = dispatchWith({ services: { llm, agentDefaultModel: route() } })
  for (const payload of [
    { target: 'zh-CN', items: [] },
    { target: 'zh-CN', items: [{ id: 'b0', text: 'a' }, { id: 'b0', text: 'b' }] },
    { target: 'xx', items: [{ id: 'b0', text: 'a' }] },
  ]) {
    const result = await dispatch('translateBatch', payload)
    assert.equal(result.ok, false, JSON.stringify(payload))
    assert.equal(result.error.code, 'bad-request', JSON.stringify(payload))
  }
  assert.equal(llm.calls.length, 0, '坏入参必须在触达模型之前被拒')
})

test('system 被适配器丢弃也能工作：指令与请求 JSON 都在 user 消息里（2026-11-25 真机 wb 实测）', async () => {
  const reply = JSON.stringify({ items: [{ id: 'b0', text: '你好世界' }] })
  const llm = fakeLlm(textChunks(reply))
  const dispatch = dispatchWith({ services: { llm, agentDefaultModel: route() } })
  // 假适配器只读 user（与真机那条 wb/deepseek-v4.1-flash 的行为一致：system 根本没到模型）。
  const result = await dispatch('translateBatch', { target: 'zh-CN', items: [{ id: 'b0', text: 'Hello' }] })
  assert.equal(result.ok, true, JSON.stringify(result))
  const user = llm.calls[0].messages[0].content[0].text
  assert.match(user, /You are a translation engine/, '指令必须不依赖 system 也能到达模型')
  assert.match(user, /Return only a JSON object/)
  assert.match(user, /"items":\[\{"id":"b0","text":"Hello"\}\]/, '请求 JSON 必须原样在 user 里')
})
