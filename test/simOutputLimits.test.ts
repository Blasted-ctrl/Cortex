import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { BrowserWindow } from 'electron'
import { IPC } from '../src/shared/ipc'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), emitDiagnostics: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../src/main/services/runnerService', () => ({ emitDiagnostics: mocks.emitDiagnostics }))
vi.mock('../src/main/services/commandResolver', () => ({ safeCommand: () => 'mock-compiler' }))
vi.mock('../src/main/services/fsService', () => ({ getWorkspaceRoot: () => null }))
vi.mock('../src/main/services/simBuild', () => ({
  SIM_MAIN: '', prepareSimulation: async (req: { simDir: string }) => ({ exePath: join(req.simDir, 'sim.exe'), args: [], cwd: req.simDir })
}))
import * as simulator from '../src/main/services/simService'

const LIMIT = 1024 * 1024
const send = vi.fn()
const win = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow
let workspace: string
let children: ReturnType<typeof child>[]
let sequence = 0
function child() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn()
  })
}
async function start(launch = true): Promise<{ id: string; proc: ReturnType<typeof child> }> {
  const id = `output-limit-${++sequence}`
  await simulator.start(win, { id, cwd: workspace, filePath: join(workspace, 'sketch.ino') })
  if (launch) children[0].emit('close', 0)
  return { id, proc: children[launch ? 1 : 0] }
}
beforeAll(async () => { workspace = await mkdtemp(join(tmpdir(), 'cortex-sim-limits-')) })
afterAll(async () => { await rm(workspace, { recursive: true, force: true }) })
beforeEach(() => {
  vi.clearAllMocks()
  children = []
  mocks.spawn.mockImplementation(() => { const proc = child(); children.push(proc); return proc })
})
afterEach(() => {
  simulator.killAll()
  for (const proc of children) { proc.emit('exit', null); proc.emit('close', null) }
})

describe('desktop simulation output remains bounded and failures are explicit', () => {
  it('stops overflowing compiler diagnostics and never launches a successful compiler result', async () => {
    const { id, proc } = await start(false)
    proc.stderr.emit('data', 'x'.repeat(LIMIT))
    expect(proc.kill).not.toHaveBeenCalled()
    proc.stderr.emit('data', 'overflow')
    expect(proc.kill).toHaveBeenCalledTimes(1)
    proc.emit('close', 0)
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(IPC.SIM_EXIT, { id, code: 2 })
    expect(send.mock.calls.some(([channel, value]) => channel === IPC.SIM_EVENT && /diagnostic.*limit|limit.*diagnostic/i.test(value.text))).toBe(true)
    for (const [, , diagnostics] of mocks.emitDiagnostics.mock.calls) expect(Buffer.byteLength(diagnostics)).toBeLessThanOrEqual(LIMIT)
  })

  it('fails on an unterminated stdout line and drops subsequent output after overflow', async () => {
    const { id, proc } = await start()
    proc.stdout.emit('data', 'x'.repeat(LIMIT))
    expect(proc.kill).not.toHaveBeenCalled()
    proc.stdout.emit('data', 'overflow')
    expect(proc.kill).toHaveBeenCalledTimes(1)
    const calls = send.mock.calls.length
    proc.stdout.emit('data', '@pin 13 1\n'.repeat(1000))
    expect(send.mock.calls).toHaveLength(calls)
    proc.emit('close', 0)
    expect(send).toHaveBeenCalledWith(IPC.SIM_EXIT, { id, code: 2 })
    expect(send.mock.calls.some(([channel, value]) => channel === IPC.SIM_EVENT && /line.*limit|limit.*line/i.test(value.text))).toBe(true)
    expect(send.mock.calls.some(([channel, value]) => channel === IPC.SIM_EVENT && value.kind === 'serial')).toBe(false)
  })

  it('checks complete oversized lines too, not just trailing partials', async () => {
    const { id, proc } = await start()
    proc.stdout.emit('data', '@serial ' + 'x'.repeat(LIMIT) + '\n')
    proc.emit('close', 0)
    expect(proc.kill).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(IPC.SIM_EXIT, { id, code: 2 })
    expect(send.mock.calls.some(([channel, value]) => channel === IPC.SIM_EVENT && value.kind === 'serial')).toBe(false)
  })

  it.each(['stdout', 'stderr'] as const)('measures %s limits in UTF-8 bytes instead of character count', async (stream) => {
    const { id, proc } = await start(stream === 'stdout')
    proc[stream].emit('data', 'é'.repeat(LIMIT / 2))
    expect(proc.kill).not.toHaveBeenCalled()
    proc[stream].emit('data', 'é')
    expect(proc.kill).toHaveBeenCalledTimes(1)
    proc.emit('close', 0)
    expect(send).toHaveBeenCalledWith(IPC.SIM_EXIT, { id, code: 2 })
  })

  it('preserves ordinary chunked protocol, split CRLF, and final serial residue', async () => {
    const { id, proc } = await start()
    proc.stdout.emit('data', '@serial Hello')
    proc.stdout.emit('data', ' world\r')
    proc.stdout.emit('data', '\n@pin 13 1\n@serial tail')
    proc.emit('close', 0)
    expect(send).toHaveBeenCalledWith(IPC.SIM_EVENT, { id, kind: 'serial', text: 'Hello world' })
    expect(send).toHaveBeenCalledWith(IPC.SIM_EVENT, { id, kind: 'pin', pin: 13, value: 1 })
    expect(send).toHaveBeenCalledWith(IPC.SIM_EVENT, { id, kind: 'serial', text: 'tail' })
    expect(send).toHaveBeenCalledWith(IPC.SIM_EXIT, { id, code: 0 })
    expect(proc.kill).not.toHaveBeenCalled()
  })

  it('can process a chunk larger than the limit when individual lines are bounded', async () => {
    const { id, proc } = await start()
    const payload = 'a'.repeat(600_000)
    proc.stdout.emit('data', `@serial ${payload}\n@serial ${payload}\n`)
    proc.emit('close', 0)
    expect(send.mock.calls.filter(([channel, value]) => channel === IPC.SIM_EVENT && value.kind === 'serial')).toHaveLength(2)
    expect(send).toHaveBeenCalledWith(IPC.SIM_EXIT, { id, code: 0 })
    expect(proc.kill).not.toHaveBeenCalled()
  })
})
