import { beforeEach, describe, expect, it, vi } from 'vitest'
import { langFromPath } from '../src/shared/languages'

const api = {
  writeFile: vi.fn(),
  runStart: vi.fn(),
  runStop: vi.fn(),
  boardCompile: vi.fn(),
  boardUpload: vi.fn(),
  coreInstall: vi.fn(),
  serialClose: vi.fn(),
  serialOpen: vi.fn()
}
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('window', { api })
const { useStore } = await import('../src/renderer/src/store/useStore')
const initial = useStore.getState()

function tab(path = 'C:/project/main.cpp') {
  return { path, name: path.split('/').pop()!, content: 'unsaved', savedContent: 'original', language: langFromPath(path), group: 0 as const }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.values(api).forEach((mock) => mock.mockReset().mockResolvedValue(undefined))
  api.serialOpen.mockResolvedValue(true)
  useStore.setState({
    ...initial,
    workspaceRoot: 'C:/project',
    tabs: [tab()],
    activePath: 'C:/project/main.cpp',
    running: false,
    runId: null,
    selectedFqbn: 'arduino:avr:uno',
    serialPath: 'COM5',
    serialOpen: false,
    boards: [{ address: 'COM5', protocol: 'serial', fqbn: 'arduino:avr:uno' }],
    notifications: []
  }, true)
})

const actions = ['runActive', 'buildActive', 'verifyBoard', 'uploadBoard'] as const
const launch = (action: typeof actions[number]) => action === 'runActive' || action === 'buildActive' ? api.runStart : action === 'verifyBoard' ? api.boardCompile : api.boardUpload

describe('PlatformIO project builds', () => {
  beforeEach(() => {
    useStore.setState({ tree: [{ name: 'platformio.ini', path: 'C:/project/platformio.ini', isDir: false }] })
  })

  it.each(['platformio.ini', 'include/driver.h', null])('builds the project with %s active', async file => {
    const active = file ? tab(`C:/project/${file}`) : null
    useStore.setState({ tabs: active ? [active] : [], activePath: active?.path ?? null })
    await useStore.getState().buildActive()
    expect(api.runStart).toHaveBeenCalledWith(expect.objectContaining({ cwd: 'C:/project', buildSystem: 'platformio', buildOnly: true }))
  })

  it('saves edited configuration and source files before starting the project build', async () => {
    const config = tab('C:/project/platformio.ini')
    useStore.setState({ tabs: [tab(), config] })
    await useStore.getState().buildActive()
    expect(api.writeFile).toHaveBeenCalledWith(config.path, config.content, config.savedContent)
    expect(useStore.getState().tabs.every(file => file.content === file.savedContent)).toBe(true)
    expect(api.runStart).toHaveBeenCalledOnce()
  })

  it.each(['src/main.cpp', 'src/main.c', 'firmware/controller.cpp'])('routes Run for %s to the board build without flashing hardware', async file => {
    const active = tab(`C:/project/${file}`)
    useStore.setState({ tabs: [active, tab('C:/project/platformio.ini')], activePath: active.path })
    await useStore.getState().runActive()
    expect(api.runStart).toHaveBeenCalledWith(expect.objectContaining({ cwd: 'C:/project', buildSystem: 'platformio', buildOnly: true }))
    expect(api.writeFile).toHaveBeenCalledWith('C:/project/platformio.ini', 'unsaved', 'original')
    expect(api.boardUpload).not.toHaveBeenCalled()
    expect(api.boardCompile).not.toHaveBeenCalled()
  })

  it.each(['tools/camera_preview.cpp', 'tools/native.c', 'src/main.py'])('keeps Run for %s on the laptop', async file => {
    const active = tab(`C:/project/${file}`)
    useStore.setState({ tabs: [active], activePath: active.path })
    await useStore.getState().runActive()
    expect(api.runStart).toHaveBeenCalledWith(expect.objectContaining({ filePath: active.path, language: active.language.id }))
    expect(api.runStart.mock.calls[0][0].buildOnly).not.toBe(true)
    expect(api.runStart.mock.calls[0][0].buildSystem).toBeUndefined()
    expect(api.boardUpload).not.toHaveBeenCalled()
  })

  it('does not build while another source file changes during Save All', async () => {
    const write = deferred<void>()
    const other = tab('C:/project/other.cpp')
    useStore.setState({ tabs: [tab(), other] })
    api.writeFile.mockReturnValue(write.promise)
    const building = useStore.getState().buildActive()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalled())
    useStore.getState().updateContent(other.path, 'newer edit')
    write.resolve(undefined)
    await building
    expect(api.runStart).not.toHaveBeenCalled()
    expect(useStore.getState().tabs.find(file => file.path === other.path)?.content).toBe('newer edit')
  })

  it('shows the compiler error and its location when a build fails', async () => {
    await useStore.getState().buildActive()
    const id = api.runStart.mock.calls[0][0].id
    useStore.getState().handleDiagnostics({ id, diagnostics: [{ file: 'C:/project/main.cpp', line: 2, column: 10, severity: 'error', message: 'ESP32Servo.h: No such file or directory' }] })
    useStore.getState().handleRunExit({ id, phase: 'compile', code: 1 })
    expect(useStore.getState().notifications.at(-1)?.detail).toContain('main.cpp:2: ESP32Servo.h: No such file or directory')
    expect(useStore.getState().bottomView).toBe('problems')
  })
})

describe('run and board preparation boundaries', () => {
  it.each(actions)('%s launches its saved target on the happy path', async (action) => {
    await useStore.getState()[action]()
    expect(launch(action)).toHaveBeenCalledOnce()
    expect(useStore.getState().running).toBe(true)
  })

  it.each(actions)('%s clears its own busy state when output admission is rejected', async (action) => {
    const message = 'This run id is still active or cancelling. Wait for it to finish before retrying.'
    launch(action).mockRejectedValueOnce(new Error(message))
    await useStore.getState()[action]()
    expect(launch(action)).toHaveBeenCalledOnce()
    expect(useStore.getState().running).toBe(false)
    expect(useStore.getState().runId).toBe(null)
    expect(useStore.getState().runPhase).toBe('idle')
    expect(useStore.getState().output.some((entry) => entry.stream === 'stderr' && entry.text.includes(message))).toBe(true)
  })

  it.each(actions)('%s does not launch an old project after its save finishes', async (action) => {
    const write = deferred<void>()
    api.writeFile.mockReturnValueOnce(write.promise)
    const preparing = useStore.getState()[action]()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    useStore.setState({ workspaceRoot: 'C:/other', tabs: [tab('C:/other/main.cpp')], activePath: 'C:/other/main.cpp' })
    write.resolve(undefined)
    await preparing
    expect(launch(action)).not.toHaveBeenCalled()
    expect(useStore.getState().running).toBe(false)
  })

  it.each(actions)('%s does not launch a different active file after saving', async (action) => {
    const write = deferred<void>()
    api.writeFile.mockReturnValueOnce(write.promise)
    const preparing = useStore.getState()[action]()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    useStore.setState({ tabs: [tab(), tab('C:/project/other.cpp')], activePath: 'C:/project/other.cpp' })
    write.resolve(undefined)
    await preparing
    expect(launch(action)).not.toHaveBeenCalled()
  })

  it.each(actions)('%s respects Stop during a pending save', async (action) => {
    const write = deferred<void>()
    api.writeFile.mockReturnValueOnce(write.promise)
    const preparing = useStore.getState()[action]()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    await useStore.getState().stopRun()
    write.resolve(undefined)
    await preparing
    expect(launch(action)).not.toHaveBeenCalled()
  })

  it.each(actions)('%s cannot launch stale bytes typed over while saving', async (action) => {
    const write = deferred<void>()
    api.writeFile.mockReturnValueOnce(write.promise)
    const preparing = useStore.getState()[action]()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    useStore.getState().updateContent('C:/project/main.cpp', 'new edit')
    write.resolve(undefined)
    await preparing
    expect(launch(action)).not.toHaveBeenCalled()
    expect(useStore.getState().tabs[0].content).toBe('new edit')
  })

  it.each(actions)('%s ignores a duplicate click while preparing', async (action) => {
    const write = deferred<void>()
    api.writeFile.mockReturnValueOnce(write.promise)
    const first = useStore.getState()[action]()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    const second = useStore.getState()[action]()
    write.resolve(undefined)
    await Promise.all([first, second])
    expect(launch(action)).toHaveBeenCalledOnce()
  })

  it.each(actions)('%s cancels a pending launch request with its own ID', async (action) => {
    const starting = deferred<void>()
    launch(action).mockReturnValueOnce(starting.promise)
    const preparing = useStore.getState()[action]()
    await vi.waitFor(() => expect(launch(action)).toHaveBeenCalledOnce())
    const id = launch(action).mock.calls[0][0].id
    await useStore.getState().stopRun()
    starting.resolve(undefined)
    await preparing
    expect(api.runStop).toHaveBeenCalledWith(id)
    expect(useStore.getState().runId).toBe(null)
    expect(useStore.getState().running).toBe(false)
  })

  it.each(actions)('%s cannot overwrite a newer run with a stale launch error', async (action) => {
    const starting = deferred<void>()
    launch(action).mockReturnValueOnce(starting.promise)
    const preparing = useStore.getState()[action]()
    await vi.waitFor(() => expect(launch(action)).toHaveBeenCalledOnce())
    await useStore.getState().stopRun()
    useStore.setState({ runId: 'newer-run', running: true, runPhase: 'run', runAction: 'run', output: [{ stream: 'system', text: 'New project output' }] })
    starting.reject(new Error('Late failure'))
    await preparing
    expect(useStore.getState().runId).toBe('newer-run')
    expect(useStore.getState().running).toBe(true)
    expect(useStore.getState().output[0].text).toBe('New project output')
  })

  it.each(['verifyBoard', 'uploadBoard'] as const)('%s cancels if the selected board changes during saving', async (action) => {
    const write = deferred<void>()
    api.writeFile.mockReturnValueOnce(write.promise)
    const preparing = useStore.getState()[action]()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    useStore.setState({ selectedFqbn: 'esp32:esp32:esp32' })
    write.resolve(undefined)
    await preparing
    expect(launch(action)).not.toHaveBeenCalled()
  })

  it('cancels upload if the chosen port changes during saving', async () => {
    const write = deferred<void>()
    api.writeFile.mockReturnValueOnce(write.promise)
    const preparing = useStore.getState().uploadBoard()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    useStore.setState({ serialPath: 'COM7' })
    write.resolve(undefined)
    await preparing
    expect(api.boardUpload).not.toHaveBeenCalled()
  })

  it('does not choose the first of two identical connected boards', async () => {
    useStore.setState({ serialPath: '', boards: [
      { address: 'COM5', protocol: 'serial', fqbn: 'arduino:avr:uno' },
      { address: 'COM7', protocol: 'serial', fqbn: 'arduino:avr:uno' }
    ] })
    await useStore.getState().uploadBoard()
    expect(api.boardUpload).not.toHaveBeenCalled()
    expect(useStore.getState().output[0].text).toContain('Pick a port')
  })

  it('accepts one unambiguous matching board when no port is explicitly chosen', async () => {
    useStore.setState({ serialPath: '' })
    await useStore.getState().uploadBoard()
    expect(api.boardUpload).toHaveBeenCalledWith(expect.objectContaining({ port: 'COM5' }))
  })

  it('accepts an explicit port even with two matching boards', async () => {
    useStore.setState({ serialPath: 'COM7', boards: [
      { address: 'COM5', protocol: 'serial', fqbn: 'arduino:avr:uno' },
      { address: 'COM7', protocol: 'serial', fqbn: 'arduino:avr:uno' }
    ] })
    await useStore.getState().uploadBoard()
    expect(api.boardUpload).toHaveBeenCalledWith(expect.objectContaining({ port: 'COM7' }))
  })

  it('cancels an implicit upload port if board discovery becomes ambiguous while saving', async () => {
    const write = deferred<void>()
    useStore.setState({ serialPath: '' })
    api.writeFile.mockReturnValueOnce(write.promise)
    const preparing = useStore.getState().uploadBoard()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    useStore.setState({ boards: [
      { address: 'COM5', protocol: 'serial', fqbn: 'arduino:avr:uno' },
      { address: 'COM7', protocol: 'serial', fqbn: 'arduino:avr:uno' }
    ] })
    write.resolve(undefined)
    await preparing
    expect(api.boardUpload).not.toHaveBeenCalled()
  })

  it('keeps an open serial monitor open if the sketch cannot be saved', async () => {
    useStore.setState({ serialOpen: true })
    api.writeFile.mockRejectedValueOnce(new Error('Disk full'))
    await expect(useStore.getState().uploadBoard()).rejects.toThrow('Disk full')
    expect(api.serialClose).not.toHaveBeenCalled()
    expect(useStore.getState().serialOpen).toBe(true)
  })

  it('does not upload an old target if it changes while closing the serial monitor', async () => {
    const closing = deferred<void>()
    useStore.setState({ serialOpen: true })
    api.serialClose.mockReturnValueOnce(closing.promise)
    const preparing = useStore.getState().uploadBoard()
    await vi.waitFor(() => expect(api.serialClose).toHaveBeenCalledOnce())
    useStore.setState({ serialPath: 'COM7' })
    closing.resolve(undefined)
    await preparing
    expect(api.boardUpload).not.toHaveBeenCalled()
  })

  it('does not let an old serial close alter a new project monitor', async () => {
    const closing = deferred<void>()
    useStore.setState({ serialOpen: true })
    api.serialClose.mockReturnValueOnce(closing.promise)
    const preparing = useStore.getState().uploadBoard()
    await vi.waitFor(() => expect(api.serialClose).toHaveBeenCalledOnce())
    useStore.setState({ workspaceRoot: 'C:/other', activePath: 'C:/other/main.cpp', tabs: [tab('C:/other/main.cpp')], serialPath: 'COM7', serialOpen: true })
    closing.resolve(undefined)
    await preparing
    expect(api.boardUpload).not.toHaveBeenCalled()
    expect(useStore.getState().serialOpen).toBe(true)
  })

  it('cancels upload rather than close over a newer monitor operation on the same port', async () => {
    const closing = deferred<void>()
    useStore.setState({ serialOpen: true })
    api.serialClose.mockReturnValueOnce(closing.promise)
    const preparing = useStore.getState().uploadBoard()
    await vi.waitFor(() => expect(api.serialClose).toHaveBeenCalledOnce())
    useStore.setState({ serialOpen: false })
    await useStore.getState().toggleSerial()
    closing.resolve(undefined)
    await preparing
    expect(api.boardUpload).not.toHaveBeenCalled()
    expect(useStore.getState().serialOpen).toBe(true)
  })

  it('does not let a stale upload completion clear a newer upload monitor restore', async () => {
    const oldStarting = deferred<void>()
    const newStarting = deferred<void>()
    useStore.setState({ serialOpen: true })
    api.boardUpload.mockReturnValueOnce(oldStarting.promise).mockReturnValueOnce(newStarting.promise)
    const oldUpload = useStore.getState().uploadBoard()
    await vi.waitFor(() => expect(api.boardUpload).toHaveBeenCalledOnce())
    await useStore.getState().stopRun()
    useStore.setState({ serialOpen: true, serialPath: 'COM7' })
    const newUpload = useStore.getState().uploadBoard()
    await vi.waitFor(() => expect(api.boardUpload).toHaveBeenCalledTimes(2))
    oldStarting.resolve(undefined)
    await oldUpload
    newStarting.resolve(undefined)
    await newUpload
    const id = api.boardUpload.mock.calls[1][0].id
    useStore.getState().handleRunExit({ id, phase: 'compile', code: 0 })
    await vi.waitFor(() => expect(api.serialOpen).toHaveBeenCalledWith({ path: 'COM7', baudRate: initial.serialBaud }))
  })

  it('does not start a package operation while a run is preparing its save', async () => {
    const write = deferred<void>()
    api.writeFile.mockReturnValueOnce(write.promise)
    const preparing = useStore.getState().runActive()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    const installing = useStore.getState().installCore('arduino:avr')
    // Complete the old package implementation if it incorrectly started, so
    // this negative regression does not leave a pending operation behind.
    if (api.coreInstall.mock.calls.length) {
      const id = api.coreInstall.mock.calls[0][0].id
      useStore.getState().handleRunExit({ id, phase: 'run', code: 0 })
    }
    write.resolve(undefined)
    await Promise.all([preparing, installing])
    expect(api.coreInstall).not.toHaveBeenCalled()
    expect(api.runStart).toHaveBeenCalledOnce()
  })

  it('restores the same monitor if the upload request fails to start', async () => {
    useStore.setState({ serialOpen: true })
    api.boardUpload.mockRejectedValueOnce(new Error('CLI unavailable'))
    await useStore.getState().uploadBoard()
    await vi.waitFor(() => expect(api.serialOpen).toHaveBeenCalledWith({ path: 'COM5', baudRate: initial.serialBaud }))
    expect(useStore.getState().running).toBe(false)
  })

  it('reopens the original monitor when its upload completes', async () => {
    useStore.setState({ serialOpen: true })
    await useStore.getState().uploadBoard()
    const id = api.boardUpload.mock.calls[0][0].id
    useStore.getState().handleRunExit({ id, phase: 'compile', code: 0 })
    await vi.waitFor(() => expect(api.serialOpen).toHaveBeenCalledWith({ path: 'COM5', baudRate: initial.serialBaud }))
  })

  it('clears the serial monitor only after a successful upload', async () => {
    const old = { serialLines: [{ text: 'old firmware', ts: 1 }], serialCarry: 'partial', plotSeries: { a: [1] } }
    useStore.setState(old)
    await useStore.getState().uploadBoard()
    useStore.getState().handleRunExit({ id: api.boardUpload.mock.calls[0][0].id, phase: 'compile', code: 1 })
    expect(useStore.getState().serialLines).toEqual(old.serialLines)

    await useStore.getState().uploadBoard()
    useStore.getState().handleRunExit({ id: api.boardUpload.mock.calls[1][0].id, phase: 'compile', code: 0 })
    expect(useStore.getState()).toMatchObject({ serialLines: [], serialCarry: '', plotSeries: {} })
  })

  it('does not open a newly selected port when an old upload completes', async () => {
    useStore.setState({ serialOpen: true })
    await useStore.getState().uploadBoard()
    const id = api.boardUpload.mock.calls[0][0].id
    useStore.setState({ serialPath: 'COM7' })
    useStore.getState().handleRunExit({ id, phase: 'compile', code: 0 })
    expect(api.serialOpen).not.toHaveBeenCalled()
  })
})
