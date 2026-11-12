import { Worker } from 'node:worker_threads'
import type { SearchPage, SearchQuery } from './shared.js'

export function createSearch(path: string) {
  let worker: Worker | undefined
  let closed = false
  let id = 0
  const pending = new Map<number, { resolve: (page: SearchPage) => void; reject: (error: Error) => void }>()

  function start(): Worker {
    const next = new Worker(new URL('./search-worker.js', import.meta.url), { workerData: path })
    const fail = (error: Error): void => {
      if (worker !== next) return
      worker = undefined
      for (const job of pending.values()) job.reject(error)
      pending.clear()
    }
    next.on('error', fail)
    next.on('exit', (code) => fail(new Error('搜索线程已退出（' + code + '）')))
    next.on('message', (response: { id: number; page?: SearchPage; error?: string }) => {
      const job = pending.get(response.id)
      if (!job) return
      pending.delete(response.id)
      if (response.page) job.resolve(response.page)
      else job.reject(new Error(response.error ?? '搜索线程返回了无效结果'))
    })
    worker = next
    return next
  }

  return {
    async run(query: SearchQuery, feeds: Array<[string, string]>, limit: number, signal?: AbortSignal): Promise<SearchPage> {
      if (closed) throw new Error('搜索服务已关闭')
      signal?.throwIfAborted()
      if (pending.size >= 32) throw new Error('搜索请求过多，请稍后重试')
      const target = worker ?? start()
      const requestId = ++id
      const flag = new Int32Array(new SharedArrayBuffer(4))
      // 同步 SQLite 查询期间线程收不到消息，因此跨线程共享取消标记。
      const cancel = (): void => { Atomics.store(flag, 0, 1) }
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        return await new Promise<SearchPage>((resolve, reject) => {
          pending.set(requestId, { resolve, reject })
          target.postMessage({ id: requestId, query, feeds, limit, flag })
        })
      } finally {
        pending.delete(requestId)
        signal?.removeEventListener('abort', cancel)
        signal?.throwIfAborted()
      }
    },
    async close(): Promise<void> {
      closed = true
      await worker?.terminate()
    },
  }
}
