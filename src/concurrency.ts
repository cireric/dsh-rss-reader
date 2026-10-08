/**
 * 有界并发映射：最多 limit 个任务同时在飞，返回值与输入**按下标一一对应**。
 *
 * 为什么抽出来：refresh.ts 与 subscribe.ts 各自有一份 worker 池实现（同一形状两份代码），
 * 而两份都有同一个隐患 —— limit 缺失或非法时 Math.min(undefined, n) 得到 NaN，
 * Array.from({ length: NaN }) 产出**空**的 worker 列表，于是「一个任务都不跑」，调用方拿到
 * 一列空结果却没有任何报错。这类静默空转比抛错难查得多（2026-10-07 实测踩到：新增的并发
 * 选项漏传时，刷新静默变成空操作）。
 *
 * 所以这里把非法 limit 一律收敛成 1（串行）——与仓库其它地方对非法配置的处理一致
 * （truncateContent 把非法上限视为不截断、clampScrollTop 把非有限值视为 0）：宁可退化成
 * 串行，也不要静默不干活。
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  const bound = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await run(items[index], index)
    }
  }

  const workers = Math.max(1, Math.min(bound, items.length))
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}
