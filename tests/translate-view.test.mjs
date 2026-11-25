/**
 * 三态视图的客户端链路（R7 03，spec §4.5 / 验收 7 / 12 / 14）。
 *
 * 钉的是读者能看见的承诺：
 *   ① 有译文时默认「译文」，没有译文时切换器不出现；
 *   ② 三枚切换按钮（原文 / 译文 / 对照）可点、带 aria-pressed；
 *   ③ 译文态：可翻块换成译文纯文本，pre / img / table 原样，表格上方标「表格未翻译」；
 *   ④ 对照态：每段原文后紧跟自己的译文、不串段；pre / img / table 只渲染一次；
 *   ⑤ 标题：译文态用译文标题，标题翻译失败回原文标题 + 角标，对照态永远原文标题；
 *   ⑥ list 译文按行还原成 ul/ol，行数不等或空白整块退回原文；
 *   ⑦ 切态不发任何 rpc（渲染切换不该碰模型）。
 *
 * 断言只走 DOM 与公开的 store 动作（setTranslationMode / t 键），不读内部计划数组。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { articleOf, cleanupAll, itemOf, mount, openArticle, skip } from './helpers/translate-harness.mjs'

afterEach(cleanupAll)

/** 覆盖全部块种类：可翻 p/h/list，不可翻 pre/img/table。 */
const VIEW_BLOCKS = [
  { kind: 'p', text: '段落一' },
  { kind: 'pre', text: 'const x = 1' },
  { kind: 'h', level: 2, text: '小标题' },
  { kind: 'img', src: 'https://img.example/x.png', alt: '图' },
  { kind: 'table', header: ['列'], rows: [['值']] },
  { kind: 'list', ordered: false, items: ['甲', '乙'] },
  { kind: 'list', ordered: true, items: ['一', '二'] },
]

const VIEW_TRANSLATIONS = {
  b0: '译文一',
  b2: '译文标题',
  b5: '译甲\n译乙',
  b6: '译一\n译二',
}

/** 假模型：按块下标回译文；list 用 \n 拼行（与请求的 items.join('\n') 同形）。 */
function responderOf(translations, title = '译文题目') {
  return (payload) => ({
    value: {
      model: 'fake/m',
      ...(title === undefined ? {} : { title }),
      items: payload.items.map((item) => ({
        id: item.id,
        text: translations[item.id] ?? ('译:' + item.text),
      })),
    },
  })
}

/** 回包不带 title：标题翻译失败的现场（请求带了 title，回包没有）。 */
function responderWithoutTitle(translations) {
  return (payload) => ({
    value: {
      model: 'fake/m',
      items: payload.items.map((item) => ({
        id: item.id,
        text: translations[item.id] ?? ('译:' + item.text),
      })),
    },
  })
}

function translationOf(h) {
  return [...h.store.get().translations.values()][0]
}

async function translateAll(h) {
  h.$('[data-rss-translate]').click()
  await h.waitFor(() => translationOf(h)?.status === 'done', { label: '翻译完成', timeout: 10000 })
  await h.settle()
}

const pressedOf = (h) => h.$$('[data-rss-translation-mode]').map((button) => button.getAttribute('aria-pressed'))

test('R7 03 有译文默认「译文」：切换器三枚、aria-pressed、译文态块渲染', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', VIEW_BLOCKS) },
    translateBatch: responderOf(VIEW_TRANSLATIONS),
  })
  try {
    const body = await openArticle(h, 'a')
    // 没有译文：只有原文，切换器不出现（spec §4.5）。
    assert.equal(h.$('[data-rss-translation-modes]'), null, '无译文时不许出现切换器')
    assert.equal(h.store.get().translationMode, 'original')

    await translateAll(h)
    assert.equal(h.store.get().translationMode, 'translated', '有译文时默认落「译文」')

    const buttons = h.$$('[data-rss-translation-mode]')
    assert.deepEqual(buttons.map((button) => button.textContent), ['原文', '译文', '对照'])
    for (const button of buttons) {
      assert.equal(button.getAttribute('type'), 'button', '切换器按钮必须是 type=button')
      assert.equal(button.tabIndex, 0, '切换器按钮必须可 Tab 到达')
    }
    assert.deepEqual(pressedOf(h), ['false', 'true', 'false'], '默认按下的是「译文」')

    // 译文态：可翻块的原文被译文替换；不可翻块原样只渲染一次。
    assert.equal(h.$('[data-rss-translation="0"]').textContent, '译文一')
    assert.equal(h.$('[data-rss-translation="2"]').textContent, '译文标题')
    assert.equal(h.$('[data-rss-translation="0"]').style.whiteSpace, 'pre-wrap', '译文纯文本必须保留换行')
    assert.equal(body.textContent.includes('段落一'), false, '译文态不许再把原文段落画一遍')
    assert.equal(body.querySelectorAll('pre').length, 1, 'pre 只渲染一次')
    assert.equal(body.querySelectorAll('img').length, 1, 'img 只渲染一次')
    assert.equal(body.querySelectorAll('table').length, 1, 'table 只渲染一次')
    assert.equal(h.$('[data-rss-translation="1"]'), null, 'pre 不产生译文段')
    assert.equal(h.$('[data-rss-translation="3"]'), null, 'img 不产生译文段')
    assert.equal(h.$('[data-rss-translation="4"]'), null, 'table 不产生译文段')

    // 表格上方一行「表格未翻译」：标记必须排在 <table> 之前。
    const tableMarker = h.$('[data-rss-table-not-translated]')
    assert.ok(tableMarker !== null, '译文态的表格上方必须有「表格未翻译」')
    assert.equal(tableMarker.textContent, '表格未翻译')
    const table = body.querySelector('table')
    assert.ok((tableMarker.compareDocumentPosition(table) & h.win.Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      '「表格未翻译」必须在表格上方')

    // list 译文还原成项目符号 / 有序列表（验收 7）。
    const unordered = h.$('[data-rss-translation="5"]')
    assert.deepEqual([...unordered.querySelectorAll('ul > li')].map((li) => li.textContent), ['译甲', '译乙'])
    const ordered = h.$('[data-rss-translation="6"]')
    assert.deepEqual([...ordered.querySelectorAll('ol > li')].map((li) => li.textContent), ['译一', '译二'])
  } finally {
    h.cleanup()
  }
})

test('R7 03 三态切换：原文 / 对照 / 译文互换，且不发任何 rpc', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', VIEW_BLOCKS) },
    translateBatch: responderOf(VIEW_TRANSLATIONS),
  })
  try {
    const body = await openArticle(h, 'a')
    await translateAll(h)
    const rpcBefore = h.requests.length

    // 原文：译文段全部消失，原文回来。
    h.$('[data-rss-translation-mode="original"]').click()
    await h.settle()
    assert.equal(h.store.get().translationMode, 'original')
    assert.deepEqual(pressedOf(h), ['true', 'false', 'false'])
    assert.equal(h.$$('[data-rss-translation]').length, 0, '原文态不许留任何译文段')
    assert.equal(body.textContent.includes('段落一'), true)
    assert.equal(h.$('[data-rss-table-not-translated]'), null, '「表格未翻译」只属于译文态')

    // 对照：原文在上、译文段紧跟在下；每段译文落在自己的块里，不串段。
    h.$('[data-rss-translation-mode="parallel"]').click()
    await h.settle()
    assert.equal(h.store.get().translationMode, 'parallel')
    assert.deepEqual(pressedOf(h), ['false', 'false', 'true'])
    assert.equal(body.textContent.includes('段落一'), true)
    const first = h.$('[data-rss-translation="0"]')
    assert.equal(first.previousElementSibling?.textContent, '段落一', '译文段必须紧跟自己的原文块')
    assert.equal(first.parentElement?.getAttribute('data-rss-block'), '0', '译文段不许串到别的块')
    assert.match(first.getAttribute('style') ?? '', /3px/, '对照态译文段要有左 3px 竖线')
    const heading = h.$('[data-rss-translation="2"]')
    assert.equal(heading.previousElementSibling?.textContent, '小标题')
    assert.equal(heading.parentElement?.getAttribute('data-rss-block'), '2')
    // 不可翻块只渲染一次，也不产生译文段（spec §4.5）。
    assert.equal(body.querySelectorAll('pre').length, 1)
    assert.equal(body.querySelectorAll('img').length, 1)
    assert.equal(body.querySelectorAll('table').length, 1)
    for (const index of [1, 3, 4]) {
      assert.equal(h.$('[data-rss-translation="' + index + '"]'), null, '不可翻块 index=' + index + ' 不产生译文段')
    }
    // 对照态的 list 也要还原成列表，而不是一坨 pre-wrap 文本。
    const list = h.$('[data-rss-translation="5"]')
    assert.deepEqual([...list.querySelectorAll('ul > li')].map((li) => li.textContent), ['译甲', '译乙'])

    // 切回译文：原文又让位给译文。
    h.$('[data-rss-translation-mode="translated"]').click()
    await h.settle()
    assert.equal(h.store.get().translationMode, 'translated')
    assert.equal(body.textContent.includes('段落一'), false)

    assert.equal(h.requests.length, rpcBefore, '切三态只改渲染，一条 rpc 都不许发')
  } finally {
    h.cleanup()
  }
})

test('R7 03 / 06 无译文时按 t 触发翻译（首次确认由 06 的用例单独覆盖）', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', VIEW_BLOCKS) },
    translateBatch: responderOf(VIEW_TRANSLATIONS),
  })
  try {
    await openArticle(h, 'a')
    h.press('t')
    await h.waitFor(() => h.calls('translateBatch').length === 1, { label: 't 触发翻译' })
    await h.waitFor(() => translationOf(h)?.status === 'done', { label: '翻译完成' })
    await h.settle()
    assert.equal(h.store.get().translationMode, 'translated', '开始翻译后有译文默认落「译文」')
    assert.ok(h.$('[data-rss-translation-modes]') !== null, '翻译完成后切换器出现')
  } finally {
    h.cleanup()
  }
})

test('R7 03 t 在有译文时循环 原文 → 译文 → 对照', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', VIEW_BLOCKS) },
    translateBatch: responderOf(VIEW_TRANSLATIONS),
  })
  try {
    const body = await openArticle(h, 'a')
    await translateAll(h)
    const rpcBefore = h.requests.length
    assert.equal(h.store.get().translationMode, 'translated')

    h.press('t')
    await h.settle()
    assert.equal(h.store.get().translationMode, 'parallel', '译文 → 对照')
    assert.deepEqual(pressedOf(h), ['false', 'false', 'true'])

    h.press('t')
    await h.settle()
    assert.equal(h.store.get().translationMode, 'original', '对照 → 原文')
    assert.equal(body.textContent.includes('段落一'), true)

    h.press('t')
    await h.settle()
    assert.equal(h.store.get().translationMode, 'translated', '原文 → 译文')
    assert.equal(body.textContent.includes('段落一'), false)

    assert.equal(h.requests.length, rpcBefore, 't 循环三态不发 rpc')
  } finally {
    h.cleanup()
  }
})

test('R7 03 标题三态：译文态译文标题，标题失败回原文 + 角标，对照态永远原文', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', VIEW_BLOCKS) },
    translateBatch: responderOf(VIEW_TRANSLATIONS),
  })
  try {
    await openArticle(h, 'a')
    await translateAll(h)
    assert.equal(h.$('.dsh-rss-article-title').textContent, '译文题目', '译文态显示译文标题')
    assert.equal(h.$('[data-rss-title-failed]'), null)

    h.$('[data-rss-translation-mode="parallel"]').click()
    await h.settle()
    assert.equal(h.$('.dsh-rss-article-title').textContent, '文章 a', '对照态永远显示原文标题')
    assert.equal(h.$('[data-rss-title-failed]'), null, '对照态不标「标题未翻译」')

    h.$('[data-rss-translation-mode="translated"]').click()
    await h.settle()
    assert.equal(h.$('.dsh-rss-article-title').textContent, '译文题目')
  } finally {
    h.cleanup()
  }

  const failed = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', VIEW_BLOCKS) },
    translateBatch: responderWithoutTitle(VIEW_TRANSLATIONS),
  })
  try {
    await openArticle(failed, 'a')
    await translateAll(failed)
    assert.equal(translationOf(failed).titleFailed, true, '请求带了标题、回包没有 ⇒ titleFailed = true')
    assert.equal(failed.$('.dsh-rss-article-title').textContent, '文章 a', '标题翻译失败回原文标题')
    const badge = failed.$('[data-rss-title-failed]')
    assert.ok(badge !== null, '标题翻译失败必须有角标')
    assert.equal(badge.textContent, '标题未翻译')

    failed.$('[data-rss-translation-mode="parallel"]').click()
    await failed.settle()
    assert.equal(failed.$('[data-rss-title-failed]'), null, '对照态不显示标题失败角标')

    failed.$('[data-rss-translation-mode="translated"]').click()
    await failed.settle()
    assert.ok(failed.$('[data-rss-title-failed]') !== null, '切回译文态角标回来')
  } finally {
    failed.cleanup()
  }
})

test('R7 03 list 行数不等 / 空白译文：整块退回原文，不渲染空段落', skip, async () => {
  const blocks = [
    { kind: 'list', ordered: false, items: ['甲', '乙'] },
    { kind: 'list', ordered: true, items: ['一', '二'] },
    { kind: 'list', ordered: false, items: ['丙', '丁'] },
    { kind: 'list', ordered: false, items: ['戊'] },
  ]
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', blocks) },
    translateBatch: responderOf({
      b0: '甲译\n乙译',
      b1: '一译\n二译',
      b2: '只有一行',
      b3: '   ',
    }),
  })
  try {
    const body = await openArticle(h, 'a')
    await translateAll(h)
    // 行数相等 ⇒ 还原成列表。
    assert.deepEqual([...h.$('[data-rss-translation="0"]').querySelectorAll('ul > li')].map((li) => li.textContent), ['甲译', '乙译'])
    assert.deepEqual([...h.$('[data-rss-translation="1"]').querySelectorAll('ol > li')].map((li) => li.textContent), ['一译', '二译'])
    // 行数不等 ⇒ 整块退回原文；空白译文 ⇒ 同样退回原文，且不留空段落。
    assert.equal(h.$('[data-rss-translation="2"]'), null, '行数不等时不许硬贴译文')
    assert.equal(h.$('[data-rss-translation="3"]'), null, '空白译文不许留下空段落')
    const itemsIn = (index) => [...h.$('[data-rss-block="' + index + '"]').querySelectorAll('li')]
      .map((li) => li.textContent)
    assert.deepEqual(itemsIn(2), ['丙', '丁'], '行数不等的列表必须整块退回原文')
    assert.deepEqual(itemsIn(3), ['戊'], '空白译文的列表必须整块退回原文')
    assert.equal(body.querySelectorAll('ol > li').length, 2, '只有行数相等的有序列表被还原')
  } finally {
    h.cleanup()
  }
})

test('R7 03 无译文（全批失败）：切换器不出现、正文按原文渲染', skip, async () => {
  // 一条可翻 + 一张表：若渲染层只看「有条目」就会落译文态（表格会挂「表格未翻译」），
  // 但 blocks.size === 0 —— 没有任何译文可切，必须完全按原文画（评审修复 A4）。
  const blocks = [
    { kind: 'p', text: '段落一' },
    { kind: 'table', header: ['列'], rows: [['值']] },
  ]
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', blocks) },
    translateBatch: async () => ({
      error: { code: 'translate-failed', message: '模型失败', details: { reason: 'empty' } },
    }),
  })
  try {
    const body = await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => translationOf(h)?.status === 'done', { label: '失败批收尾' })
    await h.settle()
    assert.equal(translationOf(h).blocks.size, 0, '全批失败没有任何译文块')
    assert.equal(h.$('[data-rss-translation-modes]'), null, '没有译文时切换器不许出现')
    assert.equal(h.$('[data-rss-table-not-translated]'), null, '无译文时不许落译文态（表格未翻译标记不出现）')
    assert.match(body.textContent, /段落一/, '正文必须原样显示原文')
    assert.equal(h.$('.dsh-rss-article-title').textContent, '文章 a')
  } finally {
    h.cleanup()
  }
})
