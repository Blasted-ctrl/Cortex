import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileReadResult } from '../src/shared/ipc'
import { langFromPath } from '../src/shared/languages'

const api = { readFile: vi.fn(), writeFile: vi.fn() }
vi.stubGlobal('window', { api })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
const { useStore } = await import('../src/renderer/src/store/useStore')
const initial = useStore.getState()
const root = 'C:/owned-git-reconciliation'
const path = `${root}/main.cpp`
const tab = (content = 'original', target = path) => ({ path: target, name: target.split('/').at(-1)!, content, savedContent: content, language: langFromPath(target), group: 0 as const })
let releases: Array<() => void>
let operations: Promise<unknown>[]
function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  releases.push(() => resolve(fallback))
  return { promise, resolve, reject }
}
function track<T>(operation: Promise<T>): Promise<T> { operations.push(operation); return operation }

beforeEach(() => {
  releases = []
  operations = []
  api.readFile.mockReset().mockResolvedValue({ kind: 'text', content: 'disk' })
  api.writeFile.mockReset().mockResolvedValue(undefined)
  useStore.setState({ ...initial, workspaceRoot: root, tabs: [tab()], activePath: path, groupActive: { 0: path, 1: null }, notifications: [], confirm: vi.fn().mockResolvedValue(true) }, true)
})
afterEach(async () => {
  const finished = Promise.allSettled(operations)
  releases.forEach(release => release())
  await finished
})

describe('Git-triggered clean-tab reconciliation', () => {
  it('adopts exact disk bytes without writing or prompting', async () => {
    api.readFile.mockResolvedValueOnce({ kind: 'text', content: '\ufeffdisk\r\n' })
    await useStore.getState().reloadOpenTabsFromDisk()
    expect(useStore.getState().tabs[0]).toMatchObject({ content: '\ufeffdisk\r\n', savedContent: '\ufeffdisk\r\n' })
    expect(api.writeFile).not.toHaveBeenCalled()
    expect(useStore.getState().confirm).not.toHaveBeenCalled()
  })

  it('does not read or discard an already dirty buffer', async () => {
    useStore.getState().updateContent(path, 'local typing')
    await useStore.getState().reloadOpenTabsFromDisk()
    expect(useStore.getState().tabs[0]).toMatchObject({ content: 'local typing', savedContent: 'original' })
    expect(api.readFile).not.toHaveBeenCalled()
    expect(useStore.getState().confirm).not.toHaveBeenCalled()
  })

  it.each(['binary', 'too-large'] as const)('closes a clean editable tab that became %s', async (kind) => {
    api.readFile.mockResolvedValueOnce(kind === 'too-large' ? { kind, size: 5 } : { kind })
    await useStore.getState().reloadOpenTabsFromDisk()
    expect(useStore.getState().tabs).toEqual([])
    expect(useStore.getState().confirm).not.toHaveBeenCalled()
  })

  it('drops a stale placeholder when the file becomes editable text', async () => {
    useStore.setState({ tabs: [{ ...tab(''), readOnlyReason: 'Binary file' }] })
    await useStore.getState().reloadOpenTabsFromDisk()
    expect(useStore.getState().tabs).toEqual([])
  })

  it('retains a placeholder that is still nontext', async () => {
    const placeholder = { ...tab(''), readOnlyReason: 'Binary file' }
    useStore.setState({ tabs: [placeholder] })
    api.readFile.mockResolvedValueOnce({ kind: 'binary' })
    await useStore.getState().reloadOpenTabsFromDisk()
    expect(useStore.getState().tabs).toEqual([placeholder])
  })

  it.each([
    'ENOENT: no such file or directory',
    "Error invoking remote method 'fs:readFile': Error: ENOENT: no such file or directory"
  ])('closes an owned clean tab on a missing-file errno prefix: %s', async (message) => {
    api.readFile.mockRejectedValueOnce(new Error(message))
    await useStore.getState().reloadOpenTabsFromDisk()
    expect(useStore.getState().tabs).toEqual([])
    expect(useStore.getState().notifications).toEqual([])
  })

  it.each([
    'EACCES: permission denied',
    'Read failed',
    "EACCES: permission denied, open '/project/ENOENT:main.cpp'",
    "Error invoking remote method 'fs:readFile': Error: EACCES: permission denied, open '/project/ENOENT:main.cpp'",
    "Refused file '/project/ENOENT:main.cpp' outside the workspace"
  ])('retains the buffer and reports an owned read failure: %s', async (message) => {
    const original = useStore.getState().tabs[0]
    api.readFile.mockRejectedValueOnce(new Error(message))
    await useStore.getState().reloadOpenTabsFromDisk()
    expect(useStore.getState().tabs[0]).toBe(original)
    expect(api.writeFile).not.toHaveBeenCalled()
    expect(useStore.getState().confirm).not.toHaveBeenCalled()
    expect(useStore.getState().notifications).toEqual([expect.objectContaining({ kind: 'error', title: 'Could not reload main.cpp', detail: expect.stringMatching(/kept.*retry|retry.*kept/i) })])
  })

  for (const change of ['reopen', 'edit-save', 'workspace-aba'] as const) {
    it.each(['success', 'missing', 'error'] as const)(`ignores a delayed %s after ${change}`, async (result) => {
      const read = deferred<FileReadResult>({ kind: 'text', content: 'old disk' })
      api.readFile.mockReturnValueOnce(read.promise)
      const reloading = track(useStore.getState().reloadOpenTabsFromDisk())
      if (change === 'reopen') {
        await useStore.getState().closeTab(path)
        useStore.setState({ tabs: [tab('replacement')], activePath: path, groupActive: { 0: path, 1: null } })
      } else if (change === 'edit-save') {
        useStore.getState().updateContent(path, 'new saved text')
        await useStore.getState().saveActive()
      } else {
        useStore.setState({ workspaceRoot: 'C:/other', tabs: [] })
        useStore.setState({ workspaceRoot: root, tabs: [tab('new session')] })
      }
      const current = useStore.getState().tabs[0]
      if (result === 'success') read.resolve({ kind: 'text', content: 'old disk' })
      else read.reject(new Error(result === 'missing' ? 'ENOENT: old file missing' : 'EACCES: old read refused'))
      await reloading
      expect(useStore.getState().tabs[0]).toBe(current)
      expect(useStore.getState().confirm).not.toHaveBeenCalled()
      expect(useStore.getState().notifications).toEqual([])
    })
  }

  it('keeps typing that arrives while the read is pending without a discard prompt', async () => {
    const read = deferred<FileReadResult>({ kind: 'text', content: 'old disk' })
    api.readFile.mockReturnValueOnce(read.promise)
    const reloading = track(useStore.getState().reloadOpenTabsFromDisk())
    useStore.getState().updateContent(path, 'typed during read')
    read.reject(new Error('ENOENT: no such file'))
    await reloading
    expect(useStore.getState().tabs[0]).toMatchObject({ content: 'typed during read', savedContent: 'original' })
    expect(useStore.getState().confirm).not.toHaveBeenCalled()
  })

  it.each(['success', 'error'] as const)('a later failed reconciliation invalidates an older %s', async (result) => {
    const read = deferred<FileReadResult>({ kind: 'text', content: 'obsolete' })
    api.readFile.mockReturnValueOnce(read.promise).mockRejectedValueOnce(new Error('EACCES: current read refused'))
    const earlier = track(useStore.getState().reloadOpenTabsFromDisk())
    await useStore.getState().reloadOpenTabsFromDisk()
    const current = useStore.getState().tabs[0]
    const notices = useStore.getState().notifications
    if (result === 'success') read.resolve({ kind: 'text', content: 'obsolete' })
    else read.reject(new Error('ENOENT: obsolete missing'))
    await earlier
    expect(useStore.getState().tabs[0]).toBe(current)
    expect(useStore.getState().notifications).toEqual(notices)
    expect(notices).toHaveLength(1)
  })

  it('does not acquire a replacement second tab while awaiting the first tab', async () => {
    const second = `${root}/second.cpp`
    useStore.setState({ tabs: [tab(), tab('original second', second)] })
    const read = deferred<FileReadResult>({ kind: 'text', content: 'first disk' })
    api.readFile.mockReturnValueOnce(read.promise)
    const reloading = track(useStore.getState().reloadOpenTabsFromDisk())
    const replacement = tab('replacement second', second)
    useStore.setState({ tabs: [useStore.getState().tabs[0], replacement] })
    read.resolve({ kind: 'text', content: 'first disk' })
    await reloading
    expect(useStore.getState().tabs[1]).toBe(replacement)
    expect(api.readFile).toHaveBeenCalledTimes(1)
  })
})

describe('save-waiting tab closes', () => {
  it('still closes after its own normal successful save without a discard prompt', async () => {
    useStore.getState().updateContent(path, 'saved on close')
    const write = deferred<void>(undefined)
    api.writeFile.mockReturnValueOnce(write.promise)
    const saving = track(useStore.getState().saveActive())
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    const closing = track(useStore.getState().closeTab(path))
    expect(useStore.getState().tabs).toHaveLength(1)
    write.resolve(undefined)
    await Promise.all([saving, closing])
    expect(useStore.getState().tabs).toEqual([])
    expect(useStore.getState().confirm).not.toHaveBeenCalled()
  })

  it('does not close a same-path replacement opened during the save wait', async () => {
    const write = deferred<void>(undefined)
    api.writeFile.mockReturnValueOnce(write.promise)
    const saving = track(useStore.getState().saveActive())
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    const closing = track(useStore.getState().closeTab(path))
    useStore.setState({ tabs: [] })
    useStore.setState({ tabs: [tab()] })
    write.resolve(undefined)
    await Promise.all([saving, closing])
    expect(useStore.getState().tabs).toHaveLength(1)
    expect(useStore.getState().confirm).not.toHaveBeenCalled()
  })

  it('keeps a failed save when discard is cancelled and permits a later save and close', async () => {
    useStore.getState().updateContent(path, 'retry this edit')
    useStore.setState({ confirm: vi.fn().mockResolvedValue(false) })
    const write = deferred<void>(undefined)
    api.writeFile.mockReturnValueOnce(write.promise)
    const saving = track(useStore.getState().saveActive())
    const failed = expect(saving).rejects.toThrow('Disk full')
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    const closing = track(useStore.getState().closeTab(path))
    write.reject(new Error('Disk full'))
    await Promise.all([failed, closing])
    expect(useStore.getState().tabs[0]).toMatchObject({ content: 'retry this edit', savedContent: 'original' })
    expect(useStore.getState().notifications).toHaveLength(1)
    await useStore.getState().saveActive()
    await useStore.getState().closeTab(path)
    expect(useStore.getState().tabs).toEqual([])
    expect(useStore.getState().confirm).toHaveBeenCalledOnce()
  })

  it('does not discard typing during a reconciliation close waiting for a save', async () => {
    const write = deferred<void>(undefined)
    api.writeFile.mockReturnValueOnce(write.promise)
    const saving = track(useStore.getState().saveActive())
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    api.readFile.mockResolvedValueOnce({ kind: 'binary' })
    const reloading = track(useStore.getState().reloadOpenTabsFromDisk())
    await Promise.resolve()
    useStore.getState().updateContent(path, 'new typing')
    write.resolve(undefined)
    await Promise.all([saving, reloading])
    expect(useStore.getState().tabs[0]).toMatchObject({ content: 'new typing', savedContent: 'original' })
    expect(useStore.getState().confirm).not.toHaveBeenCalled()
  })
})
