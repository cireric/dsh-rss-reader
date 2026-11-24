# 归档页回溯夹具（R9 01）

全部是 2026-11-23 的真实抓取（`curl` 直连站点），不是手写样本。裁剪只做了三件事：
删 `<style>`、删 `<script>`、删 `<img>`（三者内部都没有 `<a href>`），其余原样保留。
裁剪后逐份复核过下面的「唯一链接数 / 形态命中数」，与抓取时一致。

| 文件 | 来源 URL | 抓取日期 | 唯一 http(s) 链接 |
|---|---|---|---|
| `ryf-archives.html` | https://www.ruanyifeng.com/blog/archives.html | 2026-11-23 | 51 |
| `ryf-month.html` | https://www.ruanyifeng.com/blog/2020/01/ | 2026-11-23 | 23 |
| `yf-month.html`（抓取时名 `/tmp/yf-month.html`） | https://blog.codingnow.com/2026/10/ | 2026-11-23 | 6 |
| `ryf-atom.xml` | http://www.ruanyifeng.com/blog/atom.xml | 2026-11-23 | 3 条 entry（3 个文章链接） |
| `probe-feed.xml`（抓取时名 `/tmp/probe-feed.xml`） | https://blog.codingnow.com/atom.xml | 2026-11-23 | 15 条 entry（15 个文章链接） |

「唯一 http(s) 链接」的口径就是 `extractArchiveLinks` 的口径：`<a href>` 三种引号形态、
相对地址按页面地址解析、只留 `http:` / `https:`、去 fragment、按文档顺序去重。

## 形态命中与候选（验收 A1 / A2 的固定数）

样本 = atom 里 `<entry>` 的 `link`（不是 feed 自己的 `rel="alternate"` 首页链接）：

| 归档页 | 链接 | 形态命中 | 同文键去掉已在 feed | 候选 |
|---|---|---|---|---|
| `ryf-archives.html` | 51 | 20 | 3（atom 是 `http://`，归档页是 `https://`） | 17 |
| `ryf-month.html` | 23 | 8 | 0 | 8 |
| `yf-month.html` | 6 | 3 | 2 | 1（`/2026/01/ai_game_design.html`） |

## `dates/` 小片段

日期夹具不是整页，只保留能看出写法的片段：

- `ruanyf-abbr.html`：从 `ryf-month.html` 的 asset-footer 原样摘录的 `<abbr class="published" title="…">`。
- `visible-zh.html`：票面 A5 指定的可见中文写法「日期：2020年1月3日」，页面壳是构造的。
- `visible-en.html`：云风文章页的可见英文写法「提交于 October 11, 2026 07:30 PM」（spec §1.1 实测），
  时间值取自同页 `dc:date`；页面壳是构造的。
- `time-element.html`：`<time datetime>`，时间值取自云风 atom 的 published。
- `meta-published.html`：`<meta property="article:published_time">`，时间值取自云风 `/2026/10/` 的 `dc:date`。
  **这一级与「URL 完整日期」都没有真实站点实测样本**，见 spec §10 与 `docs/pitfalls.md` 八。
- `month-only.html`：只有年月的页面与 URL，用来钉住「不补 01 日」。
