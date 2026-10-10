import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as files from '../src/main/services/fsService'

let fixture: string
let root: string
let outside: string
beforeEach(async () => {
  fixture = await fs.mkdtemp(join(tmpdir(), 'cortex-session-read-'))
  root = join(fixture, 'project')
  outside = join(fixture, 'outside')
  await fs.mkdir(root)
  await fs.mkdir(outside)
  await fs.writeFile(join(root, 'main.cpp'), 'current disk source')
  await fs.writeFile(join(outside, 'secret.cpp'), 'not admitted')
  files.setWorkspaceRoot(root)
})
afterEach(async () => { files.setWorkspaceRoot(null); await fs.rm(fixture, { recursive: true, force: true }) })

describe('confined automatic session reads', () => {
  it('reads only files and directories from the admitted project', async () => {
    expect(await files.readWorkspaceFile(root, join(root, 'main.cpp'))).toEqual({ kind: 'text', content: 'current disk source' })
    expect(await files.readWorkspaceDir(root, root)).toEqual([expect.objectContaining({ name: 'main.cpp' })])
    await expect(files.readWorkspaceFile(outside, join(outside, 'secret.cpp'))).rejects.toThrow(/project|workspace/i)
    await expect(files.readWorkspaceFile(root, join(outside, 'secret.cpp'))).rejects.toThrow(/outside/i)
  })
  it('rejects escaped junctions for files and expanded directories', async () => {
    const alias = join(root, 'alias')
    await fs.symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(files.readWorkspaceFile(root, join(alias, 'secret.cpp'))).rejects.toThrow(/outside/i)
    await expect(files.readWorkspaceDir(root, alias)).rejects.toThrow(/outside/i)
  })
  it('supports the admitted project itself opened through a directory link', async () => {
    const alias = join(fixture, 'project-link')
    await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    files.setWorkspaceRoot(alias)
    expect(await files.readWorkspaceFile(alias, join(alias, 'main.cpp'))).toMatchObject({ content: 'current disk source' })
    expect((await files.readWorkspaceDir(alias, alias))[0].path).toBe(join(alias, 'main.cpp'))
  })
  it('does not restore after admission closes and leaves manual chosen-file reads working', async () => {
    files.setWorkspaceRoot(null)
    await expect(files.readWorkspaceFile(root, join(root, 'main.cpp'))).rejects.toThrow(/project|workspace/i)
    expect(await files.readFile(join(outside, 'secret.cpp'))).toMatchObject({ content: 'not admitted' })
  })
})
