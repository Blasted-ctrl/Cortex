import { beforeEach, describe, expect, it, vi } from 'vitest'
import { langFromPath } from '../src/shared/languages'

const validRecent = { path: 'C:/project', name: 'project', ts: 1 }
const api = {
  writeFile: vi.fn(),
  deletePath: vi.fn(),
  rename: vi.fn(),
  createFile: vi.fn(),
  createDir: vi.fn(),
  readFile: vi.fn(),
  readDir: vi.fn(),
  watchStart: vi.fn(),
  watchStop: vi.fn(),
  lspDisposeRoot: vi.fn(),
  lspServers: vi.fn(),
  setProjectConfig: vi.fn()
}
const storage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
storage.getItem.mockImplementation((key: string) => key === 'cortex.recents'
  ? JSON.stringify([null, { path: 42 }, validRecent, { ...validRecent, ts: 0 }]) : null)
vi.stubGlobal('localStorage', storage)
vi.stubGlobal('window', { api })

const { useStore, normPath } = await import('../src/renderer/src/store/useStore')
const initial = useStore.getState()
const loadedRecents = initial.recents

function tab(path: string, content = 'unsaved', savedContent = 'original') {
  return { path, name: path.split('/').pop()!, content, savedContent, language: langFromPath(path), group: 0 as const }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  api.writeFile.mockReset().mockResolvedValue(undefined)
  api.deletePath.mockReset().mockResolvedValue(undefined)
  api.rename.mockReset().mockResolvedValue(undefined)
  api.createFile.mockReset().mockResolvedValue(undefined)
  api.createDir.mockReset().mockResolvedValue(undefined)
  api.readFile.mockReset().mockResolvedValue({ kind: 'text', content: 'disk' })
  api.readDir.mockReset().mockResolvedValue([])
  api.watchStart.mockResolvedValue(undefined)
  api.watchStop.mockResolvedValue(undefined)
  api.lspDisposeRoot.mockResolvedValue(undefined)
  api.lspServers.mockResolvedValue({})
  api.setProjectConfig.mockReset().mockResolvedValue({})
  useStore.setState({
    ...initial,
    workspaceRoot: 'C:/project',
    workspaceName: 'project',
    tabs: [tab('C:/project/main.cpp')],
    activePath: 'C:/project/main.cpp',
    groupActive: { 0: 'C:/project/main.cpp' },
    notifications: [],
    recents: [validRecent],
    stopRun: vi.fn().mockResolvedValue(undefined),
    stopSim: vi.fn().mockResolvedValue(undefined),
    stopDebug: vi.fn(),
    cancelAgent: vi.fn(),
    loadProjectConfig: vi.fn().mockResolvedValue(undefined),
    loadDiagram: vi.fn().mockResolvedValue(undefined),
    refreshTree: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue(true),
    refreshBoardStatus: vi.fn().mockResolvedValue(undefined),
    refreshProjectModel: vi.fn().mockResolvedValue(undefined)
  }, true)
})

describe('filesystem event tree refreshes', () => {
  beforeEach(() => {
    useStore.setState({ refreshTree: initial.refreshTree, expanded: new Set<string>(), tree: [], childrenCache: {} })
  })

  it('does not restore a deleted file from an older directory read', async () => {
    const earlierRead = deferred<Array<{ name: string; path: string; isDir: boolean }>>()
    api.readDir.mockReturnValueOnce(earlierRead.promise).mockResolvedValueOnce([])
    const beforeDeletion = useStore.getState().refreshTree()
    await useStore.getState().refreshTree()
    expect(useStore.getState().tree).toEqual([])
    earlierRead.resolve([{ name: 'renamed.cpp', path: 'C:/project/renamed.cpp', isDir: false }])
    await beforeDeletion
    expect(useStore.getState().tree).toEqual([])
  })

  it('does not restore deleted nested entries when an older expanded directory read finishes last', async () => {
    const directory = { name: 'src', path: 'C:/project/src', isDir: true }
    const earlierChildren = deferred<Array<{ name: string; path: string; isDir: boolean }>>()
    useStore.setState({ expanded: new Set([directory.path]) })
    api.readDir.mockResolvedValueOnce([directory]).mockReturnValueOnce(earlierChildren.promise)
      .mockResolvedValueOnce([directory]).mockResolvedValueOnce([])
    const beforeDeletion = useStore.getState().refreshTree()
    await vi.waitFor(() => expect(api.readDir).toHaveBeenCalledTimes(2))
    await useStore.getState().refreshTree()
    earlierChildren.resolve([{ name: 'renamed.cpp', path: 'C:/project/src/renamed.cpp', isDir: false }])
    await beforeDeletion
    expect(useStore.getState().childrenCache[directory.path]).toEqual([])
  })

  it('does not insert an old project tree after switching workspaces', async () => {
    const earlierRead = deferred<Array<{ name: string; path: string; isDir: boolean }>>()
    api.readDir.mockReturnValueOnce(earlierRead.promise)
    const refreshing = useStore.getState().refreshTree()
    const newTree = [{ name: 'new.cpp', path: 'C:/other/new.cpp', isDir: false }]
    useStore.setState({ workspaceRoot: 'C:/other', tree: newTree })
    earlierRead.resolve([{ name: 'old.cpp', path: 'C:/project/old.cpp', isDir: false }])
    await refreshing
    expect(useStore.getState().tree).toEqual(newTree)
  })

  it('does not replace a freshly reopened project with its previous session tree', async () => {
    const earlierRead = deferred<Array<{ name: string; path: string; isDir: boolean }>>()
    api.readDir.mockReturnValueOnce(earlierRead.promise)
    const refreshing = useStore.getState().refreshTree()
    useStore.setState({ workspaceRoot: 'C:/other', tree: [] })
    const reopenedTree = [{ name: 'current.cpp', path: 'C:/project/current.cpp', isDir: false }]
    useStore.setState({ workspaceRoot: 'C:/project', tree: reopenedTree })
    earlierRead.resolve([{ name: 'deleted.cpp', path: 'C:/project/deleted.cpp', isDir: false }])
    await refreshing
    expect(useStore.getState().tree).toEqual(reopenedTree)
  })

  it('handles a missing root without rejecting the event callback or discarding open edits', async () => {
    const lastKnownTree = [{ name: 'main.cpp', path: 'C:/project/main.cpp', isDir: false }]
    const lastKnownChildren = { 'C:/project/src': [{ name: 'module.cpp', path: 'C:/project/src/module.cpp', isDir: false }] }
    useStore.setState({ tree: lastKnownTree, childrenCache: lastKnownChildren })
    api.readDir.mockRejectedValueOnce(new Error('Project folder was removed'))
    await expect(useStore.getState().refreshTree()).resolves.toBeUndefined()
    expect(useStore.getState()).toMatchObject({
      workspaceRoot: 'C:/project', tree: lastKnownTree, childrenCache: lastKnownChildren,
      tabs: [expect.objectContaining({ content: 'unsaved', savedContent: 'original' })]
    })
    expect(useStore.getState().notifications).toContainEqual(expect.objectContaining({
      kind: 'error', title: 'Could not refresh project files',
      detail: expect.stringMatching(/restore.*folder.*refresh/i)
    }))
  })

  it('ignores a delayed root read error after another project becomes active', async () => {
    const earlierRead = deferred<Array<{ name: string; path: string; isDir: boolean }>>()
    api.readDir.mockReturnValueOnce(earlierRead.promise)
    const refreshing = useStore.getState().refreshTree()
    const newTree = [{ name: 'new.cpp', path: 'C:/other/new.cpp', isDir: false }]
    useStore.setState({ workspaceRoot: 'C:/other', tree: newTree })
    earlierRead.reject(new Error('Old folder was removed'))
    await expect(refreshing).resolves.toBeUndefined()
    expect(useStore.getState().tree).toEqual(newTree)
    expect(useStore.getState().notifications).toEqual([])
  })

  it('ignores a superseded root error after a newer refresh succeeded', async () => {
    const earlierRead = deferred<Array<{ name: string; path: string; isDir: boolean }>>()
    const currentTree = [{ name: 'current.cpp', path: 'C:/project/current.cpp', isDir: false }]
    api.readDir.mockReturnValueOnce(earlierRead.promise).mockResolvedValueOnce(currentTree)
    const earlierRefresh = useStore.getState().refreshTree()
    await useStore.getState().refreshTree()
    earlierRead.reject(new Error('Transient read failure'))
    await expect(earlierRefresh).resolves.toBeUndefined()
    expect(useStore.getState().tree).toEqual(currentTree)
    expect(useStore.getState().notifications).toEqual([])
  })
})

describe('project settings persistence feedback', () => {
  it('reports failed persistence without an unhandled setter rejection', async () => {
    api.setProjectConfig.mockRejectedValueOnce(new Error('Configuration is locked'))
    await expect(useStore.getState().persistProjectConfig({ std: 'c++20' })).resolves.toBeUndefined()
    expect(useStore.getState().notifications).toContainEqual(expect.objectContaining({
      kind: 'error', title: 'Could not save project settings',
      detail: expect.stringContaining('Configuration is locked')
    }))
  })

  it('identifies the original project when a pending settings write fails after switching', async () => {
    const write = deferred<void>()
    api.setProjectConfig.mockReturnValueOnce(write.promise)
    const saving = useStore.getState().persistProjectConfig({ optimization: '-O2' })
    useStore.setState({ workspaceRoot: 'C:/other' })
    write.reject(new Error('Old project is no longer writable'))
    await expect(saving).resolves.toBeUndefined()
    expect(api.setProjectConfig).toHaveBeenCalledWith('C:/project', { optimization: '-O2' })
    expect(useStore.getState().notifications[0].detail).toContain('C:/project')
  })
})

describe('explicit reload from disk', () => {
  it('replaces a clean buffer with the exact current disk contents', async () => {
    useStore.setState({ tabs: [tab('C:/project/main.cpp', 'original', 'original')] })
    api.readFile.mockResolvedValueOnce({ kind: 'text', content: '\ufeffexternal\r\n' })
    await useStore.getState().reloadActiveFromDisk()
    expect(useStore.getState().tabs[0]).toMatchObject({ content: '\ufeffexternal\r\n', savedContent: '\ufeffexternal\r\n' })
    expect(useStore.getState().confirm).not.toHaveBeenCalled()
    expect(api.writeFile).not.toHaveBeenCalled()
  })

  it('keeps unsaved edits when the reload confirmation is cancelled', async () => {
    useStore.setState({ confirm: vi.fn().mockResolvedValue(false) })
    await useStore.getState().reloadActiveFromDisk()
    expect(useStore.getState().tabs[0]).toMatchObject({ content: 'unsaved', savedContent: 'original' })
    expect(api.writeFile).not.toHaveBeenCalled()
  })

  it('only discards unsaved edits after an explicit confirmation', async () => {
    await useStore.getState().reloadActiveFromDisk()
    expect(useStore.getState().confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Discard and reload', cancelLabel: 'Keep editing', danger: true }))
    expect(useStore.getState().tabs[0]).toMatchObject({ content: 'disk', savedContent: 'disk' })
  })

  it('does not lose edits typed while a disk reload is pending', async () => {
    const read = deferred<{ kind: 'text'; content: string }>()
    api.readFile.mockReturnValueOnce(read.promise)
    const reloading = useStore.getState().reloadActiveFromDisk()
    useStore.getState().updateContent('C:/project/main.cpp', 'typed during reload')
    read.resolve({ kind: 'text', content: 'disk' })
    await expect(reloading).rejects.toThrow(/changed while reloading/i)
    expect(useStore.getState().tabs[0]).toMatchObject({ content: 'typed during reload', savedContent: 'original' })
  })

  it('keeps the open buffer if the file cannot be read', async () => {
    api.readFile.mockRejectedValueOnce(new Error('File not found'))
    await expect(useStore.getState().reloadActiveFromDisk()).rejects.toThrow('File not found')
    expect(useStore.getState().tabs[0]).toMatchObject({ content: 'unsaved', savedContent: 'original' })
  })
})

describe('saving editor buffers', () => {
  it('retains edits made while a save is still pending', async () => {
    const write = deferred<void>()
    api.writeFile.mockReturnValueOnce(write.promise)
    const saving = useStore.getState().saveActive()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    useStore.getState().updateContent('C:/project/main.cpp', 'newer edit')
    write.resolve(undefined)
    await saving
    expect(useStore.getState().tabs[0]).toMatchObject({ content: 'newer edit', savedContent: 'unsaved' })
  })

  it('serializes overlapping saves so an older write cannot overwrite a newer one', async () => {
    const first = deferred<void>()
    api.writeFile.mockReturnValueOnce(first.promise)
    const savingFirst = useStore.getState().saveActive()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    useStore.getState().updateContent('C:/project/main.cpp', 'latest')
    const savingSecond = useStore.getState().saveActive()
    await Promise.resolve()
    expect(api.writeFile).toHaveBeenCalledOnce()
    first.resolve(undefined)
    await Promise.all([savingFirst, savingSecond])
    expect(api.writeFile.mock.calls.map((args) => args.slice(1))).toEqual([['unsaved', 'original'], ['latest', 'unsaved']])
    expect(useStore.getState().tabs[0].savedContent).toBe('latest')
  })

  it('marks successful files clean but keeps a failed file dirty during Save All', async () => {
    useStore.setState({ tabs: [tab('C:/project/ok.cpp'), tab('C:/project/locked.cpp')] })
    api.writeFile.mockImplementation(async (path: string) => {
      if (path.endsWith('locked.cpp')) throw new Error('Permission denied')
    })
    await expect(useStore.getState().saveAll()).rejects.toThrow('Permission denied')
    expect(useStore.getState().tabs[0].savedContent).toBe('unsaved')
    expect(useStore.getState().tabs[1].savedContent).toBe('original')
    expect(useStore.getState().notifications[0]).toMatchObject({ kind: 'error', title: 'Could not save locked.cpp' })
  })

  it('never writes a read-only placeholder, even if an extension marks it dirty', async () => {
    useStore.setState({ tabs: [{ ...tab('C:/project/firmware.bin'), readOnlyReason: 'Binary file' }] })
    await useStore.getState().saveAll()
    expect(api.writeFile).not.toHaveBeenCalled()
  })

  it('allows a failed save to be retried without losing the buffer', async () => {
    api.writeFile.mockRejectedValueOnce(new Error('Disk full'))
    await expect(useStore.getState().saveActive()).rejects.toThrow('Disk full')
    expect(useStore.getState().tabs[0]).toMatchObject({ content: 'unsaved', savedContent: 'original' })
    await useStore.getState().saveActive()
    expect(useStore.getState().tabs[0].savedContent).toBe('unsaved')
  })

  it('keeps the UTF-8 BOM when the editor omits it from a change event', () => {
    useStore.setState({ tabs: [tab('C:/project/main.cpp', '\ufefforiginal\r\n', '\ufefforiginal\r\n')] })
    useStore.getState().updateContent('C:/project/main.cpp', 'changed\r\n')
    expect(useStore.getState().tabs[0].content).toBe('\ufeffchanged\r\n')
  })
})

describe('changing projects', () => {
  it('checks the requested folder before stopping the working project', async () => {
    api.readDir.mockRejectedValueOnce(new Error('Folder no longer exists'))
    await expect(useStore.getState().openWorkspace('C:/missing')).rejects.toThrow('Folder no longer exists')
    expect(useStore.getState().stopRun).not.toHaveBeenCalled()
    expect(api.watchStop).not.toHaveBeenCalled()
    expect(useStore.getState()).toMatchObject({ workspaceRoot: 'C:/project', tabs: [tab('C:/project/main.cpp')] })
  })

  it('saves edits before replacing the project and remembers the real folder', async () => {
    await useStore.getState().openWorkspace('C:/other')
    expect(api.writeFile).toHaveBeenCalledWith('C:/project/main.cpp', 'unsaved', 'original')
    expect(api.writeFile.mock.invocationCallOrder[0]).toBeLessThan(api.watchStop.mock.invocationCallOrder[0])
    expect(useStore.getState()).toMatchObject({ workspaceRoot: 'C:/other', tabs: [] })
    expect(storage.setItem).toHaveBeenCalledWith('cortex.lastWorkspace', 'C:/other')
    expect(useStore.getState().recents[0].path).toBe('C:/other')
  })

  it('keeps the existing project open when saving fails', async () => {
    api.writeFile.mockRejectedValueOnce(new Error('Disk full'))
    await expect(useStore.getState().openWorkspace('C:/other')).rejects.toThrow('Disk full')
    expect(api.watchStop).not.toHaveBeenCalled()
    expect(api.watchStart).not.toHaveBeenCalled()
    expect(useStore.getState()).toMatchObject({ workspaceRoot: 'C:/project', tabs: [tab('C:/project/main.cpp')] })
    expect(storage.setItem).not.toHaveBeenCalledWith('cortex.lastWorkspace', 'C:/other')
  })

  it('keeps a project open if Close Folder cannot save it', async () => {
    api.writeFile.mockRejectedValueOnce(new Error('Disk full'))
    await expect(useStore.getState().closeWorkspace()).rejects.toThrow('Disk full')
    expect(useStore.getState().workspaceRoot).toBe('C:/project')
    expect(useStore.getState().tabs[0].content).toBe('unsaved')
    expect(api.watchStop).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalledWith('cortex.lastWorkspace')
  })

  it('preserves typing that arrives during Close Folder teardown', async () => {
    api.watchStop.mockImplementationOnce(async () => {
      useStore.getState().updateContent('C:/project/main.cpp', 'typed during close')
    })
    await expect(useStore.getState().closeWorkspace()).rejects.toThrow(/new edits/i)
    expect(useStore.getState().workspaceRoot).toBe('C:/project')
    expect(useStore.getState().tabs[0].content).toBe('typed during close')
    expect(api.watchStart).toHaveBeenCalledWith('C:/project')
  })

  it('does not insert a delayed file read from the previous project into the new one', async () => {
    const read = deferred<{ kind: 'text'; content: string }>()
    api.readFile.mockReturnValueOnce(read.promise)
    const opening = useStore.getState().openFile('C:/project/slow.cpp')
    await useStore.getState().openWorkspace('C:/other')
    read.resolve({ kind: 'text', content: 'old project' })
    await opening
    expect(useStore.getState().tabs).toEqual([])
  })

  it('validates and deduplicates stored recents instead of crashing on malformed entries', () => {
    expect(loadedRecents).toEqual([validRecent])
  })

  it('restores the original project if its new watcher cannot start', async () => {
    api.watchStart.mockRejectedValueOnce(new Error('Cannot watch project'))
    await expect(useStore.getState().openWorkspace('C:/other')).rejects.toThrow('Cannot watch project')
    expect(useStore.getState().workspaceRoot).toBe('C:/project')
    expect(useStore.getState().tabs[0].path).toBe('C:/project/main.cpp')
    expect(api.watchStart).toHaveBeenLastCalledWith('C:/project')
  })

  it('preserves new typing that arrives while the watcher is being changed', async () => {
    api.watchStart.mockImplementationOnce(async () => {
      useStore.getState().updateContent('C:/project/main.cpp', 'typed during switch')
    })
    await expect(useStore.getState().openWorkspace('C:/other')).rejects.toThrow(/new edits/i)
    expect(useStore.getState().workspaceRoot).toBe('C:/project')
    expect(useStore.getState().tabs[0]).toMatchObject({ content: 'typed during switch', savedContent: 'unsaved' })
    expect(api.watchStart).toHaveBeenLastCalledWith('C:/project')
  })

  it('preserves distinct POSIX file names and folds Windows names', () => {
    expect(normPath('/home/project/Main.cpp')).not.toBe(normPath('/home/project/main.cpp'))
    expect(normPath('C:\\Project\\MAIN.cpp')).toBe(normPath('c:/project/main.cpp'))
  })

  it('serializes overlapping project changes instead of mixing their results', async () => {
    const first = deferred<[]>()
    api.readDir.mockReturnValueOnce(first.promise)
    const openingFirst = useStore.getState().openWorkspace('C:/first')
    await vi.waitFor(() => expect(api.readDir).toHaveBeenCalledOnce())
    const openingSecond = useStore.getState().openWorkspace('C:/second')
    await Promise.resolve()
    expect(api.readDir).toHaveBeenCalledOnce()
    first.resolve([])
    await Promise.all([openingFirst, openingSecond])
    expect(api.watchStart.mock.calls).toEqual([['C:/first'], ['C:/second']])
    expect(useStore.getState().workspaceRoot).toBe('C:/second')
  })

  it('saves a dirty circuit before switching and keeps it if saving fails', async () => {
    const saveDiagram = vi.fn().mockRejectedValueOnce(new Error('Circuit save failed'))
    useStore.setState({ simDiagramDirty: true, saveDiagram })
    await expect(useStore.getState().openWorkspace('C:/other')).rejects.toThrow('Circuit save failed')
    expect(useStore.getState().workspaceRoot).toBe('C:/project')
    expect(useStore.getState().simDiagramDirty).toBe(true)
    expect(api.watchStop).not.toHaveBeenCalled()
  })

  it('waits for a pending file save before renaming its tab', async () => {
    const write = deferred<void>()
    api.writeFile.mockReturnValueOnce(write.promise)
    const saving = useStore.getState().saveActive()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    const renaming = useStore.getState().renameEntry('C:/project/main.cpp', 'renamed.cpp')
    await Promise.resolve()
    expect(api.rename).not.toHaveBeenCalled()
    write.resolve(undefined)
    await Promise.all([saving, renaming])
    expect(useStore.getState().tabs[0]).toMatchObject({ path: 'C:/project/renamed.cpp', savedContent: 'unsaved' })
  })

  it('waits for a pending save before deleting a file so it cannot be recreated', async () => {
    const write = deferred<void>()
    api.writeFile.mockReturnValueOnce(write.promise)
    const saving = useStore.getState().saveActive()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    const deleting = useStore.getState().deleteEntry('C:/project/main.cpp')
    await Promise.resolve()
    expect(api.deletePath).not.toHaveBeenCalled()
    write.resolve(undefined)
    await Promise.all([saving, deleting])
    expect(api.deletePath).toHaveBeenCalledWith('C:/project/main.cpp')
    expect(useStore.getState().tabs).toEqual([])
  })

  it('waits for a pending save before closing its tab', async () => {
    const write = deferred<void>()
    api.writeFile.mockReturnValueOnce(write.promise)
    const saving = useStore.getState().saveActive()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    const closing = useStore.getState().closeTab('C:/project/main.cpp')
    await Promise.resolve()
    try {
      expect(useStore.getState().tabs).toHaveLength(1)
    } finally {
      write.resolve(undefined)
    }
    await Promise.all([saving, closing])
    expect(useStore.getState().tabs).toEqual([])
    expect(useStore.getState().confirm).not.toHaveBeenCalled()
  })

  it.each(['..', '../outside.cpp', 'folder/file.cpp', 'folder\\file.cpp', 'bad\u0000name'])('refuses a path masquerading as a file name: %j', async (name) => {
    await expect(useStore.getState().renameEntry('C:/project/main.cpp', name)).rejects.toThrow(/name/i)
    await expect(useStore.getState().createNewFile('C:/project', name)).rejects.toThrow(/name/i)
    await expect(useStore.getState().createNewFolder('C:/project', name)).rejects.toThrow(/name/i)
    expect(api.rename).not.toHaveBeenCalled()
    expect(api.createFile).not.toHaveBeenCalled()
    expect(api.createDir).not.toHaveBeenCalled()
  })
})
