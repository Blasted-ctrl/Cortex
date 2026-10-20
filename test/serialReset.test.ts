import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'

type Callback = (error: Error | null) => void
let instances: MockSerialPort[]
let setError: Error | null

class MockSerialPort extends EventEmitter {
  static list = vi.fn(async () => [])
  isOpen = false
  signals: Array<{ dtr: boolean; rts: boolean; at: number }> = []
  write = vi.fn()
  close = vi.fn((callback: Callback) => { this.isOpen = false; callback(null); this.emit('close') })
  set = vi.fn((signals: { dtr: boolean; rts: boolean }, callback: Callback) => {
    this.signals.push({ ...signals, at: Date.now() })
    callback(setError)
  })
  constructor(public options: { path: string }) {
    super()
    instances.push(this)
  }
  open(callback?: Callback): void {
    this.isOpen = true
    this.emit('open')
    callback?.(null)
  }
}

const win = { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow
let serial: typeof import('../src/main/services/serialService')

beforeEach(async () => {
  vi.resetModules()
  instances = []
  setError = null
  vi.doMock('serialport', () => ({ SerialPort: MockSerialPort }))
  serial = await import('../src/main/services/serialService')
})

afterEach(() => {
  vi.doUnmock('serialport')
})

describe('resetBoard', () => {
  it('pulses RTS (the reset line) with DTR released, then releases both', async () => {
    expect(await serial.openPort(win, { path: 'COM5', baudRate: 115200 })).toBe(true)
    expect(await serial.resetBoard()).toBe(true)
    const steps = instances[0].signals
    expect(steps.map(({ dtr, rts }) => ({ dtr, rts }))).toEqual([
      { dtr: false, rts: true },  // EN low: the chip is held in reset; GPIO0 high
      { dtr: false, rts: false } // EN high: it boots and runs the sketch, not the bootloader
    ])
    expect(steps[1].at - steps[0].at).toBeGreaterThanOrEqual(90)
  })

  it('never drives DTR, which would put an ESP32 into its flash bootloader', async () => {
    await serial.openPort(win, { path: 'COM5', baudRate: 115200 })
    await serial.resetBoard()
    expect(instances[0].signals.every((s) => s.dtr === false)).toBe(true)
  })

  it('does nothing and reports false with no open port', async () => {
    expect(await serial.resetBoard()).toBe(false)
  })

  it('reports a driver failure instead of claiming success', async () => {
    await serial.openPort(win, { path: 'COM5', baudRate: 115200 })
    setError = new Error('Operation not supported')
    await expect(serial.resetBoard()).rejects.toThrow('Operation not supported')
  })
})
