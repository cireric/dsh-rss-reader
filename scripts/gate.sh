#!/bin/bash
# L1 门禁（M5 05 的方案 A）：一条命令跑完「host 构建 → client 构建 → 类型检查 → 测试」，
# 逐条打印退出码与耗时。**不做 L2（变异门槛）**：它要独占机器、按批跑，见
# docs/ops/build-reproducibility.md §7.2 —— 把 15 分钟的活塞进这里只会让人不再跑它。
#
# 用法：bash scripts/gate.sh
# 退出码：0 = 四条全过；否则是第一条失败的退出码（后面的步骤标记为跳过）。
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 与 build.sh 同一套 checkout 探测：L1 里有两步依赖它（tsc / tsdown 都在 checkout 的 .bin 里）
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness" "$HOME/deepseek-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "gate: 找不到 dsh checkout（设 DSH_CHECKOUT）" >&2
  exit 1
fi
export DSH_CHECKOUT="$CHECKOUT"
export PATH="$CHECKOUT/node_modules/.bin:$PATH"

step_names=("build" "build:client" "typecheck" "test")
step_cmds=("npm run build" "npm run build:client" "npm run typecheck" "npm test")

failed=0
summary=""
for i in "${!step_names[@]}"; do
  name="${step_names[$i]}"
  cmd="${step_cmds[$i]}"
  if [ "$failed" -ne 0 ]; then
    summary="$summary\n  - $name\t跳过（前面的步骤已失败）"
    continue
  fi
  start=$(date +%s)
  echo ""
  echo "=== gate: $name ==="
  eval "$cmd"
  code=$?
  elapsed=$(( $(date +%s) - start ))
  if [ "$code" -ne 0 ]; then
    failed=$code
    summary="$summary\n  ✗ $name\texit=$code\t${elapsed}s"
  else
    summary="$summary\n  ✓ $name\texit=0\t${elapsed}s"
  fi
done

echo ""
echo "=== L1 汇总（checkout: $CHECKOUT）==="
echo -e "$summary"
if [ "$failed" -ne 0 ]; then
  echo ""
  echo "L1 未通过：exit=$failed"
  exit "$failed"
fi
echo ""
echo "L1 全过。L2（变异门槛）与 L3（真机三步）不在本脚本里，见 docs/ops/build-reproducibility.md §7.2。"
