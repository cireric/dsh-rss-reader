/**
 * 抓取层边界测试：条件请求、超时、体积上限、编码。
 * 全部对着本地 HTTP 服务器打——不依赖外网，因此可以进 CI。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { fetchFeed, decodeXmlBody } from '../lib/feed/fetch.js'

const LIMITS = { timeoutMs: 2000, maxBytes: 1_000_000 }

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
    const result = await fetchFeed(base + '/feed.xml', {}, { timeoutMs: 80, maxBytes: 1024 })
    assert.equal(result.kind, 'failed')
    assert.match(result.reason, /超时/)
  })
})

test('响应超过体积上限即中止，不整份读进内存', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/xml' })
    res.end('x'.repeat(200_000))
  }, async (base) => {
    const result = await fetchFeed(base + '/feed.xml', {}, { timeoutMs: 2000, maxBytes: 4096 })
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
