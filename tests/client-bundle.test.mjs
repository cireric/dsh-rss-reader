/**
 * client bundle 契约测试：直接加载**构建产物** lib/client.js，
 * 用桩 window.__ModuleLoader__ / require / ctx 捕获它实际发出的注册与开页动作。
 *
 * 这一层能抓到浏览器里才会炸、构建却不会报的错：panellist 的 id 与 main 的 key 不一致
 * （点图标会抛 selecting a missing main entry，面板根本打不开）。
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
  const ctx = {
    slots: {
      inject: (_slot, callback) => callback(),
      register: (options, component) => {
        registrations.push({ options, component })
        return () => {}
      },
    },
    effect: (callback) => {
      const disposer = callback()
      return disposer
    },
  }
  exports.apply(ctx)
  return { id, exports, registrations }
}

test('bundle 以包名注册，且声明所需的浏览器服务', () => {
  const { id, exports } = collectRegistrations()
  assert.equal(id, '@dsh-external/dsh-rss-reader')
  // 展开成宿主 realm 的数组再比：bundle 在 vm 沙箱里跑，数组原型不同源。
  // 两侧都排序：断言的是集合，不依赖声明顺序。
  assert.deepEqual(
    [...exports.inject].sort(),
    ['slots'],
    '缺 inject 声明时宿主不会提供 slots 服务',
  )
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