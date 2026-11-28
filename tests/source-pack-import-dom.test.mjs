/**
 * R15 09：精选源「勾选 + 导入所选」的 DOM 层验收（spec §4.3.2 / §6 A14）。
 *
 * 为什么单独渲染 `SourcePackView` 而不是整棵 Reader：本票的界面判据只有三件事 ——
 * 每条一个 checkbox、顶部「导入所选（N/M）」在空勾选时禁用、导入结果逐条上屏。
 * 整树挂载要桩 fetch / 存储 / 设置快照，为了验一个 checkbox 不值得。
 *
 * 装配手法照抄 tests/explore-view-dom.test.mjs（jsdom 从 dsh checkout 解析，缺依赖则跳过）：
 * React 必须在 jsdom 全局就位后再 require（docs/pitfalls.md §2.11）；不把 jsdom 节点交给 assert（§2.8）。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')
const require_ = createRequire(join(ROOT, 'package.json'))

/** 依次探测 dsh checkout（与 scripts/build.sh / explore-view-dom.test.mjs 同一串候选）。 */
function checkoutRoot() {
  const home = process.env['HOME'] ?? ''
  const candidates = [
    process.env['DSH_CHECKOUT'],
    join(home, 'dsh-harness'),
    join(home, 'dsh'),
    join(home, '.dsh', 'dsh-harness'),
    join(home, 'deepseek-harness'),
  ]
  return candidates.find((candidate) => candidate !== undefined && existsSync(join(candidate, 'node_modules', '.pnpm')))
}

function pnpmPackage(checkout, prefix) {
  const store = join(checkout, 'node_modules', '.pnpm')
  const dir = readdirSync(store).find((entry) => entry.startsWith(prefix + '@'))
  return dir === undefined ? undefined : join(store, dir, 'node_modules', prefix)
}

function loadStack() {
  const checkout = checkoutRoot()
  if (checkout === undefined) return undefined
  try {
    const jsdomPath = require_.resolve('jsdom', { paths: [checkout] })
    const reactPath = pnpmPackage(checkout, 'react')
    const reactDomPath = pnpmPackage(checkout, 'react-dom')
    if (reactPath === undefined || reactDomPath === undefined) return undefined
    return { JSDOM: require_(jsdomPath).JSDOM, reactPath, reactDomPath }
  } catch (error) {
    console.warn('[source-pack-import-dom] 真实 React/jsdom 装配失败，跳过本组测试：', error instanceof Error ? error.message : error)
    return undefined
  }
}

const STACK = loadStack()
const skip = STACK === undefined ? { skip: '环境缺真实 React/jsdom（见本文件顶部说明）' } : {}
const liveCleanups = []

afterEach(() => {
  for (const cleanup of liveCleanups.splice(0)) cleanup()
})

async function waitFor(check, label) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待超时：' + label)
}

const ENTRY = (url, extra = {}) => ({ url, title: '源 ' + url, addedAt: '2026-10-10T00:00:00.000Z', ...extra })

/** 组件所需的整份 state：只写本组断言会碰到的值，其余按空态给。 */
function packState(patch = {}) {
  return {
    entries: [],
    seed: { collectedAt: '2026-10-10', count: 79 },
    q: '',
    category: undefined,
    loading: false,
    error: undefined,
    warning: undefined,
    notice: undefined,
    saving: false,
    selected: [],
    importing: false,
    importReport: undefined,
    formOpen: false,
    draft: { url: '', title: '', category: '', note: '' },
    probing: false,
    probe: undefined,
    ...patch,
  }
}

async function mountView(state, overrides = {}) {
  const { JSDOM } = STACK
  const globalSnapshot = {}
  for (const key of ['window', 'document', 'HTMLElement', 'Element', 'Node']) globalSnapshot[key] = globalThis[key]
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>')
  const win = dom.window
  globalThis.window = win
  globalThis.document = win.document
  globalThis.HTMLElement = win.HTMLElement
  globalThis.Element = win.Element
  globalThis.Node = win.Node

  const React = require_(STACK.reactPath)
  const jsxRuntime = require_(join(STACK.reactPath, 'jsx-runtime'))
  const createRoot = require_(join(STACK.reactDomPath, 'client')).createRoot

  let captured = null
  win.__ModuleLoader__ = { load: (entry) => { captured = entry } }
  vm.runInThisContext(readFileSync(BUNDLE, 'utf8'), { filename: 'client.js' })
  assert.ok(captured !== null, 'bundle 没有调用 window.__ModuleLoader__.load')
  const exportsObj = captured.factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return jsxRuntime
    throw new Error('未预期的外部依赖：' + specifier)
  })
  assert.equal(typeof exportsObj.SourcePackView, 'function', 'SourcePackView 必须能从 bundle 取到（仅供 DOM 测试的导出）')

  const calls = []
  const props = {
    state,
    onQuery: () => {},
    onCategory: () => {},
    onOpenForm: () => {},
    onCloseForm: () => {},
    onDraft: () => {},
    onProbe: () => {},
    onSave: () => {},
    onRemove: (url) => { calls.push(['remove', url]) },
    onEdit: () => {},
    onEditDraft: () => {},
    onEditSave: () => {},
    onEditCancel: () => {},
    onToggleSelect: (url) => { calls.push(['toggle', url]) },
    onImport: () => { calls.push(['import']) },
    onRestoreSeed: () => {},
    onBack: () => {},
    ...overrides,
  }
  const root = createRoot(win.document.getElementById('root'))
  root.render(React.createElement(exportsObj.SourcePackView, props))
  await waitFor(() => win.document.querySelector('[data-rss-pack-page]') !== null, '精选源视图上屏')

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    try {
      root.unmount()
    } catch (error) {
      console.warn('[source-pack-import-dom] unmount 失败：', error)
    }
    dom.window.close()
    for (const key of Object.keys(globalSnapshot)) globalThis[key] = globalSnapshot[key]
  }
  liveCleanups.push(cleanup)

  return {
    win,
    calls,
    cleanup,
    $: (selector) => win.document.querySelector(selector),
    $$: (selector) => [...win.document.querySelectorAll(selector)],
  }
}

test('每条一个 checkbox；空勾选时「导入所选（0/N）」禁用，勾选后点击回调带 URL', skip, async () => {
  const entries = [ENTRY('https://a.example/feed'), ENTRY('https://b.example/feed')]
  const empty = await mountView(packState({ entries }))
  try {
    assert.equal(empty.$$('[data-rss-pack-select]').length, 2, '每条一个 checkbox')

    const button = empty.$('[data-rss-pack-import]')
    assert.ok(button !== null, '顶部必须有「导入所选」按钮')
    assert.equal(button.disabled, true, '空选择时按钮禁用')
    assert.match(button.textContent ?? '', /导入所选（0\/2）/, '按钮文案带 N/M')

    empty.$$('[data-rss-pack-select]')[0].click()
    assert.deepEqual(empty.calls, [['toggle', 'https://a.example/feed']], '点 checkbox 只上报 URL，由动作层维护勾选')
  } finally {
    empty.cleanup()
  }

  const selected = await mountView(packState({ entries, selected: [entries[1].url] }))
  try {
    const enabled = selected.$('[data-rss-pack-import]')
    assert.equal(enabled.disabled, false, '有勾选时按钮可用')
    assert.match(enabled.textContent ?? '', /导入所选（1\/2）/)
    assert.equal(selected.$$('[data-rss-pack-select]')[1].checked, true, '勾选态回填到对应行')
  } finally {
    selected.cleanup()
  }
})

test('超过 30 条：顶部直接提示分批（动作层负责不发请求）', skip, async () => {
  const entries = Array.from({ length: 31 }, (_, index) => ENTRY('https://s' + index + '.example/feed'))
  const view = await mountView(packState({ entries, selected: entries.map((entry) => entry.url) }))
  try {
    const hint = view.$('[data-rss-pack-import-limit]')
    assert.ok(hint !== null, '超限必须有提示')
    assert.match(hint.textContent ?? '', /一次最多导入 30 条/)
    assert.match(hint.textContent ?? '', /当前勾选 31 条/)
  } finally {
    view.cleanup()
  }
})

test('导入结果逐条上屏：新增 / 已存在汇总、失败带原因、跳过项也展示', skip, async () => {
  const entries = [ENTRY('https://good.example/feed'), ENTRY('https://bad.example/feed')]
  const view = await mountView(packState({
    entries,
    importReport: {
      added: 1,
      existed: 2,
      failed: [{ url: 'https://bad.example/feed', reason: 'HTTP 404' }],
      skipped: [{ title: '坏项', reason: 'URL 非法：ftp://x' }],
      accepted: [{ url: 'https://good.example/feed', title: '好源', folder: '科技' }],
    },
  }))

  try {
    const report = view.$('[data-rss-pack-import-report]')
    assert.ok(report !== null, '导入结果块必须出现')
  assert.match(view.$('[data-rss-pack-import-summary]')?.textContent ?? '', /新增 1 条/)
  assert.match(view.$('[data-rss-pack-import-summary]')?.textContent ?? '', /已存在 2 条/)

  const failed = view.$('[data-rss-pack-import-failed-row="https://bad.example/feed"]')
  assert.ok(failed !== null, '失败条目必须逐条列出')
  assert.match(failed.textContent ?? '', /HTTP 404/, '失败要带原因（不是只报个数字）')
  assert.equal(view.$('[data-rss-pack-import-accepted="https://bad.example/feed"]'), null, '失败条目不能出现在已入库清单里')

  const skipped = view.$('[data-rss-pack-import-skipped]')
  assert.ok(skipped !== null, '文件内跳过项也要展示')
  assert.match(skipped.textContent ?? '', /URL 非法/)
    assert.equal(view.$$('[data-rss-pack-entry]').length, 2, '结果块不影响源包清单：条目仍然在')
  } finally {
    view.cleanup()
  }
})

/** 受控 input 写值并派发 React 认的 input 事件（原生 setter 绕过 value tracker，pitfalls §2.11）。 */
function typeInto(win, element, value) {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) throw new Error('找不到 INPUT 的 value setter')
  setter.call(element, value)
  element.dispatchEvent(new win.Event('input', { bubbles: true }))
}

test('行内编辑：点「编辑」上报 URL；编辑态回填并可改分类 / 备注、保存与取消各自回调（spec §4.3.1）', skip, async () => {
  const entries = [
    ENTRY('https://a.example/feed', { category: '科技', note: '旧备注' }),
    ENTRY('https://b.example/feed', { category: '播客' }),
  ]
  const calls = []
  const view = await mountView(packState({ entries }), {
    onEdit: (url) => { calls.push(['edit', url]) },
    onEditDraft: (patch) => { calls.push(['draft', patch]) },
    onEditSave: () => { calls.push(['save']) },
    onEditCancel: () => { calls.push(['cancel']) },
  })
  try {
    const editButtons = view.$$('[data-rss-pack-edit]')
    assert.equal(editButtons.length, 2, '每条都有自己的编辑入口')
    editButtons[0].click()
    assert.deepEqual(calls.at(-1), ['edit', 'https://a.example/feed'], '编辑按钮只上报条目 URL，草稿由动作层持有')
  } finally {
    view.cleanup()
  }

  const editing = await mountView(packState({
    entries,
    editing: { url: 'https://a.example/feed', category: '科技', note: '旧备注' },
  }), {
    onEditDraft: (patch) => { calls.push(['draft', patch]) },
    onEditSave: () => { calls.push(['save']) },
    onEditCancel: () => { calls.push(['cancel']) },
  })
  try {
    const form = editing.$('[data-rss-pack-edit-form]')
    assert.ok(form !== null, '编辑态必须只在那一条下面展开表单')
    assert.equal(editing.$$('[data-rss-pack-edit-form]').length, 1, '同时只编辑一条')

    const category = editing.$('[data-rss-pack-edit-category]')
    const note = editing.$('[data-rss-pack-edit-note]')
    assert.equal(category?.value, '科技', '分类输入回填当前值')
    assert.equal(note?.value, '旧备注', '备注输入回填当前值')

    typeInto(editing.win, category, '科学')
    assert.deepEqual(calls.at(-1), ['draft', { category: '科学' }], '输入即上报草稿 patch（受控输入）')
    typeInto(editing.win, note, '新备注')
    assert.deepEqual(calls.at(-1), ['draft', { note: '新备注' }])

    editing.$('[data-rss-pack-edit-save]').click()
    editing.$('[data-rss-pack-edit-cancel]').click()
    assert.deepEqual(calls.slice(-2), [['save'], ['cancel']], '保存 / 取消各自回动作层，组件不直调 RPC')
  } finally {
    editing.cleanup()
  }
})

// ── 评审 F3（2026-11-28）：校验结论的归属必须画在界面上 ────────────────────────

test('F3：校验的是另一个地址时，界面说清是哪一个，且只给「仍然保存（未验证）」', skip, async () => {
  const h = await mountView(packState({
    formOpen: true,
    // 用户粘的是站点首页，实际验证的是页面声明的 feed。
    draft: { url: 'https://blog.example/', title: '博客', category: '', note: '' },
    probe: { ok: true, url: 'https://blog.example/feed.xml', format: 'rss2', itemCount: 20, title: '博客' },
  }))
  const text = h.$('[data-rss-pack-probe-result]')?.textContent ?? ''
  assert.match(text, /blog\.example\/feed\.xml/, '必须点名真正验证过的地址')
  assert.match(text, /不是上面这个地址/, '必须说清「验的不是你要存的那条」')
  assert.equal(h.$('[data-rss-pack-save]'), null,
    '地址不同 ⇒ 不许给「保存」（那会把未验证的地址标成已验证）')
  assert.notEqual(h.$('[data-rss-pack-save-unverified]'), null,
    '只能走「仍然保存（未验证）」')
})

test('F3：同一个地址且验证通过 ⇒ 正常给「保存」，文案不提另一条地址', skip, async () => {
  const h = await mountView(packState({
    formOpen: true,
    draft: { url: 'https://good.example/feed', title: '好源', category: '', note: '' },
    probe: { ok: true, url: 'https://good.example/feed', format: 'rss2', itemCount: 3, title: '好源' },
  }))
  const text = h.$('[data-rss-pack-probe-result]')?.textContent ?? ''
  assert.match(text, /已验证/)
  assert.equal(text.includes('不是上面这个地址'), false, '同一地址不该出现错位提示')
  assert.notEqual(h.$('[data-rss-pack-save]'), null, '验证通过 ⇒ 给「保存」')
  assert.equal(h.$('[data-rss-pack-save-unverified]'), null, '不需要「仍然保存」')
})
