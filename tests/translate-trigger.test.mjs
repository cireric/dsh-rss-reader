/**
 * 键盘触发与「无自动调用」（R7 06，spec §4.1 / D14 / 验收 14 / 15）。
 *
 *   ① `t` 无译文 ⇒ 等同点「译」：首次仍弹确认框，取消零副作用，确认后开始；
 *   ② `t` 有译文 ⇒ 原文 → 译文 → 对照 循环；
 *   ③ 输入框聚焦时 `t` 不触发；
 *   ④ 打开文章 / 刷新 / 切筛选 / 恢复视图（面板重挂）⇒ translateBatch 计数必须为 0；
 *   ⑤ 可翻块为 0 的按钮禁用并给出准确原因。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { articleOf, cleanupAll, itemOf, mount, openArticle, skip } from './helpers/translate-harness.mjs'

afterEach(cleanupAll)

const BLOCKS = [{ kind: 'p', text: '第一段' }, { kind: 'h', level: 2, text: '小标题' }]

function translationOf(h) {
  return [...h.store.get().translations.values()][0]
}

test('R7 06 t 无译文：首次弹确认框；取消零请求，确认后开始并进入译文态', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', BLOCKS) },
    noticeAck: false,
  })
  try {
    await openArticle(h, 'a')
    h.press('t')
    await h.waitFor(() => h.$('[data-rss-translate-confirm]') !== null, { label: 't 也走同一个确认框' })
    assert.equal(h.calls('translateBatch').length, 0)

    h.$('[data-rss-translate-confirm-cancel]').click()
    await h.settle()
    assert.equal(h.$('[data-rss-translate-confirm]'), null)
    assert.equal(h.calls('translateBatch').length, 0, '取消后 t 不许发翻译请求')
    assert.equal(h.calls('saveSettings').length, 0)
    assert.equal(h.store.get().translations.size, 0)

    h.press('t')
    await h.waitFor(() => h.$('[data-rss-translate-confirm]') !== null, { label: '再次按 t 仍要确认' })
    h.$('[data-rss-translate-confirm-ok]').click()
    await h.waitFor(() => h.calls('translateBatch').length === 1, { label: '确认后开始翻译' })
    await h.waitFor(() => translationOf(h)?.status === 'done', { label: '翻译完成' })
    assert.equal(h.store.get().translationMode, 'translated', '开始翻译后默认落译文态')
  } finally {
    h.cleanup()
  }
})

test('R7 06 t 有译文：原文 → 译文 → 对照 循环且不发 rpc', skip, async () => {
  const h = await mount({ items: [itemOf('a')], articles: { a: articleOf('a', BLOCKS) } })
  try {
    await openArticle(h, 'a')
    h.press('t')
    await h.waitFor(() => h.calls('translateBatch').length === 1, { label: 't 触发首翻' })
    await h.waitFor(() => translationOf(h)?.status === 'done', { label: '翻译完成' })
    await h.settle()
    const requestsBefore = h.requests.length

    assert.equal(h.store.get().translationMode, 'translated')
    h.press('t')
    await h.settle()
    assert.equal(h.store.get().translationMode, 'parallel', '译文 → 对照')
    h.press('t')
    await h.settle()
    assert.equal(h.store.get().translationMode, 'original', '对照 → 原文')
    h.press('t')
    await h.settle()
    assert.equal(h.store.get().translationMode, 'translated', '原文 → 译文')
    assert.equal(h.requests.length, requestsBefore, '三态循环只改渲染，一条 rpc 都不许发')
  } finally {
    h.cleanup()
  }
})

test('R7 06 t 输入控件聚焦时不触发', skip, async () => {
  const h = await mount({ items: [itemOf('a')], articles: { a: articleOf('a', BLOCKS) } })
  try {
    await openArticle(h, 'a')
    const language = h.$('[data-rss-target-language]')
    assert.ok(language !== null, 'Aa 面板里应有目标语言下拉')
    language.focus()
    h.press('t')
    await h.settle()
    assert.equal(h.calls('translateBatch').length, 0, '输入控件聚焦时 t 必须被 isTypingTarget 挡住')
    assert.equal(h.store.get().translations.size, 0)
  } finally {
    h.cleanup()
  }
})

test('R7 06 全程无自动调用：打开文章 / 刷新 / 切筛选 / 恢复视图 → translateBatch = 0', skip, async () => {
  const h = await mount({ items: [itemOf('a')], articles: { a: articleOf('a', BLOCKS) } })
  try {
    await openArticle(h, 'a')
    assert.equal(h.calls('translateBatch').length, 0, '打开文章不许自动翻译')

    await h.store.load('refresh')
    await h.settle()
    assert.equal(h.calls('translateBatch').length, 0, '刷新不许自动翻译')

    h.store.setFilter('unread')
    await h.settle()
    assert.equal(h.calls('translateBatch').length, 0, '切筛选不许自动翻译')

    await h.remount()
    assert.equal(h.calls('translateBatch').length, 0, '恢复视图（面板重挂）不许自动翻译')
  } finally {
    h.cleanup()
  }
})

test('R7 06 可翻块为 0：按钮禁用、title 说明原因、点击零请求', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', [{ kind: 'img', src: 'https://img.example/x.png', alt: '图' }]) },
  })
  try {
    await openArticle(h, 'a')
    const button = h.$('[data-rss-translate]')
    assert.ok(button !== null, '可用性为 true 时按钮仍要渲染（只是禁用）')
    assert.equal(button.disabled, true, '全图片文章没有可翻块 ⇒ 必须禁用')
    assert.equal(button.title, '这篇没有可翻译的正文')
    button.click()
    await h.settle()
    assert.equal(h.calls('translateBatch').length, 0)
    assert.equal(h.store.get().translations.size, 0)
  } finally {
    h.cleanup()
  }
})
