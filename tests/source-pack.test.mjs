/**
 * R15 08：精选源包的配置形状、初始化语义与增删（spec §4.3.1 / §5.1 / §6 A13）。
 *
 * 这一层钉的是**用户可见的契约**：
 *  - `curatedSources` 在 config.json 里读得回、写得回（漏进 validateConfig 就会在下一次刷新写盘时静默消失）；
 *  - 字段**缺失** ⇒ 首次打开用内置快照初始化并落盘；字段**存在但为空数组** ⇒ 用户删光了，不再自动填充；
 *  - 归一化与去重：同 URL 只留一条；坏项逐条丢弃，不让一条坏输入毁掉整份清单；
 *  - 删除 / 新增 / 恢复快照都落盘，重建控制器后仍在；
 *  - 「恢复内置快照」只补缺失项，不清空用户自己的条目；
 *  - 删除源包条目不影响订阅（源包与订阅是两处数据）。
 *
 * 判据都从模块的公开边界观察（readConfigFile / writeConfigFile / createSourcePack / dispatch），
 * 不碰内部字段。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '../lib/config.js'
import { normalizeCuratedSources, readConfigFile, writeConfigFile } from '../lib/storage/config-file.js'
import { createSourcePack } from '../lib/source-pack.js'
import { CURATED_SEED, CURATED_SEED_META } from '../lib/curated-seed.js'
import { createDispatch } from '../lib/endpoints.js'
import { createMemoryStore } from '../lib/memory-store.js'

const ENTRY = (url, extra = {}) => ({
  url,
  title: '示例源',
  category: '测试分类',
  addedAt: '2026-11-01T00:00:00.000Z',
  ...extra,
})

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'rss-source-pack-'))
}

/** 写一份原始 config.json；`file` 是对象或字符串（原样写，用于坏 JSON / 手改文件）。 */
function writeRawConfig(dir, file) {
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, typeof file === 'string' ? file : JSON.stringify(file))
  return configPath
}

function harness(options = {}) {
  const dir = tempDir()
  const configPath = options.configPath ?? join(dir, 'config.json')
  if (options.file !== undefined) writeRawConfig(dir, options.file)
  const logs = []
  const control = createSourcePack({ configPath, log: (line) => logs.push(line) })
  return {
    dir, configPath, control, logs,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// ── 配置形状（§5.1）──────────────────────────────────────────────────────

test('config.json 的 curatedSources：读得回、写得回，刷新写盘（read-modify-write）不丢', () => {
  const dir = tempDir()
  const path = join(dir, 'config.json')
  try {
    const curatedSources = [ENTRY('https://a.example/feed'), { url: 'https://b.example/feed', category: '测试分类', addedAt: '2026-11-01T00:00:00.000Z' }]
    writeConfigFile(path, { version: 1, feeds: {}, curatedSources })
    assert.deepEqual(readConfigFile(path).curatedSources, curatedSources,
      '写入时必须显式保留 curatedSources，读取时必须读回同一份')

    // 模拟 store 的日常写盘：只改 feeds/folders，curatedSources 必须原样带过去。
    const current = readConfigFile(path)
    writeConfigFile(path, { ...current, feeds: {}, folders: ['tech'] })
    assert.deepEqual(readConfigFile(path).curatedSources, curatedSources,
      'validateConfig 漏掉 curatedSources 时，这里会静默丢掉整份清单')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('curatedSources 缺省时保持「不存在」，不被物化成空数组（初始化语义的前提）', () => {
  const dir = tempDir()
  const path = join(dir, 'config.json')
  try {
    writeConfigFile(path, { version: 1, feeds: {} })
    assert.equal(readConfigFile(path).curatedSources, undefined,
      '缺省 ≠ 空数组：前者要触发种子初始化，后者是用户删光了')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 归一化与去重（§7 纯函数）────────────────────────────────────────────

test('归一化与去重：URL 去空白并归一、空文本字段折叠、同 URL 只留第一条、坏项逐条回报', () => {
  const { entries, issues } = normalizeCuratedSources([
    { url: ' https://a.example ', title: ' A ', category: ' C ', note: ' N ', addedAt: ' 2026-11-01T00:00:00.000Z ' },
    { url: 'https://a.example/', title: '重复项', addedAt: '2026-11-01T00:00:00.000Z' },
    { url: 'ftp://files.example/feed', addedAt: '2026-11-01T00:00:00.000Z' },
    { url: 'https://b.example/feed', addedAt: '不是时刻' },
    '不是对象',
    { url: 'https://c.example/feed', title: '   ', category: '', addedAt: '2026-11-01T00:00:00.000Z' },
  ])
  assert.deepEqual(entries, [
    { url: 'https://a.example/', title: 'A', category: 'C', note: 'N', addedAt: '2026-11-01T00:00:00.000Z' },
    { url: 'https://c.example/feed', addedAt: '2026-11-01T00:00:00.000Z' },
  ])
  assert.equal(issues.length, 4, '重复 / 非 http(s) / 坏时刻 / 非对象 各算一条')
  const reasons = issues.map((issue) => issue.reason).join('|')
  assert.match(reasons, /重复/)
  assert.match(reasons, /http\(s\)/)
  assert.match(reasons, /addedAt/)
  assert.match(reasons, /对象/)
})

test('配置文件里的坏项逐条丢弃并告警：合法项保留、不抛错（清单不是订阅，一条坏地址不该让整份配置打不开）', () => {
  const dir = tempDir()
  const path = join(dir, 'config.json')
  try {
    writeRawConfig(dir, {
      version: 1,
      feeds: {},
      curatedSources: [
        ENTRY('https://good.example/feed'),
        { url: 'not-a-url', addedAt: '2026-11-01T00:00:00.000Z' },
        { url: 'https://bad.example/feed', addedAt: 42 },
      ],
    })
    const warnings = []
    const file = readConfigFile(path, (line) => warnings.push(line))
    assert.deepEqual(file.curatedSources, [ENTRY('https://good.example/feed')])
    assert.equal(warnings.length, 2, '两条坏项各留一条告警')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 种子初始化语义（§4.3.1 / A13）───────────────────────────────────────

test('首次打开用内置快照初始化并落盘：79 条，重启（重建控制器）后仍是同一份', () => {
  const h = harness()
  try {
    const first = h.control.snapshot()
    assert.equal(first.entries.length, 79, '内置快照是 79 条（采集日 2026-10-10）')
    assert.deepEqual(first.seed, { collectedAt: '2026-10-10', count: 79 })
    assert.equal(CURATED_SEED.length, 79)
    assert.equal(CURATED_SEED_META.count, 79)
    assert.deepEqual(readConfigFile(h.configPath).curatedSources, first.entries,
      '首次打开必须落盘，而不是只活在内存里')

    const restarted = createSourcePack({ configPath: h.configPath, log: () => {} })
    assert.deepEqual(restarted.snapshot().entries, first.entries)
  } finally {
    h.cleanup()
  }
})

test('字段存在但为空数组 = 用户删光了：重启后不再自动填充种子', () => {
  const h = harness()
  try {
    assert.equal(h.control.snapshot().entries.length, 79)
    const removed = h.control.save([])
    assert.equal(removed.ok, true)
    assert.equal(removed.snapshot.entries.length, 0)

    const restarted = createSourcePack({ configPath: h.configPath, log: () => {} })
    assert.equal(restarted.snapshot().entries.length, 0,
      '空数组如果再被种子填满，「删光」就永远关不掉')
    assert.deepEqual(readConfigFile(h.configPath).curatedSources, [])
  } finally {
    h.cleanup()
  }
})

test('坏项容忍：保存时逐条丢弃并回报，合法项照常落盘', () => {
  const h = harness()
  try {
    const outcome = h.control.save([
      ENTRY('https://good.example/feed'),
      { url: 'nope', addedAt: '2026-11-01T00:00:00.000Z' },
      { url: 'https://bad.example/feed', addedAt: 'x' },
    ])
    assert.equal(outcome.ok, true)
    assert.equal(outcome.dropped, 2)
    assert.equal(outcome.snapshot.entries.length, 1)
    assert.match(outcome.snapshot.warning ?? '', /已忽略 2 条无效项/)
    assert.equal(readConfigFile(h.configPath).curatedSources.length, 1)
  } finally {
    h.cleanup()
  }
})

// ── 恢复内置快照 / 删除 / 重启 ──────────────────────────────────────────

test('恢复内置快照只补缺失 URL，不清用户自己的条目，也不产生重复', () => {
  const h = harness()
  try {
    const seeds = h.control.snapshot().entries
    const mine = ENTRY('https://my.example/feed', { title: '我的源' })
    const kept = seeds.slice(0, 5)
    assert.equal(h.control.save([...kept, mine]).ok, true)

    const restored = h.control.save([...kept, mine], { restoreSeed: true })
    assert.equal(restored.ok, true)
    assert.equal(restored.restored, 74, '79 条种子里有 5 条已在清单中，只补 74 条')
    assert.equal(restored.snapshot.entries.length, 80)
    assert.equal(restored.snapshot.entries.filter((entry) => entry.url === mine.url).length, 1)
    assert.ok(restored.snapshot.entries.some((entry) => entry.title === '我的源'))

    // 再恢复一次：一条都不补（清单已完整），用户条目仍在。
    const again = h.control.save(restored.snapshot.entries, { restoreSeed: true })
    assert.equal(again.ok, true)
    assert.equal(again.restored, 0)
    assert.equal(again.snapshot.entries.length, 80)
  } finally {
    h.cleanup()
  }
})

test('删除 / 新增都落盘：重建控制器后删掉的仍不在、新加的仍在（A13）', () => {
  const h = harness()
  try {
    const seeds = h.control.snapshot().entries
    const removedUrl = seeds[0].url
    const added = ENTRY('https://my.example/feed', { title: '我的源' })
    const saved = h.control.save([...seeds.slice(1), added])
    assert.equal(saved.ok, true)
    assert.equal(saved.snapshot.entries.length, 79, '79 - 1 + 1')

    const restarted = createSourcePack({ configPath: h.configPath, log: () => {} })
    const after = restarted.snapshot().entries
    assert.equal(after.length, 79)
    assert.equal(after.some((entry) => entry.url === removedUrl), false, '删除必须落盘，重启后不能复活')
    assert.equal(after.filter((entry) => entry.url === added.url).length, 1, '新增必须落盘')
  } finally {
    h.cleanup()
  }
})

// ── 端点（§5.2）─────────────────────────────────────────────────────────

function dispatchHarness() {
  const h = harness()
  const store = createMemoryStore()
  const dispatch = createDispatch({
    config: Config({}),
    log: (line) => h.logs.push(line),
    ready: () => store,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
    sourcePack: h.control,
  })
  return { ...h, store, dispatch }
}

test('sourcePack 端点：返回条目与内置快照元信息（采集日 + 条数）', async () => {
  const h = dispatchHarness()
  try {
    const result = await h.dispatch('sourcePack', {})
    assert.equal(result.ok, true)
    assert.equal(result.value.sourcePack.entries.length, 79)
    assert.deepEqual(result.value.sourcePack.seed, { collectedAt: '2026-10-10', count: 79 })
    assert.equal(result.value.sourcePack.entries[0].title.length > 0, true)
  } finally {
    h.cleanup()
  }
})

test('saveSourcePack 端点：整份替换，坏项逐条丢弃并回 warning，删除不影响订阅', async () => {
  const h = dispatchHarness()
  try {
    const before = h.store.listFeeds()
    const saved = await h.dispatch('saveSourcePack', {
      entries: [
        ENTRY('https://kept.example/feed'),
        { url: 'javascript:alert(1)', addedAt: '2026-11-01T00:00:00.000Z' },
      ],
    })
    assert.equal(saved.ok, true)
    assert.equal(saved.value.sourcePack.entries.length, 1)
    assert.match(saved.value.sourcePack.warning ?? '', /已忽略 1 条无效项/)
    assert.deepEqual(h.store.listFeeds(), before, '源包增删不是订阅操作')

    const read = await h.dispatch('sourcePack', {})
    assert.equal(read.value.sourcePack.entries.length, 1, '整份替换必须落盘')
  } finally {
    h.cleanup()
  }
})

test('删除源包条目不影响订阅：config.feeds 原样保留，条目库也不参与', () => {
  const dir = tempDir()
  const path = join(dir, 'config.json')
  try {
    const feed = { url: 'https://feed.example/atom.xml', title: '订阅源' }
    writeConfigFile(path, { version: 1, feeds: { [feed.url]: feed } })
    const control = createSourcePack({ configPath: path, log: () => {} })
    assert.equal(control.snapshot().entries.length, 79)
    assert.equal(control.save([]).ok, true)

    const file = readConfigFile(path)
    assert.deepEqual(file.curatedSources, [])
    assert.deepEqual(file.feeds, { [feed.url]: feed },
      '源包是清单、feeds 是订阅：删条目只能动 curatedSources')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
