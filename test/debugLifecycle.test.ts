import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BrowserWindow } from 'electron'
import type { DebugStartRequest } from '../src/shared/ipc'
import { IPC } from '../src/shared/ipc'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), mkdir: vi.fn(), diagnostics: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mocks.spawn, execFile: vi.fn() }))
vi.mock('fs/promises', () => ({ mkdir: mocks.mkdir }))
vi.mock('../src/main/services/fsService', () => ({ withinWorkspace: () => true, getWorkspaceRoot: () => null }))
vi.mock('../src/main/services/commandResolver', () => ({ safeCommand: (command: string) => command, needsShell: () => false }))
vi.mock('../src/main/services/runnerService', () => ({ emitCapturedDiagnostics: mocks.diagnostics }))
import * as debug from '../src/main/services/debugService'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly kill = vi.fn(() => true)
  readonly writes: string[] = []
  autoReply = true
  readonly stdin = Object.assign(new EventEmitter(), { write: (text: string): boolean => {
    this.writes.push(text)
    if (this.autoReply && /^\d+/.test(text)) queueMicrotask(() => this.reply(text))
    return true
  } })

  reply(command = this.writes.at(-1)!, result = 'done'): void {
    const token = /^\d+/.exec(command)?.[0]
    if (token) this.stdout.write(`${token}^${result}\n`)
  }
}

const cwd = join(tmpdir(), 'cortex-owned-mocked-debug')
const request = (id = 'debug'): DebugStartRequest => ({ runId: id, cwd, filePath: join(cwd, 'main.cpp'), std: 'c++20', extraArgs: ['-Wall'], breakpoints: [] })
const send = vi.fn()
const destroyed = vi.fn(() => false)
const win = { isDestroyed: destroyed, webContents: { send } } as unknown as BrowserWindow
let children: FakeChild[]
let gdbAutoReply: boolean
const flush = async (): Promise<void> => { for (let turn = 0; turn < 20; turn++) await Promise.resolve() }

async function launch(id?: string): Promise<FakeChild> {
  const starting = debug.start(win, request(id))
  await flush()
  children.at(-1)!.emit('close', 0)
  await starting
  return children.at(-1)!
}

beforeEach(() => {
  debug.stop()
  vi.clearAllMocks()
  destroyed.mockReturnValue(false)
  mocks.mkdir.mockResolvedValue(undefined)
  children = []
  gdbAutoReply = true
  mocks.spawn.mockImplementation((command: string) => {
    const child = new FakeChild()
    child.autoReply = command === 'gdb' && gdbAutoReply
    children.push(child)
    return child
  })
})
afterEach(async () => {
  debug.stop()
  for (const child of children) { child.emit('exit', null); child.emit('close', null); child.stdout.end(); child.stderr.end() }
  await flush()
})

describe('actual debugger child lifecycle', () => {
  it('does not overwrite renderer idle when the stopped gdb exits later', async () => {
    const gdb = await launch()
    debug.stop()
    send.mockClear()
    gdb.emit('exit', 0)
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect(gdb.kill).toHaveBeenCalledOnce()
  })

  it('ignores old gdb data and errors without muting the new session', async () => {
    const old = await launch('old')
    old.emit('exit', 0)
    const current = await launch('new')
    send.mockClear()
    old.stdout.write('@"old target\\n"\n*running,thread-id="all"\n')
    old.stderr.write('old stderr')
    old.emit('error', new Error('old child error'))
    old.emit('exit', 1)
    await flush()
    expect(send).not.toHaveBeenCalled()
    current.stdout.write('@"current target\\n"\n')
    current.stderr.write('current stderr')
    expect(send).toHaveBeenCalledWith(IPC.DEBUG_OUTPUT, { stream: 'program', text: 'current target\n' })
    expect(send).toHaveBeenCalledWith(IPC.DEBUG_OUTPUT, { stream: 'gdb', text: 'current stderr' })
    await expect(debug.evaluate('counter')).resolves.toBe('')
  })

  it('drains final output until close without reviving commands or state after natural exit', async () => {
    const gdb = await launch()
    gdb.autoReply = false
    const pending = debug.evaluate('counter')
    gdb.emit('exit', 0)
    await expect(pending).resolves.toBe('<gdb exited>')
    const written = [...gdb.writes]
    send.mockClear()
    gdb.stdout.write('@"final target\\n"\nfinal plain output\n*running,thread-id="all"\n*stopped,reason="breakpoint-hit"\n')
    gdb.stderr.write('final stderr')
    debug.cont()
    debug.selectFrame(0)
    await flush()
    expect(send).toHaveBeenCalledWith(IPC.DEBUG_OUTPUT, { stream: 'program', text: 'final target\n' })
    expect(send).toHaveBeenCalledWith(IPC.DEBUG_OUTPUT, { stream: 'program', text: 'final plain output\n' })
    expect(send).toHaveBeenCalledWith(IPC.DEBUG_OUTPUT, { stream: 'gdb', text: 'final stderr' })
    expect(send.mock.calls.some(([channel]) => channel === IPC.DEBUG_STATE)).toBe(false)
    expect(gdb.writes).toEqual(written)
    await expect(debug.evaluate('counter')).resolves.toContain('debug session ended')
    gdb.emit('close', 0)
    send.mockClear()
    gdb.stdout.write('@"after-close output\\n"\n')
    gdb.stderr.write('after-close stderr')
    await flush()
    expect(send).not.toHaveBeenCalled()
  })

  it.each(['stop', 'exit', 'error', 'window-exit'] as const)('settles initialization when %s interrupts an MI command', async event => {
    gdbAutoReply = false
    let settled = false
    const starting = debug.start(win, request()).then(() => { settled = true })
    await flush()
    children[0].emit('close', 0)
    await flush()
    const gdb = children[1]
    expect(gdb.writes).toHaveLength(1)
    send.mockClear()
    if (event === 'stop') debug.stop()
    else if (event === 'exit' || event === 'window-exit') {
      if (event === 'window-exit') destroyed.mockReturnValue(true)
      gdb.emit('exit', 0)
    }
    else gdb.emit('error', new Error('active gdb error'))
    await flush()
    expect(settled).toBe(true)
    expect(send.mock.calls.some(([channel, state]) => channel === IPC.DEBUG_STATE && state.status === 'running')).toBe(false)
    if (event === 'stop' || event === 'window-exit') expect(send).not.toHaveBeenCalled()
    else expect(send).toHaveBeenCalledWith(IPC.DEBUG_STATE, expect.objectContaining({ status: 'exited', ...(event === 'error' ? { error: 'Error: active gdb error' } : {}) }))
    await starting
  })

  it('settles pending and subsequent evaluations when the active child exits', async () => {
    const gdb = await launch()
    gdb.autoReply = false
    const pending = debug.evaluate('counter')
    gdb.emit('exit', 0)
    await expect(pending).resolves.toBe('<gdb exited>')
    let settled = false
    let result: string | undefined
    const afterExit = debug.evaluate('counter').then(value => { settled = true; result = value })
    await flush()
    expect(settled).toBe(true)
    expect(result).toContain('debug session ended')
    await afterExit
    expect(send).toHaveBeenCalledWith(IPC.DEBUG_STATE, expect.objectContaining({ status: 'exited' }))
  })

  it('does not publish a completed stopped-frame refresh after Stop', async () => {
    const gdb = await launch()
    gdb.autoReply = false
    gdb.stdout.write('*stopped,reason="breakpoint-hit"\n')
    gdb.reply(undefined, 'done,stack=[frame={level="0",func="main",file="main.cpp",line="5"}]')
    await flush()
    expect(gdb.writes.at(-1)).toContain('-stack-list-variables')
    gdb.reply(undefined, 'done,variables=[{name="counter",value="42"}]')
    debug.stop()
    const written = [...gdb.writes]
    send.mockClear()
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect(gdb.writes).toEqual(written)
  })

  it('does not publish a completed frame selection after Stop', async () => {
    const gdb = await launch()
    gdb.autoReply = false
    debug.selectFrame(0)
    gdb.reply()
    await flush()
    gdb.reply(undefined, 'done,variables=[{name="counter",value="42"}]')
    await flush()
    expect(gdb.writes.at(-1)).toContain('-stack-list-frames')
    gdb.reply(undefined, 'done,stack=[frame={level="0",func="main",file="main.cpp",line="5"}]')
    debug.stop()
    const written = [...gdb.writes]
    send.mockClear()
    await flush()
    expect(send).not.toHaveBeenCalled()
    expect(gdb.writes).toEqual(written)
  })

  it('ignores a cancelled compile close without losing the newer compile Stop handle', async () => {
    const oldStarting = debug.start(win, request('old'))
    await flush()
    const old = children[0]
    const newStarting = debug.start(win, request('new'))
    await flush()
    const current = children[1]
    expect(old.kill).toHaveBeenCalledOnce()
    send.mockClear()
    old.stderr.write('old diagnostics')
    old.emit('error', new Error('old compile error'))
    old.emit('close', 1)
    await oldStarting
    expect(send).not.toHaveBeenCalled()
    debug.stop()
    current.emit('close', 0)
    await newStarting
    expect(current.kill).toHaveBeenCalledOnce()
    expect(children).toHaveLength(2)
  })

  it('retains the exact newer compiler handle after an old close callback', async () => {
    const oldStarting = debug.start(win, request('old'))
    await flush()
    const newStarting = debug.start(win, request('new'))
    await flush()
    children[0].emit('close', 0)
    await oldStarting
    debug.stop()
    children[1].emit('close', 0)
    await newStarting
    expect(children[1].kill).toHaveBeenCalledOnce()
    expect(children).toHaveLength(2)
  })

  it('does not spawn a compiler after Stop during directory preparation', async () => {
    let prepared!: () => void
    mocks.mkdir.mockReturnValueOnce(new Promise<void>(resolve => { prepared = resolve }))
    const starting = debug.start(win, request())
    debug.stop()
    prepared()
    await flush()
    // Any unexpected RED compiler is explicitly closed; this fixture never hangs.
    for (const child of children) child.emit('close', 1)
    await starting
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('preserves active compiler diagnostics, arguments and failed-build state', async () => {
    const starting = debug.start(win, request())
    await flush()
    children[0].stderr.write('main.cpp:4: error: expected expression\n')
    children[0].emit('close', 1)
    await starting
    expect(mocks.spawn.mock.calls[0][1]).toEqual(expect.arrayContaining(['-g', '-O0', '-std=c++20', '-Wall', request().filePath]))
    expect(mocks.diagnostics).toHaveBeenCalledWith(win, 'debug', {
      diagnostics: [{ file: join(cwd, 'main.cpp'), line: 4, column: 1, severity: 'error', message: 'expected expression', code: undefined }]
    })
    expect(send).toHaveBeenCalledWith(IPC.DEBUG_STATE, expect.objectContaining({ status: 'exited', error: 'Build failed. Fix the errors and try again.' }))
  })

  it('preserves active inferior output and natural exit status', async () => {
    const gdb = await launch()
    gdb.stdout.write('@"42\\n"\n*stopped,reason="exited-normally",exit-code="052"\n')
    await flush()
    expect(send).toHaveBeenCalledWith(IPC.DEBUG_OUTPUT, { stream: 'program', text: '42\n' })
    expect(send).toHaveBeenCalledWith(IPC.DEBUG_STATE, expect.objectContaining({ status: 'exited', reason: 'exited-normally', exitCode: 42 }))
  })
})
