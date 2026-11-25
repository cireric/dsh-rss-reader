/**
 * 整篇翻译的客户端链路（R7 04，spec §4.3 / §4.6 / §4.8 / 验收 3/4/5/6/10）。
 *
 * 这里只钉票面承诺的可见行为：
 *   ① 第一批 = 视口内可见块（用桩 getBoundingClientRect 喂矩形），可见集为空才从第一块退化；
 *   ② 之后批次串行、每批 ≤12 块 / ≤2000 字符（单块 2000–6000 独占 ≤6000）；
 *   ③ 进度从 1/N 到 N/N，全部完成 status='done'；
 *   ④ 可翻字符 30001 ⇒ 零请求并提示；恰好 30000 ⇒ 15 批正常完成；
 *   ⑤ 切条目后不再发新批（在途最多 +1 后不变）。
 *
 * 假 rpc 记录每批 payload —— 判据是「用户能看到的批次与进度」，不是内部计划数组。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { articleOf, cleanupAll, itemOf, mount, openArticle, skip } from './helpers/translate-harness.mjs'

afterEach(cleanupAll)

/** 当前唯一的译文条目（本组用例每篇只翻译一场）。 */
function translationOf(h) {
  return [...h.store.get().translations.values()][0]
}

/** 等这一场翻译进入完成态（整篇多批，给足超时）。 */
async function waitDone(h, timeout = 10000) {
  await h.waitFor(() => translationOf(h)?.status === 'done', { label: '整篇翻译完成', timeout })
}

/**
 * 只让 0 号块落在视口里：容器 0..80，块高 50、间距 100。
 * 其余元素返回零矩形 —— 正文布局在 jsdom 里本来就不存在，本用例只关心选批。
 */
function stubViewport(h) {
  h.win.Element.prototype.getBoundingClientRect = function () {
    const block = this.getAttribute?.('data-rss-block')
    if (block !== null && block !== undefined) {
      const index = Number(block)
      const top = 10 + index * 100
      return { top, bottom: top + 50, left: 0, right: 600 }
    }
    if (this.getAttribute?.('data-rss-scroll') === 'article') {
      return { top: 0, bottom: 80, left: 0, right: 600 }
    }
    return { top: 0, bottom: 0, left: 0, right: 0 }
  }
}

test('R7 04 视口优先：第一批只含屏幕内可见块，其余按文档顺序续批', skip, async () => {
  const blocks = [
    { kind: 'p', text: '第一段' },
    { kind: 'p', text: '第二段' },
    { kind: 'p', text: '第三段' },
  ]
  const h = await mount({ items: [itemOf('a')], articles: { a: articleOf('a', blocks) } })
  try {
    await openArticle(h, 'a')
    stubViewport(h)
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => h.calls('translateBatch').length >= 1, { label: '发出第一批' })
    const first = h.calls('translateBatch')[0].payload
    assert.deepEqual(first.items.map((item) => item.id), ['b0'], '屏幕内只有 b0，第一批不许把 b1/b2 也带上')
    await waitDone(h)
    const payloads = h.calls('translateBatch').map((call) => call.payload)
    assert.equal(payloads.length, 2, 'b0 一批 + 剩余两块一批')
    assert.deepEqual(payloads[1].items.map((item) => item.id), ['b1', 'b2'], '剩余批按文档顺序')
    const entry = translationOf(h)
    assert.equal(entry.done, 3)
    assert.equal(entry.total, 3)
  } finally {
    h.cleanup()
  }
})

test('R7 04 串行且守批次上限：同时只有一批在飞，≤12 块 / ≤2000 字符', skip, async () => {
  const blocks = Array.from({ length: 30 }, (_, index) => ({ kind: 'p', text: '段'.repeat(100) + index }))
  let inFlight = 0
  let maxInFlight = 0
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', blocks) },
    translateBatch: async (payload) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      // 给后一批一个「抢跑」的机会：真串行时它永远等不到。
      await new Promise((resolve) => setTimeout(resolve, 2))
      inFlight -= 1
      return { value: { model: 'fake/m', items: payload.items.map((item) => ({ id: item.id, text: '译:' + item.text })) } }
    },
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await waitDone(h)
    const payloads = h.calls('translateBatch').map((call) => call.payload)
    assert.equal(maxInFlight, 1, '同一时刻只许一批在飞')
    assert.deepEqual(payloads.map((payload) => payload.items.length), [12, 12, 6])
    for (const payload of payloads) {
      assert.ok(payload.items.length <= 12, '每批 ≤12 块')
      const chars = payload.items.reduce((sum, item) => sum + item.text.length, 0)
      assert.ok(chars <= 2000, '每批 ≤2000 字符，实际 ' + chars)
    }
    const ids = payloads.flatMap((payload) => payload.items.map((item) => item.id))
    assert.deepEqual(ids, blocks.map((_, index) => 'b' + index), '批次按文档顺序覆盖全篇、不重不漏')
    const entry = translationOf(h)
    assert.equal(entry.status, 'done')
    assert.equal(entry.done, 30)
    assert.equal(entry.total, 30)
  } finally {
    h.cleanup()
  }
})

test('R7 04 进度：30000 字符恰好放行，15 批从 1/15 走到 15/15', skip, async () => {
  const blocks = Array.from({ length: 15 }, () => ({ kind: 'p', text: '字'.repeat(2000) }))
  const h = await mount({ items: [itemOf('a')], articles: { a: articleOf('a', blocks) } })
  try {
    await openArticle(h, 'a')
    const seen = []
    const unsubscribe = h.store.subscribe(() => {
      const entry = translationOf(h)
      if (entry === undefined) return
      const progress = entry.done + '/' + entry.total
      if (seen[seen.length - 1] !== progress) seen.push(progress)
    })
    h.$('[data-rss-translate]').click()
    await waitDone(h)
    unsubscribe()
    assert.deepEqual(
      seen.filter((value) => value !== '0/15'),
      Array.from({ length: 15 }, (_, index) => (index + 1) + '/15'),
      '进度必须从 1/15 递增到 15/15',
    )
    const payloads = h.calls('translateBatch').map((call) => call.payload)
    assert.equal(payloads.length, 15, '30000 / 2000 = 15 批')
    for (const payload of payloads) {
      assert.equal(payload.items.length, 1, '每块 2000 字符 ⇒ 一批只能装一块')
      assert.equal(payload.items[0].text.length, 2000)
    }
    assert.equal(h.$('[data-rss-translate-progress]').textContent, '已译 15/15 块')
    const entry = translationOf(h)
    assert.equal(entry.status, 'done')
    assert.equal(entry.done, 15)
    assert.equal(entry.total, 15)
  } finally {
    h.cleanup()
  }
})

test('R7 04 整篇 30001 字符：直接拒绝并提示，零请求、零条目', skip, async () => {
  const blocks = [
    ...Array.from({ length: 14 }, () => ({ kind: 'p', text: '字'.repeat(2000) })),
    { kind: 'p', text: '字'.repeat(2001) },
  ]
  const h = await mount({ items: [itemOf('a')], articles: { a: articleOf('a', blocks) } })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.settle()
    assert.equal(h.calls('translateBatch').length, 0, '超过 30000 时一条请求都不许发')
    assert.equal(h.store.get().translations.size, 0, '拒绝不留半截翻译态')
    const notice = h.store.get().notice ?? ''
    assert.match(notice, /30001/)
    assert.match(notice, /30000/)
    assert.equal(h.$('[data-rss-translate-progress]'), null)
  } finally {
    h.cleanup()
  }
})

test('R7 04 长块三档：5000 字独占一批，6001 字原位标「段落过长未翻译」', skip, async () => {
  const blocks = [
    { kind: 'p', text: '超'.repeat(6001) },
    { kind: 'p', text: '长'.repeat(5000) },
    { kind: 'p', text: '短' },
  ]
  const h = await mount({ items: [itemOf('a')], articles: { a: articleOf('a', blocks) } })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await waitDone(h)
    const payloads = h.calls('translateBatch').map((call) => call.payload)
    assert.deepEqual(payloads.map((payload) => payload.items.map((item) => item.id)), [['b1'], ['b2']])
    assert.equal(payloads[0].items[0].text.length, 5000, '2000–6000 的块独占一批，原样整块发送')
    assert.equal(h.$$('[data-rss-translation="0"]').length, 0, '超长块不产生译文段')
    assert.equal(h.$('[data-rss-translation-too-long="0"]').textContent, '段落过长未翻译')
    const entry = translationOf(h)
    assert.equal(entry.total, 2, 'Y 不含超长块')
    assert.equal(entry.done, 2)
    assert.equal(entry.status, 'done')
  } finally {
    h.cleanup()
  }
})

test('R7 04 切条目中止：在途那批跑完后不再发新批', skip, async () => {
  const blocks = Array.from({ length: 30 }, (_, index) => ({ kind: 'p', text: '段'.repeat(100) + index }))
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const h = await mount({
    items: [itemOf('a'), itemOf('b')],
    articles: {
      a: articleOf('a', blocks),
      b: articleOf('b', [{ kind: 'p', text: '另一篇' }]),
    },
    translateBatch: async (payload) => {
      await gate
      return { value: { model: 'fake/m', items: payload.items.map((item) => ({ id: item.id, text: '译:' + item.text })) } }
    },
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => h.calls('translateBatch').length === 1, { label: '第一批在途' })
    await openArticle(h, 'b')
    release()
    await h.waitFor(() => translationOf(h)?.status === 'stopped', { label: '旧场次被标停' })
    await h.settle()
    assert.equal(h.calls('translateBatch').length, 1, '切条目后最多只有那一条在途请求，之后不许再发')
    assert.equal(h.store.get().article?.itemId, 'b')
  } finally {
    h.cleanup()
  }
})
