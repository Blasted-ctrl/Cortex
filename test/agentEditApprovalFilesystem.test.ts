import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as files from '../src/main/services/fsService'

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
vi.stubGlobal('window', { api: { readFile: files.readFile, exists: files.exists, writeFile: files.writeFile, readDir: files.readDir } })
const { useStore, workspaceScopedReset } = await import('../src/renderer/src/store/useStore')
const initial = useStore.getState()
let fixture: string
let path: string

beforeEach(async () => {
  fixture = await fs.mkdtemp(join(tmpdir(), 'cortex-approval-save-'))
  path = join(fixture, 'main.cpp')
  files.setWorkspaceRoot(fixture)
  storage.clear()
  useStore.setState({
    ...initial, ...workspaceScopedReset(), workspaceRoot: fixture, workspaceName: 'approval-save', tree: []
  }, true)
})

afterEach(async () => {
  await useStore.getState().refreshTree()
  files.setWorkspaceRoot(null)
  useStore.setState(initial, true)
  await fs.rm(fixture, { recursive: true, force: true })
})

async function approve(bom: string): Promise<string> {
  const original = `${bom}// original\r\n`
  await fs.writeFile(path, original, 'utf8')
  await useStore.getState().openFile(path)
  useStore.setState({ agentEdits: [{
    id: 'edit-1', path, oldContent: original.replace(/\r\n/g, '\n'), newContent: '// approved\n', originalExists: true, status: 'pending'
  }] })
  await useStore.getState().approveAgentEdit('edit-1')
  expect(useStore.getState().agentEdits[0].status).toBe('approved')
  return `${bom}// approved\r\n`
}

describe.each([{ name: 'CRLF', bom: '' }, { name: 'BOM/CRLF', bom: '\ufeff' }])('agent approval through native filesystem ($name)', ({ bom }) => {
  it('preserves disk bytes and permits a later ordinary save after an LF-only proposal', async () => {
    const approved = await approve(bom)
    expect(await fs.readFile(path)).toEqual(Buffer.from(approved, 'utf8'))
    const approvedTab = useStore.getState().tabs[0]

    useStore.getState().updateContent(path, '// typed after approval\r\n')
    await expect(useStore.getState().saveActive()).resolves.toBeUndefined()

    expect(approvedTab.content).toBe(approved)
    expect(approvedTab.savedContent).toBe(approved)
    const saved = `${bom}// typed after approval\r\n`
    expect(await fs.readFile(path)).toEqual(Buffer.from(saved, 'utf8'))
    expect(useStore.getState().tabs[0]).toMatchObject({ content: saved, savedContent: saved })
    expect(await fs.readdir(fixture)).toEqual(['main.cpp'])
  })

  it('refuses an actual external edit without losing either the disk or unsaved buffer', async () => {
    const approved = await approve(bom)
    const external = `${bom}// edited by another program\r\n`
    await fs.writeFile(path, external, 'utf8')
    useStore.getState().updateContent(path, '// unsaved local edit\r\n')

    await expect(useStore.getState().saveActive()).rejects.toThrow(/changed on disk/i)

    expect(await fs.readFile(path)).toEqual(Buffer.from(external, 'utf8'))
    expect(useStore.getState().tabs[0]).toMatchObject({
      content: `${bom}// unsaved local edit\r\n`, savedContent: approved
    })
    expect(useStore.getState().tabs[0].content).not.toBe(useStore.getState().tabs[0].savedContent)
    expect(await fs.readdir(fixture)).toEqual(['main.cpp'])
  })
})

describe('reviewed existence through the native filesystem', () => {
  function stage(originalExists: boolean | undefined): void {
    useStore.setState({ agentEdits: [{ id: 'edit-1', path, oldContent: '', newContent: '// reviewed\n', originalExists, status: 'pending' }] })
  }

  it.each([true, false])('applies an unchanged empty snapshot whose reviewed existence is %s', async originalExists => {
    if (originalExists) await fs.writeFile(path, '')
    stage(originalExists)
    await useStore.getState().approveAgentEdit('edit-1')
    expect(useStore.getState().agentEdits[0].status).toBe('approved')
    expect(await fs.readFile(path)).toEqual(Buffer.from('// reviewed\n', 'utf8'))
    expect(await fs.readdir(fixture)).toEqual(['main.cpp'])
    expect(useStore.getState().tabs).toEqual([])
  })

  it('does not recreate an existing empty file deleted after review', async () => {
    await fs.writeFile(path, '')
    stage(true)
    await fs.unlink(path)
    await useStore.getState().approveAgentEdit('edit-1')
    expect(useStore.getState().agentEdits[0]).toMatchObject({ status: 'stale', error: expect.stringMatching(/re-run/i) })
    expect(await fs.readdir(fixture)).toEqual([])
    expect(useStore.getState().tabs).toEqual([])
  })

  it.each(['', '// external\r\n'])('preserves a previously absent target externally created with %j', async content => {
    stage(false)
    await fs.writeFile(path, content, 'utf8')
    await useStore.getState().approveAgentEdit('edit-1')
    expect(useStore.getState().agentEdits[0].status).toBe('stale')
    expect(await fs.readFile(path)).toEqual(Buffer.from(content, 'utf8'))
    expect(await fs.readdir(fixture)).toEqual(['main.cpp'])
    expect(useStore.getState().tabs).toEqual([])
  })

  it.each([true, false])('refuses ambiguous legacy empty proposals when the target exists=%s', async exists => {
    if (exists) await fs.writeFile(path, '')
    stage(undefined)
    await useStore.getState().approveAgentEdit('edit-1')
    expect(useStore.getState().agentEdits[0]).toMatchObject({ status: 'stale', error: expect.stringMatching(/re-run/i) })
    expect(await fs.readdir(fixture)).toEqual(exists ? ['main.cpp'] : [])
    if (exists) expect(await fs.readFile(path)).toEqual(Buffer.alloc(0))
    expect(useStore.getState().tabs).toEqual([])
  })
})
