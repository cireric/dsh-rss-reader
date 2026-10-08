/**
 * 变异测试：把已经修好的关键判定**逐个改坏**，看测试套件是否见红。
 *
 * 为什么值得固化：这次评审里最有价值的产出不是「测试全绿」，而是**量出了绿的可信边界**——
 * 只断言 store 的客户端测试让三条接线变异全部幸存（P1-5 之前）；正文缓存闸门因为喂的是废弃的
 * 数据形态而永不触发（P0-3 之前）。这两类问题「跑测试」发现不了，只有「改坏它看有没有人喊」
 * 才能发现。
 *
 * 用法：npm run mutation（需先 npm run build + npm run build:client —— 改的是 lib/ 产物）。
 * 判据：**每一条变异都必须被抓到**；有幸存者就以非零码退出，并指出是哪条漏了。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

const ROOT = process.cwd()

/**
 * 每条只改一处。刻意**不含等价变异** —— 例如 selectArticleEvictions 里把 total 与上限的
 * 比较从小于等于改成小于：两者在相等时的返回值同为「不清」，行为完全相同，它幸存不是测试
 * 缺口。等价变异混进来会让这道门槛变成狼来了。
 */
const MUTATIONS = [
  { id: 'retention-星标保护', file: 'lib/retention.js',
    from: 'const unread = byOldest.filter((row) => !row.starred && !row.read);',
    to: 'const unread = byOldest.filter((row) => !row.read);' },
  { id: 'retention-未读优先级', file: 'lib/retention.js',
    from: 'return [...unread, ...read].slice(0, overflow).map((row) => row.id);',
    to: 'return [...read, ...unread].slice(0, overflow).map((row) => row.id);' },
  { id: 'retention-清理的星标保护', file: 'lib/retention.js',
    from: '.filter((row) => row.read && !row.starred && row.recency < cutoffIso)',
    to: '.filter((row) => row.read && row.recency < cutoffIso)' },
  { id: 'retention-非法上限保护', file: 'lib/retention.js',
    from: 'if (maxChars <= 0 || total <= maxChars)',
    to: 'if (total <= maxChars)' },
  { id: 'list-scroll-视口内判定', file: 'lib/list-scroll.js',
    from: 'if (rowTop >= currentTop && rowTop + rowHeight <= currentTop + containerHeight)',
    to: 'if (rowTop > currentTop && rowTop + rowHeight <= currentTop + containerHeight)' },
  { id: 'list-scroll-夹取保护', file: 'lib/list-scroll.js',
    from: 'const ceiling = Number.isFinite(maxTop) && maxTop > 0 ? maxTop : 0;',
    to: 'const ceiling = maxTop;' },
  { id: 'item-id-guid 优先级', file: 'lib/feed/item-id.js',
    from: 'const basis = item.id?.trim() || item.link?.trim() ||',
    to: 'const basis = item.link?.trim() ||' },
  { id: 'keys-大写 R', file: 'lib/keys.js',
    from: "case 'r':\n        case 'R':",
    to: "case 'r':" },
  { id: 'keys-大写 F', file: 'lib/keys.js',
    from: "case 'f':\n        case 'F':",
    to: "case 'f':" },
  { id: 'refresh-正文升级判定', file: 'lib/refresh.js',
    from: 'const needsContentUpgrade = (previous?.contentRevision ?? 1) < CONTENT_REVISION;',
    to: 'const needsContentUpgrade = (previous?.contentRevision ?? 1) > CONTENT_REVISION;' },
  { id: 'refresh-正文不得降级覆盖', file: 'lib/refresh.js',
    from: 'if (existing !== undefined && (summary?.length ?? 0) > (existing.summary?.length ?? 0))',
    to: 'if (existing !== undefined)' },
  { id: 'refresh-缓存闸门认 blocks', file: 'lib/refresh.js',
    from: 'chars: articleCharsOf(record.article),',
    to: 'chars: (record.article?.paragraphs ?? []).reduce((sum, paragraph) => sum + paragraph.length, 0),' },
  { id: 'domain-rebuildItem 的 omit', file: 'lib/domain.js',
    from: 'if (change.omit?.includes(field) === true)',
    to: 'if (false)' },
  { id: 'client-iframe 沙箱', file: 'lib/client.js',
    from: 'allow-scripts allow-forms allow-popups',
    to: 'allow-scripts allow-same-origin allow-forms allow-popups' },
  { id: 'client-键解析短路', file: 'lib/client.js',
    from: 'const action = resolveReaderKey(event.key, event.shiftKey);',
    to: "const action = 'none';" },
  { id: 'client-可见性守卫恒真', file: 'lib/client.js',
    from: 'if (root === null || root.getClientRects().length === 0)',
    to: 'if (true)' },
  { id: 'client-不注册监听器', file: 'lib/client.js',
    from: 'document.addEventListener("keydown", onKeyDown);',
    to: ';' },
]

function runSuite() {
  try {
    const out = execSync('node --test tests/*.test.mjs 2>&1', { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
    return { ok: true, out: out }
  } catch (error) {
    return { ok: false, out: String(error.stdout || '') + String(error.stderr || '') }
  }
}

const baseline = runSuite()
if (!baseline.ok) {
  console.error('基线不是绿的 —— 先修好再跑变异。')
  console.error(baseline.out.split('\n').filter((l) => /^\s*(✖|not ok)/.test(l)).slice(0, 5).join('\n'))
  process.exit(2)
}
console.log('基线绿。逐条改坏关键判定，看套件是否见红：')
console.log('')

const backups = new Map()
for (const path of new Set(MUTATIONS.map((m) => ROOT + '/' + m.file))) backups.set(path, readFileSync(path, 'utf8'))

const survivors = []
let applied = 0
for (const m of MUTATIONS) {
  const path = ROOT + '/' + m.file
  const original = backups.get(path)
  const mutated = original.replace(m.from, m.to)
  if (mutated === original) {
    console.log('  ?  ' + m.id.padEnd(26) + ' 未应用（产物里形状与预期不符，请同步更新本条）')
    survivors.push(m.id + '（未应用）')
    continue
  }
  applied += 1
  writeFileSync(path, mutated)
  let res
  try { res = runSuite() } finally { writeFileSync(path, original) }
  const fails = res.out.split('\n').filter((l) => /^\s*✖/.test(l)).map((l) => l.trim().replace(/\s*\(\d.*$/, ''))
  if (res.ok) {
    console.log('  x  ' + m.id.padEnd(26) + ' 幸存（套件仍然全绿）')
    survivors.push(m.id)
  } else {
    console.log('  v  ' + m.id.padEnd(26) + ' 被抓到（' + fails.length + ' 条翻红：' + (fails[0] || '').slice(0, 44) + '）')
  }
}

const after = runSuite()
console.log('')
console.log('应用 ' + applied + '/' + MUTATIONS.length + ' 条 · 幸存 ' + survivors.length + ' 条 · 恢复后基线 ' + (after.ok ? '仍然绿' : '没恢复干净！'))
if (survivors.length > 0) {
  console.error('幸存清单：' + survivors.join('、'))
  console.error('-> 这些都是测试没覆盖到的判定：补一条会翻红的断言，或确认它是等价变异。')
  process.exit(1)
}
console.log('全部被抓到。')
