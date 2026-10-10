import { beforeEach, describe, expect, it, vi } from 'vitest'
import { langFromPath } from '../src/shared/languages'
import type { FirmwareTestResponse } from '../src/shared/firmwareTest'

const api = { writeFile: vi.fn(), firmwareTestRun: vi.fn(), firmwareTestStop: vi.fn() }
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
vi.stubGlobal('window', { api })
const { useStore, workspaceScopedReset } = await import('../src/renderer/src/store/useStore')
const result: FirmwareTestResponse = {
  report: { version: 1, generatedAt: '', exitCode: 0, reproducible: true, results: [] },
  reportPath: 'C:/project/.cortex/test-results/one/report.json', summaryPath: 'C:/project/.cortex/test-results/one/summary.md', notes: []
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(ok => { resolve = ok })
  return { promise, resolve }
}
beforeEach(() => {
  vi.clearAllMocks()
  api.writeFile.mockReset().mockResolvedValue(undefined)
  api.firmwareTestRun.mockReset().mockResolvedValue(result)
  api.firmwareTestStop.mockReset().mockResolvedValue(undefined)
  useStore.setState({ ...workspaceScopedReset(), workspaceRoot: 'C:/project', notifications: [], tabs: [{
    path: 'C:/project/controller.ino', name: 'controller.ino', content: 'new', savedContent: 'old', language: langFromPath('controller.ino'), group: 0
  }] })
})
describe('real desktop firmware store lifecycle', () => {
  it('saves changes before running and opens persisted results', async () => {
    await useStore.getState().runFirmwareTests()
    expect(api.writeFile).toHaveBeenCalledOnce()
    expect(api.firmwareTestRun).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: 'C:/project' }))
    expect(api.writeFile.mock.invocationCallOrder[0]).toBeLessThan(api.firmwareTestRun.mock.invocationCallOrder[0])
    expect(useStore.getState()).toMatchObject({ firmwareTestRunning: false, firmwareTestResult: result, bottomView: 'tests', bottomVisible: true })
  })
  it('refuses launch when saving fails and preserves edited bytes', async () => {
    api.writeFile.mockRejectedValueOnce(new Error('disk conflict'))
    await useStore.getState().runFirmwareTests()
    expect(api.firmwareTestRun).not.toHaveBeenCalled()
    expect(useStore.getState().tabs[0].content).toBe('new')
    expect(useStore.getState().firmwareTestError).toContain('disk conflict')
  })
  it('blocks duplicates and Stop prevents a pending save from launching', async () => {
    const save = deferred<void>()
    api.writeFile.mockReturnValueOnce(save.promise)
    const first = useStore.getState().runFirmwareTests()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    await useStore.getState().runFirmwareTests()
    await useStore.getState().stopFirmwareTests()
    save.resolve(undefined)
    await first
    expect(api.firmwareTestRun).not.toHaveBeenCalled()
    expect(useStore.getState().firmwareTestRunning).toBe(false)
  })
  it('never launches bytes typed over during Save All', async () => {
    const save = deferred<void>()
    api.writeFile.mockReturnValueOnce(save.promise)
    const first = useStore.getState().runFirmwareTests()
    await vi.waitFor(() => expect(api.writeFile).toHaveBeenCalledOnce())
    useStore.getState().updateContent('C:/project/controller.ino', 'typed later')
    save.resolve(undefined)
    await first
    expect(api.firmwareTestRun).not.toHaveBeenCalled()
    expect(useStore.getState().firmwareTestError).toContain('changed')
  })
  it('drops a stale response after the project switches and does not clear its newer owner', async () => {
    const run = deferred<FirmwareTestResponse>()
    api.firmwareTestRun.mockReturnValueOnce(run.promise)
    const first = useStore.getState().runFirmwareTests()
    await vi.waitFor(() => expect(api.firmwareTestRun).toHaveBeenCalledOnce())
    useStore.setState({ ...workspaceScopedReset(), workspaceRoot: 'C:/other', firmwareTestRunId: 'new-owner', firmwareTestRunning: true })
    run.resolve(result)
    await first
    expect(useStore.getState()).toMatchObject({ firmwareTestRunId: 'new-owner', firmwareTestRunning: true, firmwareTestResult: null })
  })
  it('sends replay and override as explicit configuration, and refuses an unopened project', async () => {
    await useStore.getState().runFirmwareTests({ replay: 'saved/report.json', firmware: 'fixed.ino' })
    expect(api.firmwareTestRun).toHaveBeenCalledWith(expect.objectContaining({ replay: 'saved/report.json', firmware: 'fixed.ino' }))
    api.firmwareTestRun.mockClear()
    useStore.setState({ ...workspaceScopedReset(), workspaceRoot: null })
    await useStore.getState().runFirmwareTests()
    expect(api.firmwareTestRun).not.toHaveBeenCalled()
    expect(useStore.getState().firmwareTestError).toContain('Open a project')
  })
})
