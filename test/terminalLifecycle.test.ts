import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import type { BrowserWindow } from 'electron'
import type { TerminalCreateResult } from '../src/shared/ipc'
import { IPC } from '../src/shared/ipc'
import { pickShell, clampDim, MAX_TERMINALS } from '../src/shared/terminalConfig'

type Exit = { exitCode: number; signal?: number }

class FakePty extends EventEmitter {
  readonly write = vi.fn()
  readonly resize = vi.fn()
  readonly kill = vi.fn()

  onData(listener: (data: string) => void): { dispose: () => void } {
    this.on('data', listener)
    return { dispose: () => { this.off('data', listener) } }
  }

  onExit(listener: (event: Exit) => void): { dispose: () => void } {
    this.on('exit', listener)
    return { dispose: () => { this.off('exit', listener) } }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(ok => { resolve = ok })
  return { promise, resolve }
}

const nativeName = '@homebridge/node-pty-prebuilt-multiarch'
const workspace = join(tmpdir(), 'cortex-owned-fake-terminal')
const send = vi.fn()
const destroyed = vi.fn(() => false)
const win = { isDestroyed: destroyed, webContents: { send } } as unknown as BrowserWindow
const spawn = vi.fn(() => {
  const pty = new FakePty()
  instances.push(pty)
  return pty
})
const native = { spawn }
let instances: FakePty[]
let terminal: typeof import('../src/main/services/terminalService')
let loading: ReturnType<typeof deferred<typeof native>> | undefined
let entered: ReturnType<typeof deferred<void>>
let loadingError: Error | undefined
let creations: Array<Promise<TerminalCreateResult>>

beforeEach(() => {
  vi.clearAllMocks()
  instances = []
  creations = []
  loading = undefined
  loadingError = undefined
  entered = deferred<void>()
  destroyed.mockReturnValue(false)
  spawn.mockReset().mockImplementation(() => {
    const pty = new FakePty()
    instances.push(pty)
    return pty
  })
  const source = readFileSync(join(__dirname, '../src/main/services/terminalService.ts'), 'utf8')
  const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  const exports = {} as typeof terminal
  // Overlapping delayed dynamic imports can bypass Vitest's factory mock.
  // This closed loader never resolves the real optional native module.
  runInNewContext(code, {
    exports,
    process: { platform: process.platform, env: { ...process.env } },
    require: (specifier: string) => {
      if (specifier === nativeName) {
        entered.resolve(undefined)
        if (loadingError) throw loadingError
        return loading ? loading.promise : native
      }
      if (specifier === 'os') return { homedir }
      if (specifier === '../../shared/ipc') return { IPC }
      if (specifier === '../../shared/terminalConfig') return { pickShell, clampDim, MAX_TERMINALS }
      if (specifier === './fsService') return { getWorkspaceRoot: () => workspace }
      throw new Error(`Unexpected runtime dependency in terminal lifecycle fixture: ${specifier}`)
    }
  })
  terminal = exports
})

afterEach(async () => {
  loading?.resolve(native)
  await Promise.allSettled(creations)
  terminal.killAll()
  for (const pty of instances) pty.removeAllListeners()
})

function create(id: string): Promise<TerminalCreateResult> {
  const result = terminal.create(win, { id, cols: 80, rows: 24 })
  creations.push(result)
  return result
}

async function opened(id: string): Promise<FakePty> {
  const index = instances.length
  const result = await create(id)
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, id, cwd: workspace })
  return instances[index]
}

describe('actual terminal lifecycle without native processes', () => {
  it('ignores retired data without muting a same-id replacement', async () => {
    const old = await opened('shared')
    terminal.kill('shared')
    const current = await opened('shared')
    send.mockClear()
    old.emit('data', 'old output')
    current.emit('data', 'current output')
    expect(send.mock.calls).toEqual([[IPC.TERMINAL_DATA, { id: 'shared', data: 'current output' }]])
    expect(terminal.count()).toBe(1)
  })

  it('keeps a replacement writable, resizable and killable after the old exit', async () => {
    const old = await opened('shared')
    terminal.kill('shared')
    const current = await opened('shared')
    send.mockClear()
    old.emit('exit', { exitCode: 1, signal: 9 })
    terminal.write('shared', 'current input')
    terminal.resize('shared', 91, 27)
    expect(terminal.count()).toBe(1)
    expect(current.write).toHaveBeenCalledWith('current input')
    expect(current.resize).toHaveBeenCalledWith(91, 27)
    expect(send).not.toHaveBeenCalled()
    terminal.kill('shared')
    expect(current.kill).toHaveBeenCalledOnce()
    expect(old.kill).toHaveBeenCalledOnce()
    expect(terminal.count()).toBe(0)
  })

  it('retires ownership before synchronous kill data and exit callbacks', async () => {
    const pty = await opened('disposed')
    const counts: number[] = []
    pty.kill.mockImplementation(() => {
      counts.push(terminal.count())
      pty.emit('data', 'stale during kill')
      pty.emit('exit', { exitCode: 1 })
    })
    send.mockClear()
    terminal.kill('disposed')
    terminal.kill('disposed')
    expect(counts).toEqual([0])
    expect(pty.kill).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
    expect(terminal.count()).toBe(0)
  })

  it('retires all sessions before killAll native callbacks', async () => {
    const first = await opened('first')
    const second = await opened('second')
    const counts: number[] = []
    for (const pty of [first, second]) pty.kill.mockImplementation(() => {
      counts.push(terminal.count())
      pty.emit('data', 'stale during killAll')
      pty.emit('exit', { exitCode: 1 })
    })
    send.mockClear()
    terminal.killAll()
    expect(counts).toEqual([0, 0])
    expect(first.kill).toHaveBeenCalledOnce()
    expect(second.kill).toHaveBeenCalledOnce()
    expect(send).not.toHaveBeenCalled()
    expect(terminal.count()).toBe(0)
  })

  it('kills each original session once when native kill reenters killAll', async () => {
    const first = await opened('first')
    const second = await opened('second')
    let reentered = false
    first.kill.mockImplementation(() => {
      if (reentered) return
      reentered = true
      terminal.killAll()
    })
    terminal.killAll()
    expect(first.kill).toHaveBeenCalledOnce()
    expect(second.kill).toHaveBeenCalledOnce()
    expect(terminal.count()).toBe(0)
  })

  it.each(['loading', 'cached'] as const)('cancels overlapping creates during %s module teardown', async phase => {
    if (phase === 'cached') expect(await terminal.isAvailable()).toBe(true)
    else loading = deferred<typeof native>()
    const first = create('pending-first')
    const second = create('pending-second')
    if (phase === 'loading') await entered.promise
    terminal.killAll()
    loading?.resolve(native)
    expect(await first).toMatchObject({ ok: false, error: expect.any(String) })
    expect(await second).toMatchObject({ ok: false, error: expect.any(String) })
    expect(spawn).not.toHaveBeenCalled()
    expect(terminal.count()).toBe(0)
    const current = await opened('after-teardown')
    current.emit('data', 'new session')
    expect(send).toHaveBeenCalledWith(IPC.TERMINAL_DATA, { id: 'after-teardown', data: 'new session' })
  })

  it.each(['loading', 'cached'] as const)('does not spawn into a window destroyed during %s module loading', async phase => {
    if (phase === 'cached') expect(await terminal.isAvailable()).toBe(true)
    else loading = deferred<typeof native>()
    const pending = create('destroyed-window')
    if (phase === 'loading') await entered.promise
    destroyed.mockReturnValue(true)
    loading?.resolve(native)
    expect(await pending).toMatchObject({ ok: false, error: expect.any(String) })
    expect(spawn).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(terminal.count()).toBe(0)
  })

  it('preserves active final data followed by natural exit and releases its slot', async () => {
    const pty = await opened('natural')
    pty.emit('data', 'final output\n')
    pty.emit('exit', { exitCode: 0, signal: 0 })
    expect(send.mock.calls).toEqual([
      [IPC.TERMINAL_DATA, { id: 'natural', data: 'final output\n' }],
      [IPC.TERMINAL_EXIT, { id: 'natural', exitCode: 0, signal: 0 }]
    ])
    expect(terminal.count()).toBe(0)
    expect(pty.kill).not.toHaveBeenCalled()
    terminal.write('natural', 'after exit')
    terminal.resize('natural', 91, 27)
    expect(pty.write).not.toHaveBeenCalled()
    expect(pty.resize).not.toHaveBeenCalled()
  })

  it('cleans an active natural exit even when the window cannot receive IPC', async () => {
    const pty = await opened('closed-window')
    destroyed.mockReturnValue(true)
    pty.emit('data', 'closed-window output')
    expect(() => pty.emit('exit', { exitCode: 0 })).not.toThrow()
    expect(terminal.count()).toBe(0)
    expect(send).not.toHaveBeenCalled()
    expect(pty.kill).not.toHaveBeenCalled()
  })

  it('rejects a live duplicate id without replacing its existing session', async () => {
    const pty = await opened('duplicate')
    expect(await create('duplicate')).toMatchObject({ ok: false, error: expect.stringContaining('already exists') })
    expect(spawn).toHaveBeenCalledOnce()
    expect(terminal.count()).toBe(1)
    terminal.write('duplicate', 'original session')
    expect(pty.write).toHaveBeenCalledWith('original session')
  })

  it('enforces the session cap and admits another session after natural exit', async () => {
    for (let index = 0; index < MAX_TERMINALS; index++) await opened(`capped-${index}`)
    expect(await create('over-cap')).toMatchObject({ ok: false, error: expect.stringContaining('Too many terminals') })
    expect(spawn).toHaveBeenCalledTimes(MAX_TERMINALS)
    expect(terminal.count()).toBe(MAX_TERMINALS)
    instances[0].emit('exit', { exitCode: 0 })
    await opened('released-slot')
    expect(terminal.count()).toBe(MAX_TERMINALS)
    expect(spawn).toHaveBeenCalledTimes(MAX_TERMINALS + 1)
  })

  it('reports an unavailable optional backend without spawning', async () => {
    loadingError = new Error('Owned fake native module is unavailable')
    expect(await terminal.isAvailable()).toBe(false)
    expect(await create('unavailable')).toMatchObject({ ok: false, error: expect.stringContaining('unavailable') })
    expect(spawn).not.toHaveBeenCalled()
    expect(terminal.count()).toBe(0)
  })

  it('reports a native spawn failure without retaining a session', async () => {
    spawn.mockImplementationOnce(() => { throw new Error('Owned fake spawn failed') })
    expect(await create('failed-spawn')).toMatchObject({ ok: false, error: expect.stringContaining('Owned fake spawn failed') })
    expect(terminal.count()).toBe(0)
    expect(send).not.toHaveBeenCalled()
    const current = await opened('after-failure')
    terminal.write('after-failure', 'valid input')
    expect(current.write).toHaveBeenCalledWith('valid input')
  })
})
