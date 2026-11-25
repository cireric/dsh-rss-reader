/**
 * 中止、继续与全局单任务（R7 06，spec §4.1 / §4.6 / D18 / D19 / 验收 10 / 11 / 15）。
 *
 * 判据只用读者能看见的东西 + 假 rpc 的请求记录：
 *   ① 在飞时点「停止」⇒ 不再发下一批，按钮变「继续翻译（还剩 N/M）」；
 *   ② 点继续只发剩余批，已成功写回的块不重发；
 *   ③ Esc / j / 组件卸载（切面板）同样中止，且回来**不自动续**；
 *   ④ 连点两次「译」只有一场在跑（同一时刻最多一批在飞）。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { articleOf, cleanupAll, itemOf, mount, openArticle, skip } from './helpers/translate-harness.mjs'

afterEach(cleanupAll)

/** 30 块 × 100 字 = 12 / 12 / 6 三批（每批 ≤12 块且 ≤2000 字）。 */
const MANY = Array.from({ length: 30 }, (_, index) => ({ kind: 'p', text: '段'.repeat(100) + index }))

function translationOf(h) {
  return [...h.store.get().translations.values()][0]
}

function successOf(payload) {
  return {
    value: {
      model: 'fake/m',
      items: payload.items.map((item) => ({ id: item.id, text: '译:' + item.text })),
    },
  }
}

/** 可控闸门：release() 之前 translateBatch 一直挂起，用来制造「在途」。 */
function gateOf() {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  return { gate, release }
}

test('R7 06 停止：在途批跑完不再发下一批；继续只补剩余块，已译块不重发', skip, async () => {
  const second = gateOf()
  let inFlight = 0
  let maxInFlight = 0
  let calls = 0
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', MANY) },
    translateBatch: async (payload) => {
      calls += 1
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        if (calls === 2) await second.gate
        return successOf(payload)
      } finally {
        inFlight -= 1
      }
    },
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => h.calls('translateBatch').length === 2, { label: '第二批在途' })
    assert.equal(h.$('[data-rss-translate]').textContent, '停止', '在译时按钮必须是「停止」')
    assert.equal(h.$('[data-rss-translate]').getAttribute('data-rss-translate-state'), 'stop')

    h.$('[data-rss-translate]').click()
    await h.waitFor(() => h.$('[data-rss-translate]').textContent.startsWith('继续翻译'), { label: '停止后按钮变继续' })
    const stopped = translationOf(h)
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.done, 12, '第一批已成功写回的 12 块必须保留')
    assert.equal(stopped.total, 30)
    assert.equal(stopped.blocks.size, 12)
    assert.equal(h.$('[data-rss-translate]').textContent, '继续翻译（还剩 18/30）')

    // 放行在途那一批：spec §4.6 允许它跑完，**结果必须写回**（评审修复 A3）——
    // 否则「继续」会把这一批已经付过钱的段落重发一遍。
    second.release()
    await h.waitFor(() => translationOf(h)?.done === 24, { label: '在途批结果写回已停止的场次' })
    await h.settle()
    assert.equal(h.calls('translateBatch').length, 2, '停止后最多只有那一条在途请求，之后不许再发')
    assert.equal(translationOf(h).status, 'stopped')
    assert.equal(translationOf(h).blocks.size, 24, '在途批的译文必须保留')
    assert.equal(h.$('[data-rss-translate]').textContent, '继续翻译（还剩 6/30）')

    h.$('[data-rss-translate]').click()
    await h.waitFor(() => h.calls('translateBatch').length === 3, { label: '继续只补最后一小批' })
    await h.waitFor(() => translationOf(h)?.status === 'done', { label: '继续后整篇完成' })
    await h.settle()

    const laterIds = h.calls('translateBatch').slice(2)
      .flatMap((call) => call.payload.items.map((item) => item.id))
    for (const call of h.calls('translateBatch').slice(0, 2)) {
      const sentIds = call.payload.items.map((item) => item.id)
      for (const id of sentIds) {
        assert.equal(laterIds.includes(id), false, '继续翻译不许重发已成功写回的块 ' + id)
      }
    }
    assert.deepEqual(laterIds, MANY.map((_, index) => 'b' + index).slice(24),
      '继续只补剩余块（前两批已在停止前 / 在途时写回），且按文档顺序')
    const entry = translationOf(h)
    assert.equal(entry.status, 'done')
    assert.equal(entry.done, 30)
    assert.equal(maxInFlight, 1, '批次必须串行：同一时刻只有一批在飞')
  } finally {
    h.cleanup()
  }
})

test('R7 06 Esc 回列表：在途批跑完后不再发新批', skip, async () => {
  const first = gateOf()
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', MANY) },
    translateBatch: async (payload) => { await first.gate; return successOf(payload) },
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => h.calls('translateBatch').length === 1, { label: '第一批在途' })
    h.press('Escape')
    await h.settle()
    assert.equal(h.store.get().view, 'list', 'Esc 必须回到列表')
    first.release()
    await h.waitFor(() => translationOf(h)?.status === 'stopped', { label: '旧场次被标停' })
    await h.settle()
    assert.equal(h.calls('translateBatch').length, 1, '离开正文后不许再发下一批')
    assert.equal(translationOf(h).blocks.size, 12, '在途批跑完的译文仍要保留（继续时不重发）')
  } finally {
    h.cleanup()
  }
})

test('R7 06 j 换条目：不依赖组件卸载，在途批跑完后不再发新批', skip, async () => {
  const first = gateOf()
  const h = await mount({
    items: [itemOf('a'), itemOf('b')],
    articles: { a: articleOf('a', MANY), b: articleOf('b', [{ kind: 'p', text: '另一篇' }]) },
    translateBatch: async (payload) => { await first.gate; return successOf(payload) },
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => h.calls('translateBatch').length === 1, { label: '第一批在途' })
    h.press('j')
    await h.waitFor(() => h.store.get().article?.itemId === 'b', { label: '换到下一篇' })
    first.release()
    await h.waitFor(() => translationOf(h)?.status === 'stopped', { label: '旧场次被标停' })
    await h.settle()
    assert.equal(h.calls('translateBatch').length, 1, '换条目后不许再给旧文章发新批')
    assert.equal(translationOf(h).blocks.size, 12, '换条目也不许丢掉在途批已产出的译文')
    assert.equal(h.store.get().article?.itemId, 'b')
  } finally {
    h.cleanup()
  }
})

test('R7 06 切面板再回来：译文与进度还在、不自动续；手动继续才发请求', skip, async () => {
  const second = gateOf()
  let calls = 0
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', MANY) },
    translateBatch: async (payload) => {
      calls += 1
      if (calls === 2) await second.gate
      return successOf(payload)
    },
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => h.calls('translateBatch').length === 2, { label: '第二批在途' })
    await h.remount()
    await h.waitFor(() => translationOf(h)?.status === 'stopped', { label: '卸载即中止' })

    const afterSwitch = translationOf(h)
    assert.equal(afterSwitch.status, 'stopped', '切走必须中止，不是继续跑')
    assert.equal(afterSwitch.done, 12, '切回来进度必须还在')
    assert.equal(afterSwitch.blocks.size, 12, '切回来译文必须还在')
    assert.equal(h.store.get().view, 'article', '面板切回来仍停在正文页')
    assert.equal(h.$('[data-rss-translate]').textContent, '继续翻译（还剩 18/30）')
    assert.equal(h.calls('translateBatch').length, 2, '切回来不许自动续翻')

    second.release()
    await h.waitFor(() => translationOf(h)?.done === 24, { label: '在途批结果写回' })
    await h.settle()
    assert.equal(h.calls('translateBatch').length, 2, '在途批的迟到回包也不许触发后续批')
    assert.equal(h.$('[data-rss-translate]').textContent, '继续翻译（还剩 6/30）')

    h.$('[data-rss-translate]').click()
    await h.waitFor(() => h.calls('translateBatch').length === 3, { label: '手动继续发最后一小批' })
    await h.waitFor(() => translationOf(h)?.status === 'done', { label: '继续完成' })
  } finally {
    h.cleanup()
  }
})

test('R7 06 切到设置再回来：同样中止；重开文章后显示继续，不自动续', skip, async () => {
  const first = gateOf()
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', MANY) },
    translateBatch: async (payload) => { await first.gate; return successOf(payload) },
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => h.calls('translateBatch').length === 1, { label: '第一批在途' })
    h.store.openSettings()
    await h.settle()
    assert.equal(h.store.get().view, 'settings')
    first.release()
    await h.waitFor(() => translationOf(h)?.status === 'stopped', { label: '切设置即中止' })
    await h.settle()
    assert.equal(h.calls('translateBatch').length, 1, '切设置后不许再发新批')

    h.store.closeSettings()
    await h.store.openArticle()
    await h.waitFor(() => h.store.get().article?.itemId === 'a', { label: '重开文章' })
    await h.settle()
    assert.equal(translationOf(h).blocks.size, 12, '在途批跑完的译文仍要保留（不是白花钱）')
    assert.equal(translationOf(h).done, 12)
    assert.equal(h.$('[data-rss-translate]').textContent, '继续翻译（还剩 18/30）')
    assert.equal(h.calls('translateBatch').length, 1, '重开文章不许自动续翻')
  } finally {
    h.cleanup()
  }
})

test('R7 06 全局单任务：连点两次「译」只有一场在跑，请求不并发', skip, async () => {
  const gate = gateOf()
  let inFlight = 0
  let maxInFlight = 0
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', MANY) },
    translateBatch: async (payload) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        await gate.gate
        return successOf(payload)
      } finally {
        inFlight -= 1
      }
    },
  })
  try {
    await openArticle(h, 'a')
    const first = h.store.requestTranslate()
    await h.waitFor(() => h.calls('translateBatch').length === 1, { label: '第一场已开始' })
    await h.store.requestTranslate()
    await h.settle()
    assert.equal(h.calls('translateBatch').length, 1, '第二次点「译」不许再发一场')
    assert.equal(translationOf(h).status, 'running')
    gate.release()
    await first
    await h.waitFor(() => translationOf(h)?.status === 'done', { label: '第一场跑完' })
    assert.equal(maxInFlight, 1, '两场翻译不许并发')
  } finally {
    h.cleanup()
  }
})

test('R7 06 重试也是一场翻译：重试在飞时点「重译」不许两批并发，done 不重复累计', skip, async () => {
  // 两块各 3000 字 ⇒ 每块独占一批。第一场：b0 成功、b1 失败；随后手动重试 b1（闸门挂住）。
  const blocks = [
    { kind: 'p', text: '甲'.repeat(3000) },
    { kind: 'p', text: '乙'.repeat(3000) },
  ]
  const retryGate = gateOf()
  let calls = 0
  let inFlight = 0
  let maxInFlight = 0
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', blocks) },
    translateBatch: async (payload) => {
      calls += 1
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        if (calls === 3) await retryGate.gate // 第 3 次 = 手动重试 b1
        if (calls === 2) {
          return { error: { code: 'translate-failed', message: '模型失败', details: { reason: 'timeout' } } }
        }
        return successOf(payload)
      } finally {
        inFlight -= 1
      }
    },
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => translationOf(h)?.status === 'done' && translationOf(h)?.failures.size === 1,
      { label: '第一场：b1 失败收尾' })
    assert.equal(h.calls('translateBatch').length, 2)
    assert.equal(translationOf(h).done, 1)

    h.$('[data-rss-translation-retry]').click()
    await h.waitFor(() => h.calls('translateBatch').length === 3, { label: '重试在飞' })

    // 重试还挂着时点「重译」：beginSession 必须先中止并等这条在途请求落地，不能立刻发新批。
    const retranslate = h.$('[data-rss-translate]')
    assert.equal(retranslate.textContent, '重译')
    retranslate.click()
    await h.settle()
    assert.equal(h.calls('translateBatch').length, 3, '重试在飞时不许再发新的一批')

    retryGate.release()
    await h.waitFor(() => translationOf(h)?.status === 'done' && translationOf(h)?.done === 2,
      { label: '重译整篇完成' })
    await h.settle()
    assert.equal(maxInFlight, 1, '同一时刻只许一批在飞（重试也参与全局单任务）')
    assert.equal(h.calls('translateBatch').length, 5, '重试 1 条 + 重译两批')
    assert.equal(translationOf(h).done, 2, 'done 必须等于 total，旧重试回包不许重复累计')
    assert.equal(translationOf(h).total, 2)
    assert.equal(translationOf(h).blocks.size, 2)
  } finally {
    h.cleanup()
  }
})
