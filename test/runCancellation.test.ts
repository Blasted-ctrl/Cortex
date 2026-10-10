import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BrowserWindow } from 'electron'
import type { RunRequest, SimStartRequest } from '../src/shared/ipc'
import { IPC } from '../src/shared/ipc'

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  mkdir: vi.fn(),
  access: vi.fn(),
  getArduinoCli: vi.fn(),
  getSettings: vi.fn(),
  prepareSimulation: vi.fn()
}))

vi.mock('child_process', () => ({ spawn: mocks.spawn, execFile: vi.fn() }))
vi.mock('fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('fs')>()
  return { ...original, promises: { ...original.promises, mkdir: mocks.mkdir, access: mocks.access } }
})
vi.mock('../src/main/services/fsService', () => ({ getWorkspaceRoot: () => null, withinWorkspace: () => true }))
vi.mock('../src/main/services/commandResolver', () => ({
  safeCommand: (command: string) => command,
  commandMissing: () => false,
  needsShell: () => false
}))
vi.mock('../src/main/services/arduinoCliService', () => ({
  getArduinoCli: mocks.getArduinoCli,
  clearArduinoCliSetupHint: vi.fn()
}))
vi.mock('../src/main/services/settingsService', () => ({ getSettings: mocks.getSettings }))
vi.mock('../src/main/services/simBuild', () => ({ prepareSimulation: mocks.prepareSimulation, SIM_MAIN: '' }))

import * as runner from '../src/main/services/runnerService'
import * as embedded from '../src/main/services/embeddedService'
import * as packages from '../src/main/services/packageService'
import * as simulator from '../src/main/services/simService'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn()
  })
}

let workspace: string
const send = vi.fn()
const destroyed = vi.fn(() => false)
const win = { isDestroyed: destroyed, webContents: { send, isDestroyed: destroyed } } as unknown as BrowserWindow
const cli = { command: 'mock-arduino-cli', args: [], source: 'managed' as const, env: {} }
let children: ReturnType<typeof child>[]
let autoClose: boolean
const request = (id: string, language: RunRequest['language'] = 'cpp'): RunRequest => ({
  id, language, cwd: workspace, filePath: join(workspace, language === 'rust' ? 'main.rs' : 'main.cpp')
})
const simRequest = (id: string): SimStartRequest => ({ id, cwd: workspace, filePath: join(workspace, 'sketch.ino') })
const boardRequest = (id: string) => ({ id, fqbn: 'arduino:avr:uno', sketchPath: join(workspace, 'sketch.ino'), port: 'MOCK-NOT-HARDWARE' })

beforeAll(async () => { workspace = await mkdtemp(join(tmpdir(), 'cortex-cancel-')) })
afterAll(async () => { await rm(workspace, { recursive: true, force: true }) })
beforeEach(() => {
  vi.clearAllMocks()
  send.mockImplementation((_channel, payload) => { if (payload.deliveryToken) runner.acknowledgeOutput(win, payload.deliveryToken) })
  children = []
  autoClose = true
  destroyed.mockReturnValue(false)
  mocks.mkdir.mockResolvedValue(undefined)
  mocks.access.mockRejectedValue(new Error('No Cargo project'))
  mocks.getArduinoCli.mockResolvedValue(cli)
  mocks.getSettings.mockResolvedValue({ boards: { additionalUrls: [] } })
  mocks.prepareSimulation.mockResolvedValue({ exePath: join(workspace, 'sim.exe'), args: [], cwd: workspace })
  mocks.spawn.mockImplementation(() => {
    const proc = child()
    children.push(proc)
    // An unexpected compiler must finish in RED tests rather than hang them.
    if (autoClose) queueMicrotask(() => { proc.emit('exit', 1); proc.emit('close', 1, null) })
    return proc
  })
})
afterEach(() => {
  runner.killAll()
  runner.disposeWindowRuns(win)
  simulator.killAll()
  for (const proc of children) { proc.emit('exit', null); proc.emit('close', null, null) }
})

describe('Stop cancels reserved runs before any executable can launch', () => {
  it('rejects a reload retry while the old resolver is cancelling and succeeds after it finishes', async () => {
    const tool = deferred<typeof cli>()
    mocks.getArduinoCli.mockReturnValueOnce(tool.promise)
    const old = embedded.compile(win, boardRequest('reload-retry'))
    runner.disposeWindowRuns(win)
    await expect(embedded.compile(win, boardRequest('reload-retry'))).rejects.toThrow(/still active or cancelling/)
    expect(mocks.spawn).not.toHaveBeenCalled()
    tool.resolve(cli)
    await old
    await embedded.compile(win, boardRequest('reload-retry'))
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })

  it('does not let an old closed child remove a new window run with the same id', async () => {
    autoClose = false
    await runner.startRun(win, request('same-id-after-quit', 'javascript'))
    runner.killAll()
    const newWin = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: vi.fn((_channel, payload) => {
      if (payload.deliveryToken) runner.acknowledgeOutput(newWin as unknown as BrowserWindow, payload.deliveryToken)
    }) } } as unknown as BrowserWindow
    await runner.startRun(newWin, request('same-id-after-quit', 'javascript'))
    expect(children).toHaveLength(2)
    children[0].emit('close', 0, null)
    runner.stopRun('same-id-after-quit')
    expect(children[1].kill).toHaveBeenCalledTimes(1)
    children[1].emit('close', 0, null)
    runner.disposeWindowRuns(newWin)
  })

  it.each(['compile', 'upload'] as const)('cancels a board %s during delayed CLI resolution', async (operation) => {
    const tool = deferred<typeof cli>()
    mocks.getArduinoCli.mockReturnValueOnce(tool.promise)
    const pending = embedded[operation](win, boardRequest(operation))
    runner.stopRun(operation)
    tool.resolve(cli)
    await pending
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(IPC.RUN_EXIT, expect.objectContaining({ id: operation, code: null, phase: 'compile' }))
  })

  it('treats a resolver error after cancellation as cancellation, not a failed upload', async () => {
    const tool = deferred<typeof cli>()
    mocks.getArduinoCli.mockReturnValueOnce(tool.promise)
    const pending = embedded.upload(win, boardRequest('cancelled-error'))
    runner.stopRun('cancelled-error')
    tool.reject(new Error('Tool resolution failed'))
    await pending
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(IPC.RUN_EXIT, expect.objectContaining({ id: 'cancelled-error', code: null }))
    expect(send.mock.calls.some(([channel, value]) => channel === IPC.RUN_OUTPUT && value.stream === 'stderr')).toBe(false)
  })

  it('quit cancels uploads that have not yet resolved their tools', async () => {
    const tool = deferred<typeof cli>()
    mocks.getArduinoCli.mockReturnValueOnce(tool.promise)
    const pending = embedded.upload(win, boardRequest('quit-upload'))
    runner.killAll()
    tool.resolve(cli)
    await pending
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('does not upload after the originating window has closed', async () => {
    const tool = deferred<typeof cli>()
    mocks.getArduinoCli.mockReturnValueOnce(tool.promise)
    const pending = embedded.upload(win, boardRequest('closed-upload'))
    destroyed.mockReturnValue(true)
    tool.resolve(cli)
    await pending
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('rejects duplicate pending IDs and releases a cancelled ID for a later retry', async () => {
    const tool = deferred<typeof cli>()
    mocks.getArduinoCli.mockReturnValueOnce(tool.promise)
    const pending = embedded.compile(win, boardRequest('duplicate'))
    await expect(embedded.upload(win, boardRequest('duplicate'))).rejects.toThrow(/still active or cancelling/)
    expect(mocks.getArduinoCli).toHaveBeenCalledTimes(1)
    runner.stopRun('duplicate')
    tool.resolve(cli)
    await pending
    await embedded.compile(win, boardRequest('duplicate'))
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })

  it('cancels a native build while its output directory is being created', async () => {
    const directory = deferred<void>()
    mocks.mkdir.mockReturnValueOnce(directory.promise)
    const pending = runner.startRun(win, request('native-mkdir'))
    runner.stopRun('native-mkdir')
    directory.resolve()
    await pending
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(IPC.RUN_EXIT, expect.objectContaining({ id: 'native-mkdir', code: null }))
  })

  it('reports cancellation when native directory preparation rejects after Stop', async () => {
    const directory = deferred<void>()
    mocks.mkdir.mockReturnValueOnce(directory.promise)
    const pending = runner.startRun(win, request('native-prep-error'))
    runner.stopRun('native-prep-error')
    directory.reject(new Error('Directory preparation failed'))
    await expect(pending).resolves.toBeUndefined()
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(IPC.RUN_EXIT, expect.objectContaining({ id: 'native-prep-error', code: null }))
  })

  it('preserves unexpected preparation errors and releases the ID for retry', async () => {
    mocks.mkdir.mockRejectedValueOnce(new Error('Directory permission denied'))
    await expect(runner.startRun(win, request('native-retry'))).rejects.toThrow('Directory permission denied')
    await runner.startRun(win, request('native-retry'))
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })

  it('cancels Cargo discovery before cargo can build or run', async () => {
    const manifest = deferred<void>()
    mocks.access.mockReturnValueOnce(manifest.promise)
    const pending = runner.startRun(win, request('cargo-discovery', 'rust'))
    runner.stopRun('cargo-discovery')
    manifest.resolve()
    await pending
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('cancels loose Rust compilation during directory preparation', async () => {
    const directory = deferred<void>()
    mocks.mkdir.mockReturnValueOnce(directory.promise)
    const pending = runner.startRun(win, request('rust-mkdir', 'rust'))
    await vi.waitFor(() => expect(mocks.mkdir).toHaveBeenCalled())
    runner.stopRun('rust-mkdir')
    directory.resolve()
    await pending
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it.each(['cpp', 'rust'] as const)('does not launch a %s binary when a stopped compiler exits successfully', async (language) => {
    autoClose = false
    const pending = runner.startRun(win, request(`handoff-${language}`, language))
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1))
    runner.stopRun(`handoff-${language}`)
    expect(children[0].kill).toHaveBeenCalledTimes(1)
    children[0].emit('close', 0, null)
    await pending
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(IPC.RUN_EXIT, expect.objectContaining({ id: `handoff-${language}`, code: null }))
  })

  it('keeps Stop effective between compiler close and the executable handoff', async () => {
    autoClose = false
    const pending = runner.startRun(win, request('between-phases'))
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1))
    children[0].emit('close', 0, null)
    runner.stopRun('between-phases')
    await pending
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(IPC.RUN_EXIT, expect.objectContaining({ id: 'between-phases', code: null, phase: 'run' }))
  })

  it('still launches a successful native build and tracks its executable for Stop', async () => {
    autoClose = false
    const pending = runner.startRun(win, request('normal-native'))
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1))
    children[0].emit('close', 0, null)
    await pending
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    runner.stopRun('normal-native')
    expect(children[1].kill).toHaveBeenCalledTimes(1)
  })

  it('cancels only the exact reserved ID, not another pending upload', async () => {
    const first = deferred<typeof cli>()
    const second = deferred<typeof cli>()
    mocks.getArduinoCli.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const stopped = embedded.upload(win, boardRequest('stopped-upload'))
    const running = embedded.upload(win, boardRequest('other-upload'))
    runner.stopRun('stopped-upload')
    first.resolve(cli)
    second.resolve(cli)
    await Promise.all([stopped, running])
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })

  it.each(['coreInstall', 'coreUpdateIndex'] as const)('cancels %s during delayed settings preparation', async (operation) => {
    const settings = deferred<{ boards: { additionalUrls: string[] } }>()
    mocks.getSettings.mockReturnValueOnce(settings.promise)
    const pending = operation === 'coreInstall'
      ? packages.coreInstall(win, { id: operation, name: 'arduino:avr' })
      : packages.coreUpdateIndex(win, operation)
    runner.stopRun(operation)
    settings.resolve({ boards: { additionalUrls: [] } })
    await pending
    expect(mocks.getArduinoCli).not.toHaveBeenCalled()
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(IPC.RUN_EXIT, expect.objectContaining({ id: operation, code: null, phase: 'run' }))
  })

  it('cancels library installation while resolving CLI tools', async () => {
    const tool = deferred<typeof cli>()
    mocks.getArduinoCli.mockReturnValueOnce(tool.promise)
    const pending = packages.libInstall(win, { id: 'library', name: 'Servo' })
    runner.stopRun('library')
    tool.resolve(cli)
    await pending
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})

describe('Simulation preparation has its own SIM_STOP reservation', () => {
  it.each(['stop', 'quit'] as const)('%s prevents a prepared simulation from spawning its compiler', async (action) => {
    const prepared = deferred<{ exePath: string; args: string[]; cwd: string }>()
    mocks.prepareSimulation.mockReturnValueOnce(prepared.promise)
    const pending = simulator.start(win, simRequest(action))
    if (action === 'stop') simulator.stop(action)
    else simulator.killAll()
    prepared.resolve({ exePath: join(workspace, 'sim.exe'), args: [], cwd: workspace })
    await pending
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(IPC.SIM_EXIT, { id: action, code: null })
  })

  it('does not start a prepared simulation after the window closes', async () => {
    const prepared = deferred<{ exePath: string; args: string[]; cwd: string }>()
    mocks.prepareSimulation.mockReturnValueOnce(prepared.promise)
    const pending = simulator.start(win, simRequest('closed-sim'))
    destroyed.mockReturnValue(true)
    prepared.resolve({ exePath: join(workspace, 'sim.exe'), args: [], cwd: workspace })
    await pending
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('does not prepare a duplicate ID and can retry a cancelled preparation', async () => {
    const prepared = deferred<{ exePath: string; args: string[]; cwd: string }>()
    mocks.prepareSimulation.mockReturnValueOnce(prepared.promise)
    const pending = simulator.start(win, simRequest('sim-duplicate'))
    await simulator.start(win, simRequest('sim-duplicate'))
    expect(mocks.prepareSimulation).toHaveBeenCalledTimes(1)
    simulator.stop('sim-duplicate')
    prepared.resolve({ exePath: join(workspace, 'sim.exe'), args: [], cwd: workspace })
    await pending
    await simulator.start(win, simRequest('sim-duplicate'))
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
  })

  it('keeps the normal compiler-to-simulation handoff working', async () => {
    autoClose = false
    await simulator.start(win, simRequest('normal-sim'))
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    children[0].emit('close', 0, null)
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
    expect(mocks.spawn.mock.calls[1][0]).toBe(join(workspace, 'sim.exe'))
  })
})
