import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc'
import type { RunExit, RunOutputChunk } from '../../shared/ipc'

export const RUN_OUTPUT_LIMITS = {
  runs: 32,
  queuedBytes: 256 * 1024,
  outputEntries: 128,
  packetBytes: 32 * 1024,
  idBytes: 256
} as const

type Stream = RunOutputChunk['stream']
type Omitted = NonNullable<RunOutputChunk['omitted']>
type Entry =
  | { kind: 'output'; id: string; stream: Stream; data: string }
  | { kind: 'omitted'; id: string; omitted: Omitted }
  | { kind: 'exit'; id: string; exit: RunExit }

interface RunDelivery { finished: boolean; exits: number }
interface InFlight { id: string; token: string }

function prefixLength(data: string, fits: (prefix: string) => boolean, upper: number): number {
  let low = 0
  let high = Math.min(data.length, upper)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(data.slice(0, middle))) low = middle
    else high = middle - 1
  }
  // Keep a UTF-16 surrogate pair together so transport slicing cannot turn a
  // decoded UTF-8 character into two replacement characters.
  if (low && low < data.length && /[\uD800-\uDBFF]/.test(data[low - 1])) low--
  return low
}

class OutputDelivery {
  private readonly runs = new Map<string, RunDelivery>()
  private readonly entries: Entry[] = []
  private readonly omissions = new Map<string, Extract<Entry, { kind: 'omitted' }>>()
  private queuedBytes = 0
  private outputEntries = 0
  private inFlight: InFlight | null = null
  private pumping = false
  private disposed = false

  constructor(private readonly window: BrowserWindow) {}

  reserve(id: string): void {
    if (typeof id !== 'string' || !id || Buffer.byteLength(id) > RUN_OUTPUT_LIMITS.idBytes) throw new Error('Run id must be a non-empty string of at most 256 UTF-8 bytes.')
    if (this.disposed || this.window.isDestroyed()) throw new Error('The run window is closed.')
    if (this.runs.has(id)) throw new Error('This run is still delivering output. Wait for it to finish or reload the window.')
    if (this.runs.size >= RUN_OUTPUT_LIMITS.runs) throw new Error('The output receiver is not responding or too many runs are outstanding (maximum 32). Wait for output to finish or reload the window before starting another run.')
    this.runs.set(id, { finished: false, exits: 0 })
  }

  output(id: string, stream: Stream, data: string): void {
    const run = this.runs.get(id)
    if (this.disposed || !run || run.finished || run.exits >= 2 || !data) return
    const omitted = this.omissions.get(id)
    if (omitted) {
      this.omit(omitted, stream, Buffer.byteLength(data))
      return
    }
    let offset = 0
    while (offset < data.length) {
      const tail = this.entries.at(-1)
      const coalesce = tail?.kind === 'output' && tail.id === id && tail.stream === stream && Buffer.byteLength(tail.data) < RUN_OUTPUT_LIMITS.packetBytes ? tail : null
      const entryRoom = RUN_OUTPUT_LIMITS.packetBytes - (coalesce ? Buffer.byteLength(coalesce.data) : 0)
      const room = Math.min(RUN_OUTPUT_LIMITS.queuedBytes - this.queuedBytes, entryRoom)
      const entryAvailable = coalesce || this.outputEntries < RUN_OUTPUT_LIMITS.outputEntries - RUN_OUTPUT_LIMITS.runs * 2
      const remaining = data.slice(offset)
      const count = entryAvailable && room > 0 ? prefixLength(remaining, prefix => Buffer.byteLength(prefix) <= room, room) : 0
      if (!count) {
        const marker: Extract<Entry, { kind: 'omitted' }> = { kind: 'omitted', id, omitted: { stdout: 0, stderr: 0, system: 0 } }
        this.omit(marker, stream, Buffer.byteLength(remaining))
        this.omissions.set(id, marker)
        this.entries.push(marker)
        break
      }
      const text = remaining.slice(0, count)
      if (coalesce) coalesce.data += text
      else {
        this.entries.push({ kind: 'output', id, stream, data: text })
        this.outputEntries++
      }
      this.queuedBytes += Buffer.byteLength(text)
      offset += count
      this.pump()
    }
    this.pump()
  }

  exit(payload: RunExit): void {
    const run = this.runs.get(payload.id)
    if (this.disposed || !run) return
    if (run.exits >= 2) throw new Error('A run cannot produce more than its reserved compile and run exits.')
    run.exits++
    // Seal the omission interval at the phase fence. Program output cannot be
    // counted in a marker that is delivered before its compile completion.
    this.omissions.delete(payload.id)
    this.entries.push({ kind: 'exit', id: payload.id, exit: payload })
    this.pump()
  }

  finish(id: string): void {
    const run = this.runs.get(id)
    if (!run) return
    run.finished = true
    this.release(id)
  }

  acknowledge(token: unknown): void {
    if (typeof token !== 'string' || this.inFlight?.token !== token || this.disposed) return
    const id = this.inFlight.id
    this.inFlight = null
    this.release(id)
    this.pump()
  }

  dispose(): void {
    this.disposed = true
    this.entries.length = 0
    this.runs.clear()
    this.omissions.clear()
    this.inFlight = null
    this.queuedBytes = this.outputEntries = 0
  }

  private omit(entry: Extract<Entry, { kind: 'omitted' }>, stream: Stream, bytes: number): void {
    entry.omitted[stream] = Math.min(Number.MAX_SAFE_INTEGER, entry.omitted[stream] + bytes)
  }

  private release(id: string): void {
    if (this.runs.get(id)?.finished && this.inFlight?.id !== id && !this.entries.some(entry => entry.id === id)) this.runs.delete(id)
  }

  private pump(): void {
    if (this.pumping || this.disposed) return
    this.pumping = true
    try {
      while (!this.inFlight && this.entries.length && !this.disposed) {
        if (this.window.isDestroyed() || this.window.webContents.isDestroyed()) {
          this.dispose()
          break
        }
        const entry = this.entries[0]
        const token = randomUUID()
        let channel: string = IPC.RUN_OUTPUT
        let payload: RunOutputChunk | RunExit
        if (entry.kind === 'exit') {
          channel = IPC.RUN_EXIT
          payload = { ...entry.exit, deliveryToken: token }
          this.entries.shift()
        } else if (entry.kind === 'omitted') {
          const detail = Object.entries(entry.omitted).filter(([, bytes]) => bytes).map(([stream, bytes]) => `${bytes} ${stream} bytes`).join(', ')
          payload = { id: entry.id, stream: 'system', data: `\n[Cortex omitted ${detail} while the output receiver was busy.]\n`, omitted: { ...entry.omitted }, deliveryToken: token }
          this.entries.shift()
          if (this.omissions.get(entry.id) === entry) this.omissions.delete(entry.id)
        } else {
          const base = { id: entry.id, stream: entry.stream, deliveryToken: token }
          const count = prefixLength(entry.data, data => Buffer.byteLength(JSON.stringify({ ...base, data })) <= RUN_OUTPUT_LIMITS.packetBytes, RUN_OUTPUT_LIMITS.packetBytes)
          const data = entry.data.slice(0, count)
          payload = { ...base, data }
          entry.data = entry.data.slice(count)
          this.queuedBytes -= Buffer.byteLength(data)
          if (!entry.data) { this.entries.shift(); this.outputEntries-- }
        }
        this.inFlight = { id: entry.id, token }
        try { this.window.webContents.send(channel, payload) } catch { this.dispose() }
      }
    } finally { this.pumping = false }
  }
}

const deliveries = new WeakMap<BrowserWindow, OutputDelivery>()

export function reserveRunOutput(window: BrowserWindow, id: string): void {
  let delivery = deliveries.get(window)
  if (!delivery) { delivery = new OutputDelivery(window); deliveries.set(window, delivery) }
  delivery.reserve(id)
}

export function deliverRunOutput(window: BrowserWindow, id: string, stream: Stream, data: string): void { deliveries.get(window)?.output(id, stream, data) }
export function deliverRunExit(window: BrowserWindow, payload: RunExit): void { deliveries.get(window)?.exit(payload) }
export function finishRunOutput(window: BrowserWindow, id: string): void { deliveries.get(window)?.finish(id) }
export function acknowledgeRunOutput(window: BrowserWindow, token: unknown): void { deliveries.get(window)?.acknowledge(token) }
export function disposeRunOutput(window: BrowserWindow): void { deliveries.get(window)?.dispose(); deliveries.delete(window) }
