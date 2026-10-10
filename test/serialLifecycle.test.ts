import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { IPC } from '../src/shared/ipc'

type Callback = (error: Error | null) => void
let instances: MockSerialPort[]
let autoClose: boolean
let immediateOpen: boolean

class MockSerialPort extends EventEmitter {
  static list = vi.fn(async () => [])
  isOpen = false
  opening = false
  openingCallback?: Callback
  closingCallback?: Callback
  write = vi.fn()
  close = vi.fn((callback: Callback) => {
    this.closingCallback = callback
    if (autoClose) this.finishClose()
  })
  constructor(public options: { path: string; autoOpen?: boolean }, callback?: Callback) {
    super()
    instances.push(this)
    if (options.autoOpen !== false) this.open(callback)
  }
  open(callback?: Callback): void {
    this.opening = true
    this.openingCallback = callback
    if (immediateOpen) {
      this.emit('data', Buffer.from('startup\n'))
      this.finishOpen()
    }
  }
  finishOpen(error: Error | null = null): void {
    this.opening = false
    this.isOpen = !error
    if (!error) this.emit('open')
    this.openingCallback?.(error)
  }
  finishClose(error: Error | null = null): void {
    if (!error) this.isOpen = false
    this.closingCallback?.(error)
    if (!error) this.emit('close')
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((ok) => { resolve = ok })
  return { promise, resolve }
}

const send = vi.fn()
const win = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow
let serial: typeof import('../src/main/services/serialService')

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  instances = []
  autoClose = true
  immediateOpen = false
  vi.doMock('serialport', () => ({ SerialPort: MockSerialPort }))
  serial = await import('../src/main/services/serialService')
})

afterEach(() => {
  vi.useRealTimers()
  vi.doUnmock('serialport')
})

async function opening(path = 'COM5'): Promise<{ result: Promise<boolean>; port: MockSerialPort }> {
  const count = instances.length
  const result = serial.openPort(win, { path, baudRate: 115200 })
  await vi.waitFor(() => expect(instances).toHaveLength(count + 1))
  return { result, port: instances[count] }
}

describe('serial lifecycle ownership without hardware', () => {
  it('attaches listeners before explicitly opening a port', async () => {
    immediateOpen = true
    expect(await serial.openPort(win, { path: 'COM5', baudRate: 115200 })).toBe(true)
    expect(instances[0].options.autoOpen).toBe(false)
    expect(send).toHaveBeenCalledWith(IPC.SERIAL_DATA, { path: 'COM5', data: 'startup\n' })
  })

  it('cancels an open that is still loading the native module', async () => {
    vi.resetModules()
    const loaded = deferred<{ SerialPort: typeof MockSerialPort }>()
    vi.doMock('serialport', () => loaded.promise)
    serial = await import('../src/main/services/serialService')
    const result = serial.openPort(win, { path: 'COM5', baudRate: 115200 })
    await serial.closePort()
    loaded.resolve({ SerialPort: MockSerialPort })
    expect(await result).toBe(false)
    expect(instances).toHaveLength(0)
  })

  it('does not let an old failed open clear a newer successful port', async () => {
    const old = await opening('COM5')
    const current = await opening('COM7')
    current.port.finishOpen()
    expect(await current.result).toBe(true)
    old.port.finishOpen(new Error('Old port vanished'))
    expect(await old.result).toBe(false)
    await serial.writePort('new-port-only')
    expect(current.port.write).toHaveBeenCalledWith('new-port-only')
    expect(send).not.toHaveBeenCalledWith(IPC.SERIAL_STATUS, expect.objectContaining({ path: 'COM5', message: 'Old port vanished' }))
  })

  it('closes a superseded late successful open without publishing stale events', async () => {
    const old = await opening('COM5')
    const current = await opening('COM7')
    current.port.finishOpen()
    await current.result
    send.mockClear()
    old.port.finishOpen()
    expect(await old.result).toBe(false)
    old.port.emit('data', Buffer.from('old data'))
    old.port.emit('error', new Error('Old error'))
    expect(old.port.close).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
    await serial.writePort('current')
    expect(current.port.write).toHaveBeenCalledWith('current')
  })

  it('cancels a pending native open even when its callback succeeds later', async () => {
    const pending = await opening()
    await serial.closePort()
    pending.port.finishOpen()
    expect(await pending.result).toBe(false)
    expect(pending.port.close).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalledWith(IPC.SERIAL_STATUS, expect.objectContaining({ open: true }))
  })

  it('a delayed close cannot clear the next port and is shared by concurrent callers', async () => {
    const old = await opening()
    old.port.finishOpen()
    await old.result
    autoClose = false
    const closing = serial.closePort()
    const next = serial.openPort(win, { path: 'COM7', baudRate: 115200 })
    await vi.waitFor(() => expect(old.port.close).toHaveBeenCalled())
    old.port.finishClose()
    await closing
    await vi.waitFor(() => expect(instances).toHaveLength(2))
    instances[1].finishOpen()
    expect(await next).toBe(true)
    expect(old.port.close).toHaveBeenCalledOnce()
    await serial.writePort('new connection')
    expect(instances[1].write).toHaveBeenCalledWith('new connection')
  })

  it('reports close failure without forgetting a still-open native port', async () => {
    const active = await opening()
    active.port.finishOpen()
    await active.result
    autoClose = false
    const closing = serial.closePort()
    const failed = expect(closing).rejects.toThrow('Driver refused close')
    active.port.finishClose(new Error('Driver refused close'))
    await failed
    await serial.writePort('still owned')
    expect(active.port.write).toHaveBeenCalledWith('still owned')
    active.port.emit('data', Buffer.from('still receiving'))
    expect(send).toHaveBeenCalledWith(IPC.SERIAL_DATA, { path: 'COM5', data: 'still receiving' })
  })

  it('decodes a UTF-8 character split across native data chunks exactly once', async () => {
    const active = await opening()
    active.port.finishOpen()
    await active.result
    send.mockClear()
    active.port.emit('data', Buffer.from([0xe2]))
    active.port.emit('data', Buffer.from([0x82, 0xac]))
    expect(send.mock.calls.filter(([channel]) => channel === IPC.SERIAL_DATA)).toEqual([
      [IPC.SERIAL_DATA, { path: 'COM5', data: '\u20ac' }]
    ])
  })

  it('bounds a native open that never calls back and closes a later success', async () => {
    vi.useFakeTimers()
    const pending = await opening()
    await vi.advanceTimersByTimeAsync(15_001)
    expect(await pending.result).toBe(false)
    expect(send).toHaveBeenCalledWith(IPC.SERIAL_STATUS, expect.objectContaining({ open: false, message: expect.stringContaining('timed out') }))
    pending.port.finishOpen()
    expect(pending.port.close).toHaveBeenCalledOnce()
  })

  it('bounds a native close that never calls back without dropping ownership', async () => {
    const active = await opening()
    active.port.finishOpen()
    await active.result
    autoClose = false
    vi.useFakeTimers()
    const closing = serial.closePort()
    const failed = expect(closing).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(10_001)
    await failed
    await serial.writePort('still owned after timeout')
    expect(active.port.write).toHaveBeenCalledWith('still owned after timeout')
    active.port.emit('data', Buffer.from('still receiving after timeout'))
    expect(send).toHaveBeenCalledWith(IPC.SERIAL_DATA, { path: 'COM5', data: 'still receiving after timeout' })
  })
})
