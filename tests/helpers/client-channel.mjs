/**
 * 客户端测试的**共享世界**（阶段 4 票据 02）。
 *
 * 为什么要它：nav-selection / unread-accounting / nav-persistence / client-bundle 四个文件各自
 * 用 vm + React 假件 + fetch 桩搭一遍客户端环境，桩之间已经漂移。store 现在收 ReaderStoreDeps
 * （见 src/client/store.ts），所以「通道」可以是纯函数里的一个假实现 —— 不必再往沙箱塞 fetch。
 *
 * 这个文件只负责三件事：加载 bundle、给 React 假件、造一条记录调用的假 rpc。
 * 各测试自己的数据（overview 长什么样、要不要失败回包）通过参数给。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

export const BUNDLE = fileURLToPath(new URL('../../lib/client.js', import.meta.url))
export const BUNDLE_NAME = 'client.js'

/** 只够「模块定义跑得通」的 React 假件：本组测试驱动 store，不渲染组件树。 */
export function reactStub() {
  return {
    jsx: () => null, jsxs: () => null, Fragment: Symbol('Fragment'),
    useEffect: () => {}, useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useCallback: (fn) => fn, useRef: (initial) => ({ current: initial }), default: {},
  }
}

/**
 * 加载真实构建产物，取出它导出的模块。
 *
 * @param globals 追加进沙箱的全局（例如 setTimeout / AbortController —— 缺一个的表现是整组报错，
 *                而不是断言失败，所以这里显式要求调用方补齐自己会碰到的那些）
 */
export function loadClientModule(globals = {}) {
  const source = readFileSync(BUNDLE, 'utf8')
  let captured = null
  class HTMLElementStub {}
  const sandbox = {
    document: { addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null, activeElement: null },
    window: { __ModuleLoader__: { load: (entry) => { captured = entry } }, open: () => {} },
    console,
    HTMLElement: HTMLElementStub,
    JSON,
    Date,
    ...globals,
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: BUNDLE_NAME })
  if (captured === null) throw new Error('client bundle 没有调用 window.__ModuleLoader__.load')
  const require = (specifier) => {
    if (specifier === 'react' || specifier === 'react/jsx-runtime') return reactStub()
    throw new Error('未预期的外部依赖：' + specifier)
  }
  return { exports: captured.factory(require), sandbox }
}

/**
 * 一条记录调用序列的假 rpc。
 *
 * @param overview  overview 回包；若含 `pages`，按 payload.cursor 分派（分页断言要能看见回带了哪个游标）
 * @param request   其它端点的自定义回包：(endpoint, payload) => 值 | undefined（undefined = 走默认）
 */
export function createFakeChannel({ overview, request } = {}) {
  const calls = []
  const pages = overview?.pages ?? {}
  const pageCalls = []
  const base = pages.base ?? overview
  const rpc = async (endpoint, payload, signal) => {
    calls.push([endpoint, payload])
    // 搜索用例要看「旧请求被 abort」：把 signal 原样交给自定义处理器（与真实通道同形）。
    if (endpoint === 'searchItems' && overview?.search) return overview.search(payload, signal)
    if (request !== undefined) {
      const mocked = await request(endpoint, payload)
      if (mocked !== undefined) return mocked
    }
    if (endpoint === 'overview') {
      const cursor = payload?.cursor
      pageCalls.push(cursor)
      if (cursor === undefined) return base
      const page = pages[cursor]
      if (page === undefined) throw new Error('测试桩没有为游标 ' + cursor + ' 准备回包')
      return page
    }
    return { changed: 1, unread: 0 }
  }
  return { rpc, calls, pageCalls }
}
