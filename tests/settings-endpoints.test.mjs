/**
 * settings 端点的回包与「启动时合并」的优先级（R11 01，spec D3–D4.1 / D6 / A4 / B9–B11）。
 *
 * 这一层只验**已装配的宿主**：settings 控制器读文件、把 overrides 合并进同一份 config，
 * 端点再把生效值 / 默认值 / 读侧告警交给界面。合并顺序是整张票的核心 —— 它错了，
 * 页面上看到的数字就不是下一次刷新真正会用的值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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
  const concurrencyReads = []
  const config = Config(options.patch ?? {})
  const settings = createSettingsControl({ config, settingsPath, log: (line) => logs.push(line) })
  const store = createMemoryStore()
  const dispatch = createDispatch({
    config,
    log: () => {},
    ready: () => store,
    refreshNow: async () => {
      refreshReads.push(config.refreshFeedsPerRound)
      concurrencyReads.push(config.refreshConcurrency)
      return { outcome: 'not-ready', attempted: 0, total: 0 }
    },
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
    settings,
  })
  return {
    config, settings, dispatch, dir, settingsPath, logs, refreshReads, concurrencyReads,
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

// ── R11 07：恢复默认（spec D28 / D8，验收 A5 / C15）────────────────────────────
//
// 核心规则只有一条：**继承值恰好等于默认值 ⇒ 删覆盖；不等于默认值 ⇒ 写一条等于默认值的覆盖**。
// 前者保证「恢复默认」不留下无意义的钉子（否则将来改默认值这项不再跟随），后者保证结果一定是
// 「生效值 = 默认值」—— 因为删掉覆盖会回落到 patch 基线，而基线本身不等于默认。

const TUNABLE_DEFAULTS = {
  refreshFeedsPerRound: 20,
  refreshConcurrency: 5,
  minRefreshIntervalMs: 600000,
  cleanupAfterDays: 30,
}

/** 除四个可调键之外的 Config 字段（恢复默认不许碰它们）。 */
function nonTunableConfig(config) {
  const { refreshFeedsPerRound, refreshConcurrency, minRefreshIntervalMs, cleanupAfterDays, ...rest } = config
  return rest
}

test('saveSettings 恢复默认：继承值等于默认的键删覆盖，不等于默认的键写一条等于默认值的覆盖（A5）', async () => {
  const h = harness({
    // patch 基线：两个键显式写成默认值（继承值 = 默认 ⇒ 该删覆盖），清理天数写 45（不等 ⇒ 该写覆盖）。
    patch: { refreshConcurrency: 5, cleanupAfterDays: 45 },
    file: JSON.stringify({ version: 1, overrides: {
      refreshFeedsPerRound: 7,
      refreshConcurrency: 8,
      minRefreshIntervalMs: 120000,
      cleanupAfterDays: 60,
    } }),
  })
  const restBefore = nonTunableConfig(h.config)
  try {
    const result = await h.dispatch('saveSettings', { resetToDefaults: true })
    assert.equal(result.ok, true, '恢复默认必须成功')
    assert.deepEqual(result.value.settings.effective, TUNABLE_DEFAULTS,
      '一次请求后四项生效值必须全部回到默认（客户端不再补发其它请求）')
    assert.deepEqual(JSON.parse(fileText(h)), { version: 1, overrides: { cleanupAfterDays: 30 } },
      '继承值 = 默认值的三项必须删覆盖；cleanupAfterDays 继承 45 ≠ 30 ⇒ 写一条等于默认值的覆盖')
    // 文件与内存必须一致：下一次 refreshNow / cleanup 读的是同一个 config 对象。
    assert.deepEqual({
      refreshFeedsPerRound: h.config.refreshFeedsPerRound,
      refreshConcurrency: h.config.refreshConcurrency,
      minRefreshIntervalMs: h.config.minRefreshIntervalMs,
      cleanupAfterDays: h.config.cleanupAfterDays,
    }, TUNABLE_DEFAULTS)
    assert.deepEqual(h.settings.snapshot().effective, TUNABLE_DEFAULTS, '端点快照与内存一致')
    assert.deepEqual(h.logs.filter((line) => line.startsWith('恢复默认：')), [
      '恢复默认：refreshFeedsPerRound 删覆盖（20）',
      '恢复默认：refreshConcurrency 删覆盖（5）',
      '恢复默认：minRefreshIntervalMs 删覆盖（600000）',
      '恢复默认：cleanupAfterDays 60 → 30',
    ], 'D8：逐键记实际动作 —— 删覆盖记结果值，写覆盖记旧生效值 → 新值')
    // 只碰四个可调键：settings.json 里不会出现白名单之外的键（显示区开关根本不在这个文件里）。
    assert.deepEqual(Object.keys(JSON.parse(fileText(h)).overrides), ['cleanupAfterDays'],
      '恢复默认的写入面只有四个可调键')
    assert.deepEqual(nonTunableConfig(h.config), restBefore,
      '恢复默认只碰四个可调键：其余 Config 字段（订阅种子 / 抓取参数 / 日期等）原样不动')
  } finally {
    h.cleanup()
  }
})

test('saveSettings 恢复默认：继承值不等于默认且原本没有覆盖时补一条默认覆盖，重复调用不再写盘', async () => {
  const h = harness({ patch: { cleanupAfterDays: 45 } })
  try {
    const first = await h.dispatch('saveSettings', { resetToDefaults: true })
    assert.equal(first.ok, true)
    assert.deepEqual(JSON.parse(fileText(h)), { version: 1, overrides: { cleanupAfterDays: 30 } },
      '删覆盖会回落 45，所以必须补一条 30 的覆盖')
    assert.equal(first.value.settings.effective.cleanupAfterDays, 30)
    assert.deepEqual(h.logs.filter((line) => line.startsWith('恢复默认：')),
      ['恢复默认：cleanupAfterDays 45 → 30'])

    // 再把 mtime 拨到过去：第二次恢复默认已经是幂等态（四项都等于默认），不该再写一次文件。
    const past = new Date('2000-01-01T00:00:00Z')
    utimesSync(h.settingsPath, past, past)
    const beforeMtime = statSync(h.settingsPath).mtimeMs
    const logsBefore = h.logs.length
    const second = await h.dispatch('saveSettings', { resetToDefaults: true })
    assert.equal(second.ok, true, '已经全默认时再点一次也必须成功（幂等），不许报错')
    assert.equal(statSync(h.settingsPath).mtimeMs, beforeMtime, '没有实际动作时不许重写文件')
    assert.equal(h.logs.length, logsBefore, '没有实际动作时不许编造日志')
  } finally {
    h.cleanup()
  }
})

test('saveSettings 恢复默认：四项本来就都是继承默认时不创建 settings.json（没有钉子可删）', async () => {
  const h = harness()
  try {
    const result = await h.dispatch('saveSettings', { resetToDefaults: true })
    assert.equal(result.ok, true)
    assert.equal(fileText(h), undefined, '全默认时恢复默认不该凭空造一份空覆盖文件')
    assert.deepEqual(result.value.settings.effective, TUNABLE_DEFAULTS)
    assert.deepEqual(h.logs.filter((line) => line.startsWith('恢复默认：')), [],
      '没有任何实际动作就不该逐键记「删覆盖」')
  } finally {
    h.cleanup()
  }
})

test('saveSettings 恢复默认写盘失败：端点回 write-failed，内存与文件都不变（D7 同一条顺序）', async () => {
  const h = harness({
    patch: { cleanupAfterDays: 45 },
    file: JSON.stringify({ version: 1, overrides: { refreshConcurrency: 8 } }),
  })
  const beforeFile = fileText(h)
  try {
    chmodSync(h.dir, 0o500)
    let result
    try {
      result = await h.dispatch('saveSettings', { resetToDefaults: true })
    } finally {
      chmodSync(h.dir, 0o700)
    }
    assert.equal(result.ok, false, '写盘失败必须回错误（恢复默认不能假装成功）')
    assert.equal(result.error.code, 'write-failed', '错误码与「你输错了」分开')
    assert.equal(fileText(h), beforeFile, '写盘失败时文件保持旧内容')
    assert.equal(h.config.refreshConcurrency, 8, '写盘失败时内存生效值保持旧值')
    assert.equal(h.config.cleanupAfterDays, 45)
    assert.deepEqual(h.logs.filter((line) => line.startsWith('恢复默认：')), [],
      '没写成功就不能留下「已恢复」的日志')
  } finally {
    h.cleanup()
  }
})

// ── R11 03：其余三个参数（spec §4.1 / D9，验收 A1–A3、A6）───────────────────────────
//
// 三个键与 02 的 refreshFeedsPerRound 走同一条保存路径，不需要第二套端点逻辑；
// 这一组证明「都能写 / 都稀疏 / 重启都在」，以及边界值一个都不许落盘。

test('saveSettings 其余三项：并发 / 自动刷新间隔 / 清理天数都能写、稀疏、重启保持', async () => {
  const h = harness({ patch: { cleanupAfterDays: 45 } })
  try {
    const concurrency = await h.dispatch('saveSettings', { patch: { refreshConcurrency: 12 } })
    assert.equal(concurrency.ok, true, '并发 12 是合法值')
    assert.equal(concurrency.value.settings.effective.refreshConcurrency, 12, '回包里的生效值必须是 12')
    assert.equal(h.config.refreshConcurrency, 12, '写盘成功后必须改同一个 config 对象（下一轮刷新读它）')
    await h.dispatch('refresh', {})
    assert.deepEqual(h.concurrencyReads, [12], '下一轮 refreshNow 开跑时读到的并发必须是新值')

    // 自动刷新间隔的权威值始终是毫秒：客户端把「1.5 分钟」换算成 90000 再提交，端点只验毫秒范围。
    const interval = await h.dispatch('saveSettings', { patch: { minRefreshIntervalMs: 90000 } })
    assert.equal(interval.ok, true, '90000 ms（1.5 分钟）是合法值')
    assert.equal(interval.value.settings.effective.minRefreshIntervalMs, 90000)
    assert.equal(h.config.minRefreshIntervalMs, 90000)

    const cleanup = await h.dispatch('saveSettings', { patch: { cleanupAfterDays: 400 } })
    assert.equal(cleanup.ok, true, '清理天数 400 是合法值')
    assert.equal(cleanup.value.settings.effective.cleanupAfterDays, 400)
    assert.equal(h.config.cleanupAfterDays, 400)

    assert.deepEqual(JSON.parse(fileText(h)), {
      version: 1,
      overrides: { refreshConcurrency: 12, minRefreshIntervalMs: 90000, cleanupAfterDays: 400 },
    }, '三次保存只写被点名的三个键（稀疏覆盖），patch 基线不落盘')

    // 模拟重启：同一份 $DSH_HOME、全新的 Config 与控制器（apply 的创建顺序）。
    const restartedConfig = Config({ cleanupAfterDays: 45 })
    const restarted = createSettingsControl({
      config: restartedConfig,
      settingsPath: h.settingsPath,
      log: () => {},
    })
    assert.equal(restarted.snapshot().effective.refreshConcurrency, 12, '重启后并发仍是 12')
    assert.equal(restarted.snapshot().effective.minRefreshIntervalMs, 90000, '重启后间隔仍是 90000 ms')
    assert.equal(restarted.snapshot().effective.cleanupAfterDays, 400, '重启后清理天数仍是 400（覆盖赢过 patch）')
  } finally {
    h.cleanup()
  }
})

test('saveSettings 其余三项的非法边界：0 / 负数 / 超上限 / 小数都回 bad-request，文件与内存都不变', async () => {
  const h = harness({
    patch: { refreshConcurrency: 6, minRefreshIntervalMs: 600000, cleanupAfterDays: 45 },
    file: JSON.stringify({ version: 1, overrides: { refreshFeedsPerRound: 7 } }),
  })
  const beforeFile = fileText(h)
  const beforeEffective = h.settings.snapshot().effective
  try {
    const cases = [
      // 并发：没有「零并发」这种调度；1–32，且必须是整数。
      ['refreshConcurrency', [0, 33, 1.5]],
      // 毫秒：0 合法（不节流），但负数与超过一天（86400000）都不行；毫秒也必须是整数。
      ['minRefreshIntervalMs', [-1, 86_400_001, 60_000.5]],
      // 清理天数：0 会清光已读条目（数据事故），负数与超上限 3650 天同样非法。
      ['cleanupAfterDays', [0, -1, 3651, 1.5]],
    ]
    for (const [key, values] of cases) {
      for (const bad of values) {
        const result = await h.dispatch('saveSettings', { patch: { [key]: bad } })
        assert.equal(result.ok, false, key + '=' + bad + ' 必须被拒')
        assert.equal(result.error.code, 'bad-request', key + '=' + bad + ' 走统一坏入参信封')
        assert.equal(fileText(h), beforeFile, '被拒的保存不许动设置文件：' + key + '=' + bad)
        assert.equal(h.config[key], beforeEffective[key], '被拒的保存不许改内存：' + key + '=' + bad)
      }
    }
    assert.deepEqual(h.settings.snapshot().effective, beforeEffective, '端点快照也必须保持旧值')
  } finally {
    h.cleanup()
  }
})
