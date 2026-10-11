import { app, safeStorage } from 'electron'
import { constants, promises as fs } from 'fs'
import { isUtf8 } from 'buffer'
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { DEFAULT_BOARD_URLS } from '../../shared/boardUrls'

export interface Settings {
  theme: 'dark' | 'light'
  defaultCppCompiler: string
  defaultCppStandard: string
  pythonPath: string
  ai: {
    provider: 'anthropic' | 'openai' | 'gemini' | 'local' | 'custom' | 'none'
    model: string
    apiKey: string // decrypted, main-process only. Never sent to the renderer.
    baseUrl: string
  }
  serial: {
    baudRate: number
  }
  boards: {
    /** Extra arduino-cli board-manager index URLs (the "Additional Boards
     *  Manager URLs" of the Arduino IDE). Without the ESP32/ESP8266 index here,
     *  arduino-cli cannot see or install those cores. */
    additionalUrls: string[]
  }
}

/** Renderer-facing settings: the raw key is redacted, replaced by a boolean. */
export interface PublicSettings extends Omit<Settings, 'ai'> {
  ai: Omit<Settings['ai'], 'apiKey'> & { apiKey: ''; apiKeySet: boolean }
}

const DEFAULTS: Settings = {
  theme: 'dark',
  // Empty means "whatever detection found", like ai.model below. 'g++' here was
  // a guess that behaved like an explicit user override: loadSettings applied it
  // unconditionally (it is truthy), so on a machine with clang++ and no g++ it
  // could overwrite the compiler detection had correctly chosen, and the sim
  // then failed with a bare "spawn g++ ENOENT".
  defaultCppCompiler: '',
  defaultCppStandard: 'c++23',
  pythonPath: 'python',
  // model is intentionally empty: a hardcoded Claude id was being POSTed to
  // Ollama the moment someone picked the local provider. aiService fills in a
  // per-provider default when this is blank.
  ai: { provider: 'none', model: '', apiKey: '', baseUrl: '' },
  serial: { baudRate: 115200 },
  // Pre-seeded so ESP32 works out of the box: an ESP32-focused IDE that could
  // not install the ESP32 core without the user first hunting down an index URL
  // was the single most common first-run wall in the audit.
  boards: { additionalUrls: [...DEFAULT_BOARD_URLS] }
}

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

let cached: Settings | null = null
let loading: Promise<Settings> | null = null
let pendingWrite: Promise<void> = Promise.resolve()

class SettingsError extends Error {}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function copySettings(settings: Settings): Settings {
  return { ...settings, ai: { ...settings.ai }, serial: { ...settings.serial }, boards: { additionalUrls: [...settings.boards.additionalUrls] } }
}

async function readSettingsText(path: string): Promise<string | null> {
  const bytes = await fs.readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (bytes === null) return null
  if (!isUtf8(bytes)) throw new SettingsError('Cannot save settings: settings.json is not valid UTF-8. Keep a copy and repair it before retrying.')
  return bytes.toString('utf8')
}

function parseStored(raw: string | null): Record<string, unknown> {
  if (raw === null) return {}
  let value: unknown
  try { value = JSON.parse(raw) } catch {
    throw new SettingsError('Cannot save settings: settings.json contains invalid JSON. Keep a copy and repair it before retrying.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SettingsError('Cannot save settings: settings.json must contain a JSON object.')
  return value as Record<string, unknown>
}

function decryptStored(stored: string, encrypted: boolean): string {
  if (!stored) return ''
  if (encrypted) {
    try {
      if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } catch {
      /* corrupt/unreadable ciphertext */
    }
    return ''
  }
  return stored
}

function isProvider(value: unknown): value is Settings['ai']['provider'] {
  return typeof value === 'string' && ['anthropic', 'openai', 'gemini', 'local', 'custom', 'none'].includes(value)
}

function fromStored(stored: Record<string, unknown>): Settings {
  const ai = record(stored.ai)
  const serial = record(stored.serial)
  const boards = record(stored.boards)
  const text = (value: unknown, fallback: string): string => typeof value === 'string' ? value : fallback
  let apiKey = decryptStored(text(ai.apiKeyStored, ''), ai.apiKeyEncrypted === true)
  // Older plaintext keys migrate on a successful save, never on a read.
  if (!apiKey && typeof ai.apiKey === 'string') apiKey = ai.apiKey
  return {
    theme: stored.theme === 'light' ? 'light' : DEFAULTS.theme,
    defaultCppCompiler: text(stored.defaultCppCompiler, DEFAULTS.defaultCppCompiler),
    defaultCppStandard: text(stored.defaultCppStandard, DEFAULTS.defaultCppStandard),
    pythonPath: text(stored.pythonPath, DEFAULTS.pythonPath),
    ai: { provider: isProvider(ai.provider) ? ai.provider : DEFAULTS.ai.provider, model: text(ai.model, DEFAULTS.ai.model), baseUrl: text(ai.baseUrl, DEFAULTS.ai.baseUrl), apiKey },
    serial: { baudRate: typeof serial.baudRate === 'number' && Number.isFinite(serial.baudRate) && serial.baudRate > 0 ? serial.baudRate : DEFAULTS.serial.baudRate },
    boards: { additionalUrls: Array.isArray(boards.additionalUrls) ? boards.additionalUrls.filter((value): value is string => typeof value === 'string') : [...DEFAULTS.boards.additionalUrls] }
  }
}

/** Full settings including the decrypted API key. Main-process use only. */
export async function getSettings(): Promise<Settings> {
  if (cached) return copySettings(cached)
  if (!loading) {
    loading = (async () => {
      let next = copySettings(DEFAULTS)
      try { next = fromStored(parseStored(await readSettingsText(settingsPath()))) } catch {
        /* Startup still works with an unreadable file; saves read strictly. */
      }
      cached = next
      return next
    })().finally(() => { loading = null })
  }
  return copySettings(await loading)
}

function publicSettings(settings: Settings): PublicSettings {
  const s = copySettings(settings)
  return { ...s, ai: { provider: s.ai.provider, model: s.ai.model, baseUrl: s.ai.baseUrl, apiKey: '', apiKeySet: !!s.ai.apiKey } }
}

/** Redacted settings for the renderer (never carries the raw key). */
export async function getPublicSettings(): Promise<PublicSettings> {
  return publicSettings(await getSettings())
}

type SettingsPatch = Omit<Partial<Settings>, 'ai' | 'serial' | 'boards'> & {
  ai?: Partial<Settings['ai']>
  serial?: Partial<Settings['serial']>
  boards?: Partial<Settings['boards']>
}

function capturePatch(patch: Partial<Settings>): SettingsPatch {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SettingsError('Cannot save settings: the update must be an object.')
  const next: SettingsPatch = {}
  if (patch.theme !== undefined) {
    if (patch.theme !== 'dark' && patch.theme !== 'light') throw new SettingsError('Cannot save settings: invalid theme.')
    next.theme = patch.theme
  }
  for (const key of ['defaultCppCompiler', 'defaultCppStandard', 'pythonPath'] as const) {
    if (patch[key] !== undefined) {
      if (typeof patch[key] !== 'string') throw new SettingsError('Cannot save settings: build paths and standards must be text.')
      next[key] = patch[key]
    }
  }
  if (patch.ai !== undefined) {
    if (!patch.ai || typeof patch.ai !== 'object' || Array.isArray(patch.ai)) throw new SettingsError('Cannot save settings: invalid AI settings.')
    next.ai = {}
    if (patch.ai.provider !== undefined) {
      if (!isProvider(patch.ai.provider)) throw new SettingsError('Cannot save settings: invalid AI provider.')
      next.ai.provider = patch.ai.provider
    }
    for (const key of ['model', 'baseUrl', 'apiKey'] as const) {
      if (patch.ai[key] !== undefined) {
        if (typeof patch.ai[key] !== 'string') throw new SettingsError('Cannot save settings: AI fields must be text.')
        next.ai[key] = patch.ai[key]
      }
    }
  }
  if (patch.serial !== undefined) {
    const value = patch.serial?.baudRate
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new SettingsError('Cannot save settings: invalid serial baud rate.')
    next.serial = { baudRate: value }
  }
  if (patch.boards !== undefined) {
    const urls = patch.boards?.additionalUrls
    if (!Array.isArray(urls) || urls.some((url) => typeof url !== 'string')) throw new SettingsError('Cannot save settings: board URLs must be a list of text values.')
    next.boards = { additionalUrls: [...urls] }
  }
  return next
}

async function writableSettingsPath(): Promise<string> {
  const target = settingsPath()
  const entry = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new SettingsError('Cannot save settings: settings.json must be a regular, unlinked file.')
  return target
}

async function persistSettings(patch: SettingsPatch): Promise<PublicSettings> {
  try {
    await getSettings()
    const target = await writableSettingsPath()
    const raw = await readSettingsText(target)
    const stored = parseStored(raw)
    const current = fromStored(stored)
    const ai = { ...current.ai, ...patch.ai }
    const incoming = patch.ai?.apiKey
    ai.apiKey = typeof incoming === 'string' && incoming.trim() !== '' ? incoming : current.ai.apiKey
    const next: Settings = { ...current, ...patch, ai, serial: { ...current.serial, ...patch.serial }, boards: { ...current.boards, ...patch.boards } }
    const persistedAi: Record<string, unknown> = { ...record(stored.ai), provider: ai.provider, model: ai.model, baseUrl: ai.baseUrl }
    if (ai.apiKey) {
      if (safeStorage.isEncryptionAvailable()) {
        persistedAi.apiKeyStored = safeStorage.encryptString(ai.apiKey).toString('base64')
        persistedAi.apiKeyEncrypted = true
      } else {
        // Retain the existing best-effort policy when no OS keyring is available.
        persistedAi.apiKeyStored = ai.apiKey
        persistedAi.apiKeyEncrypted = false
      }
      delete persistedAi.apiKey
    }
    // If a stored credential cannot be decrypted, an unrelated save keeps its bytes.
    const persisted = { ...stored, ...next, ai: persistedAi, serial: { ...record(stored.serial), ...next.serial }, boards: { ...record(stored.boards), ...next.boards } }
    const previous = await fs.stat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (previous) await fs.access(target, constants.W_OK)
    const mode = previous ? previous.mode & 0o777 : 0o600
    const staged = join(dirname(target), `.settings.json.cortex-save-${randomUUID()}`)
    const handle = await fs.open(staged, 'wx', mode)
    let committed = false
    try {
      await handle.writeFile(JSON.stringify(persisted, null, 2), 'utf8')
      await handle.sync()
      await handle.close()
      if (previous) await fs.chmod(staged, mode)
      if (await writableSettingsPath() !== target) throw new SettingsError('Cannot save settings: the settings path changed during the save.')
      if (await readSettingsText(target) !== raw) throw new SettingsError('Settings changed on disk during the save. Review settings.json before retrying.')
      await fs.rename(staged, target)
      committed = true
      cached = copySettings(next)
      return publicSettings(next)
    } finally {
      await handle.close().catch(() => {})
      if (!committed) await fs.unlink(staged).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
    }
  } catch (error) {
    if (error instanceof SettingsError) throw error
    throw new SettingsError('Cannot save settings.json. Check file permissions, available disk space and the OS keyring, then retry.')
  }
}

export async function setSettings(patch: Partial<Settings>): Promise<PublicSettings> {
  const owned = capturePatch(patch)
  const task = pendingWrite.then(() => persistSettings(owned))
  pendingWrite = task.then(() => {}, () => {})
  return task
}
