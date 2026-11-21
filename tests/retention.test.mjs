/**
 * 保留与清理策略的单测。这些都是「删数据」的规则，必须逐条钉住边界：
 * 星标被误删、未读被误删、近期已读被误删，都是用户会真实感到损失的错误。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectPrunable, selectArticleEvictions, selectCleanup, articleCharsOf } from '../lib/retention.js'

const row = (id, recency, { starred = false, kept = false, read = false } = {}) => ({ id, starred, kept, read, recency })

test('裁剪：未超上限时一条都不删', () => {
  assert.deepEqual(selectPrunable([row('a', '2026-01-01')], 5), [])
  assert.deepEqual(selectPrunable([], 5), [])
  assert.deepEqual(selectPrunable([row('a', '1'), row('b', '2')], 2), [])
})

test('裁剪：优先删未读，且从最旧的开始', () => {
  const rows = [row('new-read', '2026-03-01', { read: true }), row('old-unread', '2026-01-01'), row('mid-unread', '2026-02-01')]
  // 超 1 条 ⇒ 删最旧的未读
  assert.deepEqual(selectPrunable(rows, 2), ['old-unread'])
  // 超 2 条 ⇒ 两个未读都删，即便有更旧的已读也不动它
  assert.deepEqual(selectPrunable(rows, 1), ['old-unread', 'mid-unread'])
})

test('裁剪：星标条目永不被删——哪怕它最旧、哪怕超额最多', () => {
  const rows = [row('star-old', '2026-01-01', { starred: true }), row('plain', '2026-02-01'), row('read', '2026-03-01', { read: true })]
  const picked = selectPrunable(rows, 1)
  assert.ok(!picked.includes('star-old'), '星标条目被删了')
  assert.deepEqual(picked, ['plain', 'read'], '非星标的两条都该删')
})

test('裁剪：星标占满时宁可超上限也不删（返回数量少于溢出量）', () => {
  const rows = [row('s1', '2026-01-01', { starred: true }), row('s2', '2026-01-02', { starred: true })]
  assert.deepEqual(selectPrunable(rows, 1), [], '没有可删对象时不得动星标')
})

test('裁剪：未读用尽后才轮到已读（已读是最后手段）', () => {
  const rows = [row('u', '2026-01-01'), row('r1', '2026-01-02', { read: true }), row('r2', '2026-01-03', { read: true })]
  assert.deepEqual(selectPrunable(rows, 2), ['u'])
  assert.deepEqual(selectPrunable(rows, 1), ['u', 'r1'])
})

test('正文缓存：未超上限不清；上限非法一律视为不清理', () => {
  const entries = [{ id: 'a', chars: 100, fetchedAt: '2026-01-01' }]
  assert.deepEqual(selectArticleEvictions(entries, 200), [])
  assert.deepEqual(selectArticleEvictions(entries, 0), [], '上限 0 视为未配置，不该清空')
  assert.deepEqual(selectArticleEvictions(entries, -5), [])
})

test('正文缓存：超限时从最旧开始清，清到刚好达标即停', () => {
  const entries = [
    { id: 'old', chars: 300, fetchedAt: '2026-01-01' },
    { id: 'mid', chars: 300, fetchedAt: '2026-02-01' },
    { id: 'new', chars: 300, fetchedAt: '2026-03-01' },
  ]
  // 总量 900，上限 600 ⇒ 清 1 条即达标
  assert.deepEqual(selectArticleEvictions(entries, 600), ['old'])
  // 上限 350 ⇒ 要清到剩 300，即清两条
  assert.deepEqual(selectArticleEvictions(entries, 350), ['old', 'mid'])
  // 上限 1000 ⇒ 不动
  assert.deepEqual(selectArticleEvictions(entries, 1000), [])
})

test('显式清理：四个条件缺一不可', () => {
  const cutoff = '2026-06-01T00:00:00.000Z'
  const rows = [
    { ...row('keep-unread', '2026-01-01'), articleChars: 0 },
    { ...row('keep-starred', '2026-01-01', { read: true, starred: true }), articleChars: 0 },
    // 「保持未读」是用户明确说的「别动它」，与星标同级（2026-11-14 起由判据本身守，不再依赖 SQL 谓词）
    { ...row('keep-kept', '2026-01-01', { read: true, kept: true }), articleChars: 0 },
    { ...row('keep-recent', '2026-07-01', { read: true }), articleChars: 0 },
    { ...row('delete-me', '2026-01-01', { read: true }), articleChars: 5000 },
  ]
  assert.deepEqual(selectCleanup(rows, cutoff), ['delete-me'])
})

test('显式清理：边界是严格早于阈值（等于阈值不清）', () => {
  const cutoff = '2026-06-01T00:00:00.000Z'
  const equal = [{ ...row('exactly', cutoff, { read: true }), articleChars: 0 }]
  assert.deepEqual(selectCleanup(equal, cutoff), [], '恰好等于阈值不该被清')
})

test('裁剪：星标与保持未读的条目一律不动（其余按未读优先删）', () => {
  // recency 用真实时间串：字典序 = 时间序，小的更旧
  const rows = [
    { id: 'read-old', starred: false, kept: false, read: true, recency: '2026-01-01' },
    { id: 'unread-old', starred: false, kept: false, read: false, recency: '2026-01-02' },
    { id: 'kept', starred: false, kept: true, read: false, recency: '2026-01-03' },
    { id: 'starred', starred: true, kept: false, read: false, recency: '2026-01-04' },
    { id: 'unread-new', starred: false, kept: false, read: false, recency: '2026-01-05' },
  ]
  // 溢出 2 条：**未读桶内最旧优先** ⇒ 删 unread-old / unread-new，
  // 而真正最旧的 read-old 反而留着 —— 这正是「先删未读」这条策略的可见后果
  const picked = selectPrunable(rows, 3)
  assert.ok(!picked.includes('kept'), '保持未读不该被自动裁剪')
  assert.ok(!picked.includes('starred'), '星标不该被自动裁剪')
  assert.deepEqual(picked, ['unread-old', 'unread-new'], '先删未读、再删已读，且按最旧优先')
})

test('裁剪：全被星标/保持占满时，宁可超上限也不删', () => {
  const rows = [
    { id: 'a', starred: true, kept: false, read: false, recency: '1' },
    { id: 'b', starred: false, kept: true, read: true, recency: '2' },
    { id: 'c', starred: false, kept: false, read: true, recency: '3' },
  ]
  assert.deepEqual(selectPrunable(rows, 1), ['c'], '只剩一条可删，不该动被保护的')
})


/* ── 全局预算：maxArticleCacheChars 的上限跨全部源共摊（2026-10-11 任务 9） ──
 *
 * 病象：上限原是**每源**一份，调用方逐源调用它，200 源即 200 份 8M 字符 ≈ 16 亿字符。
 * 纯函数本身一直是「吃进所有条目」的口径 —— 分家的责任在调用方（src/refresh.ts）。
 *
 * ⚠️ **下面这组用例对「修复前的代码」是绿的，这不是它们的判别力所在。**
 * 任务 9 修的是接线（调用方喂了单源名单），纯函数一个字没改 —— 所以别拿这一组当
 * 「修复被这些测试证明」的证据。真正的判别力在 `tests/refresh.test.mjs` 的
 * 「全局预算：每源都没超上限，但合计超了 ⇒ 必须跨源清」（实测：修前 3 ≠ 1 翻红）。
 * 这一组的价值是**把纯函数的口径钉死**：它一旦被改成按源分摊（例如按 entries.length 均分），
 * 下面第 2、3 条会当场翻红 —— 那是同一判据在别的形状下分家的信号。
 */

test('全局正文预算：上限只装得下 1 条 ⇒ 清掉跨源最旧的两条', () => {
  // 3 个源各 1 条，各 300 字符（合计 900），上限 350 ⇒ 装不下两条，清到剩一条即停
  const entries = [
    { id: 'feed-a/old', chars: 300, fetchedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'feed-b/mid', chars: 300, fetchedAt: '2026-02-01T00:00:00.000Z' },
    { id: 'feed-c/new', chars: 300, fetchedAt: '2026-03-01T00:00:00.000Z' },
  ]
  const picked = selectArticleEvictions(entries, 350)
  assert.deepEqual(picked, ['feed-a/old', 'feed-b/mid'],
    '淘汰必须跨源按抓取时间从最旧清起 —— 只清调用方「当下这个源」就不是全局预算')
  assert.ok(!picked.includes('feed-c/new'), '最新那条必须留下')
})

test('全局正文预算：每个源单独看都没超限，合计超了照样要清', () => {
  // 每源 400 < 500（单看任一源都不超），但三源合计 1200 > 500 ⇒ 必须清。
  // 这条是「每源预算」与「全局预算」的分水岭：按源清算的实现对它完全无感。
  const entries = [
    { id: 'a/1', chars: 400, fetchedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b/1', chars: 400, fetchedAt: '2026-01-02T00:00:00.000Z' },
    { id: 'c/1', chars: 400, fetchedAt: '2026-01-03T00:00:00.000Z' },
  ]
  assert.deepEqual(selectArticleEvictions(entries, 500), ['a/1', 'b/1'],
    '单源都没超限不代表总量没超限：闸门必须看合计')
})

test('全局正文预算：合计未超限时一条都不清（哪怕按每源分摊都超）', () => {
  // 反面：上限 1200 ≥ 合计 900 ⇒ 不动。反过来按源分摊（900/3 = 300 < 400）会误清三条。
  const entries = [
    { id: 'a/1', chars: 300, fetchedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b/1', chars: 300, fetchedAt: '2026-02-01T00:00:00.000Z' },
    { id: 'c/1', chars: 300, fetchedAt: '2026-03-01T00:00:00.000Z' },
  ]
  assert.deepEqual(selectArticleEvictions(entries, 1200), [],
    '总量在预算内就一条都不许清 —— 清缓存是降级，不该在没必要时发生')
})

test('全局正文预算：上限 <= 0 返回空（未配置 ≠ 整份清空）', () => {
  const entries = [
    { id: 'a/1', chars: 900, fetchedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b/1', chars: 900, fetchedAt: '2026-01-02T00:00:00.000Z' },
  ]
  assert.deepEqual(selectArticleEvictions(entries, 0), [],
    '上限 0 视为未配置：把缓存整份清空是静默丢数据，不是限流')
  assert.deepEqual(selectArticleEvictions(entries, -1), [], '负上限同理')
})

test('全局正文预算：抓取时间打平时按 id 定序（同一轮抓取的条目共享时间戳是常态）', () => {
  // 跨源清算把各源的条目混进一张名单，id 来自不同源的前缀 ⇒ 必须有确定的 tie-break，
  // 否则同一份库每次刷新的淘汰对象可能不同，行为不可复现。
  const entries = [
    { id: 'z/1', chars: 300, fetchedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'a/1', chars: 300, fetchedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'm/1', chars: 300, fetchedAt: '2026-01-01T00:00:00.000Z' },
  ]
  assert.deepEqual(selectArticleEvictions(entries, 350), ['a/1', 'm/1'],
    '同 fetchedAt 时按 id 升序清，淘汰对象必须可复现')
})


test('全局正文预算：上限是 NaN 时一条都不清（垃圾上限不得变成「清空整库」）', () => {
  // 守卫曾经写成 maxChars <= 0：NaN <= 0 是 false ⇒ 守卫不生效；而 total <= NaN 也是 false
  // ⇒ 判定一路走进淘汰循环，**把全部条目清空**。Task 9 把闸门从单源改成全库之后，
  // 同一个洞的爆炸半径从一个源变成了整库，所以必须钉住。
  const entries = [
    { id: 'a/1', chars: 900, fetchedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'b/1', chars: 900, fetchedAt: '2026-01-02T00:00:00.000Z' },
  ]
  assert.deepEqual(selectArticleEvictions(entries, Number.NaN), [],
    'NaN 上限 = 未配置：清空整库是静默丢数据，不是限流')
  assert.deepEqual(selectArticleEvictions(entries, undefined), [],
    'undefined 同理（配置没解析时的形状，见 src/index.ts 的 Config 兜底注释）')
  assert.deepEqual(selectArticleEvictions(entries, Infinity), [],
    'Infinity 是有效上限且装得下全部 ⇒ 不清')
})
/**
 * —— 表格的字符统计（R5 04）——
 *
 * 为什么值得单独一条：`table` 块两个字段都没有（既没有 `text` 也没有 `items`），只按那两个字段
 * 读的实现会把整张表算成 **0 字符**。于是「一张大表格不占缓存额度」——`capArticleCache` 的淘汰
 * 口径直接失真，而这件事在界面上看不出来（用户只会觉得缓存限额不生效）。
 */

/**
 * 含表格的夹具。
 *
 * 期望值按**手算的字面量**写，不在这里重跑一遍投影（那会变成自证）：
 * - 段落 `'正文甲乙丙'` = 5 字；
 * - 表格投影是「表头一行 + 每行单元格空格分隔、行间换行」⇒ `'参数 值\n电压 220V'`：
 *   参数(2) + 空格(1) + 值(1) + 换行(1) + 电压(2) + 空格(1) + 220V(4) = **12** 字。
 * 合计 17。分隔符算进去是**有意的**：它们确实是投影出来的字符，搜索与日志看到的也是它们。
 */
const TABLE_ARTICLE = {
  fetchedAt: '2026-10-11T10:00:00.000Z',
  blocks: [
    { kind: 'p', text: '正文甲乙丙' },
    { kind: 'table', header: ['参数', '值'], rows: [['电压', '220V']] },
  ],
}
const TABLE_CHARS = 12
const PARAGRAPH_CHARS = 5

test('articleCharsOf：表格块不再算成 0 字符（否则大表格不占缓存额度）', () => {
  assert.equal(articleCharsOf(TABLE_ARTICLE), PARAGRAPH_CHARS + TABLE_CHARS,
    '表格的表头与单元格都必须计入字符数')
  assert.ok(articleCharsOf(TABLE_ARTICLE) > PARAGRAPH_CHARS, '只算段落的话表格等于不存在')
  // 没有表格时行为不变（既有判据）
  assert.equal(articleCharsOf({ blocks: [{ kind: 'p', text: '正文甲乙丙' }] }), PARAGRAPH_CHARS)
  assert.equal(articleCharsOf({ blocks: [{ kind: 'list', items: ['一二', '三'] }] }), 3)
  assert.equal(articleCharsOf(undefined), 0)
})

test('articleCharsOf：paragraphs 存在时仍只算 paragraphs（二选一，与既有语义一致）', () => {
  // 这条钉住「二选一」不被表格分支顺手改成「相加」—— 并存形态经 normalizeLegacyArticle 后
  // 不该出现，但 schema 允许；口径变化会让旧库的字符数当场翻倍。
  assert.equal(articleCharsOf({ paragraphs: ['一二三'], blocks: [{ kind: 'table', rows: [['甲乙']] }] }), 3,
    'paragraphs 在场时只算 paragraphs')
})
