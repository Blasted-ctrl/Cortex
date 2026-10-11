import { act, createElement } from 'react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GitOpResult, GitStatus } from '../src/shared/ipc'
import * as files from '../src/main/services/fsService'
import { createHost, invoke, type HostNode } from './reactHost'

const api = {
  gitStatus: vi.fn(), gitBranches: vi.fn(), gitDiff: vi.fn(),
  gitSwitch: vi.fn(), gitCreateBranch: vi.fn(), gitPull: vi.fn(), gitFetch: vi.fn(),
  gitPush: vi.fn(), gitInit: vi.fn(), gitCommit: vi.fn(), gitStage: vi.fn(), gitUnstage: vi.fn(),
  readFile: vi.fn(), readDir: vi.fn(), writeFile: vi.fn(), onFsEvent: vi.fn(() => () => undefined)
}
vi.stubGlobal('window', { api })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
vi.stubGlobal('React', React)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const { useStore } = await import('../src/renderer/src/store/useStore')
const { default: VcsPanel } = await import('../src/renderer/src/components/VcsPanel')
const initial = useStore.getState()
let host: ReturnType<typeof createHost>
let fixture: string
let root: string
let path: string
let releases: Array<() => void>
let pendingIo: Promise<unknown>[]
const status = (branch = 'main'): GitStatus => ({ isRepo: true, branch, upstream: 'origin/main', ahead: 1, behind: 1, files: [{ path: 'main.cpp', index: 'M', worktree: 'M' }] })
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  releases.push(() => resolve(fallback))
  return { promise, resolve, reject }
}
function track<T>(promise: Promise<T>): Promise<T> { pendingIo.push(promise); return promise }
async function drain(): Promise<void> {
  let consumed = 0
  do {
    const batch = pendingIo.slice(consumed)
    consumed = pendingIo.length
    await act(async () => { await Promise.allSettled(batch) })
  } while (consumed < pendingIo.length)
}
function control(label: string): HostNode {
  const node = host.nodes().find(current => current.props['aria-label'] === label || current.props.title === label)
  if (!node) throw new Error(`Control missing: ${label}`)
  return node
}
async function click(label: string): Promise<void> {
  await act(async () => { invoke(control(label), 'onClick', { stopPropagation: () => undefined }) })
}
async function input(label: string, value: string): Promise<void> {
  await act(async () => { invoke(control(label), 'onChange', { target: { value } }) })
}
async function begin(action: 'switch' | 'create' | 'pull'): Promise<void> {
  if (action === 'pull') { await click('Pull 1 commit from origin/main (fast-forward only)'); return }
  await click('Switch branch')
  if (action === 'switch') { await click('Switch to other'); return }
  await input('New branch name', 'feature/owned')
  await act(async () => {
    const form = host.nodes().find(node => node.type === 'form')!
    invoke(form, 'onSubmit', { preventDefault: () => undefined })
  })
}
async function aba(): Promise<void> {
  await act(async () => {
    useStore.setState({ workspaceRoot: join(fixture, 'other'), tabs: [] })
    useStore.setState({ workspaceRoot: root, tabs: [] })
  })
}

beforeEach(async () => {
  releases = []
  pendingIo = []
  fixture = await fs.mkdtemp(join(tmpdir(), 'cortex-vcs-ownership-'))
  root = join(fixture, 'project')
  path = join(root, 'main.cpp')
  await fs.mkdir(root)
  await fs.mkdir(join(fixture, 'other'))
  await fs.writeFile(path, 'original\r\n')
  files.setWorkspaceRoot(root)
  api.gitStatus.mockReset().mockImplementation(() => track(Promise.resolve(status())))
  api.gitBranches.mockReset().mockResolvedValue({ current: 'main', branches: ['main', 'other'] })
  api.gitDiff.mockReset().mockResolvedValue({ oldContent: 'before', newContent: 'after' })
  for (const operation of [api.gitSwitch, api.gitCreateBranch, api.gitPull, api.gitFetch, api.gitPush, api.gitInit, api.gitCommit, api.gitStage, api.gitUnstage]) operation.mockReset().mockResolvedValue({ ok: true })
  api.readFile.mockReset().mockImplementation((target: string) => track(files.readFile(target)))
  api.readDir.mockReset().mockImplementation((target: string) => track(files.readDir(target)))
  api.writeFile.mockReset().mockImplementation((target: string, content: string, expected: string | null | undefined) => track(files.writeFile(target, content, expected)))
  useStore.setState({ ...initial, workspaceRoot: root, workspaceName: 'project', tabs: [], tree: [], expanded: new Set(), childrenCache: {}, notifications: [], confirm: vi.fn().mockResolvedValue(true) }, true)
  await useStore.getState().openFile(path)
  host = createHost()
  await host.render(createElement(VcsPanel))
  await drain()
  api.readFile.mockClear()
  api.readDir.mockClear()
  api.gitStatus.mockClear()
})
afterEach(async () => {
  releases.forEach(release => release())
  await drain()
  await host.render(null)
  files.setWorkspaceRoot(null)
  useStore.setState(initial, true)
  if (fixture.startsWith(join(tmpdir(), 'cortex-vcs-ownership-'))) await fs.rm(fixture, { recursive: true, force: true })
})

describe('owned Source Control operations', () => {
  it.each(['stage', 'unstage', 'commit', 'fetch', 'push', 'init'] as const)('normal %s preserves confirmation and refreshes status', async (action) => {
    if (action === 'init') {
      api.gitStatus.mockResolvedValueOnce({ isRepo: false, files: [], ahead: 0, behind: 0 })
      await click('Refresh source control')
      api.gitStatus.mockClear()
    }
    if (action === 'commit') {
      await input('Commit message', 'owned commit')
      await click('Commit staged changes')
    } else if (action === 'init') {
      const node = host.nodes().find(node => node.type === 'button' && node.children.some(child => child.props.text === 'Initialize repository'))!
      await act(async () => { invoke(node, 'onClick', {}) })
    } else await click(action === 'stage' ? 'Stage' : action === 'unstage' ? 'Unstage' : action === 'fetch' ? 'Fetch remote changes' : 'Push 1 commit to origin/main')
    await drain()
    const operation = action === 'stage' ? api.gitStage : action === 'unstage' ? api.gitUnstage : action === 'commit' ? api.gitCommit : action === 'fetch' ? api.gitFetch : action === 'push' ? api.gitPush : api.gitInit
    expect(operation).toHaveBeenCalledOnce()
    expect(api.gitStatus).toHaveBeenCalledOnce()
    expect(control('Fetch remote changes').props.disabled).toBe(false)
    if (action === 'push' || action === 'init' || action === 'fetch') expect(useStore.getState().confirm).toHaveBeenCalledOnce()
    else expect(useStore.getState().confirm).not.toHaveBeenCalled()
    if (action === 'commit') {
      expect(operation).toHaveBeenCalledWith('owned commit')
      expect(control('Commit message').props.value).toBe('')
      expect(useStore.getState().notifications).toContainEqual(expect.objectContaining({ kind: 'success', title: 'Committed' }))
    }
    expect(await fs.readFile(path, 'utf8')).toBe('original\r\n')
  })

  it.each(['push', 'init', 'fetch', 'pull'] as const)('cancelled %s confirmation does not invoke Git', async (action) => {
    if (action === 'init') {
      api.gitStatus.mockResolvedValueOnce({ isRepo: false, files: [], ahead: 0, behind: 0 })
      await click('Refresh source control')
    }
    await act(async () => { useStore.setState({ confirm: vi.fn().mockResolvedValue(false) }) })
    if (action === 'init') {
      const node = host.nodes().find(node => node.type === 'button' && node.children.some(child => child.props.text === 'Initialize repository'))!
      await act(async () => { invoke(node, 'onClick', {}) })
    } else await click(action === 'push' ? 'Push 1 commit to origin/main' : action === 'fetch' ? 'Fetch remote changes' : 'Pull 1 commit from origin/main (fast-forward only)')
    await drain()
    expect(useStore.getState().confirm).toHaveBeenCalledOnce()
    expect(api.gitPush).not.toHaveBeenCalled()
    expect(api.gitInit).not.toHaveBeenCalled()
    expect(api.gitFetch).not.toHaveBeenCalled()
    expect(api.gitPull).not.toHaveBeenCalled()
    expect(useStore.getState().notifications).toEqual([])
  })

  it('a normal commit error retains the draft and releases busy', async () => {
    api.gitCommit.mockResolvedValueOnce({ ok: false, error: 'Commit refused' })
    await input('Commit message', 'retry this message')
    await click('Commit staged changes')
    await drain()
    expect(control('Commit message').props.value).toBe('retry this message')
    expect(host.nodes().some(node => node.props.text === 'Commit refused')).toBe(true)
    expect(control('Fetch remote changes').props.disabled).toBe(false)
  })

  it.each(['switch', 'create', 'pull'] as const)('normal %s reconciles actual disk bytes and tree before announcing success', async (action) => {
    const operation = action === 'switch' ? api.gitSwitch : action === 'create' ? api.gitCreateBranch : api.gitPull
    operation.mockImplementationOnce(async () => { await fs.writeFile(path, '\ufeffbranch\r\n'); return { ok: true } })
    await begin(action)
    await vi.waitFor(() => expect(useStore.getState().notifications).toContainEqual(expect.objectContaining({ kind: 'success' })))
    await drain()
    expect(useStore.getState().tabs[0]).toMatchObject({ content: '\ufeffbranch\r\n', savedContent: '\ufeffbranch\r\n' })
    expect(useStore.getState().tree).toContainEqual(expect.objectContaining({ path, name: 'main.cpp' }))
    expect(control('Fetch remote changes').props.disabled).toBe(false)
    expect(await fs.readFile(path)).toEqual(Buffer.from('\ufeffbranch\r\n'))
  })

  it.each(['switch', 'create', 'pull'] as const)('%s stays busy through delayed tab and tree reconciliation', async (action) => {
    const read = deferred<void>(undefined)
    const tree = deferred<void>(undefined)
    api.readFile.mockImplementationOnce((target: string) => track(read.promise.then(() => files.readFile(target))))
    api.readDir.mockImplementationOnce((target: string) => track(tree.promise.then(() => files.readDir(target))))
    await begin(action)
    await vi.waitFor(() => expect(api.readFile).toHaveBeenCalledOnce())
    expect(control('Fetch remote changes').props.disabled).toBe(true)
    await click('Fetch remote changes')
    expect(api.gitFetch).not.toHaveBeenCalled()
    read.resolve(undefined)
    await vi.waitFor(() => expect(api.readDir).toHaveBeenCalledOnce())
    expect(control('Fetch remote changes').props.disabled).toBe(true)
    tree.resolve(undefined)
    await drain()
    expect(control('Fetch remote changes').props.disabled).toBe(false)
  })

  for (const action of ['switch', 'create', 'pull'] as const) {
    it.each(['success', 'error'] as const)(`${action} ignores an old %s after workspace ABA`, async (result) => {
      const op = deferred<GitOpResult>({ ok: true })
      const operation = action === 'switch' ? api.gitSwitch : action === 'create' ? api.gitCreateBranch : api.gitPull
      operation.mockReturnValueOnce(op.promise)
      await begin(action)
      await aba()
      const calls = api.gitStatus.mock.calls.length
      const current = useStore.getState().tabs
      if (result === 'success') op.resolve({ ok: true })
      else op.reject(new Error('Old operation failed'))
      await drain()
      expect(api.readFile).not.toHaveBeenCalled()
      expect(api.readDir).not.toHaveBeenCalled()
      expect(api.gitStatus).toHaveBeenCalledTimes(calls)
      expect(useStore.getState().tabs).toBe(current)
      expect(useStore.getState().notifications).toEqual([])
    })
  }

  it.each(['push', 'init', 'fetch', 'pull'] as const)('a delayed %s confirmation cannot authorize a reopened workspace', async (action) => {
    if (action === 'init') {
      api.gitStatus.mockResolvedValueOnce({ isRepo: false, files: [], ahead: 0, behind: 0 })
      await click('Refresh source control')
    }
    const confirmation = deferred(false)
    await act(async () => { useStore.setState({ confirm: vi.fn().mockReturnValueOnce(confirmation.promise) }) })
    const label = action === 'push' ? 'Push 1 commit to origin/main' : action === 'init' ? 'Initialize repository' : action === 'fetch' ? 'Fetch remote changes' : 'Pull 1 commit from origin/main (fast-forward only)'
    if (action === 'init') {
      const node = host.nodes().find(node => node.type === 'button' && node.children.some(child => child.props.text === 'Initialize repository'))!
      await act(async () => { invoke(node, 'onClick', {}) })
    } else await click(label)
    await aba()
    confirmation.resolve(true)
    await drain()
    const operation = action === 'push' ? api.gitPush : action === 'init' ? api.gitInit : action === 'fetch' ? api.gitFetch : api.gitPull
    expect(operation).not.toHaveBeenCalled()
    expect(useStore.getState().notifications).toEqual([])
  })

  it.each(['stage', 'unstage', 'commit', 'fetch', 'push', 'init'] as const)('suppresses a delayed %s failure in a replacement project', async (action) => {
    if (action === 'init') {
      api.gitStatus.mockResolvedValueOnce({ isRepo: false, files: [], ahead: 0, behind: 0 })
      await click('Refresh source control')
    }
    const op = deferred<GitOpResult>({ ok: false, error: 'Old failure' })
    const operation = action === 'stage' ? api.gitStage : action === 'unstage' ? api.gitUnstage : action === 'commit' ? api.gitCommit : action === 'fetch' ? api.gitFetch : action === 'push' ? api.gitPush : api.gitInit
    operation.mockReturnValueOnce(op.promise)
    if (action === 'commit') {
      await input('Commit message', 'old commit')
      await click('Commit staged changes')
    } else if (action === 'init') {
      const node = host.nodes().find(node => node.type === 'button' && node.children.some(child => child.props.text === 'Initialize repository'))!
      await act(async () => { invoke(node, 'onClick', {}) })
    } else await click(action === 'stage' ? 'Stage' : action === 'unstage' ? 'Unstage' : action === 'fetch' ? 'Fetch remote changes' : 'Push 1 commit to origin/main')
    await act(async () => { useStore.setState({ workspaceRoot: join(fixture, 'other'), tabs: [] }) })
    const calls = api.gitStatus.mock.calls.length
    op.resolve({ ok: false, error: 'Old failure' })
    await drain()
    expect(api.gitStatus).toHaveBeenCalledTimes(calls)
    expect(useStore.getState().notifications).toEqual([])
    expect(host.nodes().some(node => node.props.text === 'Old failure')).toBe(false)
  })

  it('retains a newer commit draft after an old successful commit', async () => {
    const op = deferred<GitOpResult>({ ok: true })
    api.gitCommit.mockReturnValueOnce(op.promise)
    await input('Commit message', 'old commit')
    await click('Commit staged changes')
    await act(async () => { useStore.setState({ workspaceRoot: join(fixture, 'other'), tabs: [] }) })
    await input('Commit message', 'new project draft')
    op.resolve({ ok: true })
    await drain()
    expect(control('Commit message').props.value).toBe('new project draft')
    expect(useStore.getState().notifications).toEqual([])
  })

  it('retains a newer branch draft after an old successful branch creation', async () => {
    const op = deferred<GitOpResult>({ ok: true })
    api.gitCreateBranch.mockReturnValueOnce(op.promise)
    await begin('create')
    await act(async () => { useStore.setState({ workspaceRoot: join(fixture, 'other'), tabs: [] }) })
    await click('Switch branch')
    await input('New branch name', 'new-project-branch')
    op.resolve({ ok: true })
    await drain()
    expect(control('New branch name').props.value).toBe('new-project-branch')
    expect(useStore.getState().notifications).toEqual([])
  })

  it('ignores status and branch-list responses from a previous same-root lifetime', async () => {
    const oldStatus = deferred<GitStatus>(status('obsolete'))
    const oldBranches = deferred({ current: 'obsolete', branches: ['obsolete'] })
    api.gitStatus.mockReturnValueOnce(oldStatus.promise)
    api.gitBranches.mockReturnValueOnce(oldBranches.promise)
    await click('Refresh source control')
    await click('Switch branch')
    await aba()
    oldStatus.resolve(status('obsolete'))
    oldBranches.resolve({ current: 'obsolete', branches: ['obsolete'] })
    await drain()
    expect(host.nodes().some(node => node.props.text === 'obsolete')).toBe(false)
    expect(useStore.getState().notifications).toEqual([])
  })

  it.each(['success', 'error'] as const)('ignores a delayed diff %s after workspace ABA', async (result) => {
    const diff = deferred({ oldContent: 'before', newContent: 'obsolete patch' })
    api.gitDiff.mockReturnValueOnce(diff.promise)
    await click('Modified: main.cpp')
    await aba()
    if (result === 'success') diff.resolve({ oldContent: 'before', newContent: 'obsolete patch' })
    else diff.reject(new Error('Old diff refused'))
    await drain()
    expect(host.nodes().some(node => node.props.text === 'obsolete patch')).toBe(false)
    expect(host.nodes().filter(node => node.props.role === 'alert')).toEqual([])
  })

  it('keeps the operation busy until its status refresh finishes', async () => {
    const read = deferred<GitStatus>(status())
    api.gitStatus.mockReturnValueOnce(read.promise)
    await click('Stage')
    expect(control('Fetch remote changes').props.disabled).toBe(true)
    await click('Unstage')
    expect(api.gitUnstage).not.toHaveBeenCalled()
    read.resolve(status())
    await drain()
    expect(control('Fetch remote changes').props.disabled).toBe(false)
  })

  it.each(['switch', 'create', 'pull', 'stage', 'commit'] as const)('preserves dirty buffers and refuses %s', async (action) => {
    await act(async () => { useStore.getState().updateContent(path, 'unsaved') })
    if (action === 'stage') await click('Stage')
    else if (action === 'commit') {
      await input('Commit message', 'not ready')
      await act(async () => { invoke(control('Commit message'), 'onKeyDown', { key: 'Enter' }) })
    } else await begin(action)
    expect(api.gitSwitch).not.toHaveBeenCalled()
    expect(api.gitCreateBranch).not.toHaveBeenCalled()
    expect(api.gitPull).not.toHaveBeenCalled()
    expect(api.gitStage).not.toHaveBeenCalled()
    expect(api.gitCommit).not.toHaveBeenCalled()
    expect(useStore.getState().tabs[0].content).toBe('unsaved')
    expect(await fs.readFile(path, 'utf8')).toBe('original\r\n')
  })
})
