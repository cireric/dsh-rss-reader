/**
 * R9 01：回溯的纯函数层。
 *
 * 这些用例钉的是**行为契约**（spec §4.2 / §4.4 / §4.5），不是实现形状：
 *   - A1/A2：真实归档页上的链接总数 → 形态命中数 → 同文键去重后的候选数，全部是固定数字；
 *   - A3：样本不足时**没有**过滤器（调用方据此拒绝，绝不退回「全收」）；
 *   - A4：同文键只在协议上与 link_key 不同，其余归一化规则逐条相同；
 *   - A5：日期只认 spec §4.4 的五级来源，只有年月时**不补 01**。
 *
 * 夹具是 2026-11-23 的真实抓取，见 fixtures/archive/README.md。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deriveLinkFilter, extractArchiveLinks, selectBackfillCandidates } from '../lib/history.js'
import { linkKeyOf, sameArticleKeyOf } from '../lib/duplicates.js'
import { articleDateOf } from '../lib/article-date.js'

const fixture = (name) => readFileSync(new URL('./fixtures/archive/' + name, import.meta.url), 'utf8')

/** atom 里的**条目**链接（`<entry>` 内的 rel=alternate；不含 feed 自己的首页链接）。 */
function entryLinks(xml) {
  return xml.split('<entry>').slice(1)
    .map((block) => /<link[^>]*rel="alternate"[^>]*href="([^"]*)"/.exec(block)?.[1])
    .filter((href) => href !== undefined)
}

const RYF_ARCHIVES_URL = 'https://www.ruanyifeng.com/blog/archives.html'
const RYF_MONTH_URL = 'https://www.ruanyifeng.com/blog/2020/01/'
const YF_MONTH_URL = 'https://blog.codingnow.com/2026/10/'

/* ==================== 链接抽取：三种引号 / 相对地址 / 协议 / 去重 ==================== */

test('extractArchiveLinks：三种引号形态都能抽，相对地址按 base 解析，只留 http(s)，去 fragment 并按文档顺序去重', () => {
  const html = [
    '<a href="/blog/a.html">A</a>',
    "<a href='https://other.example/b.html#section'>B</a>",
    '<a href=/blog/c.html?x=1&amp;y=2>C</a>',
    '<a href="#top">页内锚点</a>',
    '<a href="javascript:void(0)">脚本</a>',
    '<a href="mailto:x@example.com">邮件</a>',
    '<a href="/blog/a.html#again">A 的另一个锚点</a>',
    '<a data-href="/blog/not-a-link.html">只有 data-href</a>',
    '<a>没有 href</a>',
  ].join('\n')
  assert.deepEqual(extractArchiveLinks(html, RYF_ARCHIVES_URL), [
    'https://www.ruanyifeng.com/blog/a.html',
    'https://other.example/b.html',
    'https://www.ruanyifeng.com/blog/c.html?x=1&y=2',
    // href="#top" 解析成页面自身（已去 fragment）——它确实是 http(s) 链接，
    // 形态过滤会在后面把它滤掉；抽取层不替过滤层做决定。
    'https://www.ruanyifeng.com/blog/archives.html',
  ])
})

test('extractArchiveLinks：真实归档页的链接总数（A1/A2 的分母）', () => {
  assert.equal(extractArchiveLinks(fixture('ryf-archives.html'), RYF_ARCHIVES_URL).length, 51)
  assert.equal(extractArchiveLinks(fixture('ryf-month.html'), RYF_MONTH_URL).length, 23)
  assert.equal(extractArchiveLinks(fixture('yf-month.html'), YF_MONTH_URL).length, 6)
})

/* ==================== 形态过滤器：两条规则 + 样本下限 ==================== */

test('A3 样本不足：少于 3 条链接不产生过滤器（调用方据此拒绝，不退回全收）', () => {
  assert.equal(deriveLinkFilter([]), undefined)
  assert.equal(deriveLinkFilter(['https://www.ruanyifeng.com/blog/2026/11/weekly-issue-420.html']), undefined)
  assert.equal(deriveLinkFilter([
    'https://www.ruanyifeng.com/blog/2026/11/weekly-issue-420.html',
    'https://www.ruanyifeng.com/blog/2026/11/weekly-issue-419.html',
  ]), undefined)
  // 3 条**有效**样本才够：样本给的是「这个源的文章长什么样」
  assert.equal(typeof deriveLinkFilter([
    'https://www.ruanyifeng.com/blog/2026/11/weekly-issue-420.html',
    'https://www.ruanyifeng.com/blog/2026/11/weekly-issue-419.html',
    'https://www.ruanyifeng.com/blog/2026/11/weekly-issue-418.html',
  ]), 'function')
  // 数组长度是 3、但一条是空串 / 非 http(s) ⇒ 有效样本只有 2 条，仍不足（A3 的「有效样本」口径）
  assert.equal(deriveLinkFilter([
    'https://www.ruanyifeng.com/blog/2026/11/weekly-issue-420.html',
    'https://www.ruanyifeng.com/blog/2026/11/weekly-issue-419.html',
    '',
  ]), undefined)
  assert.equal(deriveLinkFilter([
    'https://www.ruanyifeng.com/blog/2026/11/weekly-issue-420.html',
    'https://www.ruanyifeng.com/blog/2026/11/weekly-issue-419.html',
    'mailto:x@example.com',
  ]), undefined)
})

test('形态规则：整路径形状（数字→#）或「目录形状 + 扩展名」任一命中即算文章；host 必须一致、协议忽略', () => {
  const filter = deriveLinkFilter(entryLinks(fixture('ryf-atom.xml')))
  assert.ok(filter)

  // 规则一：数字串换成 # 后与样本同形
  assert.equal(filter('https://www.ruanyifeng.com/blog/2020/01/deno-intro.html'), true)
  // 协议忽略（atom 是 http://，归档页是 https://）
  assert.equal(filter('http://www.ruanyifeng.com/blog/2020/01/deno-intro.html'), true)
  // 规则二：目录形状（数字→#）+ 扩展名相同
  assert.equal(filter('https://www.ruanyifeng.com/blog/2019/06/some-article.html'), true)

  // 月份索引：没有扩展名，两条规则都不该吃下它
  assert.equal(filter('https://www.ruanyifeng.com/blog/2026/11/'), false)
  // 分类页
  assert.equal(filter('https://www.ruanyifeng.com/blog/weekly/'), false)
  // host 不同
  assert.equal(filter('https://example.com/blog/2020/01/deno-intro.html'), false)
  // 扩展名不同
  assert.equal(filter('https://www.ruanyifeng.com/blog/2020/01/deno-intro.pdf'), false)
  // 非 http(s) / 解析不出来
  assert.equal(filter('javascript:alert(1)'), false)
  assert.equal(filter('/blog/2020/01/deno-intro.html'), false)
})

/* ==================== 候选：形态命中 − 已知，按文档顺序取前 N ==================== */

test('selectBackfillCandidates：形态命中、同文键去掉已知链接、按文档顺序取前 N', () => {
  const links = [
    'https://example.com/blog/2026/01/a.html',
    'https://example.com/blog/2026/01/b.html',
    'https://example.com/blog/2026/01/c.html',
    'https://example.com/blog/2026/01/d.html',
    'https://example.com/blog/2026/01/e.html',
  ]
  const filter = (url) => url.endsWith('.html') && url.includes('/blog/')
  const knownLinks = [
    // 协议不同也算同一篇（同文键），末尾斜杠与锚点同样归一
    'http://example.com/blog/2026/01/b.html/',
    'https://example.com/blog/2026/01/d.html#top',
  ]
  assert.deepEqual(
    selectBackfillCandidates({ links, filter, knownLinks, limit: 2 }),
    ['https://example.com/blog/2026/01/a.html', 'https://example.com/blog/2026/01/c.html'],
  )
  assert.deepEqual(selectBackfillCandidates({ links, filter, knownLinks, limit: 0 }), [])
  assert.deepEqual(selectBackfillCandidates({ links, filter, knownLinks, limit: 10 }), [
    'https://example.com/blog/2026/01/a.html',
    'https://example.com/blog/2026/01/c.html',
    'https://example.com/blog/2026/01/e.html',
  ])
})

test('A1 阮一峰 archives.html：51 链接 → 形态命中 20 → 同文键去掉 3 条已在 feed ⇒ 17 个候选', () => {
  const links = extractArchiveLinks(fixture('ryf-archives.html'), RYF_ARCHIVES_URL)
  const filter = deriveLinkFilter(entryLinks(fixture('ryf-atom.xml')))
  assert.ok(filter)
  const knownLinks = entryLinks(fixture('ryf-atom.xml'))

  assert.equal(links.length, 51)
  assert.equal(links.filter(filter).length, 20)

  const candidates = selectBackfillCandidates({ links, filter, knownLinks, limit: 50 })
  assert.equal(candidates.length, 17)
  // 归档页最新的 3 篇已在 feed 里（http 链接），不许再抓一遍
  for (const known of knownLinks) {
    assert.equal(candidates.includes(known.replace('http://', 'https://')), false, '已存在：' + known)
  }
  // 文档顺序：跳过已存在的 420/419/418 之后，第一条是 417
  assert.equal(candidates[0], 'https://www.ruanyifeng.com/blog/2026/10/weekly-issue-417.html')
  // 月份索引 / 分类页 / 导航 / 社交链接都不出现
  for (const nonArticle of [
    'https://www.ruanyifeng.com/blog/2026/11/',
    'https://www.ruanyifeng.com/blog/weekly/',
    'https://www.ruanyifeng.com/blog/',
    'http://weibo.com/ruanyf',
    'https://twitter.com/ruanyf',
    'https://www.ruanyifeng.com/feed.html?utm_source=',
  ]) {
    assert.equal(candidates.includes(nonArticle), false, '非文章：' + nonArticle)
  }
})

test('阮一峰月份页 /blog/2020/01/：23 链接 → 形态命中 8 ⇒ 8 个候选（这页的文章都不在 atom 窗口里）', () => {
  const links = extractArchiveLinks(fixture('ryf-month.html'), RYF_MONTH_URL)
  const filter = deriveLinkFilter(entryLinks(fixture('ryf-atom.xml')))
  assert.ok(filter)
  const knownLinks = entryLinks(fixture('ryf-atom.xml'))

  assert.equal(links.length, 23)
  assert.equal(links.filter(filter).length, 8)
  const candidates = selectBackfillCandidates({ links, filter, knownLinks, limit: 20 })
  assert.equal(candidates.length, 8)
  // 上下月索引与导航都不是文章
  for (const nonArticle of [
    'https://www.ruanyifeng.com/blog/2019/12/',
    'https://www.ruanyifeng.com/blog/2020/02/',
    'https://www.ruanyifeng.com/blog/weekly/',
    'https://www.ruanyifeng.com/blog/',
  ]) {
    assert.equal(candidates.includes(nonArticle), false, '非文章：' + nonArticle)
  }
})

test('A2 云风月份页：6 链接 → 形态命中 3 → 同文键去掉 2 条已在 feed ⇒ 1 个新候选（月份索引被滤掉）', () => {
  const links = extractArchiveLinks(fixture('yf-month.html'), YF_MONTH_URL)
  const filter = deriveLinkFilter(entryLinks(fixture('probe-feed.xml')))
  assert.ok(filter)
  const knownLinks = entryLinks(fixture('probe-feed.xml'))

  assert.equal(links.length, 6)
  assert.equal(links.filter(filter).length, 3)

  const candidates = selectBackfillCandidates({ links, filter, knownLinks, limit: 20 })
  assert.deepEqual(candidates, ['https://blog.codingnow.com/2026/01/ai_game_design.html'])
  // 月份索引 / 首页不是文章
  for (const nonArticle of [
    'https://blog.codingnow.com/',
    'https://blog.codingnow.com/2026/09/',
    'https://blog.codingnow.com/2026/11/',
  ]) {
    assert.equal(candidates.includes(nonArticle), false, '非文章：' + nonArticle)
  }
  // 本月两篇已在 atom 里（15 条样本内）
  assert.equal(candidates.includes('https://blog.codingnow.com/2026/10/qwerty.html'), false)
  assert.equal(candidates.includes('https://blog.codingnow.com/2026/10/dotage.html'), false)
})

/* ==================== 同文键：与 link_key 只差协议 ==================== */

test('A4 同文键：http/https、锚点、utm 四种写法判同一篇；路径大小写不同判两篇', () => {
  const same = [
    'http://example.com/a/',
    'https://example.com/a',
    'https://example.com/a#top',
    'https://example.com/a?utm_source=z',
  ]
  for (const link of same) {
    assert.equal(sameArticleKeyOf(link), 'example.com/a', link)
  }
  assert.notEqual(sameArticleKeyOf('https://example.com/A'), sameArticleKeyOf('https://example.com/a'))

  // 不参与判定的输入同样给空串（与 linkKeyOf 一致）
  for (const bad of ['', '   ', 'javascript:alert(1)', 'mailto:x@example.com', 'not a url', '/relative']) {
    assert.equal(sameArticleKeyOf(bad), '', JSON.stringify(bad))
  }
})

test('sameArticleKeyOf 由 linkKeyOf 派生：两者只在协议前缀上不同（改归一化规则时一起变）', () => {
  const samples = [
    'https://example.com/a/',
    'http://example.com/a?b=1&a=2&utm_medium=x',
    'https://EXAMPLE.com:443/a#x',
    'https://example.com/A',
    'https://www.example.com/a',
    '',
    'not a url',
  ]
  for (const link of samples) {
    const key = linkKeyOf(link)
    const withoutProtocol = key === '' ? '' : key.slice(key.indexOf('://') + 3)
    assert.equal(sameArticleKeyOf(link), withoutProtocol, link)
  }
})

/* ==================== 日期：五级来源，只有年月不补日 ==================== */

test('A5 日期：abbr.published / 可见中文 / 可见英文都得真实 ISO；只有年月的 URL 不产生日期', () => {
  // 阮一峰真页摘录：title="2020-01-31T11:07:04+08:00" ⇒ UTC 03:07:04
  assert.equal(
    articleDateOf(fixture('dates/ruanyf-abbr.html'), 'https://www.ruanyifeng.com/blog/2020/01/weekly-issue-92.html'),
    '2020-01-31T03:07:04.000Z',
  )
  // 可见中文「日期：2020年1月3日」：日粒度 ⇒ 当天 00:00 +08:00
  assert.equal(
    articleDateOf(fixture('dates/visible-zh.html'), 'https://example.com/posts/hello.html'),
    '2020-01-02T16:00:00.000Z',
  )
  // 可见英文「提交于 October 11, 2026 07:30 PM」：19:30 +08:00 ⇒ UTC 11:30
  assert.equal(
    articleDateOf(fixture('dates/visible-en.html'), 'https://blog.codingnow.com/2026/10/dotage.html'),
    '2026-10-11T11:30:00.000Z',
  )
  // 只有年月：URL 是月份页、可见文本也只有年月 ⇒ 不补 01
  assert.equal(
    articleDateOf(fixture('dates/month-only.html'), 'https://www.ruanyifeng.com/blog/2020/01/'),
    undefined,
  )
})

test('articleDateOf：五级来源按 time → abbr.published → meta → 可见文本 → URL 的顺序取第一个', () => {
  const url = 'https://example.com/2020/05/06/post.html'
  const time = '<time datetime="2026-11-20T07:55:47Z">x</time>'
  const abbr = '<abbr class="published" title="2021-02-03T04:05:06+08:00">x</abbr>'
  const meta = '<meta property="article:published_time" content="2022-03-04T05:06:07Z">'
  const visible = '<p>日期：2023年7月8日</p>'

  // 单独一级时各自都能作答（第五级 URL 只在前四级都没有时才用）
  assert.equal(articleDateOf(time, url), '2026-11-20T07:55:47.000Z')
  assert.equal(articleDateOf(abbr, url), '2021-02-02T20:05:06.000Z')
  assert.equal(articleDateOf(meta, url), '2022-03-04T05:06:07.000Z')
  assert.equal(articleDateOf(visible, url), '2023-07-07T16:00:00.000Z')
  assert.equal(articleDateOf('<p>没有日期标记</p>', url), '2020-05-05T16:00:00.000Z')

  // 多层同时存在：更靠前的来源赢
  assert.equal(articleDateOf(time + abbr + meta + visible, url), '2026-11-20T07:55:47.000Z')
  assert.equal(articleDateOf(abbr + meta + visible, url), '2021-02-02T20:05:06.000Z')
  assert.equal(articleDateOf(meta + visible, url), '2022-03-04T05:06:07.000Z')
  assert.equal(articleDateOf(visible, url), '2023-07-07T16:00:00.000Z')

  // 「可见文本」只认读者看得见的部分：script / 注释里的日期不算
  assert.equal(
    articleDateOf('<script>var s = "date: 1999-01-01"</script><!-- 日期：1998年2月3日 -->' + visible, url),
    '2023-07-07T16:00:00.000Z',
  )
})

test('articleDateOf：带时区归一成 UTC；无时区按 +08:00；日粒度按当天 00:00；日历校验不滚动', () => {
  const time = (datetime) => articleDateOf('<time datetime="' + datetime + '">x</time>', 'https://example.com/a.html')
  assert.equal(time('2026-10-11T19:30:36+08:00'), '2026-10-11T11:30:36.000Z')
  assert.equal(time('2026-10-11T19:30:36Z'), '2026-10-11T19:30:36.000Z')
  // 无时区：按 +08:00 解释（spec §11 D10）
  assert.equal(time('2026-10-11T19:30:36'), '2026-10-11T11:30:36.000Z')
  assert.equal(time('2026-10-11'), '2026-10-10T16:00:00.000Z')

  // 日历校验：2020-02-31 不许被 Date 滚到 3 月，直接认不出
  assert.equal(time('2020-02-31T00:00:00+08:00'), undefined)
  assert.equal(time('2020-02-30'), undefined)
  assert.equal(time('2021-02-29'), undefined)
  // 闰年 2 月 29 是真实存在的一天
  assert.equal(time('2020-02-29'), '2020-02-28T16:00:00.000Z')
  // 月份 / 日 / 时分越界同样认不出
  assert.equal(time('2020-13-01'), undefined)
  assert.equal(time('2020-01-01T24:00:00'), undefined)
})

test('articleDateOf：认不出就返回 undefined（不用抓取时间、不猜正文里的孤立日期）', () => {
  assert.equal(articleDateOf('<html><body><p>没有日期</p></body></html>', 'https://example.com/post.html'), undefined)
  // 正文里出现的日期没有「日期词」引路，不算发布日期
  assert.equal(articleDateOf('<p>那一年是 2020年1月3日，他刚开始写作。</p>', 'https://example.com/post.html'), undefined)
  // URL 只有年月（没有日）
  assert.equal(articleDateOf('<p>无</p>', 'https://example.com/2020/01/'), undefined)
  // URL 里的日期不完整（只有日与月之外的碎数字）
  assert.equal(articleDateOf('<p>无</p>', 'https://example.com/2020/1/post.html'), undefined)
})

test('articleDateOf：meta 的三种写法（property / name=date / itemprop=datePublished）都认', () => {
  const expected = '2026-10-11T11:30:36.000Z'
  for (const meta of [
    '<meta property="article:published_time" content="2026-10-11T19:30:36+08:00">',
    '<meta name="date" content="2026-10-11T19:30:36+08:00">',
    '<meta itemprop="datePublished" content="2026-10-11T19:30:36+08:00" />',
  ]) {
    assert.equal(articleDateOf(meta, 'https://example.com/a.html'), expected, meta)
  }
})
