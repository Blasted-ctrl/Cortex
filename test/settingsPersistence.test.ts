import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Settings } from '../src/main/services/settingsService'

const electron = vi.hoisted(() => ({
  root: '',
  available: true,
  encrypt: vi.fn((value: string) => Buffer.from(`sealed:${value}`)),
  decrypt: vi.fn((value: Buffer) => {
    const text = value.toString()
    if (!text.startsWith('sealed:')) throw new Error('Unreadable fixture ciphertext')
    return text.slice(7)
  })
}))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => {
    if (name !== 'userData') throw new Error('Unexpected Electron path')
    return electron.root
  } },
  safeStorage: {
    isEncryptionAvailable: () => electron.available,
    encryptString: electron.encrypt,
    decryptString: electron.decrypt
  }
}))

const KEY = 'settings-test-only-key'
const original = {
  theme: 'dark', defaultCppCompiler: '', defaultCppStandard: 'c++23', pythonPath: 'python',
  ai: { provider: 'openai', model: 'initial-model', baseUrl: '', apiKeyStored: KEY, apiKeyEncrypted: false, futureAiField: 'keep' },
  serial: { baudRate: 115200, futureSerialField: true },
  boards: { additionalUrls: ['https://example.invalid/index.json'], futureBoardField: true },
  futureSetting: { retained: true }
}
let fixture: string
let path: string
let service: typeof import('../src/main/services/settingsService')

beforeEach(async () => {
  vi.resetModules()
  vi.restoreAllMocks()
  electron.available = true
  electron.encrypt.mockReset().mockImplementation((value: string) => Buffer.from(`sealed:${value}`))
  electron.decrypt.mockReset().mockImplementation((value: Buffer) => {
    const text = value.toString()
    if (!text.startsWith('sealed:')) throw new Error('Unreadable fixture ciphertext')
    return text.slice(7)
  })
  fixture = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'cortex-settings-save-')))
  electron.root = fixture
  path = join(fixture, 'settings.json')
  await fs.writeFile(path, JSON.stringify(original), { mode: 0o600 })
  service = await import('../src/main/services/settingsService')
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture, { recursive: true, force: true })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function pauseNextWrite() {
  const entered = deferred()
  const held = deferred()
  let paused = false
  const pause = async (): Promise<void> => {
    if (paused) return
    paused = true
    entered.resolve()
    await held.promise
  }
  const write = fs.writeFile.bind(fs)
  const open = fs.open.bind(fs)
  vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
    if (String(args[0]) === path) await pause()
    return write(...args)
  })
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (basename(String(args[0])).startsWith('.settings.json.cortex-save-')) {
      const writeHandle = handle.writeFile.bind(handle)
      vi.spyOn(handle, 'writeFile').mockImplementation(async (...values) => {
        await pause()
        return writeHandle(...values)
      })
    }
    return handle
  })
  return { entered: entered.promise, release: held.resolve }
}

describe('actual settings persistence', () => {
  it('serializes independent and nested patches without losing either update', async () => {
    await service.getSettings()
    const ai = { ...original.ai, model: 'new-model', apiKey: '' } as Settings['ai']
    await Promise.all([service.setSettings({ theme: 'light' }), service.setSettings({ ai })])
    const saved = JSON.parse(await fs.readFile(path, 'utf8'))
    expect(saved.theme).toBe('light')
    expect(saved.ai.model).toBe('new-model')
    expect((await service.getSettings()).theme).toBe('light')
  })

  it('returns each operation own committed snapshot and keeps same-field invocation order', async () => {
    await service.getSettings()
    const [first, second] = await Promise.all([
      service.setSettings({ pythonPath: 'first-python' }),
      service.setSettings({ pythonPath: 'second-python' })
    ])
    expect(first.pythonPath).toBe('first-python')
    expect(second.pythonPath).toBe('second-python')
    expect(JSON.parse(await fs.readFile(path, 'utf8')).pythonPath).toBe('second-python')
  })

  it('keeps reads at the committed state while a new save is staging', async () => {
    const committed = await service.getPublicSettings()
    const held = pauseNextWrite()
    const saving = service.setSettings({ theme: 'light' })
    try {
      await held.entered
      expect(await service.getPublicSettings()).toEqual(committed)
      expect(JSON.parse(await fs.readFile(path, 'utf8')).theme).toBe('dark')
    } finally {
      held.release()
      await saving
    }
    expect((await service.getPublicSettings()).theme).toBe('light')
  })

  it('owns the queued patch and nested URL array from the invocation boundary', async () => {
    await service.getSettings()
    const held = pauseNextWrite()
    const first = service.setSettings({ theme: 'light' })
    let second: Promise<unknown> | undefined
    try {
      await held.entered
      const ai = { provider: 'openai', model: 'submitted-model', baseUrl: '', apiKey: '' } as Settings['ai']
      const urls = ['https://example.invalid/submitted.json']
      const patch = { ai, boards: { additionalUrls: urls } }
      second = service.setSettings(patch)
      ai.model = 'mutated-after-submit'
      urls.push('https://example.invalid/not-submitted.json')
    } finally {
      held.release()
      await Promise.all([first, second])
    }
    const saved = JSON.parse(await fs.readFile(path, 'utf8'))
    expect(saved.theme).toBe('light')
    expect(saved.ai.model).toBe('submitted-model')
    expect(saved.boards.additionalUrls).toEqual(['https://example.invalid/submitted.json'])
  })

  it('shares cold initialization across getters and writers without an old read replacing a commit', async () => {
    const read = fs.readFile.bind(fs)
    const held = deferred()
    const entered = deferred()
    let reads = 0
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      if (String(args[0]) === path) {
        ++reads
        const value = await read(...args)
        if (reads === 1) { entered.resolve(); await held.promise }
        return value
      }
      return read(...args)
    })
    const first = service.getSettings()
    await entered.promise
    const second = service.getPublicSettings()
    const saving = service.setSettings({ theme: 'light' })
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(reads).toBe(1)
    } finally {
      held.resolve()
      await Promise.all([first, second, saving])
    }
    expect((await service.getSettings()).theme).toBe('light')
    expect(JSON.parse(await read(path, 'utf8')).theme).toBe('light')
  })

  it.each(['partial write', 'sync', 'rename', 'encryption'] as const)('preserves disk and cache after %s failure, then recovers the queue', async (failure) => {
    const before = await fs.readFile(path, 'utf8')
    const committed = await service.getPublicSettings()
    const injected = new Error(`Fixture ${failure} failed with ${KEY}`)
    if (failure === 'encryption') electron.encrypt.mockImplementationOnce(() => { throw injected })
    else if (failure === 'rename') vi.spyOn(fs, 'rename').mockRejectedValueOnce(injected)
    else {
      const open = fs.open.bind(fs)
      vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
        const handle = await open(...args)
        if (basename(String(args[0])).startsWith('.settings.json.cortex-save-')) {
          if (failure === 'sync') vi.spyOn(handle, 'sync').mockRejectedValueOnce(injected)
          else {
            const write = handle.writeFile.bind(handle)
            vi.spyOn(handle, 'writeFile').mockImplementationOnce(async () => { await write('{partial', 'utf8'); throw injected })
          }
        }
        return handle
      })
      if (failure === 'partial write') {
        const write = fs.writeFile.bind(fs)
        vi.spyOn(fs, 'writeFile').mockImplementationOnce(async (...args) => { await write(path, '{partial', 'utf8'); throw injected })
      }
    }
    const rejected = service.setSettings({ theme: 'light' }).catch((error: Error) => error)
    const error = await rejected
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(KEY)
    expect(await fs.readFile(path, 'utf8')).toBe(before)
    expect(await service.getPublicSettings()).toEqual(committed)
    expect(await fs.readdir(fixture)).toEqual(['settings.json'])
    vi.restoreAllMocks()
    await service.setSettings({ pythonPath: 'recovered-python' })
    expect((await service.getPublicSettings()).theme).toBe('dark')
    expect(JSON.parse(await fs.readFile(path, 'utf8')).pythonPath).toBe('recovered-python')
  })

  it('allows the next already queued update after a failed save without inheriting its patch', async () => {
    await service.getSettings()
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('Locked fixture file'))
    const [first, second] = await Promise.allSettled([
      service.setSettings({ theme: 'light' }),
      service.setSettings({ pythonPath: 'recovered-python' })
    ])
    expect(first.status).toBe('rejected')
    expect(second.status).toBe('fulfilled')
    expect((await service.getPublicSettings()).theme).toBe('dark')
    expect(JSON.parse(await fs.readFile(path, 'utf8')).pythonPath).toBe('recovered-python')
  })

  it.each([
    ['null update', null],
    ['array update', []],
    ['unsupported theme', { theme: 'fixture-invalid-theme' }],
    ['nontext build field', { pythonPath: 42 }],
    ['null AI settings', { ai: null }],
    ['array AI settings', { ai: [] }],
    ['unsupported AI provider', { ai: { provider: 'fixture-invalid-provider' } }],
    ['nontext AI field', { ai: { apiKey: { privateValue: KEY } } }],
    ['nonnumber baud rate', { serial: { baudRate: '115200' } }],
    ['nonfinite baud rate', { serial: { baudRate: Number.NaN } }],
    ['nonpositive baud rate', { serial: { baudRate: 0 } }],
    ['nonlist board URLs', { boards: { additionalUrls: 'https://example.invalid/index.json' } }],
    ['nontext board URL', { boards: { additionalUrls: [42] } }]
  ])('rejects %s without changing committed settings and accepts the next valid update', async (_name, patch) => {
    const before = await fs.readFile(path)
    const committed = await service.getSettings()
    const publicSettings = await service.getPublicSettings()
    const error = await service.setSettings(patch as Partial<Settings>).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toMatch(/settings/i)
    expect(String(error)).not.toContain(KEY)
    expect(await fs.readFile(path)).toEqual(before)
    expect(await service.getSettings()).toEqual(committed)
    expect(await service.getPublicSettings()).toEqual(publicSettings)
    expect(await fs.readdir(fixture)).toEqual(['settings.json'])

    const recovered = await service.setSettings({ pythonPath: 'recovered-python' })
    expect(recovered).toEqual({ ...publicSettings, pythonPath: 'recovered-python' })
    expect(await service.getSettings()).toEqual({ ...committed, pythonPath: 'recovered-python' })
    expect(JSON.parse(await fs.readFile(path, 'utf8')).pythonPath).toBe('recovered-python')
    expect(await fs.readdir(fixture)).toEqual(['settings.json'])
  })

  it.each(['{unfinished', '[]', 'null', '42', Buffer.from([0xff, 0xfe])])('keeps startup fallback but refuses to replace malformed existing bytes %j', async (bytes) => {
    await fs.writeFile(path, bytes)
    const before = await fs.readFile(path)
    expect((await service.getPublicSettings()).theme).toBe('dark')
    await expect(service.setSettings({ theme: 'light' })).rejects.toThrow(/settings/i)
    expect(await fs.readFile(path)).toEqual(before)
    expect(await fs.readdir(fixture)).toEqual(['settings.json'])
  })

  it('does not overwrite unreadable existing settings and can recover once access returns', async () => {
    const before = await fs.readFile(path, 'utf8')
    const failure = Object.assign(new Error(`Denied fixture ${KEY}`), { code: 'EACCES' })
    vi.spyOn(fs, 'readFile').mockRejectedValue(failure)
    expect((await service.getPublicSettings()).theme).toBe('dark')
    const error = await service.setSettings({ theme: 'light' }).catch((value: Error) => value)
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toContain(KEY)
    vi.restoreAllMocks()
    expect(await fs.readFile(path, 'utf8')).toBe(before)
    await service.setSettings({ pythonPath: 'recovered-python' })
    expect((await service.getSettings()).ai.apiKey).toBe(KEY)
    expect((await service.getPublicSettings()).theme).toBe('dark')
  })

  it('refuses an external update during staging instead of overwriting it', async () => {
    const committed = await service.getPublicSettings()
    const held = pauseNextWrite()
    const saving = service.setSettings({ theme: 'light' }).catch((error: Error) => error)
    const external = JSON.stringify({ ...original, pythonPath: 'external-python' })
    try {
      await held.entered
      await fs.writeFile(path, external, 'utf8')
    } finally { held.release() }
    expect(await saving).toBeInstanceOf(Error)
    expect(await fs.readFile(path, 'utf8')).toBe(external)
    expect(await service.getPublicSettings()).toEqual(committed)
    expect(await fs.readdir(fixture)).toEqual(['settings.json'])
  })

  it('preserves unknown disk fields and merges an external update present before staging', async () => {
    await service.getSettings()
    await fs.writeFile(path, JSON.stringify({ ...original, pythonPath: 'external-python' }))
    await service.setSettings({ theme: 'light' })
    const saved = JSON.parse(await fs.readFile(path, 'utf8'))
    expect(saved.pythonPath).toBe('external-python')
    expect(saved.futureSetting).toEqual({ retained: true })
    expect(saved.ai.futureAiField).toBe('keep')
    expect(saved.serial.futureSerialField).toBe(true)
    expect(saved.boards.futureBoardField).toBe(true)
    expect((await service.getPublicSettings()).pythonPath).toBe('external-python')
  })

  it.each([true, false])('keeps the existing encryption policy (available=%s) and blank-key preservation', async (available) => {
    electron.available = available
    const first = await service.setSettings({ theme: 'light' })
    expect(first.ai).toMatchObject({ apiKey: '', apiKeySet: true })
    const saved = JSON.parse(await fs.readFile(path, 'utf8'))
    expect(saved.ai.apiKeyEncrypted).toBe(available)
    expect(saved.ai.apiKeyStored).toBe(available ? Buffer.from(`sealed:${KEY}`).toString('base64') : KEY)
    const ai = { ...original.ai, model: 'second-model', apiKey: '  ' } as Settings['ai']
    await service.setSettings({ ai })
    expect((await service.getSettings()).ai.apiKey).toBe(KEY)
    expect((await service.getPublicSettings()).ai.apiKey).toBe('')
  })

  it('migrates a legacy plaintext key without leaking it in public responses', async () => {
    await fs.writeFile(path, JSON.stringify({ ...original, ai: { provider: 'openai', apiKey: KEY } }))
    expect((await service.getSettings()).ai.apiKey).toBe(KEY)
    const response = await service.setSettings({ theme: 'light' })
    const saved = JSON.parse(await fs.readFile(path, 'utf8'))
    expect(saved.ai.apiKey).toBeUndefined()
    expect(saved.ai.apiKeyEncrypted).toBe(true)
    expect(JSON.stringify(response)).not.toContain(KEY)
  })

  it.each(['unavailable keyring', 'unreadable ciphertext'])('preserves stored credential bytes during an unrelated save with %s', async (failure) => {
    const ai = { ...original.ai, apiKeyStored: 'unreadable-fixture-ciphertext', apiKeyEncrypted: true }
    await fs.writeFile(path, JSON.stringify({ ...original, ai }))
    if (failure === 'unavailable keyring') electron.available = false
    const response = await service.setSettings({ theme: 'light' })
    expect(response.theme).toBe('light')
    expect(response.ai.apiKey).toBe('')
    const saved = JSON.parse(await fs.readFile(path, 'utf8'))
    expect(saved.ai.apiKeyStored).toBe(ai.apiKeyStored)
    expect(saved.ai.apiKeyEncrypted).toBe(true)
    expect(saved.ai.futureAiField).toBe('keep')
  })

  it('redacts unknown incoming credential fields and owns public/main nested snapshots', async () => {
    const response = await service.setSettings({ theme: 'light', unexpectedKey: KEY } as Partial<Settings>)
    expect(JSON.stringify(response)).not.toContain(KEY)
    const publicSettings = await service.getPublicSettings()
    publicSettings.boards.additionalUrls.push('https://example.invalid/not-saved.json')
    publicSettings.serial.baudRate = 1
    const full = await service.getSettings()
    full.ai.apiKey = 'mutated-not-saved'
    expect((await service.getSettings()).ai.apiKey).toBe(KEY)
    expect((await service.getPublicSettings()).boards.additionalUrls).toEqual(original.boards.additionalUrls)
    expect((await service.getPublicSettings()).serial.baudRate).toBe(115200)
  })

  it('creates a missing file with restrictive requested permissions and no staging leftovers', async () => {
    await fs.unlink(path)
    const open = vi.spyOn(fs, 'open')
    await service.setSettings({ theme: 'light' })
    expect(JSON.parse(await fs.readFile(path, 'utf8')).theme).toBe('light')
    const staging = open.mock.calls.find((args) => basename(String(args[0])).startsWith('.settings.json.cortex-save-'))
    expect(staging?.[1]).toBe('wx')
    expect(staging?.[2]).toBe(0o600)
    if (process.platform !== 'win32') expect((await fs.stat(path)).mode & 0o777).toBe(0o600)
    expect(await fs.readdir(fixture)).toEqual(['settings.json'])
  })

  it('preserves existing permissions when replacing the file', async () => {
    await fs.chmod(path, 0o600)
    const mode = (await fs.stat(path)).mode & 0o777
    await service.setSettings({ theme: 'light' })
    expect((await fs.stat(path)).mode & 0o777).toBe(mode)
  })

  it('refuses a linked settings entry without changing its external target', async () => {
    const outside = join(fixture, 'outside')
    await fs.mkdir(outside)
    const external = join(outside, 'settings.json')
    const before = JSON.stringify(original)
    await fs.writeFile(external, before)
    await fs.unlink(path)
    await fs.symlink(outside, path, 'junction')
    await expect(service.setSettings({ theme: 'light' })).rejects.toThrow(/settings/i)
    expect(await fs.readFile(external, 'utf8')).toBe(before)
    expect((await fs.lstat(path)).isSymbolicLink()).toBe(true)
  })
})
