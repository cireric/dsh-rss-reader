/**
 * 记录重建原语的单测（2026-10-07 随「三处手写重建收敛成一个」加）。
 *
 * 为什么值得单独测：它承担「按 schema 字段表搬运」这件事，一旦字段表漏项或 omit 逻辑写错，
 * 表现是**静默丢字段**——而 store 层看不出、界面上也看不出。原先三份手写拷贝里就有一份栽了：
 * unmarkRead 那份参数类型只声明 7 个字段，于是撤销「全部已读」时把 article 缓存一起丢掉了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rebuildItem } from '../lib/domain.js'

const ITEM = {
  feedId: 'https://ex.test/feed',
  title: '标题',
  link: 'https://ex.test/a',
  publishedAt: '2024-01-01T00:00:00.000Z',
  summary: '摘要',
  fetchedAt: '2024-01-02T00:00:00.000Z',
  readAt: '2024-06-01T00:00:00.000Z',
  starred: true,
  article: { fetchedAt: '2024-06-02T00:00:00.000Z', revision: 1, blocks: [{ kind: 'p', text: '正文' }] },
  articleFailure: '旧的失败原因',
}

test('rebuildItem：omit 只去掉点名的那一个，其余原样保留', () => {
  const next = rebuildItem(ITEM, { omit: ['readAt'] })
  assert.equal(next.readAt, undefined)
  assert.equal(next.starred, true)
  assert.deepEqual(next.article, ITEM.article, 'article 缓存不该被动 —— unmarkRead 就是栽在这里')
  assert.equal(next.articleFailure, '旧的失败原因')
})

test('rebuildItem：set 覆盖新值，并可同时 omit 掉要清掉的字段', () => {
  const next = rebuildItem(ITEM, {
    omit: ['articleFailure'],
    set: { article: { fetchedAt: '2024-07-01T00:00:00.000Z', revision: 2 } },
  })
  assert.equal(next.articleFailure, undefined, '成功取到正文后旧的失败原因要被清掉')
  assert.equal(next.article.revision, 2)
  assert.equal(next.readAt, ITEM.readAt, '没点名的字段照旧保留')
})

test('rebuildItem：可选字段缺省时不落 undefined 键（.strict() 下要干净）', () => {
  const bare = { feedId: 'f', title: 't', link: 'l', fetchedAt: '2024-01-01T00:00:00.000Z', starred: false }
  const next = rebuildItem(bare)
  assert.deepEqual(Object.keys(next).sort(), ['feedId', 'fetchedAt', 'link', 'starred', 'title'])
  assert.ok(!('publishedAt' in next), '缺省的 publishedAt 不该以 undefined 的形式落键')
})

test('rebuildItem：字段表覆盖了输入的每个已定义字段（防「手抄字段表」回归）', () => {
  const next = rebuildItem(ITEM)
  for (const [key, value] of Object.entries(ITEM)) {
    if (value === undefined) continue
    assert.deepEqual(next[key], value, '字段 ' + key + ' 没被搬运 —— 字段表可能漏了它')
  }
})
