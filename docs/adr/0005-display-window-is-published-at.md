# ADR-0005：显示窗按发布时间与读者本地日判定

- 状态：已采纳（2026-11-19）
- 适用：`overview` 的时间窗、`src/item-page.ts` 的栅栏、`src/store-sqlite.ts` 的范围查询、`src/preferences.ts` 的范围档位

## 背景

产品里原本已经有三个「时间」，各有各的判据：

1. **列表排序键** `recency` = `COALESCE(published_at, fetched_at)`（`src/cursor.ts`）；
2. **A 的标读阈值**也用 `recency`（客户端 `recencyOf`）；
3. **搜索的日期筛选**：`i.recency` + 客户端给的日期 + `to` 补成 UTC 日末（`src/search-worker.ts`）。

要加「今天该读什么」这个显示窗时，最省事的做法是复用 `recency`：索引现成（`i2`），口径与另外两处一致。
但它恰好毁掉这个功能要回答的问题——**没有发布日期的条目会退到抓取时间**，于是第一次订阅一个老博客时，
它整站的历史文章都会被算成「今天」。

第二个诱惑是让宿主按自己的时区算日界。宿主与浏览器不保证同一时区（远程宿主、容器、SSH），
而「今天」是**读者的**今天。

## 决定

1. 显示窗只按 `items.published_at` 判定；**没有发布日期的条目不进任何时间窗**，数量单独报出（不能静默消失）。
2. 边界由**客户端**按浏览器本地自然日算成半开区间 `[from, to)` 的 ISO 瞬间；宿主只做
   `published_at >= from AND published_at < to`，**不得**用自身时区重算，也不得把 `to` 补成日末。
3. 传输值必须是 `toISOString()` 形态（毫秒精度、`Z`）。库里的 `published_at` 由 `toIsoUtc` 归一成同一形态，
   所以字符串比较等于时间比较；游标协议已经依赖这条前提。
4. **不为此新增索引**：查询写成 `published_at IS NOT NULL AND recency >= ? AND recency < ?`——对
   `published_at` 非空的行，「recency 在窗内」与「published_at 在窗内」等价，于是范围与
   `ORDER BY recency DESC, id ASC` 可以共用 `i2`。验收要求 EXPLAIN QUERY PLAN 证明走 `i2` 且 10 万行基准达标；
   计划不选它时才升 v5 加 `i4(published_at)`，不预先做。

## 后果

- 产品里**并存两套日期口径**：显示窗（`published_at`、读者本地日、排除无日期）与搜索（`recency`、UTC 日界、含无日期）。
  这是**有意的**：搜索回答「我按日期找文章」，显示窗回答「我还没读的今天」。将来若要统一，改的是搜索那一侧，
  不是这里。
- 无发布日期的条目在任何时间窗里都不可见，只在「全部」下照常出现。这条代价必须由计数提示补上，
  否则用户会以为条目丢了。
- 以后若改用 `recency`，语义会变（老博客首次订阅时整站变成「今天」）。那是重开这个裁决，不是实现优化。
