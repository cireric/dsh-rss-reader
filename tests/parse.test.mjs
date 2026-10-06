/**
 * 三格式归一测试：钉死 RSS2.0 / RSS1.0(RDF) / Atom 的字段映射与日期归一。
 * 依赖构建产物 lib/（npm test 前先 dev_build_plugin 或 bash scripts/build.sh）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFeed } from '../lib/feed/parse.js'
import { toIsoUtc } from '../lib/feed/date.js'
import { deriveItemId } from '../lib/feed/item-id.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = (name) => readFileSync(join(ROOT, 'tests', 'fixtures', name), 'utf8')

test('RSS 2.0：字段映射、CDATA、相对链接、实体解码', () => {
  const feed = parseFeed(fixture('rss2.xml'), 'https://example.com/feed.xml')

  assert.equal(feed.format, 'rss2')
  assert.equal(feed.title, '示例科技博客')
  assert.equal(feed.items.length, 2)

  const [first, second] = feed.items
  assert.equal(first.id, 'post-59')
  assert.equal(first.link, 'https://example.com/blog/ts-59')
  assert.equal(first.publishedAt, '2018-04-02T02:00:00.000Z', '单位数日期 + 带偏移时区必须归一成 UTC')
  assert.equal(first.publishedRaw, 'Mon, 2 Apr 2018 10:00:00 +0800')
  assert.equal(first.author, '张三')
  assert.match(first.summary, /CDATA 里的 <b>HTML<\/b>/)

  assert.equal(second.link, 'https://example.com/blog/rust-zig', '相对链接要按源地址补全')
  assert.equal(second.publishedAt, '2003-06-03T09:39:21.000Z')
  assert.equal(second.summary, '相对链接 + 实体：Tom & Jerry ’s', '内置实体与数字实体都要解码')
  assert.equal(second.id, undefined, '没给 guid 时不得凭空编造 id')
})

test('RSS 1.0 (RDF)：条目与 dc:date', () => {
  const feed = parseFeed(fixture('rss1.xml'), 'https://rss1.example.net/feed')

  assert.equal(feed.format, 'rss1')
  assert.equal(feed.title, 'RSS 1.0 示例')
  assert.equal(feed.items.length, 1)
  assert.equal(feed.items[0].link, 'https://rss1.example.net/a')
  assert.equal(feed.items[0].publishedAt, '2020-01-02T03:04:05.000Z')
  assert.equal(feed.items[0].summary, 'RDF 描述')
})

test('Atom：link 属性取值、published 缺失时用 updated 兜底', () => {
  const feed = parseFeed(fixture('atom.xml'), 'https://atom.example.org/feed.xml')

  assert.equal(feed.format, 'atom')
  assert.equal(feed.title, 'Atom 示例')
  assert.equal(feed.items.length, 2)

  const [first, second] = feed.items
  assert.equal(first.id, 'tag:atom.example.org,2024:repro')
  assert.equal(first.link, 'https://atom.example.org/posts/repro')
  assert.equal(first.author, '李四')
  assert.equal(first.publishedAt, '2024-04-30T00:15:00.000Z', '带偏移的 ISO8601 也要落到 UTC')
  assert.equal(second.link, 'https://atom.example.org/posts/updated-only')
  assert.equal(second.publishedAt, '2024-05-02T00:00:00.000Z', '缺 published 必须回退到 updated')
  assert.equal(second.summary, '<p>content 兜底</p>', '缺 summary 必须回退到 content')
})

test('非 feed 输入判为 unknown，且不抛异常', () => {
  const feed = parseFeed(fixture('notafeed.html'), 'https://example.com/')
  assert.equal(feed.format, 'unknown')
  assert.equal(feed.items.length, 0)
})

test('日期归一：非法值返回 undefined 而不编造', () => {
  assert.equal(toIsoUtc(''), undefined)
  assert.equal(toIsoUtc(undefined), undefined)
  assert.equal(toIsoUtc('不是日期'), undefined)
  assert.equal(toIsoUtc('2024-05-01T12:00:00Z'), '2024-05-01T12:00:00.000Z')
  assert.equal(toIsoUtc('Mon, 2 Apr 2018 10:00:00 +0800'), '2018-04-02T02:00:00.000Z')
  assert.equal(toIsoUtc('Thu, 01 Jan 1970 00:00:00 GMT'), '1970-01-01T00:00:00.000Z')
})

test('条目 id 稳定派生：同一输入恒等，不同 guid 不同 id', () => {
  const a = deriveItemId('feed-1', { id: 'guid-a', link: 'https://x/1', title: 't' })
  const b = deriveItemId('feed-1', { id: 'guid-a', link: 'https://x/1', title: 't' })
  assert.equal(a, b)

  assert.notEqual(a, deriveItemId('feed-1', { id: 'guid-b', link: 'https://x/1', title: 't' }))
  assert.notEqual(a, deriveItemId('feed-2', { id: 'guid-a', link: 'https://x/1', title: 't' }), '同一文章在两个源里必须各自独立')

  // 无 guid 时退到 link
  const byLink = deriveItemId('feed-1', { link: 'https://x/2' })
  assert.equal(byLink, deriveItemId('feed-1', { link: 'https://x/2', title: '变了也不影响' }))
})
