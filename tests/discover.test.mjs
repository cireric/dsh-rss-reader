/**
 * Feed auto-discovery（规格 §3.1 的第二种订阅途径）：从首页 HTML 里找它声明的 feed。
 * 纯函数，不出网。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoverFeedUrls, isSameOrigin } from '../lib/feed/discover.js'

const PAGE = 'https://site.test/blog/index.html'

test('标准声明：link rel=alternate + rss/atom 类型', () => {
  const rss = '<link rel="alternate" type="application/rss+xml" href="/feed.xml">'
  assert.deepEqual(discoverFeedUrls(rss, PAGE), ['https://site.test/feed.xml'])
  const atom = '<link rel="alternate" type="application/atom+xml" title="A" href="https://other.test/atom.xml">'
  assert.deepEqual(discoverFeedUrls(atom, PAGE), ['https://other.test/atom.xml'])
})

test('相对路径按页面 URL 绝对化', () => {
  const html = '<link rel="alternate" type="application/rss+xml" href="feed.xml">'
  assert.deepEqual(discoverFeedUrls(html, PAGE), ['https://site.test/blog/feed.xml'])
})

test('只认真正声明 feed 的 link：rel 不对 / type 不对都忽略', () => {
  assert.deepEqual(discoverFeedUrls('<link rel="stylesheet" type="text/css" href="/a.css">', PAGE), [])
  assert.deepEqual(discoverFeedUrls('<link rel="alternate" type="text/html" href="/index.html">', PAGE), [])
  // 取舍：只认标准的 rel=alternate 声明。rel 别的写法（如 preload）是**资源提示**、不是 feed 声明，
  // 即便 type 写着 feed 也不当候选 —— 放宽只会让「订阅我们」这类链接混进来，而收益是个例
  assert.deepEqual(discoverFeedUrls('<link rel="preload" type="application/rss+xml" href="/x.xml">', PAGE), [])
})

test('主路径命中就不再走 a 标签兜底（否则会把「订阅我们」这类链接当 feed）', () => {
  const html = '<link rel="alternate" type="application/rss+xml" href="/feed.xml"><a href="/feed">订阅</a>'
  assert.deepEqual(discoverFeedUrls(html, PAGE), ['https://site.test/feed.xml'])
})

test('兜底：没有 link 声明时，按 §3.1 的词表在 a 的 href 里找（那个「橙色图标」）', () => {
  const html = '<nav><a href="/about">关于</a><a href="/rss.xml">订阅</a><a href="/feed">Feed</a></nav>'
  assert.deepEqual(discoverFeedUrls(html, PAGE), ['https://site.test/rss.xml', 'https://site.test/feed'])
})

test('去重、保序、候选封顶 5 个', () => {
  const one = Array.from({ length: 8 }, (_, i) => '<link rel="alternate" type="application/rss+xml" href="/f' + i + '.xml">')
  const found = discoverFeedUrls(one.join("") + one[0], PAGE)
  assert.equal(found.length, 5, '一个页面挂几十个链接不能顺着全抓')
  assert.equal(found[0], 'https://site.test/f0.xml', '保序')
  assert.equal(new Set(found).size, found.length, '去重')
})

test('非 http(s) 的 href 一律丢弃（data: / javascript:）', () => {
  const html = '<link rel="alternate" type="application/rss+xml" href="data:text/plain,x">'
    + '<link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">'
  assert.deepEqual(discoverFeedUrls(html, PAGE), [])
})

test('isSameOrigin：同源才继承信任（信任不传播的判据）', () => {
  assert.equal(isSameOrigin('https://a.test/x', 'https://a.test/y'), true)
  assert.equal(isSameOrigin('https://a.test/x', 'https://b.test/y'), false)
  assert.equal(isSameOrigin('https://a.test/x', 'http://a.test/y'), false, '协议不同就算跨源')
  assert.equal(isSameOrigin('not a url', 'https://a.test/y'), false)
})
