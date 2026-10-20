import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { safeCommand } from '../../services/commandResolver'
import { runProcess, type ProcessResult } from '../process'

export const HIL_BAUD = 115200

export interface PortInfo { path: string; vendorId?: string; productId?: string; manufacturer?: string; pnpId?: string }

/** USB vendor IDs of boards and USB-serial bridges a bench is likely to use. */
const KNOWN_VENDORS: Record<string, string> = {
  '16c0': 'Teensy (PJRC)', '303a': 'Espressif', '10c4': 'Silicon Labs CP210x', '1a86': 'WCH CH340',
  '0403': 'FTDI', '0483': 'STMicroelectronics', '2341': 'Arduino', '2a03': 'Arduino', '2e8a': 'Raspberry Pi'
}

export function describePort(port: PortInfo): string {
  const vendor = port.vendorId ? KNOWN_VENDORS[port.vendorId.toLowerCase()] : undefined
  return `${port.path}${vendor ? ` (${vendor})` : port.manufacturer ? ` (${port.manufacturer})` : ''}`
}

/**
 * The port to flash and test. An explicit choice always wins; otherwise exactly one
 * port from a known board vendor must be present. Guessing between two boards could
 * flash the wrong one, so that is refused.
 */
export function choosePort(ports: PortInfo[], explicit?: string): string {
  if (explicit) {
    if (!ports.some((p) => p.path.toLowerCase() === explicit.toLowerCase())) {
      throw new Error(`Port ${explicit} is not connected. Present: ${ports.map(describePort).join(', ') || 'none'}`)
    }
    return explicit
  }
  const boards = ports.filter((p) => p.vendorId && KNOWN_VENDORS[p.vendorId.toLowerCase()] && !/^BTHENUM/i.test(p.pnpId ?? ''))
  if (boards.length === 1) return boards[0].path
  if (boards.length === 0) throw new Error(`No board found. Connect one or set CORTEX_HIL_PORT. Present: ${ports.map(describePort).join(', ') || 'none'}`)
  throw new Error(`Several boards found; set CORTEX_HIL_PORT to one of: ${boards.map(describePort).join(', ')}`)
}

export async function listPorts(): Promise<PortInfo[]> {
  const { SerialPort } = await import('serialport')
  return (await SerialPort.list()).map((p) => ({ path: p.path, vendorId: p.vendorId, productId: p.productId, manufacturer: p.manufacturer, pnpId: p.pnpId }))
}

/** --arduino-cli, then ARDUINO_CLI, then PATH, then the copy Cortex manages for its own board tools. */
export function resolveArduinoCli(explicit?: string): string {
  const named = explicit || process.env['ARDUINO_CLI']
  if (named) {
    if (!existsSync(named)) throw new Error(`arduino-cli not found at ${named}`)
    return named
  }
  const onPath = safeCommand(process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli')
  if (onPath) return onPath
  const base = process.platform === 'win32' ? join(process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming'), 'Cortex')
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'Cortex') : join(process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config'), 'Cortex')
  const root = join(base, 'board-tools', 'cli')
  const binary = process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli'
  if (existsSync(root)) {
    for (const version of readdirSync(root).sort().reverse()) {
      const candidate = join(root, version, `${process.platform}-${process.arch}`, binary)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('arduino-cli was not found. Put it on PATH or set ARDUINO_CLI (see docs/HIL.md).')
}

const failed = (result: ProcessResult): boolean => !!result.error || result.code !== 0

/** Compiles and flashes with arduino-cli: argument arrays, no shell. */
export async function compileAndUpload(cli: string, fqbn: string, sketchDir: string, buildDir: string, port: string | null): Promise<{ log: string; args: string[]; version: string }> {
  const version = await runProcess(cli, ['version'], { cwd: sketchDir, timeoutMs: 15_000 })
  const args = ['compile', '--fqbn', fqbn, '--build-path', buildDir, sketchDir]
  const compiled = await runProcess(cli, args, { cwd: sketchDir, timeoutMs: 600_000 })
  let log = compiled.stdout + compiled.stderr
  if (failed(compiled)) throw new Error(`Compiling for ${fqbn} failed${compiled.error ? `: ${compiled.error}` : ''}\n${log}`)
  if (port) {
    const uploaded = await runProcess(cli, ['upload', '--fqbn', fqbn, '--port', port, '--input-dir', buildDir, sketchDir], { cwd: sketchDir, timeoutMs: 180_000 })
    log += uploaded.stdout + uploaded.stderr
    if (failed(uploaded)) throw new Error(`Uploading to ${port} failed${uploaded.error ? `: ${uploaded.error}` : ''}\n${uploaded.stdout}${uploaded.stderr}`)
  }
  return { log, args, version: version.stdout.trim() || 'unknown' }
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

interface Port {
  isOpen: boolean
  write(data: string, callback?: (error?: Error | null) => void): boolean
  drain(callback: (error?: Error | null) => void): void
  close(callback?: (error?: Error | null) => void): void
  on(event: 'close' | 'error', listener: (error?: Error) => void): void
  pipe<T>(destination: T): T
}

/**
 * A line-oriented connection to the board that survives the USB re-enumeration a reset
 * causes on native-USB boards such as the Teensy.
 */
export class BoardLink {
  private port: Port | null = null
  private queue: string[] = []
  private wake: (() => void) | null = null
  private readonly output: string[] = []

  constructor(readonly path: string, private readonly baud = HIL_BAUD) {}

  /** Everything received so far, for the report's log. */
  takeOutput(): string { return this.output.splice(0).join('\n') }

  async open(timeoutMs = 20_000): Promise<void> {
    const { SerialPort, ReadlineParser } = await import('serialport')
    const deadline = Date.now() + timeoutMs
    let lastError = ''
    while (Date.now() < deadline) {
      const port = new SerialPort({ path: this.path, baudRate: this.baud, autoOpen: false }) as unknown as Port & { open(cb: (e: Error | null) => void): void }
      const error = await new Promise<Error | null>((done) => port.open(done))
      if (!error) {
        this.port = port
        const parser = port.pipe(new ReadlineParser({ delimiter: '\n' })) as unknown as { on(event: 'data', listener: (line: string) => void): void }
        parser.on('data', (line) => this.receive(line.replace(/\r$/, '')))
        port.on('close', () => { if (this.port === port) this.port = null })
        port.on('error', () => {})
        return
      }
      lastError = error.message
      await sleep(250)
    }
    throw new Error(`Could not open ${this.path}: ${lastError}`)
  }

  private receive(line: string): void {
    this.output.push(line)
    this.queue.push(line)
    this.wake?.()
  }

  /** The next line, or null once the timeout passes. */
  async next(timeoutMs: number): Promise<string | null> {
    if (this.queue.length) return this.queue.shift()!
    await new Promise<void>((done) => {
      const timer = setTimeout(() => { this.wake = null; done() }, timeoutMs)
      this.wake = () => { clearTimeout(timer); this.wake = null; done() }
    })
    return this.queue.length ? this.queue.shift()! : null
  }

  /** Reads until a line matches or the deadline passes; non-matching lines are dropped. */
  async waitFor(match: (line: string) => boolean, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return null
      const line = await this.next(remaining)
      if (line === null) return null
      if (match(line)) return line
    }
  }

  async send(line: string): Promise<void> {
    const port = this.port ?? (() => { throw new Error(`${this.path} is not open`) })()
    await new Promise<void>((done, fail) => port.write(`${line}\n`, (error) => (error ? fail(error) : done())))
    await new Promise<void>((done, fail) => port.drain((error) => (error ? fail(error) : done())))
  }

  async close(): Promise<void> {
    const port = this.port
    this.port = null
    if (port?.isOpen) await new Promise<void>((done) => port.close(() => done()))
  }

  /** Asks the board to restart, then reconnects; native-USB ports disappear briefly. */
  async reset(): Promise<void> {
    await this.send('@hil reset').catch(() => {})
    await sleep(300)
    await this.close()
    this.queue = []
    await sleep(1200)
    await this.open(20_000)
  }
}
