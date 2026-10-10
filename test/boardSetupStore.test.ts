import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BoardStatus } from '../src/shared/ipc'

const api = {
  boardStatus: vi.fn(),
  setupBoardTools: vi.fn(),
  onBoardSetupProgress: vi.fn(),
  boardListConnected: vi.fn(),
  boardListAll: vi.fn(),
  detectToolchains: vi.fn(),
  lspServers: vi.fn(),
  envInspect: vi.fn()
}

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('window', { api })

const { useStore } = await import('../src/renderer/src/store/useStore')
const ready: BoardStatus = { available: true, version: '1.3.1', source: 'managed', setupRequired: false }
const missing: BoardStatus = { available: false, version: '', setupRequired: true }
let unsubscribe: ReturnType<typeof vi.fn>
let progress: (message: string) => void

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  unsubscribe = vi.fn()
  api.boardStatus.mockResolvedValue(missing)
  api.setupBoardTools.mockResolvedValue(ready)
  api.onBoardSetupProgress.mockImplementation((cb) => { progress = cb; return unsubscribe })
  api.boardListConnected.mockResolvedValue([])
  api.boardListAll.mockResolvedValue([])
  api.detectToolchains.mockResolvedValue([])
  api.lspServers.mockResolvedValue({})
  api.envInspect.mockResolvedValue(null)
  useStore.setState({
    boardStatus: null,
    boardSetupBusy: false,
    boardSetupMessage: '',
    boardSetupError: null,
    workspaceRoot: null,
    boards: [],
    boardTargets: [],
    notifications: []
  })
})

describe('in-app board tools setup', () => {
  it('automatically sets up a missing CLI and refreshes the installed board and toolchain lists', async () => {
    await useStore.getState().refreshBoardStatus()
    expect(api.setupBoardTools).toHaveBeenCalledOnce()
    expect(api.onBoardSetupProgress.mock.invocationCallOrder[0]).toBeLessThan(api.setupBoardTools.mock.invocationCallOrder[0])
    expect(useStore.getState()).toMatchObject({ boardStatus: ready, boardSetupBusy: false, boardSetupError: null })
    expect(api.boardListConnected).toHaveBeenCalledOnce()
    expect(api.boardListAll).toHaveBeenCalledOnce()
    expect(api.detectToolchains).toHaveBeenCalledWith(true)
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('initializes missing indexes even when the executable is already available', async () => {
    api.boardStatus.mockResolvedValue({ ...ready, setupRequired: true })
    useStore.setState({ workspaceRoot: 'C:/project' })
    await useStore.getState().refreshBoardStatus()
    expect(api.setupBoardTools).toHaveBeenCalledOnce()
    expect(api.envInspect).toHaveBeenCalledWith('C:/project', null, true, [])
  })

  it('does not start a download when the existing tools are ready', async () => {
    api.boardStatus.mockResolvedValue({ ...ready, source: 'path' })
    await useStore.getState().refreshBoardStatus()
    expect(api.setupBoardTools).not.toHaveBeenCalled()
    expect(api.onBoardSetupProgress).not.toHaveBeenCalled()
    expect(api.boardListAll).toHaveBeenCalledOnce()
  })

  it('joins repeated setup and refresh requests while showing streamed progress', async () => {
    const setup = deferred<BoardStatus>()
    api.setupBoardTools.mockReturnValue(setup.promise)
    const first = useStore.getState().setupBoardTools()
    const second = useStore.getState().setupBoardTools()
    const refresh = useStore.getState().refreshBoardStatus()
    expect(first).toBe(second)
    progress('Downloading board tools...')
    expect(useStore.getState()).toMatchObject({ boardSetupBusy: true, boardSetupMessage: 'Downloading board tools...' })
    expect(api.setupBoardTools).toHaveBeenCalledOnce()
    expect(api.boardStatus).not.toHaveBeenCalled()
    setup.resolve(ready)
    await Promise.all([first, second, refresh])
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('keeps an actionable error, avoids an automatic retry loop, and allows an explicit retry', async () => {
    api.setupBoardTools.mockRejectedValueOnce(new Error('Network unavailable'))
    await useStore.getState().refreshBoardStatus()
    expect(useStore.getState().boardSetupError).toContain('Network unavailable')
    expect(useStore.getState().boardSetupBusy).toBe(false)
    expect(useStore.getState().notifications.at(-1)?.title).toBe('Board tools setup failed')
    expect(unsubscribe).toHaveBeenCalledOnce()
    await useStore.getState().refreshBoardStatus()
    expect(api.setupBoardTools).toHaveBeenCalledOnce()
    await useStore.getState().setupBoardTools()
    expect(api.setupBoardTools).toHaveBeenCalledTimes(2)
    expect(useStore.getState().boardSetupError).toBeNull()
    expect(useStore.getState().boardStatus).toEqual(ready)
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })

  it('rejects a setup result whose indexes are still unavailable', async () => {
    api.setupBoardTools.mockResolvedValue({ ...ready, setupRequired: true, hint: 'Could not update the library index.' })
    await useStore.getState().setupBoardTools()
    expect(useStore.getState().boardSetupError).toContain('Could not update the library index.')
    expect(useStore.getState().boardSetupBusy).toBe(false)
    expect(api.boardListAll).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('does not overwrite a completed setup with an older status probe', async () => {
    const status = deferred<BoardStatus>()
    api.boardStatus.mockReturnValue(status.promise)
    const refresh = useStore.getState().refreshBoardStatus()
    await useStore.getState().setupBoardTools()
    status.resolve(missing)
    await refresh
    expect(useStore.getState().boardStatus).toEqual(ready)
    expect(api.setupBoardTools).toHaveBeenCalledOnce()
  })
})
