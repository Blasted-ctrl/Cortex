import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  getArduinoCli: vi.fn(),
  clearArduinoCliSetupHint: vi.fn(),
  execFileAsync: vi.fn(),
  spawn: vi.fn(),
  sendRunOutput: vi.fn(),
  sendRunExit: vi.fn(),
  trackProcess: vi.fn(),
  untrackProcess: vi.fn(),
  beginRunStart: vi.fn(() => new AbortController().signal),
  finishRunStart: vi.fn(),
  runStartCancelled: vi.fn(() => false),
  emitDiagnostics: vi.fn(),
  additionalUrls: [] as string[]
}))

vi.mock('child_process', () => ({
  execFile: Object.assign(vi.fn(), {
    [Symbol.for('nodejs.util.promisify.custom')]: mocks.execFileAsync
  }),
  spawn: mocks.spawn
}))
vi.mock('../src/main/services/arduinoCliService', () => ({ getArduinoCli: mocks.getArduinoCli, clearArduinoCliSetupHint: mocks.clearArduinoCliSetupHint }))
vi.mock('../src/main/services/runnerService', () => ({
  sendRunOutput: mocks.sendRunOutput,
  sendRunExit: mocks.sendRunExit,
  trackProcess: mocks.trackProcess,
  untrackProcess: mocks.untrackProcess,
  beginRunStart: mocks.beginRunStart,
  finishRunStart: mocks.finishRunStart,
  runStartCancelled: mocks.runStartCancelled,
  emitDiagnostics: mocks.emitDiagnostics
}))
vi.mock('../src/main/services/settingsService', () => ({
  getSettings: async () => ({ boards: { additionalUrls: mocks.additionalUrls } })
}))
vi.mock('../src/main/services/fsService', () => ({ getWorkspaceRoot: () => null }))

import * as embedded from '../src/main/services/embeddedService'
import * as packages from '../src/main/services/packageService'
import { detectToolchains } from '../src/main/services/toolchainService'

const command = join(process.cwd(), '.cortex', 'test-tools', 'arduino-cli.exe')
const prefix = ['--config-file', join(process.cwd(), '.cortex', 'test-tools', 'arduino-cli.yaml')]
const cli = { command, args: prefix, source: 'managed' as const, env: { PATH: process.env.PATH, CORTEX_BOARD_TOOLS_TEST: 'true' } }
const win = {} as Parameters<typeof embedded.compile>[0]
const sketchPath = join(process.cwd(), 'examples', 'blink', 'blink.ino')

function child(): EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough } {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.getArduinoCli.mockResolvedValue(cli)
  mocks.execFileAsync.mockResolvedValue({ stdout: '{}', stderr: '' })
  mocks.spawn.mockImplementation(() => child())
  mocks.additionalUrls = []
})

describe('Arduino services use the same managed executable and configuration', () => {
  it('reports the managed runtime version and source', async () => {
    mocks.execFileAsync.mockResolvedValue({ stdout: 'arduino-cli Version: 1.5.1\n', stderr: '' })
    expect(await embedded.status()).toMatchObject({
      available: true, version: 'arduino-cli Version: 1.5.1', source: 'managed'
    })
    expect(mocks.execFileAsync).toHaveBeenCalledWith(command, [...prefix, 'version'], expect.objectContaining({ env: cli.env }))
  })

  it.each([
    ['connected boards', () => embedded.listConnected(), ['board', 'list', '--format', 'json']],
    ['board targets', () => embedded.listAll(), ['board', 'listall', '--format', 'json']],
    ['board MCU', () => embedded.boardMcu('arduino:avr:uno'), ['board', 'details', '--fqbn', 'arduino:avr:uno', '--format', 'json']],
    ['core search', () => packages.coreSearch('avr'), ['core', 'search', 'avr', '--format', 'json']],
    ['installed cores', () => packages.coreInstalled(), ['core', 'list', '--format', 'json']],
    ['library search', () => packages.libSearch('Servo'), ['lib', 'search', 'Servo', '--format', 'json']],
    ['installed libraries', () => packages.libInstalled(), ['lib', 'list', '--format', 'json']]
  ])('%s prepends the managed configuration', async (_name, run, args) => {
    await run()
    expect(mocks.execFileAsync).toHaveBeenCalledWith(command, [...prefix, ...args], expect.objectContaining({ env: cli.env }))
  })

  it('preserves board and library JSON parsing', async () => {
    mocks.execFileAsync.mockResolvedValueOnce({
      stdout: JSON.stringify({ detected_ports: [{ port: { address: 'COM8' }, matching_boards: [{ name: 'Uno', fqbn: 'arduino:avr:uno' }] }] }), stderr: ''
    })
    expect(await embedded.listConnected()).toEqual([{ address: 'COM8', protocol: 'serial', label: undefined, boardName: 'Uno', fqbn: 'arduino:avr:uno' }])
    mocks.execFileAsync.mockResolvedValueOnce({
      stdout: JSON.stringify({ installed_libraries: [{ library: { name: 'Servo', version: '1.3.0', provides_includes: ['Servo.h'], architectures: ['avr'] } }] }), stderr: ''
    })
    expect(await packages.libInstalled()).toMatchObject([{ name: 'Servo', installedVersion: '1.3.0', providesIncludes: ['Servo.h'], architectures: ['avr'] }])
  })

  it('retains managed configuration when an unavailable vendor index triggers search fallback', async () => {
    mocks.additionalUrls = ['https://espressif.github.io/arduino-esp32/package_esp32_index.json']
    mocks.execFileAsync.mockRejectedValueOnce(new Error('Vendor index unavailable'))
    mocks.execFileAsync.mockResolvedValueOnce({ stdout: '{}', stderr: '' })
    await packages.coreSearch('avr')
    expect(mocks.execFileAsync).toHaveBeenNthCalledWith(1, command, [
      ...prefix, 'core', 'search', 'avr', '--additional-urls', mocks.additionalUrls[0], '--format', 'json'
    ], expect.any(Object))
    expect(mocks.execFileAsync).toHaveBeenNthCalledWith(2, command, [...prefix, 'core', 'search', 'avr', '--format', 'json'], expect.any(Object))
  })

  it.each([
    ['verify', () => embedded.compile(win, { id: 'operation', fqbn: 'arduino:avr:uno', sketchPath }), ['compile', '--fqbn', 'arduino:avr:uno', sketchPath], 'compile'],
    ['upload', () => embedded.upload(win, { id: 'operation', fqbn: 'arduino:avr:uno', sketchPath, port: 'COM8' }), ['compile', '--upload', '--fqbn', 'arduino:avr:uno', '-p', 'COM8', sketchPath], 'compile'],
    ['core install', () => packages.coreInstall(win, { id: 'operation', name: 'arduino:avr', version: '1.8.6' }), ['core', 'install', '--', 'arduino:avr@1.8.6'], 'run'],
    ['core remove', () => packages.coreUninstall(win, 'operation', 'arduino:avr'), ['core', 'uninstall', '--', 'arduino:avr'], 'run'],
    ['index refresh', () => packages.coreUpdateIndex(win, 'operation'), ['core', 'update-index'], 'run'],
    ['library install', () => packages.libInstall(win, { id: 'operation', name: 'Servo', version: '1.3.0' }), ['lib', 'install', '--', 'Servo@1.3.0'], 'run'],
    ['library remove', () => packages.libUninstall(win, 'operation', 'Servo'), ['lib', 'uninstall', '--', 'Servo'], 'run']
  ])('%s streams from the managed runtime and emits its completion', async (_name, run, args, phase) => {
    await run()
    expect(mocks.spawn).toHaveBeenCalledWith(command, [...prefix, ...args], expect.objectContaining({ env: cli.env }))
    expect(mocks.spawn.mock.calls[0][2].shell).not.toBe(true)
    const proc = mocks.spawn.mock.results[0].value as ReturnType<typeof child>
    proc.stdout.write('working\n')
    proc.emit('close', 0, null)
    expect(mocks.sendRunOutput).toHaveBeenCalledWith(win, 'operation', 'stdout', 'working\n')
    expect(mocks.sendRunExit).toHaveBeenCalledWith(win, expect.objectContaining({ id: 'operation', code: 0, phase }))
    expect(mocks.untrackProcess).toHaveBeenCalledWith('operation')
  })

  it('uses a safe PATH installation without adding Cortex configuration', async () => {
    mocks.getArduinoCli.mockResolvedValue({ command, args: [], source: 'path' })
    await embedded.listConnected()
    await packages.libInstall(win, { id: 'operation', name: 'Servo' })
    expect(mocks.execFileAsync).toHaveBeenCalledWith(command, ['board', 'list', '--format', 'json'], expect.any(Object))
    expect(mocks.spawn).toHaveBeenCalledWith(command, ['lib', 'install', '--', 'Servo'], expect.any(Object))
  })

  it.each([0, 1])('clears the setup catalog warning only after a successful index refresh (exit %s)', async (code) => {
    await packages.coreUpdateIndex(win, 'refresh')
    const proc = mocks.spawn.mock.results[0].value as ReturnType<typeof child>
    proc.emit('close', code, null)
    expect(mocks.clearArduinoCliSetupHint).toHaveBeenCalledTimes(code === 0 ? 1 : 0)
  })

  it('does not clear a catalog warning after an unrelated successful install', async () => {
    await packages.libInstall(win, { id: 'install', name: 'Servo' })
    const proc = mocks.spawn.mock.results[0].value as ReturnType<typeof child>
    proc.emit('close', 0, null)
    expect(mocks.clearArduinoCliSetupHint).not.toHaveBeenCalled()
  })

  it('keeps renderer-supplied package names as a single positional argument without a shell', async () => {
    const name = '-unsafe & injected-command'
    await packages.libInstall(win, { id: 'operation', name })
    expect(mocks.spawn).toHaveBeenCalledWith(command, [...prefix, 'lib', 'install', '--', name], { windowsHide: true, env: cli.env })
  })
})

describe('missing or failed board tools never fall back to a bare command', () => {
  it('offers in-app setup rather than a manual CLI download', async () => {
    mocks.getArduinoCli.mockResolvedValue(null)
    const status = await embedded.status()
    expect(status.available).toBe(false)
    expect(status.hint).toContain('Set up board tools')
    expect(status.hint).not.toMatch(/winget|brew|Install arduino-cli/i)
    await embedded.listConnected()
    await packages.libInstalled()
    expect(mocks.execFileAsync).not.toHaveBeenCalled()
  })

  it.each([
    ['verify', () => embedded.compile(win, { id: 'operation', fqbn: 'arduino:avr:uno', sketchPath }), 'compile'],
    ['upload', () => embedded.upload(win, { id: 'operation', fqbn: 'arduino:avr:uno', sketchPath, port: 'COM8' }), 'compile'],
    ['core install', () => packages.coreInstall(win, { id: 'operation', name: 'arduino:avr' }), 'run'],
    ['library install', () => packages.libInstall(win, { id: 'operation', name: 'Servo' }), 'run']
  ])('%s reports startup failure and completes the operation', async (_name, run, phase) => {
    mocks.getArduinoCli.mockResolvedValue(null)
    await run()
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(mocks.sendRunOutput).toHaveBeenCalledWith(win, 'operation', 'stderr', expect.stringContaining('Set up board tools'))
    expect(mocks.sendRunExit).toHaveBeenCalledWith(win, expect.objectContaining({ id: 'operation', code: 127, phase }))
  })

  it('reports a rejected runtime resolution through the streamed operation', async () => {
    mocks.getArduinoCli.mockRejectedValue(new Error('Configuration could not be read'))
    await packages.libInstall(win, { id: 'operation', name: 'Servo' })
    expect(mocks.sendRunExit).toHaveBeenCalledWith(win, expect.objectContaining({ code: 127 }))
    expect(mocks.sendRunOutput).toHaveBeenCalledWith(win, 'operation', 'stderr', expect.stringContaining('Configuration could not be read'))
  })

  it('reports a synchronous native launch failure without leaving the operation pending', async () => {
    mocks.spawn.mockImplementationOnce(() => { throw new Error('Permission denied') })
    await embedded.compile(win, { id: 'operation', fqbn: 'arduino:avr:uno', sketchPath })
    expect(mocks.sendRunExit).toHaveBeenCalledWith(win, expect.objectContaining({ id: 'operation', code: 127, phase: 'compile' }))
    expect(mocks.sendRunOutput).toHaveBeenCalledWith(win, 'operation', 'stderr', expect.stringContaining('Permission denied'))
  })
})

describe('toolchain detection reflects managed board tools without installing them', () => {
  it('probes the resolved command/configuration and refreshes stale availability', async () => {
    mocks.getArduinoCli.mockResolvedValue(null)
    const first = await detectToolchains(true)
    expect(first.find(t => t.id === 'arduino-cli')?.available).toBe(false)
    expect(mocks.execFileAsync.mock.calls.some(([bin]) => bin === 'arduino-cli')).toBe(false)

    mocks.getArduinoCli.mockResolvedValue(cli)
    mocks.execFileAsync.mockResolvedValue({ stdout: 'arduino-cli Version: 1.5.1\n', stderr: '' })
    const refreshed = await detectToolchains(true)
    expect(refreshed.find(t => t.id === 'arduino-cli')).toMatchObject({ command, available: true, version: 'arduino-cli Version: 1.5.1' })
    expect(mocks.execFileAsync).toHaveBeenCalledWith(command, [...prefix, 'version'], expect.objectContaining({ env: cli.env }))
  })
})
