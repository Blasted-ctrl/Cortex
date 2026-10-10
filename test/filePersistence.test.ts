import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as files from '../src/main/services/fsService'

let fixture: string
let workspace: string
let outside: string

beforeEach(async () => {
  fixture = await fs.mkdtemp(join(tmpdir(), 'cortex-persistence-'))
  workspace = join(fixture, 'project')
  outside = join(fixture, 'other')
  await fs.mkdir(workspace)
  await fs.mkdir(outside)
  files.setWorkspaceRoot(workspace)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture, { recursive: true, force: true })
})

describe('project file persistence', () => {
  it('admits only the open project root for project-wide settings', () => {
    expect(files.isWorkspaceRoot(workspace)).toBe(true)
    expect(files.isWorkspaceRoot(join(workspace, '.'))).toBe(true)
    expect(files.isWorkspaceRoot(join(workspace, 'nested'))).toBe(false)
    expect(files.isWorkspaceRoot(outside)).toBe(false)
    files.setWorkspaceRoot(null)
    expect(files.isWorkspaceRoot(workspace)).toBe(false)
  })
  it('saves actual UTF-8 bytes and leaves no staging files', async () => {
    const path = join(workspace, 'main.cpp')
    await fs.writeFile(path, 'old\r\n')
    await files.writeFile(path, '\ufeff// new\r\n')
    expect(await fs.readFile(path, 'utf8')).toBe('\ufeff// new\r\n')
    expect(await fs.readdir(workspace)).toEqual(['main.cpp'])
  })

  it('does not expose an in-progress save as a project source file', async () => {
    const path = join(workspace, 'main.cpp')
    await fs.writeFile(path, 'original')
    const rename = fs.rename.bind(fs)
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (source, destination) => {
      expect((await files.readDir(workspace)).map((entry) => entry.name)).toEqual(['main.cpp'])
      expect(await files.listAllFiles(workspace)).toEqual([path])
      await rename(source, destination)
    })
    await files.writeFile(path, 'changed')
    expect(await fs.readFile(path, 'utf8')).toBe('changed')
  })

  it('keeps the original file if the final atomic replacement fails', async () => {
    const path = join(workspace, 'main.cpp')
    await fs.writeFile(path, 'precious original')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('File is locked'), { code: 'EPERM' }))
    await expect(files.writeFile(path, 'new buffer')).rejects.toThrow('File is locked')
    expect(await fs.readFile(path, 'utf8')).toBe('precious original')
    expect(await fs.readdir(workspace)).toEqual(['main.cpp'])
  })

  it('refuses to overwrite another file when renaming', async () => {
    const source = join(workspace, 'old.cpp')
    const destination = join(workspace, 'new.cpp')
    await fs.writeFile(source, 'first')
    await fs.writeFile(destination, 'second')
    await expect(files.rename(source, destination)).rejects.toThrow(/already exists/i)
    expect(await fs.readFile(source, 'utf8')).toBe('first')
    expect(await fs.readFile(destination, 'utf8')).toBe('second')
  })

  it('allows an ordinary file and directory rename', async () => {
    await fs.mkdir(join(workspace, 'src'))
    await fs.writeFile(join(workspace, 'src', 'main.cpp'), 'int main() {}')
    await files.rename(join(workspace, 'src'), join(workspace, 'firmware'))
    await files.rename(join(workspace, 'firmware', 'main.cpp'), join(workspace, 'firmware', 'test.cpp'))
    expect(await fs.readFile(join(workspace, 'firmware', 'test.cpp'), 'utf8')).toBe('int main() {}')
  })

  it('refuses to delete or rename the workspace root', async () => {
    await fs.writeFile(join(workspace, 'keep.cpp'), 'keep')
    await expect(files.remove(workspace)).rejects.toThrow(/workspace root/i)
    await expect(files.rename(workspace, join(workspace, 'moved'))).rejects.toThrow(/workspace root/i)
    expect(await fs.readFile(join(workspace, 'keep.cpp'), 'utf8')).toBe('keep')
  })

  it('refuses save, creation, rename, and deletion through an escaping junction', async () => {
    const linked = join(workspace, 'linked')
    await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await fs.writeFile(join(outside, 'keep.cpp'), 'outside project')
    await expect(files.writeFile(join(linked, 'keep.cpp'), 'corrupt')).rejects.toThrow(/outside/i)
    await expect(files.createFile(join(linked, 'new.cpp'))).rejects.toThrow(/outside/i)
    await expect(files.createDir(join(linked, 'new', 'nested'))).rejects.toThrow(/outside/i)
    await expect(files.rename(join(linked, 'keep.cpp'), join(workspace, 'moved.cpp'))).rejects.toThrow(/outside/i)
    await expect(files.remove(join(linked, 'keep.cpp'))).rejects.toThrow(/outside/i)
    expect(await fs.readFile(join(outside, 'keep.cpp'), 'utf8')).toBe('outside project')
    expect(await fs.readdir(outside)).toEqual(['keep.cpp'])
  })

  it('does not treat a duplicate create as permission to overwrite', async () => {
    const path = join(workspace, 'keep.cpp')
    await fs.writeFile(path, 'keep')
    await expect(files.createFile(path)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(path, 'utf8')).toBe('keep')
  })

  it('permits new nested folders within the actual workspace', async () => {
    const dir = join(workspace, 'firmware', 'include')
    await files.createDir(dir)
    await files.createFile(join(dir, 'controller.h'))
    expect(await fs.readFile(join(dir, 'controller.h'), 'utf8')).toBe('')
  })

  it('clears mutation permission when the workspace is closed', async () => {
    const path = join(workspace, 'keep.cpp')
    await fs.writeFile(path, 'keep')
    files.stopWatch()
    expect(files.getWorkspaceRoot()).toBe(null)
    await expect(files.writeFile(path, 'corrupt')).rejects.toThrow(/open a project/i)
    await expect(files.createFile(join(workspace, 'new.cpp'))).rejects.toThrow(/open a project/i)
    await expect(files.remove(path)).rejects.toThrow(/open a project/i)
    expect(await fs.readFile(path, 'utf8')).toBe('keep')
  })

  it.runIf(process.platform === 'win32')('supports a case-only file rename on Windows', async () => {
    const source = join(workspace, 'main.cpp')
    const destination = join(workspace, 'Main.cpp')
    await fs.writeFile(source, 'keep')
    await files.rename(source, destination)
    expect(await fs.readdir(workspace)).toEqual(['Main.cpp'])
    expect(await fs.readFile(destination, 'utf8')).toBe('keep')
  })

  it('refuses to overwrite edits another program saved after the tab was opened', async () => {
    const path = join(workspace, 'main.cpp')
    await fs.writeFile(path, 'external edit\r\n')
    await expect(files.writeFile(path, 'my unsaved edit\r\n', 'original\r\n')).rejects.toThrow(/changed on disk/i)
    expect(await fs.readFile(path, 'utf8')).toBe('external edit\r\n')
    expect(await fs.readdir(workspace)).toEqual(['main.cpp'])
  })

  it('accepts an exact CRLF and BOM disk snapshot', async () => {
    const path = join(workspace, 'main.cpp')
    await fs.writeFile(path, '\ufefforiginal\r\n')
    await files.writeFile(path, '\ufeffchanged\r\n', '\ufefforiginal\r\n')
    expect(await fs.readFile(path, 'utf8')).toBe('\ufeffchanged\r\n')
  })

  it('blocks a missing file instead of recreating it from a stale editor tab', async () => {
    const path = join(workspace, 'deleted.cpp')
    await expect(files.writeFile(path, 'unsaved', 'original')).rejects.toThrow(/changed on disk/i)
    expect(await fs.readdir(workspace)).toEqual([])
  })

  it('creates a file only when its expected disk snapshot is still absent', async () => {
    const path = join(workspace, 'diagram.json')
    await files.writeFile(path, 'new diagram', null)
    expect(await fs.readFile(path, 'utf8')).toBe('new diagram')
    await expect(files.writeFile(path, 'replacement', null)).rejects.toThrow(/changed on disk/i)
    expect(await fs.readFile(path, 'utf8')).toBe('new diagram')
  })

  it('preserves an external file created while its first save is being staged', async () => {
    const path = join(workspace, 'diagram.json')
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'open').mockImplementationOnce(async (...args) => {
      const handle = await open(...args)
      await fs.writeFile(path, 'external diagram')
      return handle
    })
    await expect(files.writeFile(path, 'my diagram', null)).rejects.toThrow(/changed on disk/i)
    expect(await fs.readFile(path, 'utf8')).toBe('external diagram')
    expect(await fs.readdir(workspace)).toEqual(['diagram.json'])
  })

  it('checks for external edits again after writing the staging file', async () => {
    const path = join(workspace, 'main.cpp')
    await fs.writeFile(path, 'original')
    const chmod = fs.chmod.bind(fs)
    vi.spyOn(fs, 'chmod').mockImplementationOnce(async (...args) => {
      await chmod(...args)
      await fs.writeFile(path, 'external edit during save')
    })
    await expect(files.writeFile(path, 'my unsaved edit', 'original')).rejects.toThrow(/changed on disk/i)
    expect(await fs.readFile(path, 'utf8')).toBe('external edit during save')
    expect(await fs.readdir(workspace)).toEqual(['main.cpp'])
  })
})
