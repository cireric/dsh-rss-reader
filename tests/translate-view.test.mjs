/**
 * 三态视图的客户端链路（R7 03，spec §4.5 / 验收 7 / 12 / 14）。
 *
 * 钉的是读者能看见的承诺：
 *   ① 有译文时默认「对照」（2026-11-26 用户拍板：原文下方直接给译文），没有译文时切换器不出现；
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


function translationOf(h) {
  return [...h.store.get().translations.values()][0]
}

async function translateAll(h) {
  h.$('[data-rss-translate]').click()
  await h.waitFor(() => translationOf(h)?.status === 'done', { label: '翻译完成', timeout: 10000 })
  await h.settle()
}

test('R7 03 有译文默认「对照」：单枚切换按钮、对照渲染、表格明示、list 还原', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', VIEW_BLOCKS) },
    translateBatch: responderOf(VIEW_TRANSLATIONS),
  })
  try {
    const body = await openArticle(h, 'a')
    // 没有译文：只有原文，切换按钮不出现。
    assert.equal(h.$('[data-rss-translation-toggle]'), null, '无译文时不许出现切换按钮')
    assert.equal(h.store.get().translationMode, 'original')

    await translateAll(h)
    assert.equal(h.store.get().translationMode, 'parallel', '有译文时默认落「对照」')

    const toggle = h.$('[data-rss-translation-toggle]')
    assert.ok(toggle !== null, '有译文后必须出现单枚切换按钮')
    assert.equal(toggle.textContent, '原文', '正在看对照时按钮写的是目标态「原文」')
    assert.equal(toggle.getAttribute('type'), 'button', '切换按钮必须是 type=button')
    assert.equal(toggle.tabIndex, 0, '切换按钮必须可 Tab 到达')
    assert.equal(toggle.getAttribute('aria-label'), '显示原文')

    // 对照态：原文在上、译文段紧跟在下；不可翻块只渲染一次、不产生译文段。
    assert.equal(h.$('[data-rss-translation="0"]').textContent, '译文一')
    assert.equal(h.$('[data-rss-translation="2"]').textContent, '译文标题')
    assert.equal(h.$('[data-rss-translation="0"]').style.whiteSpace, 'pre-wrap', '译文纯文本必须保留换行')
    assert.equal(body.textContent.includes('段落一'), true, '对照态必须保留原文')
    assert.equal(body.querySelectorAll('pre').length, 1, 'pre 只渲染一次')
    assert.equal(body.querySelectorAll('img').length, 1, 'img 只渲染一次')
    assert.equal(body.querySelectorAll('table').length, 1, 'table 只渲染一次')
    assert.equal(h.$('[data-rss-translation="1"]'), null, 'pre 不产生译文段')
    assert.equal(h.$('[data-rss-translation="3"]'), null, 'img 不产生译文段')
    assert.equal(h.$('[data-rss-translation="4"]'), null, 'table 不产生译文段')

    // 表格上方一行「表格未翻译」：标记必须排在 <table> 之前。
    const tableMarker = h.$('[data-rss-table-not-translated]')
    assert.ok(tableMarker !== null, '对照态的表格上方必须有「表格未翻译」')
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
test('R7 03 两态切换：原文 / 对照互换，且不发任何 rpc', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', VIEW_BLOCKS) },
    translateBatch: responderOf(VIEW_TRANSLATIONS),
  })
  try {
    const body = await openArticle(h, 'a')
    await translateAll(h)
    const rpcBefore = h.requests.length

    // 切回原文：译文段全部消失，按钮变成「译文」。
    h.$('[data-rss-translation-toggle="original"]').click()
    await h.settle()
    assert.equal(h.store.get().translationMode, 'original')
    assert.equal(h.$('[data-rss-translation-toggle]').textContent, '译文', '正在看原文时按钮写的是目标态「译文」')
    assert.equal(h.$$('[data-rss-translation]').length, 0, '原文态不许留任何译文段')
    assert.equal(body.textContent.includes('段落一'), true)

    // 切回对照：原文在上、译文段紧跟在下；每段译文落在自己的块里，不串段。
    h.$('[data-rss-translation-toggle="parallel"]').click()
    await h.settle()
    assert.equal(h.store.get().translationMode, 'parallel')
    assert.equal(h.$('[data-rss-translation-toggle]').textContent, '原文')
    const first = h.$('[data-rss-translation="0"]')
    assert.equal(first.previousElementSibling?.textContent, '段落一', '译文段必须紧跟自己的原文块')
    assert.equal(first.parentElement?.getAttribute('data-rss-block'), '0', '译文段不许串到别的块')
    assert.match(first.getAttribute('style') ?? '', /3px/, '对照态译文段要有左 3px 竖线')
    // 不可翻块只渲染一次，也不产生译文段。
    assert.equal(body.querySelectorAll('pre').length, 1)
    assert.equal(body.querySelectorAll('img').length, 1)
    assert.equal(body.querySelectorAll('table').length, 1)
    for (const index of [1, 3, 4]) {
      assert.equal(h.$('[data-rss-translation="' + index + '"]'), null, '不可翻块 index=' + index + ' 不产生译文段')
    }

    assert.equal(h.requests.length, rpcBefore, '切两态只改渲染，一条 rpc 都不许发')
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
    assert.equal(h.store.get().translationMode, 'parallel', '开始翻译后有译文默认落「对照」')
    assert.ok(h.$('[data-rss-translation-toggle]') !== null, '翻译完成后切换按钮出现')
  } finally {
    h.cleanup()
  }
})

test('R7 03 t 在有译文时循环 原文 ↔ 对照', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', VIEW_BLOCKS) },
    translateBatch: responderOf(VIEW_TRANSLATIONS),
  })
  try {
    const body = await openArticle(h, 'a')
    await translateAll(h)
    const rpcBefore = h.requests.length
    assert.equal(h.store.get().translationMode, 'parallel', '默认对照')

    h.press('t')
    await h.settle()
    assert.equal(h.store.get().translationMode, 'original', '对照 → 原文')
    assert.equal(h.$('[data-rss-translation-toggle]').textContent, '译文')
    assert.equal(body.textContent.includes('段落一'), true)

    h.press('t')
    await h.settle()
    assert.equal(h.store.get().translationMode, 'parallel', '原文 → 对照')
    assert.equal(h.$('[data-rss-translation-toggle]').textContent, '原文')

    assert.equal(h.requests.length, rpcBefore, 't 循环两态不发 rpc')
  } finally {
    h.cleanup()
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
    // 默认对照态会把原文列表也画出来，所以只数译文段里的 ol（原文的那些不算「还原」）。
    assert.equal(body.querySelectorAll('[data-rss-translation] ol > li').length, 2, '只有行数相等的有序列表被还原')
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
    // 用 === null 而不是 assert.equal(node, null)：失败时 Node 会去序列化 jsdom 节点，能把进程撑死。
    assert.ok(h.$('[data-rss-translation-toggle]') === null, '没有译文时切换按钮不许出现')
    assert.ok(h.$('[data-rss-table-not-translated]') === null, '无译文时不许出现「表格未翻译」标记')
    assert.match(body.textContent, /段落一/, '正文必须原样显示原文')
    assert.equal(h.$('.dsh-rss-article-title').textContent, '文章 a')
  } finally {
    h.cleanup()
  }
})

test('R7 优化 翻译中的批在原文下方显示「正在翻译」占位，回包后由译文接替', skip, async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', VIEW_BLOCKS) },
    translateBatch: async (payload) => {
      await gate
      return responderOf(VIEW_TRANSLATIONS)(payload)
    },
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => h.$('[data-rss-translation-pending]') !== null, { label: '出现翻译中占位' })
    const pending = h.$('[data-rss-translation-pending="0"]')
    assert.equal(pending.getAttribute('aria-label'), '正在翻译', '读屏器要能听到这一批在跑')
    assert.ok(pending.querySelector('.dsh-rss-spinner') !== null, '占位里要有旋转图标')
    // pre / img / table 不占编号，不会出现在占位里。
    assert.equal(h.$('[data-rss-translation-pending="1"]'), null)
    release()
    await h.waitFor(() => translationOf(h)?.status === 'done', { label: '翻译完成' })
    await h.settle()
    assert.equal(h.$('[data-rss-translation-pending]'), null, '回包后占位必须消失')
    assert.ok(h.$('[data-rss-translation="0"]') !== null, '译文段接替占位的位置')
  } finally {
    h.cleanup()
  }
})
