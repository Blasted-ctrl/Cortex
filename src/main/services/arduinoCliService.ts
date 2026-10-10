import { app } from 'electron'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { join, extname } from 'path'
import { promisify } from 'util'
import { ARDUINO_CLI_VERSION } from '../../shared/arduinoCliRelease'
import { buildAdditionalUrlArgs } from '../../shared/boardUrls'
import { safeCommand } from './commandResolver'
import { getWorkspaceRoot } from './fsService'
import { getSettings } from './settingsService'
import { installArduinoCli } from './arduinoCliInstall'

export interface ArduinoCli {
  command: string
  args: string[]
  source: 'bundled' | 'managed' | 'path'
  env?: NodeJS.ProcessEnv
}

const execFileAsync = promisify(execFile)
const rejectedCommands = new Set<string>()
let configPending: Promise<string> | undefined
let setupPending: Promise<void> | undefined
const listeners = new Set<(message: string) => void>()
let setupHint: string | undefined

export function arduinoCliSetupHint(): string | undefined { return setupHint }
export function clearArduinoCliSetupHint(): void { setupHint = undefined }

function toolsRoot(): string {
  return join(app.getPath('userData'), 'board-tools')
}

function managedDirectory(): string {
  return join(toolsRoot(), 'cli', ARDUINO_CLI_VERSION, `${process.platform}-${process.arch}`)
}

async function isFile(path: string): Promise<boolean> {
  try { return (await fs.stat(path)).isFile() } catch { return false }
}

async function configFile(): Promise<string> {
  if (!configPending) {
    configPending = (async () => {
      const root = toolsRoot()
      for (const dir of ['data', 'downloads', 'sketchbook', 'build-cache']) {
        await fs.mkdir(join(root, dir), { recursive: true, mode: 0o700 })
      }
      const path = join(root, 'arduino-cli.json')
      // Do not import a system Arduino config or user sketchbook. Vendor URLs
      // are supplied explicitly by packageService; bootstrap always works with
      // the official base indexes even when an optional vendor is offline.
      await fs.writeFile(path, JSON.stringify({
        directories: { data: join(root, 'data'), downloads: join(root, 'downloads'), user: join(root, 'sketchbook') },
        build_cache: { path: join(root, 'build-cache') },
        board_manager: { additional_urls: [] },
        metrics: { enabled: false },
        updater: { enable_notification: false },
        network: { connection_timeout: '60s' }
      }, null, 2), { mode: 0o600 })
      return path
    })().catch((error) => { configPending = undefined; throw error })
  }
  return configPending
}

async function ownedCli(command: string, source: 'bundled' | 'managed'): Promise<ArduinoCli> {
  // Environment settings take priority over --config-file in Arduino CLI.
  // Scrub them so another Arduino installation cannot redirect owned writes.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('ARDUINO_')))
  return { command, source, args: ['--config-file', await configFile()], env }
}

/** Resolve only. Downloads happen in setupArduinoCli, never during detection. */
export async function getArduinoCli(): Promise<ArduinoCli | null> {
  const binary = process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli'
  if (app.isPackaged) {
    const bundled = join(process.resourcesPath, 'arduino-cli', binary)
    if (!rejectedCommands.has(bundled) && await isFile(bundled)) return ownedCli(bundled, 'bundled')
  }
  const managed = join(managedDirectory(), binary)
  if (!rejectedCommands.has(managed) && await isFile(managed)) return ownedCli(managed, 'managed')
  const external = safeCommand(process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli', getWorkspaceRoot() ?? undefined)
  if (external && !rejectedCommands.has(external) && !['.cmd', '.bat'].includes(extname(external).toLowerCase())) {
    return { command: external, source: 'path', args: [] }
  }
  return null
}

export async function arduinoCliNeedsSetup(): Promise<boolean> {
  const cli = await getArduinoCli()
  if (!cli) return true
  if (cli.source === 'path') return false
  const data = join(toolsRoot(), 'data')
  return !(await isFile(join(data, 'package_index.json')) && await isFile(join(data, 'library_index.json')))
}

function progress(message: string): void {
  for (const listener of listeners) {
    try { listener(message) } catch { /* a closed window must not abort setup */ }
  }
}

async function run(cli: ArduinoCli, args: string[], timeout = 180_000): Promise<void> {
  await execFileAsync(cli.command, [...cli.args, ...args], {
    timeout, windowsHide: true, env: cli.env, maxBuffer: 8 * 1024 * 1024
  })
}

async function setup(): Promise<void> {
  setupHint = undefined
  let cli = await getArduinoCli()
  if (cli) {
    try { await run(cli, ['version'], 10_000) } catch {
      rejectedCommands.add(cli.command)
      cli = null
    }
  }
  if (!cli) {
    await installArduinoCli(managedDirectory(), process.platform, process.arch, progress)
    rejectedCommands.delete(join(managedDirectory(), process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli'))
    cli = await getArduinoCli()
    if (!cli) throw new Error('Cortex could not find its board tools after setup. Please retry.')
    await run(cli, ['version'], 10_000)
  }
  if (cli.source !== 'path' && await arduinoCliNeedsSetup()) {
    progress('Preparing the board package catalog...')
    await run(cli, ['core', 'update-index'])
    progress('Preparing the library catalog...')
    await run(cli, ['lib', 'update-index'])
    if (await arduinoCliNeedsSetup()) throw new Error('Board tools could not prepare the package catalogs. Check your connection and retry setup.')
    const urls = buildAdditionalUrlArgs((await getSettings()).boards.additionalUrls)
    if (urls.length) {
      progress('Preparing additional board catalogs...')
      try { await run(cli, ['core', 'update-index', ...urls]) } catch {
        setupHint = 'Some additional board catalogs could not be refreshed. Use the Refresh index button in Boards Manager when online.'
        progress(setupHint)
      }
    }
  }
  progress('Board tools are ready. Install the support package for your board in Boards Manager.')
}

/** One setup job for all windows/callers; failed attempts remain retryable. */
export function setupArduinoCli(onProgress?: (message: string) => void): Promise<void> {
  if (onProgress) listeners.add(onProgress)
  if (!setupPending) setupPending = setup().finally(() => { setupPending = undefined })
  const current = setupPending
  return current.finally(() => { if (onProgress) listeners.delete(onProgress) })
}
