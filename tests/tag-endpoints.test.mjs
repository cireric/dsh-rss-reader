/**
 * M2 05 的 wire 契约：标签 CRUD 与文章关联的错误码/形状。
 * 存储语义（迁移、级联、身份合并）在 tests/tag-storage.test.mjs；这里只钉端点层。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, migrateSchema } from '../lib/storage/db.js'
import { writeConfigFile } from '../lib/storage/config-file.js'
import { createSqliteStore } from '../lib/store-sqlite.js'
import { createDispatch } from '../lib/endpoints.js'
import { Config } from '../lib/config.js'

const FEED = 'https://tag-endpoint.example/feed.xml'
const ITEM = 'item-1'
const TIME = '2026-10-20T12:00:00.000Z'

function makeDispatch() {
  const dir = mkdtempSync(join(tmpdir(), 'rss-tag-endpoint-'))
  const configPath = join(dir, 'config.json')
  writeConfigFile(configPath, { version: 1, feeds: { [FEED]: { url: FEED, title: 'T' } } })
  const db = openDatabase(join(dir, 'rss.db'))
  migrateSchema(db)
  const store = createSqliteStore(db, configPath)
  db.prepare('INSERT INTO items (id, feed_id, title, link, fetched_at, starred) VALUES (?, ?, ?, ?, ?, 0)')
    .run(ITEM, FEED, '文章', 'https://tag-endpoint.example/1', TIME)
  const dispatch = createDispatch({
    config: Config({}), log: () => {}, ready: () => store,
    refreshNow: async () => false, lastRefreshCompletedAt: () => undefined, articleAttempts: new Map(),
  })
  return { dispatch, store, cleanup: () => { db.close(); rmSync(dir, { recursive: true, force: true }) } }
}

test('标签端点：创建/改名/列表/删除与错误码', async () => {
  const h = makeDispatch()
  try {
    let result = await h.dispatch('listTags', {})
    assert.deepEqual(result.value.tags, [], '空库没有标签')

    result = await h.dispatch('createTag', { name: '  甲  ' })
    assert.equal(result.ok, true, JSON.stringify(result))
    const tag = result.value.tag
    assert.equal(tag.name, '甲', '创建去首尾空白')
    assert.equal(typeof tag.id, 'string')

    result = await h.dispatch('createTag', { name: '甲' })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'conflict')
    result = await h.dispatch('createTag', { name: '   ' })
    assert.equal(result.error.code, 'bad-request')

    result = await h.dispatch('renameTag', { id: tag.id, name: '甲改' })
    assert.equal(result.ok, true)
    assert.equal(result.value.tag.id, tag.id, '改名保 id')
    result = await h.dispatch('renameTag', { id: 'missing', name: 'x' })
    assert.equal(result.error.code, 'not-found')
    result = await h.dispatch('renameTag', { id: tag.id })
    assert.equal(result.error.code, 'bad-request')

    result = await h.dispatch('listTags', {})
    assert.equal(result.value.tags[0].itemCount, 0, '空标签仍在列表里')
    result = await h.dispatch('deleteTag', { id: tag.id })
    assert.equal(result.ok, true)
    result = await h.dispatch('deleteTag', { id: tag.id })
    assert.equal(result.error.code, 'not-found')
  } finally { h.cleanup() }
})

test('setItemTags：重复去重、混合无效回滚、空数组清空，列表计数同步', async () => {
  const h = makeDispatch()
  try {
    const a = (await h.dispatch('createTag', { name: 'A' })).value.tag
    const b = (await h.dispatch('createTag', { name: 'B' })).value.tag

    let result = await h.dispatch('setItemTags', { itemId: ITEM, tagIds: [a.id, a.id, b.id] })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(result.value.tags.map((tag) => tag.name).sort(), ['A', 'B'], '重复 id 只写一次')
    result = await h.dispatch('listTags', {})
    assert.deepEqual(result.value.tags.map((tag) => [tag.name, tag.itemCount]).sort(), [['A', 1], ['B', 1]])

    result = await h.dispatch('setItemTags', { itemId: ITEM, tagIds: [a.id, 'missing'] })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'not-found')
    result = await h.dispatch('setItemTags', { itemId: ITEM, tagIds: [b.id] })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.tags.map((tag) => tag.name), ['B'], '混合无效请求没有改掉原有 A/B')

    result = await h.dispatch('setItemTags', { itemId: 'missing', tagIds: [a.id] })
    assert.equal(result.error.code, 'not-found')
    result = await h.dispatch('setItemTags', { itemId: ITEM, tagIds: 'not-array' })
    assert.equal(result.error.code, 'bad-request')
    result = await h.dispatch('setItemTags', { itemId: ITEM, tagIds: [] })
    assert.deepEqual(result.value.tags, [], '空数组清空关联')
  } finally { h.cleanup() }
})
