/**
 * R7 02 的界面验收（spec §4.1 / §5.2 / §5.3 / 验收 1/13）：
 *   ① translateInfo.available === false ⇒ 文章面没有「译」按钮、Aa 面板没有语言下拉、t 无反应；
 *   ② 可用时两处入口（Aa 面板与设置页「显示」分区）共用同一个 translateTarget，
 *      切换后落盘走 saveViewPreferences，translateBatch 的 target 跟着变；
 *   ③ 设置页「翻译」分区：不可用显示中文 reason；可用显示模型选择器（首项跟随会话默认），
 *      选中具体模型后才出现思考强度；保存经 saveSettings 一次提交三键，成功后刷新 translateInfo。
 *
 * 用真实 React + 真实构建产物（与 translate-dom.test.mjs 共用夹具）。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { AVAILABLE_TRANSLATE_INFO, articleOf, cleanupAll, itemOf, mount, openArticle, skip } from './helpers/translate-harness.mjs'

afterEach(cleanupAll)

const BLOCKS = [{ kind: 'p', text: '第一段' }, { kind: 'h', level: 2, text: '小标题' }]

/** 打开设置页（工具栏「设置」按钮），等快照与分区渲染。 */
async function openSettings(h) {
  const button = h.$$('button').find((node) => (node.textContent ?? '').trim() === '设置')
  assert.ok(button !== undefined, '工具栏必须有「设置」按钮')
  button.click()
  await h.waitFor(() => h.$('[data-rss-settings-page]') !== null, { label: '设置页上屏' })
  await h.settle()
}

/** 触发一次 React 能识别的 select 变化。 */
async function choose(h, select, value) {
  select.value = value
  select.dispatchEvent(new h.win.Event('change', { bubbles: true }))
  await h.settle()
}

test('不可用：文章面没有「译」按钮、Aa 没有语言下拉、t 不触发任何翻译请求', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', BLOCKS) },
    translateInfo: { available: false, reason: 'no-provider' },
  })
  try {
    await openArticle(h, 'a')
    assert.equal(h.$('[data-rss-translate]'), null, '不可用时「译」按钮必须**不存在**（不是 disabled）')
    assert.equal(h.$('[data-rss-target-language]'), null, '不可用时 Aa 面板的目标语言下拉也不渲染')

    h.press('t')
    await h.settle()
    assert.equal(h.calls('translateBatch').length, 0, '不可用时 t 不许发起翻译（06 接键盘时也读同一个门禁）')
  } finally { h.cleanup() }
})

test('可用：渲染「译」按钮与语言下拉；切换语言写入 viewPreferences，translateBatch 的 target 跟着变', skip, async () => {
  const h = await mount({ items: [itemOf('a')], articles: { a: articleOf('a', BLOCKS) } })
  try {
    await openArticle(h, 'a')
    const button = h.$('[data-rss-translate]')
    assert.ok(button !== null, '可用时必须渲染「译」按钮')
    const language = h.$('[data-rss-target-language]')
    assert.ok(language !== null, '可用时 Aa 面板必须渲染目标语言下拉')
    assert.equal(language.value, 'zh-CN', '默认目标语言是简体中文')
    assert.deepEqual([...language.options].map((option) => option.value), ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'],
      '语言表来自 translate-copy 的五种语言')

    await choose(h, language, 'en')
    const writes = h.calls('saveViewPreferences')
    assert.ok(writes.length >= 1, '切换语言必须走既有的 saveViewPreferences 通道（不新开端点）')
    assert.equal(writes[writes.length - 1].payload.preferences.translateTarget, 'en',
      '落盘的 translateTarget 必须是新语言')
    assert.equal(h.store.get().translateTarget, 'en', 'store 里的目标语言必须同步')

    h.$('[data-rss-translate]').click()
    await h.waitFor(() => h.calls('translateBatch').length === 1, { label: '发出翻译请求' })
    assert.equal(h.calls('translateBatch')[0].payload.target, 'en', 'translateBatch 的 target 必须跟随语言偏好')
  } finally { h.cleanup() }
})

test('设置页显示分区：语言下拉与 Aa 共用同一个值，切换同样走 saveViewPreferences', skip, async () => {
  const h = await mount({ items: [itemOf('a')], articles: { a: articleOf('a', BLOCKS) } })
  try {
    await openArticle(h, 'a')
    await openSettings(h)
    const language = h.$('[data-rss-display-language]')
    assert.ok(language !== null, '设置页「显示」分区必须有同一个目标语言下拉')
    assert.equal(language.value, 'zh-CN')
    await choose(h, language, 'ja')
    const writes = h.calls('saveViewPreferences')
    assert.equal(writes[writes.length - 1].payload.preferences.translateTarget, 'ja')
    assert.equal(h.store.get().translateTarget, 'ja')
  } finally { h.cleanup() }
})

test('设置页翻译分区：不可用时显示中文 reason，没有模型选择器', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', BLOCKS) },
    translateInfo: { available: false, reason: 'llm-unmounted' },
  })
  try {
    await openSettings(h)
    const section = h.$('[data-rss-settings-section="translate"]')
    assert.ok(section !== null, '「翻译」分区必须永远可见')
    const reason = section.querySelector('[data-rss-translate-reason]')
    assert.ok(reason !== null, '不可用时必须显示原因')
    assert.match(reason.textContent ?? '', /LLM 服务未挂载/
      , '原因必须是中文人话，而不是 wire 枚举')
    assert.equal(section.querySelector('[data-rss-translate-model]'), null, '列不出目录时不该画一个空选择器')
  } finally { h.cleanup() }
})

test('设置页翻译分区：模型选择器 + 思考强度；保存一次三键，成功后立即刷新 translateInfo', skip, async () => {
  const h = await mount({ items: [itemOf('a')], articles: { a: articleOf('a', BLOCKS) } })
  try {
    await openSettings(h)
    const section = h.$('[data-rss-settings-section="translate"]')
    assert.ok(section !== null)
    const picker = section.querySelector('[data-rss-translate-model]')
    assert.ok(picker !== null, '可用时必须有模型选择器')
    assert.match(picker.options[0].textContent ?? '', /跟随会话默认（m）/,
      '首项必须是「跟随会话默认（当前模型名）」，模型名来自宿主探测结果')
    assert.deepEqual([...picker.querySelectorAll('optgroup')].map((group) => group.getAttribute('label')), ['p'],
      '其后按 provider 分组列模型')
    assert.deepEqual([...picker.options].slice(1).map((option) => option.textContent), ['m', 'm2'])

    const probesBefore = h.calls('translateInfo').length
    await choose(h, picker, JSON.stringify(['p', 'm']))
    await h.waitFor(() => h.calls('saveSettings').length === 1, { label: '保存翻译路由' })
    assert.deepEqual(h.calls('saveSettings')[0].payload, { patch: {
      translateProvider: 'p', translateModel: 'm', translateEffort: '',
    } }, '选中模型必须一次提交 provider+model（成对落盘，effort 清空）')
    await h.waitFor(() => h.calls('translateInfo').length > probesBefore, { label: '保存成功后刷新 translateInfo' })

    const effort = section.querySelector('[data-rss-translate-effort]')
    assert.ok(effort !== null, '选中支持思考强度的模型后必须出现强度下拉')
    assert.deepEqual([...effort.options].map((option) => option.value), ['', 'low', 'high'],
      '空值 = 跟随模型默认，其后是该模型声明的 efforts')

    await choose(h, effort, 'high')
    await h.waitFor(() => h.calls('saveSettings').length === 2, { label: '保存思考强度' })
    assert.deepEqual(h.calls('saveSettings')[1].payload.patch, {
      translateProvider: 'p', translateModel: 'm', translateEffort: 'high',
    }, '改强度同样一次提交三键（路由原子更新）')

    await choose(h, picker, JSON.stringify(['p', 'm2']))
    await h.waitFor(() => h.calls('saveSettings').length === 3, { label: '切到无强度模型' })
    await h.settle()
    assert.equal(section.querySelector('[data-rss-translate-effort]'), null,
      '该模型没有 efforts 时不渲染思考强度下拉')
  } finally { h.cleanup() }
})

test('刷新面板：translateTarget 从 viewPreferences 恢复，Aa 下拉显示上次选的语言', skip, async () => {
  const h = await mount({
    items: [itemOf('a')],
    articles: { a: articleOf('a', BLOCKS) },
    preferences: {
      navSelection: { kind: 'virtual' }, filter: 'all', navVisible: true, showUnread: true,
      translateTarget: 'ko', reading: { fontSize: 16, lineWidth: 760, theme: 'auto', expandImages: true },
    },
  })
  try {
    await openArticle(h, 'a')
    const language = h.$('[data-rss-target-language]')
    assert.ok(language !== null)
    assert.equal(language.value, 'ko', '目标语言必须从视图记忆恢复，而不是回默认 zh-CN')
  } finally { h.cleanup() }
})
