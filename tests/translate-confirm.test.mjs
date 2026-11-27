/**
 * 首次外发确认（R7 06，spec §4.2 / 验收 2 / 15）。
 *
 * 钉的是读者能看见、且能核对的三条承诺：
 *   ① 第一次点「译」先弹共享 ConfirmDialog，正文说明会发给哪个 provider/model、本次约多少字符；
 *   ② 取消 ⇒ 零 rpc、零 saveSettings、store 不留任何状态，按钮回到「译」；
 *   ③ 确认 ⇒ **先**写 `translateNoticeAck = true`（走 saveSettings 的 patch）**再**发 translateBatch；
 *      标记已经为 true 后不再弹；设置页「翻译」分区的隐私句常驻不可关。
 *
 * 文案本身从 `translate-copy` 的单源取：测试不手抄第二份中文，避免「页面改了、测试还绿」。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { TRANSLATE_SETTINGS_NOTICE } from '../lib/translate-copy.js'
import { articleOf, cleanupAll, itemOf, mount, openArticle, skip } from './helpers/translate-harness.mjs'

afterEach(cleanupAll)

const BLOCKS = [{ kind: 'p', text: '第一段' }, { kind: 'h', level: 2, text: '小标题' }]
const CHARS = 6

const dialog = (h) => h.$('[data-rss-translate-confirm]')

/** 打开设置页（工具栏「设置」按钮）。 */
async function openSettings(h) {
  const button = h.$$('button').find((node) => (node.textContent ?? '').trim() === '设置')
  assert.ok(button !== undefined, '工具栏必须有「设置」按钮')
  button.click()
  await h.waitFor(() => h.$('[data-rss-settings-page]') !== null, { label: '设置页上屏' })
  await h.settle()
}

test('R7 06 首次点「译」：确认框写清路由与字符数；取消零副作用', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', BLOCKS) },
    noticeAck: false,
  })
  try {
    await openArticle(h, 'a')
    const trigger = h.$('[data-rss-translate]')
    assert.equal(trigger.getAttribute('type'), 'button')
    assert.equal(trigger.tabIndex, 0, '「译」必须可 Tab 到达')
    assert.equal(trigger.getAttribute('aria-label'), '译', '新按钮必须有可读标签')
    const requestsBefore = h.requests.length
    trigger.click()
    await h.waitFor(() => dialog(h) !== null, { label: '确认框上屏' })

    const card = h.$('[data-rss-translate-confirm-card]')
    assert.ok(card !== null, '必须是共享 ConfirmDialog 的卡片（role=dialog）')
    assert.equal(card.getAttribute('role'), 'dialog')
    for (const selector of ['[data-rss-translate-confirm-ok]', '[data-rss-translate-confirm-cancel]']) {
      const button = h.$(selector)
      assert.equal(button.getAttribute('type'), 'button')
      assert.equal(button.tabIndex, 0, '确认框按钮必须可 Tab 到达')
      assert.ok((button.getAttribute('aria-label') ?? '') !== '', '确认框按钮必须有 aria-label')
    }
    const notice = h.$('[data-rss-translate-notice]').textContent ?? ''
    assert.match(notice, /当前文章正文/, '必须说明外发的是当前文章正文')
    assert.match(notice, /p\/m/, '必须写出 provider/model')
    assert.match(notice, new RegExp('约 ' + CHARS + ' 字符'), '字符数必须是当前文章可翻字符总数')
    assert.match(notice, /调用费用/, '必须提示可能产生费用')

    // 取消：框关掉、零请求、零保存、没有任何译文 / 确认态残留。
    h.$('[data-rss-translate-confirm-cancel]').click()
    await h.settle()
    assert.equal(dialog(h), null, '取消后确认框必须消失')
    assert.equal(h.calls('translateBatch').length, 0, '取消不许发翻译请求')
    assert.equal(h.calls('saveSettings').length, 0, '取消不许写 settings')
    assert.equal(h.store.get().translateConfirm, undefined, '取消不留确认态')
    assert.equal(h.store.get().translations.size, 0, '取消不许创建半截译文条目')
    assert.equal(h.$('[data-rss-translate]').textContent, '译', '按钮回到「译」')
    assert.equal(h.requests.length, requestsBefore, '取消后不应新增任何请求')
  } finally {
    h.cleanup()
  }
})

test('R7 06 确认：先写 translateNoticeAck=true，再发 translateBatch；已确认后不再弹', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', BLOCKS) },
    noticeAck: false,
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => dialog(h) !== null, { label: '确认框上屏' })
    h.$('[data-rss-translate-confirm-ok]').click()

    await h.waitFor(() => h.calls('translateBatch').length === 1, { label: '确认后开始翻译' })
    const saveIndex = h.requests.findIndex((entry) => entry.endpoint === 'saveSettings')
    const batchIndex = h.requests.findIndex((entry) => entry.endpoint === 'translateBatch')
    assert.ok(saveIndex >= 0, '确认必须先写 settings')
    assert.ok(saveIndex < batchIndex, '写标记必须早于第一条翻译请求')
    assert.deepEqual(h.calls('saveSettings')[0].payload, { patch: { translateNoticeAck: true } },
      '标记只能通过 saveSettings 的 patch 白名单写入')
    assert.equal(h.store.get().settings.effective.translateNoticeAck, true, '客户端快照必须同步成已确认')

    await h.waitFor(() => [...h.store.get().translations.values()][0]?.status === 'done', { label: '翻译完成' })
    await h.settle()
    assert.equal(dialog(h), null)

    // 完成态再点：按钮是「重译」，已经确认过 ⇒ 直接重发，不再弹框。
    const retranslate = h.$('[data-rss-translate]')
    assert.equal(retranslate.textContent, '重译')
    assert.match(retranslate.className, /dsh-rss-btn--ghost/, '完成态按钮必须降级为次要样式')
    retranslate.click()
    await h.waitFor(() => h.calls('translateBatch').length === 2, { label: '重译直接开始' })
    assert.equal(dialog(h), null, '已确认过的用户重译时不许再弹确认框')
    assert.equal(h.calls('saveSettings').length, 1, '重译不重复写确认标记')
  } finally {
    h.cleanup()
  }
})

test('R7 06 标记已为 true：首次点「译」直接开始，不弹确认框', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', BLOCKS) },
  })
  try {
    await openArticle(h, 'a')
    h.$('[data-rss-translate]').click()
    await h.waitFor(() => h.calls('translateBatch').length === 1, { label: '直接发翻译请求' })
    assert.equal(dialog(h), null, 'translateNoticeAck=true 时不许再打扰用户')
    assert.equal(h.calls('saveSettings').length, 0, '已确认过就不该再写一次 settings')
  } finally {
    h.cleanup()
  }
})

test('R7 06 设置页「翻译」分区：隐私句常驻，不可关闭（即使模型不可用）', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', BLOCKS) },
    translateInfo: { available: false, reason: 'no-provider' },
  })
  try {
    await openSettings(h)
    const section = h.$('[data-rss-settings-section="translate"]')
    assert.ok(section !== null, '「翻译」分区必须永远可见')
    const notice = section.querySelector('.dsh-rss-settings-help')
    assert.ok(notice !== null, '分区里必须常驻一句外发提示')
    assert.equal(notice.textContent, TRANSLATE_SETTINGS_NOTICE, '文案必须取 translate-copy 的单源')
    assert.match(notice.textContent ?? '', /当前文章正文/)
    assert.equal(section.querySelector('[data-rss-translate-reason]') !== null, true,
      '不可用时同一分区还要给出中文原因')
  } finally {
    h.cleanup()
  }
})
