/**
 * M2 02：文件夹端点的 wire 契约与 OPML 归属回归。
 *
 * 端点层只多两件事：把 payload 形状校验成明确的错误码、把 FolderError 转成失败信封。
 * 真正容易错的是 OPML：**「已存在的源保留本地归属」必须包括本地是「未分类」**——
 * 旧写法 `previous?.folder ?? subscription?.folder` 会把本地未分类的源重新套上 OPML 分组，
 * 而用户根本看不出归属是什么时候被改回去的。
 *
 * 这里用真实 SQLite store + 本地 HTTP 桩源（不出公网），走真实 opmlImport 校验路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrateSchema } from '../lib/storage/db.js'
import { readConfigFile, writeConfigFile } from '../lib/storage/config-file.js'
import { createSqliteStore } from '../lib/store-sqlite.js'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'
import { parseOpml } from '../lib/opml.js'

const FEED_ID = 'https://a.example/feed.xml'

function makeDispatch(feeds = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rss-folder-endpoint-'))
  const configPath = join(dir, 'config.json')
  writeConfigFile(configPath, { version: 1, feeds })
  const db = openDatabase(':memory:')
  migrateSchema(db)
  const store = createSqliteStore(db, configPath)
  const dispatch = createDispatch({
    config: Config({ timeoutMs: 3000, importConcurrency: 2 }),
    log: () => {},
    ready: () => store,
    refreshNow: async () => ({ outcome: 'not-ready', attempted: 0, total: 0 }),
    lastRefreshCompletedAt: () => undefined,
    articleAttempts: new Map(),
  })
  return {
    dispatch, store, configPath,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test('文件夹端点：增删改移的返回值与错误码（payload 形状在端点层拦住）', async () => {
  const h = makeDispatch({ [FEED_ID]: { url: FEED_ID, title: 'A', folder: '旧组' } })
  try {
    let result = await h.dispatch('listFolders', {})
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.folders, [{ name: '旧组', feedIds: [FEED_ID] }], '读取接口返回目录与成员')

    result = await h.dispatch('createFolder', { name: ' 空组 ' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.folders.map((folder) => folder.name), ['旧组', '空组'], '新名称去空白')
    result = await h.dispatch('createFolder', { name: '空组' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'conflict')
    result = await h.dispatch('createFolder', { name: '   ' })
    assert.equal(result.error.code, 'bad-request')
    result = await h.dispatch('createFolder', {})
    assert.equal(result.error.code, 'bad-request')

    result = await h.dispatch('renameFolder', { from: '旧组', to: '新组' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.folders, [
      { name: '新组', feedIds: [FEED_ID] },
      { name: '空组', feedIds: [] },
    ])
    result = await h.dispatch('renameFolder', { from: '缺失', to: 'x' })
    assert.equal(result.error.code, 'not-found')
    result = await h.dispatch('renameFolder', { from: '新组', to: '空组' })
    assert.equal(result.error.code, 'conflict')
    result = await h.dispatch('renameFolder', { from: '新组' })
    assert.equal(result.error.code, 'bad-request')

    result = await h.dispatch('moveFeedToFolder', { feedId: FEED_ID, folder: '空组' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.folders, [
      { name: '新组', feedIds: [] },
      { name: '空组', feedIds: [FEED_ID] },
    ])
    result = await h.dispatch('moveFeedToFolder', { feedId: FEED_ID })
    assert.equal(result.error.code, 'bad-request', '缺 folder 键 ≠ 移到未分类')
    result = await h.dispatch('moveFeedToFolder', { feedId: FEED_ID, folder: '不存在' })
    assert.equal(result.error.code, 'not-found')
    result = await h.dispatch('moveFeedToFolder', { feedId: 'https://missing.example/feed.xml', folder: '空组' })
    assert.equal(result.error.code, 'not-found')

    result = await h.dispatch('deleteFolder', { name: '空组' })
    assert.equal(result.ok, true)
    assert.equal(result.value.detached, 1, '删除目录只解除分类')
    assert.deepEqual(result.value.folders, [{ name: '新组', feedIds: [] }])
    assert.ok(h.store.feed(FEED_ID), '删除文件夹绝不退订')
    assert.equal(h.store.feed(FEED_ID).folder, undefined)
    result = await h.dispatch('deleteFolder', { name: '空组' })
    assert.equal(result.error.code, 'not-found')
  } finally { h.cleanup() }
})

const rssOf = (title) => '<?xml version="1.0"?><rss version="2.0"><channel><title>' + title
  + '</title><item><title>a</title><link>https://site.example/a</link><guid>g-' + title
  + '</guid></item></channel></rss>'

async function feedServer() {
  const server = createServer((req, res) => {
    const title = req.url === '/existing.xml' ? '已有源' : req.url === '/new.xml' ? '新源' : ''
    if (title === '') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('no')
      return
    }
    res.writeHead(200, { 'content-type': 'application/rss+xml' })
    res.end(rssOf(title))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    origin: 'http://127.0.0.1:' + address.port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const opmlWith = (origin, folder) => '<opml version="2.0"><body><outline text="' + folder + '">'
  + '<outline text="已有" type="rss" xmlUrl="' + origin + '/existing.xml"/>'
  + '<outline text="新" type="rss" xmlUrl="' + origin + '/new.xml"/>'
  + '</outline></body></opml>'

test('OPML：新源继承分组，重复导入保留本地未分类，导出保持分组', async () => {
  const server = await feedServer()
  const existing = server.origin + '/existing.xml'
  const added = server.origin + '/new.xml'
  const h = makeDispatch({ [existing]: { url: existing, title: '已有源' } })
  try {
    let result = await h.dispatch('opmlImport', { opml: opmlWith(server.origin, '导入分组') })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.value.added, 1, '新源一条')
    assert.equal(result.value.existed, 1, '已有源一条')
    assert.deepEqual(result.value.failed, [])
    const acceptedExisting = result.value.accepted.find((entry) => entry.url === existing)
    const acceptedNew = result.value.accepted.find((entry) => entry.url === added)
    assert.equal(acceptedExisting.folder, undefined, '本地未分类的已有源必须保持未分类')
    assert.equal(acceptedNew.folder, '导入分组', '新源继承 OPML 分组')

    let disk = readConfigFile(h.configPath)
    assert.equal(disk.feeds[existing].folder, undefined, '重复导入不得把本地未分类改回 OPML 分组')
    assert.equal(disk.feeds[added].folder, '导入分组')
    assert.deepEqual(disk.folders, ['导入分组'], '新分组进入目录')

    // 再导入一次：两条都已存在，归属一个都不许变
    result = await h.dispatch('opmlImport', { opml: opmlWith(server.origin, '导入分组') })
    assert.equal(result.value.added, 0)
    assert.equal(result.value.existed, 2)
    assert.equal(readConfigFile(h.configPath).feeds[existing].folder, undefined, '重复导入仍保持未分类')

    // 把已有源移到本地分组，再用 OPML 导入：本地归属优先
    result = await h.dispatch('createFolder', { name: '本地分组' })
    assert.equal(result.ok, true)
    result = await h.dispatch('moveFeedToFolder', { feedId: existing, folder: '本地分组' })
    assert.equal(result.ok, true)
    result = await h.dispatch('opmlImport', { opml: opmlWith(server.origin, '导入分组') })
    assert.equal(result.value.existed, 2)
    disk = readConfigFile(h.configPath)
    assert.equal(disk.feeds[existing].folder, '本地分组', '已有源的本地归属优先于 OPML 分组')

    // 导出：有订阅的分组都在；解析回来核对归属
    result = await h.dispatch('opmlExport', {})
    assert.equal(result.ok, true)
    const exported = parseOpml(result.value.opml)
    assert.equal(exported.skipped.length, 0)
    assert.equal(exported.subscriptions.find((sub) => sub.xmlUrl === existing).folder, '本地分组')
    assert.equal(exported.subscriptions.find((sub) => sub.xmlUrl === added).folder, '导入分组')
  } finally {
    await server.close()
    h.cleanup()
  }
})
