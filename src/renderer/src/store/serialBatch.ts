/**
 * Coalesces serial data before it reaches the store.
 *
 * A board printing in a tight loop (println + delay(2)) sends hundreds of lines a
 * second, and the USB driver delivers them as many small chunks. Handing each chunk to
 * the store re-rendered the monitor every time, which starved the window: clicks such as
 * Disconnect queued behind the rendering and seemed dead. Batching caps the work at one
 * store update per interval no matter how fast the device talks, and loses nothing.
 */

export const SERIAL_BATCH_MS = 50

export interface ChunkBatcher {
  push: (data: string) => void
  /** Deliver anything pending now (for example before the port closes). */
  flush: () => void
  /** Drop anything pending and stop the timer. */
  cancel: () => void
}

export function createChunkBatcher(deliver: (data: string) => void, intervalMs = SERIAL_BATCH_MS): ChunkBatcher {
  let pending: string[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (pending.length === 0) return
    const data = pending.join('')
    pending = []
    deliver(data)
  }
  return {
    push(data) {
      if (!data) return
      pending.push(data)
      if (!timer) timer = setTimeout(flush, intervalMs)
    },
    flush,
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = []
    }
  }
}
