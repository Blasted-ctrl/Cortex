import { constants, promises as fs } from 'fs'
import { isUtf8 } from 'buffer'
import { randomUUID } from 'crypto'
import { join, basename, dirname, relative, resolve } from 'path'
import chokidar, { FSWatcher } from 'chokidar'
import type { BrowserWindow } from 'electron'
import type { FileNode, FileReadResult } from '../../shared/ipc'
import { IPC } from '../../shared/ipc'
import { isWithin } from '../../shared/security'

const IGNORE = new Set(['node_modules', '.git', 'out', 'dist', 'release', '.cortex'])
const isIgnoredName = (name: string): boolean => IGNORE.has(name) || /^\..+\.cortex-save-[a-f0-9-]{36}$/.test(name)

// The currently open workspace. Renderer-initiated writes/deletes are confined
// to it so a compromised renderer cannot mutate arbitrary files on disk.
let workspaceRoot: string | null = null
export function setWorkspaceRoot(root: string | null): void {
  workspaceRoot = root ? resolve(root) : null
}
export function getWorkspaceRoot(): string | null {
  return workspaceRoot
}
export async function getPhysicalWorkspaceRoot(): Promise<string | null> {
  const root = workspaceRoot
  if (!root) return null
  try {
    const physical = await fs.realpath(root)
    return root === workspaceRoot ? physical : null
  } catch {
    return null
  }
}
/** True when `p` is the open workspace or a path within it. Used to confine
 * renderer-supplied roots (LSP, etc.) the way file writes are confined. */
export function withinWorkspace(p: string): boolean {
  return !!workspaceRoot && isWithin(workspaceRoot, resolve(p))
}
/** Project-wide settings can target only the admitted folder, not a nested
 * symlink supplied by the renderer. The service captures its real root next. */
export function isWorkspaceRoot(p: string): boolean {
  return typeof p === 'string' && !!workspaceRoot &&
    isWithin(workspaceRoot, resolve(p)) && isWithin(resolve(p), workspaceRoot)
}
async function writablePath(p: string): Promise<string> {
  const root = workspaceRoot
  if (!root) throw new Error('Open a project folder before changing files.')
  const target = resolve(p)
  if (!isWithin(root, target)) {
    throw new Error(`Refused: path is outside the open workspace: ${p}`)
  }
  const realRoot = await fs.realpath(root)
  let probe = target
  for (;;) {
    try {
      const real = await fs.realpath(probe)
      if (!isWithin(realRoot, real)) throw new Error(`Refused: path is outside the open workspace: ${p}`)
      return join(real, relative(probe, target))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // A dangling link is not a new file: following it can create a target
      // outside the project, even though its parent directory is inside it.
      const entry = await fs.lstat(probe).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code === 'ENOENT') return null
        throw failure
      })
      if (entry?.isSymbolicLink()) throw new Error(`Refused: unresolved symbolic link: ${p}`)
      const parent = dirname(probe)
      if (parent === probe) throw error
      probe = parent
    }
  }
}

async function entryPath(p: string): Promise<string> {
  const physical = await writablePath(p)
  const root = workspaceRoot && await fs.realpath(workspaceRoot)
  if (root && relative(root, physical) === '') throw new Error('Refused: cannot rename or delete the workspace root.')
  return join(await writablePath(dirname(p)), basename(p))
}

/** Read a directory one level deep (lazy tree loading). */
export async function readDir(dirPath: string): Promise<FileNode[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true })
  const nodes: FileNode[] = entries
    .filter((e) => !isIgnoredName(e.name))
    .map((e) => ({
      name: e.name,
      path: join(dirPath, e.name),
      isDir: e.isDirectory()
    }))
  // Directories first, then alphabetical.
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return nodes
}

/** Anything larger opens as a placeholder: Monaco chokes and it is almost
 * certainly generated, not something you meant to edit. */
const MAX_EDITABLE_BYTES = 8 * 1024 * 1024

/**
 * Read a file for the editor, refusing binaries and oversized files.
 *
 * A plain utf8 read let `.bin`/`.elf`/`.o`/`.png` open as editable mojibake;
 * saving that tab re-encoded U+FFFD over the artifact and destroyed it. A NUL
 * byte anywhere is the standard binary heuristic (it is what git uses).
 *
 * The scan covers the WHOLE buffer, not a leading window: a PDF or tar whose
 * first pages are ASCII would otherwise pass the sniff and then be decoded
 * lossily. Reading once also avoids a stat/open race and cannot leak a handle.
 */
export async function readFile(filePath: string): Promise<FileReadResult> {
  const stat = await fs.stat(filePath)
  if (stat.size > MAX_EDITABLE_BYTES) return { kind: 'too-large', size: stat.size }
  const buf = await fs.readFile(filePath)
  if (buf.length > MAX_EDITABLE_BYTES) return { kind: 'too-large', size: buf.length }
  if (buf.includes(0) || !isUtf8(buf)) return { kind: 'binary' }
  return { kind: 'text', content: buf.toString('utf8') }
}

/** Saved session paths are untrusted metadata, unlike an explicit file picker. */
async function workspaceRead<T>(root: string, path: string, read: (physical: string) => Promise<T>): Promise<T> {
  if (!isWorkspaceRoot(root) || typeof path !== 'string' || path.length > 4096 || path.includes('\0')) throw new Error('Session read requires the open project.')
  const target = resolve(path)
  if (!isWithin(resolve(root), target)) throw new Error('Session path is outside the open workspace.')
  const physicalRoot = await fs.realpath(root)
  const physical = await fs.realpath(target)
  if (!isWithin(physicalRoot, physical)) throw new Error('Session path links outside the open workspace.')
  const result = await read(physical)
  if (!isWorkspaceRoot(root) || await fs.realpath(root) !== physicalRoot || await fs.realpath(target) !== physical) throw new Error('The project changed during the session read.')
  return result
}
export function readWorkspaceFile(root: string, path: string): Promise<FileReadResult> {
  return workspaceRead(root, path, readFile)
}
export async function readWorkspaceDir(root: string, path: string): Promise<FileNode[]> {
  const nodes = await workspaceRead(root, path, readDir)
  return nodes.map(node => ({ ...node, path: join(path, node.name) }))
}

/**
 * Probe for optional files (a saved diagram, a project config) without going
 * through the throw path. Electron logs every rejected ipcMain.handle to
 * stderr, so "this workspace has no diagram yet" was printing an ENOENT stack
 * on every open, which is exactly the noise that hides real errors.
 */
export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/** Recursively list all file paths under root (for quick-open). Capped. */
export async function listAllFiles(root: string, cap = 8000): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= cap) return
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (isIgnoredName(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.isFile()) {
        // Only real files. A symlink is neither dir nor recursed here; following
        // it (stat/read) could escape the workspace, so it is skipped.
        out.push(full)
        if (out.length >= cap) return
      }
    }
  }
  await walk(root)
  return out
}

async function assertFileUnchanged(filePath: string, expectedContent: string | null | undefined): Promise<void> {
  if (expectedContent === undefined) return
  const current = await fs.readFile(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (expectedContent === null ? current !== null : !current || !isUtf8(current) || current.toString('utf8') !== expectedContent) {
    throw new Error('This file changed on disk or was deleted. Your editor changes were not written. Compare them with the disk version before retrying.')
  }
}

export async function writeFile(filePath: string, content: string, expectedContent?: string | null): Promise<void> {
  const target = await writablePath(filePath)
  const previous = await fs.stat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (previous && !previous.isFile()) throw new Error('Cannot save: the destination is not a regular file.')
  await assertFileUnchanged(target, expectedContent)
  if (previous) await fs.access(target, constants.W_OK)
  const staged = join(dirname(target), `.${basename(target)}.cortex-save-${randomUUID()}`)
  const mode = previous ? previous.mode & 0o777 : 0o666
  const handle = await fs.open(staged, 'wx', mode)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    if (previous) await fs.chmod(staged, mode)
    if (await writablePath(filePath) !== target) throw new Error('Cannot save: the project path changed during the save.')
    await assertFileUnchanged(target, expectedContent)
    await fs.rename(staged, target)
  } finally {
    await handle.close().catch(() => {})
    await fs.unlink(staged).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

export async function createFile(filePath: string): Promise<void> {
  await fs.writeFile(await writablePath(filePath), '', { flag: 'wx' })
}

export async function createDir(dirPath: string): Promise<void> {
  await fs.mkdir(await writablePath(dirPath), { recursive: true })
}

export async function rename(oldPath: string, newPath: string): Promise<void> {
  const source = await entryPath(oldPath)
  const destination = await entryPath(newPath)
  if (source === destination) return
  const sameWindowsEntry = process.platform === 'win32' && source.toLowerCase() === destination.toLowerCase()
  if (!sameWindowsEntry && await exists(destination)) throw new Error(`A file or folder already exists at: ${newPath}`)
  await fs.rename(source, destination)
}

export async function remove(targetPath: string): Promise<void> {
  await fs.rm(await entryPath(targetPath), { recursive: true, force: true })
}

// ---- file watching -------------------------------------------------------

let watcher: FSWatcher | null = null

export function startWatch(rootPath: string, win: BrowserWindow): void {
  stopWatch()
  setWorkspaceRoot(rootPath)
  watcher = chokidar.watch(rootPath, {
    // Match whole path SEGMENTS. A substring test silently unwatched output.cpp,
    // layout.h and distance.cpp, and killed the whole watcher for any workspace
    // whose path merely contained "dist".
    ignored: (p: string) => p.split(/[\\/]/).some(isIgnoredName),
    ignoreInitial: true,
    depth: 12,
    // Explorer consumes names, not file contents. Delaying add can suppress a
    // rename destination's deletion after a sibling event exposed that name.
    awaitWriteFinish: false
  })
  const emit = (type: string) => (path: string) => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.FS_EVENT, { type, path, name: basename(path) })
    }
  }
  watcher
    .on('add', emit('add'))
    .on('unlink', emit('unlink'))
    .on('addDir', emit('addDir'))
    .on('unlinkDir', emit('unlinkDir'))
    .on('change', emit('change'))
}

export function stopWatch(): void {
  setWorkspaceRoot(null)
  if (watcher) {
    void watcher.close()
    watcher = null
  }
}
