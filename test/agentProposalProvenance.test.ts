import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import { IPC, type AgentEvent, type AgentStagedEdit } from '../src/shared/ipc'
import { PROPOSE_EDIT, toOpenAiTools } from '../src/shared/agentTools'

const host = vi.hoisted(() => ({ profile: '' }))
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error('Unexpected Electron path')
      return host.profile
    }
  },
  safeStorage: { isEncryptionAvailable: () => false }
}))

const ENDPOINT = 'http://provider-fixture.invalid/v1/chat/completions'
let fixture: string
let root: string
let files: typeof import('../src/main/services/fsService')
let agent: typeof import('../src/main/services/agentService')
let events: AgentEvent[]
let request: ReturnType<typeof vi.fn>
let win: BrowserWindow

beforeEach(async () => {
  vi.resetModules()
  const parent = process.platform === 'win32' && existsSync('D:/') ? 'D:/' : tmpdir()
  fixture = await fs.realpath(await fs.mkdtemp(join(parent, 'cortex-agent-provenance-')))
  root = join(fixture, 'project')
  host.profile = join(fixture, 'profile')
  await fs.mkdir(root)
  await fs.mkdir(host.profile)
  await fs.writeFile(join(host.profile, 'settings.json'), JSON.stringify({
    ai: { provider: 'local', model: 'fixture-model', baseUrl: 'http://provider-fixture.invalid', apiKeyStored: '', apiKeyEncrypted: false }
  }))
  events = []
  win = {
    isDestroyed: () => false,
    webContents: { send: (channel: string, event: AgentEvent) => {
      expect(channel).toBe(IPC.AGENT_EVENT)
      events.push(event)
    } }
  } as unknown as BrowserWindow
  request = vi.fn()
  vi.stubGlobal('fetch', request)
  files = await import('../src/main/services/fsService')
  agent = await import('../src/main/services/agentService')
  files.setWorkspaceRoot(root)
})

afterEach(async () => {
  files?.setWorkspaceRoot(null)
  vi.unstubAllGlobals()
  await fs.rm(fixture, { recursive: true, force: true })
})

async function propose(path: string, extra: Record<string, unknown> = {}): Promise<void> {
  let turn = 0
  request.mockImplementation(async (url: string, init: RequestInit) => {
    expect(url).toBe(ENDPOINT)
    expect(init.method).toBe('POST')
    const body = JSON.parse(String(init.body))
    expect(body.model).toBe('fixture-model')
    if (turn++ === 0) {
      return Response.json({ choices: [{ message: { role: 'assistant', tool_calls: [{
        id: 'proposal-tool', type: 'function', function: {
          name: PROPOSE_EDIT,
          arguments: JSON.stringify({ path, new_content: '// reviewed replacement\n', summary: 'Owned fixture proposal', ...extra })
        }
      }] } }] })
    }
    expect(turn).toBe(2)
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'Proposal is ready for review.' } }] })
  })
  await agent.run(win, {
    id: 'proposal-run', workspaceRoot: host.profile,
    messages: [{ role: 'user', content: 'Stage a change in the owned project.' }], diagnostics: []
  })
  expect(request).toHaveBeenCalledTimes(2)
  expect(events.at(-1)).toEqual({ id: 'proposal-run', kind: 'done' })
  expect(events.filter(event => event.kind === 'error')).toEqual([])
}

function edits(): AgentStagedEdit[] {
  return events.flatMap(event => event.kind === 'edit' ? [event.edit] : [])
}

function expectTool(ok: boolean): void {
  expect(events.find(event => event.kind === 'tool')).toMatchObject({ kind: 'tool', tool: PROPOSE_EDIT, ok })
}

describe('main-derived proposal provenance through the actual agent runner', () => {
  it.each([
    ['existing empty', ''],
    ['existing text', '// original\n'],
    ['existing BOM/CRLF', '\ufeff// original\r\n']
  ])('retains exact bytes and existing-file evidence for %s', async (_name, original) => {
    const path = join(root, 'main.cpp')
    await fs.writeFile(path, original)

    await propose('main.cpp')

    expect(edits()).toHaveLength(1)
    expect(edits()[0]).toMatchObject({ path, oldContent: original, newContent: '// reviewed replacement\n', originalExists: true })
    expect(edits()[0].error).toBeUndefined()
    expectTool(true)
    expect(await fs.readFile(path)).toEqual(Buffer.from(original))
    expect(await fs.readdir(root)).toEqual(['main.cpp'])
  })

  it.each(['new.cpp', 'not-created/new.cpp'])('records actual absence without creating %s', async (relativePath) => {
    await propose(relativePath)

    expect(edits()).toHaveLength(1)
    expect(edits()[0]).toMatchObject({ path: join(root, relativePath), oldContent: '', originalExists: false })
    expect(edits()[0].error).toBeUndefined()
    expectTool(true)
    expect(await fs.readdir(root)).toEqual([])
  })

  it.each([
    ['existing empty', '', false],
    ['existing text', '// original\n', false],
    ['absent', null, true]
  ])('ignores model-supplied originalExists for %s', async (_name, original, claimed) => {
    const path = join(root, 'main.cpp')
    if (original !== null) await fs.writeFile(path, original)

    await propose('main.cpp', { originalExists: claimed })

    expect(edits()).toHaveLength(1)
    expect(edits()[0]).toMatchObject({ oldContent: original ?? '', originalExists: original !== null })
    expectTool(true)
    if (original !== null) expect(await fs.readFile(path)).toEqual(Buffer.from(original))
    else expect(await fs.readdir(root)).toEqual([])
  })

  it.each([
    ['binary', Buffer.from([0, 1, 2])],
    ['invalid UTF-8', Buffer.from([0xc3, 0x28])],
    ['oversized', Buffer.alloc(8 * 1024 * 1024 + 1, 0x61)]
  ])('does not offer an approvable replacement for %s input', async (_name, original) => {
    const path = join(root, 'main.cpp')
    await fs.writeFile(path, original)

    await propose('main.cpp', { originalExists: false })

    expect(edits()).toHaveLength(1)
    expect(edits()[0].error).toMatch(/refused/i)
    expectTool(false)
    expect((await fs.readFile(path)).equals(original)).toBe(true)
    expect(await fs.readdir(root)).toEqual(['main.cpp'])
  })

  it('does not treat a real non-ENOENT read error as reviewed absence', async () => {
    const invalidPath = join(root, 'invalid\0.cpp')
    await expect(fs.stat(invalidPath)).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' })

    await propose('invalid\0.cpp', { originalExists: false })

    expect(edits().filter(edit => !edit.error)).toEqual([])
    expectTool(false)
    expect(await fs.readdir(root)).toEqual([])
  })

  it('does not stage a directory that cannot be read as file text', async () => {
    await fs.mkdir(join(root, 'folder'))

    await propose('folder')

    expect(edits().filter(edit => !edit.error)).toEqual([])
    expectTool(false)
    expect(await fs.readdir(join(root, 'folder'))).toEqual([])
  })

  it('refuses a lexical escape without reading or changing its owned outside file', async () => {
    const outside = join(fixture, 'outside.cpp')
    await fs.writeFile(outside, '// outside sentinel\n')

    await propose('../outside.cpp', { originalExists: false })

    expect(edits()).toHaveLength(1)
    expect(edits()[0].error).toMatch(/outside the workspace/i)
    expectTool(false)
    expect(await fs.readFile(outside, 'utf8')).toBe('// outside sentinel\n')
    expect(await fs.readdir(root)).toEqual([])
  })

  it('refuses a physical escape through an owned link', async () => {
    const outside = join(fixture, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(join(outside, 'main.cpp'), '// linked outside sentinel\n')
    await fs.symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    await propose('linked/main.cpp', { originalExists: false })

    expect(edits()).toHaveLength(1)
    expect(edits()[0].error).toMatch(/outside the workspace/i)
    expectTool(false)
    expect(await fs.readFile(join(outside, 'main.cpp'), 'utf8')).toBe('// linked outside sentinel\n')
    expect(await fs.readdir(outside)).toEqual(['main.cpp'])
  })

  it('does not expose reviewed filesystem evidence as a model tool argument', () => {
    const tool = toOpenAiTools().find(tool => tool.function.name === PROPOSE_EDIT)!
    expect(Object.keys(tool.function.parameters.properties)).toEqual(['path', 'new_content', 'summary'])
  })
})
