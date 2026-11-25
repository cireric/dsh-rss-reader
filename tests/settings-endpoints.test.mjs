/**
 * settings 端点的回包与「启动时合并」的优先级（R11 01，spec D3–D4.1 / D6 / A4 / B9–B11）。
 *
 * 这一层只验**已装配的宿主**：settings 控制器读文件、把 overrides 合并进同一份 config，
 * 端点再把生效值 / 默认值 / 读侧告警交给界面。合并顺序是整张票的核心 —— 它错了，
 * 页面上看到的数字就不是下一次刷新真正会用的值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/config.js'
import { createDispatch } from '../lib/endpoints.js'
import { createMemoryStore } from '../lib/memory-store.js'
import { createSettingsControl } from '../lib/settings-control.js'
import { createLifecycle } from '../lib/lifecycle.js'
import { selectStalestFeeds } from '../lib/refresh.js'

const TUNABLE = [
  'refreshFeedsPerRound', 'refreshConcurrency', 'minRefreshIntervalMs', 'cleanupAfterDays', 'rsshubBase',
  'translateProvider', 'translateModel', 'translateEffort', 'translateNoticeAck',
]

/**
 * 装配一份「生产同形」的 settings 控制器 + dispatch。
 *
 * 刻意不经过 apply：apply 要整个宿主 ctx，而这条链的语义全在控制器与 dispatch 之间。
 * @param options.patch 插件配置（模拟 profile patch 的显式值）
 * @param options.file  settings.json 的原文；不给 = 文件不存在
 * @param options.settingsPathIsDirectory 在 settings.json 的位置放一个同名目录（稳定造 EISDIR）
 */
function harness(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-settings-endpoint-'))
  const settingsPath = join(dir, 'settings.json')
  if (options.settingsPathIsDirectory === true) mkdirSync(settingsPath)
  else if (options.file !== undefined) writeFileSync(settingsPath, options.file)
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

test('settings 回包：effective / defaults 都覆盖全部可调键（含 rsshubBase），默认值来自 schema', async () => {
  const h = harness()
  try {
    const settings = await settingsOf(h)
    assert.deepEqual(Object.keys(settings.effective).sort(), [...TUNABLE].sort(), '生效值必须覆盖全部可调键')
    assert.deepEqual(settings.defaults, TUNABLE_DEFAULTS,
      '默认值由 Config({}) 现取，客户端不硬编码；RSSHub / 翻译三键默认空 = 未配置（D1 / R7 D6）')
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

test('读失败（EISDIR）：继承值继续 + 警示条 + 日志，且不隔离改名（D6 之外的 I/O 错误）', async () => {
  const h = harness({ patch: { refreshConcurrency: 6 }, settingsPathIsDirectory: true })
  try {
    const settings = await settingsOf(h)
    assert.equal(settings.effective.refreshConcurrency, 6, '读不出来时用继承值继续，不阻断启动')
    assert.match(settings.warning ?? '', /设置文件无法读取（.*），当前使用继承值/,
      '警示条要说明「无法读取」且当前用继承值；实际：' + JSON.stringify(settings.warning))
    assert.doesNotMatch(settings.warning ?? '', /已隔离为/, 'I/O 错误不是坏文件，文案不许说已隔离')
    assert.ok(h.logs.some((line) => line.includes('设置文件无法读取')),
      '读失败必须留一行日志：实际日志 ' + JSON.stringify(h.logs))
    assert.equal(statSync(h.settingsPath).isDirectory(), true, '原路径必须还在（没有被 rename 隔离）')
    assert.equal(readdirSync(h.dir).filter((name) => name.startsWith('settings.json.corrupt-')).length, 0,
      'I/O 错误不该产生隔离文件')
  } finally {
    h.cleanup()
  }
})

test('坏值逐键丢：合法的照用、非法的只报数量，文件不被重写', async () => {
  const file = JSON.stringify({
    version: 1,
    overrides: { refreshConcurrency: 0, refreshFeedsPerRound: 7, futureKey: 'https://ignored.example' },
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
    assert.deepEqual(result.value.settings.defaults, TUNABLE_DEFAULTS,
      '回包形状与 settings 读端点同形（客户端据此统一落地）')

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

test('saveSettings 空 patch：无操作成功（返回当前快照、不写盘、不改内存），未知键仍 rejected（D4.1）', async () => {
  const h = harness({
    patch: { refreshConcurrency: 6 },
    file: JSON.stringify({ version: 1, overrides: { cleanupAfterDays: 45 } }),
  })
  const beforeText = fileText(h)
  const beforeMtimeNs = statSync(h.settingsPath, { bigint: true }).mtimeNs
  const beforeEffective = h.settings.snapshot().effective
  try {
    const empty = await h.dispatch('saveSettings', { patch: {} })
    assert.equal(empty.ok, true, '空 patch 是合法的空操作（D4.1 的 Partial 允许空对象）')
    assert.deepEqual(empty.value.settings.effective, beforeEffective, '空 patch 的回包就是当前快照')
    assert.equal(fileText(h), beforeText, '空 patch 不写盘')
    assert.equal(statSync(h.settingsPath, { bigint: true }).mtimeNs, beforeMtimeNs, '空 patch 连 mtime 都不许碰')
    assert.deepEqual(h.logs.filter((line) => line.startsWith('设置：')), [], '空 patch 不该留下保存日志')

    // D5 的白名单没有放宽：空对象是「没改」，未知键仍是「不许改」。
    const unknown = await h.dispatch('saveSettings', { patch: { futureKey: 'whatever' } })
    assert.equal(unknown.ok, false, '未知键必须 rejected，不能被当成空操作静默接受')
    assert.equal(unknown.error.code, 'bad-request', '未知键走统一坏入参信封')
    assert.equal(fileText(h), beforeText, '被拒的未知键同样不写盘')
    assert.deepEqual(h.settings.snapshot().effective, beforeEffective, '被拒的未知键同样不改内存')
  } finally {
    h.cleanup()
  }
})

test('saveSettings 稀疏合并不吞别的覆盖：已有键原样保留，认不出的键在保存时被丢弃（D6 第三类）', async () => {
  const h = harness({
    file: JSON.stringify({ version: 1, overrides: { cleanupAfterDays: 45, futureKey: 'https://ignored.example' } }),
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
  rsshubBase: '',
  // R7 02：翻译三键默认空（未配置），确认标记默认 false（未确认）。
  translateProvider: '',
  translateModel: '',
  translateEffort: '',
  translateNoticeAck: false,
}

/** 除全部可调键之外的 Config 字段（恢复默认不许碰它们）。 */
function nonTunableConfig(config) {
  const {
    refreshFeedsPerRound, refreshConcurrency, minRefreshIntervalMs, cleanupAfterDays, rsshubBase,
    translateProvider, translateModel, translateEffort, translateNoticeAck, ...rest
  } = config
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
      rsshubBase: h.config.rsshubBase,
      translateProvider: h.config.translateProvider,
      translateModel: h.config.translateModel,
      translateEffort: h.config.translateEffort,
      translateNoticeAck: h.config.translateNoticeAck,
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

// ── R8a 01：rsshubBase 配置面（spec §4.1 / §7 A11–A12 / §11 D2–D3）───────────────
//
// A11：非法地址「当场拒绝、文件与内存都不变」；A12：合法地址保存后重启仍生效。
// 只经端点驱动 —— 直接调控制器会绕过入参校验，而非法值零写盘的入口正是端点这一层。

test('saveSettings rsshubBase：只改实例时 overrides 只有 rsshubBase，去尾斜杠后落盘，内存与重启都保持（A12）', async () => {
  const h = harness()
  try {
    const result = await h.dispatch('saveSettings', { patch: { rsshubBase: ' https://rsshub.rssforever.com/ ' } })
    assert.equal(result.ok, true, '合法实例地址必须保存成功')
    assert.equal(result.value.settings.effective.rsshubBase, 'https://rsshub.rssforever.com',
      '回包里的生效值必须是归一后的形态（去尾斜杠、trim）')
    assert.deepEqual(JSON.parse(fileText(h)), {
      version: 1,
      overrides: { rsshubBase: 'https://rsshub.rssforever.com' },
    }, '只改实例 ⇒ overrides 里只有 rsshubBase（版本仍是 1）')
    assert.equal(h.config.rsshubBase, 'https://rsshub.rssforever.com',
      '写盘成功后必须改同一个 config 对象（发现候选下一次就读它）')
    // 钉死「旧 → 新」两段：旧值是继承来的空串，新值是归一后的地址。只断言「有一行以
    // 设置：rsshubBase 开头」会让「没写旧值 / 没写新值」也通过（两边都蕴含前者）。
    assert.deepEqual(h.logs.filter((line) => line.startsWith('设置：rsshubBase')),
      ['设置：rsshubBase  → https://rsshub.rssforever.com'],
      '保存要留一行完整的「旧 → 新」（D8）；实际日志：' + JSON.stringify(h.logs))

    // 模拟重启：同一份 settings.json、全新的 Config 与控制器。
    const restartedConfig = Config({})
    const restarted = createSettingsControl({
      config: restartedConfig,
      settingsPath: h.settingsPath,
      log: () => {},
    })
    assert.equal(restarted.snapshot().effective.rsshubBase, 'https://rsshub.rssforever.com',
      '重启后仍应是这个实例（A12）')
    assert.equal(restartedConfig.rsshubBase, 'https://rsshub.rssforever.com', '重启后的 config 对象也必须被合并')
  } finally {
    h.cleanup()
  }
})

test('saveSettings rsshubBase 非法地址：ftp / 带 path / 带 query / javascript / 非 URL 都回 bad-request，文件与内存不变（A11）', async () => {
  const h = harness({ patch: { rsshubBase: 'https://old.example' } })
  try {
    const beforeEffective = h.settings.snapshot().effective
    assert.equal(beforeEffective.rsshubBase, 'https://old.example', '前置：继承值来自 patch')
    for (const bad of [
      'ftp://rsshub.example',
      'https://rsshub.example/api',
      'https://rsshub.example/?token=1',
      'https://rsshub.example/#top',
      'javascript:alert(1)',
      'not a url',
    ]) {
      const result = await h.dispatch('saveSettings', { patch: { rsshubBase: bad } })
      assert.equal(result.ok, false, '非法地址必须被拒：' + bad)
      assert.equal(result.error.code, 'bad-request', '非法地址走统一坏入参信封：' + bad)
      assert.equal(fileText(h), undefined, '被拒的保存不许创建设置文件：' + bad)
      assert.equal(h.config.rsshubBase, 'https://old.example', '被拒的保存不许改内存：' + bad)
      assert.deepEqual(h.settings.snapshot().effective, beforeEffective, '端点快照也必须保持旧值：' + bad)
    }
  } finally {
    h.cleanup()
  }
})

test('saveSettings rsshubBase 清空：空串落盘为显式空覆盖，页面级恢复默认不顺手清掉它', async () => {
  const h = harness({ file: JSON.stringify({ version: 1, overrides: { rsshubBase: 'https://rsshub.example' } }) })
  try {
    const cleared = await h.dispatch('saveSettings', { patch: { rsshubBase: '' } })
    assert.equal(cleared.ok, true, '空串 = 关闭，是合法值')
    assert.equal(cleared.value.settings.effective.rsshubBase, '')
    assert.deepEqual(JSON.parse(fileText(h)), { version: 1, overrides: { rsshubBase: '' } },
      '清空后写入的是空覆盖（与「实例地址」同一条稀疏写路径）')

    // 再加一个数值覆盖，然后跑页面级「恢复默认」：它只管四个数字键（RSSHub 分区自带清空按钮）。
    await h.dispatch('saveSettings', { patch: { refreshFeedsPerRound: 7 } })
    await h.dispatch('saveSettings', { patch: { rsshubBase: 'https://rsshub.example' } })
    const reset = await h.dispatch('saveSettings', { resetToDefaults: true })
    assert.equal(reset.ok, true)
    assert.equal(reset.value.settings.effective.rsshubBase, 'https://rsshub.example',
      '页面级恢复默认只覆盖四个数值参数，不清 RSSHub 地址')
    assert.deepEqual(JSON.parse(fileText(h)), { version: 1, overrides: { rsshubBase: 'https://rsshub.example' } },
      '数值覆盖被删，实例地址保留')
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

// ── R11 评审补测：A8（config.json 不被污染）与 A1 后半（在途刷新不受新值影响）────────────

test('A8：保存四个参数前后 config.json 逐字节不变，feeds / folders / feedOrder / viewPreferences 逐字段相等', async () => {
  const h = harness()
  // 一份形状与生产 config.json 同族的原文：订阅真相、文件夹、排序、视图偏好都在里面。
  const configPath = join(h.dir, 'config.json')
  const original = JSON.stringify({
    version: 1,
    feeds: {
      'https://a.example/feed.xml': { url: 'https://a.example/feed.xml', title: 'A' },
      'https://b.example/feed.xml': { url: 'https://b.example/feed.xml', title: 'B' },
    },
    folders: [{ name: '技术', feedIds: ['https://a.example/feed.xml'] }],
    feedOrder: ['https://b.example/feed.xml', 'https://a.example/feed.xml'],
    viewPreferences: {
      navSelection: { kind: 'virtual' }, filter: 'unread', navVisible: true, showUnread: false,
      reading: { fontSize: 18, lineWidth: 680, theme: 'dark', expandImages: false },
      lastItemId: 'item-1', lastListScrollTop: 120,
    },
  }, null, 2) + '\n'
  writeFileSync(configPath, original)
  const beforeBytes = readFileSync(configPath)
  const beforeMtimeNs = statSync(configPath, { bigint: true }).mtimeNs
  const before = JSON.parse(original)
  try {
    const result = await h.dispatch('saveSettings', {
      patch: {
        refreshFeedsPerRound: 7,
        refreshConcurrency: 8,
        minRefreshIntervalMs: 90000,
        cleanupAfterDays: 45,
      },
    })
    assert.equal(result.ok, true, '四个参数一起保存必须成功')

    // 保存设置根本不经过 config.json：字节级不变（不是「解析后等价」）。
    assert.deepEqual(readFileSync(configPath), beforeBytes, 'config.json 必须逐字节不变')
    assert.equal(statSync(configPath, { bigint: true }).mtimeNs, beforeMtimeNs, 'config.json 连 mtime 都不许动')
    const after = JSON.parse(readFileSync(configPath, 'utf8'))
    for (const key of ['feeds', 'folders', 'feedOrder', 'viewPreferences']) {
      assert.deepEqual(after[key], before[key], key + ' 必须逐字段相等（设置页不写订阅 / 偏好）')
    }
  } finally {
    h.cleanup()
  }
})

/** 等 predicate 为真；固定 sleep 是在赌机器速度。 */
async function waitUntil(predicate, label, { timeout = 3000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (predicate()) return
    if (Date.now() >= deadline) throw new Error('等待超时（' + timeout + 'ms）：' + label)
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

test('A1 后半：抓取途中保存新值，进行中的这一轮仍是旧批次；下一轮才用新值', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rss-settings-inflight-'))
  // 用公网 IP 字面量当源地址：DNS 判定跳过解析（fetch.ts 对字面量地址不查 DNS），
  // 而真正的网络调用被下面的全局 fetch 桩扣住 —— 测试不发一个真实请求。
  const urls = [1, 2, 3, 4].map((index) => 'http://93.184.216.34/feed' + index + '.xml')
  const config = Config({
    feeds: urls,
    refreshOnStart: false,
    refreshFeedsPerRound: 2,
    refreshConcurrency: 1,
    minRefreshIntervalMs: 0,
  })
  const logs = []
  const settings = createSettingsControl({
    config,
    settingsPath: join(dir, 'settings.json'),
    log: (line) => logs.push(line),
  })
  const lifecycle = createLifecycle({
    config,
    storagesRoot: dir,
    configFile: join(dir, 'config.json'),
    log: () => {},
    summarize: () => '刷新完成',
  })
  const originalFetch = globalThis.fetch
  const started = []
  const releases = []
  /**
   * 扣住响应的闸门。旧并发是 1：第一轮一次只会有一个 fetch 在飞，所以「已开抓」的判据是
   * started.length === 1，而不是 2（等两个才放行会死锁 —— 第二个要等第一个让出并发额度）。
   */
  let gated = true
  const feedXml = (url) => '<?xml version="1.0"?><rss version="2.0"><channel><title>F</title>'
    + '<item><title>item ' + url + '</title><link>' + url + '/item</link></item>'
    + '</channel></rss>'
  const releaseAll = () => { while (releases.length > 0) releases.shift()() }
  try {
    await lifecycle.start()
    assert.notEqual(lifecycle.ready(), undefined, '前置：lifecycle 已就绪')
    assert.equal(config.refreshFeedsPerRound, 2, '前置：旧上限是 2')

    globalThis.fetch = async (input) => {
      const url = String(input)
      started.push(url)
      // 扣住响应，制造「一轮还在抓」的窗口；测试在窗口里保存新值。
      if (gated) await new Promise((resolve) => { releases.push(resolve) })
      return new Response(feedXml(url), { status: 200, headers: { 'content-type': 'application/rss+xml' } })
    }

    const firstRun = lifecycle.refreshNow({ force: true })
    await waitUntil(() => started.length === 1, '旧批次已开抓（并发 1：第一个源在飞）')
    const saved = settings.save({ refreshFeedsPerRound: 4 })
    assert.equal(saved.ok, true, '抓取途中保存必须成功')
    assert.equal(config.refreshFeedsPerRound, 4, '保存成功后内存立即是新值（下一轮会读它）')

    // 放行当前在飞的源；后续旧批次内的源不再扣住（gate 关闭），让这一轮自然跑完。
    gated = false
    releaseAll()
    const first = await firstRun
    assert.equal(first.outcome, 'ran')
    assert.equal(first.attempted, 2, '进行中的这一轮 attempted 仍是旧值 2（不许按新值扩到 4）')
    assert.equal(started.length, 2, '进行中的这一轮不许追加抓取源')
    assert.deepEqual([...new Set(started)].sort(), [...urls.slice(0, 2)].sort(),
      '这一轮抓的仍是旧选源批次（前两个源）')

    // 下一轮：新上限 4 ⇒ 选源批次与 attempted 都变成新值。
    const beforeSecond = started.length
    const secondRun = lifecycle.refreshNow({ force: true })
    const second = await secondRun
    assert.equal(second.outcome, 'ran')
    assert.equal(second.attempted, 4, '下一轮才用新值（attempted = 4）')
    assert.equal(started.length - beforeSecond, 4, '下一轮抓了全部四个源（增量 4，不是累计）')
    assert.ok(logs.some((line) => line === '设置：refreshFeedsPerRound 2 → 4'),
      '保存留痕（D8）：实际日志 ' + JSON.stringify(logs))
  } finally {
    // 失败路径也要放掉被扣住的响应，否则 stop() 会等一轮永远不会落定的抓取（测试挂死）。
    releaseAll()
    globalThis.fetch = originalFetch
    await lifecycle.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── R7 02：翻译三键 + 确认标记（spec §5.2）──────────────────────────────────

test('R7 02：翻译三键与确认标记可经 saveSettings 写入；确认标记不出现在只读区', async () => {
  const h = harness()
  try {
    const before = await settingsOf(h)
    const readOnlyKeys = before.readOnly.map((entry) => entry.key)
    for (const key of ['translateProvider', 'translateModel', 'translateEffort', 'translateNoticeAck']) {
      assert.equal(readOnlyKeys.includes(key), false, key + ' 是可调键，不许出现在「其余参数（只读）」区')
    }

    const result = await h.dispatch('saveSettings', { patch: {
      translateProvider: '  deepseek  ',
      translateModel: 'deepseek-chat',
      translateEffort: 'high',
      // 06 票的确认框会写这一位：它不是用户可调项，但必须能经同一个端点落盘。
      translateNoticeAck: true,
    } })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value.settings.effective, {
      ...TUNABLE_DEFAULTS,
      translateProvider: 'deepseek',
      translateModel: 'deepseek-chat',
      translateEffort: 'high',
      translateNoticeAck: true,
    }, '四个键一次写盘后内存立即生效，字符串按 trim 存')
    assert.deepEqual(JSON.parse(fileText(h)), { version: 1, overrides: {
      translateProvider: 'deepseek',
      translateModel: 'deepseek-chat',
      translateEffort: 'high',
      translateNoticeAck: true,
    } }, '稀疏写：只写这四个键')

    // 重启保持：重新创建控制器（模拟插件重装）后仍是刚才的值。
    const reopened = createSettingsControl({
      config: Config({}),
      settingsPath: h.settingsPath,
      log: () => {},
    })
    assert.equal(reopened.snapshot().effective.translateProvider, 'deepseek')
    assert.equal(reopened.snapshot().effective.translateEffort, 'high')
    assert.equal(reopened.snapshot().effective.translateNoticeAck, true)
  } finally {
    h.cleanup()
  }
})

test('R7 02：翻译设置的坏值（非字符串 / 超长 / 非布尔）回 bad-request，文件与内存都不变', async () => {
  const h = harness()
  try {
    for (const patch of [
      { translateProvider: 5 },
      { translateModel: 'x'.repeat(201) },
      { translateEffort: null },
      { translateNoticeAck: 'true' },
      { translateNoticeAck: 1 },
    ]) {
      const result = await h.dispatch('saveSettings', { patch })
      assert.equal(result.ok, false, '坏值必须拒绝：' + JSON.stringify(patch))
      assert.equal(result.error.code, 'bad-request', JSON.stringify(patch))
    }
    assert.equal(fileText(h), undefined, '坏值一个都不许落盘')
    assert.equal(h.config.translateProvider, '', '坏值一个都不许改进内存')
    assert.equal(h.config.translateNoticeAck, false)
  } finally {
    h.cleanup()
  }
})
