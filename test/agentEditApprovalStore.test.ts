import { beforeEach, describe, expect, it, vi } from 'vitest'
import { langFromPath } from '../src/shared/languages'
import type { FileReadResult } from '../src/shared/ipc'

const root = 'C:/project'
const path = `${root}/main.cpp`
const disk = new Map<string, string>()
const storage = new Map<string, string>()
const api = { readFile: vi.fn(), exists: vi.fn(), writeFile: vi.fn() }
vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
vi.stubGlobal('window', { api })
const { useStore, workspaceScopedReset } = await import('../src/renderer/src/store/useStore')
const initial = useStore.getState()

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

function proposal(oldContent = 'original', newContent = 'reviewed') {
  return { id: 'edit-1', path, oldContent, newContent, status: 'pending' as const }
}

function tab(content = 'original') {
  return { path, name: 'main.cpp', content, savedContent: content, language: langFromPath(path), group: 0 as const }
}

function missing() {
  return new Error("Error invoking remote method 'fs:readFile': Error: ENOENT: no such file or directory")
}

async function commit(target: string, content: string, expected?: string | null) {
  if (expected !== undefined && (expected === null ? disk.has(target) : disk.get(target) !== expected)) {
    throw new Error('This file changed on disk or was deleted.')
  }
  disk.set(target, content)
}

beforeEach(() => {
  vi.clearAllMocks()
  disk.clear()
  disk.set(path, 'original')
  storage.clear()
  api.readFile.mockReset().mockImplementation(async (target: string) => {
    if (!disk.has(target)) throw missing()
    return { kind: 'text', content: disk.get(target)! }
  })
  api.exists.mockReset().mockImplementation(async (target: string) => disk.has(target))
  api.writeFile.mockReset().mockImplementation(commit)
  useStore.setState({
    ...initial, ...workspaceScopedReset(), workspaceRoot: root, workspaceName: 'project',
    tabs: [tab()], activePath: path, groupActive: { 0: path }, agentEdits: [proposal()],
    refreshTree: vi.fn().mockResolvedValue(undefined)
  }, true)
})

describe('actual store reviewed agent-edit approval', () => {
  it('approves an unchanged existing file with its exact disk snapshot', async () => {
    await useStore.getState().approveAgentEdit('edit-1')
    expect(disk.get(path)).toBe('reviewed')
    expect(api.writeFile).toHaveBeenCalledWith(path, 'reviewed', 'original')
    expect(useStore.getState().tabs[0]).toMatchObject({ content: 'reviewed', savedContent: 'reviewed' })
    expect(useStore.getState().agentEdits[0].status).toBe('approved')
  })

  it('preserves existing BOM and CRLF in the compared and committed bytes', async () => {
    disk.set(path, '\ufefffirst\r\nsecond\r\n')
    useStore.setState({ tabs: [tab('\ufefffirst\nsecond\n')], agentEdits: [proposal('\ufefffirst\nsecond\n', '\ufeffchanged\nsecond\n')] })
    await useStore.getState().approveAgentEdit('edit-1')
    expect(disk.get(path)).toBe('\ufeffchanged\r\nsecond\r\n')
    expect(api.writeFile).toHaveBeenCalledWith(path, '\ufeffchanged\r\nsecond\r\n', '\ufefffirst\r\nsecond\r\n')
    expect(useStore.getState().tabs[0].savedContent).toBe('\ufeffchanged\nsecond\n')
  })

  it('compares an existing empty file against empty bytes, not expected absence', async () => {
    disk.set(path, '')
    useStore.setState({ tabs: [tab('')], agentEdits: [proposal('', 'created content')] })
    await useStore.getState().approveAgentEdit('edit-1')
    expect(disk.get(path)).toBe('created content')
    expect(api.writeFile).toHaveBeenCalledWith(path, 'created content', '')
  })

  it('creates a new file only after serialized ENOENT and confirmed absence', async () => {
    disk.delete(path)
    useStore.setState({ tabs: [], agentEdits: [proposal('', 'new file')] })
    await useStore.getState().approveAgentEdit('edit-1')
    expect(disk.get(path)).toBe('new file')
    expect(api.writeFile).toHaveBeenCalledWith(path, 'new file', null)
    expect(useStore.getState().agentEdits[0].status).toBe('approved')
  })

  it('refuses an initially dirty editor buffer', async () => {
    useStore.getState().updateContent(path, 'keep unsaved')
    await useStore.getState().approveAgentEdit('edit-1')
    expect(api.writeFile).not.toHaveBeenCalled()
    expect(useStore.getState().tabs[0].content).toBe('keep unsaved')
    expect(useStore.getState().agentEdits[0].status).toBe('stale')
  })

  it('refuses edits typed while disk reconciliation is pending', async () => {
    const read = deferred<FileReadResult>()
    api.readFile.mockReturnValueOnce(read.promise)
    const approval = useStore.getState().approveAgentEdit('edit-1')
    useStore.getState().updateContent(path, 'keep newer typing')
    read.resolve({ kind: 'text', content: 'original' })
    await approval
    expect(api.writeFile).not.toHaveBeenCalled()
    expect(disk.get(path)).toBe('original')
    expect(useStore.getState().tabs[0]).toMatchObject({ content: 'keep newer typing', savedContent: 'original' })
    expect(useStore.getState().agentEdits[0].status).toBe('stale')
  })

  it('preserves typing during a write while advancing only the saved snapshot', async () => {
    const writing = deferred<void>()
    api.writeFile.mockImplementationOnce(async (...args: Parameters<typeof commit>) => { await writing.promise; await commit(...args) })
    const approval = useStore.getState().approveAgentEdit('edit-1')
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledTimes(1))
    useStore.getState().updateContent(path, 'keep typing after approval')
    writing.resolve()
    await approval
    expect(disk.get(path)).toBe('reviewed')
    expect(useStore.getState().tabs[0]).toMatchObject({ content: 'keep typing after approval', savedContent: 'reviewed' })
    expect(useStore.getState().agentEdits[0].status).toBe('approved')
  })

  it('does not adopt a late write into a closed and reopened same-path tab', async () => {
    const writing = deferred<void>()
    api.writeFile.mockImplementationOnce(async (...args: Parameters<typeof commit>) => { await writing.promise; await commit(...args) })
    const approval = useStore.getState().approveAgentEdit('edit-1')
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalled())
    await useStore.getState().closeTab(path)
    await useStore.getState().openFile(path)
    const reopened = useStore.getState().tabs[0]
    writing.resolve()
    await approval
    expect(disk.get(path)).toBe('reviewed')
    expect(useStore.getState().tabs[0]).toBe(reopened)
    expect(reopened).toMatchObject({ content: 'original', savedContent: 'original' })
  })

  it('refuses a disk change after the reviewed read, preserving external bytes', async () => {
    api.writeFile.mockImplementationOnce(async (...args: Parameters<typeof commit>) => {
      disk.set(path, 'external change')
      await commit(...args)
    })
    await useStore.getState().approveAgentEdit('edit-1')
    expect(disk.get(path)).toBe('external change')
    expect(useStore.getState().tabs[0]).toMatchObject({ content: 'original', savedContent: 'original' })
    expect(useStore.getState().agentEdits[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/changed on disk/) })
  })

  it('refuses a new target created between the absence check and write', async () => {
    disk.delete(path)
    useStore.setState({ tabs: [], agentEdits: [proposal('', 'new file')] })
    api.writeFile.mockImplementationOnce(async (...args: Parameters<typeof commit>) => {
      disk.set(path, 'external new file')
      await commit(...args)
    })
    await useStore.getState().approveAgentEdit('edit-1')
    expect(disk.get(path)).toBe('external new file')
    expect(useStore.getState().agentEdits[0].status).toBe('failed')
  })

  it('locks approval before any read so duplicate clicks cannot launch two writes', async () => {
    const read = deferred<FileReadResult>()
    api.readFile.mockReturnValue(read.promise)
    const first = useStore.getState().approveAgentEdit('edit-1')
    const second = useStore.getState().approveAgentEdit('edit-1')
    read.resolve({ kind: 'text', content: 'original' })
    await Promise.all([first, second])
    expect(api.readFile).toHaveBeenCalledTimes(1)
    expect(api.writeFile).toHaveBeenCalledTimes(1)
    expect(useStore.getState().agentEdits[0].status).toBe('approved')
  })

  it.each([path, 'c:\\PROJECT\\MAIN.cpp'])('admits only one proposal at a time for the same file identity %s', async secondPath => {
    const second = { ...proposal(), id: 'edit-2', path: secondPath, newContent: 'second reviewed edit' }
    useStore.setState({ agentEdits: [proposal(), second] })
    const read = deferred<FileReadResult>()
    api.readFile.mockReturnValue(read.promise)
    const firstApproval = useStore.getState().approveAgentEdit('edit-1')
    const secondApproval = useStore.getState().approveAgentEdit('edit-2')
    read.resolve({ kind: 'text', content: 'original' })
    await Promise.all([firstApproval, secondApproval])
    expect(api.readFile).toHaveBeenCalledTimes(1)
    expect(disk.get(path)).toBe('reviewed')
    expect(useStore.getState().agentEdits[1]).toBe(second)
    expect(second.status).toBe('pending')
  })

  it('allows an independent file approval while another file read is pending', async () => {
    const otherPath = `${root}/other.cpp`
    disk.set(otherPath, 'original')
    useStore.setState({ agentEdits: [proposal(), { ...proposal(), id: 'edit-2', path: otherPath, newContent: 'independent edit' }] })
    const read = deferred<FileReadResult>()
    api.readFile.mockReturnValueOnce(read.promise)
    const firstApproval = useStore.getState().approveAgentEdit('edit-1')
    await useStore.getState().approveAgentEdit('edit-2')
    expect(disk.get(otherPath)).toBe('independent edit')
    expect(useStore.getState().agentEdits[0].status).toBe('applying')
    expect(useStore.getState().agentEdits[1].status).toBe('approved')
    read.resolve({ kind: 'text', content: 'original' })
    await firstApproval
    expect(disk.get(path)).toBe('reviewed')
  })

  it('rejects pending proposals but does not promise cancellation once approval begins', async () => {
    useStore.getState().rejectAgentEdit('edit-1')
    await useStore.getState().approveAgentEdit('edit-1')
    expect(api.writeFile).not.toHaveBeenCalled()
    expect(useStore.getState().agentEdits[0].status).toBe('rejected')
    useStore.setState({ agentEdits: [proposal()] })
    const read = deferred<FileReadResult>()
    api.readFile.mockReturnValueOnce(read.promise)
    const approval = useStore.getState().approveAgentEdit('edit-1')
    useStore.getState().rejectAgentEdit('edit-1')
    const lockedStatus = useStore.getState().agentEdits[0].status
    read.resolve({ kind: 'text', content: 'original' })
    await approval
    expect(lockedStatus).toBe('applying')
    expect(disk.get(path)).toBe('reviewed')
  })

  it('leaves an in-flight write applying if Reject is invoked', async () => {
    const writing = deferred<void>()
    api.writeFile.mockImplementationOnce(async (...args: Parameters<typeof commit>) => { await writing.promise; await commit(...args) })
    const approval = useStore.getState().approveAgentEdit('edit-1')
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalled())
    useStore.getState().rejectAgentEdit('edit-1')
    expect(useStore.getState().agentEdits[0].status).toBe('applying')
    writing.resolve()
    await approval
    expect(disk.get(path)).toBe('reviewed')
    expect(useStore.getState().agentEdits[0].status).toBe('approved')
  })

  it.each(['read', 'write'])('does not affect a replacement proposal during a pending %s', async phase => {
    const read = deferred<FileReadResult>()
    const writing = deferred<void>()
    if (phase === 'read') api.readFile.mockReturnValueOnce(read.promise)
    else api.writeFile.mockImplementationOnce(async (...args: Parameters<typeof commit>) => { await writing.promise; await commit(...args) })
    const approval = useStore.getState().approveAgentEdit('edit-1')
    if (phase === 'write') await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalled())
    const replacement = proposal('original', 'other reviewed edit')
    useStore.setState({ agentEdits: [replacement] })
    read.resolve({ kind: 'text', content: 'original' })
    writing.resolve()
    await approval
    expect(useStore.getState().agentEdits[0]).toBe(replacement)
    expect(useStore.getState().tabs[0].content).toBe('original')
    expect(useStore.getState().refreshTree).not.toHaveBeenCalled()
    if (phase === 'read') expect(api.writeFile).not.toHaveBeenCalled()
  })

  it.each(['read', 'write'])('drops old-project effects after a switch during %s', async phase => {
    const read = deferred<FileReadResult>()
    const writing = deferred<void>()
    if (phase === 'read') api.readFile.mockReturnValueOnce(read.promise)
    else api.writeFile.mockImplementationOnce(async (...args: Parameters<typeof commit>) => { await writing.promise; await commit(...args) })
    const approval = useStore.getState().approveAgentEdit('edit-1')
    if (phase === 'write') await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalled())
    const replacement = proposal('new project', 'other reviewed edit')
    useStore.setState({ workspaceRoot: 'C:/other', tabs: [tab('new project')], agentEdits: [replacement] })
    read.resolve({ kind: 'text', content: 'original' })
    writing.resolve()
    await approval
    expect(useStore.getState().tabs[0].content).toBe('new project')
    expect(useStore.getState().agentEdits[0]).toBe(replacement)
    expect(useStore.getState().refreshTree).not.toHaveBeenCalled()
    if (phase === 'read') expect(api.writeFile).not.toHaveBeenCalled()
  })

  it('invalidates a read when the same project is closed and reopened', async () => {
    const read = deferred<FileReadResult>()
    api.readFile.mockReturnValueOnce(read.promise)
    const approval = useStore.getState().approveAgentEdit('edit-1')
    useStore.setState({ workspaceRoot: null })
    useStore.setState({ workspaceRoot: root })
    read.resolve({ kind: 'text', content: 'original' })
    await approval
    expect(api.writeFile).not.toHaveBeenCalled()
    expect(useStore.getState().tabs[0].content).toBe('original')
  })

  it.each(['EACCES: access denied', 'Unable to read file'])('fails closed on %s for an empty proposal', async message => {
    disk.set(path, '')
    useStore.setState({ tabs: [], agentEdits: [proposal('', 'replacement')] })
    api.readFile.mockRejectedValueOnce(new Error(message))
    await useStore.getState().approveAgentEdit('edit-1')
    expect(api.writeFile).not.toHaveBeenCalled()
    expect(disk.get(path)).toBe('')
    expect(useStore.getState().agentEdits[0].status).toBe('failed')
  })

  it.each<FileReadResult>([{ kind: 'binary' }, { kind: 'too-large', size: 9000000 }])('never treats $kind as an absent empty file', async result => {
    disk.delete(path)
    useStore.setState({ tabs: [], agentEdits: [proposal('', 'replacement')] })
    api.readFile.mockResolvedValueOnce(result)
    await useStore.getState().approveAgentEdit('edit-1')
    expect(api.writeFile).not.toHaveBeenCalled()
    expect(disk.has(path)).toBe(false)
    expect(useStore.getState().agentEdits[0].status).toBe('stale')
  })

  it.each(['original', ''])('does not recreate a deleted file belonging to an existing %s tab', async content => {
    disk.delete(path)
    useStore.setState({ tabs: [tab(content)], agentEdits: [proposal(content)] })
    await useStore.getState().approveAgentEdit('edit-1')
    expect(api.writeFile).not.toHaveBeenCalled()
    expect(disk.has(path)).toBe(false)
    expect(useStore.getState().tabs[0].savedContent).toBe(content)
  })

  it('refuses an ENOENT result if the target now exists', async () => {
    disk.set(path, '')
    useStore.setState({ tabs: [], agentEdits: [proposal('', 'replacement')] })
    api.readFile.mockRejectedValueOnce(missing())
    await useStore.getState().approveAgentEdit('edit-1')
    expect(api.writeFile).not.toHaveBeenCalled()
    expect(disk.get(path)).toBe('')
  })

  it('fails closed when confirming absence fails', async () => {
    disk.delete(path)
    useStore.setState({ tabs: [], agentEdits: [proposal('', 'replacement')] })
    api.exists.mockRejectedValueOnce(new Error('Access denied'))
    await useStore.getState().approveAgentEdit('edit-1')
    expect(api.writeFile).not.toHaveBeenCalled()
    expect(disk.has(path)).toBe(false)
    expect(useStore.getState().agentEdits[0].status).toBe('failed')
  })

  it('rechecks a tab opened while confirming a new target is absent', async () => {
    disk.delete(path)
    useStore.setState({ tabs: [], agentEdits: [proposal('', 'replacement')] })
    const absence = deferred<boolean>()
    api.exists.mockReturnValueOnce(absence.promise)
    const approval = useStore.getState().approveAgentEdit('edit-1')
    await vi.waitFor(() => expect(api.exists).toHaveBeenCalled())
    useStore.setState({ tabs: [tab('')] })
    absence.resolve(false)
    await approval
    expect(api.writeFile).not.toHaveBeenCalled()
    expect(disk.has(path)).toBe(false)
  })

  it('preserves the buffer and reports an owned write error', async () => {
    api.writeFile.mockRejectedValueOnce(new Error('Disk is full'))
    await useStore.getState().approveAgentEdit('edit-1')
    expect(disk.get(path)).toBe('original')
    expect(useStore.getState().tabs[0].content).toBe('original')
    expect(useStore.getState().agentEdits[0]).toMatchObject({ status: 'failed', error: 'Disk is full' })
    expect(useStore.getState().refreshTree).not.toHaveBeenCalled()
  })
})
