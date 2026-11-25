/**
 * 翻译可用性探测（R7 02，spec §4.1 / §4.4 / §5.1）。
 *
 * 这一层钉四件事：
 *   ① 四种 reason 各一条真实路径（服务缺失 / provider 空 / 模型不存在 / 无会话默认）；
 *   ② 两层路由：settings.json 的显式 provider+model 优先于会话默认，且 effort 不在该模型
 *      的 efforts 列表时被忽略而不是报错；
 *   ③ 30s 内存缓存的三个时刻：窗口内不重探、过期重探、saveSettings 成功后立即失效；
 *   ④ translateBatch 与 translateInfo 用同一条路由判定（不是两套）。
 *
 * 全部经 createDispatch 驱动注入的假服务；时钟用假 now 推进，测试不 sleep 30 秒。
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'
import { createSettingsControl } from '../lib/settings-control.js'
import { invalidateTranslateInfoCache } from '../lib/translate.js'

const STORE = {}

/** 每个用例前清掉模块级缓存：探测结果 30s 缓存是**进程级**的，测试之间必须互相隔离。 */
beforeEach(() => { invalidateTranslateInfoCache() })

/**
 * 假 llm：provider / model 目录可逐项控制，并记录被调用次数（缓存用例据此判「有没有重探」）。
 */
function fakeLlm({
  providers = [{ id: 'p' }],
  models = { p: [{ id: 'm', reasoning: { efforts: [{ id: 'low' }] } }] },
  failProviders = false,
  failModels = false,
} = {}) {
  const state = {
    providers,
    models,
    calls: { providers: 0, models: 0 },
  }
  return {
    state,
    listProviders() {
      state.calls.providers += 1
      if (failProviders) throw new Error('provider 目录炸了')
      return state.providers
    },
    async listModels(provider) {
      state.calls.models += 1
      if (failModels) throw new Error('模型目录炸了')
      return state.models[provider] ?? []
    },
    stream() {
      throw new Error('本文件不测真实流')
    },
  }
}

/** 会话目录 + 当前选择。catalogDefault 传 null 表示「目录里没有默认路由」。 */
function fakeSession({ selection = { provider: 'p', model: 'm' }, catalogDefault = { provider: 'p', model: 'm' } } = {}) {
  return {
    sessionController: { modelCatalog: async () => (catalogDefault === null ? {} : { default: catalogDefault }) },
    agentDefaultModel: { currentSelection: () => selection },
  }
}

function harness({ services, config = Config({}), now } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-translate-info-'))
  const settingsPath = join(dir, 'settings.json')
  const settings = createSettingsControl({ config, settingsPath, log: () => {} })
  const dispatch = createDispatch({
    config,
    log: () => {},
    ready: () => STORE,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
    settings,
    ...(services === undefined ? {} : { translateServices: () => services }),
    ...(now === undefined ? {} : { translateNow: now }),
  })
  return { dispatch, settings, config, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function launch(h, payload = {}) {
  const result = await h.dispatch('translateInfo', payload)
  assert.equal(result.ok, true, '探测是正常观测结果，必须回 ok 信封：' + JSON.stringify(result))
  return result.value
}

test('llm 未挂载 ⇒ llm-unmounted（插件仍能加载，只是翻译不可用）', async () => {
  const h = harness()
  try {
    assert.deepEqual(await launch(h, null), { available: false, reason: 'llm-unmounted' })
  } finally { h.cleanup() }
})

test('llm.listProviders() 为空 ⇒ no-provider', async () => {
  const h = harness({ services: { llm: fakeLlm({ providers: [] }) } })
  try {
    assert.deepEqual(await launch(h), { available: false, reason: 'no-provider' })
  } finally { h.cleanup() }
})

test('显式路由指向目录里没有的模型 ⇒ no-model（不悄悄回落到会话默认）', async () => {
  const config = Config({ translateProvider: 'p', translateModel: 'gone' })
  const h = harness({ services: { llm: fakeLlm(), ...fakeSession() }, config })
  try {
    const info = await launch(h)
    assert.equal(info.available, false)
    assert.equal(info.reason, 'no-model')
    // 设置页要能据此让用户重选：模型目录仍随探测结果下发。
    assert.deepEqual(info.providers, [{ provider: 'p', models: [{ id: 'm', efforts: ['low'] }] }])
  } finally { h.cleanup() }
})

test('服务 / 模型目录取不到也归 no-model（不是 llm-unmounted）', async () => {
  const config = Config({ translateProvider: 'p', translateModel: 'm' })
  const h = harness({ services: { llm: fakeLlm({ failModels: true }), ...fakeSession() }, config })
  try {
    const info = await launch(h)
    assert.equal(info.available, false)
    assert.equal(info.reason, 'no-model')
  } finally { h.cleanup() }
})

test('providers 非空但所有模型目录为空 ⇒ no-model（没配 key 的代理不算可用）', async () => {
  // spec §1.1 的判据：没配 key 的代理 `listModels(provider)` 返回空。providers 非空只说明
  // 适配器挂上了，目录里一个模型都没有时点「译」必然 unavailable —— 文章面不许出按钮。
  const llm = fakeLlm({ models: {} })
  const h = harness({ services: { llm, ...fakeSession() } })
  try {
    const info = await launch(h)
    assert.equal(info.available, false)
    assert.equal(info.reason, 'no-model')
    assert.deepEqual(info.providers, [], '模型目录如实为空，设置页据此显示没有可选模型')
  } finally { h.cleanup() }
})

test('默认路由的 provider 目录为空（别的 provider 有模型）⇒ no-model', async () => {
  // 不能因为「目录里还有别的模型」就放行：会话默认指向的 provider 取不到模型时，
  // 这条默认路由兑现不了，必须回 no-model 而不是 available。
  const llm = fakeLlm({ providers: [{ id: 'p' }, { id: 'q' }], models: { q: [{ id: 'other' }] } })
  const h = harness({ services: { llm, ...fakeSession() } })
  try {
    const info = await launch(h)
    assert.equal(info.available, false)
    assert.equal(info.reason, 'no-model')
    assert.deepEqual(info.providers, [{ provider: 'q', models: [{ id: 'other', efforts: [] }] }])
  } finally { h.cleanup() }
})

test('回落会话默认但 modelCatalog().default 不存在 ⇒ no-default-route', async () => {
  const h = harness({ services: { llm: fakeLlm(), ...fakeSession({ catalogDefault: null }) } })
  try {
    const info = await launch(h)
    assert.equal(info.available, false)
    assert.equal(info.reason, 'no-default-route')
  } finally { h.cleanup() }
})

test('有路由时 available：显式 provider+model 优先，effort 在列表里才带上', async () => {
  const config = Config({ translateProvider: 'p', translateModel: 'm', translateEffort: 'low' })
  const h = harness({ services: { llm: fakeLlm(), ...fakeSession() }, config })
  try {
    const info = await launch(h)
    assert.equal(info.available, true)
    assert.deepEqual(info.route, { provider: 'p', model: 'm', effort: 'low' })
    assert.deepEqual(info.sessionDefault, { provider: 'p', model: 'm' })
    assert.deepEqual(info.providers, [{ provider: 'p', models: [{ id: 'm', efforts: ['low'] }] }])
  } finally { h.cleanup() }
})

test('显式路由的 effort 不在该模型 efforts 里 ⇒ 忽略该字段继续（不报错）', async () => {
  const config = Config({ translateProvider: 'p', translateModel: 'm', translateEffort: 'high' })
  const h = harness({ services: { llm: fakeLlm(), ...fakeSession() }, config })
  try {
    const info = await launch(h)
    assert.equal(info.available, true, 'effort 不合法不许让整条路由失效')
    assert.deepEqual(info.route, { provider: 'p', model: 'm' }, '不支持的 effort 必须被丢掉')
  } finally { h.cleanup() }
})

test('只有 model 没有 provider ⇒ 视为未配置，回落会话默认', async () => {
  const config = Config({ translateModel: 'm2' })
  const llm = fakeLlm({ models: { p: [{ id: 'm' }, { id: 'm2' }] } })
  const h = harness({ services: { llm, ...fakeSession({ selection: { provider: 'p', model: 'm' } }) }, config })
  try {
    const info = await launch(h)
    assert.equal(info.available, true)
    assert.deepEqual(info.route, { provider: 'p', model: 'm' }, '半套显式路由不是路由：必须回落会话默认')
  } finally { h.cleanup() }
})

test('回落会话默认只取 provider+model：会话的 reasoningEffort 不外溢到翻译（真机 2026-11-25）', async () => {
  // 真机：会话默认带 reasoningEffort: 'max'，同一个 12 块 / 1223 字的批，带 effort 时 20.1 s
  // 被 max-tokens 截断、不带 effort 时 9.8 s 正常返回。强度只属于显式路由（spec §4.4），
  // 会话默认不许把它带进翻译请求，否则别处调高的推理强度会悄悄吃掉译文预算。
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm' }],
    stream(options) {
      calls.push(options)
      return (async function* stream() { for (const chunk of jsonChunks(JSON.stringify({ items: [{ id: 'b0', text: '你好' }] }))) yield chunk })()
    },
  }
  const h = harness({ services: { llm, ...fakeSession({ selection: { provider: 'p', model: 'm', reasoningEffort: 'max' } }) } })
  try {
    const info = await launch(h)
    assert.equal(info.available, true)
    assert.deepEqual(info.route, { provider: 'p', model: 'm' }, '会话默认只提供 provider+model')
    const result = await h.dispatch('translateBatch', { target: 'zh-CN', items: [{ id: 'b0', text: 'Hello' }] })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal('reasoningEffort' in calls[0], false, '会话默认的 reasoningEffort 不许出现在翻译流请求里')
  } finally { h.cleanup() }
})

test('30s 缓存：窗口内不重探，过期后重探（假 now，不 sleep）', async () => {
  let clock = 1_000
  const llm = fakeLlm()
  const h = harness({ services: { llm, ...fakeSession() }, now: () => clock })
  try {
    await launch(h)
    assert.equal(llm.state.calls.providers, 1, '第一次探测必须真的问服务')

    await launch(h)
    assert.equal(llm.state.calls.providers, 1, '30s 内第二次探测必须吃缓存')

    clock += 29_999
    await launch(h)
    assert.equal(llm.state.calls.providers, 1, '窗口边界内（29.999s）仍是缓存')

    clock += 1
    await launch(h)
    assert.equal(llm.state.calls.providers, 2, '满 30s 后必须重探')
  } finally { h.cleanup() }
})

test('saveSettings 成功后探测缓存立即失效（不用等 30s）', async () => {
  // 时钟固定在同一个值：只有「显式失效」才可能让第二次探测看到新服务，过期路径被排除。
  const clock = 5_000
  const llm = fakeLlm({ providers: [] })
  const services = { llm, ...fakeSession() }
  const h = harness({ services, now: () => clock })
  try {
    const before = await launch(h)
    assert.equal(before.reason, 'no-provider')
    assert.equal(llm.state.calls.providers, 1)

    // 模型服务「后挂上了」：provider 列表从空变成可用。
    llm.state.providers = [{ id: 'p' }]
    const cached = await launch(h)
    assert.equal(cached.reason, 'no-provider', '没有保存设置时，30s 缓存必须继续生效')
    assert.equal(llm.state.calls.providers, 1)

    const saved = await h.dispatch('saveSettings', { patch: { refreshConcurrency: 6 } })
    assert.equal(saved.ok, true, JSON.stringify(saved))

    const after = await launch(h)
    assert.equal(after.available, true, 'saveSettings 成功后必须立刻重探到可用路由')
    assert.equal(llm.state.calls.providers, 2)
  } finally { h.cleanup() }
})

/** 造一段能通过 translateBatch 解析的流（只关心路由，不关心译文内容）。 */
function jsonChunks(text) {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

test('translateBatch 与 translateInfo 用同一条两层路由：显式 provider/model/effort 落到 stream 请求', async () => {
  const config = Config({ translateProvider: 'p', translateModel: 'm', translateEffort: 'low' })
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm', reasoning: { efforts: [{ id: 'low' }] } }],
    stream(options) {
      calls.push(options)
      return (async function* stream() { for (const chunk of jsonChunks(JSON.stringify({ items: [{ id: 'b0', text: '你好' }] }))) yield chunk })()
    },
  }
  const h = harness({ services: { llm, ...fakeSession({ selection: { provider: 'other', model: 'other-model' } }) }, config })
  try {
    const result = await h.dispatch('translateBatch', { target: 'zh-CN', items: [{ id: 'b0', text: 'Hello' }] })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].provider, 'p', '显式 provider 必须赢过会话默认')
    assert.equal(calls[0].model, 'm')
    assert.equal(calls[0].reasoningEffort, 'low')
  } finally { h.cleanup() }
})

test('translateBatch：不支持的 effort 被忽略，流请求里没有 reasoningEffort 字段', async () => {
  const config = Config({ translateProvider: 'p', translateModel: 'm', translateEffort: 'high' })
  const calls = []
  const llm = {
    listProviders: () => [{ id: 'p' }],
    listModels: async () => [{ id: 'm', reasoning: { efforts: [{ id: 'low' }] } }],
    stream(options) {
      calls.push(options)
      return (async function* stream() { for (const chunk of jsonChunks(JSON.stringify({ items: [{ id: 'b0', text: '你好' }] }))) yield chunk })()
    },
  }
  const h = harness({ services: { llm, ...fakeSession() }, config })
  try {
    const result = await h.dispatch('translateBatch', { target: 'zh-CN', items: [{ id: 'b0', text: 'Hello' }] })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal('reasoningEffort' in calls[0], false, '不支持的 effort 必须完全不出现在请求里')
  } finally { h.cleanup() }
})
