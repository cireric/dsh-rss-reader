/**
 * settings 端点的回包与「启动时合并」的优先级（R11 01，spec D3–D4.1 / D6 / A4 / B9–B11）。
 *
 * 这一层只验**已装配的宿主**：settings 控制器读文件、把 overrides 合并进同一份 config，
 * 端点再把生效值 / 默认值 / 读侧告警交给界面。合并顺序是整张票的核心 —— 它错了，
 * 页面上看到的数字就不是下一次刷新真正会用的值。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/config.js'
import { createDispatch } from '../lib/endpoints.js'
import { createMemoryStore } from '../lib/memory-store.js'
import { createSettingsControl } from '../lib/settings-control.js'

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
  const config = Config(options.patch ?? {})
  const settings = createSettingsControl({ config, settingsPath, log: (line) => logs.push(line) })
  const store = createMemoryStore()
  const dispatch = createDispatch({
    config,
    log: () => {},
    ready: () => store,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
    settings,
  })
  return {
    config, settings, dispatch, dir, settingsPath, logs,
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
