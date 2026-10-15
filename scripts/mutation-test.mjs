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
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, mkdtempSync, existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import os from 'node:os'
import path from 'node:path'

const ROOT = process.cwd()

/**
 * 每条只改一处。刻意**不含等价变异** —— 例如 selectArticleEvictions 里把 total 与上限的
 * 比较从小于等于改成小于：两者在相等时的返回值同为「不清」，行为完全相同，它幸存不是测试
 * 缺口。等价变异混进来会让这道门槛变成狼来了。
 */
const MUTATIONS = [
  // article-view.ts 随原站视图整条删除（2026-10-08），那条变异的目标已不存在。
  // 换成守护本次修复的两条判定：装饰性小图过滤、同一图重复去重。
  { id: 'article-装饰性小图过滤', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    from: 'if (width > 0 && height > 0 && width <= DECORATIVE_IMAGE_MAX && height <= DECORATIVE_IMAGE_MAX)',
    to: 'if (false)' },
  { id: 'article-重复图去重', file: 'lib/article.js',
    judges: ['article.test.mjs'],
    from: 'if (count > MAX_SAME_IMAGE)', to: 'if (false)' },
  // 容器识别（2026-10-09）：它替代了「按尺寸/路径逐条猜杂图」的做法，失效就意味着站点头像与
  // 页脚二维码重新回到正文里 —— 正是用户截图里的现象，所以必须有人看着它。
  // ⚠️ 刻意**没有**「正文容器收窄」那条变异：它实测是**等价变异**，不是测试缺口。
  // 设子容器文本 c、父容器额外文本 x，子全为段落时子分数 = c、父分数 = c + 0.35x；
  // 要让收窄被接受需 c ≥ 0.9(c + 0.35x) ⇒ x ≤ 0.317c，而文本比阈值要求 c ≥ 0.5(c + x) ⇒ x ≤ c。
  // 后者被前者严格蕴含 ⇒ 去掉文本比检查后**没有任何输入**会改变结果，套件全绿是正确行为。
  { id: 'article-容器识别的整页兜底', file: 'lib/article.js',
    judges: ['article.test.mjs', 'overview-scale.test.mjs'],
    // 兜底失效 ⇒ 容器一旦选错就是「正文全丢」，这是本设计最危险的失效模式，必须有断言看住
    from: 'const blocks = focused.length > 0 ? focused : collectBlocks(scoped, baseUrl)',
    to: 'const blocks = focused' },
  { id: 'keys-r 归还刷新计数', file: 'lib/keys.js',
    judges: ['keys.test.mjs'],
    from: "return 'refreshCount';", to: "return 'toggleRender';" },
  { id: 'client-A 的范围阈值过滤', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs'],
    from: 'recencyOf(item) < before', to: 'true' },
  { id: 'subscribe-信任不跨源传播', file: 'lib/subscribe.js',
    judges: ['subscribe.test.mjs'],
    from: 'const inherited = options.limits.trustedTarget === true && isSameOrigin(candidate, pageUrl);',
    to: 'const inherited = options.limits.trustedTarget === true;' },
  { id: 'discover-只认 rel=alternate', file: 'lib/feed/discover.js',
    judges: ['discover.test.mjs'],
    from: 'if (!/\\balternate\\b/i.test(rel))', to: 'if (false)' },
  { id: 'client-1 键切展开视图', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs'],
    from: 'setLayout("expanded")', to: 'setLayout("list")' },
  { id: 'retention-星标保护', file: 'lib/retention.js',
    judges: ['refresh.test.mjs', 'retention.test.mjs'],
    from: 'const protectedFromPrune = (row) => row.starred || row.kept;',
    to: 'const protectedFromPrune = (row) => row.kept;' },
  { id: 'retention-未读优先级', file: 'lib/retention.js',
    judges: ['retention.test.mjs'],
    from: 'return [...unread, ...read].slice(0, overflow).map((row) => row.id);',
    to: 'return [...read, ...unread].slice(0, overflow).map((row) => row.id);' },
  { id: 'retention-清理的星标保护', file: 'lib/retention.js',
    judges: ['overview-paging.test.mjs', 'retention.test.mjs', 'store-sqlite.test.mjs'],
    from: '.filter((row) => row.read && !row.starred && row.recency < cutoffIso)',
    to: '.filter((row) => row.read && row.recency < cutoffIso)' },
  // 上限守卫（2026-10-11 修复轮 1 重写）：守卫已从 `maxChars <= 0` 改成 `!(maxChars > 0)`，
  // 为的是把 NaN 一起挡在外面 —— 挡住「整个清单」的那条与挡 NaN 的那条是同一处代码，分成两条变异。
  // ① 去掉「上限非法」这半 ⇒ 上限 0 / 负数会被当成「必须清到 0 字符」，把全部缓存清空。
  { id: 'retention-非法上限保护', file: 'lib/retention.js',
    judges: ['refresh.test.mjs', 'retention.test.mjs'],
    // from 照**编译产物**的实际形状写（docs/pitfalls.md 一、1.4）：lib/retention.js:47，独立实测 OCCURRENCES=1。
    from: 'if (!(maxChars > 0) || total <= maxChars)',
    to: 'if (total <= maxChars)' },
  // ② 把 `!(maxChars > 0)` 退回成 `maxChars <= 0` ⇒ NaN 穿过守卫（NaN <= 0 为 false），
  //   而 `total <= NaN` 同样是 false ⇒ 判定一路走进淘汰循环，**清空全部条目**。
  //   Task 9 把闸门从单源改成全库之后，同一个洞的爆炸半径从一个源变成了整库。
  //   非等价变异：NaN 下旧守卫返回整份淘汰名单，新守卫返回空。
  { id: 'retention-NaN 上限不得清空', file: 'lib/retention.js',
    judges: ['retention.test.mjs'],
    from: 'if (!(maxChars > 0) || total <= maxChars)',
    to: 'if (maxChars <= 0 || total <= maxChars)' },
  { id: 'list-scroll-视口内判定', file: 'lib/list-scroll.js',
    judges: ['list-scroll.test.mjs'],
    from: 'if (rowTop >= currentTop && rowTop + rowHeight <= currentTop + containerHeight)',
    to: 'if (rowTop > currentTop && rowTop + rowHeight <= currentTop + containerHeight)' },
  { id: 'list-scroll-夹取保护', file: 'lib/list-scroll.js',
    judges: ['list-scroll.test.mjs'],
    from: 'const ceiling = Number.isFinite(maxTop) && maxTop > 0 ? maxTop : 0;',
    to: 'const ceiling = maxTop;' },
  { id: 'item-id-guid 优先级', file: 'lib/feed/item-id.js',
    judges: ['parse.test.mjs'],
    from: 'const basis = item.id?.trim() || item.link?.trim() ||',
    to: 'const basis = item.link?.trim() ||' },
  { id: 'keys-大写 R', file: 'lib/keys.js',
    judges: ['keys.test.mjs', 'overview-scale.test.mjs'],
    from: "case 'r':\n        case 'R':",
    to: "case 'r':" },
  { id: 'keys-大写 F', file: 'lib/keys.js',
    judges: ['keys.test.mjs'],
    from: "case 'f':\n        case 'F':",
    to: "case 'f':" },
  { id: 'refresh-正文升级判定', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    from: 'const needsContentUpgrade = (previous?.contentRevision ?? 1) < CONTENT_REVISION;',
    to: 'const needsContentUpgrade = (previous?.contentRevision ?? 1) > CONTENT_REVISION;' },
  { id: 'refresh-正文不得降级覆盖', file: 'lib/refresh.js',
    judges: ['overview-scale.test.mjs', 'refresh.test.mjs'],
    from: 'if (existing !== undefined && (summary?.length ?? 0) > (existing.summary?.length ?? 0))',
    to: 'if (existing !== undefined)' },
  // 闸门必须认**现行**的 blocks 形态（2026-07 事故：只统计 paragraphs ⇒ 字符数恒为 0 ⇒ 闸门永不触发）。
  // ⚠️ 2026-10-11 修复轮 1 改写锚点：字符计数已随「清算原料」一起搬进 store-sqlite 的
  // articleCharsFromBody（原锚 `chars: articleCharsOf(record.article),` 已从 lib/refresh.js
  // 消失 ⇒ 报「未应用」；docs/pitfalls.md 二、2.7：未应用比幸存更隐蔽，因为它等于这条根本没跑）。
  // 语义不变，仍是「退回只数 paragraphs」。from 照**编译产物**的实际形状写（pitfalls 一、1.4）：
  // lib/store-sqlite.js:296，独立实测 OCCURRENCES=1。
  { id: 'refresh-缓存闸门认 blocks', file: 'lib/store-sqlite.js',
    judges: ['overview-paging.test.mjs', 'overview-scale.test.mjs', 'store-sqlite.test.mjs'],
    from: "if (typeof fields['text'] === 'string') {",
    to: "if (false) {" },
  // 全局预算的承重点（2026-10-11 任务 9）：这份名单必须覆盖**全库**。
  // 退回成「只看一个源」（等价于把它改回 2026-10-11 之前的逐源闸门）⇒ 200 源各有 8M 字符的名额，
  // 上限形同虚设；而每个源单独看又都没超自己的份额，连「哪一源超了」都判不出来。
  // 判据由 tests/refresh.test.mjs 的「全局预算：每源都没超上限，但合计超了 ⇒ 必须跨源清」看着
  // （实测：三个源各 1000 字符、上限 1500，旧实现三条全留 = 3 ≠ 1）。
  // ⚠️ from 照**编译产物**的实际形状写（docs/pitfalls.md 一、1.4）：lib/refresh.js:79 的
  // `const entries = store.listArticleCacheEntries();` 独立实测 OCCURRENCES=1。
  // ⚠️ 2026-10-11 修复轮 1 改写锚点：闸门已改走 store 的清算原料方法（原锚 `store.allItems()`
  // 随那轮改动从产物里消失 ⇒ 原锚会变「未应用」，比幸存更隐蔽）。语义不变，仍是**退回单源**。
  //
  // ⚠️⚠️ **修复轮 2：这一行曾经是假通过（2026-10-11，评审抓出）**
  //   当时的 `to` 写了 `urls[0]` —— 而 `urls` 是 `refreshFeeds` 的参数，**不在 `capArticleCache`
  //   的作用域里**（实测 lib/refresh.js：该函数签名是 `async function capArticleCache(store, maxChars)`）。
  //   于是变异抛 `ReferenceError: urls is not defined`：门槛照样报「应用」+「被抓到」、幸存者仍是 0，
  //   **但没有一条断言真的看见了「按源名单」**（实测：7 条翻红里 7 条都是同一个 ReferenceError）。
  //   ⇒ **崩溃式失败不是被抓住**：它把缺陷复现换成了「模块起不来」，门槛分辨不出来。
  //   修法：只用 `capArticleCache` 作用域内**确实存在**的东西重造「按源名单」——`store` 在参数里，
  //   所以 `store.listFeeds()[0]?.[0]` 取第一个源再按 feedId 过滤。
  //   实测：`ℹ fail 2`（恰是那两条跨源用例）、`ReferenceError` 出现 0 次。
  //   **给下一个改这一行的人**：改完必须在隔离副本里跑，并**逐条看翻红的是哪几条**；
  //   只要输出里出现 ReferenceError / SyntaxError，一律不算抓住（docs/pitfalls.md 二、2.7b）。
  { id: 'refresh-正文闸门退回单源', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    from: 'const entries = store.listArticleCacheEntries();',
    to: "const entries = store.listArticleCacheEntries().filter((entry) => store.item(entry.id)?.feedId === store.listFeeds()[0]?.[0])" },
  // 同一处代码的第二条承重点：**必须走只交出 { id, chars, fetchedAt } 的那条取数路径**。
  // 退回「把整表读出来再挑出带正文的」会把每份正文都解出来留在堆里 —— 实测 10 万条 × 8.8 KB
  // 时堆峰值 1865 MB，而 spec §9.3 的验收线是 ≤ 300 MB（超 6.2 倍）。这条守的是**内存契约**：
  // 淘汰名单两条路径算出来一样，所以纯行为断言看不见它，得从取数方式上钉。
  // ⚠️ `to` 里只用产物**已经 import 过**的 articleCharsOf —— 照源码写一个产物里没有的名字，
  // 变异的失败模式会从「缺陷复现」退化成「加载失败」，那不是被抓住（docs/pitfalls.md 二、2.7）。
  { id: 'refresh-正文闸门改走整表', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    from: 'const entries = store.listArticleCacheEntries();',
    to: 'const entries = store.allItems().filter(([, record]) => record.article !== undefined).map(([id, record]) => ({ id, chars: record.article.paragraphs?.reduce((sum, paragraph) => sum + paragraph.length, 0) ?? 0, fetchedAt: record.article?.fetchedAt ?? \'\' }));' },
  // ── 陈旧度调度（2026-10-11 任务 10）───────────────────────────────────────────
  // 三条各守一处**承重**判定，判据都在 tests/refresh.test.mjs 的新用例里（逐条实测见下）：
  //   ① 排序方向 ⇒ 调度会去抓「最新的那几个」（本任务要修的病象原封不动）
  //   ② 上限守卫 ⇒ 0 / NaN 被当成「必须为空」，即**每一轮一个源都不抓**，全量静默停摆
  //   ③ 接线 ⇒ 挑对了子集却没交给 refreshFeeds，200 源照样一轮全抓（本任务最可能的失效形态）
  // from 一律照**编译产物的实际形状**写（docs/pitfalls.md 一、1.4），OCCURRENCES 均独立实测 = 1。
  // ── 失败源不得饿死健康源（2026-10-11 任务 10 修复轮 1，评审实测抓出的真缺陷）─────────────
  // 这一族守的是**排序键的取值口径**。from 照编译产物形状写、OCCURRENCES 均独立实测 = 1
  // （lib/refresh.js:40 的回落链、:201 的失败分支写入）。
  { id: 'refresh-调度键退回只看成功', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    // lib/refresh.js:40。这就是**修复前的那份代码**：键退回 lastFetchedAt（= 上次成功）。
    // 永久失败的源永远拿不到它 ⇒ 永远最旧 ⇒ 这类源 ≥ K 个时每轮选中同一批，健康源全停更。
    // 实测 2 条翻红（纯函数复刻 200/20/K=20 与真装配 3 源 / 1 个 500 / K=1），RefErr 0 次。
    from: "    return record.lastAttemptedAt ?? record.lastFetchedAt ?? '';",
    to: "    return record.lastFetchedAt ?? '';" },
  { id: 'refresh-失败的尝试不盖时间', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs', 'teardown-race.test.mjs'],
    // lib/refresh.js:201（失败分支）。键的口径对了、但失败分支忘了盖时间 —— 两者必须同时成立。
    // ⚠️ 实测**只有 1 条**翻红：真装配那条。纯函数复刻层怎么改都测不到「失败分支有没有盖」，
    // 所以这条变异证明的正是「纯函数层断言不够、必须走真装配」这件事。谁想删掉那条真装配用例，
    // 先看这条变异会不会幸存。
    from: '            lastAttemptedAt: stamp,\n            lastFailure: result.reason,',
    to: '            lastFailure: result.reason,' },
  { id: 'refresh-陈旧度不再回落', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    // lib/refresh.js:40 的另一半：去掉对 lastFetchedAt 的回落。已有库（Task 2 迁移过来的记录）
    // 只有 lastFetchedAt、没有 lastAttemptedAt ⇒ 去掉回落后它们全被当成「从未尝试过」，
    // 旧订阅会在装载后一次性涌到最前面。非等价变异（老记录与新记录的排序结果不同）。
    // 实测 2 条翻红（陈旧度排序、饥饿不变式），RefErr 0 次。
    from: "    return record.lastAttemptedAt ?? record.lastFetchedAt ?? '';",
    to: "    return record.lastAttemptedAt ?? '';" },
  // ⚠️ 刻意**没有**给 304 分支（:221）与 200 分支（:303）的 lastAttemptedAt 写入各加一条变异：
  // 那两条是**等价变异**。两个成功分支里 lastFetchedAt 与 lastAttemptedAt 盖的是**同一个 stamp**，
  // 删掉 lastAttemptedAt 之后排序键回落到 lastFetchedAt ⇒ 取值逐字相同 ⇒ 没有任何输入会改变结果。
  // 它们幸存不是测试缺口（判定方法见本文件「正文容器收窄」那条的完整推导）。反过来说：
  // **只有失败分支那条写入是不可回落的**（它没有 lastFetchedAt 可回落）—— 判据就在上面。
  { id: 'refresh-陈旧度排序倒退', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    // lib/refresh.js:71，独立实测 OCCURRENCES=1。排序倒退后取到的是**最新**的 K 个，
    // 而未抓过的源（staleness key = ''，码位最小）从「最前」翻到「最后」⇒ 新建的源再也排不上
    // 第一轮。实测 3 条翻红：陈旧度排序、饥饿不变式、接线（refreshNow 用例）。
    from: 'if (a < b)', to: 'if (a > b)' },
  { id: 'refresh-每轮上限失效', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    // lib/refresh.js:55，独立实测 OCCURRENCES=1。整条守卫失效后 limit=0/负数/NaN 会一路走进
    // slice(0, 0) ⇒ 返回空列表 ⇒ **每一轮一个源都不抓**（所有源永久停更的那个静默失效）。
    // 实测 1 条翻红（「上限 <= 0 视为未配置」），正是守卫那一条。
    //
    // ⚠️ 刻意**没有**「limit ≥ 源数时返回全部」那条变异：它与本守卫的另一半同处一行，但
    //   是**等价变异**——把这一半去掉后仍走 .slice(0, limit)，而 limit ≥ length 时 slice 本来就
    //   返回全部，没有任何输入会改变结果。它幸存的不是测试缺口（判定先例：本文件
    //   「正文容器收窄」那条的完整推导）。它是快路径，不是行为分支。
    from: 'if (!(limit > 0) || limit >= feeds.length)', to: 'if (false)' },
  { id: 'refresh-取源退回全量', file: 'lib/index.js',
    judges: ['refresh.test.mjs'],
    // lib/index.js:178，独立实测 OCCURRENCES=1。退回「全量交出去」= 本任务要修的病象原样保留
    // （200 源 × 15s ÷ 并发 = 600s 一轮），而 selectStalestFeeds 自身的单测**全绿** ——
    // 这条证明「接线」那一层必须有独立断言看着（挑选对了却没生效是本仓库反复踩到的形态）。
    // 实测 1 条翻红（refreshNow 每轮只抓 K 个）。
    from: 'const subscriptions = selectStalestFeeds(target.listFeeds(), config.refreshFeedsPerRound);',
    to: 'const subscriptions = target.listFeeds().map(([feedId]) => feedId);' },
  { id: 'config-每轮取源默认无界', file: 'lib/config.js',
    judges: ['refresh.test.mjs'],
    // lib/config.js:20，独立实测 OCCURRENCES=1。把默认值改成 0 之后**别的用例全绿** —— 因为
    // selectStalestFeeds 把 0 解读成「未配置 ⇒ 抓全部」（那是安全侧），于是「一轮 600s」这条
    // 缺陷就借默认值回来了，而且没有任何断言会喊。这正是本任务最容易被回退的形态，所以
    // 单独拿 tests/refresh.test.mjs 的「默认值必须是个具体条数」看着它。
    from: 'refreshFeedsPerRound: z.number().default(20)',
    to: 'refreshFeedsPerRound: z.number().default(0)' },
  { id: 'domain-rebuildItem 的 omit', file: 'lib/domain.js',
    judges: ['domain.test.mjs', 'refresh.test.mjs', 'unread-accounting.test.mjs'],
    from: 'if (change.omit?.includes(field) === true)',
    to: 'if (false)' },
  { id: 'item-id-撞车即不可信', file: 'lib/feed/item-id.js',
    judges: ['parse.test.mjs'],
    from: 'new Set(group.map((index) => linkOf[index])).size < 2', to: 'false' },
  // 身份分叉（2026-10-09，用户实测「同一篇文章两条」）：这四条判定是修复的全部承重点，
  // 少一条就退回病象——所以逐个改坏，看 tests/identity.test.mjs 有没有人喊。
  { id: 'item-id-链接反查认回老身份', file: 'lib/feed/item-id.js',
    judges: ['identity.test.mjs'],
    from: 'known?.idOf(linkOf[index])', to: 'undefined' },
  { id: 'item-id-退级不得再用源 id', file: 'lib/feed/item-id.js',
    judges: ['parse.test.mjs'],
    from: 'if (options.includeSourceId !== false)', to: 'if (true)' },
  { id: 'item-id-认回身份要有旁证', file: 'lib/feed/item-id.js',
    judges: ['identity.test.mjs'],
    from: 'return record === undefined || corroborates(record, items[index]);', to: 'return true;' },
  { id: 'identity-幸存者取最早一条', file: 'lib/identity-repair.js',
    judges: ['identity.test.mjs'],
    from: 'a.fetchedAt === b.fetchedAt ? a.id.localeCompare(b.id) : a.fetchedAt.localeCompare(b.fetchedAt))',
    to: 'a.fetchedAt === b.fetchedAt ? a.id.localeCompare(b.id) : b.fetchedAt.localeCompare(a.fetchedAt))' },
  { id: 'identity-空链接不参与合并', file: 'lib/identity-repair.js',
    judges: ['identity.test.mjs'],
    from: "const link = row.link.trim();\n        if (link === '')",
    to: "const link = row.link.trim();" },
  { id: 'identity-合并保住已读态', file: 'lib/identity-repair.js',
    judges: ['identity.test.mjs'],
    from: 'readAt: keep.readAt ?? extra.readAt,', to: 'readAt: extra.readAt,' },
  { id: 'identity-合并保住星标', file: 'lib/identity-repair.js',
    judges: ['identity.test.mjs'],
    from: 'starred: keep.starred || extra.starred,', to: 'starred: keep.starred,' },
  { id: 'retention-保持未读不裁剪', file: 'lib/retention.js',
    judges: ['retention.test.mjs'],
    from: 'row.starred || row.kept',
    to: 'row.starred' },
  { id: 'fetch-重定向目标不可信', file: 'lib/feed/fetch.js',
    judges: ['fetch.test.mjs'],
    from: 'const hopBlocked = await resolvedBlockedReason(next, false);',
    to: 'const hopBlocked = await resolvedBlockedReason(next, trusted);' },
  { id: 'fetch-解析层内网拦截', file: 'lib/feed/fetch.js',
    judges: ['fetch.test.mjs'],
    from: 'const privateAddress = addresses.find((address) => isPrivateHost(address));',
    to: 'const privateAddress = undefined;' },
  { id: 'client-键解析短路', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs', 'scroll-dom.test.mjs'],
    from: 'const action = resolveReaderKey(event.key, event.shiftKey);',
    to: "const action = 'none';" },
  { id: 'client-可见性守卫恒真', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs', 'scroll-dom.test.mjs'],
    from: 'if (root === null || root.getClientRects().length === 0)',
    to: 'if (true)' },
  { id: 'client-不注册监听器', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs', 'scroll-dom.test.mjs'],
    from: 'document.addEventListener("keydown", onKeyDown);',
    to: ';' },
  // 滚动容器这一族（2026-10-09 修）。变异目标是**按键时刻现取容器**这条机制：
  // 它一旦退回「渲染期取一次」，详情页就会重新变成静默 no-op，而旧的假 React 夹具对此全绿。
  // 判据由 tests/scroll-dom.test.mjs 用真实 React + jsdom 看着（那一层才能表达这个失效）。
  { id: 'client-容器退回渲染期捕获', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    from: 'const container = root === null ? null : root.querySelector(selector);',
    to: 'const container = null;' },
  // ⚠️ 变异模式必须照**编译产物**的实际形状写（多行 if、单引号），
  // 照源码格式写会「未应用」——那等于这条变异根本没跑，比幸存更隐蔽。
  { id: 'client-容器选择器不分视图', file: 'lib/list-scroll.js',
    judges: ['list-scroll.test.mjs'],
    from: "return '[' + SCROLL_ATTR + '=\"article\"]';",
    to: "return '[' + SCROLL_ATTR + '=\"list\"]';" },
  { id: 'client-正文行高量错对象', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    from: 'const sample = box.querySelector("p") ?? box;',
    to: 'const sample = box;' },
  { id: 'client-半页退化成整页', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    from: "? halfPageTop(box.scrollTop, box.clientHeight, maxTop, direction)",
    to: "? pageTop(box.scrollTop, box.clientHeight, maxTop, direction)" },
  { id: 'client-换文章不归零', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    from: 'box.scrollTop = 0;',
    to: 'box.scrollTop = box.scrollTop;' },
  // 导航轴（2026-10-10 两列布局任务 2）。这三条是「源 x filter 叠加」的全部承重点：
  // 叠加判定失效 ⇒ 退化成只看 filter；不重落选中 ⇒ j/k 在看不见的条目上无反应；
  // perFeedUnread 不落 state ⇒ 左栏角标无数据。判据由 tests/nav-selection.test.mjs 看着。
  { id: 'client-导航轴叠加失效', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs', 'nav-selection.test.mjs', 'scroll-dom.test.mjs'],
    from: 'if (state.navSelection.kind === "feed" && item.feedId !== state.navSelection.feedId) return false;',
    to: ';' },
  { id: 'client-切源不重落选中', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs', 'nav-selection.test.mjs', 'scroll-dom.test.mjs'],
    from: 'set({ selectedId: state.items.filter(inScope)[0]?.id });',
    to: ';' },
  { id: 'client-perFeedUnread 不落 state', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs', 'scroll-dom.test.mjs', 'unread-accounting.test.mjs'],
    from: 'perFeedUnread: overview.perFeedUnread,',
    to: 'perFeedUnread: {},' },
  // setFilter 的「源 x filter」语义（评审 Important 2）。既有 setFilter 用例全跑在 virtual 状态
  // 下、源条件恒真 ⇒ 这条路径零覆盖。退回「只按 filter 算第一条」后，已选中某源时切 filter
  // 会把 selectedId 送到源外条目 —— 判据是 tests/nav-selection.test.mjs 的第 6 条用例。
  { id: 'client-setFilter 丢掉源条件', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs'],
    // ⚠️ 2026-10-10 任务 6 返工：setFilter 提出具名函数并顺带同步 navCursor，产物形状随之变化，
    // 本条 from 原为 'set({ filter });\n...relocateSelection();' ⇒ 变成「未应用」。
    // 照新产物重写（独立实测 OCCURRENCES=1），语义仍是原来的那条：**丢掉源条件**、selectedId 落全表第一条。
    from: '\t\t\t\tset({\n\t\t\t\t\tfilter,\n\t\t\t\t\tnavCursor: {\n\t\t\t\t\t\tkind: "filter",\n\t\t\t\t\t\tfilter\n\t\t\t\t\t}\n\t\t\t\t});\n\t\t\t\trelocateSelection();',
    to: '\t\t\t\tset({\n\t\t\t\t\tfilter,\n\t\t\t\t\tnavCursor: {\n\t\t\t\t\t\tkind: "filter",\n\t\t\t\t\t\tfilter\n\t\t\t\t\t}\n\t\t\t\t});\n\t\t\t\tconst list = filter === "all" ? state.items : state.items.filter((i) => filter === "unread" ? i.readAt === void 0 : i.starred);\n\t\t\t\tset({ selectedId: list[0]?.id });' },
  // 「再选同源 = 取消」与「virtual 归位 filter」（评审 Minor 2）：两条判定各一条变异。
  // 前者失效 ⇒ 左栏点亮的项再点一次不回聚合视图；后者失效 ⇒ 虚拟视图留着一套过滤器残留，
  // 变成与 filter 并存的第二套过滤状态（本任务实现时第一遍就漏了后者，靠测试才抓到）。
  { id: 'client-再选同源不取消', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs', 'scroll-dom.test.mjs'],
    from: 'if (next.kind === "feed" && current.kind === "feed" && current.feedId === next.feedId || next.kind === "virtual") set({',
    to: 'if (next.kind === "virtual") set({' },
  { id: 'client-virtual 不归位 filter', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs'],
    from: 'navSelection: { kind: "virtual" },\n\t\t\t\t\tfilter: "all"',
    to: 'navSelection: { kind: "virtual" }' },
  // 每源未读数的**键域**（2026-10-10）。左栏角标按 feeds 表逐行渲染，键域必须严格 = feeds 表：
  // 删掉「以 feeds 表铺 0」后，0 未读的源会丢键，那一行变成「角标空白」而不是「角标 0」——
  // 界面上无从分辨，是最贵的那类沉默失败。非等价变异：丢键后取值变 undefined，两条测试会红。
  // ⚠️ 2026-10-10 任务 9：本条原锚在 lib/endpoints.js 的 'perFeedUnread[feed.id] = 0;'。
  // 该循环已收敛进 shared.ts 的 countUnreadPerFeed（口径唯一化的同一件事），产物随之变化 ⇒
  // 原锚变「未应用」（docs/pitfalls.md 二、2.7：未应用比幸存更隐蔽）。照新产物重写，
  // 独立实测 lib/shared.js:41 OCCURRENCES=1，语义仍是原来那条：**丢键域**（0 未读的源不留键）。
  { id: 'endpoints-perFeedUnread 键域铺 0', file: 'lib/shared.js',
    judges: ['overview-paging.test.mjs', 'store-sqlite.test.mjs'],
    from: 'unread[feedId] = 0;', to: ';' },
  // 左栏（2026-10-10 两列布局任务 3）。这两条是本任务新增的关键判定，各一条变异：
  // 角标门失效 ⇒ 规格不变量 8 的「三者同消」在左栏漏掉（隐藏计数后左栏还留着数字）；
  // 角标数据源换回 items 派生 ⇒ items 按 maxItemsShown 截断，角标与顶栏总数对不上。
  // 判据由 tests/scroll-dom.test.mjs 的「隐藏未读计数时左栏角标也消失」看着。
  { id: 'client-左栏角标无视 showUnread', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    // ⚠️ `to` 必须**保留展开运算符**：2026-10-11 终检评审 B1 修好分类器后，这条被当场抓成
    //   「崩了（SyntaxError）」—— 它原先写成不带 `...` 的对象字面量，而在对象字面量里少一个 `...`
    //   会让那对花括号被解析成**块语句** ⇒ 产物**加载期**就语法错、整个 client 组一起红。
    //   **那正是这个分类器要堵的假通过**：崩了被当成「抓到」，而没有任何断言真的看见「角标无视
    //   showUnread」。补回 `...` 后红条数才代表这条变异的本义（实测 3 条翻红）。
    from: '...showUnread ? { "data-rss-nav-badge": String(unread) } : {},',
    to: '...{ "data-rss-nav-badge": String(unread) },' },
  { id: 'client-左栏角标改用派生', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    from: 'const unread = perFeedUnread[feed.id];',
    to: 'const unread = 0;' },
  // 折叠必须「不占宽度」（任务 3 的精确取值）：退回「渲染但宽 0」会留下一条右边框的缝，
  // 而要求是「收起 = 这一列不存在」。判据由 scroll-dom 的左栏用例看着（左栏容器应整个消失）。
  { id: 'client-折叠时左栏仍渲染', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    // from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4 记的那条坑；本次实测踩到）：
    // 产物是 `children: [state.navVisible && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(FeedNav, {`
    // （lib/client.js:1931，行首 6 个 tab），不是源码里的 `{state.navVisible && (<FeedNav`。
    // 该串是产物里唯一的 navVisible 条件：另两处是默认值 navVisible: true 与 !state.navVisible。
    // 改成恒真 ⇒ 折叠后左栏仍然渲染，`[data-rss-nav]` 还在 DOM 里 —— 折叠的判据就是「这个容器整个消失」。
    from: 'state.navVisible && /* @__PURE__ */',
    to: 'true && /* @__PURE__ */' },
  // 滚动键只作用右栏（2026-10-10 两列布局任务 4）。左栏同样 `overflowY: auto`，
  // 所以「按键不会去滚左栏」不取决于它能不能滚，而取决于**它不带 data-rss-scroll** 这个标记判定：
  // 一旦左栏也被打上该属性，querySelector 取到的第一个匹配就是它（FeedNav 在文档序里靠前），
  // n/p/空格 便去滚左栏而右栏纹丝不动 —— 读者看到的是「按键毫无反应」。
  // 判据由 tests/scroll-dom.test.mjs 的「滚动不误命中左栏」看着（纯函数层看不见这层错位）。
  { id: 'client-左栏也被标成滚动容器', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    // from 照**编译产物**的真实形状写：lib/client.js:634 的 `"data-rss-nav": "",` 是全产物唯一一处
    // （左栏容器只此一个，见 docs/pitfalls.md 一、1.4）。
    from: '"data-rss-nav": "",',
    to: '"data-rss-nav": "", "data-rss-scroll": "list",' },
  // 按键守卫不许依赖环境全局（2026-10-09）。变异回 instanceof 后，
  // 判据是 tests/scroll-dom.test.mjs 的「本 realm 没有 HTMLElement 时快捷键照样能用」。
  { id: 'client-守卫改回环境全局', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    from: 'function isElementNode(node) {',
    to: 'function isElementNode(node) { return node instanceof HTMLElement;' },
  // 右下角「回顶部 / 去底部」（2026-10-09）。两条各钉一个方向：
  // 反了或都不动，tests/scroll-dom.test.mjs 的箭头用例必须翻红。
  { id: 'client-去底部反成回顶部', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    from: 'function edgeTopFor(maxTop, edge) {',
    to: 'function edgeTopFor(maxTop, edge) { return 0;' },
  { id: 'client-箭头按钮不接容器', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    from: 'boxRef.current = node;',
    to: 'boxRef.current = null;' },
  // 「点 ↓ 之后贴住底部」（2026-10-09，用户实测：新文章首点到不了底）。
  // 病因是懒加载图片进场把内容撑高，而 scrollTop 留在原地；判据在 scroll-dom 的第 10 条用例。
  { id: 'client-到底后不贴住底部', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    from: 'if (pinnedRef.current)',
    to: 'if (false)' },
  // 用户滚走必须解除贴底 —— 少了它会把读者的滚动硬拽回底部。
  { id: 'client-用户滚走不解除贴底', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    from: 'if (Math.abs(box.scrollTop - expectedTopRef.current) > 2)',
    to: 'if (false)' },
  // 键盘流（2026-10-10 两列布局任务 6）：u 归还 GR 原义「左栏显隐」、向上半页改由 shift+d 接盘。
  // 两条都是**决策级**判定（改坏 = 用户肌肉记忆与界面标签当场对不上），各一条变异。
  // 判据：tests/keys.test.mjs 的「u 归还 GR 原义」「半页：d 向下、shift+d 向上」；
  // 接线面另有 tests/scroll-dom.test.mjs 的「u 键折叠/展开左栏」看着。
  { id: 'keys-u 改回向上半页', file: 'lib/keys.js',
    judges: ['keys.test.mjs'],
    // from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4）：lib/keys.js:40 的
    // `        case 'u': return 'toggleNav';` 是全产物唯一一处（独立实测 OCCURRENCES=1）。
    from: "case 'u': return 'toggleNav';",
    to: "case 'u': return 'halfPageUp';" },
  { id: 'keys-shift+d 不接盘上半页', file: 'lib/keys.js',
    judges: ['keys.test.mjs'],
    // lib/keys.js:38，同样唯一（独立实测 OCCURRENCES=1）。
    // 改成恒向下半页 ⇒ 上半页再无入口，「接盘」这句话在键位层就落空。
    from: "case 'd': return shift === true ? 'halfPageUp' : 'halfPageDown';",
    to: "case 'd': return 'halfPageDown';" },
  // 接线面（四条）：键位**解析对了但 client 没接线**这一层是本仓库多次踩到的形态
  // （任务 6 若只写 keys 断言就会漏）。判据都是 tests/scroll-dom.test.mjs 里走真实按键路径的新用例。
  { id: 'client-u 键不接左栏显隐', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    from: 'run(() => store.toggleNav());',
    to: 'run(() => {});' },
  // ── 返工新增（2026-10-10，按规格 §2.4 把「移动」与「打开」拆开）──────────────────────
  // 第一版把两者合成一步（移动即 selectNav 打开它），shift+o 因此只剩「取消」，规格无从满足。
  // 拆开之后这条分工有三个独立的承重点，各一条变异：
  //   ① 移动键不许去改作用域（改回「移动即打开」）
  //   ② 移动不许顺带换 filter（半塌缩：光标走了、生效的也走了）
  //   ③ 打开键必须真的落到作用域（光标算对了却不动右栏 = shift+o 变摆设）
  { id: 'client-shift+n 改成「移动即打开」', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    // from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4）。lib/client.js:2002，
    // 独立实测 OCCURRENCES=1。改回第一版行为后，press('N', true) 当场换掉右栏列表，
    // 判据「shift+n 移动光标时不改变右栏列表内容与 filter」立刻翻红。
    from: 'run(() => store.moveNavCursor(action === "navNext" ? 1 : -1));',
    to: 'run(() => { store.moveNavCursor(action === "navNext" ? 1 : -1); const n = store.get().navCursor; if (n.kind === "feed") store.selectNav({ kind: "feed", feedId: n.feedId }); else store.setFilter(n.filter); });' },
  { id: 'client-移动光标顺带换 filter', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs', 'scroll-dom.test.mjs'],
    // lib/client.js:598，独立实测 OCCURRENCES=1。这是「移动」那半边更隐蔽的半塌缩形态：
    // 光标确实走了、可 filter 也跟着走（读者看到右栏内容变了）。整条判定的要点是「光标变了而
    // 生效视图没变」，半塌缩同样得被守。
    from: 'set({ navCursor: next });',
    to: 'set({ navCursor: next, filter: next.kind === "filter" ? next.filter : state.filter });' },
  { id: 'client-打开光标不动作用域', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs', 'scroll-dom.test.mjs'],
    // lib/client.js:618，独立实测 OCCURRENCES=1。这是「打开」那半边：光标算对了却落不到作用域。
    from: 'setFilter(cursor.filter);',
    to: ';' },
  // 未读账目守恒（2026-10-10 两列布局任务 5）。这两条守的是**客户端**这一侧的每源账目：
  // 左栏角标读 state.perFeedUnread、顶栏读 state.unread（index.tsx:374 / :385），
  // 只动一边就会出现「角标还写着 3、顶栏已经 2」——界面上自相矛盾且无报错。
  // 判据是 tests/unread-accounting.test.mjs 的两条客户端用例（修前实测 2 条翻红）。
  { id: 'client-markRead 不动每源账目', file: 'lib/client.js',
    judges: ['unread-accounting.test.mjs'],
    from: '[target.feedId]: Math.max(0, (state.perFeedUnread[target.feedId] ?? 0) - 1)',
    to: '[target.feedId]: state.perFeedUnread[target.feedId]' },
  // 增量助手是 markAllRead / undoMarkAll 的账目来源。把「按宿主下发的键铺 0」删掉后，
  // 重算结果只剩空表 ⇒ 0 未读的源丢键，左栏那一行的角标变「空白」而不是「0」——
  // 与任务 1 裁决的键域契约（键域严格 = feeds 表）同一条，是最贵的那类沉默失败。
  { id: 'client-每源账目丢键域', file: 'lib/client.js',
    judges: ['overview-scale.test.mjs', 'unread-accounting.test.mjs'],
    from: 'const next = { ...state.perFeedUnread };',
    to: 'const next = {};' },
  // 严禁退回「按本地 items 整体重算」：客户端只拿得到 maxItemsShown（300）条，
  // 宿主按每源 500 条的**全量表**记账（src/config.ts）。整体重算会把截断之外的账抹掉，
  // 角标 0 / 顶栏 17 —— 正是任务 1 拒绝「客户端派生 perFeedUnread」的同一条理由。
  // 判据是 tests/unread-accounting.test.mjs 的两条截断用例（修前实测 2 条翻红）。
  { id: 'client-每源账目整体重算', file: 'lib/client.js',
    judges: ['unread-accounting.test.mjs'],
    from: 'next[feedId] = Math.max(0, next[feedId] + delta);',
    to: 'next[feedId] = Math.max(0, state.items.filter((i) => i.feedId === feedId && i.readAt === void 0).length);' },
  // ── 视图记忆持久化（2026-10-10 两列布局任务 7）────────────────────────────────
  // 这一族的判据几乎全在 tests/nav-persistence.test.mjs（那边同时钉了「老域没有 global
  // 也能打开」这条必须实测的路径）。每条 from 都照**编译产物的实际形状**写、并已独立实测
  // OCCURRENCES=1（docs/pitfalls.md 一、1.4 / 二、2.7 记的就是照源码猜 from 的后果）。
  // ① 读侧的形状校验失效 ⇒ 认不出的值被原样吃到 state 里（「回落」这条承诺当场作废）
  { id: 'persist-读侧不校验形状', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    from: '(isKnownFeed === void 0 || isKnownFeed(selection["feedId"]))',
    to: 'true' },
  // ② filter 枚举校验失效 ⇒ 非法 filter 被当成真的过滤条件用（右栏内容与按钮状态各说各话）
  { id: 'persist-filter 不校验枚举', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    from: 'FILTERS.includes(filterRaw) ? filterRaw : DEFAULT_VIEW_PREFERENCES.filter',
    to: 'filterRaw ?? DEFAULT_VIEW_PREFERENCES.filter' },
  // ③ 恢复不许盖掉用户在异步窗口里做的手势（时序守卫）
  { id: 'persist-恢复盖掉用户手势', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    from: 'if (viewTouched) return;',
    to: ';' },
  // ④ 恢复必须真的落到 state —— 只读了记忆却不用它，等于功能没接上（最隐蔽的形态）
  { id: 'persist-恢复不落到 state', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs', 'nav-persistence.test.mjs', 'overview-scale.test.mjs'],
    from: 'if (!viewRestored) applyRestoredView(preferences);',
    to: ';' },
  // ⑤ 写盘串行化失效 ⇒ 后发的先到会让记忆回退成更早的状态
  { id: 'persist-写盘不串行化', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    from: 'viewWriteChain = viewWriteChain.then(() => callRpc("saveViewPreferences", { preferences }))',
    to: 'viewWriteChain = callRpc("saveViewPreferences", { preferences })' },
  // ⑥ 宿主写侧不归一再落库 ⇒ 认不出的原值进媒介（存储里攒垃圾，只被读侧遮住）
  { id: 'persist-宿主写侧不归一', file: 'lib/store.js',
    judges: ['nav-persistence.test.mjs'],
    from: 'const safe = sanitizeViewPreferences(preferences, (feedId) => feeds.get(feedId) !== undefined);',
    to: 'const safe = preferences;' },
  // ⑦ 宿主读侧不校验 ⇒ 媒介里的坏值被透出去（回落承诺的第二道闸失效）
  { id: 'persist-宿主读侧不校验', file: 'lib/store.js',
    judges: ['nav-persistence.test.mjs', 'overview-scale.test.mjs'],
    from: 'viewPreferences: () => sanitizeViewPreferences(global.get(), (feedId) => feeds.get(feedId) !== undefined),',
    to: 'viewPreferences: () => global.get(),' },
  // ⑧⑨⑩ 三个关键动作各自写一次盘：**三个调用点各一条**，否则任一条漏写都会被另一条的
  // 整份写入盖过去（persistView 落的是整个 state）。判据在「记住上次选中的导航项…」里
  // 逐个动作各断言一次。三条 from 各自唯一：产物里 persistView() 共 3 处，下面分别锚在
  // 「后随 applyOverview」「后随 /**」「前随 set({ navVisible: … })」上（均实测 OCCURRENCES=1）。
  { id: 'persist-setFilter 不写盘', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    from: 'relocateSelection();\n\t\t\t\tpersistView();\n\t\t\t};\n\t\t\tconst applyOverview',
    to: 'relocateSelection();\n\t\t\t};\n\t\t\tconst applyOverview' },
  { id: 'persist-selectNav 不写盘', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    from: 'relocateSelection();\n\t\t\t\tpersistView();\n\t\t\t};\n\t\t\t/**',
    to: 'relocateSelection();\n\t\t\t};\n\t\t\t/**' },
  { id: 'persist-toggleNav 不写盘', file: 'lib/client.js',
    judges: ['nav-persistence.test.mjs'],
    from: 'set({ navVisible: !state.navVisible });\n\t\t\t\tpersistView();',
    to: 'set({ navVisible: !state.navVisible });' },
  // ── 标读回包的每源账目（2026-10-10 两列布局任务 9 收尾）──────────────────────────
  // 这一条守的是**缺陷本体**：客户端只拿得到 maxItemsShown（300）条 items，而宿主按每源 500 条的
  // 全量表记账。标读端点只回 unread 不回 perFeedUnread 时，客户端只能拿本地增量补每源账目；
  // 一旦本地看不见的漂移发生（另一个面板把某源标空），幽灵未读就留在基线里 ⇒ 左栏各源之和
  // 17 ≠ 顶栏 14（spec §4 不变量 1）。判据是 tests/unread-accounting.test.mjs 的
  // 「host：markRead / unmarkRead 的回包必须带 perFeedUnread」+ 两条「截断 + 外部漂移」用例。
  // from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4）：lib/endpoints.js:132，独立实测
  // OCCURRENCES=1（另一处同串在 unmarkRead 分支，靠后随的 case 名区分）。
  { id: 'endpoints-标读回包不带每源账目', file: 'lib/endpoints.js',
    judges: ['overview-scale.test.mjs', 'unread-accounting.test.mjs'],
    from: "return ok({ changed, ...accountOf(target) });\n                }\n                case 'unmarkRead': {",
    to: "return ok({ changed, unread: accountOf(target).unread });\n                }\n                case 'unmarkRead': {" },
  // 客户端这一侧的承重点：回包到手必须**整体覆盖**。退回「只覆盖 unread」= 又用本地那份
  // 看不见全量的账当真相，与上面那条是同一个不变式的两端，各自都要有人看着。
  // from 照**编译产物**的真实形状写：lib/client.js:416-421 的 applyAccount，独立实测 OCCURRENCES=1。
  { id: 'client-标读回包不整体覆盖每源账目', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs', 'unread-accounting.test.mjs'],
    from: 'unread: account.unread,\n\t\t\t\t\tperFeedUnread: account.perFeedUnread',
    to: 'unread: account.unread' },
  // ⑨ 域 global 槽的 schema 必须拒绝 null。放宽它 ⇒ 存进去的 null 与「从未写过」不可区分，
  //    重开后静默变回 initial（spec.d.ts:83-89 记的那条 round-trip 缺陷）。defineDomain 的
  //    运行时检查会同时炸，所以这条变异下那次 open 直接抛错、用例翻红。
  { id: 'persist-global schema 接受 null', file: 'lib/domain.js',
    judges: ['domain.test.mjs', 'nav-persistence.test.mjs'],
    from: 'schema: z.unknown().refine((value) => value !== null),',
    to: 'schema: z.unknown(),' },
  // 过滤行的点亮条件（2026-10-10，两轮用户实测反馈合并）：
  //  ① 选源后**仍在生效**的过滤（未读/星标）必须继续点亮，否则读者以为过滤被清掉了，
  //     而右栏其实还在按它过滤 —— 功能与指示脱节，最难自察的一类；
  //  ② 三个标签必须**同等对待**：曾为 'all' 单独开过一个「不点亮」的口子，
  //     用户一眼当成 bug（两个亮、一个不亮）。一致性优先于省一次高亮。
  // 这条变异给 'all' 重新加上那个例外，①② 会同时被它守住。
  { id: 'client-过滤行对 all 特殊对待（三个标签不一致）', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    from: 'const selected = filter === view.key;',
    to: 'const selected = filter === view.key && filter !== "all";' },
  // 失败标记必须只反映**最近一次**结果（2026-10-10 用户实测：横幅一直写「月光博客（HTTP 502）」，
  // 而日志里该源连续十几次都是 not-modified —— 502 只出现过一次、之后一路成功）。
  // 变异把 lastFailure 塞回 304 分支的写回对象：一旦恢复「展开 previous」的写法，标记就再没人清。
  { id: 'refresh-304 成功不残留上次失败标记', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    from: 'url: feedId,\n            title: previous?.title,',
    to: 'url: feedId,\n            lastFailure: previous?.lastFailure,\n            title: previous?.title,' },
  // 正文写入必须**合并进当前记录**（2026-10-10 用户实测：详情页逐篇读，已读状态丢失）。
  // 退回「用抓取前的快照整体写回」会把窗口期内并发 markRead 写进去的 readAt 抹掉 —— 丢失更新。
  // 判据：tests/article-markread-race.test.mjs（并发 markRead + 正文写入，断言 readAt 存活）。
  { id: 'article-用旧快照整体写回覆盖并发写入', file: 'lib/endpoints.js',
    judges: ['article-markread-race.test.mjs'],
    from: 'await target.updateItem(itemId, (current) => ({ ...current, articleFailure: fetched.reason }));',
    to: 'await target.saveItem(itemId, { ...existing, articleFailure: fetched.reason });' },
  // 刷新期间的写同样必须合并进当前记录（2026-10-10 与 article 端点同类）：
  // 抓取/淘汰是长任务，期间用户完全可能标已读、加星；用快照整体写回会静默抹掉这些用户数据。
  // 判据：tests/refresh.test.mjs 的两条「并发标已读」用例（各自注入一次窗口内并发写）。
  { id: 'refresh-缓存淘汰用旧快照覆盖并发写入', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    from: "await store.updateItem(itemId, (current) => rebuildItem(current, { omit: ['article', 'articleFailure'] }));",
    to: "await store.saveItem(itemId, rebuildItem(store.item(itemId), { omit: ['article', 'articleFailure'] }));" },
  { id: 'refresh-正文回填用旧快照覆盖并发写入', file: 'lib/refresh.js',
    judges: ['refresh.test.mjs'],
    from: "await store.updateItem(itemId, (current) => ({ ...current, summary }));",
    to: "await store.saveItem(itemId, { ...store.item(itemId), summary });" },
  // ── 快捷键帮助浮窗（2026-10-10）──────────────────────────────────────────────
  // 病象：头部一行塞满键位（读者记不住、界面也挤），而它必须与 keys.ts 逐字同步，
  // 同步只靠人记 —— 本仓库为「标签与实现各说各话」付过两次学费。
  // 修法：提示行收进「?」浮窗，浮窗内容逐行渲染 src/keys.ts 的 READER_KEY_HELP（唯一来源）。
  // 这五条各守一个**独立**的失效面，缺一条就退回某种「按了没反应」：
  //   ① 键位层：? 解析成 help（否则浮窗再无键盘入口）
  //   ② 接线层：解析对了但 client 没接 —— 本仓库反复踩到的形态
  //   ③ 优先级：帮助开着时 Esc 必须先关浮窗（否则正文页按 Esc 会「浮窗与文章一起消失」）
  //   ④ 角色：浮窗若标成 dialog，面板自己的按键守卫会把从浮窗内发出的键全吞掉（含 Esc）
  //   ⑤ 依赖数组：helpOpen 不进依赖 ⇒ 闭包读到注册那一刻的 false ⇒ 症状同 ③ 但根因不同
  // 判据：tests/keys.test.mjs 的「? 是快捷键帮助」「帮助表逐条反查」「帮助表反向覆盖」；
  // tests/scroll-dom.test.mjs 的「? 开合帮助浮窗」「Esc 关浮窗且不穿透」「✕ 关闭；焦点落在浮窗里…」。
  // 每条 from 均照**编译产物的真实形状**写（docs/pitfalls.md 一、1.4），并已独立核对出现次数。
  { id: 'keys-? 不认帮助键', file: 'lib/keys.js',
    judges: ['keys.test.mjs'],
    // lib/keys.js:65，产物里唯一一处。
    from: "case '?': return 'help';",
    to: "case '?': return 'none';" },
  { id: 'client-? 不接浮窗', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    // lib/client.js:2470-2471。删掉 run(...) 之后 ? 既不 preventDefault 也不开浮窗 ——
    // 「被吞掉」与「毫无反应」是两种不同的病，都由这条变异造出来。
    from: 'run(() => setHelpOpen((open) => !open));',
    to: 'run(() => {});' },
  { id: 'client-Esc 不先关浮窗', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    // lib/client.js:2491，唯一一处。改坏后：开着浮窗按 Esc 会去关文章，浮窗留在屏幕上。
    from: 'if (helpOpen) {',
    to: 'if (false) {' },
  { id: 'client-浮窗标成 dialog 角色', file: 'lib/client.js',
    judges: ['scroll-dom.test.mjs'],
    // lib/client.js:2269，唯一一处。isTypingTarget 会把 [role=dialog] 内的按键全吞掉（含 Esc）——
    // 鼠标点过一次 ✕ 之后，? 与 Esc 双双失效。判据是「✕ 关闭；焦点落在浮窗里之后…」那条用例。
    from: 'role: "region",',
    to: 'role: "dialog",' },
  { id: 'client-helpOpen 不进依赖数组', file: 'lib/client.js',
    judges: ['overview-scale.test.mjs', 'scroll-dom.test.mjs'],
    // lib/client.js:2534-2538。少了 helpOpen，按键处理器读到的永远是注册那一刻的 false：
    // 浮窗开着按 Esc → 走「关文章」分支，浮窗留在屏幕上（与上面第三条同一个病象、不同根因）。
    from: '\t\t\t\t\troot,\n\t\t\t\t\tstore,\n\t\t\t\t\thelpOpen',
    to: '\t\t\t\t\troot,\n\t\t\t\t\tstore' },
  // ── 自持存储骨架（2026-10-11 大规模存储任务 2）─────────────────────────────────
  // 这三个模块是「下次装载还能不能读到用户数据」的全部承重点，而它们的失效**全都安静**：
  // 版本闸写错 ⇒ 好库被当成坏库拒掉，界面表现是「重启之后订阅全没了」；
  // 订阅文件的版本闸失效 ⇒ 认不出的格式被硬按 v1 解释；目录权限放宽 ⇒ 数据目录变成全机可读。
  // 三条 from 均照**编译产物的真实形状**写（docs/pitfalls.md 一、1.4），并已独立实测 OCCURRENCES=1。
  { id: 'storage-版本闸把好库一起拒了', file: 'lib/storage/db.js',
    judges: ['storage-skeleton.test.mjs'],
    // 删掉「且不是当前版本」这半边后，闸变成「非 0 即拒」⇒ **已经迁移好的库第二次装载就打不开**。
    // 判据：tests/storage-skeleton.test.mjs 的「openDatabase 能重开已经建好的库」。
    from: 'if (onDisk !== 0 && onDisk !== SCHEMA_VERSION) {',
    to: 'if (onDisk !== 0) {' },
  { id: 'storage-订阅文件版本闸失效', file: 'lib/storage/config-file.js',
    judges: ['storage-skeleton.test.mjs', 'store-sqlite.test.mjs'],
    // 版本不认时必须响亮失败（未来格式硬按 v1 解释会丢掉本版不认识的字段）。
    // 判据：tests/storage-skeleton.test.mjs 的「readConfigFile 对损坏/形状不对/版本不认的 config.json 一律抛错」。
    from: 'if (record.version !== CURRENT_CONFIG_VERSION) {',
    to: 'if (false) {' },
  { id: 'storage-目录权限放宽到 0777', file: 'lib/storage/paths.js',
    judges: ['storage-skeleton.test.mjs'],
    // 库里是用户的订阅与已读态；权限放宽后同机其他账户可读，而这一点在界面上完全不可见。
    // 判据：tests/storage-skeleton.test.mjs 的「ensureStorageRoot 递归建出 0700 目录」。
    from: 'mkdirSync(root, { recursive: true, mode: 0o700 });',
    to: 'mkdirSync(root, { recursive: true, mode: 0o777 });' },
  // texts.fetched_at 的 NOT NULL（2026-10-11 终检评审 C1）：DDL 漏掉这个约束时读侧三处都走
  // `requiredText(row.article_fetched_at, ...)`，一条 NULL 行会让 item / listItems / allItems
  // **同时**抛。本版自己的写入口写不出 NULL（articleRecordSchema.fetchedAt 必填），所以这条
  // 是「不可达但可能」的那类守卫 —— 判据不能是行为断言（喂不进 NULL），只能是声明。
  // 判据：tests/storage-skeleton.test.mjs 与 tests/store-sqlite.test.mjs 的「texts.fetched_at
  // 声明 NOT NULL」，前者查 PRAGMA、后者断言直插 NULL 必须抛。
  // ⚠️ from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4）：lib/storage/db.js 里
  // `fetched_at TEXT NOT NULL\n  );` 独立实测 OCCURRENCES=1。
  { id: 'storage-正文抓取时间可空', file: 'lib/storage/db.js',
    judges: ['storage-skeleton.test.mjs', 'store-sqlite.test.mjs'],
    from: 'fetched_at TEXT NOT NULL',
    to: 'fetched_at TEXT' },
  // ── SQLite 版 ReaderStore（2026-10-11 大规模存储任务 3）───────────────────────────
  // 这一族是「换实现之后，旧实现的每一条承诺是否还在」的承重点，而它们的失效大半**安静**：
  // 列表顺序变了、并发已读被抹掉、正文被级联删掉 —— 界面上都只是「好像少了点什么」。
  // 每条 from 均照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4），
  // 并已独立实测 OCCURRENCES=1（在 /tmp 隔离副本里跑过一轮：11/11 全部被抓到）。
  { id: 'store-listItems 退回 JS 全表过滤', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    // 这是**扫描族的结构性修复**（spec §3.1）：把源条件从 SQL 挪走之后，选中哪些行不再由 SQL 决定
    // —— 所以判据是 tests/store-sqlite.test.mjs 里录 prepared SQL 的那条（行为层的「快」不可靠：
    // 一个把全表读回来再过滤的实现同样「快」）。
    // ⚠️ 本条 `to` 的字面实义：`SELECT_ALL_ITEMS.all().map(...)` —— **整表原样返回、连过滤都没有**
    //（不是「读全表再在 JS 里按 feedId 过滤」；那种写法会多一个谓词，与下面的 `to` 不同）。
    from: 'listItems: (feedId) => sql(SELECT_ITEM_BY_FEED).all(feedId).map((row) => {',
    to: 'listItems: (feedId) => sql(SELECT_ALL_ITEMS).all().map((row) => {' },
  { id: 'store-排序退回 published_at', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    // publishedAt 是可选字段：直接对它排序会让缺发布时间的条目落进 SQL 的 NULL 段
    // （SQLite 中 NULL 最小），列表顺序与迁移前不一致（Review Focus 2）。
    // 判据：tests/store-sqlite.test.mjs 的「缺 publishedAt 的行按 fetchedAt 归位」。
    from: "const ITEM_ORDER = ' ORDER BY i.recency DESC, i.id ASC';",
    to: "const ITEM_ORDER = ' ORDER BY i.published_at DESC, i.id ASC';" },
  { id: 'store-updateItem 抹掉并发已读态', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    // 这条守的是**接口存在的理由**（src/store.ts:21-31）：fn 算出的记录被原地覆盖时若丢了
    // 窗口期内并发写进去的 readAt，表现就是 2026-10-10 用户实测的「详情页逐篇读，已读状态丢失」。
    // 判据：tests/store-sqlite.test.mjs 的「原子读改写」那条。
    from: 'const next = itemRecordSchema.parse(fn(toItemRecord(row)));',
    to: 'const next = itemRecordSchema.parse({ ...fn(toItemRecord(row)), readAt: undefined });' },
  { id: 'store-updateItem 缺失键顺手创建', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    // 「写一次就等于创建」会让调用方失去「这条还在不在」的信号（src/store.ts:29）。
    // 判据：tests/store-sqlite.test.mjs 的「对缺失键拒绝」那条。
    from: "throw new Error('updateItem 拒绝：条目 ' + itemId + ' 不在库里。",
    to: "sql(UPSERT_ITEM).run(itemId, itemId, '', '', null, '2026-10-11T00:00:00.000Z', null, null, 0, 0, null); return; throw new Error('updateItem 拒绝：条目 ' + itemId + ' 不在库里。" },
  // ⚠️ **两条「本该有」的变异实测是等价变异，按 AGENTS.md 不入门槛**（2026-10-11 差分实测）：
  //
  // ① 「写条目改用 INSERT OR REPLACE」：REPLACE 会先删旧行、触发 texts 的 ON DELETE CASCADE，
  //    看着必然丢正文 —— 但 `writeItem` 在同一事务里紧接着调 `writeArticle`，正文当场写回。
  // ② 「deleteItem 只删 items、不删 texts」：`PRAGMA foreign_keys` 实测为 1，级联已代劳。
  //
  // 判据是**差分实验**：9 步操作序列（写带正文 → 覆写不带 → 再写带 → 两次 update → 两次 delete
  // → 另一条 save+update），逐条比对可观测状态（store 读回的记录 + items/texts 行数），
  // 三种实现（ON CONFLICT / INSERT OR REPLACE / 只删 items）的输出**逐字节相同**。
  // 它们幸存不是测试缺口 —— 与「正文容器收窄」那条同一个判定方法（见本文件顶部注释）。
  // 判据测试仍在（tests/store-sqlite.test.mjs 的正文级联与孤儿两条），只是它们无法区分这三种写法。
  { id: 'store-版本握手失效', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    // 顺序颠倒（先建 store、后 migrateSchema）若不在构造时拦下，症状是「插件装载成功、
    // 第一次刷新才失败」——那时用户已经白等了一轮网络。
    // 判据：tests/store-sqlite.test.mjs 的「没盖章的库当场响亮失败」。
    from: 'if (onDisk !== SCHEMA_VERSION) {',
    to: 'if (false) {' },
  { id: 'store-读偏好不校验形状', file: 'lib/store-sqlite.js',
    judges: ['nav-persistence.test.mjs', 'store-sqlite.test.mjs'],
    // src/store.ts:41-45 的承诺是「返回的保证是可信形状」；不校验就把媒介里的垃圾透给调用方去兜。
    // 判据：tests/store-sqlite.test.mjs 的「坏值逐字段回落」。
    from: 'viewPreferences: () => sanitizeViewPreferences(readConfigFile(configPath).viewPreferences, isKnownFeed),',
    to: 'viewPreferences: () => readConfigFile(configPath).viewPreferences,' },
  { id: 'store-写偏好覆盖掉订阅映射', file: 'lib/store-sqlite.js',
    judges: ['nav-persistence.test.mjs', 'store-sqlite.test.mjs'],
    // config.json 是用户订阅的**唯一**可备份副本：写偏好时若不先把旧文件读出来，
    // 一次「切了个 filter」就会把订阅列表清空 —— 且不抛错、不留痕。
    // 判据：tests/store-sqlite.test.mjs 的「写偏好不许动订阅映射」。
    from: 'const current = readConfigFile(configPath);\n            writeConfigFile(configPath, { ...current, viewPreferences: safe });',
    to: 'writeConfigFile(configPath, { feeds: {}, version: 1, viewPreferences: safe });' },
  { id: 'store-缺席字段写成 undefined 键', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    // readAt === undefined 是本仓库对「未读」的定义（src/shared.ts:62）。多一个 undefined 值
    // 的键会让 .strict() 的读侧校验与 isUnread 同时失准 —— 「所有条目看起来都没读过」。
    // 判据：tests/store-sqlite.test.mjs 的「可选字段缺席时不留 null / undefined 键」。
    // ⚠️ from 必须**连 if 一起**纳入：只改 `record.readAt = readAt;` 那一行的话，替换出来的是
    // `if (x) if (x) a; else b;` —— 内层 else 永远轮不到执行，等于什么都没改（第一版就是这么写的，
    // 它「幸存」是**变异没生效**，不是测试缺口；docs/pitfalls.md 二、2.7 记的正是这类坑）。
    from: 'if (readAt !== undefined)\n        record.readAt = readAt;',
    to: 'record.readAt = readAt;' },
  { id: 'store-deleteFeed 先删游标后写 config', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    // 退订要动**两处介质**：config.json（文件）与 cursors（库）。它们没有共同事务，
    // 中间失败无法一起回滚 —— 所以「先做哪一步」本身就是正确性，不是风格。
    // 反过来（先删游标）时，config 写不进去（文件损坏 / 磁盘满）会留下「源还在订阅列表里、
    // 游标却没了」：下一轮刷新把整份 feed 当新内容重新导入，用户看到的是已读条目**集体变未读**。
    // 这个顺序最坏只是一条孤儿游标，无害。
    // 判据：tests/store-sqlite.test.mjs 的「deleteFeed 先写 config、后删游标」——
    // 它把 configPath 指成一个目录让写入必失败，再断言**游标仍在**；顺序调换后那条当场翻红。
    // from 照**编译产物**逐字抄，已独立核对 OCCURRENCES=1（docs/pitfalls.md 一、1.4）。
    from: [
      '            writeFeeds(configPath, (feeds) => {',
      '                const next = { ...feeds };',
      '                delete next[feedId];',
      '                return next;',
      '            });',
      '            runInTransaction(() => {',
      '                sql(DELETE_CURSOR).run(feedId);',
      '            });',
    ].join('\n'),
    to: [
      '            runInTransaction(() => {',
      '                sql(DELETE_CURSOR).run(feedId);',
      '            });',
      '            writeFeeds(configPath, (feeds) => {',
      '                const next = { ...feeds };',
      '                delete next[feedId];',
      '                return next;',
      '            });',
    ].join('\n') },
  { id: 'store-老形态正文静默丢正文', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    // 库里没有存 paragraphs 的列。放开这道闸后，一条「只有 paragraphs、没有 blocks」的老记录会被
    // **当成长度为零的新记录**写下去：items 行落库、正文行被删掉，用户在详情页看到正文凭空消失，
    // 而测试若只断言「写入没抛错」就全绿。转换口径只有 domain.ts 的 normalizeLegacyArticle 一处。
    // 判据：tests/store-sqlite.test.mjs 的「拒绝写入老形态正文」。
    from: 'if (article !== undefined && article.blocks === undefined && article.paragraphs !== undefined) {\n            throw new Error(',
    to: 'if (false) {\n            throw new Error(' },
  { id: 'store-正文 fetchedAt 不落列', file: 'lib/store-sqlite.js',
    judges: ['overview-scale.test.mjs', 'store-sqlite.test.mjs'],
    // article.fetchedAt 是 refresh.ts:118 的正文缓存淘汰排序键，缺了整表退化成不可判。
    // 判据：tests/store-sqlite.test.mjs 的「item 把 texts 的正文按 blocks 还原」。
    from: 'article.title ?? null, article.fetchedAt);',
    to: 'article.title ?? null, null);' },
  // ── 订阅完整性闸（2026-10-11 大规模存储任务 4 的迁移下线后搬过来）──────────────
  // 这 6 条（原 `migrate-*`）随 src/storage/migrate.ts 一起删掉了：那条一次性迁移已经完成、
  // 老文件也已从真机删除，路由不再读它 ⇒ 它们的 `from` 在产物里不再存在，留着会被计成
  // 「未应用」而**记成幸存者**（docs/pitfalls.md 二、2.7）。判定本身没有消失，只是搬了家：
  //
  //   · 「认不出就响亮失败，绝不回落成空库」——现在由 assertSubscriptionsNotLost 承担：
  //     config.json 读不出来 ⇒ readConfigFile 带路径抛错；它不在而库里有条目 ⇒ 那次调用抛错。
  //   · 「库里有条目、但订阅文件没了」= 迁移闸门二的原语义，同一条调用（见下）。
  //   · 「老正文形态必须先折成 blocks」——老的那个调用方没了，但转换口径与拒写守卫都还在：
  //     domain.ts 的 normalizeLegacyArticle 由 tests/domain.test.mjs 钉，store-sqlite 的
  //     拒写由 tests/store-sqlite.test.mjs 的「拒绝写入老形态正文」钉（本节末尾那条变异守的就是它）。
  //   · 「不校验域名 / 读不出来当成首次安装」——判据的对象（老域文件的读取）已经不存在。
  //
  // ⚠️ from 照**编译产物**的实际形状写（docs/pitfalls.md 一、1.4）。
  { id: 'storage-订阅丢了却不报错', file: 'lib/index.js',
    judges: ['storage-skeleton.test.mjs'],
    // 把「订阅文件不在（且库里有条目）就抛错」改成「永远放行」⇒ 一次读取失败被静默当成
    // 首次安装，插件带着「有数据、没订阅」的库继续跑，用户看到订阅列表空白而日志里没有一行错。
    // 这正是迁移闸门二当初存在的原因，所以它必须仍然有人看着。
    // 判据：tests/storage-skeleton.test.mjs 的「config.json 缺失且库里有条目 ⇒ 装载必须响亮失败」。
    // ⚠️ 改法只动**值比较**那一半，不碰 configFileMissing：否则同一处里两个判定会被一起
    //    拆掉，翻红就分不清是哪一半在守（等价于把两条判据压成一条）。
    // ⚠️ `stored >= 0` 对任何非负数字恒真（0 与正数都早返回）—— 不是等价变异：条目非空时
    //    守卫的结论与后续行为都变（实测该用例翻红）。
    // ⚠️ from 必须写成**编译产物的两行形状**：tsc 会把 `if (stored === 0) return` 拆行，
    //    单行写法匹配不上 ⇒ 报「未应用」并被计成幸存者（docs/pitfalls.md 一、1.4 与二、2.7）。
    from: 'if (stored === 0)\n            return;',
    to: 'if (stored >= 0)\n            return;' },
  // ── 未读记账与列表取数改 SQL（2026-10-11 大规模存储任务 5）────────────────────────
  // 这一族的失效大半**安静**：账目少算一个源、0 未读的源丢键、清理多删了用户说「别动它」的条目
  // —— 界面上分别是「角标空白」「星标/保持未读的条目凭空消失」，都不报错。
  // 每条 from 均照**编译产物** lib/store-sqlite.js 的真实形状逐字抄，并已独立核对
  // OCCURRENCES=1（docs/pitfalls.md 一、1.4）。
  { id: 'unreadPerFeed-SQL 判据反过来', file: 'lib/store-sqlite.js',
    judges: ['overview-paging.test.mjs', 'store-sqlite.test.mjs'],
    // 未读判据一旦写反（read_at IS NOT NULL），账目就变成「已读数」——而它与「各源之和 === 总未读」
    // 的关系看着仍然自洽（两边一起错），所以只有那条**与 shared.ts 逐键对账**的用例能抓到它。
    // 判据：tests/store-sqlite.test.mjs 的「unreadPerFeed：与 shared.ts 的唯一口径…逐键相等」。
    from: "const SELECT_UNREAD_PER_FEED = 'SELECT feed_id AS feed_id, COUNT(*) AS unread FROM items WHERE read_at IS NULL GROUP BY feed_id';",
    to: "const SELECT_UNREAD_PER_FEED = 'SELECT feed_id AS feed_id, COUNT(*) AS unread FROM items WHERE read_at IS NOT NULL GROUP BY feed_id';" },
  { id: 'unreadPerFeed-丢键域（0 未读的源不留键）', file: 'lib/store-sqlite.js',
    judges: ['overview-paging.test.mjs', 'overview-scale.test.mjs', 'store-sqlite.test.mjs'],
    // 这是本仓库栽过两次的那条（任务 1 的键域、任务 5 的口径）：删掉「先按传进来的键铺 0」之后，
    // 只有**有未读的源**才留键，左栏那一行渲染出来是「角标空白」而不是「角标 0」——
    // 与「角标 0」在界面上无从分辨，是最贵的那类沉默失败。判据是 tests/unread-accounting.test.mjs
    // 的「标空之后 A 的键必须还在」与 tests/overview-scale.test.mjs 的键集断言。
    from: 'unread[feedId] = 0;',
    to: ';' },
  { id: 'cleanup-保持未读不再受保护', file: 'lib/store-sqlite.js',
    judges: ['overview-paging.test.mjs', 'overview-scale.test.mjs', 'store-sqlite.test.mjs'],
    // 用户对 kept-unread 说的是「别动它」，与星标同级（store.ts 的 listCleanupCandidates 契约）。
    // 谓词里少了它，清理会**静默删掉**用户明确标了「保持未读」的条目 —— 不可逆的数据丢失。
    // 判据：tests/overview-scale.test.mjs 的「old-0-1 必须活下来」+ tests/store-sqlite.test.mjs 的候选集对账。
    from: 'AND i.kept_unread = 0',
    to: 'AND i.kept_unread >= 0' },
  { id: 'cleanup-星标不再受保护', file: 'lib/store-sqlite.js',
    judges: ['overview-paging.test.mjs', 'overview-scale.test.mjs', 'store-sqlite.test.mjs'],
    // 星标是用户明确要留的东西（retention.ts 的 selectCleanup 也钉着它）。谓词里少了它，
    // 一次「清理」会把星标旧条目一起删掉，且**没有任何断言会翻红**（除非有这条）。
    from: 'AND i.starred = 0',
    to: 'AND i.starred >= 0' },
  { id: 'listRecent-负数上限下传给 SQLite', file: 'lib/store-sqlite.js',
    judges: ['store-sqlite.test.mjs'],
    // SQLite 把 LIMIT -1 当「无上限」。删掉 JS 侧短路后，「取 300 条」在一处算错成负数时
    // 会静默变成「读回整表」——结果看着还挺对，只有耗时爆炸。
    // 判据：tests/store-sqlite.test.mjs 的「listRecent：… 负数上限 ⇒ 空列表」。
    from: 'if (limit <= 0)\n                return [];',
    to: 'if (false)\n                return [];' },
  // 列表窗口的「放大重取」（Task 5 自审发现）：残留行（退订后没清干净 / 手工改库）会先被取回来、
  // 再因为「所属源已退订」被挡掉，而它们**已经占掉了窗口**。少了这一步，右栏会静默少几条。
  // 判据：tests/endpoints-perfeed-unread.test.mjs 的「已退订源的残留条目…不许把列表的截断窗口占掉」。
  { id: 'overview-列表窗口不再放大重取', file: 'lib/endpoints.js',
    judges: ['endpoints-perfeed-unread.test.mjs'],
    // 首轮取回的 5 条里 4 条是残留行 ⇒ 列表只剩 1 条，而用户看不出少在哪（原实现是先滤后截，不会少）。
    // ⚠️ 2026-10-11 任务 6：取数循环重写（多取一行以判断「后面还有没有」），原锚串消失 ⇒ 本条
    // 改锚到新产物的同一处判定（window 不再放大 = 残留行会被当成「已到底」）。
    from: 'exhausted = rows.length <= window;',
    to: 'exhausted = true;',
  },
  // ── 列表分页 keyset + 客户端契约（2026-10-11 大规模存储任务 6）────────────────────
  // 病象：overview 一次只回 maxItemsShown（默认 300）条且没有续页入口 ⇒ 10 万行下第 301 条之后
  // 在界面上**永远到不了**。这一族各守一个独立的失效面，且失效大半**安静**（少一条、重复一页、
  // 翻不完的循环、幽灵未读）——都不报错，只是数字/列表看着不对。
  // 每条 from 均照**编译产物**的真实形状逐字抄，并已独立核对 OCCURRENCES=1（docs/pitfalls.md 一、1.4）。
  { id: 'paging-续页谓词的 id 方向写反', file: 'lib/store-sqlite.js',
    judges: ['overview-paging.test.mjs'],
    // **缺陷本体**（spec §10.3 的实测）：分页的边界条件是「recency 降序、同 recency 内 id 升序」，
    // 于是下一页的第二个条件是 id **>** id0。方向写反（id < id0）在 recency 打平点上会**重复 + 漏**：
    // 实测 6 行每页 2 条返回 `a d e f`（a 重复、c 漏掉），正确是 `c d e f`。
    // 而 recency 打平是**常态**（同一轮抓取的条目共享 fetchedAt），所以这不是边角。
    //
    // ⚠️ 这里刻意不用行值比较 `(recency, id) < (?, ?)` 当变异体 —— 它的字典序展开**就是**这个方向
    // 错误（spec §10.3），但占位符只剩 2 个而调用方绑 4 个实参，node:sqlite 会抛
    // 「Too many parameter values」⇒ 那条变异会「因为绑定参数不匹配」被抓到，而不是因为断言看见了
    // 重复与漏（那是一条更弱的守卫）。本条把方向单独翻过来，绑定参数个数不变，于是**只有断言**能抓它。
    // 判据：tests/overview-paging.test.mjs 的「页边界正好压在 recency 打平组上」。
    from: "' WHERE i.recency < ? OR (i.recency = ? AND i.id > ?)'",
    to: "' WHERE i.recency < ? OR (i.recency = ? AND i.id < ?)'" },
  { id: 'paging-游标不校验形状（垃圾当第一页）', file: 'lib/shared.js',
    judges: ['overview-paging.test.mjs'],
    // 认不出的游标若被解出一个值，调用方就不再失败 —— 客户端回带的垃圾游标会被当成正常续页。
    // 判据：tests/overview-paging.test.mjs 的「游标认不出时响亮拒绝」与「游标编解码」两条。
    from: "if (!ISO_INSTANT.test(recency) || Number.isNaN(Date.parse(recency)))",
    to: 'if (false)' },
  { id: 'paging-端点不拒绝坏游标', file: 'lib/endpoints.js',
    judges: ['overview-paging.test.mjs', 'overview-scale.test.mjs'],
    // 「解不出就从第一页开始」会让翻页永远翻不完：每页都回同一批条目，界面无限追加重复行，
    // 而用户看到的是一份「永远滚不到底」的列表，不是一句报错。
    // 判据：tests/overview-paging.test.mjs 的「游标认不出时响亮拒绝（bad-request）」。
    from: `                    if (cursor === undefined) {
                        return fail('bad-request', '未知的续页游标（格式应为 "<recency>|<id>"）：' + raw);
                    }`,
    to: '                    if (cursor === undefined) return ok(buildOverview(false));' },
  { id: 'paging-到底也硬给续页游标', file: 'lib/endpoints.js',
    judges: ['overview-paging.test.mjs', 'overview-scale.test.mjs'],
    // 到底时还给游标 ⇒ 客户端一直显示「加载更多」，点下去得到空页（界面上的死按钮）。
    // 判据：tests/overview-paging.test.mjs 的「末页没有 nextCursor」。
    from: 'const nextCursor = lastDelivered >= 0 && (lastDelivered + 1 < rows.length || !exhausted)',
    to: 'const nextCursor = lastDelivered >= 0' },
  { id: 'paging-旧实现谓词的 id 方向写反', file: 'lib/store.js',
    judges: ['overview-paging.test.mjs'],
    // 与自持实现那条同一个失效面（P-7 把游标加在**接口**上 ⇒ 两份实现都得守）。只钉 SQL 一侧的话，
    // 两份谓词哪天分家不会有断言翻红 —— 而生产早已是 createSqliteStore，这份「不用的实现」会悄悄坏掉。
    // 判据：tests/overview-paging.test.mjs 的「旧实现（createStore）：listRecent 的游标谓词…」。
    from: 'return recency < cursor.recency || (recency === cursor.recency && itemId > cursor.id);',
    to: 'return recency < cursor.recency || (recency === cursor.recency && itemId < cursor.id);' },
  // 另三条同义性基线（2026-10-11 终检评审 G1）：`listRecent` 的游标谓词原先**是唯一一条**
  // 「旧实现 ↔ 自持实现」的对照用例，其余三条各自只被钉在「与自己的桩一致」上 ——
  // 两份实现悄悄分家时没有任何断言翻红，而生产早已是 createSqliteStore：坏掉的那份没人用。
  // 本轮在新用例里把**同一份夹具**喂给两边、逐字段 deepEqual（tests/overview-paging.test.mjs
  // 的「逐方法同义性」三条），下面三条变异各自指向其中一条。
  // ⚠️ from 照**编译产物**的真实形状写（docs/pitfalls.md 一、1.4），OCCURRENCES 均独立实测 = 1。
  { id: 'store-旧实现每源账目不铺键域', file: 'lib/store.js',
    judges: ['overview-paging.test.mjs'],
    // 键域退回「条目里出现过的源」⇒ 0 未读的源丢键（左栏那一行的角标变空白而不是 0），
    // 与自持实现「先按 feeds 表铺 0」不再同义。
    // 判据：tests/overview-paging.test.mjs 的「逐方法同义性：unreadPerFeed…逐键相等」。
    from: 'unreadPerFeed: (feedIds) => countUnreadPerFeed(feedIds, [...items.entries()].map(([, record]) => record)),',
    to: 'unreadPerFeed: (feedIds) => countUnreadPerFeed([...items.entries()].map(([, record]) => record.feedId), [...items.entries()].map(([, record]) => record)),' },
  { id: 'store-旧实现正文清单字符数恒 0', file: 'lib/store.js',
    judges: ['overview-paging.test.mjs'],
    // 清算原料的 chars 退回 0 ⇒ 正文缓存闸门以为整库正文一文不值，淘汰名单算出来与自持实现不同
    //（chars 是 articleCharsOf 的第二处调用点，两处分家时这条要翻红）。
    // 判据：tests/overview-paging.test.mjs 的「逐方法同义性：listArticleCacheEntries…」。
    from: 'chars: articleCharsOf(record.article),',
    to: 'chars: 0,' },
  { id: 'store-旧实现候选集放过保持未读', file: 'lib/store.js',
    judges: ['overview-paging.test.mjs'],
    // 去掉「保持未读」的保护后，旧实现会把用户明确说「别动它」的条目交出去当清理候选 ——
    // 与 SQL 谓词（第四项 kept_unread = 0）不再同义，最终删除集也就跟着变宽。
    // 判据：tests/overview-paging.test.mjs 的「逐方法同义性：listCleanupCandidates…」。
    from: 'rows.filter((row) => !row.kept),',
    to: 'rows,' },
  { id: 'paging-续页不追加而是替换', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs', 'nav-selection.test.mjs'],
    // 替换 ⇒ 翻到第二页时第一页整个消失（用户找不到刚读的那条）。
    // 判据：tests/nav-selection.test.mjs 的「续页是追加到列表尾部，不是替换」。
    from: 'items: [...state.items, ...overview.items],',
    to: 'items: overview.items,' },
  { id: 'paging-续页改按本地 items 派生账目', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs'],
    // 缺陷本体在翻页处的复现：第二页开始又拿截断视图当真相 ⇒ 左栏各源之和 ≠ 顶栏总未读。
    // 判据：tests/nav-selection.test.mjs 的「每一页都以宿主回包为准整体覆盖账目」。
    from: 'applyAccount(overview);',
    to: 'set({ unread: overview.items.filter((i) => i.readAt === void 0).length, perFeedUnread: state.perFeedUnread });' },
  { id: 'paging-首屏游标不落 state', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs', 'nav-selection.test.mjs'],
    // 首屏不记游标 ⇒ 界面上永远不出现「加载更多」，第 301 条之后仍然到不了（本任务的缺陷原样留下）。
    // 判据：tests/client-bundle.test.mjs 的「分页接线」+ tests/nav-selection.test.mjs 的分页族。
    from: 'nextCursor: overview.nextCursor,',
    to: 'nextCursor: void 0,' },
  { id: 'paging-客户端不回带游标', file: 'lib/client.js',
    judges: ['client-bundle.test.mjs', 'nav-selection.test.mjs'],
    // 回了 undefined ⇒ 宿主当成第一页，列表原地重复同一批 300 条（用户看到重复而不是报错）。
    // 判据：tests/nav-selection.test.mjs 的「续页是追加…」里的 pageCalls 断言。
    from: 'const overview = await callRpc("overview", { cursor });',
    to: 'const overview = await callRpc("overview", {});' },
  { id: 'paging-在途不挡重复请求', file: 'lib/client.js',
    judges: ['nav-selection.test.mjs'],
    // 连点堆请求：每次都要过一次 SQL + 一次 feeds 文件读，且会把同一页追加两遍。
    // 判据：tests/nav-selection.test.mjs 的「在途时忽略重复的 loadMore」。
    from: 'if (cursor === void 0 || state.loadingMore)',
    to: 'if (cursor === void 0)' },
  // ── 刷新日志按天分文件 + 保留 14 天（2026-10-11 大规模存储任务 7）────────────────────
  // 病象：日志是一个写到天荒地老的单文件（本机实测 503 KB），且与用户数据分居两处。
  // 修法：搬进 storages/rss-reader/，按 UTC 日期分文件，装载时 prune 掉超期的。
  //
  // ⚠️ 这一族「改坏」的代价与别处不同级：**prune 一旦宽了一个字符，删掉的就是用户的订阅真相
  // （config.json）或已读态/星标（rss.db）** —— 不可逆，且界面上只表现为「订阅少了一批」，
  // 不会报错。所以文件名判据与保留窗口边界各钉一条，两条 from 均照**编译产物**
  // lib/storage/log-file.js 的真实形状逐字抄，并已独立核对 OCCURRENCES=1（docs/pitfalls.md 一、1.4）。
  { id: 'log-文件名判据放宽成前缀匹配', file: 'lib/storage/log-file.js',
    judges: ['log-file.test.mjs'],
    // 正则放宽成 `/^reader-/` 后，捕获组 matched[1..3] 全是 undefined ⇒ Date.UTC(NaN,…) 是 NaN ⇒
    // dayMsOf 对**每一个**名字都返回 undefined ⇒ 判据里的 day === undefined 把全部条目跳过。
    // ⚠️ 所以它的真实失效**不是**「删掉 reader- 前缀的邻居」（那需要 dayMsOf 返回一个数字才会走到
    // unlinkSync），而是**保留策略被静默废掉**：从此一份日志都不会被清理，日志目录无限增长，
    // 而 pruner 每次都很「成功」地返回 0 —— 没有任何报错、没有任何日志线索。
    // 判据：tests/log-file.test.mjs 的「只删超期 reader-*.log（含超期邻居必须活着）」
    // 与「保留窗口是闭区间」——两份超期日志必须被删掉，放宽后它们全都留下。
    // lib/storage/log-file.js:29，独立实测 OCCURRENCES=1。
    from: 'const LOG_NAME = /^reader-(\\d{4})-(\\d{2})-(\\d{2})\\.log$/;',
    to: 'const LOG_NAME = /^reader-/;' },
  { id: 'log-认不出的名字被当成可删', file: 'lib/storage/log-file.js',
    judges: ['log-file.test.mjs', 'storage-skeleton.test.mjs'],
    // ⚠️ 本条曾被我按「等价变异」错误地排除过一轮，推导方向是反的：少了 `day === undefined ||` 之后，
    // 判据只剩 `if (day >= cutoff) continue`，而 undefined >= 数字 **恒为 false** ⇒ continue 不执行
    // ⇒ 直接落到 unlinkSync。凡是**认不出的名字**（config.json / rss.db / rss.db-wal / rss.db-shm /
    // notes.txt / reader-backup.log …）都会被当成超期日志删掉 —— 这正是整个模块存在的理由所在：
    // 用户的订阅真相与已读态，不可逆，且界面上只表现为「订阅少了一批」。
    // 判据：tests/log-file.test.mjs 的「只删超期 reader-*.log」与「认不出的名字既不删也不崩」
    // （两条各有一条 deepEqual 名字集合的断言，删掉邻居当场翻红）。
    // lib/storage/log-file.js:102，独立实测 OCCURRENCES=1。
    from: 'if (day === undefined || day >= cutoff)',
    to: 'if (day >= cutoff)' },
  { id: 'log-同名目录不再跳过（EISDIR 抬升为整次失败）', file: 'lib/storage/log-file.js',
    judges: ['log-file.test.mjs'],
    // 去掉「只删普通文件」这道闸后，一个名字恰好合形、且超期的**目录**会直接进 unlinkSync ⇒
    // EISDIR ⇒ 整次 prune 抛错。危害不是「删错东西」，而是**清理从此每次都失败**：
    // 用户会看到反复的清理告警，而真正该删的超期日志一个都删不掉（紧随其后的 unlinkSync 被跳过）。
    // 判据：tests/log-file.test.mjs 的「匹配到同名目录时跳过（EISDIR 不许升级成整次清理失败）」。
    // lib/storage/log-file.js，独立实测 OCCURRENCES=1。
    from: 'if (entry === undefined || !entry.isFile())',
    to: 'if (false)' },
  { id: 'log-保留窗口多留一天（边界偏移）', file: 'lib/storage/log-file.js',
    judges: ['log-file.test.mjs'],
    // keepDays 少减一天 ⇒ 窗口变成「今天 + 前 14 天」= 15 份。这类错**没有症状**：日志多留一份
    // 看起来永远是对的，只有钉在两侧的边界用例能抓到它（只断言「有老文件被删」的用例放走它）。
    // 判据：tests/log-file.test.mjs 的「保留窗口是闭区间：今天 + 前 13 天留，第 14 天前删」——
    // 它断言第 14 天前那份**必须**消失，同时第 13 天前那份**必须**还在。
    // lib/storage/log-file.js:96，独立实测 OCCURRENCES=1。
    from: 'const cutoff = today - (keepDays - 1) * DAY_MS;',
    to: 'const cutoff = today - keepDays * DAY_MS;' },
  // ⚠️ 本轮**刻意没加**的一条（实测判定为**等价变异**，按 AGENTS.md 不入门槛）：
  // 「prune 改成看 mtime」：mtime 判定需要 statSync，改动已经不止一处（要换掉整个循环体），
  // 而它表达的行为差异（文件名 vs 修改时间）已由「对认不出的文件名…且判据只看文件名不看 mtime」
  // 那条用例钉住（6 个认不出的名字 mtime 全设成 2000 年，混进 mtime 就会被一起删掉）。
  //
  // 📌 教训（修复轮 1/5）：本区块原先还排除过一条「删掉 day === undefined 这半边」，理由写的是
  // 「undefined >= cutoff 恒 false ⇒ 同样是 continue」。**这个推导是反的**：`continue` 的语义是
  // 「跳过」，条件为 false 恰恰意味着**不跳过**、继续往下走到 unlinkSync。我把「条件为假」
  // 错读成了「结果为跳过」。本条现已作为 'log-认不出的名字被当成可删' 正式入门槛。
  // 教训的教训：写下「这是等价变异」之前必须按**执行路径**推一遍（哪个分支被走到、走到哪里），
  // 而不是只看表达式的值像不像。docs/pitfalls.md 二、2.7 记的「未应用比幸存更隐蔽」是同一族错误
  // 的另一种形态 —— 两者都源于对「这条变异到底改变了哪次执行」没有真的验证。
  //
  // ── teardown 的「abort → 等落定 → close」顺序（2026-10-13 真机缺陷修复）──────────────
  // 病象（真机日志，两次）：两次成功装载之间夹着 装载失败：Error: database is not open。
  // 根因：teardown 是「abort 之后同步 close」，而在途刷新（装载启动的那轮、或面板点的那轮）
  // 仍在写库 —— refreshNow 早在进入时就用 ready() 把 store 抓走了。
  // 承重点就是这个 wait：去掉它 ⇒ close 又跑到在途刷新前头。
  // 判据：tests/teardown-race.test.mjs 两条（两条走不同的 signal 来源：启动那轮带 controller.signal，
  // 面板那轮一个 signal 都没带 —— 后者正是旧代码完全挡不住的入口）。
  // from 照**编译产物**的实际形状写（docs/pitfalls.md 一、1.4）：lib/index.js:403，独立实测 OCCURRENCES=1。
  // ⚠️ `to` 里刻意**只用产物作用域内存在的东西**（Promise 是全局）：写成引用某个局外名字会退化成
  // ReferenceError，那种红不算被抓住（docs/pitfalls.md 二、2.7b）。
  { id: 'teardown-不等在途刷新就关库', file: 'lib/index.js',
    judges: ['teardown-race.test.mjs'],
    from: 'await Promise.all([generation, inFlight]);',
    to: 'await Promise.resolve();' },
]

// ── 函数化 + 并行化（2026-10-15 变异测试提速，杠杆 B；spec docs/mutation-test-speedup-plan.md）──
// 为什么：原实现是顶层直跑、串行 + 每次全量（138 条 ≈ 14.6min）。提速三杠杆（分层 perf gate /
// 并行 worker / judges 反查）需要同一套判定逻辑服务多条路径，所以拆成下面的可复用函数；
// MUTATIONS 表与崩溃分类器的判定逐字保留（分类器三坑注释原样随迁，改任一条都要重跑）。

// 终审 C1（2026-10-15 实测挂死 40+ 分钟，K=4 干净复跑零推进）：套件与 worker 都必须有时限——
// 否则任一套件在负载下卡死 = 整个门槛无输出、无退出码地永久挂死。
const SUITE_TIMEOUT_MS = 120_000        // 单次套件墙钟上限（正常 ≈7s；超时 ⇒ 判定无效记「套件超时」）
const WORKER_BUDGET_MS = 15 * 60_000    // 单个 worker 总预算（正常全量 ≈4min；超时强制回收并 sweep）

// 「跑一次套件」。root 参数化（隔离副本跑副本、源目录跑基线）；files 省缺 = 全量内环 glob。
function runSuite(root, files) {
  const spec = files === undefined ? 'tests/*.test.mjs' : files.join(' ')
  try {
    const out = execSync('node --test ' + spec + ' 2>&1', { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: SUITE_TIMEOUT_MS })
    return { ok: true, out: out }
  } catch (error) {
    // 超时（SIGTERM 杀）也是「判定无效」：分类器见 timeout 标志记 crashed——红 ≠ 被抓住。
    // ⚠️ signal 要排除 null：正常非零退出的 error.signal 是 null 而不是 undefined（实测踩过：
    //    判式写成 !== undefined 时每一条正常的套件红都被误判成「套件超时」，138 条全 crashed）
    return { ok: false, timeout: error.killed === true || Boolean(error.signal), out: String(error.stdout || '') + String(error.stderr || '') }
  }
}

// 分类器：原 :1009-1023 逐字搬入（含三坑注释）。res.ok 参与 caught/survived 的区分，故入参是 res。
function classify(res, m) {
  if (res.timeout) return 'crashed'
  const mutatedFile = m.file.split('/').pop()
  const outLines = res.out.split('\n')
  // ⚠️ `\\s+`（不是 `\\s*`）：见上面 ② 的两种列 0 形状。
  const errorAt = outLines.findIndex((line) => /^\s+(ReferenceError|SyntaxError):/.test(line))
  const stackMentionsMutatedFile = errorAt >= 0 && outLines
    .slice(Math.max(0, errorAt - 6), errorAt + 7)
    .some((line) => line.includes(mutatedFile))
  if (errorAt >= 0 && stackMentionsMutatedFile) return 'crashed'
  return res.ok ? 'survived' : 'caught'
}

// 崩溃错误名（打印用，与 classify 同一条错误行正则）。
function crashName(res) {
  if (res.timeout) return '套件超时'
  const hit = res.out.split('\n').find((line) => /^\s+(ReferenceError|SyntaxError):/.test(line))
  return (hit && hit.match(/\b(ReferenceError|SyntaxError)\b/) || [])[1] || '未知'
}

// 翻红 → 测试文件基名（去重排序）。gate 校准与 fast 消费同一份口径。
// 实测（2026-10-15 scratch 失败用例）：reporter 的 ✖ 行印的是**测试名**不是文件名；
// 文件名印在紧邻的「test at tests/…」行（失败汇总里在其上方 1 行）与断言栈帧里
// （file:///…/tests/foo.test.mjs:4:10）。⇒ 对每个 ✖ 行在 ±6 行窗口内就近找 tests/*.test.mjs
// 引用，先上后下（汇总节的 at 行在上；就地节的栈帧在下）。
function judgesFromFails(out) {
  const lines = out.split('\n')
  const judges = new Set()
  lines.forEach((line, i) => {
    if (!/^\s*✖/.test(line)) return
    for (let d = 1; d <= 6; d++) {
      for (const j of [i - d, i + d]) {
        if (j < 0 || j >= lines.length) continue
        const m = lines[j].match(/tests\/([\w.-]+\.test\.mjs)/)
        if (m) { judges.add(m[1]); d = 7; break }
      }
    }
  })
  return [...judges].sort()
}

// 隔离副本骨架（docs/pitfalls.md §1.3：变异门槛绝不在源目录改 lib/）。
// 副本必须忠实于「测试可见面」（两条实测教训，2026-10-15 校准轮）：
//   · node_modules——tests/lib import zod 等第三方包，缺了假红；
//   · src/——article.test.mjs:254 与 client-bundle.test.mjs:266 直接读源树文件
//     （抽取版本守护、产物 mtime 新鲜度），缺了这两个用例对**任何**变异都翻红，
//     快照里 138 条全部带噪声（探针：keys 变异下两用例必炸，非断言看见缺陷）。
// .git / .worktrees 不拷（worktree 里是整份检出副本，拷了既慢又可能级联）。
function seedWorkerCopy(workerRoot) {
  for (const entry of ['lib', 'tests', 'scripts', 'src', 'node_modules', 'package.json']) {
    cpSync(path.join(ROOT, entry), path.join(workerRoot, entry), { recursive: true, preserveTimestamps: true })
  }
}

// 应用一条变异（原 :953-963 的逐条子逻辑）。ok:false = 「未应用」——比幸存更隐蔽（pitfalls 二、2.7）。
function applyMutation(root, m) {
  const target = path.join(root, m.file)
  const original = readFileSync(target, 'utf8')
  const mutated = original.replace(m.from, m.to)
  if (mutated === original) return { ok: false, original }
  writeFileSync(target, mutated)
  return { ok: true, original }
}

// 大头在前：同文件条目经排序后轮转均分 ⇒ 任何单 worker 都不会独吞整个 client 族（50 条是大头）。
const FILE_PREFIXES = ['lib/client.js', 'lib/store-sqlite.js', 'lib/refresh.js', 'lib/keys.js',
  'lib/retention.js', 'lib/store.js', 'lib/endpoints.js', 'lib/identity-repair.js',
  'lib/feed/', 'lib/storage/', 'lib/article.js', 'lib/list-scroll.js', 'lib/index.js',
  'lib/domain.js', 'lib/shared.js', 'lib/subscribe.js', 'lib/config.js']
function partitionMutations(mutations, n) {
  const rank = (file) => { const i = FILE_PREFIXES.findIndex((p) => file.startsWith(p)); return i === -1 ? FILE_PREFIXES.length : i }
  const sorted = [...mutations].sort((a, b) => rank(a.file) - rank(b.file))
  return Array.from({ length: n }, () => []).map((_, i) => sorted.filter((__, j) => j % n === i))
}

// worker 侧脚本：把主进程的 runSuite / classify / applyMutation / crashName **函数源码序列化**进去
// （Function.prototype.toString）——三条路径共用同一份实现，worker 里不维护第二份判定逻辑。
// 结果用 postMessage 回传；worker 内任何异常都记成 crashed，不许静默吞掉一条变异。
function buildWorkerScript(workerRoot, mutations) {
  return `
const { execSync } = require('node:child_process')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')
const { parentPort } = require('node:worker_threads')
const root = ${JSON.stringify(workerRoot)}
// 时限常量随函数一起序列化（C1 修复轮实测：runSuite 引用而模板缺失 ⇒ worker 里 ReferenceError
// 被 runSuite 的 try/catch 吞成 ok:false ⇒ 基线卫兵判「副本基线红」——卫兵拦下了它，但不能靠它兜）
const SUITE_TIMEOUT_MS = ${JSON.stringify(SUITE_TIMEOUT_MS)}
const WORKER_BUDGET_MS = ${JSON.stringify(WORKER_BUDGET_MS)}
const mutations = ${JSON.stringify(mutations)}
const runSuite = ${runSuite.toString()}
const classify = ${classify.toString()}
const crashName = ${crashName.toString()}
const judgesFromFails = ${judgesFromFails.toString()}
const applyMutation = ${applyMutation.toString()}
// 副本基线卫兵：副本不忠实（如 mtime 反超让 client-bundle:265 必红）⇒ 每条变异的套件必红 ⇒
// 「幸存 0」就是空洞判据。基线红 ⇒ 本副本全部变异记 worker_error，主进程计入失败清单。
const base = runSuite(root)
if (!base.ok) {
  for (const m of mutations) parentPort.postMessage({ id: m.id, status: 'worker_error', crash: '副本基线红', fails: [], judges: [] })
} else for (const m of mutations) {
  try {
    const applied = applyMutation(root, m)
    if (!applied.ok) { parentPort.postMessage({ id: m.id, status: 'unapplied' }); continue }
    let res
    const startedAt = Date.now()
    try { res = runSuite(root) } finally { writeFileSync(path.join(root, m.file), applied.original) }
    const fails = res.out.split('\\n').filter((l) => /^\\s*✖/.test(l)).map((l) => l.trim().replace(/\\s*\\(\\d.*$/, ''))
    const judges = judgesFromFails(res.out)
    const verdict = classify(res, m)
    // 逐条回传即打印（终审 C1 教训：挂死 40 分钟零输出——进度必须实时可见；worker stdout 直通主进程）
    console.log('  · ' + m.id.padEnd(26) + ' → ' + verdict + '（' + (Date.now() - startedAt) + 'ms）')
    parentPort.postMessage(verdict === 'crashed' ? { id: m.id, status: 'crashed', crash: crashName(res), fails, judges } : { id: m.id, status: verdict, fails, judges })
  } catch (error) {
    parentPort.postMessage({ id: m.id, status: 'crashed', crash: 'worker 内异常：' + error.message, fails: [] })
  }
}
`
}

function runWorker(workerRoot, mutations) {
  return new Promise((resolve) => {
    const worker = new Worker(buildWorkerScript(workerRoot, mutations), { eval: true })
    const results = []
    const sweep = (why) => {
      clearTimeout(deadline)
      // worker 本体崩了（eval 失败 / 未捕获异常 / 非零退出 / 超预算）：没回传结果的变异全部记 crashed，不许静默丢
      for (const m of mutations) {
        if (!results.some((r) => r.id === m.id)) results.push({ id: m.id, status: 'crashed', crash: why, fails: [] })
      }
      resolve(results)
    }
    // worker 总预算（终审 C1 第二道网）：卡死的 worker 强制回收，由 sweep 收尾
    const deadline = setTimeout(() => { worker.terminate(); sweep('worker 超预算 ' + WORKER_BUDGET_MS + 'ms——强制回收') }, WORKER_BUDGET_MS)
    worker.on('message', (r) => results.push(r))
    worker.on('error', (error) => sweep('worker 未捕获：' + error.message))
    worker.on('exit', (code) => { if (code !== 0) sweep('worker exit ' + code); else { clearTimeout(deadline); resolve(results) } })
  })
}

function parseArgs(argv) {
  // 默认 K=6：spec §3 实测的安全包线（8 并发曾在 100ms 级时序断言上翻红，I1 拆分前）；宁可保守
  const args = { mode: 'gate', workers: Math.min(6, Math.max(1, os.cpus().length - 2)), dumpJudges: undefined, only: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--mode') args.mode = argv[++i]
    else if (a === '--workers') args.workers = Number(argv[++i])
    else if (a === '--dump-judges') args.dumpJudges = argv[++i] ?? true
    else if (a === '--mutations') args.only = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean)
    else { console.error('未知参数: ' + a); process.exit(2) }
  }
  return args
}

// 汇总（原 :1032-1040 的判定与文案逐字保留；applied 口径 = 除「未应用」外全部计入，同原实现）。
function collectResults(results) {
  const survivors = []
  let applied = 0
  for (const r of results) {
    if (r.status === 'unapplied') {
      console.log('  ?  ' + r.id.padEnd(26) + ' 未应用（产物里形状与预期不符，请同步更新本条）')
      survivors.push(r.id + '（未应用）')
    } else if (r.status === 'crashed') {
      applied += 1
      console.log('  !  ' + r.id.padEnd(26) + ' 崩了（' + (r.crash || '未知') + '：变异 `to` 自己写错了，不算被抓住 —— 请改 `to`）')
      survivors.push(r.id + '（崩了：' + (r.crash || '未知') + '）')
    } else if (r.status === 'worker_error') {
      applied += 1
      console.log('  !  ' + r.id.padEnd(26) + ' 副本基线红（判定无效——先修副本忠实化，重跑门槛）')
      survivors.push(r.id + '（副本基线红）')
    } else if (r.status === 'survived') {
      applied += 1
      console.log('  x  ' + r.id.padEnd(26) + ' 幸存（套件仍然全绿）')
      survivors.push(r.id)
    } else {
      applied += 1
      console.log('  v  ' + r.id.padEnd(26) + ' 被抓到（' + (r.fails?.length ?? 0) + ' 条翻红：' + (r.fails?.[0] || '').slice(0, 44) + '）')
    }
  }
  return { applied, survivors }
}

// judges 快照落盘（杠杆 A 前置）：gate 全量轮的实测翻红就是「哪些测试看着这条变异」的快照——
// fast 只跑这些文件的前提是快照采自 gate（gateRed ⊆ judges 由构造成立，spec §5）。
// crashed / survived / unapplied 不进快照：它们本来就令 gate exit 1，没有「看着谁」可言。
function writeJudgesDump(file, results, selected) {
  const mutations = {}
  for (const r of results) {
    if (r.status !== 'caught') continue
    const m = selected.find((x) => x.id === r.id)
    mutations[r.id] = { file: m ? m.file : '', judges: r.judges ?? [] }
  }
  writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), suiteGlob: 'tests/*.test.mjs', mutations }, null, 2))
  console.log('judges 快照已写入 ' + file + '（' + Object.keys(mutations).length + ' 条）')
}

// 退出码契约（spec §0）：gate 干净=0 / gate 失败=1 / 基线红=2；fast 一律非 0——全抓到=3、
// 有任何非抓到=4。fast 通过 ≠ gate 通过：fast 是建议通道，只有 gate 干净才允许 exit 0。
function exitCodeFor(mode, ok) {
  return mode === 'fast' ? (ok ? 3 : 4) : (ok ? 0 : 1)
}

// fast 内环（杠杆 A）：judges 是 gate 轮的快照，只跑每条变异真正翻红的文件并集。
// 漂移兜底（spec §7）：judges 缺失或指向不存在的文件 ⇒ 计「未应用」入失败清单，绝不静默跳过；
// 副本基线红 ⇒ 全部记失败，本轮不给出任何建议。结论只是建议，gate 永远权威。
async function runFast(args, selected) {
  const workerRoot = mkdtempSync(path.join(os.tmpdir(), 'mutation-fast-'))
  const results = []
  try {
    const sub = path.join(workerRoot, 'w0')
    mkdirSync(sub, { recursive: true })
    seedWorkerCopy(sub)
    const baseline = runSuite(sub)
    if (!baseline.ok) {
      console.error('fast：隔离副本基线红——副本或快照不可信，本轮不给出建议。')
      for (const m of selected) results.push({ id: m.id, status: 'crashed', crash: '副本基线红', fails: [], judges: [] })
    } else {
      console.log('fast：基线绿。只跑 judges 并集（' + selected.length + ' 条；建议通道，gate 永远权威）：')
      console.log('')
      for (const m of selected) {
        const declared = [...new Set(m.judges ?? [])]
        const files = declared.filter((f) => existsSync(path.join(sub, 'tests', f)))
        if (declared.length === 0 || files.length !== declared.length) {
          console.log('  ?  ' + m.id.padEnd(26) + ' judges 缺失或指向不存在的测试文件——计「未应用」（漂移兜底：重跑 mutation:calibrate）')
          results.push({ id: m.id, status: 'unapplied', fails: [], judges: [] })
          continue
        }
        const applied = applyMutation(sub, m)
        if (!applied.ok) {
          console.log('  ?  ' + m.id.padEnd(26) + ' 未应用（产物里形状与预期不符，请同步更新本条）')
          results.push({ id: m.id, status: 'unapplied', fails: [], judges: [] })
          continue
        }
        let res
        try { res = runSuite(sub, files.map((f) => 'tests/' + f)) } finally { writeFileSync(path.join(sub, m.file), applied.original) }
        const fails = res.out.split('\n').filter((l) => /^\s*✖/.test(l)).map((l) => l.trim().replace(/\s*\(\d.*$/, ''))
        const verdict = classify(res, m)
        const redJudges = judgesFromFails(res.out).filter((j) => files.includes(j))
        const mark = verdict === 'caught' ? 'v' : verdict === 'crashed' ? '!' : 'x'
        const label = verdict === 'caught'
          ? '被 ' + (redJudges.join('、') || '未知文件') + ' 翻红（' + fails.length + ' 条）'
          : verdict === 'crashed'
            ? '崩了（' + crashName(res) + '：变异 `to` 自己写错了，不算被抓住）'
            : '幸存（judges 文件全绿——建议仅供参考，以 gate 为准）'
        console.log('  ' + mark + '  ' + m.id.padEnd(26) + ' ' + label)
        results.push({ id: m.id, status: verdict, fails, judges: redJudges })
      }
    }
  } finally {
    rmSync(workerRoot, { recursive: true, force: true })
  }
  const applied = results.filter((r) => r.status !== 'unapplied').length
  const survivors = results
    .filter((r) => r.status !== 'caught')
    .map((r) => r.id + (r.status === 'unapplied' ? '（未应用）' : r.status === 'crashed' ? '（崩了：' + (r.crash || '') + '）' : ''))
  console.log('')
  console.log('应用 ' + applied + '/' + selected.length + ' 条 · 幸存 ' + survivors.length + ' 条（fast 退出码恒非 0——fast 通过 ≠ gate 通过）')
  if (survivors.length > 0) console.error('幸存清单：' + survivors.join('、'))
  process.exitCode = exitCodeFor('fast', survivors.length === 0)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const selected = args.only ? MUTATIONS.filter((m) => args.only.includes(m.id)) : MUTATIONS
  if (selected.length === 0) { console.error('--mutations 没匹配到任何条目'); process.exitCode = 2; return }
  if (args.mode === 'fast') { await runFast(args, selected); return }
  if (args.mode !== 'gate') { console.error('--mode ' + args.mode + ' 不认识（gate | fast）'); process.exitCode = 2; return }

  const baseline = runSuite(ROOT)
  if (!baseline.ok) {
    console.error('基线不是绿的 —— 先修好再跑变异。')
    console.error(baseline.out.split('\n').filter((l) => /^\s*(✖|not ok)/.test(l)).slice(0, 5).join('\n'))
    process.exitCode = 2
    return
  }
  console.log('基线绿。逐条改坏关键判定，看套件是否见红：')
  console.log('')

  const workerRoot = mkdtempSync(path.join(os.tmpdir(), 'mutation-gate-'))
  let results
  try {
    const n = Math.max(1, Math.min(args.workers || 1, selected.length))
    const buckets = partitionMutations(selected, n)
    const running = []
    for (let i = 0; i < buckets.length; i++) {
      if (buckets[i].length === 0) continue
      const sub = path.join(workerRoot, 'w' + i)
      mkdirSync(sub, { recursive: true })
      seedWorkerCopy(sub)
      running.push(runWorker(sub, buckets[i]))
    }
    results = (await Promise.all(running)).flat()
  } finally {
    rmSync(workerRoot, { recursive: true, force: true })
  }

  // 打印顺序对齐 MUTATIONS 定义序（并行回传顺序不定）
  const order = new Map(selected.map((m, i) => [m.id, i]))
  results.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  const { applied, survivors } = collectResults(results)
  if (args.dumpJudges !== undefined) writeJudgesDump(args.dumpJudges === true ? 'judges-dump.json' : args.dumpJudges, results, selected)

  const after = runSuite(ROOT)
  console.log('')
  console.log('应用 ' + applied + '/' + selected.length + ' 条 · 幸存 ' + survivors.length + ' 条 · 恢复后基线 ' + (after.ok ? '仍然绿' : '没恢复干净！'))
  if (survivors.length > 0) {
    console.error('幸存清单：' + survivors.join('、'))
    console.error('-> 标「幸存」的是测试没覆盖到的判定（补一条会翻红的断言，或确认它是等价变异）；')
    console.error('   标「崩了」的：变异 `to` 自己写错了（ReferenceError / SyntaxError），那种红不算被抓住（docs/pitfalls.md 二、2.7b）。')
    process.exitCode = 1
    return
  }
  console.log('全部被抓到。')
}

main().then(() => process.exit(process.exitCode ?? 0))
