import { spawn, execFile, ChildProcess } from 'child_process'
import { promisify } from 'util'
import type { BrowserWindow } from 'electron'
import type { CorePlatform, LibPackage, PackageInstallRequest } from '../../shared/ipc'
import * as runner from './runnerService'
import { getSettings } from './settingsService'
import { buildAdditionalUrlArgs } from '../../shared/boardUrls'
import { getArduinoCli, clearArduinoCliSetupHint } from './arduinoCliService'

const execFileAsync = promisify(execFile)
const CLI = 'arduino-cli'

async function readCli(args: string[], timeout: number, maxBuffer = 1 << 24): Promise<string> {
  const cli = await getArduinoCli()
  if (!cli) throw new Error('Board tools are not ready. Use Set up board tools in Cortex and retry.')
  const { stdout } = await execFileAsync(cli.command, [...cli.args, ...args], { timeout, windowsHide: true, maxBuffer, env: cli.env })
  return stdout.toString()
}

async function additionalUrlArgs(): Promise<string[]> {
  try {
    return buildAdditionalUrlArgs((await getSettings()).boards.additionalUrls)
  } catch {
    return []
  }
}

// arduino-cli runs without a daemon here, so every call re-reads the package
// index from disk: a search takes ~13s on its own and longer while a concurrent
// `list` is in flight. The old 20s/15s budgets silently timed out into an empty
// result, which the UI showed as "No cores found" on a query that does match.
const SEARCH_TIMEOUT = 90000
const LIST_TIMEOUT = 60000

// arduino-cli's JSON shape drifts across versions (bare arrays in 0.x, keyed
// objects in 1.x), so everything below reads defensively.

interface RawRelease {
  version?: string
  name?: string
  boards?: { name?: string }[]
}
interface RawPlatform {
  id?: string
  ID?: string
  name?: string
  Name?: string
  installed_version?: string
  Installed?: string
  latest_version?: string
  Latest?: string
  releases?: Record<string, RawRelease>
  boards?: { name?: string }[]
  Boards?: { name?: string }[]
  maintainer?: string
  Maintainer?: string
  metadata?: { maintainer?: string; website?: string; deprecated?: boolean }
  deprecated?: boolean
}

function sortVersionsDesc(versions: string[]): string[] {
  const cmp = (a: string, b: string): number => {
    const pa = a.split(/[.\-+]/).map((n) => parseInt(n, 10))
    const pb = b.split(/[.\-+]/).map((n) => parseInt(n, 10))
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      // A non-numeric segment (rc1, beta) is a prerelease; a numeric release
      // ranks above it. Do not pre-coerce NaN to 0 or this never triggers.
      const da = pa[i]
      const db = pb[i]
      const na = Number.isNaN(da)
      const nb = Number.isNaN(db)
      if (na !== nb) return na ? 1 : -1
      if (na && nb) {
        if (a !== b) return a < b ? 1 : -1
        continue
      }
      const va = da ?? 0
      const vb = db ?? 0
      if (va !== vb) return vb - va
    }
    return 0
  }
  return [...new Set(versions)].sort(cmp)
}

function normalizePlatform(p: RawPlatform): CorePlatform | null {
  const id = p.id ?? p.ID
  if (!id) return null
  const latest = p.latest_version ?? p.Latest ?? ''
  const installed = p.installed_version ?? p.Installed ?? ''
  const releaseVersions = p.releases ? Object.keys(p.releases) : []
  const versions = sortVersionsDesc(releaseVersions.length ? releaseVersions : [latest].filter(Boolean))
  // Board names come from the installed release, else the latest, else any.
  const rel = p.releases?.[installed] ?? p.releases?.[latest] ?? Object.values(p.releases ?? {})[0]
  const boardsRaw = rel?.boards ?? p.boards ?? p.Boards ?? []
  const boards = boardsRaw.map((b) => b.name).filter((n): n is string => !!n)
  return {
    id,
    // arduino-cli 1.x carries the display name ("Arduino ESP32 Boards") on the
    // release, not the platform, so prefer that over falling back to the raw id.
    name: p.name ?? p.Name ?? rel?.name ?? id,
    maintainer: p.metadata?.maintainer ?? p.maintainer ?? p.Maintainer,
    installedVersion: installed,
    latestVersion: latest || versions[0] || '',
    versions,
    boards,
    deprecated: p.metadata?.deprecated ?? p.deprecated
  }
}

function safeMap<T, R>(list: T[], fn: (x: T) => R | null): R[] {
  // Guard per element so one malformed row does not discard the whole list.
  const out: R[] = []
  for (const x of list) {
    try {
      const r = fn(x)
      if (r !== null) out.push(r)
    } catch {
      /* skip the bad entry */
    }
  }
  return out
}

function readPlatforms(stdout: string): CorePlatform[] {
  try {
    const parsed = JSON.parse(stdout || '{}')
    const list: RawPlatform[] = Array.isArray(parsed) ? parsed : (parsed.platforms ?? [])
    return safeMap(list, normalizePlatform)
  } catch {
    return []
  }
}

/** Search installable cores (empty query lists the whole index). The vendor
 *  index URLs are what make third-party cores (esp32, esp8266) show up here. */
export async function coreSearch(query: string): Promise<CorePlatform[]> {
  const base = ['core', 'search', ...(query ? [query] : [])]
  const extra = await additionalUrlArgs()
  const run = async (args: string[]): Promise<CorePlatform[]> => {
    const stdout = await readCli([...args, '--format', 'json'], SEARCH_TIMEOUT)
    return readPlatforms(stdout)
  }
  try {
    return await run([...base, ...extra])
  } catch {
    // arduino-cli aborts the ENTIRE search when any additional index cannot be
    // downloaded or read (offline, or a wrong URL), dropping even the built-in
    // cores. Retry without the extra URLs so the built-in cores still list,
    // rather than showing an empty "No cores found" for every query.
    if (extra.length === 0) return []
    try {
      return await run(base)
    } catch {
      return []
    }
  }
}

/** Installed cores (so the UI can show version + a Remove action). */
export async function coreInstalled(): Promise<CorePlatform[]> {
  try {
    const args = ['core', 'list', ...(await additionalUrlArgs()), '--format', 'json']
    const stdout = await readCli(args, LIST_TIMEOUT)
    return readPlatforms(stdout)
  } catch {
    return []
  }
}

// ---- Libraries -------------------------------------------------------------

interface RawLibRelease {
  version?: string
  author?: string
  sentence?: string
  website?: string
}
interface RawLib {
  name?: string
  Name?: string
  latest?: RawLibRelease
  available_versions?: string[]
  releases?: Record<string, RawLibRelease>
  author?: string
  sentence?: string
  website?: string
  version?: string
  library?: {
    name?: string
    version?: string
    author?: string
    sentence?: string
    website?: string
    provides_includes?: string[]
    architectures?: string[]
  }
}

function normalizeLib(l: RawLib): LibPackage | null {
  // `lib list` nests the record under `library`; `lib search` is flat.
  const lib = l.library ?? l
  const name = lib.name ?? l.Name
  if (!name) return null
  const latestRel = l.latest ?? {}
  const versionsRaw = l.available_versions ?? (l.releases ? Object.keys(l.releases) : [])
  const versions = sortVersionsDesc(versionsRaw)
  // provides_includes / architectures only appear on `lib list` (installed).
  const provides = Array.isArray(l.library?.provides_includes)
    ? l.library!.provides_includes.filter((h): h is string => typeof h === 'string')
    : undefined
  const archs = Array.isArray(l.library?.architectures)
    ? l.library!.architectures.filter((a): a is string => typeof a === 'string')
    : undefined
  return {
    name,
    author: latestRel.author ?? lib.author,
    sentence: latestRel.sentence ?? lib.sentence,
    installedVersion: l.library?.version ?? '',
    latestVersion: latestRel.version ?? versions[0] ?? lib.version ?? '',
    versions,
    website: latestRel.website ?? lib.website,
    providesIncludes: provides,
    architectures: archs
  }
}

export async function libSearch(query: string): Promise<LibPackage[]> {
  try {
    const args = ['lib', 'search', ...(query ? [query] : []), '--format', 'json']
    const stdout = await readCli(args, SEARCH_TIMEOUT, 1 << 25)
    const parsed = JSON.parse(stdout || '{}')
    const list: RawLib[] = parsed.libraries ?? (Array.isArray(parsed) ? parsed : [])
    return safeMap(list, normalizeLib)
  } catch {
    return []
  }
}

export async function libInstalled(): Promise<LibPackage[]> {
  try {
    const stdout = await readCli(['lib', 'list', '--format', 'json'], LIST_TIMEOUT)
    const parsed = JSON.parse(stdout || '{}')
    const list: RawLib[] = parsed.installed_libraries ?? []
    return safeMap(list, normalizeLib)
  } catch {
    return []
  }
}

// ---- streamed operations (install / uninstall / update-index) --------------

// Notified when a streamed package op finishes (install/uninstall/update-index),
// i.e. when the installed set may have changed on disk. Wired by main/index.ts
// to environmentService.invalidate so the dependency cache is dropped exactly at
// completion, not at op start. A callback (not an import) keeps packageService
// free of a dependency cycle with environmentService.
let onPackagesChanged: (() => void) | null = null
export function setOnPackagesChanged(cb: () => void): void {
  onPackagesChanged = cb
}

/** Run an arduino-cli command, streaming its output to the Output panel. */
async function stream(win: BrowserWindow, id: string, argsSource: string[] | (() => Promise<string[]>)): Promise<void> {
  const cancellation = runner.beginRunStart(id)
  if (!cancellation) return
  const start = performance.now()
  let args: string[]
  let proc: ChildProcess
  try {
    if (runner.runStartCancelled(win, id, cancellation, 'run')) return
    args = typeof argsSource === 'function' ? await argsSource() : argsSource
    if (runner.runStartCancelled(win, id, cancellation, 'run')) return
    runner.sendRunOutput(win, id, 'system', `$ ${CLI} ${args.join(' ')}\n`)
    const cli = await getArduinoCli()
    if (runner.runStartCancelled(win, id, cancellation, 'run')) return
    if (!cli) throw new Error('Board tools are not ready. Use Set up board tools in Cortex and retry.')
    proc = spawn(cli.command, [...cli.args, ...args], { windowsHide: true, env: cli.env })
    // Decode UTF-8 across chunk boundaries (see runnerService).
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    runner.trackProcess(id, proc)
  } catch (err) {
    if (runner.runStartCancelled(win, id, cancellation, 'run')) return
    runner.sendRunOutput(win, id, 'stderr', `Failed to launch ${CLI}: ${String(err)}\n`)
    runner.sendRunExit(win, { id, code: 127, signal: null, durationMs: 0, phase: 'run' })
    return
  } finally {
    runner.finishRunStart(id, cancellation)
  }
  proc.stdin?.on('error', () => {})
  proc.stdout?.on('data', (d) => runner.sendRunOutput(win, id, 'stdout', d.toString()))
  // arduino-cli reports download/compile progress on stderr; it is normal output.
  proc.stderr?.on('data', (d) => runner.sendRunOutput(win, id, 'stdout', d.toString()))
  proc.on('error', (err) => runner.sendRunOutput(win, id, 'stderr', `${String(err)}\n`))
  proc.on('close', (code, signal) => {
    runner.untrackProcess(id)
    const durationMs = Math.round(performance.now() - start)
    if (code === 0) {
      if (args[0] === 'core' && args[1] === 'update-index') clearArduinoCliSetupHint()
      runner.sendRunOutput(win, id, 'system', `Done in ${durationMs}ms\n`)
    }
    runner.sendRunExit(win, { id, code, signal, durationMs, phase: 'run' })
    // The installed package set may have changed; let the environment cache know.
    onPackagesChanged?.()
  })
}

export async function coreInstall(win: BrowserWindow, req: PackageInstallRequest): Promise<void> {
  const target = req.version ? `${req.name}@${req.version}` : req.name
  // The vendor URLs must be present here too, or installing esp32:esp32 fails
  // with "platform not found" even after it appeared in search.
  await stream(win, req.id, async () => ['core', 'install', ...(await additionalUrlArgs()), '--', target])
}
export async function coreUninstall(win: BrowserWindow, id: string, coreId: string): Promise<void> {
  await stream(win, id, ['core', 'uninstall', '--', coreId])
}
export async function coreUpdateIndex(win: BrowserWindow, id: string): Promise<void> {
  // This is the call that actually fetches the espressif/esp8266 indexes named
  // by the additional URLs, so those cores become searchable and installable.
  await stream(win, id, async () => ['core', 'update-index', ...(await additionalUrlArgs())])
}
export async function libInstall(win: BrowserWindow, req: PackageInstallRequest): Promise<void> {
  const target = req.version ? `${req.name}@${req.version}` : req.name
  await stream(win, req.id, ['lib', 'install', '--', target])
}
export async function libUninstall(win: BrowserWindow, id: string, name: string): Promise<void> {
  await stream(win, id, ['lib', 'uninstall', '--', name])
}
