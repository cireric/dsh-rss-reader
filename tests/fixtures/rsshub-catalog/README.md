# RSSHub 目录快照夹具（R15 04）

`rssforever-2026-11-27.json` 取自真实实例 `https://rsshub.rssforever.com/api/namespace`：

- 抓取日期：2026-11-27（本机 `curl`，HTTP 200，3,289,636 字节，4.5 s 内返回）
- 原始规模：1,589 个站点 / 3,288 条路由
- 原始事实计数：`features.requireConfig` 非空数组 180 条、`features.nsfw === true` 209 条、
  `features.nfsw === true` 1 条（与 spec §1.3 的实测数字一致）

## 裁剪口径

只保留下面 6 个站点与 6 条路由，其余站点 / 路由删除；**保留下来的字段与值逐字节来自原始回包**
（没有补字段、没有改值）。每站只留一条路由，是为了让三种 `requireConfig` 形态、`nsfw` 与
`nfsw` 拼写漂移在同一份夹具里可读。

| 站点 | 路由 | `requireConfig` 原始值 | 用途 |
|---|---|---|---|
| `github` | `/branches/:user/:repo` | `false` | 三态之 `none` |
| `163` | `/music/playlist/:id` | 全可选数组（`optional: true`） | 三态之 `optional` |
| `dianping` | `/user/:id` | 含 `optional: false` 的数组 | 三态之 `required` |
| `instagram` | `/:category/:key` | 混合数组（可选项 + 无 `optional` 的必填项） | 「有一项不是可选项即必填」 |
| `2048` | `/:id?` | `false` | `nsfw: true` 的事实来源 |
| `0xxx` | `/:filter?` | `false` | 拼写漂移 `nfsw: true`（**不映射**成 `nsfw`） |

## 复现抓取

```bash
curl -sS https://rsshub.rssforever.com/api/namespace -o /tmp/rsshub-namespace.json
```

实例目录会随时间变化；上表的计数只对 2026-11-27 这份快照成立。
