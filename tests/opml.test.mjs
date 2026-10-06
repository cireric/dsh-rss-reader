/**
 * OPML 导入/导出的单测。
 *
 * 用固定夹具模拟**真实阅读器导出的怪癖**：属性大小写不一致、嵌套分组、重复项、坏 URL、
 * 纯分组容器、文本里的 XML 实体。这些都是"别人的文件"，一旦解析错了我无法在浏览器里看出来，
 * 所以逐条钉住：该进的进、该跳的跳、跳过原因必须可见。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseOpml, buildOpml } from '../lib/opml.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(join(here, 'fixtures', 'subscriptions.opml'), 'utf8')

test('解析真实形态的 OPML：读得到源、认得出嵌套分组', () => {
  const { subscriptions } = parseOpml(fixture)
  const urls = subscriptions.map((s) => s.xmlUrl)
  assert.ok(urls.includes('https://news.ycombinator.com/rss'), '漏了未嵌套的源')
  assert.ok(urls.includes('https://github.blog/feed/'), '漏了嵌套源')
  assert.ok(urls.includes('https://sspai.com/feed'), '漏了二级嵌套源')

  const sp = subscriptions.find((s) => s.xmlUrl === 'https://sspai.com/feed')
  assert.equal(sp.folder, 'Tech/中文源', '二级分组的 folder 应当用 / 连接')
  const hn = subscriptions.find((s) => s.xmlUrl === 'https://news.ycombinator.com/rss')
  assert.equal(hn.folder, 'Tech')
  assert.equal(hn.title, 'Hacker News')
})

test('标题与 URL 里的实体被解码（&amp; → &）', () => {
  const { subscriptions } = parseOpml(fixture)
  const amp = subscriptions.find((s) => s.xmlUrl === 'https://example.com/amp.xml')
  assert.ok(amp, '带实体的源没有被解析出来')
  assert.equal(amp.title, '带 & 的名字')
})

test('属性名大小写不敏感：xmlurl 也要认', () => {
  const { subscriptions } = parseOpml(fixture)
  assert.ok(
    subscriptions.some((s) => s.xmlUrl === 'https://example.com/lowercase.xml'),
    '小写 xmlurl 的源被漏掉了 —— 真实 OPML 里这种写法很常见',
  )
})

test('被跳过的条目必须给出原因（不能静默吞）', () => {
  const { skipped } = parseOpml(fixture)
  const reasons = skipped.map((s) => s.reason).join(' | ')
  assert.match(reasons, /URL 非法/, '坏 URL 未被报告')
  assert.match(reasons, /重复/, '重复项未被报告')
  assert.match(reasons, /既没有 xmlUrl 也没有子项/, '空分组容器未被报告')
})

test('同一文件内的重复 URL 只保留一次', () => {
  const { subscriptions } = parseOpml(fixture)
  const count = subscriptions.filter((s) => s.xmlUrl === 'https://github.blog/feed/').length
  assert.equal(count, 1, '重复 URL 应当只保留一条')
})

test('不是 OPML 的输入：如实报告，不抛异常', () => {
  const rss = '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>'
  const result = parseOpml(rss)
  assert.deepEqual(result.subscriptions, [])
  assert.match(result.skipped[0].reason, /不是 OPML/)
})

test('空与畸形输入不抛异常', () => {
  for (const input of ['', '   ', '<opml>', 'not xml at all <<<']) {
    const result = parseOpml(input)
    assert.ok(Array.isArray(result.subscriptions), '输入 ' + JSON.stringify(input) + ' 时应当返回结构而不是抛错')
  }
})

test('导出：无 folder 的平铺、有 folder 的嵌套', () => {
  const opml = buildOpml([
    { url: 'https://a.test/feed', title: 'A' },
    { url: 'https://b.test/feed', title: 'B', folder: 'Tech' },
    { url: 'https://c.test/feed', title: 'C', folder: 'Tech' },
  ])
  assert.match(opml, /<opml version="2\.0">/)
  assert.match(opml, /xmlUrl="https:\/\/a\.test\/feed"/)
  assert.match(opml, /<outline text="Tech"/)
})

test('导出 → 导入 往返：订阅集合与分组保持不变', () => {
  const original = [
    { url: 'https://a.test/feed', title: 'A & B' },
    { url: 'https://b.test/feed', title: 'B', folder: '分组一' },
    { url: 'https://c.test/feed', title: 'C', folder: '分组一' },
    { url: 'https://d.test/feed', title: 'D', folder: '分组二/子组' },
  ]
  const { subscriptions, skipped } = parseOpml(buildOpml(original))
  assert.deepEqual(skipped, [], '我们自己导出的文件不该产生跳过项：' + JSON.stringify(skipped))
  assert.equal(subscriptions.length, original.length)
  for (const feed of original) {
    const found = subscriptions.find((s) => s.xmlUrl === feed.url)
    assert.ok(found, '往返后丢了 ' + feed.url)
    assert.equal(found.title, feed.title, feed.url + ' 的标题在往返中变了')
    if (feed.folder !== undefined) assert.equal(found.folder, feed.folder, feed.url + ' 的分组在往返中变了')
  }
})
