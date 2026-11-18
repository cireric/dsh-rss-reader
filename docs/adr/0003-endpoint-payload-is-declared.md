# ADR-0003：端点的入参是声明的一部分

- 状态：已采纳（2026-11-16）
- 适用：`src/endpoints.ts` 的 `EndpointSpec` / `defineEndpoint`、`src/endpoint-payloads.ts`、`createDispatch`

## 背景

2026-10-15 的 H1 深化明确排除 zod：实施计划写「引入 zod：新增依赖 + 供应链审查成本，收益只是少写几行解析 ⇒ 不做」
（`git show 02d7b09:docs/superpowers/plans/2026-10-15-endpoint-registry.md:348`）；终审把
`String((payload as {...})?.x ?? '')` 的解析惯用法定为「刻意保留」
（`git show b3f434b:docs/superpowers/reviews/2026-10-15-endpoint-registry-review.md:64`）。

但那条裁决的两项代价当时就不成立：zod 自 `ef50cba` 起就是运行时依赖，H1 当时（`c901727`）的
`package.json` 已含 `"zod": "^4.4.3"`，`src/domain.ts` 一直用它做记录 schema。留下的只是
「端点里要不要扩大 zod 的用途」。

代价则已经兑现。2026-11-14 评审卡 #8：28 个端点里 23 个接 payload，23 处 `payload as`、
7 处 `String(x ?? '')`、3 处 `map(String)`；只有 `searchItems` 有 schema；「缺字段」与「空串」不可分。
两个具体缺陷：`saveViewPreferences` 缺 `preferences` 键会把默认视图写盘
（`src/endpoints.ts` → `src/store-sqlite.ts` 的 `saveViewPreferences` → `src/preferences.ts` 的
`sanitizeViewPreferences`）；`saveReadingProgress` 缺 `ratio` 会把阅读进度写回 0。

## 决定

1. **重开 H1 的「不引入 zod」裁决**，限定：只用仓库已有的 zod，不新增依赖，不换校验库。
2. `EndpointSpec` 增加必填的 `payload: z.ZodType<unknown>` 与可选的 `invalidMessage`；**28 个端点全部声明**，
   零入参端点声明 `z.unknown()`（语义 = 接受并忽略 payload，与旧行为一致）。
3. 解析**只发生一次**，位置在 `defineEndpoint` 工厂里（`createDispatch` 的四步顺序一个字不动）。
   失败统一回 `bad-request` 信封，`details.issues` 带字段路径与 issue code；handler 拿到已解析的值，
   handler 体内不再有 `payload as`。
4. 声明**只判形状与类型**：键在不在、类型对不对、以及不读外部状态的组合规则（folder / tagId 互斥、
   `from ≤ to`）。业务判定（URL 合法性、文件夹/标签/条目是否存在、比例夹取）留在 handler ——
   它们读 store 或配置，搬进声明就是第二个裁决者。
5. 未知键剥掉（与既有 `searchQuerySchema` 一致）；可选字段上的 `null` 继续当「缺席」
   （旧代码的 `typeof` / `??` 守卫本来就这么判）。范围类端点整份 payload 为 `null`
   （浏览器通道 `browserRpc` 的 `payload ?? null`，即首屏与顶栏刷新的 wire 形状）归一成空对象。
6. **形状解析失败**的文案收敛成每端点一条（写在声明旁边）；handler 自己的业务失败文案不受影响。
   三条金标准文案（`removeFeed` / `opmlImport` / `discoverFeeds`）逐字保留。

## 后果

- 可观测变化只限于「坏类型与必需键缺失」：从静默接受 / 静默写默认变成 `bad-request`。
  `addFeed {url: ''}` 仍是 `ok + failed`；`duplicateHints` 仍截断；`searchItems` 的规则不变；
  越界 `ratio` 仍由 `clampReadingRatio` 夹取。
- `src/endpoints.ts` 不再有**运行时** zod 依赖（只剩一个 `import type { ZodType }`）；每个 handler 少 2–5 行守卫；新增端点默认拿到校验，
  `Record<Endpoint, EndpointSpec>` 少一条声明就编译失败。
- 客户端仍以 `payload: unknown` 调用：payload 类型化到客户端是另一条收益链（会动 20 多个调用点），
  留作候选池。
- 要换校验库时，替换面是 `src/endpoint-payloads.ts` 与 `defineEndpoint` 一处；
  handler 与 dispatch 不受影响。
- 测试面多一份「不经 handler 的 payload 契约」：`ENDPOINTS[name].payload` 可直接 safeParse。
