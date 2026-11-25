/**
 * 一键翻译的客户端链路（R7 01，spec §4.1 / §4.3 / §4.6）。
 *
 * 只钉本票承诺的三件事：
 *   ① 点「译」→ 发一次 translateBatch（只带前 12 个可翻块、合计 ≤2000 字符）→ 每段原文下方出现译文；
 *   ② 切条目再回来译文还在（store 存活）；
 *   ③ 刷新（新 store）译文消失。
 * 可用性门禁、三态切换、确认框分别是 02/03/06 的票，这里不提前造。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { articleOf, cleanupAll, itemOf, mount, openArticle, skip } from './helpers/translate-harness.mjs'

afterEach(cleanupAll)

const BLOCKS = [
  { kind: 'p', text: '第一段' },
  { kind: 'pre', text: 'const x = 1' },
  { kind: 'h', level: 2, text: '小标题' },
  { kind: 'img', src: 'https://img.example/x.png', alt: '图' },
  { kind: 'list', ordered: false, items: ['甲', '乙'] },
]

test('R7 01 点「译」：只发可翻块、译文渲染在原文块下方', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', BLOCKS) },
  })
  try {
    const body = await openArticle(h, 'a')
    const button = h.$('[data-rss-translate]')
    assert.ok(button !== null, '正文工具栏必须有「译」按钮')
    assert.equal(button.getAttribute('type'), 'button')
    assert.equal(button.textContent, '译')
    // 放在 Aa 左侧：同一行里它后面紧跟的是 <details>（Aa 面板）。
    assert.equal(button.nextElementSibling?.tagName.toLowerCase(), 'details', '「译」必须紧挨在 Aa 左侧')

    button.click()
    await h.waitFor(() => h.calls('translateBatch').length === 1, { label: '发出 translateBatch' })
    await h.settle()

    const request = h.calls('translateBatch')[0].payload
    assert.equal(request.target, 'zh-CN', '01 固定目标语言 zh-CN')
    assert.equal(request.title, '文章 a', '标题随首批发送')
    assert.deepEqual(request.items.map((item) => item.id), ['b0', 'b2', 'b4'], 'pre / img 不占编号、不进入请求')
    assert.deepEqual(request.items.map((item) => item.text), ['第一段', '小标题', '甲\n乙'])

    // R7 03 起有译文默认落「译文」态；01 的「原文块下方紧跟译文段」现在是**对照**态的形状
    // （spec §4.5），所以先切到对照再核对本票的承诺 —— 断言语义不变，只是换了状态入口。
    h.$('[data-rss-translation-mode="parallel"]').click()
    await h.settle()
    const translations = h.$$('[data-rss-translation]')
    assert.equal(translations.length, 3, '不可翻块不产生译文段')
    assert.deepEqual(translations.map((node) => node.textContent), ['译:第一段', '译:小标题', '译:甲乙'],
      'list 译文按行还原成 li，textContent 不再保留换行')
    assert.deepEqual([...h.$('[data-rss-translation="4"]').querySelectorAll('li')].map((li) => li.textContent),
      ['译:甲', '乙'], 'list 译文还原成项目符号列表')
    assert.equal(translations[0].previousElementSibling?.textContent, '第一段', '译文段必须紧跟自己的原文块')
    assert.equal(translations[0].style.whiteSpace, 'pre-wrap', '译文保留换行')
  } finally {
    h.cleanup()
  }
})

test('R7 01 首批上限：最多 12 块、合计不超过 2000 字符（先到先切）', skip, async () => {
  const many = Array.from({ length: 15 }, (_, index) => ({ kind: 'p', text: '段' + index }))
  const h = await mount({
    items: [itemOf('a'), itemOf('b')],
    articles: { a: articleOf('a', many), b: articleOf('b', BLOCKS) },
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    // 15 块会很快发出两批（12 + 3）：等「至少一条」再读第一条，避免 === 1 的轮询竞态。
    await h.waitFor(() => h.calls('translateBatch').length >= 1, { label: '发出 translateBatch' })
    assert.equal(h.calls('translateBatch')[0].payload.items.length, 12, '最多 12 块')

    // 第二篇：第一段 1500 字，第二段 600 字 —— 2000 字符上限从第二段起就切不动。
    const long = [
      { kind: 'p', text: '长'.repeat(1500) },
      { kind: 'p', text: '尾'.repeat(600) },
      { kind: 'p', text: '短' },
    ]
    const h2 = await mount({ items: [itemOf('a')], articles: { a: articleOf('a', long) } })
    try {
      await openArticle(h2, 'a')
      h2.$('[data-rss-translate]').click()
      // 1500 字一块 + 600/短块一批：两条也可能在第一次轮询前就都发完，等「至少一条」。
      await h2.waitFor(() => h2.calls('translateBatch').length >= 1, { label: '发出 translateBatch' })
      const items = h2.calls('translateBatch')[0].payload.items
      assert.equal(items.length, 1, '超过 2000 字符上限的块不能被硬塞进同一批')
      assert.equal(items[0].text.length, 1500)
    } finally {
      h2.cleanup()
    }
  } finally {
    h.cleanup()
  }
})

test('R7 01 内存态：切条目再回来译文还在，且不再发请求', skip, async () => {
  const h = await mount({
    items: [itemOf('a'), itemOf('b')],
    articles: { a: articleOf('a', BLOCKS), b: articleOf('b', [{ kind: 'p', text: '另一篇' }]) },
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => h.calls('translateBatch').length === 1, { label: '首次翻译' })
    await h.settle()
    assert.equal(h.$$('[data-rss-translation]').length, 3)
    assert.equal(h.store.get().translations.size, 1, '译文按条目 + 正文版本 + 目标语言存进 store')

    await openArticle(h, 'b')
    assert.equal(h.$$('[data-rss-translation]').length, 0, '别的条目不能看到这篇的译文')
    await openArticle(h, 'a')
    assert.equal(h.$$('[data-rss-translation]').length, 3, '切回来译文还在')
    assert.equal(h.calls('translateBatch').length, 1, '切回来不重新请求')
  } finally {
    h.cleanup()
  }
})

test('R7 01 刷新（新 store）：译文消失，回原文态', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', BLOCKS) },
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => h.calls('translateBatch').length === 1, { label: '翻译完成' })
    await h.settle()
    assert.equal(h.store.get().translations.size, 1)

    // 刷新页面 = 插件重新 apply，store 重新创建；译文只在内存，故必须为空。
    const fresh = h.createStore()
    assert.equal(fresh.get().translations.size, 0, '新 store 不允许继承旧译文')
  } finally {
    h.cleanup()
  }
})

test('R7 01 空 / 纯空白译文：该块退回原文，不渲染空段落', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', BLOCKS) },
    translateBatch: (payload) => ({
      value: {
        model: 'fake/m',
        items: payload.items.map((item) => ({
          id: item.id,
          // b0 = 纯空白段落；b4 = 含两条的 list 只回一条空白行（行数不等也属「没有可用译文」）。
          // 让 b2（h）拿到唯一的正常译文，本用例才只钉「空白 / 无译文退回原文」这一件事。
          text: item.id === 'b0' ? '   ' : item.id === 'b4' ? '\n' : '正常译文',
        })),
      },
    }),
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => h.calls('translateBatch').length === 1, { label: '翻译完成' })
    await h.settle()
    const translations = h.$$('[data-rss-translation]')
    assert.equal(translations.length, 1, '只有非空译文产生段落')
    assert.equal(translations[0].textContent, '正常译文')
    assert.equal(h.$('[data-rss-translation="0"]'), null, '空白译文不许留下空段落')
    assert.equal(h.$('[data-rss-translation="4"]'), null, 'list 拿到空白译文时整块退回原文，不留空段落')
  } finally {
    h.cleanup()
  }
})
