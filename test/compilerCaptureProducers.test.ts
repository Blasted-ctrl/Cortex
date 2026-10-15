import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { resolve, join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { RunDiagnostics, RunRequest } from '../src/shared/ipc'
import { IPC } from '../src/shared/ipc'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), mkdir: vi.fn(), access: vi.fn(), readFile: vi.fn(async () => '') }))
vi.mock('child_process', () => ({ spawn: mocks.spawn, execFile: vi.fn() }))
vi.mock('fs', async importOriginal => {
  const original = await importOriginal<typeof import('fs')>()
  return { ...original, promises: { ...original.promises, mkdir: mocks.mkdir, access: mocks.access, readFile: mocks.readFile } }
})
vi.mock('fs/promises', () => ({ mkdir: mocks.mkdir }))
vi.mock('../src/main/services/fsService', () => ({ getWorkspaceRoot: () => null, withinWorkspace: () => true }))
vi.mock('../src/main/services/commandResolver', () => ({ safeCommand: (command: string) => command, commandMissing: () => false, needsShell: () => false }))
vi.mock('../src/main/services/arduinoCliService', () => ({
  getArduinoCli: async () => ({ command: 'mock-board-tools', args: [], source: 'managed', env: {} })
}))

import * as runner from '../src/main/services/runnerService'
import * as embedded from '../src/main/services/embeddedService'
import * as debug from '../src/main/services/debugService'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  readonly kill = vi.fn(() => true)
  closed = false
  close(code = 1): void {
    if (this.closed) return
    this.closed = true
    this.emit('exit', code)
    this.emit('close', code, null)
  }
}

const cwd = resolve('compiler-capture-owned-fixture')
const send = vi.fn()
const win = { isDestroyed: () => false, webContents: { send, isDestroyed: () => false } } as unknown as BrowserWindow
let children: FakeChild[]
const request = (id: string, language: RunRequest['language'] = 'cpp'): RunRequest => ({
  id, language, cwd, filePath: join(cwd, language === 'rust' ? 'main.rs' : 'main.cpp')
})
const flush = async (): Promise<void> => { for (let turn = 0; turn < 20; turn++) await Promise.resolve() }
const tick = async (): Promise<void> => { await new Promise<void>(done => setImmediate(done)) }
const published = (id: string): RunDiagnostics[] => send.mock.calls
  .filter(([channel, payload]) => channel === IPC.RUN_DIAGNOSTICS && payload.id === id).map(([, payload]) => payload)
const successes = (id: string) => send.mock.calls.filter(([channel, payload]) =>
  channel === IPC.RUN_EXIT && payload.id === id && payload.phase === 'compile' && payload.code === 0)
const textError = 'late.cpp:7:3: error: CORTEX_LATE_DIAGNOSTIC'
const lateDiagnostic = { file: join(cwd, 'late.cpp'), line: 7, column: 3, severity: 'error', message: 'CORTEX_LATE_DIAGNOSTIC' }
const rustError = '{"message":"CORTEX_RUST_ERROR","level":"error","code":{"code":"E0425"},"spans":[{"file_name":"late.rs","line_start":7,"column_start":3,"is_primary":true}],"rendered":"error[E0425]: CORTEX_RUST_ERROR\\n"}'
const cargoError = '{"reason":"compiler-message","message":{"message":"CORTEX_CARGO_ERROR","level":"error","code":{"code":"E0425"},"spans":[{"file_name":"src/main.rs","line_start":7,"column_start":3,"is_primary":true}],"rendered":"error[E0425]: CORTEX_CARGO_ERROR\\n"}}'
const cargoDiagnostic = { file: join(cwd, 'src/main.rs'), line: 7, column: 3, severity: 'error', message: 'CORTEX_CARGO_ERROR', code: 'E0425' }

beforeEach(() => {
  debug.stop()
  vi.clearAllMocks()
  children = []
  mocks.mkdir.mockResolvedValue(undefined)
  mocks.access.mockRejectedValue(new Error('No Cargo manifest'))
  mocks.spawn.mockImplementation((command: string) => {
    const child = new FakeChild()
    if (command === 'gdb') child.stdin.on('data', chunk => {
      const token = /^\d+/.exec(chunk.toString())?.[0]
      if (token) queueMicrotask(() => child.stdout.write(`${token}^done\n`))
    })
    children.push(child)
    return child
  })
  send.mockImplementation((_channel, payload) => {
    if (payload.deliveryToken) runner.acknowledgeOutput(win, payload.deliveryToken)
  })
})

afterEach(async () => {
  debug.stop()
  runner.killAll()
  for (const child of children) { child.close(); child.stdout.end(); child.stderr.end(); child.stdin.end() }
  runner.disposeWindowRuns(win)
  await tick()
})

describe('actual compilation producers use bounded capture and the real publisher', () => {
  it.each(['cpp', 'rust'] as const)('keeps a late %s error after an oversized record and preserves failure exit', async language => {
    const id = 'large-' + language
    const starting = runner.startRun(win, request(id, language))
    await flush()
    expect(children).toHaveLength(1)
    const omitted = 'x'.repeat(2 * 1024 * 1024)
    children[0].stderr.write(omitted + '\n' + (language === 'rust' ? rustError : textError))
    children[0].close(1)
    await starting

    expect(published(id)).toEqual([{
      id,
      diagnostics: [language === 'rust'
        ? { file: join(cwd, 'late.rs'), line: 7, column: 3, severity: 'error', message: 'CORTEX_RUST_ERROR', code: 'E0425' }
        : lateDiagnostic],
      capture: { omittedDiagnostics: 0, unparsedBytes: 2 * 1024 * 1024 }
    }])
    expect(successes(id)).toEqual([])
    expect(children).toHaveLength(1)
    expect(send).toHaveBeenCalledWith(IPC.RUN_EXIT, expect.objectContaining({ id, code: 1, phase: 'compile' }))
  })

  it('keeps successful warnings without introducing capture metadata or preventing executable handoff', async () => {
    const starting = runner.startRun(win, request('warning'))
    await flush()
    children[0].stderr.write('late.cpp:2:5: warning: unused capture [-Wunused-variable]\n')
    children[0].close(0)
    await starting

    expect(published('warning')).toEqual([{ id: 'warning', diagnostics: [{
      file: join(cwd, 'late.cpp'), line: 2, column: 5, severity: 'warning', message: 'unused capture', code: '-Wunused-variable'
    }] }])
    expect(children).toHaveLength(2)
    expect(successes('warning')).toHaveLength(1)
    children[1].close(0)
  })

  it('retains decoded Unicode when pipe reads split the original UTF-8 bytes', async () => {
    const starting = runner.startRun(win, request('unicode'))
    await flush()
    const bytes = Buffer.from('late.cpp:7:3: error: caf\u00e9 \ud83d\ude00\r\n')
    const split = bytes.indexOf(0xf0) + 2
    children[0].stderr.write(bytes.subarray(0, split))
    children[0].stderr.write(bytes.subarray(split))
    children[0].close(1)
    await starting

    expect(published('unicode')).toEqual([{ id: 'unicode', diagnostics: [{ ...lateDiagnostic, message: 'caf\u00e9 \ud83d\ude00' }] }])
  })

  it('counts the 501st diagnostic without dropping the actual compile failure', async () => {
    const starting = runner.startRun(win, request('count'))
    await flush()
    children[0].stderr.write((textError + '\n').repeat(501))
    children[0].close(1)
    await starting

    expect(published('count')).toEqual([{ id: 'count', diagnostics: Array.from({ length: 500 }, () => lateDiagnostic),
      capture: { omittedDiagnostics: 1, unparsedBytes: 0 } }])
  })

  it.each(['compile', 'upload'] as const)('uses the real collector/publisher for board %s without flashing hardware', async operation => {
    const id = 'board-' + operation
    await embedded[operation](win, { id, fqbn: 'arduino:avr:uno', sketchPath: join(cwd, 'sketch.ino'), port: 'MOCK-NOT-HARDWARE' })
    expect(children).toHaveLength(1)
    children[0].stderr.write('x'.repeat(2 * 1024 * 1024) + '\n' + textError)
    children[0].close(1)

    expect(published(id)).toEqual([{ id, diagnostics: [lateDiagnostic], capture: { omittedDiagnostics: 0, unparsedBytes: 2 * 1024 * 1024 } }])
    expect(send).toHaveBeenCalledWith(IPC.RUN_EXIT, expect.objectContaining({ id, code: 1, phase: 'compile' }))
  })

  it.each(['compile', 'upload'] as const)('preserves board %s warnings and publishes a later complete empty result', async operation => {
    const id = 'board-warning-' + operation
    const board = { id, fqbn: 'arduino:avr:uno', sketchPath: join(cwd, 'sketch.ino'), port: 'MOCK-NOT-HARDWARE' }
    await embedded[operation](win, board)
    children[0].stderr.write('late.cpp:2:5: warning: unused capture [-Wunused-variable]\n')
    children[0].close(0)
    expect(published(id)).toEqual([{ id, diagnostics: [{
      file: join(cwd, 'late.cpp'), line: 2, column: 5, severity: 'warning', message: 'unused capture', code: '-Wunused-variable'
    }] }])
    expect(send).toHaveBeenCalledWith(IPC.RUN_EXIT, expect.objectContaining({ id, code: 0, phase: 'compile' }))
    await embedded[operation](win, board)
    children[1].close(0)
    expect(published(id).at(-1)).toEqual({ id, diagnostics: [] })
  })

  it.each([true, false])('publishes successful Debug compilation with warnings %s before real MI initialization', async warning => {
    const id = 'debug-warning-' + warning
    const starting = debug.start(win, { runId: id, cwd, filePath: join(cwd, 'main.cpp'), breakpoints: [] })
    await flush()
    if (warning) children[0].stderr.write('late.cpp:2:5: warning: unused capture [-Wunused-variable]\n')
    children[0].close(0)
    await starting

    expect(published(id)).toEqual([{ id, diagnostics: warning ? [{
      file: join(cwd, 'late.cpp'), line: 2, column: 5, severity: 'warning', message: 'unused capture', code: '-Wunused-variable'
    }] : [] }])
    expect(children).toHaveLength(2)
    expect(mocks.spawn.mock.calls[1][0]).toBe('gdb')
    debug.stop()
    expect(children[1].kill).toHaveBeenCalledOnce()
  })

  it('publishes bounded Debug diagnostics using the actual runner emitter', async () => {
    const starting = debug.start(win, { runId: 'debug-capture', cwd, filePath: join(cwd, 'main.cpp'), breakpoints: [] })
    await flush()
    expect(children).toHaveLength(1)
    children[0].stderr.write('x'.repeat(2 * 1024 * 1024) + '\n' + textError)
    children[0].close(1)
    await starting

    expect(published('debug-capture')).toEqual([{ id: 'debug-capture', diagnostics: [lateDiagnostic], capture: { omittedDiagnostics: 0, unparsedBytes: 2 * 1024 * 1024 } }])
    expect(children).toHaveLength(1)
  })

  it('does not publish a superseded Debug compile over its replacement', async () => {
    const old = debug.start(win, { runId: 'debug-old', cwd, filePath: join(cwd, 'main.cpp'), breakpoints: [] })
    await flush()
    const current = debug.start(win, { runId: 'debug-current', cwd, filePath: join(cwd, 'main.cpp'), breakpoints: [] })
    await flush()
    children[0].stderr.write(textError)
    children[0].close(1)
    await old
    children[1].stderr.write('new.cpp:9:2: error: current build')
    children[1].close(1)
    await current

    expect(published('debug-old')).toEqual([])
    expect(published('debug-current')).toEqual([{ id: 'debug-current', diagnostics: [{
      file: join(cwd, 'new.cpp'), line: 9, column: 2, severity: 'error', message: 'current build'
    }] }])
  })
})

describe('actual Cargo output boundaries', () => {
  beforeEach(() => { mocks.access.mockResolvedValue(undefined) })

  it('does not infer compile success from an oversized machine record', async () => {
    await runner.startRun(win, request('cargo-overflow', 'rust'))
    const oversized = '{"reason":"compiler-message","message":{"message":"discarded","level":"error","spans":[{"file_name":"fake.rs","line_start":99}],"rendered":"' + 'x'.repeat(2 * 1024 * 1024) + '"}}'
    children[0].stdout.write(oversized + '\n' + cargoError + '\n')
    await tick()

    expect(successes('cargo-overflow')).toEqual([])
    expect(published('cargo-overflow').at(-1)).toEqual({ id: 'cargo-overflow', diagnostics: [cargoDiagnostic],
      capture: { omittedDiagnostics: 0, unparsedBytes: Buffer.byteLength(oversized) } })
    children[0].stdout.write('{"reason":"build-finished","success":true}\nEnter name: ')
    expect(successes('cargo-overflow')).toHaveLength(1)
    expect(send).toHaveBeenCalledWith(IPC.RUN_OUTPUT, expect.objectContaining({ stream: 'stdout', data: 'Enter name: ' }))
    children[0].close(0)
  })

  it('flushes a failed terminal and treats later compiler-shaped data as program output', async () => {
    await runner.startRun(win, request('cargo-failed', 'rust'))
    const program = '{"reason":"compiler-message","message":{"message":"program telemetry","level":"error","spans":[{"file_name":"fake.rs","line_start":99}]}}'
    children[0].stdout.write(cargoError + '\n{"reason":"build-finished","success":false}\n' + program + '\nEnter name: ')
    await tick()

    expect(successes('cargo-failed')).toEqual([])
    expect(published('cargo-failed').at(-1)).toEqual({ id: 'cargo-failed', diagnostics: [cargoDiagnostic] })
    const output = send.mock.calls.filter(([channel, value]) => channel === IPC.RUN_OUTPUT && value.stream === 'stdout').map(([, value]) => value.data).join('')
    expect(output).toContain(program + '\nEnter name: ')
    children[0].close(101)
    expect(send).toHaveBeenCalledWith(IPC.RUN_EXIT, expect.objectContaining({ id: 'cargo-failed', code: 101, phase: 'run' }))
  })

  it('does not certify a slow potential machine prefix as a successful compile', async () => {
    await runner.startRun(win, request('cargo-slow', 'rust'))
    vi.useFakeTimers()
    try {
      children[0].stdout.write('{"reason":')
      await vi.advanceTimersByTimeAsync(251)
      expect(successes('cargo-slow')).toEqual([])
      children[0].stdout.write('"compiler-message"}\n' + cargoError + '\n{"reason":"build-finished","success":false}\n')
      await vi.runAllTimersAsync()
      expect(successes('cargo-slow')).toEqual([])
      expect(published('cargo-slow').at(-1)).toEqual({ id: 'cargo-slow', diagnostics: [cargoDiagnostic],
        capture: { omittedDiagnostics: 0, unparsedBytes: 29 } })
      children[0].close(101)
    } finally { vi.useRealTimers() }
  })

  it.each([true, false])('forwards a timed-out prompt suffix until its newline before terminal success %s', async success => {
    const id = 'cargo-timed-prompt-' + success
    await runner.startRun(win, request(id, 'rust'))
    vi.useFakeTimers()
    try {
      children[0].stdout.write('{Enter ')
      await vi.advanceTimersByTimeAsync(251)
      children[0].stdout.write('your name: ')
      children[0].stdout.write(cargoError)
      expect(successes(id)).toEqual([])
      const output = send.mock.calls.filter(([channel, value]) => channel === IPC.RUN_OUTPUT && value.stream === 'stdout')
        .map(([, value]) => value.data).join('')
      expect(output).toBe('{Enter your name: ' + cargoError)
      children[0].stdout.write('\n' + cargoError + '\n{"reason":"build-finished","success":' + success + '}\n')
      await vi.runAllTimersAsync()
      expect(published(id).at(-1)).toEqual({ id, diagnostics: [cargoDiagnostic],
        capture: { omittedDiagnostics: 0, unparsedBytes: Buffer.byteLength('{Enter your name: ' + cargoError) } })
      expect(successes(id)).toHaveLength(success ? 1 : 0)
      children[0].close(success ? 0 : 101)
    } finally { vi.useRealTimers() }
  })

  it.each([
    ['Enter name: ', true], ['Enter name: ', false],
    ['procedural macro output\n', true], ['procedural macro output\n', false]
  ] as const)('forwards %j without declaring success before terminal outcome %s', async (programText, success) => {
    const id = 'cargo-ordinary-' + success
    await runner.startRun(win, request(id, 'rust'))
    children[0].stdout.write(programText)
    expect(successes(id)).toEqual([])
    expect(send).toHaveBeenCalledWith(IPC.RUN_OUTPUT, expect.objectContaining({ stream: 'stdout', data: programText }))
    children[0].stdout.write((programText.endsWith('\n') ? '' : '\n') + '{"reason":"build-finished","success":' + success + '}\n')
    expect(successes(id)).toHaveLength(success ? 1 : 0)
    children[0].close(success ? 0 : 101)
  })

  it('does not classify a compiler-shaped suffix of an already displayed program line', async () => {
    await runner.startRun(win, request('cargo-prompt-suffix', 'rust'))
    children[0].stdout.write('Enter name: ')
    children[0].stdout.write(cargoError + '\n{"reason":"build-finished","success":true}\n')
    await tick()

    expect(successes('cargo-prompt-suffix')).toHaveLength(1)
    expect(published('cargo-prompt-suffix').at(-1)).toEqual({ id: 'cargo-prompt-suffix', diagnostics: [] })
    const output = send.mock.calls.filter(([channel, value]) => channel === IPC.RUN_OUTPUT && value.stream === 'stdout').map(([, value]) => value.data).join('')
    expect(output).toContain('Enter name: ' + cargoError + '\n')
    children[0].close(0)
  })

  it.each([true, false])('flushes a final unterminated Cargo terminal with success %s', async success => {
    const id = 'cargo-final-' + success
    await runner.startRun(win, request(id, 'rust'))
    children[0].stdout.write(cargoError + '\n{"reason":"build-finished","success":' + success + '}')
    children[0].close(success ? 0 : 101)
    await tick()

    expect(published(id)).toEqual([{ id, diagnostics: [cargoDiagnostic] }])
    expect(successes(id)).toHaveLength(success ? 1 : 0)
  })

  it('flushes final residue once at close and cannot publish an older queued flush after replacement', async () => {
    await runner.startRun(win, request('cargo-retired', 'rust'))
    children[0].stdout.write(cargoError + '\n')
    runner.stopRun('cargo-retired')
    children[0].close(101)
    const oldCount = published('cargo-retired').length
    await runner.startRun(win, request('cargo-retired', 'rust'))
    children[1].stdout.write('{"reason":"build-finished","success":true}\n')
    await tick()

    expect(published('cargo-retired').slice(oldCount)).toEqual([{ id: 'cargo-retired', diagnostics: [] }])
    children[1].close(0)
  })

  it('ignores a retired child queue and close after an ID has a new owner', async () => {
    const id = 'cargo-owner-replaced'
    await runner.startRun(win, request(id, 'rust'))
    children[0].stdout.write(cargoError + '\n')
    runner.killAll()
    await runner.startRun(win, request(id, 'rust'))
    children[1].stdout.write('{"reason":"build-finished","success":true}\n')
    await tick()
    expect(published(id)).toEqual([{ id, diagnostics: [] }])
    const beforeClose = send.mock.calls.filter(([channel]) => channel === IPC.RUN_EXIT).length
    children[0].close(101)
    await tick()

    expect(published(id)).toEqual([{ id, diagnostics: [] }])
    expect(send.mock.calls.filter(([channel]) => channel === IPC.RUN_EXIT)).toHaveLength(beforeClose)
    children[1].close(0)
  })
})
