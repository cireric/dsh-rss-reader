/**
 * 抓取层边界测试：条件请求、超时、体积上限、编码。
 * 全部对着本地 HTTP 服务器打——不依赖外网，因此可以进 CI。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { blockedReason, resolvedBlockedReason, fetchFeed, decodeXmlBody } from '../lib/feed/fetch.js'

// allowPrivateHosts 只给测试用：桩服务器都在 127.0.0.1，而生产默认是拒绝内网地址
const LIMITS = { timeoutMs: 2000, maxBytes: 1_000_000, trustedTarget: true }

async function withServer(handler, run) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    return await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('200 存下 ETag/Last-Modified，再次抓取命中 304', async () => {
  let hits = 0
  await withServer((req, res) => {
    hits += 1
    if (req.headers['if-none-match'] === '"v1"') {
      res.writeHead(304)
      res.end()
      return
    }
    res.writeHead(200, {
      'content-type': 'application/rss+xml',
      etag: '"v1"',
      'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
    })
    res.end('<rss version="2.0"><channel><title>t</title></channel></rss>')
  }, async (base) => {
    const first = await fetchFeed(base + '/feed.xml', {}, LIMITS)
    assert.equal(first.kind, 'ok')
    assert.equal(first.etag, '"v1"')
    assert.equal(first.lastModified, 'Wed, 01 Jan 2025 00:00:00 GMT')
    assert.match(first.body, /<rss/)

    const second = await fetchFeed(base + '/feed.xml', { etag: first.etag, lastModified: first.lastModified }, LIMITS)
    assert.equal(second.kind, 'not-modified', '带缓存凭据重抓必须走 304，不得发全量重抓')
    assert.equal(hits, 2)
  })
})

test('非 2xx 就地判失败，只影响这一个源', async () => {
  await withServer((_req, res) => {
    res.writeHead(500)
    res.end('boom')
  }, async (base) => {
    const result = await fetchFeed(base + '/feed.xml', {}, LIMITS)
    assert.equal(result.kind, 'failed')
    assert.match(result.reason, /500/)
  })
})

test('超时判失败，不挂死刷新', async () => {
  await withServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200)
      res.end('late')
    }, 500)
  }, async (base) => {
    const result = await fetchFeed(base + '/feed.xml', {}, { timeoutMs: 80, maxBytes: 1024, trustedTarget: true })
    assert.equal(result.kind, 'failed')
    assert.match(result.reason, /超时/)
  })
})

test('响应超过体积上限即中止，不整份读进内存', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/xml' })
    res.end('x'.repeat(200_000))
  }, async (base) => {
    const result = await fetchFeed(base + '/feed.xml', {}, { timeoutMs: 2000, maxBytes: 4096, trustedTarget: true })
    assert.equal(result.kind, 'failed')
    assert.match(result.reason, /体积上限/)
  })
})

test('GBK 声明按声明解码，中文不乱码', () => {
  const bytes = Buffer.concat([
    Buffer.from('<?xml version="1.0" encoding="gbk"?><rss><channel><title>'),
    Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), // "中文" 的 GBK 字节
    Buffer.from('</title></channel></rss>'),
  ])
  assert.match(decodeXmlBody(new Uint8Array(bytes)), /<title>中文<\/title>/)
})

test('UTF-8 BOM 被剥掉', () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<rss/>')])
  assert.equal(decodeXmlBody(new Uint8Array(bytes)), '<rss/>')
})

test('出网策略：内网地址一律拒绝——哪怕那里真有服务在听', async () => {
  await withServer((_req, res) => { res.writeHead(200); res.end('<rss/>') }, async (base) => {
    // 不带 allowPrivateHosts（= 生产默认）：桩服务器确实在 127.0.0.1 上监听，也必须被拒
    const result = await fetchFeed(base + '/feed.xml', {}, { timeoutMs: 2000, maxBytes: 1000 })
    assert.equal(result.kind, 'failed')
    assert.match(result.reason, /内网地址/)
  })
})

test('出网策略：协议与内网段的判定', () => {
  const blocked = (u) => blockedReason(u) !== undefined
  assert.ok(blocked('file:///etc/hosts'))
  assert.ok(blocked('data:text/html,<h1>x</h1>'))
  assert.ok(blocked('gopher://example.com/'))
  assert.ok(blocked('http://127.0.0.1:3080/'))
  assert.ok(blocked('http://localhost/feed'))
  assert.ok(blocked('http://10.0.0.5/feed'))
  assert.ok(blocked('http://172.16.3.4/feed'))
  assert.ok(blocked('http://192.168.1.1/feed'))
  assert.ok(blocked('http://169.254.169.254/latest/meta-data/'))
  assert.ok(blocked('http://[::1]/feed'))
  assert.ok(blocked('http://[::ffff:127.0.0.1]/feed'))
  assert.ok(blocked('http://nas.local/feed'))
  // 怪写法的 IPv4 不用单独处理：WHATWG URL 先把它归一成点分四段
  assert.ok(blocked('http://2130706433/feed'))
  assert.ok(!blocked('http://example.com/feed'))
  assert.ok(!blocked('https://example.com:8443/feed'))
  assert.equal(blockedReason('http://127.0.0.1/feed', true), undefined, '测试开关打开后放行')
})

test('出网策略：重定向到非 http(s) 被拒（每一跳都复核）', async () => {
  await withServer((_req, res) => { res.writeHead(302, { location: 'data:text/html,<h1>x</h1>' }); res.end() }, async (base) => {
    const result = await fetchFeed(base + '/feed.xml', {}, { timeoutMs: 2000, maxBytes: 1000, trustedTarget: true })
    assert.equal(result.kind, 'failed')
    assert.match(result.reason, /重定向被拒/)
  })
})

test('出网策略：重定向的目标一律按不可信处理（哪怕起始地址可信）', async () => {
  // 起始地址可以是用户配置的可信目标（trustedTarget），但**重定向目标不接受这个信任**：它由响应
  // 内容决定，一个正常域名完全可以把我们 302 到 169.254.169.254。这里用本地桩复现：302 回自己
  // 也算内网，所以第一跳就该被拒。
  //
  // 注：跳数上限（5 跳）因此只能从**公网起点**触发——本地桩服务器都在 127.0.0.1，走不到那一步。
  // 那一段现在只有读代码这一层证据，不再有用例（如实记在这里，别以为它被测过）。
  await withServer((_req, res) => { res.writeHead(302, { location: '/loop' }); res.end() }, async (base) => {
    const result = await fetchFeed(base + '/feed.xml', {}, { timeoutMs: 2000, maxBytes: 1000, trustedTarget: true })
    assert.equal(result.kind, 'failed')
    assert.match(result.reason, /重定向被拒/, '重定向目标不该继承起始地址的可信度')
  })
})

test('出网策略：域名解析到内网地址也要拒（rebinding 的前置拦截）', async () => {
  const fakeLookup = async (host) => (host === 'evil.test' ? ['93.184.216.34', '169.254.169.254'] : ['93.184.216.34'])
  assert.match(String(await resolvedBlockedReason('http://evil.test/feed', false, fakeLookup)), /内网地址/)
  assert.equal(await resolvedBlockedReason('http://good.test/feed', false, fakeLookup), undefined,
    '解析到公网地址的不该被拦')

  // 解析失败按失败上报 —— 否则会走到 fetch 再报一个更含糊的错
  const boom = async () => { throw new Error('ENOTFOUND') }
  assert.match(String(await resolvedBlockedReason('http://nx.test/feed', false, boom)), /解析失败/)

  // 测试开关打开时整段跳过（桩服务器都在 127.0.0.1）
  assert.equal(await resolvedBlockedReason('http://evil.test/feed', true, fakeLookup), undefined)

  // 字面量地址不查 DNS：blockedReason 已经判过
  assert.match(String(await resolvedBlockedReason('http://169.254.169.254/latest/', false, fakeLookup)), /内网地址/)
})
