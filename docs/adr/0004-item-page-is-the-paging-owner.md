# ADR-0004：一页条目是分页协议的 owner

- 状态：已采纳（2026-11-18）
- 适用：`src/item-page.ts`、`src/endpoints.ts` 的 overview / refresh、`ReaderStore.listRecent`、
  `src/store.ts` 与 `src/memory-store.ts` 的 JS 游标谓词

## 背景

2026-11-14 评审卡 #7：`buildOverview` 是 `src/endpoints.ts` 里一个不可导出的闭包，115 行里同时握着
范围解析、孤儿过滤、窗口放大 ×2、多取一行判尾、`ItemView` 投影、标签批量补、`nextCursor` 合成、
未读账求和。游标围栏的编码与解码隔 200 行；同一 keyset 谓词在 `store-sqlite.ts` 的 3 个 SELECT 变体、
`store.ts` 与 `memory-store.ts` 的 JS 各写一遍。要测其中任何一件，都得起真库 + 真 dispatch，
并直接写 `items` / `texts` 的列。

分页协议其实是三件事的合成：**排序键**（`recency` 降序 + `id` 升序，`src/cursor.ts` 的 `recencyOf`）、
**续页关系**（严格排在边界之后）、**栅栏**（游标绑在范围上，范围一变就失配）。三者分居三处时，
改动任何一处都不会让另一处的用例翻红。

## 决定

1. 新模块 `src/item-page.ts` 拥有「(范围, 游标, 页大小) → 条目 + 下一游标」：窗口补偿、多取一行判尾、
   栅栏键构造、编解码与 `afterCursor` 全在里面。端点只做三件事：解析范围存在性、调用模块、装配回包
   （目录 / 账目 / refresh 元信息）。
2. 模块交出的是**行**（`[id, ItemRecord]`），不是 `ItemView`：投影与标签批量补留在端点。
   这样模块的替身只需要实现**一条**取数语义（评审卡 #7 的判据），wire 形状继续由端点一处拥有。
3. 围栏失败分三态（`ok` / `mismatch` / `malformed`），端点映射成现有的两条中文文案；
   **不是**模块产出 `RpcResult` 信封 —— 信封是 wire 层的东西。
4. `ReaderStore` 只保留一条取数语义 `listRecent(limit, cursor?, feedIds?, tagId?)`，签名不动。
   **范围谓词**按范围分开写（三种范围各有自己的索引取舍）；**游标子句**收成一处：SQL 侧一个共享
   片段常量，JS 侧 `afterCursor` 由两份适配器共用。
5. 搜索与 agent 工具的栅栏**不在本阶段收编**：它们的分页在 `search-worker` 的独立 SQL 里，
   收编要同时动 worker 与 tool 两个测试面。触发条件：出现第三处栅栏，或搜索分页要改排序键。

## 后果

- 「一页怎么产生」可以在不碰库的情况下测：一个假的 `listRecent` 就能钉住窗口放大、判尾与围栏三态。
- 孤儿过滤从「端点里的一段 if」变成模块的输入（`knownFeedIds`），窗口补偿与它同住 ——
  两者本来就是同一件事（孤儿占掉窗口，才需要放大重取）。
- 排序键或续页方向要改时，SQL 与 JS 仍是两种语言的两种写法（无法消除），但每种语言只剩一处。
- `endpoints.ts` 的 overview 段（`buildOverview`）从 116 行降到 83 行；`refresh` 与 `overview`
  走同一条取页路径。
- 新模块是 host 侧纯模块（`node:crypto` + 类型），不依赖 store 实现；`store.ts` /
  `memory-store.ts` 反向 import 它的 `afterCursor`，所以 `PageSource` 用结构化声明，避免模块环。

## 2026-11-19 修订（R1 显示窗）

决定 4 的「签名不动」按**范围维度**放宽：`listRecent` 允许增加一个可选的时间窗参数，与 `feedIds` / `tagId` 正交。
`PageScope` 仍是 folder / tag 两态，时间窗**不进** `PageScope`；但它必须进栅栏键（`fenceKeyOf(scope, window)`），
否则切窗后旧游标会静默续页。续页谓词仍只有「每种语言一处」——加窗不产生第二处。
