# 官方周测 JSON 夹具（R15 05）

## 来源

- 地址：`https://rsshub.js.org/build/test-full-routes.json`
- 抓取日期：2026-11-27（本机直连，实测 1,731,054 字节 / 3.9 s）
- 原始总量：`testResults[].assertionResults[]` 合计 **3,947** 条 —— 2,676 `passed` / 1,271 `failed`；其中 3,943 条标题以 `/` 开头（路由测试），4 条不以 `/` 开头（`exports app entrypoint` 等非路由标题）。
- 顶层是 Jest 汇总对象（`numTotalTests` / `success` / `testResults` …），路由测试的 `title` 就是完整路径模板。

### 为什么裁成一个子集

原始文件 1.7 MB，且每周变化。测试只需要形状与状态两类样本，提交整份原始文件会让仓库每次周更都背上一个不可复现的大文件。因此：

- `assertionResults` **裁剪为 7 条**：3 条 `passed` 路由（含一条可选参数 `:page?`）、2 条 `failed` 路由、2 条非路由标题（`exports app entrypoint` / `serve index`，均为 `passed`）；
- 顶层 `numTotal*` / `success` 等数字**保留原始值**（3,947 / 2,676 / 1,271），表示这批样本来自哪一份真实汇总；它们不参与解析，也不应被当成夹具里 7 条断言的计数；
- `name` / `status` / 断言对象字段（`ancestorTitles` / `fullName` / `duration` / `failureMessages` …）原样保留，避免把形状裁剪成「手写形状」——旧夹具手写 `requireConfig: true` 的经验就是这么来的（`docs/pitfalls.md` §2.6）。

## 另一个文件

- `shape-drift.json`：`testResults[0]` 缺少 `assertionResults`。它不是真实数据，用来钉「上游结构漂移 ⇒ 整份数据按不可用处理（返回 `undefined`），探索页只是没有周测标注」。
