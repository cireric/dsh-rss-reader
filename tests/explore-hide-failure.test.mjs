/**
 * R15 07 / 评审 F2（2026-11-28）：探索页「隐藏此站点」的失败必须可见。
 *
 * 病象：写盘失败（磁盘满 / 权限 / 文件被外部改坏）时，订阅页会给红字，探索页一片安静 ——
 * 用户以为「点了没反应」，而隐藏其实没生效。根因是探索域拿到的是**裸的**
 * `settingsActions.hideRsshubNamespace`（只记一行日志），而不是根上的组合动作 `hideNamespace`
 * （它把失败画成 `state.error`）。
 *
 * 这条用例钉的是「两个入口共用同一条失败通道」这句话本身：把它当断言，而不是当注释。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadClientModule } from './helpers/client-channel.mjs'

/** 一个最小可用的客户端 store：只桩本用例会走到的四个端点。 */
function makeStore({ saveFails }) {
  const calls = []
  const { exports } = loadClientModule({ AbortController, setTimeout, clearTimeout, URL })
  const settings = { instances: ['https://hub.test'], hiddenNamespaces: [], hideNsfw: true }
  const store = exports.createReaderStore({
    rpc: async (endpoint, payload) => {
      calls.push([endpoint, payload])
      if (endpoint === 'rsshubSettings') return { rsshub: settings }
      if (endpoint === 'saveRsshubSettings') {
        if (saveFails) throw new Error('写盘失败：EACCES')
        return {
          rsshub: {
            ...settings,
            hiddenNamespaces: payload.hiddenNamespaces ?? settings.hiddenNamespaces,
            hideNsfw: payload.hideNsfw ?? settings.hideNsfw,
          },
        }
      }
      if (endpoint === 'exploreCatalog') {
        return { siteTotal: 1, routeTotal: 1, matched: 1, categories: [], items: [], nextCursor: undefined }
      }
      return { changed: 0, unread: 0 }
    },
  })
  return { store, calls }
}

/** 等一次微任务轮次：openExplore 的第一页请求是 fire-and-forget。 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

test('F2：探索页隐藏站点写盘失败 ⇒ 全局 error 必须给出「隐藏站点失败」', async () => {
  const { store } = makeStore({ saveFails: true })
  await store.loadRsshubSettings()
  store.openExplore()
  await settle()

  await store.hideExploreNamespace('github')

  assert.match(String(store.get().error), /隐藏站点失败/,
    '写盘失败必须在界面上可见（探索页与订阅页共用同一条失败通道）')
})

test('F2：订阅页隐藏站点写盘失败 ⇒ 同一条通道，文案一致（对照，防回归）', async () => {
  const { store } = makeStore({ saveFails: true })
  await store.loadRsshubSettings()

  await store.hideNamespace('github')

  assert.match(String(store.get().error), /隐藏站点失败/, '组合动作自己的通道不许漂')
})

test('F2：探索页隐藏成功 ⇒ 不许留下错误，且要用新筛选重取第一页', async () => {
  const { store, calls } = makeStore({ saveFails: false })
  await store.loadRsshubSettings()
  store.openExplore()
  await settle()
  const before = calls.filter(([endpoint]) => endpoint === 'exploreCatalog').length

  await store.hideExploreNamespace('github')

  assert.equal(store.get().error, undefined, '成功路径不许挂错误')
  // vm 沙箱里的数组跨 realm，deepEqual 会因原型不同而红（docs/pitfalls.md §2.12）⇒ 比字符串。
  assert.equal([...store.get().rsshubSettings.hiddenNamespaces].join(','), 'github', '快照落进权威状态')
  const after = calls.filter(([endpoint]) => endpoint === 'exploreCatalog').length
  assert.equal(after, before + 1, '隐藏是筛选条件的一部分 ⇒ 必须重取第一页（游标整份作废）')
})
