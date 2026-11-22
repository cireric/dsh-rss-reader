/**
 * settings 端点的回包与「启动时合并」的优先级（R11 01，spec D3–D4.1 / D6 / A4 / B9–B11）。
 *
 * 这一层只验**已装配的宿主**：settings 控制器读文件、把 overrides 合并进同一份 config，
 * 端点再把生效值 / 默认值 / 读侧告警交给界面。合并顺序是整张票的核心 —— 它错了，
 * 页面上看到的数字就不是下一次刷新真正会用的值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/config.js'
import { createDispatch } from '../lib/endpoints.js'
import { createMemoryStore } from '../lib/memory-store.js'
import { createSettingsControl } from '../lib/settings-control.js'
import { selectStalestFeeds } from '../lib/refresh.js'

const TUNABLE = ['refreshFeedsPerRound', 'refreshConcurrency', 'minRefreshIntervalMs', 'cleanupAfterDays']

/**
 * 装配一份「生产同形」的 settings 控制器 + dispatch。
 *
 * 刻意不经过 apply：apply 要整个宿主 ctx，而这条链的语义全在控制器与 dispatch 之间。
 * @param options.patch 插件配置（模拟 profile patch 的显式值）
 * @param options.file  settings.json 的原文；不给 = 文件不存在
 */
function harness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-settings-endpoint-'))
  const settingsPath = join(dir, 'settings.json')
  if (options.file !== undefined) writeFileSync(settingsPath, options.file)
  const logs = []
  // 记录每次 refreshNow 开跑时读到的「每轮源数」：保存是否真的对**下一次刷新**生效，靠它证明。
  const refreshReads = []
  const config = Config(options.patch ?? {})
  const settings = createSettingsControl({ config, settingsPath, log: (line) => logs.push(line) })
  const store = createMemoryStore()
  const dispatch = createDispatch({
    config,
    log: () => {},
    ready: () => store,
    refreshNow: async () => {
      refreshReads.push(config.refreshFeedsPerRound)
      return { outcome: 'not-ready', attempted: 0, total: 0 }
    },
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
    settings,
  })
  return {
    config, settings, dispatch, dir, settingsPath, logs, refreshReads,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

async function settingsOf(h) {
  const result = await h.dispatch('settings', null)
  assert.equal(result.ok, true, 'settings 端点应当成功')
  return result.value.settings
}

test('settings 回包：effective / defaults 都覆盖四个可调键，默认值来自 schema', async () => {
  const h = harness()
  try {
    const settings = await settingsOf(h)
    assert.deepEqual(Object.keys(settings.effective).sort(), [...TUNABLE].sort(), '生效值必须覆盖四个可调键')
    assert.deepEqual(settings.defaults, {
      refreshFeedsPerRound: 20,
      refreshConcurrency: 5,
      minRefreshIntervalMs: 600000,
      cleanupAfterDays: 30,
    }, '默认值由 Config({}) 现取，客户端不硬编码')
    assert.deepEqual(settings.effective, settings.defaults, '没有 settings.json 时生效值就是默认值')
    assert.equal(settings.warning, undefined, '文件不存在是正常首装，不该报警')
  } finally {
    h.cleanup()
  }
})

test('settings 覆盖优先级：settings.json > patch 基线，未覆盖的键仍跟 patch', async () => {
  const h = harness({
    // patch 显式写了两个值：settings.json 只能盖住它点名的那一个。
    patch: { refreshConcurrency: 5, cleanupAfterDays: 45 },
    file: JSON.stringify({ version: 1, overrides: { refreshConcurrency: 8 } }),
  })
  try {
    const settings = await settingsOf(h)
    assert.equal(settings.effective.refreshConcurrency, 8, 'settings.json 的覆盖必须赢过 patch')
    assert.equal(settings.effective.cleanupAfterDays, 45, '没覆盖的键必须继续跟 patch（patch 是基线）')
    assert.equal(h.config.refreshConcurrency, 8, '合并必须写进**同一个** config 对象（lifecycle 拿的是这个引用）')
    assert.equal(h.config.cleanupAfterDays, 45, '未覆盖的键在内存里也不能被默认值顶掉')
  } finally {
    h.cleanup()
  }
})

test('坏 JSON：原文件隔离、生效值回继承值、回包带可展示的警示', async () => {
  const h = harness({
    patch: { refreshConcurrency: 6 },
    file: '{ 这不是 JSON',
  })
  try {
    const settings = await settingsOf(h)
    assert.equal(settings.effective.refreshConcurrency, 6, '坏文件不阻断启动：生效值回继承值')
    assert.match(settings.warning ?? '', /设置文件无法读取.*已隔离为/, '警示条文案要说明隔离结果')
    assert.match(settings.warning ?? '', /settings\.json\.corrupt-/, '文案里要给出隔离文件路径')
    assert.equal(readdirSync(h.dir).filter((name) => name.startsWith('settings.json.corrupt-')).length, 1,
      '原文件必须真的被改名隔离')
    assert.ok(h.logs.some((line) => line.includes('设置文件')), '隔离必须留一行日志')
  } finally {
    h.cleanup()
  }
})

test('坏值逐键丢：合法的照用、非法的只报数量，文件不被重写', async () => {
  const file = JSON.stringify({
    version: 1,
    overrides: { refreshConcurrency: 0, refreshFeedsPerRound: 7, rsshubBase: 'https://ignored.example' },
  })
  const h = harness({ file })
  try {
    const settings = await settingsOf(h)
    assert.equal(settings.effective.refreshFeedsPerRound, 7, '同一份文件里的合法键必须生效')
    assert.equal(settings.effective.refreshConcurrency, 5, '坏值只该丢它自己，回落到继承值')
    assert.equal(settings.warning, '有 1 项设置无法识别，已忽略', '未知键不算坏值，只有 refreshConcurrency 这一项')
  } finally {
    h.cleanup()
  }
})

// ── R11 02：第一个参数可写（spec D4.1 / D7 / D8 / D9，验收 A1–A3、A6–A7、B12）────────────
//
// 这一组只经**端点**驱动保存：写盘 / 内存 / 日志三条副作用必须一起成立。直接调控制器会
// 绕过入参校验（那正是「非法值零写盘」的入口），而票据要求的是端点语义。

/** 读当前 settings.json 的原文（不存在时返回 undefined）——「文件没被动过」也靠它。 */
function fileText(h) {
  try {
    return readFileSync(h.settingsPath, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

test('saveSettings 稀疏写：只改一项就只写这一个键，形状 { version, overrides }、权限 0600、内存立即生效并留痕', async () => {
  const h = harness()
  try {
    const result = await h.dispatch('saveSettings', { patch: { refreshFeedsPerRound: 7 } })
    assert.equal(result.ok, true, '合法保存必须成功')
    assert.equal(result.value.settings.effective.refreshFeedsPerRound, 7, '回包里的生效值必须是新值')
    assert.deepEqual(result.value.settings.defaults, {
      refreshFeedsPerRound: 20, refreshConcurrency: 5, minRefreshIntervalMs: 600000, cleanupAfterDays: 30,
    }, '回包形状与 settings 读端点同形（客户端据此统一落地）')

    assert.deepEqual(JSON.parse(fileText(h)), { version: 1, overrides: { refreshFeedsPerRound: 7 } },
      '稀疏覆盖：只改这一项时 overrides 里不许出现另外三个键')
    assert.equal(statSync(h.settingsPath).mode & 0o777, 0o600, 'settings.json 的权限必须是 0600')
    assert.equal(h.config.refreshFeedsPerRound, 7,
      '写盘成功后必须改**同一个** config 对象 —— lifecycle 下一次 refreshNow 读到的就是它')
    await h.dispatch('refresh', {})
    assert.deepEqual(h.refreshReads, [7], '下一次 refreshNow 开跑时读到的必须是 7')
    assert.ok(h.logs.includes('设置：refreshFeedsPerRound 20 → 7'),
      '每次成功保存要留一行「旧 → 新」（D8）；实际日志：' + JSON.stringify(h.logs))
  } finally {
    h.cleanup()
  }
})

test('saveSettings 稀疏合并不吞别的覆盖：已有键原样保留，认不出的键在保存时被丢弃（D6 第三类）', async () => {
  const h = harness({
    file: JSON.stringify({ version: 1, overrides: { cleanupAfterDays: 45, rsshubBase: 'https://rsshub.example' } }),
  })
  try {
    const result = await h.dispatch('saveSettings', { patch: { refreshFeedsPerRound: 7 } })
    assert.equal(result.ok, true)
    assert.deepEqual(JSON.parse(fileText(h)), {
      version: 1,
      overrides: { refreshFeedsPerRound: 7, cleanupAfterDays: 45 },
    }, '保存只更新白名单内被点名的键；本版不认识的键不许被回写')
  } finally {
    h.cleanup()
  }
})

test('saveSettings 重启保持：重新创建 settings 控制器（模拟重启）仍是 7', async () => {
  const h = harness()
  try {
    const result = await h.dispatch('saveSettings', { patch: { refreshFeedsPerRound: 7 } })
    assert.equal(result.ok, true)

    // 模拟重启：同一份 $DSH_HOME 目录、全新的 Config 与控制器（与 apply 的创建顺序一致）。
    const restartedConfig = Config({})
    const restarted = createSettingsControl({
      config: restartedConfig,
      settingsPath: h.settingsPath,
      log: () => {},
    })
    assert.equal(restarted.snapshot().effective.refreshFeedsPerRound, 7, '重启后仍应是 7')
    assert.equal(restartedConfig.refreshFeedsPerRound, 7, '重启后的 config 对象也必须被合并成 7')
  } finally {
    h.cleanup()
  }
})

test('saveSettings 接受 0：0 合法，且「抓全部源」由既有 selectStalestFeeds 判据给出', async () => {
  const h = harness()
  try {
    const result = await h.dispatch('saveSettings', { patch: { refreshFeedsPerRound: 0 } })
    assert.equal(result.ok, true, '0 不是非法值（spec §4.1：0 = 抓全部源）')
    assert.equal(result.value.settings.effective.refreshFeedsPerRound, 0)
    assert.equal(h.config.refreshFeedsPerRound, 0)

    // 0 的语义不是设置层自己的规则：它由 selectStalestFeeds 的 `!(limit > 0)` 分支保证。
    const feeds = [['a', { url: 'a' }], ['b', { url: 'b' }], ['c', { url: 'c' }]]
    assert.deepEqual(selectStalestFeeds(feeds, h.config.refreshFeedsPerRound), ['a', 'b', 'c'],
      'limit = 0 必须抓全部源，不许当成「一个都不抓」')
  } finally {
    h.cleanup()
  }
})

test('saveSettings 非法值：负数 / 超上限 / 非数字都回 bad-request，文件与内存都不变', async () => {
  const h = harness({ patch: { refreshFeedsPerRound: 33 } })
  try {
    for (const bad of [-1, 1000, '7', 7.5, null, true]) {
      const result = await h.dispatch('saveSettings', { patch: { refreshFeedsPerRound: bad } })
      assert.equal(result.ok, false, '非法值必须被拒：' + JSON.stringify(bad))
      assert.equal(result.error.code, 'bad-request', '非法值走统一坏入参信封：' + JSON.stringify(bad))
      assert.equal(fileText(h), undefined, '被拒的保存不许创建设置文件')
      assert.equal(h.config.refreshFeedsPerRound, 33, '被拒的保存不许改内存')
    }
    assert.equal(h.settings.snapshot().effective.refreshFeedsPerRound, 33, '端点快照仍是旧值')
  } finally {
    h.cleanup()
  }
})

test('saveSettings 写盘失败：端点回错误，内存旧值与文件旧内容都不变（先落盘再改内存，D7）', async () => {
  const h = harness({ file: JSON.stringify({ version: 1, overrides: { refreshFeedsPerRound: 7 } }) })
  const before = fileText(h)
  try {
    // 让写盘注定失败：目录去掉写权限 ⇒ 临时文件建不出来（测试跑在非 root 用户下）。
    chmodSync(h.dir, 0o500)
    let result
    try {
      result = await h.dispatch('saveSettings', { patch: { refreshFeedsPerRound: 9 } })
    } finally {
      chmodSync(h.dir, 0o700)
    }
    assert.equal(result.ok, false, '写盘失败必须回错误，不许静默成功')
    assert.equal(result.error.code, 'write-failed', '写盘失败要有可诊断的错误码')
    assert.equal(h.config.refreshFeedsPerRound, 7, '写盘失败时进程内生效值必须保持旧值')
    assert.equal(fileText(h), before, '写盘失败时文件必须保持旧内容')
    assert.equal(h.settings.snapshot().effective.refreshFeedsPerRound, 7, '端点快照也不许变')
  } finally {
    h.cleanup()
  }
})

test('saveSettings 入参二选一：resetToDefaults 本票明确回「未实现」，不许静默成功', async () => {
  const h = harness()
  try {
    const result = await h.dispatch('saveSettings', { resetToDefaults: true })
    assert.equal(result.ok, false, '07 票才实现恢复默认；现在不能假装成功')
    assert.equal(result.error.code, 'not-implemented')
    assert.match(result.error.message, /恢复默认/)
    assert.equal(fileText(h), undefined, '未实现的分支不许写盘')
  } finally {
    h.cleanup()
  }
})
