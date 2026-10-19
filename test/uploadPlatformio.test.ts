import { beforeEach, describe, expect, it, vi } from 'vitest'
import { langFromPath } from '../src/shared/languages'

const api = {
  writeFile: vi.fn(),
  runStart: vi.fn(),
  runStop: vi.fn(),
  serialClose: vi.fn(),
  serialOpen: vi.fn(),
  serialList: vi.fn()
}
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('window', { api })
const { useStore } = await import('../src/renderer/src/store/useStore')
const initial = useStore.getState()

const BT3 = { path: 'COM3' }
const BT4 = { path: 'COM4' }
const ESP = { path: 'COM5', vendorId: '10C4' }

function tab(path = 'C:/project/src/main.cpp') {
  return { path, name: path.split('/').pop()!, content: 'unsaved', savedContent: 'original', language: langFromPath(path), group: 0 as const }
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.values(api).forEach((mock) => mock.mockReset().mockResolvedValue(undefined))
  api.serialList.mockResolvedValue([BT3, BT4, ESP])
  useStore.setState({
    ...initial,
    workspaceRoot: 'C:/project',
    tree: [{ name: 'platformio.ini', path: 'C:/project/platformio.ini', isDir: false }],
    tabs: [tab()],
    activePath: 'C:/project/src/main.cpp',
    running: false,
    runId: null,
    serialPath: '',
    serialOpen: false,
    ports: [],
    notifications: []
  }, true)
})

describe('PlatformIO upload', () => {
  it('saves, then builds and flashes the only USB serial device, not a Bluetooth link', async () => {
    await useStore.getState().uploadPlatformio()
    expect(api.writeFile).toHaveBeenCalledWith('C:/project/src/main.cpp', 'unsaved', 'original')
    expect(api.runStart).toHaveBeenCalledOnce()
    expect(api.runStart).toHaveBeenCalledWith(expect.objectContaining({
      cwd: 'C:/project', buildSystem: 'platformio', buildOnly: true, uploadPort: 'COM5'
    }))
    expect(useStore.getState().runAction).toBe('upload')
    expect(useStore.getState().running).toBe(true)
  })

  it('uses the explicitly selected port', async () => {
    useStore.setState({ serialPath: 'COM3' })
    await useStore.getState().uploadPlatformio()
    expect(api.runStart).toHaveBeenCalledWith(expect.objectContaining({ uploadPort: 'COM3' }))
  })

  it('refuses to guess between two boards and says what to do', async () => {
    api.serialList.mockResolvedValue([BT3, ESP, { path: 'COM6', vendorId: '1A86' }])
    await useStore.getState().uploadPlatformio()
    expect(api.runStart).not.toHaveBeenCalled()
    expect(useStore.getState().running).toBe(false)
    expect(useStore.getState().output[0].text).toMatch(/More than one serial device.*Serial & Devices/)
  })

  it('explains a missing board instead of flashing something else', async () => {
    api.serialList.mockResolvedValue([BT3, BT4])
    await useStore.getState().uploadPlatformio()
    expect(api.runStart).not.toHaveBeenCalled()
    expect(useStore.getState().output[0].text).toMatch(/No USB serial device.*data cable/)
  })

  it('releases the serial monitor before flashing when it holds that port', async () => {
    useStore.setState({ serialPath: 'COM5', serialOpen: true })
    await useStore.getState().uploadPlatformio()
    expect(api.serialClose).toHaveBeenCalledOnce()
    expect(api.serialClose.mock.invocationCallOrder[0]).toBeLessThan(api.runStart.mock.invocationCallOrder[0])
    expect(useStore.getState().serialOpen).toBe(false)
  })

  it('flashes the explicitly selected port even when another USB device is listed, closing its monitor', async () => {
    useStore.setState({ serialPath: 'COM3', serialOpen: true })
    api.serialList.mockResolvedValue([BT3, ESP])
    await useStore.getState().uploadPlatformio()
    expect(api.runStart).toHaveBeenCalledWith(expect.objectContaining({ uploadPort: 'COM3' }))
    expect(api.serialClose).toHaveBeenCalledOnce()
  })

  it('does nothing outside a PlatformIO project', async () => {
    useStore.setState({ tree: [] })
    await useStore.getState().uploadPlatformio()
    expect(api.runStart).not.toHaveBeenCalled()
    expect(api.serialList).not.toHaveBeenCalled()
  })

  it('does not start a second operation while one is running', async () => {
    useStore.setState({ running: true })
    await useStore.getState().uploadPlatformio()
    expect(api.runStart).not.toHaveBeenCalled()
  })

  it('never flashes from Build or Run, only from Upload', async () => {
    await useStore.getState().buildActive()
    expect(api.runStart).toHaveBeenCalledOnce()
    expect(api.runStart.mock.calls[0][0]).not.toHaveProperty('uploadPort')
    useStore.setState({ running: false, runId: null })
    api.runStart.mockClear()
    await useStore.getState().runActive()
    for (const [request] of api.runStart.mock.calls) expect(request).not.toHaveProperty('uploadPort')
  })
})
