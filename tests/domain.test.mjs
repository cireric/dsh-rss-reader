/**
 * 记录重建原语的单测（2026-10-07 随「三处手写重建收敛成一个」加）。
 *
 * 为什么值得单独测：它承担「按 schema 字段表搬运」这件事，一旦字段表漏项或 omit 逻辑写错，
 * 表现是**静默丢字段**——而 store 层看不出、界面上也看不出。原先三份手写拷贝里就有一份栽了：
 * unmarkRead 那份参数类型只声明 7 个字段，于是撤销「全部已读」时把 article 缓存一起丢掉了。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { itemRecordSchema, normalizeLegacyArticle, rebuildItem } from '../lib/domain.js'
import { normalizeAuthor } from '../lib/author.js'

const ITEM = {
  feedId: 'https://ex.test/feed',
  title: '标题',
  link: 'https://ex.test/a',
  publishedAt: '2024-01-01T00:00:00.000Z',
  summary: '摘要',
  author: '张三',
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

test('normalizeLegacyArticle：老段落缓存折成结构化块，其余字段原样保留', () => {
  const legacy = { ...ITEM, article: { fetchedAt: '2024-06-02T00:00:00.000Z', revision: 1, title: '标题', frameable: true, paragraphs: ['第一段', '第二段'] } }
  const next = normalizeLegacyArticle(legacy)
  assert.notEqual(next, legacy, '有老数据时必须返回新对象 —— 调用方靠这个判断要不要写回')
  assert.deepEqual(next.article.blocks, [{ kind: 'p', text: '第一段' }, { kind: 'p', text: '第二段' }])
  assert.equal(next.article.paragraphs, undefined, '规范化之后不该再留 paragraphs')
  assert.equal(next.article.frameable, true, '可嵌性要继承下来')
  assert.equal(next.article.revision, 1, '内容版本要继承，否则会被判过期重抓')
  assert.equal(next.readAt, legacy.readAt, '已读态不许被动')
  assert.equal(next.starred, legacy.starred)
})

test('normalizeLegacyArticle：空的老段落等于没有缓存，整份丢掉 article', () => {
  const legacy = { ...ITEM, article: { fetchedAt: '2024-06-02T00:00:00.000Z', paragraphs: [] } }
  const next = normalizeLegacyArticle(legacy)
  assert.equal(next.article, undefined, '空缓存没有保留价值，丢掉让用户下次打开重抓')
  assert.equal(next.readAt, legacy.readAt)
})

test('normalizeLegacyArticle：已是新形态就返回同一个对象（幂等，可反复跑全表）', () => {
  const modern = { ...ITEM, article: { fetchedAt: '2024-06-02T00:00:00.000Z', revision: 2, blocks: [{ kind: 'p', text: '正文' }] } }
  assert.equal(normalizeLegacyArticle(modern), modern, '必须是同一个引用 —— 否则每次打开都会写全表')
})

test('normalizeLegacyArticle：没有正文缓存的记录不受影响', () => {
  const bare = { ...ITEM, article: undefined }
  assert.equal(normalizeLegacyArticle(bare), bare)
})

/** R12 决策 3：作者归一化只有这一处实现（零依赖叶子，refresh / store 读侧 / 搜索 worker 共用）。 */
test('normalizeAuthor：trim 后为空 ⇒ undefined；有值则 trim 后原样保留（不剥邮箱、不改写）', () => {
  assert.equal(normalizeAuthor('  张三  '), '张三', '前后空白必须去掉')
  assert.equal(normalizeAuthor(''), undefined, '空串就是「没有作者」')
  assert.equal(normalizeAuthor('   '), undefined, '纯空白就是「没有作者」')
  assert.equal(normalizeAuthor(undefined), undefined, '缺省保持缺省')
  assert.equal(normalizeAuthor('张三 <a@b.c>'), '张三 <a@b.c>', '作者是 feed 原值：不剥邮箱、不改大小写、不截断')
})

/** R12 决策 1：schema 是写缝兜底 —— 绕过 normalizeAuthor 的写者也会被 trim、被拒空白。 */
test('itemRecordSchema：author 空白/空串解析失败，前后空白被 trim（写缝兜底）', () => {
  const base = { feedId: 'f', title: 't', link: 'l', fetchedAt: '2024-01-01T00:00:00.000Z', starred: false }
  assert.equal(itemRecordSchema.safeParse({ ...base, author: '' }).success, false, '空串不是合法作者')
  assert.equal(itemRecordSchema.safeParse({ ...base, author: '   ' }).success, false, '纯空白不是合法作者')
  const parsed = itemRecordSchema.safeParse({ ...base, author: '  张三  ' })
  assert.equal(parsed.success, true, '有值的作者必须能通过校验')
  assert.equal(parsed.data.author, '张三', 'schema 的 .trim() 要负责去掉前后空白')
  assert.equal(itemRecordSchema.safeParse(base).success, true, 'author 是可选的，缺省照常合法')
})
