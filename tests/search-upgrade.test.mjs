import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { SCHEMA_VERSION } from '../lib/storage/db.js'
// 正文缓存的 revision 跟着抽取器版本走：写死 3 会在下一次抬版本时变成「缓存过期」，
// 让「旧库可读」这条用例去走网络（2026-11-15 抬到 4 时实测踩到）。
import { EXTRACTOR_REVISION } from '../lib/article.js'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const feed = 'https://example.test/v1'
const time = '2026-10-20T12:00:00.000Z'
const blocks = [{ kind: 'p', text: '旧版缓存正文里的支付' }]

function snapshot(path, configPath) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return {
      version: db.prepare('PRAGMA user_version').get().user_version,
      schema: db.prepare('SELECT type, name, sql FROM sqlite_schema ORDER BY name').all(),
      // 显式列而不是 *：v4 给 items 加了派生列 link_key（升级时会回填），它在 v1 里不存在 ——
      // 拿 * 比较会把「新增派生列」误报成「旧条目被改了」。业务列一个不少，仍逐行对账。
      items: db.prepare('SELECT id, feed_id, title, link, published_at, fetched_at, summary, read_at, starred, kept_unread, article_failure, recency FROM items ORDER BY id').all(),
      texts: db.prepare('SELECT * FROM texts ORDER BY item_id').all(),
      cursors: db.prepare('SELECT * FROM cursors ORDER BY feed_id').all(),
      config: JSON.parse(readFileSync(configPath, 'utf8')),
    }
  } finally {
    db.close()
  }
}

test('搜索直接使用旧版 v1 库，Worker 启动失败时仍可阅读且恢复后能重试', { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'rss-search-upgrade-'))
  const oldHome = process.env.DSH_HOME
  const stops = []
  let server
  try {
    process.env.DSH_HOME = root
    const storage = join(root, 'storages', 'rss-reader')
    mkdirSync(storage, { recursive: true })
    const path = join(storage, 'rss.db')
    const configPath = join(storage, 'config.json')
    const oldDb = new DatabaseSync(path)
    try {
      oldDb.exec(readFileSync(new URL('./fixtures/rss-storage-v1.sql', import.meta.url), 'utf8'))
      oldDb.prepare('INSERT INTO items (id, feed_id, title, link, fetched_at, read_at, starred, kept_unread) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run('read', feed, '旧版已读星标', 'https://example.test/read', time, time, 1, 0)
      oldDb.prepare('INSERT INTO items (id, feed_id, title, link, fetched_at, kept_unread) VALUES (?, ?, ?, ?, ?, ?)')
        .run('unread', feed, '旧版保留未读', 'https://example.test/unread', time, 1)
      oldDb.prepare('INSERT INTO texts (item_id, body, revision, frameable, title, fetched_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('read', JSON.stringify(blocks), EXTRACTOR_REVISION, 0, '旧版缓存标题', time)
      oldDb.prepare('INSERT INTO cursors (feed_id, seen, cursor_at) VALUES (?, ?, ?)')
        .run(feed, JSON.stringify(['read', 'unread']), time)
    } finally {
      oldDb.close()
    }
    writeFileSync(configPath, JSON.stringify({ version: 1, feeds: { [feed]: { url: feed, title: '旧版订阅' } } }))
    const before = snapshot(path, configPath)

    // 只在临时插件副本里移走 Worker，模拟发布缺件且保留真实加载失败路径。
    const lib = join(root, 'lib')
    cpSync(fileURLToPath(new URL('../lib/', import.meta.url)), lib, { recursive: true })
    // 临时插件副本要与真实发布包同形：settings 控制器在装载时读包自身的 version
    //（R11 06 关于区的版本号），缺了它 apply 会响亮失败 —— 这正是本夹具想复现的「发布缺件」之外的情况。
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '0.0.0-test' }))
    symlinkSync(fileURLToPath(new URL('../node_modules/', import.meta.url)), join(root, 'node_modules'), 'dir')
    const { apply } = await import(pathToFileURL(join(lib, 'index.js')).href)
    let handler
    const lines = []
    const ctx = {
      logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
      effect: (setup) => { stops.push(setup()) },
      webServer: { register: (route) => {
        handler = route.handler
        return () => { handler = undefined }
      } },
      tools: { register: () => () => {} },
      on: () => () => {},
      connection: { requestRejection: () => undefined },
    }
    server = createServer((req, res) => handler(req, res))
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const url = 'http://127.0.0.1:' + server.address().port + '/rss-reader-api'
    const request = async (endpoint, payload = {}) => {
      const response = await fetch(url, { method: 'POST', body: JSON.stringify({ endpoint, payload }), signal: AbortSignal.timeout(3000) })
      assert.equal(response.status, 200)
      return response.json()
    }
    const boot = async () => {
      apply(ctx, { feeds: [], refreshOnStart: false })
      for (let index = 0; index < 50; index++) {
        const overview = await request('overview')
        if (overview.ok) return overview.value
        assert.equal(overview.error.code, 'not-ready')
        await delay(10)
      }
      assert.fail('旧库未能启动')
    }
    const stop = async () => {
      while (stops.length) await stops.pop()?.()
    }

    const overview = await boot()
    // v1→v2 的迁移是 M2 05 的交付：旧库第一次装载就升级；条目/正文/游标/配置保持原样。
    const upgraded = snapshot(path, configPath)
    assert.equal(upgraded.version, SCHEMA_VERSION, '旧库应升级到当前物理版本')
    assert.deepEqual(upgraded.items, before.items, '升级不改变旧条目')
    assert.deepEqual(upgraded.texts, before.texts, '升级不改变旧正文缓存')
    assert.deepEqual(upgraded.cursors, before.cursors, '升级不改变去重窗口')
    assert.deepEqual(upgraded.config, before.config, '升级不改变 config.json')
    assert.ok(upgraded.schema.some((row) => row.name === 'tags'), 'v2 必须建出 tags 表')
    assert.ok(upgraded.schema.some((row) => row.name === 'item_tags'), 'v2 必须建出 item_tags 表')
    assert.deepEqual(overview.feeds.map(({ title }) => title), ['旧版订阅'])
    assert.deepEqual(overview.items.map(({ id, readAt, starred, keptUnread }) => [id, readAt, starred, keptUnread]), [
      ['read', time, true, undefined], ['unread', undefined, false, true],
    ])
    const search = await request('searchItems', { text: '支付' })
    assert.equal(search.ok, true)
    assert.deepEqual(search.value.items.map(({ id }) => id), ['read'])
    await stop()
    assert.deepEqual(snapshot(path, configPath), upgraded, '停止后库仍是升级后的稳定状态')

    const worker = join(lib, 'search-worker.js')
    renameSync(worker, worker + '.disabled')
    await boot()
    const failed = await request('searchItems', { text: '支付' })
    assert.equal(failed.ok, false)
    assert.equal(failed.error.code, 'internal')
    assert.match(failed.error.message, /search-worker\.js/)
    assert(lines.some((line) => line.includes('请求失败（searchItems）')))

    const afterFailure = await request('overview')
    assert.equal(afterFailure.ok, true)
    assert.deepEqual(afterFailure.value.items, overview.items)
    const article = await request('article', { itemId: 'read' })
    assert.equal(article.ok, true)
    assert.equal(article.value.cached, true)
    assert.deepEqual(article.value.blocks, blocks)

    renameSync(worker + '.disabled', worker)
    const retry = await request('searchItems', { text: '支付' })
    assert.deepEqual(retry, search)
    await stop()
    assert.deepEqual(snapshot(path, configPath), upgraded, '第二次停止后也不该再改库')
  } finally {
    try {
      while (stops.length) await stops.pop()?.()
    } finally {
      if (server?.listening) await new Promise((resolve) => server.close(resolve))
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
      rmSync(root, { recursive: true, force: true })
    }
  }
})
