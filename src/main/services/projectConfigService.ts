import { constants, promises as fs } from 'fs'
import { isUtf8 } from 'buffer'
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'
import type { ProjectConfig } from '../../shared/ipc'
import { isBareCommand, isWithin } from '../../shared/security'

/** Per-project build configuration, stored at <workspace>/.cortex/config.json. */

function configPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.cortex', 'config.json')
}

/** The file exactly as written, with no sanitization. Only the WRITER may use
 *  this: it exists so persisting one setting cannot delete another one that the
 *  app merely refuses to honour. */
async function readConfigText(path: string): Promise<string | null> {
  const bytes = await fs.readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!bytes) return null
  if (!isUtf8(bytes)) throw new Error('Cannot save project settings: config.json is not valid UTF-8.')
  return bytes.toString('utf8')
}

async function writableConfigPath(root: string): Promise<string> {
  const currentRoot = await fs.realpath(root)
  if (!isWithin(root, currentRoot) || !isWithin(currentRoot, root)) throw new Error('Cannot save: the project path changed during the save.')
  const directory = join(root, '.cortex')
  const entry = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (entry?.isSymbolicLink()) throw new Error('Refused: linked .cortex directory is outside the supported project layout.')
  await fs.mkdir(directory, { recursive: true })
  const physicalDirectory = await fs.realpath(directory)
  if (!isWithin(root, physicalDirectory)) throw new Error('Refused: configuration directory is outside the project.')
  const target = join(physicalDirectory, 'config.json')
  const file = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (file?.isSymbolicLink()) throw new Error('Refused: linked config.json could write outside the project.')
  if (file && !file.isFile()) throw new Error('Cannot save: config.json is not a regular file.')
  return target
}

export async function getProjectConfig(workspaceRoot: string): Promise<ProjectConfig> {
  try {
    const raw = await fs.readFile(configPath(workspaceRoot), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || !parsed) return {}
    const cfg = { ...(parsed as ProjectConfig) }
    // This file travels with the workspace, so it is untrusted: a cloned repo
    // can ship one. `compiler` is spawned as a command (build path and the LSP
    // toolchain probe), so a config that points it at an absolute path to an
    // arbitrary binary would be code execution on open. Only honour a bare,
    // PATH-resolved name here; a real absolute compiler path belongs in the
    // trusted app settings.
    if (cfg.compiler && !isBareCommand(cfg.compiler)) delete cfg.compiler
    return cfg
  } catch {
    return {}
  }
}

async function persistConfig(root: string, patch: ProjectConfig): Promise<ProjectConfig> {
  // The RAW file, not the sanitized view: basing the merge on the sanitized one
  // meant that saving any setting silently deleted a `compiler` line the user
  // had hand-written, out of their own version-controlled file, as a git
  // deletion they never made. Refusing to honour a value is not a licence to
  // erase it.
  const target = await writableConfigPath(root)
  const raw = await readConfigText(target)
  let current: ProjectConfig = {}
  if (raw !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error('Cannot save project settings: config.json contains invalid JSON. Keep a copy and repair it before retrying.')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Cannot save project settings: config.json must contain a JSON object.')
    current = parsed as ProjectConfig
  }
  const next: ProjectConfig = { ...current, ...patch }
  const previous = await fs.stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (previous) await fs.access(target, constants.W_OK)
  const mode = previous ? previous.mode & 0o777 : 0o666
  const staged = join(dirname(target), `.config.json.cortex-save-${randomUUID()}`)
  const handle = await fs.open(staged, 'wx', mode)
  try {
    await handle.writeFile(JSON.stringify(next, null, 2), 'utf8')
    await handle.sync()
    await handle.close()
    if (previous) await fs.chmod(staged, mode)
    if (await writableConfigPath(root) !== target) throw new Error('Cannot save: the configuration path changed during the save.')
    if (await readConfigText(target) !== raw) throw new Error('Project settings changed on disk during the save. Retry after reviewing config.json.')
    await fs.rename(staged, target)
  } finally {
    await handle.close().catch(() => {})
    await fs.unlink(staged).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
  return next
}

const pendingWrites = new Map<string, Promise<ProjectConfig>>()
let writeAdmission: Promise<void> = Promise.resolve()

export function setProjectConfig(workspaceRoot: string, patch: ProjectConfig): Promise<ProjectConfig> {
  let queued!: Promise<ProjectConfig>
  // Preserve invocation order while resolving aliases, without making one
  // project's slow disk write block another project's writes.
  const admitted = writeAdmission.then(async () => {
    const root = await fs.realpath(workspaceRoot)
    const key = process.platform === 'win32' ? root.toLowerCase() : root
    const previous = pendingWrites.get(key) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(() => persistConfig(root, patch)).finally(() => {
      if (pendingWrites.get(key) === task) pendingWrites.delete(key)
    })
    pendingWrites.set(key, task)
    queued = task
  })
  writeAdmission = admitted.catch(() => {})
  return admitted.then(() => queued)
}
