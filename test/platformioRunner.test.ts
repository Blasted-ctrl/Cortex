import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { resolve } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { RunRequest } from '../src/shared/ipc'
import { IPC } from '../src/shared/ipc'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), access: vi.fn(), mkdir: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mocks.spawn, execFile: vi.fn() }))
vi.mock('fs', async importOriginal => {
  const original = await importOriginal<typeof import('fs')>()
  return { ...original, promises: { ...original.promises, mkdir: mocks.mkdir, access: mocks.access } }
})
vi.mock('fs/promises', () => ({ mkdir: mocks.mkdir }))
const root = resolve('platformio-runner-fixture')
vi.mock('../src/main/services/fsService', () => ({ getWorkspaceRoot: () => root, withinWorkspace: () => true }))
vi.mock('../src/main/services/commandResolver', () => ({ safeCommand: (command: string) => command, commandMissing: () => false, needsShell: () => false }))
vi.mock('../src/main/services/arduinoCliService', () => ({
  getArduinoCli: async () => ({ command: 'mock-board-tools', args: [], source: 'managed', env: {} })
}))

import * as runner from '../src/main/services/runnerService'

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

const send = vi.fn()
const win = { isDestroyed: () => false, webContents: { send, isDestroyed: () => false } } as unknown as BrowserWindow
let children: FakeChild[]
const flush = async (): Promise<void> => { for (let turn = 0; turn < 20; turn++) await Promise.resolve() }
const request = (id: string, extra: Partial<RunRequest> = {}): RunRequest => ({
  id, language: 'cpp', cwd: root, filePath: resolve(root, 'platformio.ini'), buildOnly: true, buildSystem: 'platformio', ...extra
})
const exits = (id: string) => send.mock.calls.filter(([channel, payload]) => channel === IPC.RUN_EXIT && payload.id === id).map(([, payload]) => payload)
const everythingSent = (): string => JSON.stringify(send.mock.calls)

beforeEach(() => {
  vi.clearAllMocks()
  children = []
  mocks.mkdir.mockResolvedValue(undefined)
  mocks.access.mockResolvedValue(undefined)
  mocks.spawn.mockImplementation(() => {
    const child = new FakeChild()
    children.push(child)
    return child
  })
  send.mockImplementation((_channel, payload) => {
    if (payload?.deliveryToken) runner.acknowledgeOutput(win, payload.deliveryToken)
  })
})

afterEach(() => {
  runner.killAll()
  for (const child of children) { child.close(); child.stdout.end(); child.stderr.end(); child.stdin.end() }
  runner.disposeWindowRuns(win)
})

describe('PlatformIO build and upload commands', () => {
  it('builds with plain "pio run" and never flashes', async () => {
    const starting = runner.startRun(win, request('build-only'))
    await flush()
    expect(mocks.spawn).toHaveBeenCalledOnce()
    expect(mocks.spawn.mock.calls[0][0]).toBe('pio')
    expect(mocks.spawn.mock.calls[0][1]).toEqual(['run'])
    children[0].close(0)
    await starting
    expect(everythingSent()).toContain('PlatformIO build completed')
    expect(exits('build-only').at(-1)).toMatchObject({ code: 0 })
  })

  it('uploads with fixed arguments and the chosen port as one argv element', async () => {
    const starting = runner.startRun(win, request('upload', { uploadPort: 'COM5' }))
    await flush()
    expect(mocks.spawn.mock.calls[0][1]).toEqual(['run', '-t', 'upload', '--upload-port', 'COM5'])
    expect(mocks.spawn.mock.calls[0][2]).toMatchObject({ cwd: root })
    children[0].close(0)
    await starting
    expect(everythingSent()).toContain('$ pio run -t upload --upload-port COM5')
    expect(everythingSent()).toContain('PlatformIO upload completed')
    expect(exits('upload').at(-1)).toMatchObject({ code: 0, phase: 'run' })
  })

  it('reports a failed upload as a failure', async () => {
    const starting = runner.startRun(win, request('failed', { uploadPort: '/dev/ttyUSB0' }))
    await flush()
    children[0].stderr.write('A fatal error occurred: Could not open port\n')
    children[0].close(2)
    await starting
    expect(exits('failed').at(-1)).toMatchObject({ code: 2 })
    expect(everythingSent()).not.toContain('upload completed')
  })

  it.each(['', '--erase', '-t', 'COM5 --erase', 'COM5;calc', '/tmp/ttyUSB0', 'C:/x/COM5'])('refuses a port that is not a plain device name: %j', async port => {
    await runner.startRun(win, request('bad-port', { uploadPort: port }))
    await flush()
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(everythingSent()).toContain('Refusing to upload')
    expect(exits('bad-port').at(-1)?.code).not.toBe(0)
  })

  it('refuses a non-string port from a hostile caller', async () => {
    await runner.startRun(win, request('bad-type', { uploadPort: 5 as unknown as string }))
    await flush()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
