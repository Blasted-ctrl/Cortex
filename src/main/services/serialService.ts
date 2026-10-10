import type { BrowserWindow } from 'electron'
import { StringDecoder } from 'node:string_decoder'
import type { SerialPortDescriptor, SerialOpenOptions } from '../../shared/ipc'
import { IPC } from '../../shared/ipc'

// serialport is a native optional dependency. Load it lazily so a failed
// native build never prevents the IDE from starting.
type SerialPortModule = typeof import('serialport')
let mod: SerialPortModule | null | undefined

async function load(): Promise<SerialPortModule | null> {
  if (mod !== undefined) return mod
  try {
    mod = (await import('serialport')) as SerialPortModule
  } catch {
    mod = null
  }
  return mod
}

export async function isAvailable(): Promise<boolean> {
  return (await load()) !== null
}

export async function listPorts(): Promise<SerialPortDescriptor[]> {
  const m = await load()
  if (!m) return []
  const ports = await m.SerialPort.list()
  return ports.map((p) => ({
    path: p.path,
    manufacturer: p.manufacturer,
    serialNumber: p.serialNumber,
    vendorId: p.vendorId,
    productId: p.productId,
    friendlyName: (p as { friendlyName?: string }).friendlyName
  }))
}

let port: import('serialport').SerialPort | null = null
let operationSeq = 0
let activePortSeq = 0
const closingPorts = new WeakMap<import('serialport').SerialPort, Promise<void>>()

/** Share a close of the same instance, retaining ownership if its driver fails. */
function closeInstance(candidate: import('serialport').SerialPort): Promise<void> {
  const pending = closingPorts.get(candidate)
  if (pending) return pending
  if (!candidate.isOpen) return Promise.resolve()
  const task = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Closing serial port timed out. Retry closing it before uploading.')), 10_000)
    timer.unref()
    try {
      candidate.close((error) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      })
    } catch (error) {
      clearTimeout(timer)
      reject(error)
    }
  }).finally(() => closingPorts.delete(candidate))
  closingPorts.set(candidate, task)
  return task
}

function status(win: BrowserWindow, open: boolean, path: string, message?: string): void {
  if (!win.isDestroyed()) {
    win.webContents.send(IPC.SERIAL_STATUS, { open, path, message })
  }
}

export async function openPort(win: BrowserWindow, opts: SerialOpenOptions): Promise<boolean> {
  const operation = ++operationSeq
  const m = await load()
  if (operation !== operationSeq) return false
  if (!m) {
    status(win, false, opts.path, 'serialport module unavailable')
    return false
  }
  const previous = port
  if (previous) {
    try {
      await closeInstance(previous)
    } catch (error) {
      if (operation === operationSeq) {
        if (port === previous) activePortSeq = operation
        status(win, false, opts.path, `Could not close previous serial port: ${String(error)}`)
      }
      return false
    }
    if (operation !== operationSeq) return false
    if (port === previous) port = null
  }
  // Disable constructor auto-open: listeners and instance ownership must exist
  // before even a synchronous native callback can arrive.
  const candidate = new m.SerialPort({
    path: opts.path,
    baudRate: opts.baudRate,
    dataBits: opts.dataBits ?? 8,
    stopBits: opts.stopBits ?? 1,
    parity: opts.parity ?? 'none',
    autoOpen: false
  })
  port = candidate
  activePortSeq = operation
  const isCurrent = (): boolean => port === candidate && activePortSeq === operationSeq
  const isRequestCurrent = (): boolean => isCurrent() && operation === operationSeq
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (isRequestCurrent()) {
        port = null
        status(win, false, opts.path, 'Opening serial port timed out. Check the device and retry.')
      }
      settle(false)
    }, 15_000)
    timer.unref()
    const settle = (opened: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(opened)
    }
    const decoder = new StringDecoder('utf8')
    candidate.on('data', (chunk: Buffer | string) => {
      if (!isCurrent() || win.isDestroyed()) return
      const data = typeof chunk === 'string' ? chunk : decoder.write(chunk)
      if (data) win.webContents.send(IPC.SERIAL_DATA, { path: opts.path, data })
    })
    // A clean close is NOT an error. Sending a message here made every normal
    // disconnect (and every upload, which closes the port first) paint a red
    // error box. Real failures still arrive via 'error' and the open callback.
    candidate.on('close', () => {
      if (!isCurrent()) return
      port = null
      status(win, false, opts.path)
      settle(false)
    })
    candidate.on('error', (error: Error) => {
      if (!isCurrent()) return
      status(win, false, opts.path, error.message)
      settle(false)
    })
    try {
      candidate.open((error) => {
        if (!isRequestCurrent()) {
          // Stop or a newer open may have won while this driver was opening.
          // Close this captured instance, never the shared current port.
          if (!error) void closeInstance(candidate).catch((failure) => console.warn('Could not close superseded serial port:', failure))
          settle(false)
          return
        }
        if (error) {
          if (!candidate.isOpen) port = null
          status(win, false, opts.path, error.message)
          settle(false)
        } else {
          status(win, true, opts.path)
          settle(true)
        }
      })
    } catch (error) {
      if (isCurrent()) {
        port = null
        status(win, false, opts.path, String(error))
      }
      settle(false)
    }
  })
}

export async function writePort(data: string): Promise<void> {
  if (port?.isOpen) port.write(data)
}

export async function closePort(): Promise<void> {
  const operation = ++operationSeq
  const candidate = port
  if (!candidate) return
  try {
    await closeInstance(candidate)
  } catch (error) {
    if (operation === operationSeq && port === candidate) activePortSeq = operation
    throw error
  }
  if (port === candidate) port = null
}
