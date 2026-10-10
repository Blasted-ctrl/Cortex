import { beforeEach, describe, expect, it, vi } from 'vitest'
import { langFromPath } from '../src/shared/languages'

const api = {
  exists: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), createDir: vi.fn(), readDir: vi.fn(),
  getProjectConfig: vi.fn(), watchStart: vi.fn(), watchStop: vi.fn(), lspDisposeRoot: vi.fn(), lspServers: vi.fn(),
  detectToolchains: vi.fn(), simStart: vi.fn(), simStop: vi.fn()
}
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('window', { api, confirm: vi.fn(() => true) })
const { useStore, workspaceScopedReset } = await import('../src/renderer/src/store/useStore')
const initial = useStore.getState()
const compiler = { id: 'g++', name: 'GCC', command: 'g++', kind: 'cpp' as const, available: true, version: 'fixture' }

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

function tab(path = 'C:/fixture/blink.ino') {
  const content = 'void setup() {}\nvoid loop() {}\n'
  return { path, name: path.split('/').pop()!, content, savedContent: content, language: langFromPath(path), group: 0 as const }
}

beforeEach(() => {
  for (const mock of Object.values(api)) mock.mockReset()
  api.exists.mockResolvedValue(false)
  api.readFile.mockResolvedValue({ kind: 'text', content: '' })
  api.writeFile.mockResolvedValue(undefined)
  api.createDir.mockResolvedValue(undefined)
  api.readDir.mockResolvedValue([])
  api.getProjectConfig.mockResolvedValue({})
  api.watchStart.mockResolvedValue(undefined)
  api.watchStop.mockResolvedValue(undefined)
  api.lspDisposeRoot.mockResolvedValue(undefined)
  api.lspServers.mockResolvedValue({})
  api.detectToolchains.mockResolvedValue([compiler])
  api.simStart.mockResolvedValue(undefined)
  api.simStop.mockResolvedValue(undefined)
  vi.mocked(window.confirm).mockReset().mockReturnValue(true)
  useStore.setState({
    ...initial, ...workspaceScopedReset(), workspaceRoot: 'C:/fixture', workspaceName: 'fixture',
    tabs: [tab()], activePath: 'C:/fixture/blink.ino', groupActive: { 0: 'C:/fixture/blink.ino' },
    toolchains: [compiler], mainView: 'editor', notifications: [],
    stopRun: vi.fn().mockResolvedValue(undefined), stopDebug: vi.fn(), cancelAgent: vi.fn(),
    refreshBoardStatus: vi.fn().mockResolvedValue(undefined), refreshProjectModel: vi.fn().mockResolvedValue(undefined)
  }, true)
})

describe('circuit save lifecycle', () => {
  it('serializes overlapping snapshots and waits for the latest circuit during Save All', async () => {
    useStore.setState({ tabs: [], activePath: null, simDiagramDirty: true })
    const first = deferred<void>()
    api.writeFile.mockReturnValueOnce(first.promise)
    const saveFirst = useStore.getState().saveDiagram().catch((error: Error) => error.message)
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    const firstSnapshot = api.writeFile.mock.calls[0][1]
    useStore.getState().movePart(useStore.getState().simParts[0].id, 400, 200)
    const saveSecond = useStore.getState().saveDiagram()
    let flushed = false
    const flushing = useStore.getState().saveAll().then(() => { flushed = true })
    await Promise.resolve()
    expect(api.writeFile).toHaveBeenCalledOnce()
    expect(flushed).toBe(false)
    first.resolve(undefined)
    expect(await saveFirst).toContain('changed while saving')
    await Promise.all([saveSecond, flushing])
    expect(api.writeFile).toHaveBeenCalledTimes(2)
    expect(api.writeFile.mock.calls[1][2]).toBe(firstSnapshot)
    expect(JSON.parse(api.writeFile.mock.calls[1][1]).parts[0]).toMatchObject({ x: 400, y: 200 })
    expect(useStore.getState().simDiagramDirty).toBe(false)
  })

  it.each(['close', 'switch'])('waits for a pending clean circuit save before project %s', async (action) => {
    useStore.setState({ tabs: [], activePath: null, simDiagramDirty: false })
    const write = deferred<void>()
    api.writeFile.mockReturnValueOnce(write.promise)
    const saving = useStore.getState().saveDiagram()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    const changing = action === 'close' ? useStore.getState().closeWorkspace() : useStore.getState().openWorkspace('C:/other')
    await Promise.resolve()
    expect(api.watchStop).not.toHaveBeenCalled()
    expect(useStore.getState().workspaceRoot).toBe('C:/fixture')
    write.resolve(undefined)
    await Promise.all([saving, changing])
    expect(useStore.getState().workspaceRoot).toBe(action === 'close' ? null : 'C:/other')
  })

  it('keeps the loaded disk baseline when an external program edits the circuit', async () => {
    const original = JSON.stringify({ version: 3, board: 'uno', parts: [], wires: [] })
    let disk = original
    api.exists.mockResolvedValue(true)
    api.readFile.mockImplementation(async () => ({ kind: 'text', content: disk }))
    api.writeFile.mockImplementation(async (_path, content, expected) => {
      if (expected !== disk) throw new Error('This file changed on disk.')
      disk = content
    })
    await useStore.getState().loadDiagram()
    useStore.getState().addPart('led')
    disk = 'external circuit changes'
    await expect(useStore.getState().saveDiagram()).rejects.toThrow('changed on disk')
    expect(api.writeFile.mock.calls[0][2]).toBe(original)
    expect(disk).toBe('external circuit changes')
    expect(useStore.getState().simDiagramDirty).toBe(true)
  })

  it('guards a previously missing diagram and explicitly confirmed corrupt JSON', async () => {
    await useStore.getState().loadDiagram()
    await useStore.getState().saveDiagram()
    expect(api.writeFile.mock.calls[0][2]).toBeNull()
    const corrupt = '{ invalid JSON'
    api.exists.mockResolvedValue(true)
    api.readFile.mockResolvedValue({ kind: 'text', content: corrupt })
    await useStore.getState().loadDiagram()
    expect(useStore.getState().simDiagramError).not.toBeNull()
    useStore.getState().addPart('led')
    await useStore.getState().saveDiagram()
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Replace that file'))
    expect(api.writeFile.mock.calls[1][2]).toBe(corrupt)
  })
})

describe('simulation start lifecycle', () => {
  it('starts only once when Run is clicked again during compiler detection', async () => {
    const detection = deferred<typeof compiler[]>()
    api.detectToolchains.mockReturnValueOnce(detection.promise)
    useStore.setState({ toolchains: [] })
    const first = useStore.getState().startSim()
    const second = useStore.getState().startSim()
    expect(api.detectToolchains).toHaveBeenCalledOnce()
    detection.resolve([compiler])
    await Promise.all([first, second])
    expect(api.simStart).toHaveBeenCalledOnce()
    expect(useStore.getState().simRunning).toBe(true)
  })

  it('cancels an old launch when its project switches during compiler detection', async () => {
    const detection = deferred<typeof compiler[]>()
    api.detectToolchains.mockReturnValueOnce(detection.promise)
    useStore.setState({ toolchains: [] })
    const starting = useStore.getState().startSim()
    await useStore.getState().openWorkspace('C:/other')
    detection.resolve([compiler])
    await starting
    expect(api.simStart).not.toHaveBeenCalled()
    expect(useStore.getState()).toMatchObject({ workspaceRoot: 'C:/other', simRunning: false, simRunId: null, simSerial: [], mainView: 'editor' })
  })

  it('cancels a stopped launch even before a run id exists', async () => {
    const detection = deferred<typeof compiler[]>()
    api.detectToolchains.mockReturnValueOnce(detection.promise)
    useStore.setState({ toolchains: [] })
    const starting = useStore.getState().startSim()
    await useStore.getState().stopSim()
    detection.resolve([compiler])
    await starting
    expect(api.simStart).not.toHaveBeenCalled()
    expect(useStore.getState().simRunning).toBe(false)
  })

  it.each(['detect', 'save'])('does not launch the old file after its active tab changes during %s', async (phase) => {
    const pending = deferred<void>()
    if (phase === 'detect') {
      useStore.setState({ toolchains: [] })
      api.detectToolchains.mockImplementationOnce(async () => { await pending.promise; return [compiler] })
    } else api.writeFile.mockReturnValueOnce(pending.promise)
    const starting = useStore.getState().startSim()
    if (phase === 'save') await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    useStore.setState({ tabs: [tab(), tab('C:/fixture/other.ino')], activePath: 'C:/fixture/other.ino' })
    pending.resolve(undefined)
    await starting
    expect(api.simStart).not.toHaveBeenCalled()
    expect(useStore.getState().simRunning).toBe(false)
  })

  it('stops a late process start after Stop cancelled an in-flight launch', async () => {
    const launch = deferred<void>()
    api.simStart.mockReturnValueOnce(launch.promise)
    const starting = useStore.getState().startSim()
    await vi.waitFor(() => expect(api.simStart).toHaveBeenCalledOnce())
    const id = api.simStart.mock.calls[0][0].id
    await useStore.getState().stopSim()
    launch.resolve(undefined)
    await starting
    expect(api.simStop.mock.calls).toEqual([[id], [id]])
    expect(useStore.getState().simRunning).toBe(false)
  })

  it.each(['edit', 'read-only'])('does not simulate stale disk content when the tab changes during save: %s', async (change) => {
    const write = deferred<void>()
    api.writeFile.mockReturnValueOnce(write.promise)
    const starting = useStore.getState().startSim()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    useStore.setState({ tabs: useStore.getState().tabs.map((entry) => ({
      ...entry,
      ...(change === 'edit' ? { content: `${entry.content}// new unsaved edit\n` } : { readOnlyReason: 'File is no longer writable.' })
    })) })
    write.resolve(undefined)
    await starting
    expect(api.simStart).not.toHaveBeenCalled()
    expect(useStore.getState().simRunning).toBe(false)
    if (change === 'edit') expect(useStore.getState().tabs[0].content).not.toBe(useStore.getState().tabs[0].savedContent)
  })

  it('keeps a failed old launch from writing errors into the newly opened project', async () => {
    const launch = deferred<void>()
    api.simStart.mockReturnValueOnce(launch.promise)
    const starting = useStore.getState().startSim()
    await vi.waitFor(() => expect(api.simStart).toHaveBeenCalledOnce())
    await useStore.getState().openWorkspace('C:/other')
    launch.reject(new Error('old project compilation failed'))
    await starting
    expect(useStore.getState()).toMatchObject({ workspaceRoot: 'C:/other', simSerial: [], simRunning: false, simRunId: null })
  })
})
