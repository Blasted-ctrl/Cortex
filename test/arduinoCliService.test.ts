import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const mocks = vi.hoisted(() => ({
  root: '', packaged: false,
  safeCommand: vi.fn(), install: vi.fn(), exec: vi.fn(),
  urls: [] as string[]
}))
vi.mock('electron', () => ({ app: { getPath: () => mocks.root, get isPackaged() { return mocks.packaged } } }))
vi.mock('child_process', () => ({ execFile: Object.assign(vi.fn(), {
  [Symbol.for('nodejs.util.promisify.custom')]: mocks.exec
}) }))
vi.mock('../src/main/services/arduinoCliInstall', () => ({ installArduinoCli: mocks.install }))
vi.mock('../src/main/services/commandResolver', () => ({ safeCommand: mocks.safeCommand }))
vi.mock('../src/main/services/fsService', () => ({ getWorkspaceRoot: () => '/untrusted-project' }))
vi.mock('../src/main/services/settingsService', () => ({ getSettings: async () => ({ boards: { additionalUrls: mocks.urls } }) }))

const binary = process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli'
let service: typeof import('../src/main/services/arduinoCliService')
let oldResources: PropertyDescriptor | undefined

async function file(path: string): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true })
  await fs.writeFile(path, 'fixture')
}
function managed(): string {
  return join(mocks.root, 'board-tools', 'cli', '1.5.1', `${process.platform}-${process.arch}`, binary)
}
async function indexes(): Promise<void> {
  await file(join(mocks.root, 'board-tools', 'data', 'package_index.json'))
  await file(join(mocks.root, 'board-tools', 'data', 'library_index.json'))
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.root = await fs.mkdtemp(join(tmpdir(), 'cortex-cli-service-'))
  mocks.packaged = false
  mocks.urls = []
  oldResources = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { value: join(mocks.root, 'resources'), configurable: true })
  mocks.safeCommand.mockReturnValue(null)
  mocks.exec.mockImplementation(async (_command: string, args: string[]) => {
    if (args.includes('update-index')) await indexes()
    return { stdout: '', stderr: '' }
  })
  mocks.install.mockImplementation(async (target: string) => { await file(join(target, binary)) })
  service = await import('../src/main/services/arduinoCliService')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  if (oldResources) Object.defineProperty(process, 'resourcesPath', oldResources)
  else Reflect.deleteProperty(process, 'resourcesPath')
  await fs.rm(mocks.root, { recursive: true, force: true })
})

describe('Cortex-owned Arduino tool setup', () => {
  it('detection never downloads and refuses unresolved commands', async () => {
    expect(await service.getArduinoCli()).toBeNull()
    expect(await service.arduinoCliNeedsSetup()).toBe(true)
    expect(mocks.install).not.toHaveBeenCalled()
    expect(mocks.safeCommand).toHaveBeenCalledWith(binary, '/untrusted-project')
  })

  it('keeps an existing native PATH installation and its configuration', async () => {
    mocks.safeCommand.mockReturnValue('/external/arduino-cli')
    expect(await service.getArduinoCli()).toEqual({ command: '/external/arduino-cli', args: [], source: 'path' })
    expect(await service.arduinoCliNeedsSetup()).toBe(false)
    await service.setupArduinoCli()
    expect(mocks.install).not.toHaveBeenCalled()
    expect(mocks.exec).toHaveBeenCalledTimes(1)
  })

  it.each(['.cmd', '.bat'])('refuses shell shim %s', async (extension) => {
    mocks.safeCommand.mockReturnValue(`/external/arduino-cli${extension}`)
    expect(await service.getArduinoCli()).toBeNull()
  })

  it('prefers the packaged binary, then an owned download, before PATH', async () => {
    mocks.packaged = true
    const bundled = join(process.resourcesPath, 'arduino-cli', binary)
    await file(bundled)
    await file(managed())
    mocks.safeCommand.mockReturnValue('/external/arduino-cli')
    expect(await service.getArduinoCli()).toMatchObject({ command: bundled, source: 'bundled' })
    await fs.unlink(bundled)
    expect(await service.getArduinoCli()).toMatchObject({ command: managed(), source: 'managed' })
  })

  it('isolates managed directories and strips overriding Arduino environment variables', async () => {
    await file(managed())
    vi.stubEnv('ARDUINO_DIRECTORIES_DATA', '/external-data')
    vi.stubEnv('ARDUINO_CONFIG_FILE', '/external-config')
    vi.stubEnv('CORTEX_KEEP_TEST', 'yes')
    const cli = await service.getArduinoCli()
    expect(cli!.env).not.toHaveProperty('ARDUINO_DIRECTORIES_DATA')
    expect(cli!.env).not.toHaveProperty('ARDUINO_CONFIG_FILE')
    expect(cli!.env).toHaveProperty('CORTEX_KEEP_TEST', 'yes')
    const config = JSON.parse(await fs.readFile(cli!.args[1], 'utf8'))
    expect(config.directories).toEqual({
      data: join(mocks.root, 'board-tools', 'data'),
      downloads: join(mocks.root, 'board-tools', 'downloads'),
      user: join(mocks.root, 'board-tools', 'sketchbook')
    })
    expect(config.board_manager.additional_urls).toEqual([])
  })

  it('downloads once and bootstraps both catalogs for simultaneous callers', async () => {
    const first = vi.fn(), second = vi.fn()
    await Promise.all([service.setupArduinoCli(first), service.setupArduinoCli(second)])
    expect(mocks.install).toHaveBeenCalledTimes(1)
    expect(mocks.exec.mock.calls.map((call) => call[1].slice(2))).toEqual([
      ['version'], ['core', 'update-index'], ['lib', 'update-index']
    ])
    expect(first).toHaveBeenCalledWith(expect.stringContaining('ready'))
    expect(second).toHaveBeenCalledWith(expect.stringContaining('ready'))
    expect(await service.arduinoCliNeedsSetup()).toBe(false)
    for (const call of mocks.exec.mock.calls) {
      expect(call[2]).toMatchObject({ windowsHide: true, timeout: expect.any(Number), env: expect.any(Object) })
      expect(call[2].shell).not.toBe(true)
    }
  })

  it('uses bundled tools without downloading but prepares new profile indexes', async () => {
    mocks.packaged = true
    await file(join(process.resourcesPath, 'arduino-cli', binary))
    expect(await service.arduinoCliNeedsSetup()).toBe(true)
    await service.setupArduinoCli()
    expect(mocks.install).not.toHaveBeenCalled()
    expect(await service.arduinoCliNeedsSetup()).toBe(false)
  })

  it('skips catalog downloads when an owned profile is already ready', async () => {
    await file(managed())
    await indexes()
    await service.setupArduinoCli()
    expect(mocks.exec).toHaveBeenCalledTimes(1)
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('retries failed downloads without caching the failure', async () => {
    mocks.install.mockRejectedValueOnce(new Error('Offline'))
    await expect(service.setupArduinoCli()).rejects.toThrow('Offline')
    await service.setupArduinoCli()
    expect(mocks.install).toHaveBeenCalledTimes(2)
  })

  it('replaces an unusable external executable without changing PATH', async () => {
    mocks.safeCommand.mockReturnValue('/external/arduino-cli')
    mocks.exec.mockRejectedValueOnce(new Error('Broken executable'))
    await service.setupArduinoCli()
    expect(mocks.install).toHaveBeenCalledTimes(1)
    expect(await service.getArduinoCli()).toMatchObject({ source: 'managed' })
  })

  it('keeps official catalogs usable when an optional vendor refresh fails', async () => {
    mocks.urls = ['https://example.com/vendor.json']
    mocks.exec.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes('--additional-urls')) throw new Error('Vendor offline')
      if (args.includes('update-index')) await indexes()
      return { stdout: '', stderr: '' }
    })
    const progress = vi.fn()
    await service.setupArduinoCli(progress)
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('could not be refreshed'))
    expect(service.arduinoCliSetupHint()).toContain('could not be refreshed')
    service.clearArduinoCliSetupHint()
    expect(service.arduinoCliSetupHint()).toBeUndefined()
    expect(await service.arduinoCliNeedsSetup()).toBe(false)
  })

  it('rejects missing catalogs even if the subprocess claims success', async () => {
    mocks.exec.mockResolvedValue({ stdout: '', stderr: '' })
    await expect(service.setupArduinoCli()).rejects.toThrow('could not prepare')
  })
})
