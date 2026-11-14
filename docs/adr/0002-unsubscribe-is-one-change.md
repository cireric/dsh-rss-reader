# ADR-0002：退订是一次变更，只有一个 owner

- 状态：已采纳（2026-11-14）
- 适用：`removeFeed` 端点、`ReaderStore.deleteSubscription`、`refresh` 的退订守卫、装载守卫

## 背景

「订阅消失之后，它那些条目怎么办」在五个地方有五种假设：`removeFeed` 逐条删、`refresh` 写补偿分支、
`lifecycle` 用它当「订阅映射丢了」的判据、`tools` 的注释断言孤儿仍在、`overview` 按 feeds 键域过滤并放大窗口。
其中两条注释已经与事实相反。

而「删订阅」在库层面没有任何级联可依赖：`cursors` 与 `items` 都没有指向订阅的外键——订阅的真相在
`config.json`，库内没有 feeds 表。所以端点只能自己拼：`listItems`（会把正文全物化）→ 逐条 `deleteItem`（每条一个事务）
→ `deleteFeed`（跨介质：文件 + 库）。

实测后果（2026-11-14，隔离副本注入第 5 次删除失败）：20 条已读条目删掉 4 条、星标 2 → 1、订阅仍在；
下一轮刷新把这 4 条当新条目写回，**已读态与星标永久丢失**，用户只看到一句 `internal` 错误。

## 决定

1. `ReaderStore.deleteSubscription(feedId): Promise<{ items: number }>` 取代 `deleteFeed`，由它拥有
   「订阅项 + 条目 + 游标」这一次变更。
2. **顺序：先写 config，再在一个事务里删 items 与 cursors。** 跨介质没有共同事务，只能选一个失败形态：
   config 先成功 ⇒ 库失败 ⇒ 留下**看不见的孤儿条目**（访问期挡板挡住）；反过来则是用户可见的已读态丢失。
3. 条目删除靠 `DELETE FROM items WHERE feed_id = ?`，子表（texts / item_tags / reading_progress）由
   `ON DELETE CASCADE` 带走。
4. 孤儿只**报告**不自动删：装载时做一次 `GROUP BY feed_id` 与订阅集合比对，有就写日志。

## 后果

- `refresh` 的退订守卫保留（抓取窗口内退订仍会发生），但它只是**前置检查**，残余 TOCTOU 由孤儿报告兜底。
- `lifecycle` 的装载守卫保留（防的是 `config.json` 丢失/被清空），但不再引用「正常退订会删条目」来解释孤儿。
- 退订中途失败时用户看到的是「什么都没发生」，而不是「少了一半」。
