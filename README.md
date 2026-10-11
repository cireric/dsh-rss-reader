# @dsh-external/dsh-rss-reader

**在 DSH Web GUI 里读 RSS/Atom 的 Google Reader 式阅读流** —— 订阅源列表 + 跨源条目流 +
未读态 + 完整键盘流。不是「每日 digest 注入提示词」那一类。

- **键盘优先**：`j/k` 换条目、`n/p` 扫视、`空格`/`d` 翻页、`u` 左栏显隐、
  `shift+n/p` 左栏移动光标 + `shift+o` 打开、`o` 展开、`V` 读正文、
  `v` 开原站、`s` 星标、`m` 已读、`A` 全部已读（带 5 秒撤销）、`1/2` 切密度、`f` 订阅管理。
  记不住就按 **`?`**（或点头部最右端的 **`?`**）—— 全部键位在帮助浮窗里，浮窗内容逐行来自
  `src/keys.ts` 的 `READER_KEY_HELP`，与实现由单测互锁（见 AGENTS.md「完成定义」）。
- **正文抽取**：按需抓原站页，识别正文容器后抽成结构化块（段落/标题/代码/图片/列表/引用），
  自动滤掉站点头像与页脚二维码。原文想看原样就开新标签页。
- **订阅管理**：OPML 导入导出（导入前逐源抓取校验，坏源逐条列原因）、加源、退订。
- **保留策略**：按源裁剪（星标不自动删）、正文缓存限量、显式清理旧条目，**不设常驻定时器**。
- **安全**：出网地址策略（协议白名单 + 内网拦截 + 解析层拦截 + 重定向每跳复核）。

## 安装

```bash
dsh plugin --profile web add link:/绝对路径/dsh-rss-reader
```

本包**尚无锁文件**：依赖由 `scripts/build.sh` 从 dsh 源码 checkout 现链（不联网安装），
因此不适合独立安装。仓库内开发见下。

## 开发

```bash
npm run build            # host：链接依赖 + tsc → lib/
npm run build:client     # client：tsdown → lib/client.js（改过 src/client/** 必跑）
npm run typecheck        # 两个工程：host + client
npm test                 # 单元/集成 + 真实 DOM 接线
npm run mutation         # 变异门槛：每条都必须被抓到
```

改代码前先扫一遍 [docs/pitfalls.md](docs/pitfalls.md) 的标题 —— 构建与测试的三个坑都在那里。

## 结构

| 目录 | 内容 |
|---|---|
| `src/` | host 半：抓取 / 解析 / 自持存储（SQLite + 迁移）/ 抽取 / HTTP 端点（tsc → `lib/`） |
| `src/client/` | 浏览器半：React 组件 + 状态 store（tsdown → 单文件 `lib/client.js`） |
| `docs/pitfalls.md` | **踩坑与开发经验**：工程流程 / 测试夹具 / React / 宿主平台 / 数据解析 / 产品决定 |
| `docs/google-reader-feature-spec.md` | 功能基准：§5「不变量」是复刻时最容易踩错的地方 |
| `AGENTS.md` | 仓库规则、完成定义、工作约定（给 agent 看） |

数据落**插件自持**存储目录 `$DSH_HOME/storages/rss-reader/`（权限 0700）：

| 文件 | 内容 |
|---|---|
| `rss.db` | 条目库（`node:sqlite`；DDL 在 `src/storage/db.ts`） |
| `config.json` | 订阅源与视图偏好 |
| `reader-YYYY-MM-DD.log` | 刷新日志（按天分文件，保留 14 天；UTC 日期） |

老存储域文件 `$DSH_HOME/storages/rss_reader.json` **只读不写**：装载时一次性迁移进 `rss.db`
与 `config.json`，原文件原样留存。日志路径曾在 `state/dsh-rss-reader/reader.log`，
自持后不再写那个文件。

## 配置

在 DSH 的插件设置里改，字段与默认值见 `src/config.ts`。常用几项：

| 字段 | 默认 | 说明 |
|---|---|---|
| `feeds` | `[]` | 订阅源**种子**，仅首次落库（幂等）。订阅的真相在 `config.json` 里 |
| `refreshOnStart` | true | 装载时刷新一次 |
| `maxItemsPerFeed` | 500 | 每源保留条目数 |
| `cleanupAfterDays` | 30 | 「清理旧条目」的天数阈值 |

## 键盘

| 键 | 动作 |
|---|---|
| `j` / `k` | 列表页：移动选中（不标已读）；正文页：切上/下一条文章（显示即已读） |
| `n` / `p` | 扫视：滚动视野但**不改变选中** |
| `空格` / `shift+空格` | 整屏翻页 |
| `d` / `shift+d` | 半屏翻页（下 / 上）。`shift+d` 于 2026-10-10 接盘原本 `u` 的上半页 |
| `u` | 左栏（订阅导航）显隐（GR 原义，2026-10-10 由「向上半页」归还） |
| `shift+n` / `shift+p` | 在左栏导航里上下移动**光标**（虚拟视图三行 + 订阅源）——只走高亮，**不改变右栏** |
| `shift+o` | **打开**光标所在行（= 点击它）：虚拟视图行 → 切该过滤，源行 → 选该源 |
| `o` | 展开/折叠选中条目并标已读 |
| `V` / `v` | `V` 在阅读器内读正文；`v` 用系统浏览器打开原站 |
| `s` / `m` / `A` | 星标 / 切换已读 / 全部已读（5 秒撤销） |
| `1` / `2` | 展开视图 / 紧凑列表 |
| `r` / `R` | 刷新未读计数（只重取本地视图，**不抓取**） |
| `f` / `F` | 订阅管理（OPML 导入导出、加源、退订） |
| `Esc` | 帮助浮窗开着 → 只关浮窗；正文 → 列表；订阅管理 → 列表 |
| `?` | 快捷键帮助浮窗（开 / 关）。头部最右端那个 `?` 按钮与它等价 |
