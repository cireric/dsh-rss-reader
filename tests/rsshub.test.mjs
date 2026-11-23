/**
 * R8a 02：RSSHub Radar 的纯规则引擎（零网络 / 零配置 / 零 DOM）。
 *
 * 为什么单独成模块：Radar 的价值全在「把页面 URL 翻成订阅地址」这条推导里，而它的输入是
 * 实例返回的规则 JSON（社区维护、形状固定但内容会漂）。把它写成纯函数，规则的正确性就能用
 * 静态样本钉死；03 票的接线只负责取数据和合并，不再重复这套推导。
 *
 * 样本取自公共实例 `/api/radar/rules/{domain}` 的**实测回包**（2026-11-23）：bilibili 的
 * `space` 桶、github `.` 桶里的 8 条（完整 23 条中与用例路径相关的部分，顺序未改）、36kr
 * 唯一那条缺参规则、bangumi.moe 的 `*` 目标、423down 的 `{.+}` 目标。用真样本而不是手捏形状，是为了让「94.4% 能拼出来」这个前提可复算。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bucketKeys, buildRoute, candidatesFromRules, domainCandidates, matchSource } from '../lib/rsshub.js'

test('域名候选：从最短后缀开始，2 段 → 3 段 → 全长', () => {
  assert.deepEqual(domainCandidates('space.bilibili.com'), ['bilibili.com', 'space.bilibili.com'])
  // 多段公共后缀（co.uk）会被当成一次多余的空查询 —— 这是不引公共后缀表换来的已知代价（spec §4.3）
  assert.deepEqual(domainCandidates('www.bbc.co.uk'), ['co.uk', 'bbc.co.uk', 'www.bbc.co.uk'])
})

test('域名候选：最多 4 个，超出按「最短优先」截断（注册域仍在其中）', () => {
  assert.deepEqual(domainCandidates('a.b.c.d.e.f'), ['e.f', 'd.e.f', 'c.d.e.f', 'b.c.d.e.f'])
})

test('域名候选：大小写与末尾点归一化，再拆后缀', () => {
  assert.deepEqual(domainCandidates('GitHub.COM.'), ['github.com'])
  assert.deepEqual(domainCandidates('Space.Bilibili.com.'), ['bilibili.com', 'space.bilibili.com'])
})

test('域名候选：IPv4 / IPv6 字面量原样返回单条，不按点拆', () => {
  assert.deepEqual(domainCandidates('192.168.1.1'), ['192.168.1.1'])
  assert.deepEqual(domainCandidates('[::1]'), ['[::1]'])
  assert.deepEqual(domainCandidates('[2001:db8::1]'), ['[2001:db8::1]'])
})

test('域名候选：单标签主机（localhost）没有可回退的后缀，原样一条', () => {
  assert.deepEqual(domainCandidates('localhost'), ['localhost'])
})

test('桶：前缀桶 → . → www，去重保序', () => {
  assert.deepEqual(bucketKeys('space.bilibili.com', 'bilibili.com'), ['space', '.', 'www'])
  // www 既是前缀又是回退桶：只试一次，且按前缀那次的位置在前
  assert.deepEqual(bucketKeys('www.bilibili.com', 'bilibili.com'), ['www', '.'])
})

test('桶：host 就是注册域时不出现空前缀桶', () => {
  assert.deepEqual(bucketKeys('36kr.com', '36kr.com'), ['.', 'www'])
})

test('桶：输入按同一套归一化比较（大小写 / 末尾点）', () => {
  assert.deepEqual(bucketKeys('Space.Bilibili.COM.', 'bilibili.com'), ['space', '.', 'www'])
})

test('桶：host 不是该域名的子域时没有前缀桶（只剩回退桶）', () => {
  assert.deepEqual(bucketKeys('evil.test', 'bilibili.com'), ['.', 'www'])
})

test('模板匹配：:name 吃一段并 decodeURIComponent', () => {
  assert.deepEqual(matchSource('/:uid', '/2'), { uid: '2' })
  assert.deepEqual(matchSource('/:user/:repo', '/DIYgod/RSSHub'), { user: 'DIYgod', repo: 'RSSHub' })
  assert.deepEqual(matchSource('/:user', '/DIYgod%20RSSHub'), { user: 'DIYgod RSSHub' })
  // 站点名里的中文按百分号编码进来，捕获值必须是解码后的原文（拼地址时再编码回去）
  assert.deepEqual(matchSource('/:user', '/%E5%93%94%E5%93%A9%E5%93%94%E5%93%A9'), { user: '哔哩哔哩' })
})

test('模板匹配：字面量不区分大小写，根路径 / 也能匹配', () => {
  assert.deepEqual(matchSource('/User/:id', '/user/42'), { id: '42' })
  assert.deepEqual(matchSource('/hot-list/:category', '/HOT-LIST/tech'), { category: 'tech' })
  assert.deepEqual(matchSource('/', '/'), {})
})

test('模板匹配：必须吃完整个 path，多一段少一段都不算', () => {
  assert.equal(matchSource('/user/:id', '/user/1/extra'), undefined)
  assert.equal(matchSource('/user/:id', '/user'), undefined)
  // 末尾斜杠是**多出来的一段空段**：模板没写就不匹配（归一化在 candidatesFromRules 里做，见那里的注释）
  assert.equal(matchSource('/:user/:repo', '/DIYgod/RSSHub/'), undefined)
})

test('模板匹配：非法百分号编码不抛异常，整条判不匹配', () => {
  // 发现流程的输入是用户在地址栏里粘的东西，畸形编码不能让整个「发现候选」失败
  assert.equal(matchSource('/:id', '/%E0%A4%A'), undefined)
})

test('拼地址：:name 用捕获值填，捕获值一律 encodeURIComponent', () => {
  assert.equal(buildRoute('/bilibili/user/dynamic/:uid', { uid: '2' }), '/bilibili/user/dynamic/2')
  assert.equal(
    buildRoute('/github/branches/:user/:repo', { user: 'DIY god', repo: 'RSSHub' }),
    '/github/branches/DIY%20god/RSSHub',
  )
})

test('拼地址：任一必填参数缺失返回 undefined，不产出半成品', () => {
  assert.equal(buildRoute('/36kr/hot-list/:category', {}), undefined)
  assert.equal(buildRoute('/github/branches/:user/:repo', { user: 'DIYgod' }), undefined)
})

test('拼地址：target 含 * 或 {} 一律 undefined（通配与正则参数超出现有引擎）', () => {
  assert.equal(buildRoute('/bangumi.moe/*', {}), undefined)
  assert.equal(buildRoute('/423down/:category{.+}?', { category: 'tech' }), undefined)
})

test('拼地址：可选参数 :name? 缺了就整段省略，有值就填', () => {
  // 实测 github「User Repo」的 target 就是 /github/repos/:user/:type?/:sort?
  assert.equal(buildRoute('/github/repos/:user/:type?/:sort?', { user: 'DIYgod' }), '/github/repos/DIYgod')
  assert.equal(
    buildRoute('/github/repos/:user/:type?/:sort?', { user: 'DIYgod', type: 'stars' }),
    '/github/repos/DIYgod/stars',
  )
})

test('拼地址：返回值一定以 / 开头', () => {
  assert.equal(buildRoute('github/x/:a', { a: '1' }), '/github/x/1')
})

// ── 实例回包样本（实测，2026-11-23）────────────────────────────────────────
// 只保留与用例路径相关的条目，顺序与实例一致；`docs` 对本引擎无意义，省略。
const GITHUB = {
  _name: 'GitHub',
  '.': [
    { title: 'Repo Branches', source: ['/:user/:repo/branches', '/:user/:repo'], target: '/github/branches/:user/:repo' },
    { title: 'Repo Contributors', source: ['/:user/:repo/graphs/contributors', '/:user/:repo'], target: '/github/contributors/:user/:repo' },
    { title: 'File Commits', source: ['/:user/:repo/blob/:branch/*filepath'], target: '/github/file/:user/:repo/:branch/:filepath' },
    { title: 'Repository Event', source: ['/:owner/:repo'], target: '/github/repo_event/:owner/:repo' },
    { title: 'Repo Stars', source: ['/:user/:repo/stargazers', '/:user/:repo'], target: '/github/stars/:user/:repo' },
    { title: 'Repo Discussions', source: ['/:user/:repo/discussions', '/:user/:repo/discussions/:id', '/:user/:repo'], target: '/github/discussion/:user/:repo' },
    { title: 'Repo Issues', source: ['/:user/:repo/issues', '/:user/:repo/issues/:id', '/:user/:repo'], target: '/github/issue/:user/:repo' },
    { title: 'Repo Pull Requests', source: ['/:user/:repo/pulls', '/:user/:repo/pulls/:id', '/:user/:repo'], target: '/github/pull/:user/:repo' },
  ],
}

const BILIBILI = {
  _name: '哔哩哔哩 bilibili',
  show: [{ title: '会员购票务', source: ['/platform'], target: '/bilibili/platform/:area?/:p_type?/:uid?' }],
  space: [
    { title: 'UP 主图文', source: ['/:uid'], target: '/bilibili/user/article/:uid' },
    { title: 'UP 主投币视频', source: ['/:uid'], target: '/bilibili/user/coin/:uid' },
    { title: 'UP 主动态', source: ['/:uid'], target: '/bilibili/user/dynamic/:uid' },
    { title: 'UP 主粉丝', source: ['/:uid'], target: '/bilibili/user/followers/:uid' },
    { title: 'UP 主关注用户', source: ['/:uid'], target: '/bilibili/user/followings/:uid' },
    { title: 'UP 主点赞视频', source: ['/:uid'], target: '/bilibili/user/like/:uid' },
    { title: '用户追番列表', source: ['/:uid'], target: '/bilibili/user/bangumi/:uid' },
    { title: 'UP 主默认收藏夹', source: ['/:uid', '/:uid/favlist'], target: '/bilibili/user/fav/:uid' },
    { title: 'UP 主投稿', source: ['/:uid'], target: '/bilibili/user/video/:uid' },
  ],
  www: [
    { title: '热搜', source: ['/'], target: '/bilibili/hot-search' },
    { title: '排行榜', source: ['/v/popular/rank/:rid'], target: '/bilibili/ranking/:rid' },
  ],
}

test('候选：space 桶命中，按规则顺序产出并封顶 5 条', () => {
  const result = candidatesFromRules(BILIBILI, 'https://space.bilibili.com/2', 'https://hub.test', 'bilibili.com')
  assert.deepEqual(result.candidates.map((candidate) => candidate.url), [
    'https://hub.test/bilibili/user/article/2',
    'https://hub.test/bilibili/user/coin/2',
    'https://hub.test/bilibili/user/dynamic/2',
    'https://hub.test/bilibili/user/followers/2',
    'https://hub.test/bilibili/user/followings/2',
  ])
  // 03 票要拿这三个字段直接渲染：地址、规则名、站点名（第二行「站点名 · 未验证」）
  assert.equal(result.candidates[2].title, 'UP 主动态')
  assert.equal(result.candidates[0].siteName, '哔哩哔哩 bilibili')
  assert.equal(result.candidates[0].source, 'rsshub')
  assert.deepEqual(result.skipped, { missingParam: 0, wildcard: 0, regex: 0 })
})

test('候选：github 仓库页多命中，上限 5；limit 可调', () => {
  const url = 'https://github.com/DIYgod/RSSHub'
  const result = candidatesFromRules(GITHUB, url, 'https://hub.test/', 'github.com')
  assert.deepEqual(result.candidates.map((candidate) => candidate.url), [
    'https://hub.test/github/branches/DIYgod/RSSHub',
    'https://hub.test/github/contributors/DIYgod/RSSHub',
    'https://hub.test/github/repo_event/DIYgod/RSSHub',
    'https://hub.test/github/stars/DIYgod/RSSHub',
    'https://hub.test/github/discussion/DIYgod/RSSHub',
  ])
  assert.equal(candidatesFromRules(GITHUB, url, 'https://hub.test', 'github.com', 2).candidates.length, 2)
})

test('候选：同一地址只出现一次（不同规则拼出同一目标时保第一条）', () => {
  const rules = {
    _name: '示例站',
    '.': [
      { title: '甲', source: ['/:id'], target: '/site/feed/:id' },
      { title: '乙', source: ['/:id'], target: '/site/feed/:id' },
    ],
  }
  const result = candidatesFromRules(rules, 'https://example.com/7', 'https://hub.test', 'example.com')
  assert.deepEqual(result.candidates.map((candidate) => candidate.title), ['甲'])
})

test('候选：title 缺失时回落 _name（站点名）', () => {
  const rules = { _name: '无标题站', '.': [{ source: ['/'], target: '/site/latest' }] }
  const result = candidatesFromRules(rules, 'https://example.com/', 'https://hub.test', 'example.com')
  assert.equal(result.candidates[0].title, '无标题站')
})

test('候选：桶按 前缀 → . 的顺序遍历（www 桶的规则排在注册域桶前面）', () => {
  const rules = {
    _name: '示例站',
    '.': [{ title: '注册域', source: ['/'], target: '/site/root' }],
    www: [{ title: 'www', source: ['/'], target: '/site/www' }],
  }
  const result = candidatesFromRules(rules, 'https://www.example.com/', 'https://hub.test', 'example.com')
  assert.deepEqual(result.candidates.map((candidate) => candidate.title), ['www', '注册域'])
})

test('候选：末尾斜杠归一化（粘带 / 的地址不该一条都发现不了）', () => {
  const withSlash = candidatesFromRules(GITHUB, 'https://github.com/DIYgod/RSSHub/', 'https://hub.test', 'github.com')
  assert.equal(withSlash.candidates.length, 5)
  assert.equal(withSlash.candidates[0].url, 'https://hub.test/github/branches/DIYgod/RSSHub')
})

// ── 跳过原因（缺参 / 通配 / 正则）─────────────────────────────────────────
const KR36 = {
  _name: '36kr',
  '.': [{ title: '资讯热榜', source: ['/hot-list/:category', '/'], target: '/36kr/hot-list/:category' }],
}

test('36kr：唯一规则缺 :category，不产生候选且计 1 条缺参跳过（A6）', () => {
  const result = candidatesFromRules(KR36, 'https://36kr.com', 'https://hub.test', '36kr.com')
  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.skipped, { missingParam: 1, wildcard: 0, regex: 0 })
  // 反向前提：同一条规则在带分类的路径上是能拼出来的 —— 跳过是因为缺参，不是规则坏了
  const hit = candidatesFromRules(KR36, 'https://36kr.com/hot-list/tech', 'https://hub.test', '36kr.com')
  assert.deepEqual(hit.candidates.map((candidate) => candidate.url), ['https://hub.test/36kr/hot-list/tech'])
  assert.equal(hit.skipped.missingParam, 0)
})

test('通配：target 含 * 的规则跳过并计入 wildcard（bangumi.moe 实测样本）', () => {
  const rules = { _name: '萌番组', '.': [{ title: 'Latest', source: ['/'], target: '/bangumi.moe/*' }] }
  const result = candidatesFromRules(rules, 'https://bangumi.moe/', 'https://hub.test', 'bangumi.moe')
  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.skipped, { missingParam: 0, wildcard: 1, regex: 0 })
})

test('正则：target 含 {} 的规则跳过并计入 regex（423down 实测样本）', () => {
  const rules = {
    _name: '423Down',
    '.': [{ title: '423Down', source: ['/:category', '/'], target: '/423down/:category{.+}?' }],
  }
  const result = candidatesFromRules(rules, 'https://423down.com/', 'https://hub.test', '423down.com')
  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.skipped, { missingParam: 0, wildcard: 0, regex: 1 })
})

test('跳过只统计「命中了 source 但拼不出来」的规则，路径不匹配的规则不算', () => {
  const rules = {
    _name: '示例站',
    '.': [
      { title: '能拼', source: ['/post/:id'], target: '/site/post/:id' },
      { title: '缺参', source: ['/post/:id'], target: '/site/post/:id/:slug' },
      { title: '不匹配', source: ['/other/:id'], target: '/site/other/:id/:missing' },
    ],
  }
  const result = candidatesFromRules(rules, 'https://example.com/post/9', 'https://hub.test', 'example.com')
  assert.deepEqual(result.candidates.map((candidate) => candidate.url), ['https://hub.test/site/post/9'])
  assert.deepEqual(result.skipped, { missingParam: 1, wildcard: 0, regex: 0 })
})
