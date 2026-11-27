/**
 * R15 01：RSSHub 实例池的配置形状、迁移与设置层（spec §4.1.1 / §4.1.2 / §5 / §6 A5–A6）。
 *
 * 这一层钉的是**用户可见的契约**：
 *  - `config.json` 的 `rsshub` 三字段读得回、写得回（漏进 validateConfig 就会在下一次刷新写盘时静默消失）；
 *  - 实例池与旧的 `settings.json` `rsshubBase` 的迁移关系（缺省 ⇒ 单元素池；显式空数组 ⇒ 关闭，不回落）；
 *  - 坏实例逐条丢弃 + 告警，而不是让整份订阅配置失效；
 *  - 0 / 5 条可保存、第 6 条拒绝并提示「最多 5 个」；
 *  - 写盘成功后才改内存（写失败时内存还是旧值）。
 *
 * 判据都从模块的公开边界观察（readConfigFile / writeConfigFile / createRsshubSettings / dispatch），
 * 不碰内部字段，也不把实现细节当断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/config.js'
import { readConfigFile, writeConfigFile } from '../lib/storage/config-file.js'
import { createRsshubSettings } from '../lib/rsshub-settings.js'
import { createDispatch } from '../lib/endpoints.js'
import { createMemoryStore } from '../lib/memory-store.js'

const LEGACY = 'https://legacy.example'

const POOL_SHAPE = (instances = []) => ({
  instances,
  hiddenNamespaces: [],
  hideNsfw: true,
})

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'rss-rsshub-settings-'))
}

/** 写一份原始 config.json；`file` 是对象或字符串（原样写，用于坏 JSON）。 */
function writeRawConfig(dir, file) {
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, typeof file === 'string' ? file : JSON.stringify(file))
  return configPath
}

function harness(options = {}) {
  const dir = tempDir()
  const configPath = options.configPath ?? join(dir, 'config.json')
  if (options.file !== undefined && options.configPath === undefined) writeRawConfig(dir, options.file)
  const config = Config({ rsshubBase: LEGACY, ...options.config })
  const logs = []
  const control = createRsshubSettings({ config, configPath, log: (line) => logs.push(line) })
  return {
    dir, configPath, config, control, logs,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function dispatchHarness(options = {}) {
  const h = harness(options)
  const store = createMemoryStore()
  const calls = []
  const fetchImpl = options.fetchImpl ?? (async (url) => {
    calls.push(url)
    return { kind: 'failed', reason: 'HTTP 500' }
  })
  const dispatch = createDispatch({
    config: h.config,
    log: (line) => h.logs.push(line),
    ready: () => store,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
    rsshubSettings: h.control,
    fetchImpl,
  })
  return { ...h, store, calls, dispatch }
}

// ── 配置形状（§5.1）──────────────────────────────────────────────────────

test('config.json 的 rsshub 三字段：读得回、写得回，刷新写盘（read-modify-write）不丢', () => {
  const dir = tempDir()
  const path = join(dir, 'config.json')
  try {
    const rsshub = { instances: ['https://a.example', 'https://b.example'], hiddenNamespaces: ['nsfw'], hideNsfw: false }
    writeConfigFile(path, { version: 1, feeds: {}, rsshub })
    assert.deepEqual(readConfigFile(path).rsshub, rsshub, '写入时必须显式保留三字段，读取时必须读回同一份')

    // 模拟 store 的日常写盘：只改 feeds/folders，rsshub 必须原样带过去。
    const current = readConfigFile(path)
    writeConfigFile(path, { ...current, feeds: {}, folders: ['tech'] })
    assert.deepEqual(readConfigFile(path).rsshub, rsshub,
      'validateConfig 漏掉 rsshub 时，这里会静默丢掉整个实例池')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('坏实例逐条丢弃并告警：合法项保留、不抛错（与 folders 的坏项语义不同）', () => {
  const dir = tempDir()
  const path = join(dir, 'config.json')
  try {
    writeRawConfig(dir, {
      version: 1,
      feeds: {},
      rsshub: {
        instances: ['https://ok.example/', 'ftp://bad.example', 'https://ok2.example/api', '', 5],
        hiddenNamespaces: [],
        hideNsfw: true,
      },
    })
    const warnings = []
    const file = readConfigFile(path, (line) => warnings.push(line))
    assert.deepEqual(file.rsshub?.instances, ['https://ok.example'],
      '非法地址（协议 / path / 空串 / 非字符串）逐条丢弃，合法项保留并归一成 origin')
    assert.equal(warnings.length, 4, '每条坏实例一次告警')
    for (const line of warnings) assert.match(line, /已丢弃/, '告警必须说清楚「丢了什么」：' + line)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 迁移（§4.1.2 / A5）──────────────────────────────────────────────────

test('迁移：旧 rsshubBase 在 rsshub 缺省时视为单元素池', () => {
  const h = harness()
  try {
    assert.deepEqual(h.control.snapshot().instances, [LEGACY], '没配过池的升级用户继续用旧地址')
    assert.deepEqual(h.control.snapshot().hiddenNamespaces, [], 'hiddenNamespaces 缺省为空')
    assert.equal(h.control.snapshot().hideNsfw, true, 'hideNsfw 缺省为 true')
  } finally {
    h.cleanup()
  }
})

test('迁移：首次保存实例池前，遗留 rsshubBase 始终现读（设置保存后不重启就生效）', () => {
  const h = harness()
  try {
    assert.deepEqual(h.control.snapshot().instances, [LEGACY])
    h.config.rsshubBase = 'https://changed.example'
    assert.deepEqual(h.control.snapshot().instances, ['https://changed.example'], '池子还没写过时不许缓存旧值')
    assert.equal(h.control.save({ instances: ['https://pool.example'] }).ok, true)
    h.config.rsshubBase = 'https://changed-again.example'
    assert.deepEqual(h.control.instances(), ['https://pool.example'], '写过池子后以 config.json 为准，不再看遗留键')
  } finally {
    h.cleanup()
  }
})

test('迁移：显式空数组 = 用户主动关闭，不回落旧 rsshubBase（A5）', () => {
  const h = harness({ file: { version: 1, feeds: {}, rsshub: POOL_SHAPE([]) } })
  try {
    assert.deepEqual(h.control.snapshot().instances, [],
      '空数组是「配了空」，与「没配过」必须可区分')
  } finally {
    h.cleanup()
  }
})

test('迁移：保存空池后重启仍为空池（以 config.json 为准，不再看 settings.rsshubBase）', () => {
  const dir = tempDir()
  try {
    const configPath = join(dir, 'config.json')
    const config = Config({ rsshubBase: LEGACY })
    const first = createRsshubSettings({ config, configPath, log: () => {} })
    assert.deepEqual(first.snapshot().instances, [LEGACY], '前置：旧地址先作为单元素池')
    assert.equal(first.save({ instances: [] }).ok, true, '清空池必须可保存')
    const restarted = createRsshubSettings({ config: Config({ rsshubBase: LEGACY }), configPath, log: () => {} })
    assert.deepEqual(restarted.snapshot().instances, [], '重启后读 config.json：空池就是空池，不许回落')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 保存边界与坏项（A6）─────────────────────────────────────────────────

test('保存边界：0 / 5 条成功，第 6 条拒绝并提示「最多 5 个」（A6）', async () => {
  const h = dispatchHarness({ file: { version: 1, feeds: {} } })
  try {
    const empty = await h.dispatch('saveRsshubSettings', { instances: [] })
    assert.equal(empty.ok, true, '0 条是合法的「关闭」')
    assert.deepEqual(empty.value.rsshub.instances, [])

    const five = Array.from({ length: 5 }, (_, index) => 'https://hub' + index + '.example')
    const saved = await h.dispatch('saveRsshubSettings', { instances: five })
    assert.equal(saved.ok, true, '5 条是上限内')
    assert.deepEqual(saved.value.rsshub.instances, five)
    assert.deepEqual(JSON.parse(readFileSync(h.configPath, 'utf8')).rsshub.instances, five, '5 条必须落盘')

    const six = [...five, 'https://hub5.example']
    const rejected = await h.dispatch('saveRsshubSettings', { instances: six })
    assert.equal(rejected.ok, false, '第 6 条必须拒绝保存')
    assert.equal(rejected.error.code, 'bad-request')
    assert.match(rejected.error.message, /最多 5 个/, '提示必须明确「最多 5 个」')
    assert.deepEqual(JSON.parse(readFileSync(h.configPath, 'utf8')).rsshub.instances, five, '被拒的请求不许碰文件')
    assert.deepEqual(h.control.snapshot().instances, five, '被拒的请求也不许改内存')
  } finally {
    h.cleanup()
  }
})

test('形状：hiddenNamespaces / hideNsfw 一次定好并可落盘读回（06 / 07 票只加行为，不再改形状）', () => {
  const h = harness({ file: { version: 1, feeds: {} } })
  try {
    const saved = h.control.save({
      instances: ['https://a.example'],
      hiddenNamespaces: ['github', '  zhihu  ', ''],
      hideNsfw: false,
    })
    assert.equal(saved.ok, true)
    assert.deepEqual(saved.snapshot.hiddenNamespaces, ['github', 'zhihu'], '非空字符串保留并 trim；空串丢弃')
    assert.equal(saved.snapshot.hideNsfw, false, 'hideNsfw 可保存')
    const raw = JSON.parse(readFileSync(h.configPath, 'utf8'))
    assert.deepEqual(raw.rsshub, {
      instances: ['https://a.example'],
      hiddenNamespaces: ['github', 'zhihu'],
      hideNsfw: false,
    }, '三字段必须一起落盘')
    const restarted = createRsshubSettings({ config: Config({ rsshubBase: LEGACY }), configPath: h.configPath, log: () => {} })
    assert.deepEqual(restarted.snapshot(), {
      instances: ['https://a.example'],
      hiddenNamespaces: ['github', 'zhihu'],
      hideNsfw: false,
    }, '重启后读回同一份形状')
  } finally {
    h.cleanup()
  }
})

test('隐藏列表写盘归一化：重复项只留一次（点两次「隐藏此站点」不会变成两个 github）', () => {
  const h = harness({ file: { version: 1, feeds: {} } })
  try {
    const saved = h.control.save({
      instances: ['https://a.example'],
      hiddenNamespaces: ['github', ' github ', 'zhihu', 'github'],
    })
    assert.equal(saved.ok, true)
    assert.deepEqual(saved.snapshot.hiddenNamespaces, ['github', 'zhihu'], '重复项是同一个站点，只该占一行')
    assert.deepEqual(JSON.parse(readFileSync(h.configPath, 'utf8')).rsshub.hiddenNamespaces, ['github', 'zhihu'],
      '落盘的那份也必须是归一后的：否则设置页会显示「已隐藏（3）」')
  } finally {
    h.cleanup()
  }
})

test('读侧坏实例：控制器的快照带告警，合法项照常显示', () => {
  const h = harness({
    file: {
      version: 1,
      feeds: {},
      rsshub: { instances: ['https://ok.example', 'ftp://bad.example'], hiddenNamespaces: [], hideNsfw: true },
    },
  })
  try {
    const snapshot = h.control.snapshot()
    assert.deepEqual(snapshot.instances, ['https://ok.example'])
    assert.match(snapshot.warning ?? '', /已丢弃/, '设置页要能告诉用户坏项被丢了')
    assert.ok(h.logs.some((line) => line.includes('已丢弃')), '读侧告警必须进日志')
  } finally {
    h.cleanup()
  }
})

test('保存坏项：逐条丢弃 + 回包告警 + 日志留痕，合法项照存', async () => {
  const h = dispatchHarness({ file: { version: 1, feeds: {} } })
  try {
    const result = await h.dispatch('saveRsshubSettings', {
      instances: ['https://ok.example/', 'ftp://bad.example', 'https://ok2.example/api', ''],
    })
    assert.equal(result.ok, true, '坏项不是整份保存失败')
    assert.deepEqual(result.value.rsshub.instances, ['https://ok.example'],
      '合法项归一成 origin；坏项逐条丢弃（含空串）')
    assert.match(result.value.rsshub.warning ?? '', /已忽略 3 条/, '回包要告诉用户忽略了几条：'
      + JSON.stringify(result.value.rsshub.warning))
    assert.equal(h.logs.filter((line) => line.includes('已丢弃')).length, 3, '每条坏项一行日志')
    assert.deepEqual(JSON.parse(readFileSync(h.configPath, 'utf8')).rsshub.instances, ['https://ok.example'],
      '落盘的只有合法项')
  } finally {
    h.cleanup()
  }
})

test('写盘失败：错误如实返回，内存与文件都保持旧值（先落盘成功再改内存）', () => {
  const dir = tempDir()
  try {
    // 目标目录不存在：readConfigFile 视作「没有文件」，writeConfigFile 必然在 open tmp 时失败。
    const configPath = join(dir, 'missing-dir', 'config.json')
    const config = Config({ rsshubBase: LEGACY })
    const control = createRsshubSettings({ config, configPath, log: () => {} })
    assert.deepEqual(control.snapshot().instances, [LEGACY])
    const outcome = control.save({ instances: ['https://new.example'] })
    assert.equal(outcome.ok, false, '写盘失败必须返回失败')
    assert.match(outcome.message, /写订阅文件/, '失败原因要能展示给用户')
    assert.deepEqual(control.snapshot().instances, [LEGACY], '内存不许先于落盘生效')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('读改写保留其它顶层字段：feeds / folders / feedOrder / viewPreferences 不因保存实例池而丢', () => {
  const h = harness({
    file: {
      version: 1,
      feeds: { 'https://feed.example/atom.xml': { url: 'https://feed.example/atom.xml', title: '源一' } },
      folders: ['tech'],
      feedOrder: ['https://feed.example/atom.xml'],
      viewPreferences: { showUnread: false },
      rsshub: POOL_SHAPE([LEGACY]),
    },
  })
  try {
    assert.equal(h.control.save({ instances: ['https://new.example'] }).ok, true)
    const raw = JSON.parse(readFileSync(h.configPath, 'utf8'))
    assert.deepEqual(raw.rsshub, POOL_SHAPE(['https://new.example']), '池子更新成新值')
    assert.deepEqual(raw.feeds, { 'https://feed.example/atom.xml': { url: 'https://feed.example/atom.xml', title: '源一' } },
      'feeds 必须原样保留')
    assert.deepEqual(raw.folders, ['tech'], 'folders 必须原样保留')
    assert.deepEqual(raw.feedOrder, ['https://feed.example/atom.xml'], 'feedOrder 必须原样保留')
    assert.deepEqual(raw.viewPreferences, { showUnread: false }, 'viewPreferences 必须原样保留')
    assert.equal(raw.version, 1)
  } finally {
    h.cleanup()
  }
})

// ── 运行时语义：空池 = 零请求 ───────────────────────────────────────────

const RSS = '<?xml version="1.0"?><rss version="2.0"><channel><title>源</title>'
  + '<item><title>a</title><link>https://site.test/a</link><guid>g1</guid></item></channel></rss>'

test('空池 = RSSHub 关闭：发现与探索都零 Radar 请求（即使旧 rsshubBase 还在）', async () => {
  const fetchImpl = async (url) => {
    if (url === 'https://site.test/') {
      return { kind: 'ok', body: '<html><head><link rel="alternate" type="application/rss+xml" href="/a.xml"></head></html>', finalUrl: url }
    }
    if (url === 'https://site.test/a.xml') return { kind: 'ok', body: RSS, finalUrl: url }
    return { kind: 'failed', reason: '不该发这个请求：' + url }
  }
  const h = dispatchHarness({
    file: { version: 1, feeds: {}, rsshub: POOL_SHAPE([]) },
    config: { rsshubBase: LEGACY },
    fetchImpl,
  })
  try {
    const discovered = await h.dispatch('discoverFeeds', { url: 'https://site.test/' })
    assert.equal(discovered.ok, true)
    assert.deepEqual(discovered.value.candidates.map((candidate) => candidate.url), ['https://site.test/a.xml'],
      '空池时只走页面发现，不许拼 Radar 候选')
    assert.equal(h.calls.some((url) => String(url).startsWith(LEGACY)), false,
      '旧 rsshubBase 不许在空池时被偷偷使用')

    const explore = await h.dispatch('exploreCatalog', {})
    assert.equal(explore.ok, false, '空池时探索是功能关闭')
    assert.equal(explore.error.code, 'not-configured')
    assert.equal(h.calls.some((url) => String(url).startsWith(LEGACY)), false,
      '探索同样零请求')
  } finally {
    h.cleanup()
  }
})
