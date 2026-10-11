# 大规模订阅存储改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把条目、正文与用户状态从 `ctx.storageDomain` 搬到插件自持的 `node:sqlite`，落点 `$DSH_HOME/storages/rss-reader/`，使 200 源 × 500 条（10 万条目）可用。

**Architecture:** 100% 自持——插件自己拥有全部落盘，不再使用存储域。单目录三件：`config.json`（订阅列表，唯一进备份）、`rss.db`（条目 + 正文 + 已读/星标/保持未读 + 去重窗口）、`reader-YYYY-MM-DD.log`。`ReaderStore` 窄接口保持不变，换的是它的实现，因此 `refresh.ts` / `endpoints.ts` 的编排逻辑与既有测试桩不受影响。

**Tech Stack:** Node ESM + `node:sqlite`（`DatabaseSync`，Node 内置、零原生依赖）；zod 保留用于记录形状；tsc（host）+ tsdown（client）；node:test 跑 `lib/` 产物。

**Spec:** `docs/superpowers/specs/2026-10-11-large-scale-storage.md`（下称「本 spec」，**已冻结**）。计划以规格为依据，故规格随计划一起流转；执行者两者都要读。踩坑清单：`docs/pitfalls.md`（尤其 §4.9、§5.2）。

## Global Constraints

- 禁止 `as any` / `@ts-ignore` / `@ts-expect-error`（`strict: true`）。
- 禁止空 catch；异常必须有可见后果（日志 / 重抛 / 界面报错）。
- 测试跑的是 `lib/` 产物：改完 `src/` 必须 `npm run build`；动过 `src/client/**` 必须再跑 `npm run build:client`。
- `npm run mutation` 会临时改坏 `lib/`，**必须在 /tmp 隔离副本里跑**。
- 依赖不是 `npm install` 来的：新依赖要加进 `scripts/build.sh` 的 `link_pkg`/`link_pnpm`（本仓库无锁文件）。
- 目录权限 `0700`、文件权限 `0600`（照 `@deepseek-ai/dsh-storage-sqlite` 的 `open(path,'wx',0o600)` 做法）。
- 注释与 commit message 写中文、写「为什么」；commit 结构：病象 → 根因 → 修法 → 证据。
- **不许改** `storages/rss_reader.json`：迁移只读它，原样留存。
- 排序键恒为 `recency = COALESCE(published_at, fetched_at)`，顺序 = recency 降序 + id 升序（本 spec §10）。
- **两个「config」不许混**：`src/config.ts` 的 `Config` 是**插件配置面**（Schemastery，注入器写死 `{ }`、
  只吃 schema 默认值）；`storages/rss-reader/config.json` 是**订阅真相的落点**。§4.1 只挪后者。
  `Config.feeds` 仅作首次种子（`src/index.ts:181-192` 已按幂等处理），**不做**「把跑起来的配置写回 Config」。

## Review Focus

1. **迁移读不出的老文件**（>512 MiB / 损坏 / 非 JSON / 是别的插件的域）：理性期待是**响亮失败并原样保留老文件**，而不是静默建空库——静默会让用户以为订阅全丢了。落在 Task 4。
2. **缺 `publishedAt` 的条目排序**：现状用 `publishedAt ?? fetchedAt`（本 spec §10）。理性期待是迁移前后列表顺序**逐条一致**。落在 Task 3、Task 5。
3. **迁移中断后重入**：进程在「已建库、未导完」时被杀。理性期待是重开时**幂等续跑或整体重来**，不产生重复条目。落在 Task 4。
4. **刷新窗口内的并发用户操作**：抓取是长任务，期间用户标已读/加星。理性期待是用户状态不被覆盖（仓库有过三次同类事故，见 `src/store.ts:21-31` 的注释）。落在 Task 3、Task 5。
5. **`DSH_HOME` 不可写或权限异常**：理性期待是响亮失败并说明路径，而不是回落临时目录或静默降级。落在 Task 2。

---

### Task 1: 规模基准脚本（已完成，基线已记录）

**Files:**
- Create: `scripts/scale-bench.mjs`
- Modify: `package.json`（`bench` script）

**Interfaces:**
- Produces: `npm run bench` → 打印行数 / 文件 MiB / 打开 ms / 整份重写中位与峰值 / 一源全标已读 ms（外推）/ 常驻堆 MiB。

- [x] **Step 1: 写脚本**（合成 10 万行纯元数据，import `lib/domain.js` 的 `itemRecordSchema` 做真实校验）
- [x] **Step 2: 跑出基线**（2026-10-11，`200 × 500`）

基线（`实测`，本机 macOS + Node v24.19）：

| 指标 | 现状（域 + single JSON） | spec §9.3 目标 |
|---|---|---|
| 行数 / 文件 | 100 000 行 / 29.38 MiB（308 B/行） | — |
| 打开（parse + zod） | **70.33 ms**（parse 25.53 + zod 44.80） | ≤ 200 ms ✅ 已达标 |
| 整份重写 | 中位 **8.62 ms** / 峰值 10.50 ms | — |
| 一源 500 条全标已读 | **4312 ms**（外推 500 × 8.62） | ≤ 1 s ❌ **差 4.3×** |
| 常驻堆 | **38.97 MiB** | ≤ 300 MB ✅ 已达标 |

⇒ **只有「一源全标已读」这一条真的不达标**，它就是本次改造的核心判据。Task 3 完成后必须复测同一张表。

---

### Task 2: 自持存储骨架（路径 / 权限 / schema / config.json）

**Files:**
- Create: `src/storage/paths.ts`、`src/storage/db.ts`、`src/storage/config-file.ts`
- Modify: `scripts/build.sh`（加 `link_pkg @deepseek-ai/dsh-home-paths packages/util/home-paths`）
- Test: `tests/storage-skeleton.test.mjs`

**Interfaces:**
- Produces:
  - `storageRoot(dshHome?: string): string` → `<home>/storages/rss-reader`
  - `ensureStorageRoot(root: string): void`（`mkdirSync` `recursive` + `mode 0o700`）
  - `openDatabase(path: string): DatabaseSync`（父目录 0700、文件 `wx`/0600、`journal_mode=WAL`、`busy_timeout=5000`、`user_version` 校验）
  - `SCHEMA_VERSION = 1`、`migrateSchema(db): void`
  - `readConfigFile(path: string): ReaderConfigFile`、`writeConfigFile(path: string, value: ReaderConfigFile): void`（原子写 + 0600）
  - `interface ReaderConfigFile { feeds: Record<string, FeedRecord>; viewPreferences?: unknown; version: 1 }`
- Consumes: `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()`、`FeedRecord`（`src/domain.ts`）

> **⚠️ feeds 不是 `string[]`（定稿加固 2026-10-11，`源码核对`）**：`FeedRecord` 上挂着
> **条件请求与内容版本**——`etag` / `lastModified`（`src/refresh.ts:173`）、`contentRevision`
> （`:170` 决定是否绕开 304 回填摘要）、`lastFetchedAt`（Task 10 的陈旧度调度要按它排序）、
> `lastFailure`（`src/endpoints.ts:48` 回给界面）。只存 URL 列表会让这几项在迁移那一刻**静默归零**：
> 表现是「迁移后第一轮全量重抓 + 摘要回填逻辑空转」，而没有任何断言会翻红。
> ⇒ `feeds` 必须是 **`feedId → FeedRecord` 的映射**，逐字段与 `feeds` 表同形。
> 备份脚本读的就是这个位置（`jq -S '.tables.feeds // {}'` 取出的正是这种映射），形状天然一致。

- [ ] **Step 1: 写失败测试** `tests/storage-skeleton.test.mjs`

```js
test('storageRoot 落在 <home>/storages/rss-reader', () => {
  assert.equal(storageRoot('/tmp/x'), '/tmp/x/storages/rss-reader')
})
test('ensureStorageRoot 建出 0700 目录', () => {
  ensureStorageRoot(root)
  assert.equal(statSync(root).mode & 0o777, 0o700)
})
test('openDatabase 建库为 0600 且 user_version=1', () => {
  const db = openDatabase(dbPath); migrateSchema(db)
  assert.equal(statSync(dbPath).mode & 0o777, 0o600)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION)
})
test('openDatabase 拒绝更高版本的库（响亮失败，不静默降级）', () => {
  // 先建库并写 user_version=99，再 open ⇒ 必须 throw，且消息含路径
})
test('writeConfigFile 原子写 + 0600，readConfigFile 回读一致', () => { /* ... */ })
test('readConfigFile 对损坏 JSON 响亮失败（不返回空 feeds）', () => { /* ... */ })
```

- [ ] **Step 2: 跑测试确认失败** → `node --test tests/storage-skeleton.test.mjs`，预期 `Cannot find module '../lib/storage/paths.js'`
- [ ] **Step 3: 实现三个模块**（`paths.ts` / `db.ts` / `config-file.ts`，按上面的签名）
- [ ] **Step 4: build + 跑测试** → `npm run build && node --test tests/storage-skeleton.test.mjs`，预期全绿
- [ ] **Step 5: Review Focus 5 的断言**：`DSH_HOME` 指向不可写路径时 `ensureStorageRoot` 抛错且消息含路径（不许回落临时目录）
- [ ] **Step 6: commit**

---

### Task 3: SQLite 版 ReaderStore（接口不变，换实现）

**Files:**
- Create: `src/store-sqlite.ts`
- Test: `tests/store-sqlite.test.mjs`

**Interfaces:**
- Consumes: `ReaderStore`（`src/store.ts:11-49`，**签名一字不改**）、Task 2 的 `openDatabase`/`migrateSchema`
- Produces: `createSqliteStore(db: DatabaseSync, configPath: string): ReaderStore`

- [ ] **Step 1: 写失败测试**（每条对应一个接口方法；用内存库 `:memory:`）

```js
test('listItems 只返回该源的条目（且不走全表）', () => { /* 两源各 2 条 ⇒ 各返 2 */ })
test('updateItem 看到队列上的当前值，并发写不互相覆盖', () => {
  // 先 saveItem(readAt=undefined)，再在 updateItem 里读 current 并只改 starred
  // ⇒ readAt 必须还在（这是仓库三次事故的同一类）
})
test('updateItem 对缺失键拒绝（不是写一次就当创建）', () => { /* assert.rejects */ })
test('saveItem 覆盖整条；deleteItem 幂等', () => { /* ... */ })
test('recency 列 = COALESCE(published_at, fetched_at)', () => {
  // 缺 publishedAt 的行，其 recency 必须等于 fetchedAt
})
test('listFeeds/allItems/viewPreferences 与旧实现同形', () => { /* ... */ })
```

- [ ] **Step 2: 跑测试确认失败** → `node --test tests/store-sqlite.test.mjs`
- [ ] **Step 3: 实现 `createSqliteStore`**

要点：`listItems(feedId)` 走 `SELECT … WHERE feed_id = ?`（**这是扫描族的结构性修复**，见本 spec §3.1）；`updateItem` 在单条事务里读改写；`viewPreferences` 读写 `config.json`；写入一律用 prepared statement。表结构用本 spec §11.2 的 schema（含 `recency` 生成列 + `i1(feed_id, recency DESC)` + `i2(recency DESC, id ASC)`）。

- [ ] **Step 4: build + 跑测试**，预期全绿
- [ ] **Step 5: Review Focus 2 与 4 的断言**：缺 `publishedAt` 的行排序与现状一致；`updateItem` 并发不丢用户状态
- [ ] **Step 6: commit**

---

### Task 4: 一次性迁移 + 切换入口（cutover）

**Files:**
- Create: `src/storage/migrate.ts`
- Modify: `src/index.ts`（`openDomainWithRetry` 调用点 → `createSqliteStore`；`src/index.ts:305-338` 的域生命周期）
- Test: `tests/migrate.test.mjs`

**Interfaces:**
- Consumes: `createSqliteStore`（Task 3）、`storageRoot`/`openDatabase`/`migrateSchema`/`readConfigFile`/`writeConfigFile`（Task 2）
- Produces:
  - `migrateFromDomainFile(options: { domainPath: string; db: DatabaseSync; configPath: string; log: (m: string) => void }): Promise<{ feeds: number; items: number; cursors: number; skipped: boolean }>`
  - 幂等判据：`items` 表非空 ⇒ `skipped: true`（不重复导入）

- [ ] **Step 1: 写失败测试**

```js
test('从域文件导入 feeds/items/cursors，并写出 config.json', () => { /* 夹具：手工构造的小域文件 */ })
test('重复运行是幂等的（第二次 skipped:true，行数不变）', () => { /* ... */ })
test('域文件不存在 ⇒ skipped:true，不建空库也不抛错', () => { /* 首次安装路径 */ })
test('域文件损坏 ⇒ 抛错，且老文件与库都保持原样', () => { /* Review Focus 1 */ })
test('域文件不是本插件的（unit.name 不匹配）⇒ 抛错，不误导入', () => { /* ... */ })
```

- [ ] **Step 2: 跑测试确认失败** → `node --test tests/migrate.test.mjs`
- [ ] **Step 3: 实现 `migrateFromDomainFile`**

要点：整份读 `rss_reader.json` → 校验 `unit.name === 'rss_reader'` → 单事务写入；`feeds` 表 → `config.json` 的 `feeds`（**逐字段整体拷贝**，见 Task 2 的字段清单）；`global` → `config.json` 的 `viewPreferences`；**老文件只读、绝不改写或删除**。先写库后写 config，任一失败即整体回滚（`BEGIN`/`ROLLBACK`）。

**另两件必须在这里做掉的事（定稿加固 2026-10-11）：**

① **迁移时套一遍 `normalizeLegacyArticle`**（`src/domain.ts` 的纯函数，目前由 `src/index.ts:169-178`
   的 `normalizeLegacyArticles` 在开域后全表跑）。它的作用是把老正文缓存（`article.paragraphs`
   纯段落形态）折成 `blocks`。若迁移直接把 `article` 原样搬进 `texts`，老形态会被**原样冻进库里**，
   而 Task 8 又删掉了那个开域规范化 —— 客户端将拿到它渲染不了的形状。
   `实测`（2026-10-11，真实库）：当前 115 条中 57 条带正文、`paragraphs` 出现 **0 次**，
   即**本机数据已无老形态**，但**不能因此省掉这一步**——别的安装（或更老的备份）仍有。
   判据：迁移后库里不存在 `paragraphs` 形态的正文。

② **`inject` 必须同步减项**（`src/index.ts:47`）。自持之后插件不再需要存储域，
   留着 `export const inject = ['storageDomain', 'connection', 'webServer']` 会变成
   「自己不落盘、却仍声明依赖它」——DSH 会照常为你装配存储域，迁移的收益被抵消一半。
   同步项：`package.json` 的 `peerDependencies.@deepseek-ai/dsh-storage-domain`、
   `scripts/build.sh:89` 的 `link_pkg`。**三者必须一起改**，漏一处就是一条悬空依赖。

- [ ] **Step 4: build + 跑测试**，预期全绿
- [ ] **Step 5: 切换 `src/index.ts`**：删除 `openDomainWithRetry` 的调用，改为「`ensureStorageRoot` → `openDatabase` → `migrateSchema` → `migrateFromDomainFile` → `createSqliteStore`」。**本步不删 `openDomainWithRetry` 函数本身**（Task 8 才删），以免中途不可回退。
- [ ] **Step 6: 全量回归** → `npm run build && npm test`，预期全绿（既有 21 个测试文件里有 5 个用真实 `DomainFacility`，见下方风险）
- [ ] **Step 7: Review Focus 1 与 3 的断言**：损坏域文件响亮失败；中断后重入不产生重复
- [ ] **Step 8: commit**

> **风险（执行者注意，2026-10-11 自审核正）**：受影响的是**一个**测试文件——`tests/nav-persistence.test.mjs`。它同时：(a) `import { createStore }`（:26）并用 `fakeDomain` 桩驱动它（:93-115）；(b) 在 :494-514 用**真实 `DomainFacility` + 真实 `readerDomain`** 打开手工构造的老域文件。Task 4 之后这两处要改成驱动 `createSqliteStore`（内存库），**不许删测试**。
> 其余测试不依赖存储域实现（`tests/domain.test.mjs` 测的是 `rebuildItem` / `normalizeLegacyArticle` 这两个纯函数，与 store 无关）。这是本计划唯一会动既有测试的地方。

---

### Task 5: 未读记账与列表取数改 SQL（不再全表物化）

**Files:**
- Modify: `src/endpoints.ts`（`buildOverview` `:39-101`、`accountOf` `:107-116`）
- Test: `tests/unread-accounting.test.mjs`、`tests/endpoints-perfeed-unread.test.mjs`（既有，扩充）

**Interfaces:**
- Consumes: `ReaderStore`（Task 3 的 `createSqliteStore`）、`countUnreadPerFeed` / `isUnread`（`src/shared.ts:62-87`，**唯一口径，不许另写一份**）
- Produces（**本任务新增，加在 `src/store.ts` 的接口与两个实现上**）：
  - `countUnreadPerFeed(feedIds: readonly string[]): Record<string, number>`
  - `listRecent(limit: number): Array<[string, ItemRecord]>`（按 `recency DESC, id ASC`）
  - `buildOverview`、`accountOf` 与 **`cleanup`** 不再调用 `allItems()`

> **⚠️ `cleanup` 漏在原文覆盖率之外（定稿加固 2026-10-11，`源码核对`）**：
> `src/endpoints.ts:337` 的 `cleanup` 自己就有一句 `target.allItems()`，而 spec §3.1 只把清理
> 记在 `accountOf` 名下。**spec 与计划都漏了它**——不修的话，「点一次清理 = 一次 10 万行全表
> 遍历」原样留下，而这正是 §3.1「扫描族归零」要消灭的东西。
> 修法：清理的候选集用**一条 SQL**选出来（`read_at IS NOT NULL AND starred = 0 AND kept_unread = 0
> AND recency < ?`），别再让 JS 侧物化全表；`selectCleanup` 的判据保留为**唯一口径**
> （`src/retention.ts`），SQL 只负责把候选喂给它或与之等价。

> **⚠️ `countUnreadPerFeed` 的键域 = `feeds` 表，不是 `GROUP BY` 的结果键（定稿加固）**：
> `buildOverview` 现在先按 `listFeeds()` 铺、再补 `allItems()` 里出现的源
> （`src/endpoints.ts:44-54` 的注释：「只收所属源还在的条目」）。而 `GROUP BY feed_id`
> **只会返回有未读的源**——直接拿它当账目，未读为 0 的源会从回包里消失。
> 界面已实测过这类缺陷（`tests/unread-accounting.test.mjs` 的「某源全部标已读后：角标归 0
> **但键仍在**（键域 = feeds 表）」）：**零未读的源必须以 0 出现，不能缺键**。
> ⇒ 传进去的 `feedIds` 是 **`listFeeds()` 的全量键**，SQL 的结果按它补齐 0，不是反过来。

- [ ] **Step 1: 写失败测试**：10 万行合成数据下 `buildOverview` 的耗时断言 + 「左栏各源之和 === 顶栏总未读」不变量（既有断言保留）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 在 `store-sqlite.ts` 加两个方法**（`GROUP BY feed_id` / `LIMIT ?`），**同时给内存桩补上**（否则既有测试全红）。
      `实测`（2026-10-11）带 `listItems`+`allItems` 的内存桩共 **6 个文件**，都要补：
      `tests/article-markread-race`、`endpoints-perfeed-unread`、`identity`、`nav-persistence`、
      `refresh`、`unread-accounting`（各 `.test.mjs`）。接口加在 `src/store.ts` 上 ⇒ 漏补的文件是
      **编译期**报错（桩对象缺属性），比运行时更早暴露，但仍要逐个改完。
- [ ] **Step 4: 改 `buildOverview`/`accountOf` 用新方法**；`countUnreadPerFeed` 与 `isUnread` 仍是**唯一口径**（`src/shared.ts:62-87`，不许另写一份）
- [ ] **Step 5: build + 跑测试 + `npm run bench`**，把「一源全标已读」与打开耗时填进 Task 1 的基线表做对照
- [ ] **Step 6: commit**

---

### Task 6: 列表分页（keyset）+ 客户端契约

**Files:**
- Modify: `src/endpoints.ts`（`overview` 增加游标参数与 `nextCursor`）、`src/shared.ts`（`Overview` 加字段）、`src/client/store.ts`、`src/client/index.tsx`
- Test: `tests/client-bundle.test.mjs`、`tests/nav-selection.test.mjs`（既有，扩充）

**Interfaces:**
- Consumes: `listRecent`（Task 5）
- Produces: `Overview.nextCursor?: string`（`"<recency>|<id>"`）；`overview` 接受 `{ cursor?: string }`

> **⚠️ 谓词不许用行值比较（定稿加固 2026-10-11，`实测`；完整推导见 spec §10.3）**：
> `(recency, id) < (?, ?)` 按字典序展开成 `recency < r0 OR (recency = r0 AND id < id0)`，
> 而同 `recency` 内我们需要的是 `id > id0`（id 升序）——**方向反了**。
> 实测 6 行每页 2 条：行值形式返回 `a d e f`（`a` 重复、`c` 漏掉），OR 形式返回 `c d e f`（正确）。
> 且 `recency` 打平是**常态**：同一轮抓取的条目共享 `fetchedAt`。
> ⇒ 必须写成 `WHERE recency < ? OR (recency = ? AND id > ?)`（`实测` 10 万行翻底 334 页
> 共 493 ms、零重复零遗漏、走 `COVERING INDEX i2`）。

- [ ] **Step 1: 写失败测试**：跨页不重不漏（第 300 与第 301 条边界）；`nextCursor` 缺省表示到底
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现 keyset**（`WHERE recency < ? OR (recency = ? AND id > ?) ORDER BY recency DESC, id ASC LIMIT ?`，
        **不是**行值比较；理由见上方告示与 spec §10.3）
- [ ] **Step 4: 客户端接分页**：`applyAccount` 的整体覆盖语义**每一页都要保持**（`src/client/store.ts:387-399`）
- [ ] **Step 5: build + build:client + 跑测试**
- [ ] **Step 6: commit**

---

### Task 7: 日志按天分文件 + 保留 14 天

**Files:**
- Create: `src/storage/log-file.ts`
- Modify: `src/index.ts`（`log` 函数 `:125-135`）
- Test: `tests/log-file.test.mjs`

**Interfaces:**
- Produces: `dailyLogPath(root: string, date: Date): string` → `<root>/reader-YYYY-MM-DD.log`；`pruneOldLogs(root: string, keepDays = 14, now?: Date): number`

- [ ] **Step 1: 写失败测试**

```js
test('dailyLogPath 按 UTC 日期命名', () => {
  assert.equal(dailyLogPath('/root', new Date('2026-10-11T23:30:00Z')), '/root/reader-2026-10-11.log')
})
test('pruneOldLogs 只删超期的 reader-*.log，绝不碰 config.json / rss.db', () => {
  // 造 3 天日志（其中 2 天超期）+ config.json + rss.db ⇒ 只删超期日志
})
test('pruneOldLogs 在 keepDays 边界上不删当天的日志', () => { /* ... */ })
```
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（`appendFileSync` 保留；打开域时跑一次 prune）
- [ ] **Step 4: build + 跑测试**
- [ ] **Step 5: commit**

---

### Task 8: 删除自持后失效的机制 + pitfalls 收尾

**Files:**
- Modify: `src/index.ts`（删 `openDomainWithRetry` `:75-113`、`normalizeLegacyArticles` `:169-178`）、`src/domain.ts`（头部注释）、`src/identity-repair.ts`、`docs/pitfalls.md`（§4.9 状态行）
- Modify: `src/index.ts:47` 的 `inject`、`package.json` 的 `peerDependencies`、`scripts/build.sh:89` 的 `link_pkg`（存储域三处引用一起摘）
- Modify: `AGENTS.md`、`README.md`（两处的落盘路径已过期：`storages/rss_reader.json` → `storages/rss-reader/`，日志 `state/dsh-rss-reader/reader.log` → `storages/rss-reader/reader-YYYY-MM-DD.log`；AGENTS.md 的真机三步读的就是这个日志路径）
- Test: 既有套件（删代码后必须仍全绿）

**Interfaces:** 无新增。

- [ ] **Step 1: 确认前置**：Task 4/5 已稳定，且 `npm test` 全绿
- [ ] **Step 2: 删除失效机制**（`openDomainWithRetry`、孤儿句柄接管、`normalizeLegacyArticles`；`repairIdentities` 保留但改走新 store），并摘掉存储域的三处装配引用（`inject` / `peerDependencies` / `build.sh` 的 `link_pkg`）
- [ ] **Step 3: build + 全量测试**，预期全绿
- [ ] **Step 4: 更新 `docs/pitfalls.md` §4.9 的状态行**：从「实现尚未开始」改为「已落地」，并把 §4.6 `already-open`、§4.7（`config: {}` ⇒ `config.json`）、§4.8（域名约束）三条标为历史
- [ ] **Step 4b: 同步 `AGENTS.md` 与 `README.md` 的落盘/日志路径**（过期路径会让下一个 agent 去错地方找日志，正是「真机三步」里那一步）
- [ ] **Step 5: 更新本 spec 的「冻结后改动」**（记一行：日期 + 改了什么 + 依据）
- [ ] **Step 6: commit**

---

### Task 9: `maxArticleCacheChars` 改全局预算

**Files:**
- Modify: `src/config.ts`（`maxArticleCacheChars` 语义改全局）、`src/refresh.ts`（`capArticleCache` `:112-131` 改跨源清算）
- Test: `tests/retention.test.mjs`、`tests/refresh.test.mjs`（既有，扩充）

**Interfaces:**
- Produces: `selectGlobalArticleEvictions(entries: readonly ArticleEntry[], maxChars: number): string[]`（`src/retention.ts`，纯函数）

- [ ] **Step 1: 写失败测试**

```js
test('selectGlobalArticleEvictions 跨源超限时从最旧清起', () => {
  // 3 源各 1 条，上限只装得下 1 条 ⇒ 清掉最旧的两条（跨源，不只清单源）
})
test('selectGlobalArticleEvictions 在总量未超限时返回空', () => { /* ... */ })
test('selectGlobalArticleEvictions 在 maxChars<=0 时返回空（不整份清空）', () => { /* ... */ })
```
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现纯函数 + 改 `capArticleCache` 调用点**（现在是**每源** 8M 字符 × 200 源 ≈ 16 亿字符，本 spec §10.1）
- [ ] **Step 4: build + 跑测试**
- [ ] **Step 5: 加一条变异**（改了关键判定 ⇒ 同时补一条变异，见 AGENTS.md）
- [ ] **Step 6: commit**

---

### Task 10: 刷新调度（按陈旧度取源 + 并发可调）

**为什么补这一条（2026-10-11 自审）**：本 spec §6 把「刷新调度」列为**必须改的三面之一**，
但计划初版只覆盖了第 2、3 面——规格要求没有任务承接，属覆盖缺口。

**Files:**
- Modify: `src/refresh.ts`（`refreshFeeds` 的取源顺序）、`src/index.ts`（`refreshNow` 的 `subscriptions` 构造 `:219`）、`src/config.ts`（`refreshConcurrency` 注释与默认值）
- Test: `tests/refresh.test.mjs`（既有，扩充）

**Interfaces:**
- Consumes: `config.json` 里 `feeds` 映射的 `lastFetchedAt`（**Task 2 必须逐字段保住它**，否则按陈旧度取源无从谈起）
- Produces: `selectStalestFeeds(feeds: ReadonlyArray<[string, FeedRecord]>, limit: number): string[]`
  （纯函数，放 `src/refresh.ts`；按 `lastFetchedAt` 升序取最旧的 `limit` 个，缺 `lastFetchedAt` 的排最前）

- [ ] **Step 1: 写失败测试**

```js
test('selectStalestFeeds 取最旧的 K 个，未抓过的排最前', () => { /* 3 源，其中 1 源无 lastFetchedAt ⇒ 它必须第一 */ })
test('selectStalestFeeds 在 limit ≥ 源数时返回全部（不丢源）', () => { /* ... */ })
test('每轮最多抓 K 个源（200 源不再一轮全抓）', () => { /* 用 refreshFeedsImpl 桩数调用次数 */ })
```

- [ ] **Step 2: 跑测试确认失败** → `node --test tests/refresh.test.mjs`
- [ ] **Step 3: 实现 `selectStalestFeeds` 并接入 `refreshNow`**

要点：`refreshNow` 从 `target.listFeeds()` 取全量后交给它筛，再传给 `refreshFeeds`。
**条件请求优先（ETag / Last-Modified）已经在做**（`src/refresh.ts:171-176`），本任务不重复实现。

- [ ] **Step 4: build + 跑测试**，预期全绿
- [ ] **Step 5: 并发值**：`refreshConcurrency` 默认值**不照抄 spec 的「8–12」**——先测（同一台机器、20 个真实源）再定，把实测值写进 `src/config.ts` 的注释。spec §9.3 的网络侧两条仍是 `待测`。
- [ ] **Step 6: commit**

---

## 完成定义（本计划全部任务完成后跑一次）

```bash
npm run build            # 动过 src/client/** 则追加 npm run build:client
npm run typecheck        # host + client 两个工程，0 错误
npm test                 # 全绿
npm run mutation         # 在 /tmp 隔离副本里跑，0 幸存
npm run bench            # 与 Task 1 的基线表对照
```

**真机三步**（本仓库有过「全套测试全绿而插件在 DSH 里是坏的」）：`dev_reload_package`（前后都应 `[active]`）→ 看日志无「装载失败」→ `curl -X POST http://127.0.0.1:3080/rss-reader-api -d '{"endpoint":"overview","payload":{}}'` 得 401。
