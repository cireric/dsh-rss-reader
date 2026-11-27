/**
 * R8b 01：路由目录的投影、检索、游标与地址拼装（纯函数，零网络）。
 *
 * 夹具刻意让**站点级 categories 为空、路由级 categories 有值**：这是 D7 / B5 的判据。
 * 站点级分类只覆盖 206 个站，用它筛会让 2734 条有路由分类但没有站点分类的路由整片消失；
 * 夹具如果两边都放分类，这条缺陷就能在测试里隐身。
 *
 * 投影只读一次外部 JSON（实例返回，形状会漂），所以坏条目、字段裁剪与排序都在这里钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildExploreUrl,
  decodeCatalogCursor,
  encodeCatalogCursor,
  parsePathTemplate,
  prefillValues,
  projectCatalog,
} from '../lib/explore-catalog.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * R15 04 的真实实例快照（裁剪口径见 tests/fixtures/rsshub-catalog/README.md）。
 * 用真实回包而不是手写形状，是因为 `requireConfig` 的类型漂移正是「手写夹具没跟上实测」造成的：
 * 旧夹具把它写成布尔 `true`，投影的 `=== true` 判据才会看起来成立。
 */
function realSnapshot() {
  return JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'rsshub-catalog', 'rssforever-2026-11-27.json'), 'utf8'))
}

/** 一份带坏条目的原始回包：字段名照实例 `/api/namespace` 的实测形状（spec §1.1）。 */
function rawCatalog() {
  return {
    // 顺序刻意打乱：投影必须按 (namespace, path) 重排，不能靠对象键序。
    zhihu: {
      name: '知乎',
      url: 'https://www.zhihu.com',
      categories: [],
      description: '知乎',
      lang: 'zh',
      apiRoutes: { activities: { path: '/api/v4/members/:id/activities' } },
      routes: {
        activities: {
          path: '/zhihu/people/activities/:id',
          name: '用户动态',
          url: 'https://www.zhihu.com/people/:id',
          maintainers: ['someone'],
          example: undefined,
          parameters: {},
          description: '用户动态',
          categories: ['social'],
          features: {
            requireConfig: false,
            requirePuppeteer: false,
            antiCrawler: true,
            supportRadar: true,
            supportBT: false,
            supportPodcast: false,
            supportScihub: false,
          },
          radar: true,
          location: 'people',
        },
      },
    },
    github: {
      name: 'GitHub',
      url: 'https://github.com',
      // 站点级分类故意为空：B5 的多数路由正是这种情况。
      categories: [],
      description: 'GitHub',
      lang: 'en',
      apiRoutes: { branches: { path: '/api/branches' } },
      routes: {
        // 插入顺序也打乱：issues 在 branches 之前，但排序应按 path。
        issues: {
          path: '/github/issues/:user/:repo/:state?',
          name: '仓库 Issues',
          url: 'https://github.com/:user/:repo/issues',
          maintainers: ['a', 'b'],
          example: '/github/issues/DIYgod/RSSHub/open',
          parameters: { user: '用户名', repo: '仓库名', state: '状态' },
          description: 'Issue 列表',
          categories: ['programming'],
          features: {
            // 真实类型是 false | ConfigItem[]（spec §1.3）：这项曾经被写成布尔 true，
            // 投影照布尔读才「看起来能用」，实际实例上这个分支永远走不到。
            requireConfig: [{ name: 'GITHUB_TOKEN', optional: false }],
            requirePuppeteer: 'yes', // 非布尔 ⇒ 必须落成 false，不能原样透传
            antiCrawler: 0,
            supportRadar: false,
            supportBT: true,
            supportPodcast: true,
            supportScihub: false,
          },
          radar: false,
          location: 'repo',
        },
        branches: {
          path: '/github/branches/:user/:repo',
          name: '仓库分支',
          url: 'https://github.com/:user/:repo/branches',
          maintainers: ['c'],
          example: '/github/branches/DIYgod/RSSHub',
          parameters: { user: '用户名', repo: '仓库名' },
          description: '分支列表',
          categories: ['programming', 'github'],
          features: {
            requireConfig: false,
            requirePuppeteer: false,
            antiCrawler: false,
            supportRadar: false,
            supportBT: false,
            supportPodcast: false,
            supportScihub: false,
          },
          radar: false,
          location: 'repo',
        },
        // 坏路由：值不是对象 / path 不是字符串 / name 不是字符串 ⇒ 逐条跳过并计入 invalid
        nullRoute: null,
        numericPath: { path: 42, name: '坏路径' },
        missingName: { path: '/github/no-name/:id' },
      },
    },
    // 坏站点：值不是对象 / routes 不是对象 ⇒ 站点级跳过并计入 invalid
    notAnObject: 'oops',
    noRoutes: { name: '没有路由表', categories: ['x'] },
  }
}

test('projectCatalog：顶层不是对象 ⇒ 失败原因，不抛', () => {
  for (const raw of [null, undefined, 42, 'text', true, []]) {
    const result = projectCatalog(raw)
    assert.equal(result.ok, false, '顶层 ' + JSON.stringify(raw) + ' 必须失败')
    assert.equal(typeof result.reason, 'string')
    assert.notEqual(result.reason, '')
  }
})

test('projectCatalog：坏站点 / 坏路由逐条跳过，invalid 计数，整表仍可用（B20）', () => {
  const result = projectCatalog(rawCatalog())
  assert.equal(result.ok, true)
  // 坏条目：nullRoute / numericPath / missingName（路由级 3）+ notAnObject / noRoutes（站点级 2）
  assert.equal(result.invalid, 5)
  assert.equal(result.catalog.sites, 2, '只有两个可投影站点')
  assert.equal(result.catalog.total, 3, '只有三条可投影路由')
})

test('projectCatalog：站点 name 缺失 / 非字符串 / 空串 ⇒ 回落 namespace，路由照常展开（spec §4.2）', () => {
  // spec §4.2 的跳过清单只有形状非法（站点值不是对象 / routes 不是对象 / 路由值不是对象 /
  // path 不是字符串）：「站点名缺失」不在其中。名字只影响展示，用实例自己的键（namespace）
  // 回落；为了一个展示名丢掉整站路由，等于把一条无关紧要的字段漂移放大成整站消失。
  for (const name of [undefined, '', 42, null]) {
    const raw = {
      anon: {
        ...(name === undefined ? {} : { name }),
        routes: { only: { path: '/anon/only/:id', name: '匿名站路由' } },
      },
    }
    const result = projectCatalog(raw)
    assert.equal(result.ok, true)
    assert.equal(result.invalid, 0, 'name=' + String(name) + ' 不是坏条目，invalid 不许增加')
    assert.equal(result.catalog.sites, 1, 'name=' + String(name) + ' 时站点照常计数')
    assert.equal(result.catalog.total, 1, 'name=' + String(name) + ' 时路由照常展开')
    assert.equal(result.catalog.rows[0].siteName, 'anon', 'siteName 必须回落成 namespace')
  }

  // 只有 routes 不是对象才是站点级形状非法：没有路由表就无从展开，照旧跳过并计数。
  const dropped = projectCatalog({ broken: { name: '有名字' } })
  assert.equal(dropped.ok, true)
  assert.equal(dropped.invalid, 1)
  assert.equal(dropped.catalog.sites, 0)
  assert.equal(dropped.catalog.total, 0)
})

test('projectCatalog：字段裁剪 —— description / location / maintainers / radar / apiRoutes 一律丢弃（D12）', () => {
  const result = projectCatalog(rawCatalog())
  assert.equal(result.ok, true)
  const branches = result.catalog.rows.find((row) => row.path === '/github/branches/:user/:repo')
  assert.deepEqual(branches, {
    namespace: 'github',
    siteName: 'GitHub',
    path: '/github/branches/:user/:repo',
    name: '仓库分支',
    categories: ['programming', 'github'],
    example: '/github/branches/DIYgod/RSSHub',
    parameters: { user: '用户名', repo: '仓库名' },
    features: { requireConfig: 'none', requirePuppeteer: false, antiCrawler: false, supportPodcast: false, nsfw: false },
  })
  const keys = Object.keys(branches).sort()
  assert.deepEqual(keys, [
    'categories', 'example', 'features', 'name', 'namespace', 'parameters', 'path', 'siteName',
  ], '行里只允许 wire 声明的八个字段')
})

test('projectCatalog：features 保留 requireConfig 三态与四个布尔，非布尔按 false（不原样透传）', () => {
  const result = projectCatalog(rawCatalog())
  assert.equal(result.ok, true)
  const issues = result.catalog.rows.find((row) => row.path === '/github/issues/:user/:repo/:state?')
  assert.deepEqual(issues.features, {
    requireConfig: 'required',
    requirePuppeteer: false,
    antiCrawler: false,
    supportPodcast: true,
    nsfw: false,
  })
})

test('projectCatalog：requireConfig 三态推导（false / 空数组 / 缺字段 ⇒ none，全可选 ⇒ optional，含必填 ⇒ required）', () => {
  const route = (path, requireConfig) => ({
    path,
    name: path,
    ...(requireConfig === undefined ? {} : { features: { requireConfig } }),
  })
  const raw = {
    shapes: {
      name: '形态样本',
      routes: {
        // 旧代码只认 `=== true`；真实实例从不发布尔 true，所以这个判据必须对下列形状全部翻红。
        legacyTrue: route('/legacy-true/:id', true),
        falseValue: route('/false/:id', false),
        emptyArray: route('/empty/:id', []),
        missing: route('/missing/:id', undefined),
        allOptional: route('/all-optional/:id', [{ name: 'A', optional: true }]),
        explicitRequired: route('/explicit-required/:id', [{ name: 'B', optional: false }]),
        implicitRequired: route('/implicit-required/:id', [{ name: 'C' }]),
        mixed: route('/mixed/:id', [{ name: 'D', optional: true }, { name: 'E' }]),
      },
    },
  }
  const result = projectCatalog(raw)
  assert.equal(result.ok, true)
  const states = Object.fromEntries(result.catalog.rows.map((row) => [row.path, row.features.requireConfig]))
  assert.deepEqual(states, {
    '/legacy-true/:id': 'none',
    '/false/:id': 'none',
    '/empty/:id': 'none',
    '/missing/:id': 'none',
    '/all-optional/:id': 'optional',
    '/explicit-required/:id': 'required',
    '/implicit-required/:id': 'required',
    '/mixed/:id': 'required',
  })
})

test('projectCatalog：nsfw 只认 === true，拼写漂移 nfsw 不映射', () => {
  const raw = {
    site: {
      name: '站点',
      routes: {
        yes: { path: '/yes/:id', name: '是', features: { nsfw: true } },
        no: { path: '/no/:id', name: '否', features: { nsfw: false } },
        missing: { path: '/missing/:id', name: '缺字段', features: {} },
        stringYes: { path: '/string-yes/:id', name: '字符串', features: { nsfw: 'true' } },
        drift: { path: '/drift/:id', name: '拼写漂移', features: { nfsw: true } },
      },
    },
  }
  const result = projectCatalog(raw)
  assert.equal(result.ok, true)
  const flags = Object.fromEntries(result.catalog.rows.map((row) => [row.path, row.features.nsfw]))
  assert.deepEqual(flags, {
    '/yes/:id': true,
    '/no/:id': false,
    '/missing/:id': false,
    '/string-yes/:id': false,
    // 实例里真有一条把 nsfw 拼成 nfsw（spec §4.2.1）：认不出就不认，不能替实例猜。
    '/drift/:id': false,
  })
})

test('projectCatalog：真实实例快照夹具 —— requireConfig 三态与 nsfw / nfsw 事实', () => {
  const result = projectCatalog(realSnapshot())
  assert.equal(result.ok, true)
  assert.equal(result.invalid, 0, '快照里每条路由都必须是合法形状')
  const row = (path) => {
    const found = result.catalog.rows.find((item) => item.path === path)
    assert.ok(found !== undefined, path + ' 必须在快照里')
    return found
  }

  assert.equal(row('/branches/:user/:repo').features.requireConfig, 'none', 'false 是 none')
  assert.equal(row('/music/playlist/:id').features.requireConfig, 'optional', '全 optional:true 是 optional')
  assert.equal(row('/user/:id').features.requireConfig, 'required', '带 optional:false 是 required')
  assert.equal(row('/:category/:key').features.requireConfig, 'required', '可选项与必填项混排仍是 required')
  assert.equal(row('/:id?').features.nsfw, true, 'nsfw === true 必须保留')
  // 0xxx 的 features 只有 `nfsw: true`，没有 `nsfw`：拼写漂移不映射。
  assert.equal(row('/:filter?').features.nsfw, false, 'nfsw 不许被当成 nsfw')
})

test('projectCatalog：按 (namespace, path) 升序且冻结，顺序在缓存生命期内稳定', () => {
  const result = projectCatalog(rawCatalog())
  assert.equal(result.ok, true)
  const keys = result.catalog.rows.map((row) => row.namespace + ' ' + row.path)
  assert.deepEqual(keys, [
    'github /github/branches/:user/:repo',
    'github /github/issues/:user/:repo/:state?',
    'zhihu /zhihu/people/activities/:id',
  ])
  assert.ok(Object.isFrozen(result.catalog.rows), '行列表必须冻结')
  assert.ok(Object.isFrozen(result.catalog.rows[0]), '行本身也必须冻结')
  assert.ok(Object.isFrozen(result.catalog.rows[0].categories))
  assert.ok(Object.isFrozen(result.catalog.rows[0].parameters))
  assert.ok(Object.isFrozen(result.catalog.rows[0].features))
  // 两次投影得到同一顺序（不允许依赖对象键序的偶然值）
  const again = projectCatalog(rawCatalog())
  assert.deepEqual(
    again.catalog.rows.map((row) => row.namespace + ' ' + row.path),
    keys,
  )
})

test('projectCatalog：分类目录只收路由级 categories，去重升序（D7）', () => {
  const result = projectCatalog(rawCatalog())
  assert.equal(result.ok, true)
  assert.deepEqual(result.catalog.categories, ['github', 'programming', 'social'])
})

test('query：q 对站点名 OR 路由名 OR 路径模板，大小写不敏感（B3 / B4）', () => {
  const result = projectCatalog(rawCatalog())
  assert.equal(result.ok, true)
  const { catalog } = result

  // 站点名命中 ⇒ 该站全部路由都命中（D8：搜站点 = 看该站能订什么）
  const bySite = catalog.query({ q: 'GitHub' })
  assert.equal(bySite.matched, 2)
  assert.deepEqual(bySite.items.map((row) => row.name), ['仓库分支', '仓库 Issues'])

  // 站点名命中，但该名字不出现在任何路由名 / 路径里（知乎 vs /zhihu）：只能靠站点名命中
  assert.deepEqual(catalog.query({ q: '知乎' }).items.map((row) => row.path), ['/zhihu/people/activities/:id'])

  // 路由名命中（中文名）
  assert.deepEqual(catalog.query({ q: '用户动态' }).items.map((row) => row.path), ['/zhihu/people/activities/:id'])

  // 路径模板片段命中
  const byPath = catalog.query({ q: 'BRANCHES' })
  assert.deepEqual(byPath.items.map((row) => row.name), ['仓库分支'])

  assert.equal(catalog.query({ q: '不存在的关键词' }).matched, 0)
})

test('query：category 只看路由级 categories —— 夹具站点级分类为空（B5 / D7）', () => {
  const result = projectCatalog(rawCatalog())
  assert.equal(result.ok, true)
  const { catalog } = result
  const filtered = catalog.query({ category: 'programming' })
  assert.equal(filtered.matched, 2, '站点级 categories 为空时，按站点分类筛会得 0；命中 2 才证明看的是路由级')
  assert.ok(filtered.items.every((row) => row.categories.includes('programming')))
  assert.deepEqual(catalog.query({ category: 'github' }).items.map((row) => row.name), ['仓库分支'])
})

test('query：namespace 等值 = 站点钻取；三筛 AND 叠加（B6 / D9）', () => {
  const result = projectCatalog(rawCatalog())
  assert.equal(result.ok, true)
  const { catalog } = result
  assert.equal(catalog.query({ namespace: 'github' }).matched, 2)
  assert.equal(catalog.query({ namespace: 'zhihu' }).matched, 1)
  // 单筛都不为 0 的组合取交集
  assert.equal(catalog.query({ namespace: 'github', category: 'programming' }).matched, 2)
  assert.equal(catalog.query({ namespace: 'github', category: 'social' }).matched, 0)
  assert.equal(catalog.query({ q: 'issues', category: 'programming' }).matched, 1)
  assert.equal(catalog.query({ q: 'issues', category: 'social' }).matched, 0)
  // 空串 = 不生效
  assert.equal(catalog.query({ q: '', category: '', namespace: '' }).matched, 3)
  assert.equal(catalog.query({}).matched, 3)
  // 目录口径与筛选无关：query 不改 total / sites
  assert.equal(catalog.total, 3)
  assert.equal(catalog.sites, 2)
})


test('游标：编解码走 (namespace, path)，带 filter 栅栏前缀', () => {
  const filter = { q: 'github', category: 'programming' }
  const position = { namespace: 'github', path: '/github/branches/:user/:repo' }
  const raw = encodeCatalogCursor(filter, position)
  assert.match(raw, /^[A-Za-z0-9_-]+:/, '栅栏 = 哈希 + 冒号')
  assert.ok(raw.endsWith('github|/github/branches/:user/:repo'), '游标体是 <namespace>|<path>')
  assert.deepEqual(decodeCatalogCursor(raw, filter), position)
  // 同一条件的不同写法（大小写 / 空白）落在同一个栅栏上：它们筛选结果相同
  assert.deepEqual(decodeCatalogCursor(raw, { q: ' GitHub ', category: 'programming' }), position)
})

test('游标：q / category / namespace 任一变化 ⇒ 栅栏失配（B7）', () => {
  const position = { namespace: 'github', path: '/github/branches/:user/:repo' }
  const raw = encodeCatalogCursor({ q: 'github', category: 'programming', namespace: 'github' }, position)
  const same = { q: 'github', category: 'programming', namespace: 'github' }
  assert.deepEqual(decodeCatalogCursor(raw, same), position)
  assert.equal(decodeCatalogCursor(raw, { ...same, q: 'issues' }), undefined, '换 q 必须失配')
  assert.equal(decodeCatalogCursor(raw, { ...same, category: 'social' }), undefined, '换分类必须失配')
  assert.equal(decodeCatalogCursor(raw, { ...same, namespace: 'zhihu' }), undefined, '换站点钻取必须失配')
  assert.equal(decodeCatalogCursor(raw, {}), undefined, '去掉筛选同样失配')
})

test('游标：乱码 / 缺游标体 / 空 body 一律 undefined（B8，调用方当 bad-request）', () => {
  const filter = { q: 'x' }
  assert.equal(decodeCatalogCursor('', filter), undefined)
  assert.equal(decodeCatalogCursor('garbage', filter), undefined)
  assert.equal(decodeCatalogCursor('garbage:github|/x', filter), undefined)
  const fenceOnly = encodeCatalogCursor(filter, { namespace: 'github', path: '/x' }).split(':')[0] + ':'
  assert.equal(decodeCatalogCursor(fenceOnly, filter), undefined, '只有栅栏没有游标体')
  assert.equal(decodeCatalogCursor(fenceOnly + 'github|', filter), undefined, '缺 path')
  assert.equal(decodeCatalogCursor(fenceOnly + '|/x', filter), undefined, '缺 namespace')
  assert.equal(decodeCatalogCursor(fenceOnly + ' github|/x', filter), undefined, '两端空白说明被改过')
})

test('游标：按第一个 | 切 —— path 里出现 | 不改写 namespace', () => {
  const filter = {}
  const position = { namespace: 'github', path: '/github/a|b/:id' }
  const raw = encodeCatalogCursor(filter, position)
  assert.deepEqual(decodeCatalogCursor(raw, filter), position)
})


test('parsePathTemplate：四种参数语法 + 字面量段', () => {
  assert.deepEqual(parsePathTemplate('/branches/:user/:repo').segments, [
    { kind: 'literal', value: 'branches' },
    { kind: 'param', name: 'user', optional: false, greedy: false },
    { kind: 'param', name: 'repo', optional: false, greedy: false },
  ])
  assert.deepEqual(parsePathTemplate('/issues/:state?').segments[1], {
    kind: 'param', name: 'state', optional: true, greedy: false,
  })
  // {.+} / {.*} 贪婪；?. 尾缀仍表示可选（实测 102 条 :name{.+}?）
  assert.deepEqual(parsePathTemplate('/file/:filepath{.+}').segments[1], {
    kind: 'param', name: 'filepath', optional: false, greedy: true,
  })
  assert.deepEqual(parsePathTemplate('/nav/:nav{.*}?').segments[1], {
    kind: 'param', name: 'nav', optional: true, greedy: true,
  })
  // 真正则 constraint 只当不透明标签：决定单段，不校验正则内容（D5）
  const realRegex = parsePathTemplate('/foo/:id{[0-9]{2}}/:slug{newbook.*}')
  assert.equal(realRegex.unsupported, false)
  assert.deepEqual(realRegex.segments[1], { kind: 'param', name: 'id', optional: false, greedy: false })
  assert.deepEqual(realRegex.segments[2], { kind: 'param', name: 'slug', optional: false, greedy: false })
})

test('parsePathTemplate：* / 残留花括号 / 畸形参数段 ⇒ unsupported，不猜', () => {
  for (const path of ['/foo/*', '/foo/:id{.+', '/foo/{bar}', '/foo/:', '/foo/:path{.+}/bar']) {
    assert.equal(parsePathTemplate(path).unsupported, true, path + ' 必须被判不可拼装')
  }
  assert.equal(parsePathTemplate('/foo/bar').unsupported, false)
})

test('prefillValues：example 按段对齐（example 带 namespace 前缀，path 不带）', () => {
  const branches = parsePathTemplate('/branches/:user/:repo')
  assert.deepEqual(prefillValues(branches, '/github/branches/DIYgod/RSSHub'), {
    user: 'DIYgod',
    repo: 'RSSHub',
  })
  // 显式给 namespace 时只按它剥前缀，不做启发式
  assert.deepEqual(prefillValues(branches, '/github/branches/DIYgod/RSSHub', 'github'), {
    user: 'DIYgod',
    repo: 'RSSHub',
  })
  // 显式 namespace 对不上 ⇒ 不剥，字面量对不上 ⇒ 不预填
  assert.deepEqual(prefillValues(branches, '/gitlab/branches/DIYgod/RSSHub', 'github'), {})
})

test('prefillValues：贪婪参数吃下剩余段，其余 constraint 只吃一段', () => {
  const file = parsePathTemplate('/file/:user/:repo/:branch/:filepath{.+}')
  assert.deepEqual(prefillValues(file, '/github/file/DIYgod/RSSHub/master/docs/README.md'), {
    user: 'DIYgod', repo: 'RSSHub', branch: 'master', filepath: 'docs/README.md',
  })
  const single = parsePathTemplate('/foo/:id{[0-9]{2}}')
  assert.deepEqual(prefillValues(single, '/ns/foo/42'), { id: '42' })
})

test('prefillValues：段数对不上 / example 缺失 / 字面量不符 / 解码失败 ⇒ 空对象，不猜', () => {
  const branches = parsePathTemplate('/branches/:user/:repo')
  assert.deepEqual(prefillValues(branches, undefined), {})
  assert.deepEqual(prefillValues(branches, ''), {})
  assert.deepEqual(prefillValues(branches, '/github/branches/DIYgod'), {}, '段数少了')
  assert.deepEqual(prefillValues(branches, '/github/branches/DIYgod/RSSHub/extra'), {}, '段数多了')
  assert.deepEqual(prefillValues(branches, '/github/labels/DIYgod/RSSHub'), {}, '字面量不符')
  assert.deepEqual(prefillValues(branches, '/github/branches/%E0%A4%A/RSSHub'), {}, '坏百分号编码')
  assert.deepEqual(prefillValues(parsePathTemplate('/foo/*'), '/foo/bar'), {}, '不可拼装的模板不预填')
})

test('prefillValues：对齐有歧义时返回空（两解都成立 = 猜）', () => {
  const greedy = parsePathTemplate('/:category{.+}?')
  // 既可能把 1lou 当 namespace，也可能当值本身 —— 不猜
  assert.deepEqual(prefillValues(greedy, '/1lou/forum-2-1'), {})
  // 显式 namespace 消歧
  assert.deepEqual(prefillValues(greedy, '/1lou/forum-2-1', '1lou'), { category: 'forum-2-1' })
  // 只有一个解时照常预填（abc 的官方 example 就不带 namespace 前缀）
  assert.deepEqual(prefillValues(greedy, '/wa'), { category: 'wa' })
})


test('buildExploreUrl：base + namespace + 填值后的相对 path，无 :param 残留', () => {
  const built = buildExploreUrl(
    'https://rsshub.example/',
    'github',
    '/branches/:user/:repo',
    { user: 'DIYgod', repo: 'RSSHub' },
  )
  assert.deepEqual(built, { kind: 'ok', url: 'https://rsshub.example/github/branches/DIYgod/RSSHub' })
  // base 末尾带不带 / 结果一致
  assert.deepEqual(
    buildExploreUrl('https://rsshub.example', 'github', '/branches/:user/:repo', { user: 'a', repo: 'b' }),
    { kind: 'ok', url: 'https://rsshub.example/github/branches/a/b' },
  )
  const pathPart = built.url.replace(/^https?:\/\//, '')
  assert.ok(!pathPart.includes(':'), '不许有 :param 残留')
})

test('buildExploreUrl：可选参数缺值 ⇒ 整段省略，不留空段 / undefined（B15）', () => {
  const withoutState = buildExploreUrl(
    'https://rsshub.example', 'github', '/issues/:user/:repo/:state?', { user: 'DIYgod', repo: 'RSSHub' },
  )
  assert.deepEqual(withoutState, { kind: 'ok', url: 'https://rsshub.example/github/issues/DIYgod/RSSHub' })
  assert.ok(!withoutState.url.replace(/^https?:\/\//, '').includes('//'), '不留空段')
  assert.ok(!withoutState.url.includes('undefined'))
  assert.deepEqual(
    buildExploreUrl('https://rsshub.example', 'github', '/issues/:user/:repo/:state?', {
      user: 'DIYgod', repo: 'RSSHub', state: 'open',
    }),
    { kind: 'ok', url: 'https://rsshub.example/github/issues/DIYgod/RSSHub/open' },
  )
})

test('buildExploreUrl：必填缺失 ⇒ 分型失败并点名缺的参数（B14）', () => {
  assert.deepEqual(
    buildExploreUrl('https://rsshub.example', 'github', '/branches/:user/:repo', { user: 'DIYgod' }),
    { kind: 'missing', parameter: 'repo' },
  )
  assert.deepEqual(
    buildExploreUrl('https://rsshub.example', 'github', '/branches/:user/:repo', {}),
    { kind: 'missing', parameter: 'user' },
  )
  // 空串等同缺失：空值不是「合法的空参数」
  assert.deepEqual(
    buildExploreUrl('https://rsshub.example', 'github', '/branches/:user/:repo', { user: '', repo: 'x' }),
    { kind: 'missing', parameter: 'user' },
  )
})

test('buildExploreUrl：含 * / {} 的残留段 ⇒ unsupported，不猜', () => {
  for (const path of ['/foo/*', '/foo/:id{.+', '/foo/{bar}', '/foo/:', '/foo/:path{.+}/bar']) {
    assert.deepEqual(buildExploreUrl('https://rsshub.example', 'ns', path, {}), { kind: 'unsupported' })
  }
  // 合法的 :name{.+} 不在此列：constraint 被认出并填值
  assert.deepEqual(
    buildExploreUrl('https://rsshub.example', 'github', '/file/:user/:repo/:branch/:filepath{.+}', {
      user: 'a', repo: 'b', branch: 'main', filepath: 'docs/README.md',
    }),
    { kind: 'ok', url: 'https://rsshub.example/github/file/a/b/main/docs/README.md' },
  )
})

test('buildExploreUrl：值 encodeURIComponent；贪婪参数保留段分隔，普通参数不越段', () => {
  assert.deepEqual(
    buildExploreUrl('https://rsshub.example', 'github', '/branches/:user/:repo', { user: 'a b', repo: 'a/b' }),
    { kind: 'ok', url: 'https://rsshub.example/github/branches/a%20b/a%2Fb' },
  )
  assert.deepEqual(
    buildExploreUrl('https://rsshub.example', 'github', '/file/:user/:repo/:branch/:filepath{.+}', {
      user: 'a', repo: 'b', branch: 'main', filepath: 'a b/c',
    }),
    { kind: 'ok', url: 'https://rsshub.example/github/file/a/b/main/a%20b/c' },
  )
})

test('buildExploreUrl：模板之外的 values 键忽略；全可选模板缺值只留 namespace', () => {
  assert.deepEqual(
    buildExploreUrl('https://rsshub.example', 'github', '/issues/:user/:repo/:state?', {
      user: 'a', repo: 'b', leftover: 'ignored',
    }),
    { kind: 'ok', url: 'https://rsshub.example/github/issues/a/b' },
  )
  assert.deepEqual(
    buildExploreUrl('https://rsshub.example', 'github', '/issues/:state?', {}),
    { kind: 'ok', url: 'https://rsshub.example/github/issues' },
  )
  // 可选贪婪参数缺值同样整段省略
  assert.deepEqual(
    buildExploreUrl('https://rsshub.example', 'ns', '/x/:path{.*}?', {}),
    { kind: 'ok', url: 'https://rsshub.example/ns/x' },
  )
})

// ── R15 06：NSFW 默认隐藏与「只看可跑」（A8 / A12）──────────────────────────

/**
 * 过滤夹具：五条路由恰好覆盖「可跑」四项条件的每一种反例。
 * 目录顺序（按 path）= /anti → /nsfw → /optional → /plain → /required。
 */
function filterCatalog() {
  const route = (path, features = {}) => ({
    path,
    name: path,
    features: { requireConfig: false, requirePuppeteer: false, antiCrawler: false, supportPodcast: false, nsfw: false, ...features },
  })
  return {
    f: {
      name: '过滤样本',
      routes: {
        anti: route('/anti', { antiCrawler: true }),
        nsfw: route('/nsfw', { nsfw: true }),
        optional: route('/optional', { requireConfig: [{ name: 'TOKEN', optional: true }] }),
        plain: route('/plain'),
        required: route('/required', { requireConfig: [{ name: 'TOKEN' }] }),
      },
    },
  }
}

/** 五条路由的周测全部通过：这样 remaining 差异只来自 features，而不是周测。 */
function filterWeeklyTests() {
  return new Map(['/f/anti', '/f/nsfw', '/f/optional', '/f/plain', '/f/required'].map((key) => [key, 'passed']))
}

test('query：hideNsfw 缺省 true —— nsfw 行不出现且不计入 matched；显式 false 才出现（A8）', () => {
  const result = projectCatalog(filterCatalog())
  assert.equal(result.ok, true)
  const { catalog } = result

  const hidden = catalog.query({})
  assert.equal(hidden.matched, 4, '默认隐藏：5 条里 nsfw 那条不计入命中')
  assert.equal(hidden.items.some((row) => row.features.nsfw), false, '默认隐藏：nsfw 行不许出现')

  const shown = catalog.query({ hideNsfw: false })
  assert.equal(shown.matched, 5, '开关打开后 matched 同步 +1（宿主侧过滤，不是客户端裁页）')
  assert.equal(shown.items.some((row) => row.path === '/nsfw'), true, '开关打开后 nsfw 行必须出现')
  assert.equal(catalog.total, 5, '目录口径不受筛选影响')
})

test('query：onlyRunnable = 周测通过 + 无反爬 + 无必填 + 非 nsfw 的交集（A12）', () => {
  const result = projectCatalog(filterCatalog())
  assert.equal(result.ok, true)
  const { catalog } = result
  const weekly = filterWeeklyTests()

  const runnable = catalog.query({ onlyRunnable: true }, weekly)
  assert.equal(runnable.matched, 2, '只有 plain / optional 四项全满足')
  assert.deepEqual(runnable.items.map((row) => row.path), ['/optional', '/plain'], 'optional 配置仍算可跑')

  // 逐项反例必须被排除——任何一项条件缺失都不能混进结果。
  const paths = new Set(runnable.items.map((row) => row.path))
  assert.equal(paths.has('/anti'), false, '反爬不算可跑')
  assert.equal(paths.has('/required'), false, '必填配置不算可跑')
  assert.equal(paths.has('/nsfw'), false, 'nsfw 不算可跑')
  assert.equal(paths.has('/optional'), true, '可选配置仍算可跑')

  // 打开 NSFW 不会让 nsfw 行混进「只看可跑」：非 nsfw 是硬条件之一。
  assert.equal(catalog.query({ onlyRunnable: true, hideNsfw: false }, weekly).matched, 2)

  // 没有周测数据 ⇒ 没有任何一条能证明「周测通过」，结果为空（诚实失败，不是降级成三条）。
  assert.equal(catalog.query({ onlyRunnable: true }).matched, 0, '无周测数据时不许把「未知」当「通过」')
})

test('游标：hideNsfw / onlyRunnable 进栅栏，条件变化即失配（A8 / A12 的分页侧）', () => {
  const position = { namespace: 'f', path: '/f/plain' }
  const raw = encodeCatalogCursor({ q: 'x' }, position)
  assert.deepEqual(decodeCatalogCursor(raw, { q: 'x' }), position, '同条件翻页正常')
  assert.equal(decodeCatalogCursor(raw, { q: 'x', hideNsfw: false }), undefined, '显示 NSFW 开关变化必须换游标')
  assert.equal(decodeCatalogCursor(raw, { q: 'x', onlyRunnable: true }), undefined, '只看可跑开关变化必须换游标')
})

test('游标：周测代次进入栅栏 —— 翻页中途周测刷新 ⇒ 旧游标失配，同一份周测翻页正常', () => {
  const position = { namespace: 'f', path: '/f/plain' }
  const filter = { hideNsfw: false, onlyRunnable: true }
  const weeklyA = new Map([['/f/plain', 'passed']])
  const weeklyB = new Map([['/f/plain', 'failed']])

  const raw = encodeCatalogCursor(filter, position, weeklyA)
  assert.deepEqual(decodeCatalogCursor(raw, filter, weeklyA), position, '同一份周测数据内翻页必须正常')
  assert.equal(decodeCatalogCursor(raw, filter, weeklyB), undefined, '周测换代后旧游标必须失配')
  assert.equal(decodeCatalogCursor(raw, filter), undefined, '周测从有到无也是换代')
  assert.deepEqual(decodeCatalogCursor(raw, filter, weeklyA), position, '代次标识必须稳定，不许每次调用都变')
})
