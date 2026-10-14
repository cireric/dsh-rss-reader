# 大规模订阅（200 源 × 500 条）存储方案说明书

> **本文用途**：钉住「订阅规模到 50–100 源、目标 200 源 × 每源 500 条 ≈ 10 万条目」时
> 数据存在哪、容量预算是多少、为什么这么选。
>
> **🔒 已冻结（2026-10-11）**：§0–§9 是实现与测试的依据。实现期发现新事实需要改动时，
> **改本文并在下方「冻结后改动」记录一行**（日期 + 改了什么 + 依据）；不要悄悄改。
> 任务分解不在这里——见实施计划 `docs/superpowers/plans/2026-10-11-large-scale-storage.md`。
>
> **冻结后改动**（按上文规则逐条记录）：
> - 2026-10-11 · 自审：①§1.2/§2 的常驻堆口径由 68 MiB 校正为 **39 MiB**（旧值同时持有原文串，
>   依据 = `npm run bench` 复测）；②§10.2 与 §2 漏项表：**`summary` 不再需要外置**（取 ③ 后它留在
>   items 行内，只有正文进 `texts` 表），旧推论「只做 ①② 需 100–170 MB」随之修正为 65–80 MB；
>   ③§11.2 的 `§6.3` 引用改为 `§10`（章节已重编号）。
> - 2026-10-11 · 定稿加固（实施前复核）：④§10 新增 **§10.3「keyset 谓词」**——原计划的
>   `(recency, id) < (?, ?)` **是错的**（实测会重复并漏条目），必须用 OR 形式；
>   ⑤§11.2 的 `items`/`texts` 参考 schema 补齐 `summary`、`article_failure` 与正文版本列，
>   使它与 §10.2「`summary` 留在 items 行内、只有正文进 `texts`」自洽（原 schema 两项都缺）。
> - 2026-10-11 · 实现期发现（Task 3，`源码核对`）：⑥§11.2 的 `texts` 还缺 **`fetched_at`**——
>   `articleRecordSchema.fetchedAt` 是**必填**（`src/domain.ts:58`），且是正文缓存淘汰的排序键
>   （`src/refresh.ts:118` 的 `record.article?.fetchedAt`）。原参考 schema 无列可放它，会导致
>   「缓存超限从最旧清起」退化成整表不可判（全部时间戳相同）。实现已加该列，此处同步。
> - 2026-10-11 · 实施收尾（Task 8）：⑦本文 §4.6 提到的「删除 openDomainWithRetry + 孤儿句柄接管」
>   与 §7 的「开域后全表跑 normalizeLegacyArticles」两条待删项**已执行**；`inject` 里的
>   `storageDomain` 声明也摘掉。**但 `peerDependencies` 与 `build.sh` 的 `link_pkg` 保留**：
>   `src/domain.ts` 的 `defineDomain` 是运行期 import、`src/store.ts` 是 import type，
>   删掉那条 link 后从零 build 直接 TS2307 ×2（实测，隔离副本里复现）。
>   存活的存储域对象只剩 `src/store.ts` 的 `createStore` 与 `src/domain.ts` 的 `readerDomain`
>   （测试的「旧实现 ↔ 新实现」同义性基线用，且是变异门槛的判据，不在装载路径上）——
>   所以本 spec 「100% 自持、不再使用 ctx.storageDomain」的结论仍然成立，无正文改动。
> - 2026-10-11 · 实施期发现（Task 9，`实测`）：⑨**§9.3 的「常驻内存 ≤ 300 MB」对新增的按轮全表读取**
>   一度不成立：`store.allItems()` 一次物化 10 万条带正文的记录，堆峰值 **1865 MB**（超 6.2 倍）。
>   落地形态改为 `listArticleCacheEntries()` + `.iterate()`（只交 `{id, chars, fetchedAt}`、逐行流式），
>   同夹具 **60.4 MB**，该路径回到线内。⚠️ **进程 RSS 仍约 1359 MB，绝大部分是 SQLite 页缓存**，
>   本轮未动 `PRAGMA cache_size` —— 本条只声明「正文缓存这条路径在 300 MB 内」，不声明整个进程。
>   详见计划 §Task 9 的实测阶梯（**1865/922/60.4 MB** 三级对照），以及正文 §冻结后改动 ⑦ 的表格。
> - 2026-10-11 · 实施期发现（Task 10，`实测`）：⑩§6 第 1 条说「按陈旧度调度（每轮取最旧的 K 个源）」，
>   但**没说排序键是什么**。落地取 `lastAttemptedAt ?? lastFetchedAt`（成功/304/**失败**都盖前者）：
>   只用「上次成功」做键时，**永久失败的源永远停在最陈旧端**，一旦失败源数 ≥ K 就霸占每轮窗口、
>   健康源再也抓不到（实测 200 源 20 失败 K=20 ⇒ 0/180 覆盖；3 源 1 失败 K=1 ⇒ 0/2）。
>   `lastFetchedAt` 保留「上次**成功**」语义（界面契约依赖它），故新增可选字段，老库无需迁移。
>   同时新增配置字段 `refreshFeedsPerRound`（默认 20）：§6 只说「取最旧的 K 个」，未定 K 从何而来；
>   有界 + 陈旧度优先是该调度**不饿死任何源**的前提。§6 的「并发提到 8–12」**未采纳**——见下。
> - 2026-10-13 · 迁移下线（用户拍板，`实测`）：⑪**真机那次迁移已跑完且成功**（8 源 / 158 条 /
>   67 份正文），老文件 `storages/rss_reader.json` 与旧日志目录已在备份验证后删除 ⇒ 本文 §3.2 /
>   §10 里的 `migrateFromDomainFile` 从装载路径**删除**，`src/index.ts` 改为
>   `ensureStorageRoot → openDatabase → migrateSchema → assertSubscriptionsNotLost → createSqliteStore`。
>   迁移的闸门二（「库里有条目、订阅那份却没写成」）搬进 `assertSubscriptionsNotLost`，行为不变；
>   §8 的「迁移有一堵墙」（老文件越过 512 MiB 就读不动）与 §11 里「只读它」的复现前提**随之失效**
>   （那个文件已不存在），保留原文只为留档。**正文的结论（100% 自持、订阅真相在 config.json）不变。**
> **状态**：选型已拍板（§9.1）；先决条件「备份覆盖」已完成（§9.2）；**插件实现已全部落地**（任务 2–10）。
> ⚠️ **两条仍待测**（不因实现落地而改变）：§6 的「并发提到 8–12」与 §9.3 网络侧两条——
> `refreshConcurrency` 保持 5 并在 `src/config.ts` 记明「未实测」与其测量方案（20 个真实源、
> 扫 {1,2,4,5,8,12}、记录（并发, 中位墙钟, 超时数））。合成基准只能证明旋钮有效，不能定这个值。
>
> 证据等级沿用仓库约定：`实测`（本机真跑）/ `源码核对`（带 file:line）/
> `外推`（由实测线性推得，写明算式）/ `估算`（无样本兜底）。
> 实测环境：macOS + Node v24.19，2026-10-11。
> 所有 10 万行数字都来自**合成样本**：把当前 114 条真实条目的平均形状复制到 10 万条。
> 样本偏差见 §8，不要把这些数当真实负载的读数。

## 0. 现状（源码核对）

> 下表路径：`src/**` 相对本仓库根；`packages/storage/**` 指 DSH 检出
> `/Users/eric/Project/tests/deepseek-harness`（上游，本方案不改它）。

| 事实 | 位置 |
|---|---|
| 条目上限是**每源** 500 条（软上限，星标/保持未读可突破），无全局上限 | src/config.ts:50, src/retention.ts:34-37 |
| 去重窗口每源 5000 个 id；摘要 50 000 字符/条；正文缓存 8 000 000 字符/**每源** | src/config.ts:51-53 |
| 面板一次取 maxItemsShown = 300 条（不是分页） | src/config.ts:61, src/endpoints.ts |
| 落盘介质：storage domain `rss_reader` v1，三张表 + 一个 global 单例槽 | src/domain.ts:171-207 |
| 编排只依赖窄接口 `ReaderStore`（换实现不碰 refresh/endpoints） | src/store.ts:11-49 |
| JSON 后端 single 布局：**整份文件一次读入、每次写入整份原子重写** | packages/storage/storage-json/src/single-unit.ts:3-8, :33-40 |
| domain 运行时：**权威内存态 + 同步读**，打开即 `loadAll()` + 逐条 zod 校验 | packages/storage/storage-domain/src/domain.ts:1-9, src/index.ts:119-143 |
| `routes` 只能换介质，换不掉内存模型；`KvUnit` 无查询/分页 | storage-domain/src/index.ts:47-62 |
| 域 spec 删表**向后兼容**：设施只遍历声明过的表，老文件里未声明的表数据被忽略 | storage-domain/src/index.ts:121 |
| 未读账目由宿主全表扫描算出（客户端整体接收，不从 items 派生） | src/client/store.ts:387-399 |
| **域文件的落盘路径不由插件决定**：`root` 来自 base bundle 装配行；文件名恒为 `<root>/<域名>.json`；域名须匹配 `^[a-z][a-z0-9_]*$`（连字符非法）；`storage-domain` 的 Config 只有 `backend` / `routes`（域名→后端名），没有「域名→路径」 | packages/bundle/base/cordis.patch.yml:168-171, storage-json/src/single-unit.ts:33, storage/src/backend.ts:10, storage-domain/src/index.ts:52-62 |
| **插件自持存储有官方先例**：dsh-cost-meter 完全不用 `ctx.storageDomain`，自算 `$DSH_HOME/storages/cost-meter/`，自带目录锁、version 字段与原子写 | dsh-cost-meter/lib/store.js:1987, lib/ledger-persistence.js:17-60 |

## 1. 三条硬约束（决定方案的依据）

### 1.1 单份 JSON 文件 > 512 MiB 就打不开（不是慢，是抛错）

`实测` `buffer.constants.MAX_STRING_LENGTH` = 512 MiB（536 870 888 字符）；
构造 600 MiB 文件后 `fs.readFileSync(path, 'utf8')` 直接抛
`ERR_STRING_TOO_LONG: Cannot create a string longer than 0x1fffffe8 characters`。
JSON 后端的 single 布局正是整份 `readFileSync`（single-unit.ts:33-40）⇒ **域文件一旦超过 512 MiB，
插件连开域都做不到**，没有「降级但可用」这条路。

### 1.2 内存放大（实测口径已校正）

`实测` 解析后经两次 GC 的常驻堆：纯元数据 10 万行 = **39 MiB 堆** / 30.7 MiB 文件（≈1.3×，
口径见 §2 的说明；早期测得的 68 MiB 是在同时持有原文串时测的）；
元数据 + 2 KB 预览 = 458 MiB / 221 MiB（2.1×）；4000 行当前形状 = 243 MiB / 67.3 MiB（3.6×）。
放大来自「解析出的对象图 + zod 校验产物 + 原文串」，且**与后端无关**——换 SQLite 后端也照旧，
因为 domain 打开时仍全量载入（domain.ts:1-9）。

### 1.3 写入成本是 O(N)，不是 O(1)

`实测` single 布局每次写入重发整份文件：1.84 MiB → 2.3 ms；67.3 MiB（4000 行）→ ≈70 ms；
30.7 MiB（10 万行纯元数据）→ 中位 8.2 ms / 峰值 31.8 ms。

`外推` 由上述每字节成本线性推得：

| 场景 | 算式 | 结果 |
|---|---|---|
| 首次导入 10 万条 | 10 万次整份重写，文件从 0 长到 30.7 MiB | **≈7–14 分钟** |
| 单源「全部标为已读」500 条 | 500 × 8.2 ms | ≈4.1 s |
| 同上，但停在当前 4000 行设计 | 500 × 70 ms | ≈35 s |
| 对比：SQLite 单事务插入 10 万行 | `实测` | **0.99–1.2 s** |

### 1.4 三条约束各自逼出哪一步（2026-10-11 补，纠正论证重心）

> **术语**（本节沿用初版阶梯的编号，便于对照历史）：
> ① = 只改配置减字节（`maxContentChars` / `maxArticleCacheChars` / `maxSeenPerFeed`）；
> ② = 正文外置、元数据留域；③ = 把条目整体搬出设施。
> **本方案取 ③**，① 缩减后作为附带项保留（见 §10.1）。

原文把 ①②③ 排成阶梯，却没写「② 为什么不够」。补上：

- **§1.1 的墙只逼出第 ① 步**。墙只被**当前行形状**（≈1.4 GiB）打破，而步骤 ①（改三个配置值）
  就把 10 万行压到 30–60 MiB——距 512 MiB 墙还有 8–17 倍余量。**墙是「做 ①」的理由，
  不是「做 ③」的理由。**
- **§1.3 与 §3.1 的扫描族才逼出第 ③ 步**。① 修不掉写入放大：一源 500 条全标已读仍是
  4.1 s（`外推`），这是体验级缺陷。②（正文外置、元数据留域）也修不掉它——每次改一条
  仍要重写整份域文件。只有把写入降到「一行」才修得掉。
- 因此 **② 与 ③ 不应拆成两级台阶**：② 的收益是过渡性的，代价（两次迁移、两套落点）
  却是一次性的。本方案直接取 ③（§4）。

## 2. 容量预算：10 万条目在三种行形状下的代价

| 行形状 | 字节/行 | 文件 | 打开（parse / +zod 校验） | 打开后常驻堆 | 单次整份重写 |
|---|---|---|---|---|---|
| 当前形状（均值，摘要占 8.8 KB） | 14 916 | ≈1.4 GiB（`外推`） | **打不开**（越 512 MiB 硬墙） | — | — |
| 元数据 + 2 KB 正文预览 | 2 316 | 221 MiB | 187 ms | 458 MiB | ≈230 ms（`外推`） |
| 纯元数据（无摘要、无正文） | 315 | 30.7 MiB | 31 ms + 37 ms | 68 MiB | 8.2 ms / 31.8 ms 峰值 |

> **⚠️ 上表「常驻堆 68 MiB」与 `npm run bench` 复测的 39 MiB 不一致（2026-10-11 自审发现）**：
> 两者测的不是同一件事。上表（§11.1 脚本）在测量时**同时持有** JSON 原文串与解析结果，
> 而 `scripts/scale-bench.mjs` 只持有解析结果（原文串在 parse 后即不再被引用）。
> **本 spec 后续引用一律用 39 MiB**（那是实际运行时的常驻量，原文串在 parse 后会被回收）。
> 68 MiB 保留在此仅供对照 §11.1 的历史输出。

结论：**字节数由正文决定，行数由元数据决定。** 把正文移出行外，「10 万行」立刻从
「打不开」变成「30 MiB / 39 MiB 堆 / 8 ms 写」——同一套设施能扛住。

**⚠️ 该表只算了 items 行，漏了两项（2026-10-11 补，`估算`）：**

| 漏项 | 量 | 说明 |
|---|---|---|
| `cursors` 表的去重窗口 | 200 × 5000 = 100 万 id ≈ 35 MB 纯文本；V8 堆另算（60–100 MB） | 步骤 ① 降到 2000 后仍约 14 MB / 25–40 MB |
| 列表预览 | 客户端用 `item.summary` 渲染展开视图（src/client/index.tsx:641） | **取 ③ 后不再是问题**：summary 留在 items 行内（§10.2），只需注意库体积 |

⇒ 「域 = 30.7 MiB / 39 MiB 堆」只在**不含去重窗口**时成立。补上它之后，「只做 ①②」的
常驻量在 65–80 MB 量级（39 + 去重窗口 25–40，`估算`），仍在 300 MB 线内。

**这条推论的意义（2026-10-11 自审后重述）**：如果目标只是「装得下、打得开」，步骤 ①② 就够了。
逼出 ③ 的不是容量，是 §1.3 的写入放大（一源 500 条全标已读 4.1 s）——`npm run bench` 的
10 万行基线印证了这点：打开 70 ms 与常驻 39 MiB 两条验收线**现状就已达标**，只有批量标已读不达标。
`maxSeenPerFeed` 降档因此**不做**（§10.1）：它压的是本就不紧迫的内存，代价却是削弱去重。

## 3. 目标规模的旁账（不只是存储）

| 项 | 现状 | 200 源下的账 | 等级 |
|---|---|---|---|
| 去重窗口 | 每源 5000 个 32 字符 id | 200 × 5000 = 100 万 id ≈ 35 MB 纯文本，堆更高 | `估算` |
| 正文缓存上限 | 8 000 000 字符/**每源** | 200 × 8M = 16 亿字符——上限本身就不成立，必须改全局预算 | `估算` |
| 一轮刷新 | 并发 5 × 单源超时 15 s | 最坏 200 × 15 ÷ 5 = **600 s/轮** | `外推` |
| 未读记账 | 宿主全表遍历算 unread/perFeedUnread | 10 万行/次，SQL `GROUP BY` 只 3–12 ms | `实测` |
| **扫描族** | 每轮刷新 3 × 源数 次全表扫描 + 每次标读/星标一次全表 | 见 §3.1；原文漏账 | `源码核对`+`外推` |
| 列表取数 | `slice(0, 300)` 一次取回 | 10 万行下必须 keyset 分页 | `源码核对` |

### 3.1 原文漏掉的四处全表扫描（2026-10-11 补，`源码核对` + `外推`）

| 位置 | 频率 | 说明 |
|---|---|---|
| `refreshOne` 建身份索引 `listItems(feedId)` | 每源每轮 1 次 | 而 `listItems` 的实现是**遍历整表再过滤**（src/store.ts:73-79） |
| `prune` 再 1 次 | 每源每轮 1 次 | src/refresh.ts:91 |
| `capArticleCache` 再 1 次 | 每源每轮 1 次 | src/refresh.ts:113 |
| **小计** | 3 × 源数 次/轮 | 3 × 200 × 10 万 = **6000 万次迭代/轮** |
| `accountOf` 全表遍历 | 每次标读/撤销/星标/保持未读/清理 | src/endpoints.ts:110-116，调用点 159/178/352/367/399 |
| `buildOverview` 为**全部**条目建 ItemView + 排序 + 截断 | 每次开面板/刷新 | src/endpoints.ts:63-92（不是「取 300 条」） |
| 开域 `normalizeLegacyArticles` 全表 + 逐条写回 | 每次打开域 | src/index.ts:169-178, :323 |
| 开域 `repairIdentities` 每源一次全表 | 每次打开域 | src/identity-repair.ts:94-95 |

⇒ 点一次星标 = **一次 10 万行全表遍历 + 一次整份重写**。原文 §1.3 的「单条 UPDATE 8.2 ms」
只算了后半截。

## 4. 方案：100% 自持（插件自己拥有落盘）

### 4.0 分界线（2026-10-11 修正）

原文用「谁拥有」当分界线，**但它与自己的建议冲突**：`readAt` / `starred` / `keptUnread`
是用户拥有的状态，却长在 item 行上，而 items 整表要搬去插件自持的 SQLite。

修正后的分界线是**两条可执行的判据**，不是一句所有权口号：

1. **体量与写入频率**：要按行更新、会到 10 万行量级的数据，不进「整份进内存 + 整份写盘」的设施。
2. **可再生性 + 备份体积**：能再抓的数据（条目、正文）不进备份；不能再生、且小到能整份打包的
   （订阅列表）才进备份。

⇒ **结论：100% 自持**。插件自己拥有全部落盘，`ctx.storageDomain` 不再参与本插件。

**为什么不是「域留用户状态、大表进插件库」的混合方案**（2026-10-11 复核后否掉）：
混合会带来两处落点、跨介质无共同事务（`removeFeed` 要跨两处写）、两套迁移语义，
以及 `openDomainWithRetry` + 孤儿句柄接管（src/index.ts:75-113）这一整套只为
`storageDomain.open` 的 `already-open` 重试而存在的机制。
换来的是「用户状态走设施」——在条目已经决定进 SQLite 之后，这个收益远小于代价。

**自持有官方先例**：`dsh-cost-meter` 就是 100% 自持（自算路径、自带目录锁、自带 version 与原子写），
见 §0 表末行。它的目录锁有 60 行且要处理 Windows `EPERM`、进程被杀在 `mkdir` 与建 owner 文件之间
等边界；我们用 SQLite 的 WAL + `busy_timeout`，**同样的自持责任、实现负担明显更小**。

### 4.1 落地形态（已拍板）

单目录、全部自有数据：

```
$DSH_HOME/storages/rss-reader/
  ├── config.json                 # 订阅列表（唯一进备份的东西）
  ├── rss.db                      # 条目 + 正文缓存 + 已读/星标/保持未读 + 去重窗口
  └── reader-YYYY-MM-DD.log       # 按天分文件，保留 14 天
```

- 路径由插件自算（`resolveDshHome()` + `storages/rss-reader`），**带连字符合法**——
  这正是自持相对「留在设施里」的直接好处：域文件名受 `UNIT_NAME_RE` 约束，自持不受。
- 权限：目录 `0700`、文件 `0600`（照 `@deepseek-ai/dsh-storage-sqlite` 的 `open(path,'wx',0o600)` 做法）。
- **不采用 `node:sqlite` 之外的介质**：`per-record` JSON 把写入降到 O(1) 但 10 万个小文件
  （目录遍历 + inode 压力）；自建「追加日志 + 内存索引」等于自己实现一遍 WAL 与 compaction。
  判据见 §4.2。

### 4.2 介质判据：谁承担「崩溃恢复 + 索引 + 压缩」

条目一旦搬出设施，真正的选择不是「哪种文件格式」，而是**这三件事谁来写**：

| 方案 | 写 1 条 | 常驻内存 | 查询 | 依赖 | 判断 |
|---|---|---|---|---|---|
| 单份 JSON（现状） | 整份重写 | 全量对象图 | 自己扫 | 零 | 已出局（§1.1） |
| 每源一份 JSON | O(1 源) | 索引或按需 | 自己维护 | 零 | 仍修不掉一源 500 条标读 4.1 s |
| 追加日志 JSONL + 索引 | O(1) append | 定长索引 | 自己维护 | 零 | 可行，但 WAL/compaction 全自己写 |
| **嵌入式 DB（`node:sqlite`）** | **0.08 ms** | **O(page)** | **引擎** | **内置零依赖** | **选定** |

LMDB / RocksDB 能力不差，但需要原生依赖；本仓库 host 侧依赖面只有 `fast-xml-parser` + `zod`，
**在没有原生依赖的前提下，这一格只剩 `node:sqlite`**。

## 5. SQLite 同规模实测（10 万行）

| 操作 | 实测 | JSON 侧对应 |
|---|---|---|
| 建库 + 建索引（窄表 + 正文表 + 2 索引） | 3 ms | — |
| 插入 100 000 行（单事务） | 993 ms（窄表+正文）/ 1 199 ms（正文内联） | 10 万次整份重写 |
| 标已读（单条 UPDATE） | 0.08 ms/次（100 次 = 8 ms） | 一次整份重写 8.2 ms |
| 每源未读计数（200 组 `GROUP BY`） | 3 ms（热）/ 12 ms（次测） | JS 全表遍历 |
| 取一页 300 条 | 0.2 ms（窄表不含正文）/ 0.3 ms（含正文列） | — |
| 单条点读 × 1000 | 2 ms | — |
| 全表 `COUNT(*)` | < 1 ms | — |
| 冷开 + `COUNT(*)` | 1 ms；RSS 67 MiB、heapUsed 9 MiB | 打开即 parse + 全量 zod + `loadAll` |
| 库文件大小 | 233 MiB（窄表 + 正文另表）/ 407 MiB（正文内联） | 221 MiB（同数据 JSON） |

⚠️ 233 vs 407 MiB 那组**不是严格对照**（索引数量也不同：2 个 vs 1 个），只能说明
「窄行 + 正文另表」在这个形状下不劣于内联，不足以定论各自的精确开销。
可确定的是页面利用率：`page_size` 4096、`page_count` 59631，
2.4 KB 的行在 4 KB 页里塞不下第二行——正文内联会按页浪费。

## 6. 同时必须改的三面（只换存储不够）

1. **刷新调度**：改为按陈旧度调度（每轮取最旧的 K 个源）+ 条件请求优先 + 并发提到 8–12，
   并下调单源超时；否则 200 源最坏一轮 600 s（§3）。
2. **未读记账**：宿主侧从「遍历全表累加」改成 SQL `GROUP BY`；客户端契约不变
   （仍然只接收回包，不从 items 派生——src/client/store.ts:387-399 的记录必须保持）。
3. **列表分页**：`maxItemsShown` 从「一次取回 300」改成 keyset 游标分页，排序键必须是
   `recency = COALESCE(published_at, fetched_at)` + id，**不是裸 `published_at`**（理由见 §10）；
   否则第 301 条之后的条目在界面上永远到不了。

## 7. 明确不做

- 单个大 JSON 继续扛（§1.1 已证伪）。
- `layout: 'per-record'` 作为终态（10 万个小文件；它只治写不治内存）。
- 用 `storage-domain` 的 `routes` 把 `rss_reader` 指向 sqlite 后端来"扩容"——**已证伪**：
  换介质不换内存模型，且 KV 面没有查询/分页（§0）。
- 改任何 DSH 上游代码。方案 100% 在插件侧。
- **改 base bundle / profile patch 把 `storages` 根搬家**，好让域文件叫 `config.json`——
  那会影响所有用存储的插件（`session_projcache`、`workspace.json` …），且越界到别人的插件。
  自持之后这个需求自然消失（§4.1）。
- **把 `rss.db` 或日志放进备份**：条目与正文可再生，200 源规模下达 GB 级，装进备份会让备份不可用。

## 8. 未验证 / 已知偏差

- **迁移有一堵墙（2026-10-11 补；⚠️ 2026-10-13 起这条随迁移下线失效 —— 见「冻结后改动」⑪）**：
  迁移读的就是老文件，而 single 布局是整份 `readFile(utf8)`
  （single-unit.ts:33-40）。**若用户已越过 512 MiB，插件连开域都失败，迁移脚本同样读不出来**
  ⇒ 迁移必须显式假定「文件仍可读」，并对已越墙的用户给出带外脚本或明确放弃。
  这也是「步骤 ① 应抢在任何人越墙之前上线」的原因。当前实测 2.0 MB（15780 行），是安全窗口期。
- **迁移后没有回退路径**：自持之后不存在「切回存储域」的开关，除非再写一次反向迁移。
- **备份的粒度**：`backup.sh` 只备份订阅列表；条目、正文、去重窗口一律不备份
  （用户 2026-10-11 拍板：只保订阅，缓存无用）。

- 所有 10 万行数据是**合成样本**，沿用当前 114 条的平均形状（摘要偏大、正文缓存未满额）。
  真实 200 源的条目长度分布必然不同，§2 的绝对值会偏。
- 只测到 10 万行，**没有测百万行**。
- 「SQLite 内存 O(page)、不随 N 增长」由三件事互证（冷开 1 ms + 无 `loadAll` + RSS 67 MiB），
  **没有做 10 万 ↔ 100 万行的对照实验**。
- 233 vs 407 MiB 非严格对照（§5 已标注）。
- 200 源的真实网络行为（限流、失败率、条件请求命中率）完全没测。
- **一处自我纠错留档**：纯元数据 10 万行的堆，第一次测得 10 MiB，与数据量矛盾；
  重测（改用互不共享的字符串，并对比持有/释放两个时刻）后为 68 MiB——但那个口径
  **同时持有原文串**。2026-10-11 用 `npm run bench` 复测（只持解析结果）为 39 MiB，
  **本文后续一律用 39 MiB**；68 MiB 只在 §2 与 §11.1 作历史对照。

## 9. 决策记录

### 9.1 已定（2026-10-11 用户拍板）

**100% 自持**：插件自己拥有全部落盘，`ctx.storageDomain` 不再参与本插件。
落点 = 单目录 `$DSH_HOME/storages/rss-reader/`（§4.1）。介质 = `node:sqlite`（§4.2）。
理由：§1 的三条硬约束都是设施的设计前提被突破，而非参数没调好。

**连带作废的约定**：`src/domain.ts:5-6` 写着「迁移/并发/落盘语义由设施负责
（**别自己上 SQLite**）」。这条约定的前提是「域小到能整份进内存、整份写盘」，
在 200 × 500 下不成立。作废它必须在 `docs/pitfalls.md` 留下一条记录（否则下一个
读 `domain.ts` 注释的人会以为这条约定仍然有效）。

### 9.2 先决条件：备份覆盖（已完成）

自持意味着用户数据离开 `state/`（被 `backup.sh` 整份打包）搬进 `storages/`（原本**完全不在备份里**）。
⇒ **先补 `backup.sh`，再迁移**，否则中间会有一段时间用户数据裸奔。

`~/Project/tests/default/dsh-backup/backup.sh` 已改造并实测（2026-10-11）：

| 项 | 结果 |
|---|---|
| 只备份订阅列表 | 是——条目/正文/去重窗口明确不备份 |
| 两种形态都认 | 自持 `storages/rss-reader/config.json`；存储域 `storages/rss_reader.json` 的 `tables.feeds`（迁移前后都不漏） |
| 依赖 | 新增 `jq`（仅此一处）；缺失或解析失败时**告警并跳过，不静默、不中断备份** |
| 实测 | 真数据 8 源进归档（392K/145 文件）；四条分支（自持/存储域/无数据/jq 缺失/解析失败）逐条验证 |
| 回滚 | 原文件留副本 `backup.sh.bak-20261011-before-rss`（sha256 已核对） |

### 9.3 验收线（已按量纲拆分，2026-10-11 修正）

原文把网络与存储混在一条线上，且「首次导入 ≤ 60 s」与 §3 自己算的「最坏 600 s」不同量纲。拆开：

**存储侧**（可测，200 源 / 10 万条目）：

- 冷开 + 首屏 ≤ 200 ms
- 单条标已读 ≤ 20 ms
- **一源 500 条批量标已读 ≤ 1 s**（现状 4.1 s —— 这才是逼出 ③ 的那条）
- 插件进程常驻内存 ≤ 300 MB
- 单轮刷新不因扫描族产生可观测卡顿（3 × 源数 次全表扫描应归零）

**网络侧**（2026-10-11 用户确认：**保留，但标注待测**）：

- 一轮全 304 刷新 ≤ 15 s —— **无任何实测支撑**，标为 `待测`
- 首次导入 200 源 ≤ 60 s —— 网络下界，**不可作为存储验收线**

⚠️ **钉进测试之前必须先测**，否则会得到一条永远测不准的红线。测量时必须写明条件：
单源 RTT、并发数（`refreshConcurrency`）、304 命中率、以及是否含 DNS/TLS 冷启动。
这两条**不作为**本方案（存储改造）的验收门槛，只作为网络侧的独立观测项。

## 10. 排序与分页语义（实现依据，2026-10-11 补）

⚠️ 排序键必须与现状语义**逐字一致**（`源码核对`）：宿主排序键是
`recencyOf = publishedAt ?? fetchedAt`（src/shared.ts:241-243），顺序是 recency 倒序 + id 升序
（src/endpoints.ts:80-83），而 `publishedAt` 是**可选**字段。

直接对 `published_at` 建索引会让缺发布时间的条目落进 SQL 的 NULL 段（SQLite 中 NULL 最小），
而不是按 `fetchedAt` 归位 ⇒ 列表顺序与分页边界都和现状不一致。
**必须存一列 `recency` 并建 `(recency DESC, id ASC)` 索引。**

**排序等价性已核实**（2026-10-11 加固，`实测`）：宿主用的是 `localeCompare`
（src/endpoints.ts:81），SQLite 的 `ORDER BY` 默认是 **BINARY** 校对；两者若不等价，
「迁移前后列表顺序逐条一致」（Review Focus 2）就是空话。实测对**本插件的真实取值域**——
40 组各 40 个 32 位小写十六进制 id、以及同规模的 ISO-8601 时间戳——两种排序**逐位相同**
（差异位置数 0 / 0）。⇒ 可以在 SQL 侧直接 `ORDER BY recency DESC, id ASC`。
⚠️ 边界：这条结论只覆盖「小写十六进制 id + ISO-8601 时间戳」。若日后 id 形态变成混合大小写，
BINARY 会把大写排在小写之前、而 `localeCompare` 不会——那时必须重新验一次。

### 10.1 步骤 ① 的修正（2026-10-11，`源码核对`）

初版把「减字节」列为一整步，但那是**「留在设施里」时代的补救措施**。取 ③ 之后逐项复核：

| 项 | 原动机 | 取 ③ 之后 |
|---|---|---|
| `maxContentChars` 50k→2k | 压域文件字节数、避开 512 MiB 墙 | 墙不再是约束（SQLite 不受限）⇒ **不做** |
| `maxSeenPerFeed` 5000→2000 | 压去重窗口的 35 MB 堆 | **有害**：削弱去重，老条目滚出窗口会重新变未读（pitfalls §5.2）⇒ **不做** |
| `maxArticleCacheChars` 改全局预算 | —— | **仍然成立**：与介质无关的真缺陷。现上限是**每源** 8M 字符，200 源即 16 亿字符 |

⇒ 步骤 ① 缩为**只剩全局预算一项**；`maxSeenPerFeed` 与 `maxContentChars` 保持默认值。

### 10.2 客户端契约（2026-10-11 补，同日自审核正）

**唯一要改客户端契约的是分页**：`overview` 端点增加游标，而「客户端只接收回包、
不从 items 派生未读账」这条不变量（src/client/store.ts:387-399）**每一页都必须保持**。

⚠️ **`summary` 不再需要外置**（自审核正）：本文早期版本担心「summary 外置后列表预览与展开视图
（src/client/index.tsx:641）没有来源」——那是「元数据留在存储域」时的约束。
取 ③ 之后 `summary` 就留在 `items` 行内：SQLite 没有「整份文件必须读进一个字符串」的墙，
行是按需读的。**正文（blocks）才进 `texts` 表**（§11.2 的 schema），因为它体量大且按需取。

⇒ 由此产生的唯一真问题是**库体积**：当前 `maxContentChars` 默认 50 000 字符/条，
若真实摘要均值接近实测的 8.8 KB，10 万条即约 880 MB。这是 `maxContentChars` 的取值问题，
不是外置问题；取值依据要等真实负载测量（§8 的样本偏差仍然成立）。

### 10.3 keyset 谓词：**不许用行值比较**（2026-10-11 定稿加固，`实测`）

分页的边界条件是「`recency` 降序、同 `recency` 内 `id` 升序」，于是一页的**下一页**是
「比边界行更靠后」的那批。直觉写法是行值比较 `(recency, id) < (?, ?)`——**它是错的**。

SQLite 的行值比较按**字典序**展开：`(recency,id) < (r0,id0)` 等价于
`recency < r0 OR (recency = r0 AND id < id0)`，而我们需要的是 `id > id0`
（同 `recency` 内 `id` 是**升序**）。方向反了，后果不是「少几条」而是**重复 + 漏**：

`实测`（本机 Node v24.19，带 `(recency DESC, id ASC)` 索引，同批抓取共享 `fetchedAt`
⇒ `recency` 大量打平——这正是真实形状）。6 行、每页 2 条，第一页边界 = `b`：

| 写法 | 第二页返回 | 判定 |
|---|---|---|
| 全序（期望） | `c d e f` | —— |
| `(recency, id) < (?, ?)` | `a d e f` | ❌ **`a` 重复出现、`c` 被漏掉** |
| `recency < ? OR (recency = ? AND id > ?)` | `c d e f` | ✅ 与全序逐条相同 |

⇒ **必须用 OR 形式**：

```sql
WHERE recency < ? OR (recency = ? AND id > ?)
ORDER BY recency DESC, id ASC LIMIT ?
```

（参数是**边界行的 `recency` 与 `id`**，即游标解出的那两个值。）

**代价已实测**（10 万行 = 200 源 × 500 条、`recency` 大量打平，每页 300 条）：

- 翻完全部 100 000 行 = 334 页，累计 **493 ms**，334 页**零重复、零遗漏**（集合恰好 100 000 且互异）；
- 首屏（首页 300 条）100 次 = **6.5 ms**；
- 单页成本随页深增长，但常数极小（取下一页 50 次的中位）：第 1 页 0.10 ms、第 50 页 0.52 ms、
  第 150 页 1.91 ms、第 300 页 2.78 ms、末页 2.95 ms。

⚠️ **查询计划是 `SCAN items USING COVERING INDEX i2`，不是 `SEARCH`**（本表初稿写错过一次，
2026-10-11 复查更正）：`OR` 形式让 SQLite 放弃了索引定位，退化为**沿覆盖索引顺序扫描 + `LIMIT`
提前终止**。所以这条查询是 **O(页深)** 而不是 O(log N)——代价被「覆盖索引、无需回表、取满
300 条即停」压到上表的毫秒级。首屏走的是同一索引的定位（`SEARCH … (recency<?)`），成本与人眼
无关。**这不改变结论**（分页不是瓶颈），但它意味着：日后若把页大小从 300 调到 3000，
末页成本会按比例放大，届时要重新测。

⇒ 分页不构成瓶颈，「冷开 + 首屏 ≤ 200 ms」（§9.3）不受影响。
**注意**：这条判据只有在 `id` 与 `recency` **同时**进边界时才成立——只带 `recency` 会在
打平点上死循环或跳页，而「同批抓取的条目 `recency` 相同」是常态而非边角。

## 11. 复现方法

以下脚本为本文 `实测` 数字的来源，全部在 `/tmp` 的临时目录里跑并即时清理，
不触碰真实 `rss_reader.json`（只读它）。
（⚠️ 2026-10-13 起那个文件已从真机删除 —— 见「冻结后改动」⑪；本节记的是当时的复现前提。）

**11.1 硬墙 + 10 万行 JSON 投影**

```bash
# 以 base64 传脚本避免引号地狱；--expose-gc 用于测"解析后常驻堆"
node --expose-gc --max-old-space-size=6144 <<'EOF'
const fs=require('fs'),os=require('os'),path=require('path'),buffer=require('buffer');
console.log('MAX_STRING_LENGTH MiB:', (buffer.constants.MAX_STRING_LENGTH/1048576).toFixed(0));
const p=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'wall-')),'big.json');
fs.writeFileSync(p, Buffer.alloc(600*1024*1024, 120));
try { fs.readFileSync(p,'utf8'); } catch(e) { console.log('FAILED:', e.code, e.message); }
fs.rmSync(p,{force:true});
EOF
```

```bash
# 10 万行投影 + 整份重写计时 + 用**真实 schema** 校验（在插件仓库根跑，import 的是构建产物 lib/domain.js）
node --expose-gc --max-old-space-size=6144 <<'EOF'
const fs=require('fs'),os=require('os'),path=require('path');
(async () => {
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'meta-')); const p=path.join(dir,'meta.json');
const hr=()=>process.hrtime.bigint(), ms=t=>Number(process.hrtime.bigint()-t)/1e6;
const FEEDS=200,PER=500,N=FEEDS*PER;
const rows=[];
for(let f=0;f<FEEDS;f++){ const fid='https://feed'+f+'.example.com/atom.xml';
  for(let i=0;i<PER;i++){ rows.push({ feedId:fid, title:'t'.repeat(60)+'#'+f+'_'+i,
    link:'https://site'+f+'.example.com/post/'+i+'/'+'u'.repeat(40),
    publishedAt:'2026-10-11T09:00:00.000Z', fetchedAt:'2026-10-11T10:00:00.000Z',
    ...(i%3===0?{readAt:'2026-10-11T10:05:00.000Z'}:{}), starred:i%7===0 }); } }
const text=JSON.stringify(rows); fs.writeFileSync(p,text);
console.log('file MiB',(Buffer.byteLength(text)/1048576).toFixed(1),'bytes/row',Math.round(Buffer.byteLength(text)/N));
let t=hr(); const parsed=JSON.parse(text); console.log('parse ms',ms(t).toFixed(0));
const times=[]; for(let k=0;k<20;k++){ const x=hr(); fs.writeFileSync(p+'.tmp',text); fs.renameSync(p+'.tmp',p); times.push(ms(x)); }
times.sort((a,b)=>a-b); console.log('rewrite median ms',times[10].toFixed(1),'max',times[19].toFixed(1));
const { itemRecordSchema } = await import('./lib/domain.js');
t=hr(); for(const rec of parsed) itemRecordSchema.parse(rec); console.log('schema.parse x100k ms',ms(t).toFixed(0));
global.gc(); global.gc();
console.log('steady heap MiB',(process.memoryUsage().heapUsed/1048576).toFixed(0));
fs.rmSync(dir,{recursive:true,force:true});
})();
EOF
```

该脚本的实测输出（10 万行纯元数据）：`30.7 MiB / 315 B 每行 / parse 31 ms / 整份重写中位 8.2 ms、峰值 31.8 ms / schema.parse × 100 000 = 37 ms / 常驻堆 68 MiB`。

**11.2 SQLite 对照**

> 下方脚本是本文 `实测` 数字的**原始来源**（2026-10-11 首次测量）。
> 2026-10-11 复核后补了 `recency` 生成列与第二个索引（原脚本的 `(feed_id, published_at DESC)`
> 服务不了跨源 top-N，且 NULL 发布时间的排序语义与宿主不一致，见 §10 ⚠️）——
> 索引变更不影响已记录的耗时数字（那些测的是插入 / UPDATE / GROUP BY）。

```bash
node <<'EOF'
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('/tmp/scale.db');       // 用完即删
db.exec('PRAGMA journal_mode=WAL');
-- summary 留在行内（§10.2）；article_failure 与 texts 互斥（domain.ts 的 itemRecordSchema）
db.exec('CREATE TABLE items(id TEXT PRIMARY KEY, feed_id TEXT NOT NULL, title TEXT NOT NULL, link TEXT NOT NULL, published_at TEXT, fetched_at TEXT NOT NULL, summary TEXT, read_at TEXT, starred INTEGER NOT NULL DEFAULT 0, kept_unread INTEGER NOT NULL DEFAULT 0, article_failure TEXT, recency TEXT NOT NULL GENERATED ALWAYS AS (COALESCE(published_at, fetched_at)) VIRTUAL)');
db.exec('CREATE INDEX i1 ON items(feed_id, recency DESC)');   // 每源未读/列表
db.exec('CREATE INDEX i2 ON items(recency DESC, id ASC)');    // 跨源 top-N 与 keyset 分页（§10 的排序键）
-- 正文另表。revision 是「缓存是否过期」的判据（refresh.ts 的 CONTENT_REVISION），
-- 与 frameable / title 同为 articleRecordSchema 的字段，缺了就得整表退化成不可判。
-- fetched_at 同理**必填**：它是 refresh.ts:118 正文缓存淘汰的排序键（见「冻结后改动」⑥）。
db.exec('CREATE TABLE texts(item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE, body TEXT NOT NULL, revision INTEGER, frameable INTEGER, title TEXT, fetched_at TEXT)');
-- `实测`：node:sqlite 的 PRAGMA foreign_keys 默认就是 **1**（与 sqlite3 CLI 的默认 0 不同），
-- 上面这条 ON DELETE CASCADE 因此真的生效（删 items 行后 texts 无孤儿）。
-- 但 deleteItem 仍应**显式**删两表：不把正确性押在 pragma 默认值上，换介质/换版本都不该翻车。
// 10 万行 = 200 源 × 500 条，单事务插入，再计时：单条 UPDATE / GROUP BY 计数 / LIMIT 300 分页 / 冷开
EOF
```

判据（`实测`）：插入 100 000 行 993 ms；单条 `UPDATE` 0.08 ms；200 组 `GROUP BY` 3 ms；
`LIMIT 300` 取页 0.2 ms；冷开 + `COUNT(*)` 1 ms、RSS 67 MiB。

---

## 冻结后改动（2026-10-11）

### ⑦（正文）Task 9：全局正文预算的**内存实测**（评审修复轮 1）

`maxArticleCacheChars` 改全局预算时，顺带量了这条路径的内存（`实测`，200 源 × 500 条 = 10 万行，
每条 8.8 KB 正文，合计 8.8 亿字符）：

| 取数方式 | 堆峰值 | 耗时 |
|---|---|---|
| `store.allItems()` | 1865 MB | 1505 ms |
| `listArticleCacheEntries()` 用 `.all()` | 922 MB | 742 ms |
| **`listArticleCacheEntries()` 用 `.iterate()`**（落地形态） | **60.4 MB** | 458 ms |

判别性测量：**只取 body 不 parse 就已是 922 MB** ⇒ 爆炸源是「一次性物化」本身，不是解析。
评审独立复现：`iterate()` 的堆峰值对行数**基本持平**（10k/20k/40k ⇒ 2.7/3.4/4.7 MB，
而正文总量 84 → 336 MB）⇒ 是真流式，不是「闻起来像」。

⇒ **对 §9.3「插件进程常驻内存 ≤ 300 MB」的关系，如实陈述、不做通过/不通过判定**：
本条的**正文缓存路径**堆峰值实测 **60.4 MB，在 300 MB 之内**；
**但进程 RSS 仍约 1359 MB，绝大部分是 SQLite 自己的页缓存**（进程常驻）。
本轮**没有**动 `PRAGMA cache_size`（改它等于改全局存储行为，另行决定）。
⇒ 换句话说：**这条路径不再是大头**，但「整个进程在 300 MB 内」这件事**本轮没有测过、也不宣称**。

首次刷新仍有一次性代价（`实测`：该夹具一轮淘汰 99 091 条，写入单条 0.071 ms ⇒ 外推 ≈ 7 s）——
全局预算是「把已经超了的东西按预算收回去」，这笔钱必须在某一轮付；未做分批清算。

### ⑧ Task 9 修复轮 2：一条变异曾经是**假通过**（评审抓出）

`refresh-正文闸门退回单源` 那条变异的 `to` 引用了 `urls` —— 它是 `refreshFeeds` 的参数，
**不在 `capArticleCache` 的作用域里** ⇒ 变异抛 `ReferenceError`，门槛照样报「应用」+「被抓到」、
幸存者仍是 0，**但没有一条断言真的看见了「按源名单」**。
⇒ 记在这里是因为它是一条**通用**教训，不只属于本任务：
**崩溃式失败（ReferenceError / SyntaxError）不是被抓住** —— 它把「缺陷复现」换成了「模块起不来」，
而门槛分辨不出这两者。验证变异必须**逐条看翻红的是哪几条测试**，
并确认输出里没有 `ReferenceError` / `SyntaxError`（`ℹ fail N` 的计数**单独**不足为据）。