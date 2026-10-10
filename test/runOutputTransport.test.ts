import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { IPC } from '../src/shared/ipc'
import * as runner from '../src/main/services/runnerService'
import { RUN_OUTPUT_LIMITS } from '../src/main/services/runOutputDelivery'

const windows: BrowserWindow[] = []
const reservations: { id: string; signal: AbortSignal }[] = []
let nextId = 0

function receiver() {
  const send = vi.fn()
  const contents = Object.assign(new EventEmitter(), { send, isDestroyed: () => false })
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: contents })
  windows.push(window as unknown as BrowserWindow)
  return { win: window as unknown as BrowserWindow, send, contents, window }
}

function reserve(win: BrowserWindow, label: string): string {
  const id = `${label}-${++nextId}`
  const signal = runner.beginRunStart(win, id)
  if (!signal) throw new Error('Test reservation was unexpectedly rejected')
  reservations.push({ id, signal })
  return id
}

function finish(id: string): void {
  const reservation = reservations.find(item => item.id === id)
  if (!reservation) throw new Error('Missing test reservation')
  runner.finishRunStart(id, reservation.signal)
}

function drain(win: BrowserWindow, send: ReturnType<typeof vi.fn>): [string, any][] {
  let index = 0
  while (index < send.mock.calls.length) {
    if (index > 10000) throw new Error('Output transport did not drain within its finite entry budget')
    const [, payload] = send.mock.calls[index++]
    runner.acknowledgeOutput(win, payload.deliveryToken)
  }
  return send.mock.calls as [string, any][]
}

afterEach(() => {
  for (const { id, signal } of reservations.splice(0)) runner.finishRunStart(id, signal)
  for (const window of windows.splice(0)) runner.disposeWindowRuns(window)
})

describe('runner output transport under a stalled renderer', () => {
  it('has a fixed in-flight message bound even when producers emit many small chunks', () => {
    const { win, send } = receiver()
    const id = reserve(win, 'flood')
    for (let index = 0; index < 65536; index++) runner.sendRunOutput(win, id, 'stdout', 'x'.repeat(256))
    expect(send.mock.calls.filter(([channel]) => channel === IPC.RUN_OUTPUT)).toHaveLength(1)
  })

  it('does not let a compile exit overtake its final pending output', () => {
    const { win, send } = receiver()
    const id = reserve(win, 'fence')
    runner.sendRunOutput(win, id, 'stdout', 'first\n')
    runner.sendRunOutput(win, id, 'stderr', 'last diagnostic\n')
    runner.sendRunExit(win, { id, code: 1, signal: null, durationMs: 1, phase: 'compile' })
    expect(send.mock.calls.filter(([channel]) => channel === IPC.RUN_EXIT)).toHaveLength(0)
    finish(id)
    expect(drain(win, send).map(([channel, payload]) => [channel, payload.data ?? payload.code])).toEqual([
      [IPC.RUN_OUTPUT, 'first\n'], [IPC.RUN_OUTPUT, 'last diagnostic\n'], [IPC.RUN_EXIT, 1]
    ])
  })

  it('bounds retained bytes and explicitly accounts for every omitted byte', () => {
    const { win, send } = receiver()
    const id = reserve(win, 'bytes')
    const total = 16 * 1024 * 1024
    runner.sendRunOutput(win, id, 'stdout', 'x'.repeat(total))
    runner.sendRunExit(win, { id, code: 0, signal: null, durationMs: 1, phase: 'run' })
    finish(id)
    const messages = drain(win, send)
    const output = messages.filter(([channel]) => channel === IPC.RUN_OUTPUT).map(([, payload]) => payload)
    const retained = output.filter(item => !item.omitted).reduce((sum, item) => sum + Buffer.byteLength(item.data), 0)
    const omitted = output.reduce((sum, item) => sum + (item.omitted?.stdout ?? 0), 0)
    expect(retained).toBeGreaterThanOrEqual(RUN_OUTPUT_LIMITS.queuedBytes)
    expect(retained).toBeLessThanOrEqual(RUN_OUTPUT_LIMITS.queuedBytes + RUN_OUTPUT_LIMITS.packetBytes)
    expect(retained + omitted).toBe(total)
    expect(output.filter(item => item.omitted)).toHaveLength(1)
    expect(messages.at(-1)?.[0]).toBe(IPC.RUN_EXIT)
    for (const [, payload] of messages) expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(RUN_OUTPUT_LIMITS.packetBytes)
  })

  it('bounds entry count across interleaved ids and streams without silently losing their identity', () => {
    const { win, send } = receiver()
    const ids = [reserve(win, 'a'), reserve(win, 'b')]
    for (let index = 0; index < 10000; index++) runner.sendRunOutput(win, ids[index % 2], index % 3 === 0 ? 'stderr' : 'stdout', 'z')
    for (const id of ids) { runner.sendRunExit(win, { id, code: 0, signal: null, durationMs: 1, phase: 'run' }); finish(id) }
    const output = drain(win, send).filter(([channel]) => channel === IPC.RUN_OUTPUT).map(([, payload]) => payload)
    expect(output.length).toBeLessThanOrEqual(RUN_OUTPUT_LIMITS.outputEntries + 1)
    for (const id of ids) {
      const matching = output.filter(item => item.id === id)
      const accounted = matching.reduce((sum, item) => sum + (item.omitted ? item.omitted.stdout + item.omitted.stderr + item.omitted.system : Buffer.byteLength(item.data)), 0)
      expect(accounted).toBe(5000)
      expect(matching.some(item => item.omitted)).toBe(true)
    }
  })

  it('keeps Unicode intact and caps serialized packets including escaped control characters', () => {
    const { win, send } = receiver()
    const id = reserve(win, 'unicode')
    const text = ('\u{1F642}\u0000\n\t').repeat(4000)
    runner.sendRunOutput(win, id, 'stdout', text)
    finish(id)
    const output = drain(win, send).map(([, payload]) => payload)
    expect(output.map(item => item.data).join('')).toBe(text)
    for (const item of output) {
      expect(item.data).not.toContain('\uFFFD')
      expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThanOrEqual(RUN_OUTPUT_LIMITS.packetBytes)
    }
  })

  it('preserves a successful compile fence before program output and the final run exit', () => {
    const { win, send } = receiver()
    const id = reserve(win, 'phases')
    runner.sendRunOutput(win, id, 'system', 'compiler\n')
    runner.sendRunExit(win, { id, code: 0, signal: null, durationMs: 1, phase: 'compile' })
    runner.sendRunOutput(win, id, 'stdout', 'program\n')
    runner.sendRunExit(win, { id, code: 0, signal: null, durationMs: 1, phase: 'run' })
    finish(id)
    expect(drain(win, send).map(([channel, payload]) => [channel, payload.data ?? payload.phase])).toEqual([
      [IPC.RUN_OUTPUT, 'compiler\n'], [IPC.RUN_EXIT, 'compile'], [IPC.RUN_OUTPUT, 'program\n'], [IPC.RUN_EXIT, 'run']
    ])
  })

  it('seals omission intervals at compile and run fences instead of moving program omissions earlier', () => {
    const { win, send } = receiver()
    const id = reserve(win, 'omitted-phases')
    runner.sendRunOutput(win, id, 'stderr', 'c'.repeat(1024 * 1024))
    runner.sendRunExit(win, { id, code: 0, signal: null, durationMs: 1, phase: 'compile' })
    runner.sendRunOutput(win, id, 'stdout', 'r'.repeat(1024 * 1024))
    runner.sendRunExit(win, { id, code: 0, signal: null, durationMs: 1, phase: 'run' })
    finish(id)
    const messages = drain(win, send)
    const compile = messages.findIndex(([channel, payload]) => channel === IPC.RUN_EXIT && payload.phase === 'compile')
    const program = messages.findIndex(([, payload]) => payload.omitted?.stdout)
    expect(program).toBeGreaterThan(compile)
    expect(messages.at(-1)?.[1].phase).toBe('run')
  })

  it('still aggregates the current phase marker when an older sealed marker is delivered', () => {
    const { win, send } = receiver()
    const id = reserve(win, 'marker-identity')
    runner.sendRunOutput(win, id, 'stderr', 'c'.repeat(1024 * 1024))
    runner.sendRunExit(win, { id, code: 0, signal: null, durationMs: 1, phase: 'compile' })
    runner.sendRunOutput(win, id, 'stdout', 'r'.repeat(1024 * 1024))
    for (let step = 0; !send.mock.calls.at(-1)?.[1].omitted?.stderr; step++) {
      if (step > RUN_OUTPUT_LIMITS.outputEntries * 8) throw new Error('The bounded compile omission marker was never delivered')
      runner.acknowledgeOutput(win, send.mock.calls.at(-1)?.[1].deliveryToken)
    }
    runner.sendRunOutput(win, id, 'stdout', 'late'.repeat(256 * 1024))
    runner.sendRunExit(win, { id, code: 0, signal: null, durationMs: 1, phase: 'run' })
    finish(id)
    const messages = drain(win, send)
    const runMarkers = messages.map(([, payload]) => payload).filter(payload => payload.omitted?.stdout)
    expect(runMarkers).toHaveLength(1)
    expect(runMarkers[0].omitted.stdout).toBe(2 * 1024 * 1024)
  })

  it('refuses missing, wrong and repeated ACK tokens without releasing another packet', () => {
    const { win, send } = receiver()
    const id = reserve(win, 'tokens')
    runner.sendRunOutput(win, id, 'stdout', 'one')
    runner.sendRunOutput(win, id, 'stderr', 'two')
    for (const token of [undefined, null, {}, 'wrong']) runner.acknowledgeOutput(win, token)
    expect(send).toHaveBeenCalledTimes(1)
    const token = send.mock.calls[0][1].deliveryToken
    runner.acknowledgeOutput(win, token)
    expect(send).toHaveBeenCalledTimes(2)
    runner.acknowledgeOutput(win, token)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('rejects additional stalled runs before spawn and releases admission after failed-compile output drains', async () => {
    const { win, send } = receiver()
    const ids = Array.from({ length: RUN_OUTPUT_LIMITS.runs }, (_, index) => reserve(win, `stalled-${index}`))
    for (const id of ids) {
      runner.sendRunOutput(win, id, 'stdout', 'waiting')
      runner.sendRunExit(win, { id, code: 1, signal: null, durationMs: 1, phase: 'compile' })
      finish(id)
    }
    await expect(runner.startRun(win, { id: 'overflow', language: 'javascript', cwd: 'unused', filePath: 'unused.js' })).rejects.toThrow(/maximum 32/)
    expect(send).toHaveBeenCalledTimes(1)
    const messages = drain(win, send)
    expect(messages.filter(([channel]) => channel === IPC.RUN_EXIT)).toHaveLength(RUN_OUTPUT_LIMITS.runs)
    expect(() => reserve(win, 'after-drain')).not.toThrow()
  })

  it('disposes old deliveries on reload and ignores old producer sends and ACKs', () => {
    const { win, send } = receiver()
    const old = reserve(win, 'old')
    runner.sendRunOutput(win, old, 'stdout', 'old first')
    const stale = send.mock.calls[0][1].deliveryToken
    runner.disposeWindowRuns(win)
    expect(reservations.find(item => item.id === old)?.signal.aborted).toBe(true)
    expect(() => runner.beginRunStart(win, old)).toThrow(/still active or cancelling/)
    const current = reserve(win, 'current')
    runner.sendRunOutput(win, current, 'stdout', 'current first')
    runner.sendRunOutput(win, current, 'stdout', 'current last')
    runner.sendRunOutput(win, old, 'stdout', 'stale output')
    runner.sendRunExit(win, { id: old, code: 0, signal: null, durationMs: 1, phase: 'run' })
    runner.acknowledgeOutput(win, stale)
    expect(send).toHaveBeenCalledTimes(2)
    runner.acknowledgeOutput(win, send.mock.calls[1][1].deliveryToken)
    expect(send.mock.calls[2][1].data).toBe('current last')
  })

  it('keeps different windows independent and rejects overlong ids before allocating delivery state', () => {
    const first = receiver()
    const second = receiver()
    const a = reserve(first.win, 'window-a')
    const b = reserve(second.win, 'window-b')
    runner.sendRunOutput(first.win, a, 'stdout', 'a')
    runner.sendRunOutput(second.win, b, 'stdout', 'b')
    runner.sendRunOutput(first.win, a, 'stderr', 'a2')
    runner.acknowledgeOutput(second.win, first.send.mock.calls[0][1].deliveryToken)
    expect(first.send).toHaveBeenCalledTimes(1)
    expect(second.send).toHaveBeenCalledTimes(1)
    expect(() => runner.beginRunStart(first.win, 'x'.repeat(257))).toThrow(/256 UTF-8 bytes/)
  })
})
