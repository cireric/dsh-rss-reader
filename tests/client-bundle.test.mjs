/**
 * client bundle 契约测试：直接加载**构建产物** lib/client.js，
 * 用桩 window.__ModuleLoader__ / require / ctx 捕获它实际发出的注册与开页动作。
 *
 * 这一层能抓到浏览器里才会炸、构建却不会报的错：
 *  - panellist 的 id 与 main 的 key 不一致（点图标抛 selecting a missing main entry）；
 *  - 右栏 body 的 key 与标签页类型的 id 不一致（开了页渲染不出来）；
 *  - 底部入口开错 kind（同样渲染不出来）。
 * 需先构建（dev_build_plugin 或 npm run build:client）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(ROOT, 'lib', 'client.js')

const TAB_ID = '@dsh-external/dsh-rss-reader/tab'
const TAB_KIND = 'rssReader'

function loadClientBundle() {
  const source = readFileSync(BUNDLE, 'utf8')
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => { captured = entry } } },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  assert.ok(captured, 'client bundle 没有调用 window.__ModuleLoader__.load')
  for (const field of ['id', 'factory']) assert.ok(captured[field], 'bundle entry 缺 ' + field)
  // 元素桩保留 type/props，测试才能检查 onClick 真正接了什么
  const createElement = (type, props) => ({ type, props })
  const require = (specifier) => {
    if (specifier === 'react' || specifier === 'react/jsx-runtime') {
      return {
        jsx: createElement,
        jsxs: createElement,
        Fragment: Symbol('Fragment'),
        useCallback: (fn) => fn,
        // 立即执行 effect：组件挂载时的转发动作要能被测试观察到
        useEffect: (fn) => { fn() },
        useState: (initial) => [initial, () => undefined],
        default: {},
      }
    }
    throw new Error('未预期的外部依赖：' + specifier)
  }
  return { id: captured.id, exports: captured.factory(require) }
}

/** 以桩 ctx 跑一遍 apply，返回它注册的座位、标签页类型与开页动作。 */
function collectRegistrations() {
  const { id, exports } = loadClientBundle()
  const registrations = []
  const tabTypes = []
  const openedTabs = []
  const panelSelections = []
  const ctx = {
    slots: {
      inject: (_slot, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (definition) => {
        tabTypes.push(definition)
        return () => {}
      },
    },
    sidebarRight: {
      openTab: (kind) => {
        openedTabs.push(kind)
      },
    },
    layout: {
      selectPanel: (panelId) => {
        panelSelections.push(panelId)
      },
    },
    effect: (callback) => {
      const disposer = callback()
      return disposer
    },
  }
  exports.apply(ctx)
  return { id, exports, registrations, tabTypes, openedTabs, panelSelections }
}

test('bundle 以包名注册，且声明所需的浏览器服务', () => {
  const { id, exports } = collectRegistrations()
  assert.equal(id, '@dsh-external/dsh-rss-reader')
  // 展开成宿主 realm 的数组再比：bundle 在 vm 沙箱里跑，数组原型不同源。
  // 两侧都排序：断言的是集合，不依赖声明顺序。
  assert.deepEqual(
    [...exports.inject].sort(),
    ['layout', 'sidebarRight', 'sidebarRightTabs', 'slots'],
    '缺 sidebarRightTabs / sidebarRight 时右栏注册或开页会失败；缺 layout 则主栏让不回去',
  )
})

test('右栏标签页：类型 id 与 body key 必须一致', () => {
  const { registrations, tabTypes } = collectRegistrations()

  assert.equal(tabTypes.length, 1, '必须注册恰好一个标签页类型')
  assert.equal(tabTypes[0].id, TAB_ID)
  assert.equal(tabTypes[0].kind, TAB_KIND)
  assert.equal(typeof tabTypes[0].title, 'function')

  const body = registrations.find((r) => r.options.name === 'sidebar.right.pane.tab')
  assert.ok(body, '没有注册 sidebar.right.pane.tab')
  assert.equal(body.options.key, TAB_ID, 'body 的 key 必须等于标签页类型的 id，否则开页渲染不出来')

  const title = registrations.find((r) => r.options.name === 'sidebar.right.pane.tab.title')
  assert.ok(title, '没有注册 chip 标题座位')
  assert.equal(title.options.key, TAB_ID)
})

test('点主栏入口会把阅读器开进右栏，并把主栏让回默认面板', () => {
  const { registrations, openedTabs, panelSelections, tabTypes } = collectRegistrations()
  const main = registrations.find((r) => r.options.name === 'main')
  assert.ok(main, '没有注册 main（panellist 图标点选会抛错）')

  main.component()
  assert.deepEqual(openedTabs, [tabTypes[0].kind], '开启的 kind 必须等于已注册类型声明的 kind')
  assert.deepEqual(panelSelections, [null], '主栏必须让回默认面板（null＝conversation）')
})

test('注册侧栏图标与主面板，且二者 id 一致', () => {
  const { registrations } = collectRegistrations()
  const panellist = registrations.find((r) => r.options.name === 'sidebar.panellist')
  const main = registrations.find((r) => r.options.name === 'main')

  assert.ok(panellist, '没有注册 sidebar.panellist（侧栏不会出现入口）')
  assert.ok(main, '没有注册 main（点击图标会因缺面板而抛错）')
  assert.equal(
    main.options.key,
    panellist.options.id,
    'main.key 必须等于 panellist.id，否则点击图标会抛 selecting a missing main entry',
  )
  assert.equal(typeof panellist.component, 'function', 'panellist 需要一个图标组件')
  assert.equal(typeof main.component, 'function', 'main 需要一个面板组件')
  assert.equal(typeof panellist.options.label(), 'string', 'label 必须是字符串或返回字符串的函数')
})