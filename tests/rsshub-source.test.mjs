/**
 * R15 02：RSSHub 订阅来源的识别判据（spec §4.1.3）。
 *
 * 这里钉住**唯一**的识别规则，且只有两条：
 *  ① 记录已有 `rsshub` 字段 ⇒ 是 RSSHub 源（不因实例被移出池而失效）；
 *  ② 否则 URL 的 origin 命中实例池 ⇒ 是，`instance` = 命中的那个实例；
 *  ③ 其余一律不是 —— **不许按路径猜**（普通站点也可能有 /github/... 这种路径）。
 *
 * 纯函数，不碰网络与文件；池子由调用方传进来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rsshubProvenanceOf, rsshubSourceOf } from '../lib/rsshub-source.js'

test('origin 命中实例池：返回 namespace 首段、pathname 原文与实际实例', () => {
  const url = 'https://hub.example/github/branches/DIYgod/RSSHub?tab=readme#top'
  assert.deepEqual(
    rsshubProvenanceOf(url, ['https://hub.example']),
    {
      namespace: 'github',
      // path 是**拼好的具体路径**（不是 /:namespace/:route 模板），查询与 fragment 不属于路径。
      path: '/github/branches/DIYgod/RSSHub',
      instance: 'https://hub.example',
    },
  )
})

test('origin 比较归一：末尾斜杠、大小写主机、默认端口都不影响识别', () => {
  // 池子来自 parseRsshubBase（URL.origin 形态），但手改 config.json 会留下末尾斜杠 / 大写主机。
  assert.deepEqual(
    rsshubProvenanceOf('https://hub.example/baoyu/blog', ['https://HUB.Example/']),
    { namespace: 'baoyu', path: '/baoyu/blog', instance: 'https://hub.example' },
  )
  assert.deepEqual(
    rsshubProvenanceOf('https://HUB.EXAMPLE:443/baoyu/blog', ['https://hub.example']),
    { namespace: 'baoyu', path: '/baoyu/blog', instance: 'https://hub.example' },
  )
  assert.equal(rsshubProvenanceOf('http://hub.example/baoyu/blog', ['https://hub.example']), undefined,
    '协议不同就不是同一个 origin')
})

test('只认 origin：路径长得像 RSSHub 路由但主机不在池里，一律不是', () => {
  assert.equal(
    rsshubProvenanceOf('https://site.example/github/branches/DIYgod/RSSHub', ['https://hub.example']),
    undefined,
    '普通站点的 /github/... 路径不能被当成 RSSHub（不按路径猜）',
  )
  assert.equal(rsshubProvenanceOf('https://hub.example/baoyu/blog', []), undefined, '空池 = 一律不识别')
})

test('实例源站本身（pathname 为 /）不是有效路由：认不出 namespace/path 就返回 undefined', () => {
  assert.equal(rsshubProvenanceOf('https://hub.example', ['https://hub.example']), undefined)
  assert.equal(rsshubProvenanceOf('https://hub.example/', ['https://hub.example']), undefined)
})

test('非法 URL 不抛错，按「认不出」处理', () => {
  assert.equal(rsshubProvenanceOf('not a url', ['https://hub.example']), undefined)
  assert.equal(rsshubProvenanceOf('file:///tmp/feed.xml', ['https://hub.example']), undefined)
})

test('rsshubSourceOf：已有字段优先于 origin 匹配（实例被移出池也仍是 RSSHub 源）', () => {
  const recorded = { namespace: 'baoyu', path: '/baoyu/blog', instance: 'https://old.example' }
  assert.deepEqual(
    rsshubSourceOf({ url: 'https://old.example/baoyu/blog', rsshub: recorded }, []),
    recorded,
    '字段是已经认过的历史事实：池子清空后不许退回「不是 RSSHub 源」',
  )
  assert.deepEqual(
    rsshubSourceOf({ url: 'https://hub.example/baoyu/blog' }, ['https://hub.example']),
    { namespace: 'baoyu', path: '/baoyu/blog', instance: 'https://hub.example' },
    '没有字段时按 origin 现算（老记录 baoyu/blog 的识别路径）',
  )
  assert.equal(
    rsshubSourceOf({ url: 'https://site.example/feed.xml' }, ['https://hub.example']),
    undefined,
    '非 RSSHub 源什么都不加',
  )
})
