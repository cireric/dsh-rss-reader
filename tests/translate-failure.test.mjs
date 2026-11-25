/**
 * 翻译失败、重试与停止（R7 05，spec §4.4 / §4.7 / §5.1 / 验收 8/9）。
 *
 * 钉的是读者能看见的承诺：
 *   ① 宿主把模型失败分成四类原因（timeout / truncated / empty / unavailable），文案各一句；
 *   ② 客户端只按 `details.reason` 分类（RpcError 透传），不猜 message；
 *   ③ 一批失败不影响其余批；失败批每个位置有中文原因、批首只有一个重试按钮，
 *      点重试只重发那一批的 indices；
 *   ④ 连续 3 批失败 ⇒ 整篇停止，不再发第 4 批，顶部显示最后原因；
 *   ⑤ 单块回填失败（list 行数不等 / 空白译文）只回退该块，不计批失败、没有重试按钮；
 *   ⑥ 「译自 {model}」取回包 model（不是客户端设置），多批以最后一条非空回包为准。
 *
 * 宿主断言走 `createDispatch` + 假 llm；客户端断言走真实 React + jsdom 的共享夹具，
 * 假 rpc 抛真实的 RpcError，保证 `instanceof RpcError` 分支真的被执行到。
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'
import { articleOf, cleanupAll, itemOf, mount, openArticle, skip } from './helpers/translate-harness.mjs'

afterEach(cleanupAll)

// ───────────────────────────── 宿主：四类失败原因 ─────────────────────────────

const STORE = {}

function dispatchWith({ services, deadlineMs } = {}) {
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

/** 假 llm：按给定块序列流式返回；never = 之后永不结束（deadline 用例）。 */
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
const PAYLOAD = { target: 'zh-CN', items: [{ id: 'b0', text: 'Hello' }] }

test('R7 05 宿主失败：deadline 到点 ⇒ translate-failed / timeout', async () => {
  const llm = fakeLlm([], { never: true })
  const dispatch = dispatchWith({ services: { llm, agentDefaultModel: route() }, deadlineMs: 20 })
  const result = await dispatch('translateBatch', PAYLOAD)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'translate-failed')
  assert.equal(result.error.details.reason, 'timeout')
  assert.equal(result.error.message, '超时（60s）')
})

test('R7 05 宿主失败：finish 达到输出上限 ⇒ translate-failed / truncated', async () => {
  const llm = fakeLlm([
    { type: 'text-delta', index: 0, text: '{"items":[{"id":"b0","text":"你好' },
    { type: 'finish', reason: { kind: 'max-tokens' } },
  ])
  const dispatch = dispatchWith({ services: { llm, agentDefaultModel: route() } })
  const result = await dispatch('translateBatch', PAYLOAD)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'translate-failed')
  assert.equal(result.error.details.reason, 'truncated')
  assert.equal(result.error.message, '输出被截断（达到输出上限）')
})

test('R7 05 宿主失败：流里没有可用文本 ⇒ translate-failed / empty', async () => {
  const llm = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }])
  const dispatch = dispatchWith({ services: { llm, agentDefaultModel: route() } })
  const result = await dispatch('translateBatch', PAYLOAD)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'translate-failed')
  assert.equal(result.error.details.reason, 'empty')
  assert.equal(result.error.message, '模型没有返回可用译文')
})

test('R7 05 宿主失败：没有 llm 服务 ⇒ translate-failed / unavailable', async () => {
  // 不传 translateServices：等价于宿主没有 llm 服务（D16：服务缺失不是插件加载失败）。
  const dispatch = dispatchWith({})
  const result = await dispatch('translateBatch', PAYLOAD)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'translate-failed')
  assert.equal(result.error.details.reason, 'unavailable')
  assert.equal(result.error.message, '模型未挂载或无可用路由')
})

// ───────────────────────────── 宿主：六类非法入参 ─────────────────────────────

test('R7 05 宿主入参拒绝：空 / 超 12 项 / 超 6000 字符 / 重复 id / 全空白 / 坏语言', async () => {
  const llm = fakeLlm([])
  const dispatch = dispatchWith({ services: { llm, agentDefaultModel: route() } })
  const badPayloads = [
    { target: 'zh-CN', items: [] },
    {
      target: 'zh-CN',
      items: Array.from({ length: 13 }, (_, index) => ({ id: 'b' + index, text: '字' })),
    },
    { target: 'zh-CN', items: [{ id: 'b0', text: '字'.repeat(6001) }] },
    {
      target: 'zh-CN',
      items: [{ id: 'b0', text: '甲' }, { id: 'b0', text: '乙' }],
    },
    { target: 'zh-CN', items: [{ id: 'b0', text: '   ' }] },
    { target: 'xx', items: [{ id: 'b0', text: '甲' }] },
  ]
  for (const payload of badPayloads) {
    const result = await dispatch('translateBatch', payload)
    assert.equal(result.ok, false, JSON.stringify(payload))
    assert.equal(result.error.code, 'bad-request', JSON.stringify(payload))
  }
  assert.equal(llm.calls.length, 0, '六类坏入参都必须在触达模型之前被拒')
})

// ───────────────────────────── 客户端：批失败 UI / 重试 ─────────────────────────────

function translationOf(h) {
  return [...h.store.get().translations.values()][0]
}

function failureOf(reason) {
  return {
    error: {
      code: 'translate-failed',
      message: '模型失败：' + reason,
      details: { reason },
    },
  }
}

function successOf(payload, model = 'fake/m') {
  return {
    value: {
      model,
      items: payload.items.map((item) => ({ id: item.id, text: '译:' + item.text })),
    },
  }
}

async function waitDone(h, timeout = 10000) {
  await h.waitFor(() => translationOf(h)?.status === 'done', { label: '整篇翻译完成', timeout })
  await h.settle()
}

test('R7 05 批失败：其余批继续，失败处显示原因 + 批首一个重试按钮，点重试只重发那一批', skip, async () => {
  // 1000 + 1000 = 2000 ⇒ [b0,b1] 一批；b2 单独一批。第一批失败，第二批必须照常继续。
  const blocks = [
    { kind: 'p', text: '甲'.repeat(1000) },
    { kind: 'p', text: '乙'.repeat(1000) },
    { kind: 'p', text: '丙'.repeat(1000) },
  ]
  let calls = 0
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', blocks) },
    translateBatch: async (payload) => {
      calls += 1
      // 只让第一次（b0+b1）失败；重试时同一批必须成功，才能验证重试真的重发了整批。
      return calls === 1 ? failureOf('timeout') : successOf(payload)
    },
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await waitDone(h)

    assert.equal(h.calls('translateBatch').length, 2, '第一批失败后第二批必须继续发')
    const entry = translationOf(h)
    assert.equal(entry.failures.size, 1, '失败只记在第一批上')
    assert.deepEqual(entry.failures.get(0).indices, [0, 1], '失败批必须保留整批 indices')
    assert.equal(entry.failures.get(0).reason, 'timeout')
    assert.equal(entry.blocks.size, 1, '未失败的 b2 必须已写入；失败批块不冒充译文')

    const reasons = h.$$('[data-rss-translation-failure]')
    assert.equal(reasons.length, 2, '失败批内每个块位置都要显示原因')
    assert.match(reasons[0].textContent, /本批翻译失败：超时（60s）/)
    assert.match(reasons[1].textContent, /本批翻译失败：超时（60s）/)
    const retries = h.$$('[data-rss-translation-retry]')
    assert.equal(retries.length, 1, '一个失败批只能有一个重试按钮')
    assert.equal(retries[0].getAttribute('data-rss-translation-retry'), '0', '重试按钮放在批首块位置')
    assert.equal(retries[0].getAttribute('aria-label'), '重试本批翻译', '批级重试按钮必须有可读标签（spec §5.6）')

    retries[0].click()
    await h.waitFor(() => translationOf(h)?.failures.size === 0, { label: '重试成功' })
    await h.settle()
    const retried = h.calls('translateBatch')
    assert.equal(retried.length, 3)
    assert.deepEqual(retried[2].payload.items.map((item) => item.id), ['b0', 'b1'], '重试只重发那一批')
    assert.equal(h.$('[data-rss-translation-retry]'), null, '重试成功后按钮消失')
    const after = translationOf(h)
    assert.equal(after.blocks.size, 3, '重试不覆盖 / 不清空已成功的 b2')
    assert.equal(after.done, 3)
    assert.equal(after.status, 'done')
  } finally {
    h.cleanup()
  }
})

test('R7 05 首批失败后重试：重试请求再带 title；回包无 title ⇒ 显示「标题未翻译」', skip, async () => {
  // spec §4.3：标题随第一批发送。首批失败后 firstBatch 已经翻页，重试该批必须**再带一次**标题，
  // 否则标题永远没有第二次机会（评审修复 A6）。这里让首批失败、重试成功且回包故意不带 title。
  const blocks = [{ kind: 'p', text: '段落' }]
  let calls = 0
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', blocks) },
    translateBatch: async (payload) => {
      calls += 1
      if (calls === 1) return failureOf('timeout')
      return {
        value: {
          model: 'fake/m',
          items: payload.items.map((item) => ({ id: item.id, text: '译:' + item.text })),
        },
      }
    },
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => {
      const entry = translationOf(h)
      return entry?.status === 'done' && entry.failures.size === 1
    }, { label: '首批失败收尾' })
    await h.settle()
    assert.equal(h.calls('translateBatch')[0].payload.title, '文章 a', '首批本来就带标题')

    h.$('[data-rss-translation-retry]').click()
    await h.waitFor(() => translationOf(h)?.failures.size === 0, { label: '重试成功' })
    await h.settle()
    const retried = h.calls('translateBatch')[1].payload
    assert.equal(retried.title, '文章 a', '重试首批必须再次带上标题')
    assert.equal(translationOf(h).titleFailed, true, '带标题的批次成功但回包没有标题 ⇒ 标题未翻译')
    assert.equal(translationOf(h).title, undefined)
    assert.equal(h.$('[data-rss-title-failed]').textContent, '标题未翻译')
  } finally {
    h.cleanup()
  }
})

test('R7 05 连续 3 批失败 ⇒ 整篇停止，不再发第 4 批，顶部显示最后原因', skip, async () => {
  // 3000 字 > 2000 ⇒ 每块独占一批；四批里只允许前三批发出。
  const blocks = Array.from({ length: 4 }, (_, index) => ({ kind: 'p', text: '段'.repeat(3000) + index }))
  const reasons = ['timeout', 'truncated', 'empty']
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', blocks) },
    translateBatch: async () => failureOf(reasons[Math.min(h.calls('translateBatch').length - 1, 2)]),
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => translationOf(h)?.status === 'failed', { label: '整篇停止' })
    await h.settle()
    assert.equal(h.calls('translateBatch').length, 3, '连续第 3 批失败后不许再发第 4 批')
    const entry = translationOf(h)
    assert.equal(entry.stoppedReason, 'empty')
    assert.equal(entry.failures.size, 3)
    assert.equal(h.$('[data-rss-translation-stopped]').textContent, '翻译已停止：模型没有返回可用译文')
    assert.equal(h.$$('[data-rss-translation-failure]').length, 3)
  } finally {
    h.cleanup()
  }
})

test('R7 05 连续失败计数清零：失败 → 成功 → 失败 → 失败 → 成功 仍然跑完全篇', skip, async () => {
  // 五批各一块（3000 字）。只有「连续」三次才停：第 3、4 批的两次失败不能累计到第 1 批头上。
  const blocks = Array.from({ length: 5 }, (_, index) => ({ kind: 'p', text: '章'.repeat(3000) + index }))
  const outcomes = ['timeout', 'ok', 'truncated', 'empty', 'ok']
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', blocks) },
    translateBatch: async (payload) => {
      const index = h.calls('translateBatch').length - 1
      return outcomes[index] === 'ok' ? successOf(payload) : failureOf(outcomes[index])
    },
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await waitDone(h)
    assert.equal(h.calls('translateBatch').length, 5, '中间成功过就必须清零，不能提前停')
    const entry = translationOf(h)
    assert.equal(entry.status, 'done')
    assert.equal(entry.failures.size, 3, '三次失败都保留位置，但从未连续三次')
    assert.equal(entry.done, 2)
    assert.equal(h.$('[data-rss-translation-stopped]'), null)
  } finally {
    h.cleanup()
  }
})

test('R7 05 单块回填失败：list 行数不等 / 空白译文只退回该块，不计批失败、无重试按钮', skip, async () => {
  const blocks = [
    { kind: 'list', ordered: false, items: ['甲', '乙'] },
    { kind: 'p', text: '另一段' },
  ]
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', blocks) },
    translateBatch: async (payload) => ({
      value: {
        model: 'fake/m',
        items: payload.items.map((item) => ({
          id: item.id,
          // b0：两行原文只回一行（行数不等）；b1：纯空白。两者都只是单块无译文。
          text: item.id === 'b0' ? '只有一行' : '   ',
        })),
      },
    }),
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await waitDone(h)
    const entry = translationOf(h)
    assert.equal(entry.failures.size, 0, '单块回填失败不计入批失败')
    assert.equal(h.$$('[data-rss-translation-failure]').length, 0)
    assert.equal(h.$('[data-rss-translation-retry]'), null, '没有批失败就不该有重试按钮')
    assert.equal(h.$('[data-rss-translation="0"]'), null, 'list 行数不等 ⇒ 整块退回原文')
    assert.equal(h.$('[data-rss-translation="1"]'), null, '空白译文 ⇒ 不渲染空段落')
    assert.match(h.$('article.dsh-rss-article-column').textContent, /甲/)
  } finally {
    h.cleanup()
  }
})

// ───────────────────────────── 客户端：「译自 {model}」─────────────────────────────

test('R7 05 「译自」显示回包 model，而不是客户端设置 / 探测路由', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', [{ kind: 'p', text: '段落' }]) },
    // 探测路由是 p/m；回包故意写成另一个模型，断言界面认回包。
    translateBatch: async (payload) => successOf(payload, 'reply/model-9'),
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await waitDone(h)
    assert.equal(h.$('[data-rss-translated-from]').textContent, '译自 reply/model-9')
    assert.equal(translationOf(h).model, 'reply/model-9')
  } finally {
    h.cleanup()
  }
})

test('R7 05 多批 model 不一致：以最后一条非空回包为准', skip, async () => {
  // 1500 + 1500 > 2000 ⇒ 每块独占一批，共三批。第三批 model 为空，应沿用第二批。
  const blocks = Array.from({ length: 3 }, () => ({ kind: 'p', text: '字'.repeat(1500) }))
  const models = ['first/m1', 'second/m2', '']
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', blocks) },
    translateBatch: async (payload) => successOf(payload, models[h.calls('translateBatch').length - 1]),
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await waitDone(h)
    assert.equal(h.calls('translateBatch').length, 3)
    assert.equal(translationOf(h).model, 'second/m2', '空 model 不覆盖上一个非空值')
    assert.equal(h.$('[data-rss-translated-from]').textContent, '译自 second/m2')
  } finally {
    h.cleanup()
  }
})

// ───────────────────────────── 客户端：RpcError 透传 ─────────────────────────────

test('R7 05 RpcError：browserRpc 保留 code / details，message 仍是逐字的 code: message', skip, async () => {
  const h = await mount()
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: false,
        error: {
          code: 'translate-failed',
          message: '模型没有返回可用译文',
          details: { reason: 'empty' },
        },
      }),
    })
    await assert.rejects(h.exports.browserRpc('translateBatch', {}), (error) => {
      assert.ok(error instanceof h.exports.RpcError, '必须是 RpcError，客户端才能按 instanceof 读 details')
      assert.equal(error.code, 'translate-failed')
      assert.deepEqual(error.details, { reason: 'empty' })
      assert.equal(error.message, 'translate-failed: 模型没有返回可用译文', '既有日志 / 提示依赖的 message 必须逐字不变')
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
    h.cleanup()
  }
})
