import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cp, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import * as files from '../src/main/services/fsService'
import * as tests from '../src/main/services/firmwareTests'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cortex-desktop-tests-'))
  await cp(resolve('examples/firmware-testing'), join(root, 'examples/firmware-testing'), { recursive: true })
  files.setWorkspaceRoot(root)
})
afterEach(async () => {
  await tests.stop('run-1')
  files.setWorkspaceRoot(null)
  await rm(root, { recursive: true, force: true })
})
const request = () => ({ id: 'run-1', workspaceRoot: root })
describe('desktop firmware trust boundary', () => {
  it('requires the admitted project and rejects unknown arguments', async () => {
    await expect(tests.run({ ...request(), workspaceRoot: tmpdir() })).rejects.toThrow(/project/)
    await expect(tests.run({ ...request(), extraCompilerFlags: ['-fplugin=x'] })).rejects.toThrow(/Unknown/)
    await expect(tests.run({ ...request(), path: 'one.json', replay: 'report.json' })).rejects.toThrow(/not both/)
    await expect(tests.run({ ...request(), compiler: join(root, 'g++.exe') })).rejects.toThrow(/canonical/)
  })
  it('refuses a scenario outside the project before loading firmware', async () => {
    await expect(tests.run({ ...request(), path: resolve('examples/firmware-testing/scenarios/normal.json') })).rejects.toThrow(/outside/)
  })
  it('refuses an escaped source and symlinked scenario directory', async () => {
    const path = join(root, 'examples/firmware-testing/scenarios/normal.json')
    const scenario = JSON.parse(await readFile(path, 'utf8'))
    scenario.firmware.source = resolve('examples/firmware-testing/controller.ino')
    await writeFile(path, JSON.stringify(scenario))
    await expect(tests.run({ ...request(), path })).rejects.toThrow(/outside/)
    const link = join(root, 'linked-scenarios')
    await symlink(resolve('examples/firmware-testing/scenarios'), link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(tests.run({ ...request(), path: link })).rejects.toThrow(/outside/)
  })
  it('rejects malformed and oversized replay files without executing', async () => {
    const path = join(root, 'report.json')
    await writeFile(path, JSON.stringify({ version: 1, results: [{ scenario: {}, scenarioPath: 5 }] }))
    await expect(tests.run({ ...request(), replay: path })).rejects.toThrow(/Replay/)
    await writeFile(path, ' '.repeat(32 * 1024 * 1024 + 1))
    await expect(tests.run({ ...request(), replay: path })).rejects.toThrow(/32 MiB/)
  })
  it('validates chooser selections and refuses a foreign firmware override', async () => {
    await expect(tests.validateSelection('firmware', resolve('examples/firmware-testing/controller.ino'))).rejects.toThrow(/outside/)
    await expect(tests.validateSelection('report', join(root, 'examples/firmware-testing/controller.ino'))).rejects.toThrow(/JSON/)
    await expect(tests.validateSelection('scenario', join(root, 'examples/firmware-testing/scenarios'))).rejects.toThrow(/file/)
  })
  it('rejects aggregate event budgets before compiling rather than creating an unbounded desktop report', async () => {
    const path = join(root, 'examples/firmware-testing/scenarios/normal.json')
    const scenario = JSON.parse(await readFile(path, 'utf8'))
    scenario.limits.maxEvents = 100000
    await writeFile(path, JSON.stringify(scenario))
    await expect(tests.run(request())).rejects.toThrow(/aggregate maxEvents/)
  })
})

const compiler = ['g++', 'clang++'].find(tool => spawnSync(tool, ['--version'], { windowsHide: true }).status === 0)
describe.skipIf(!compiler)('real desktop firmware suite', () => {
  it('runs the default suite and saves readable reports without overwriting prior runs', async () => {
    const first = await tests.run({ ...request(), compiler })
    expect(first.report.exitCode).toBe(0)
    expect(first.report.results).toHaveLength(3)
    expect(JSON.parse(await readFile(first.reportPath, 'utf8'))).toEqual(first.report)
    expect(await readFile(first.summaryPath, 'utf8')).toContain('3 passed, 0 failed')
    const second = await tests.run({ ...request(), path: 'examples/firmware-testing/scenarios/normal.json', compiler })
    expect(second.reportPath).not.toBe(first.reportPath)
    expect(JSON.parse(await readFile(first.reportPath, 'utf8'))).toEqual(first.report)
  }, 90_000)
  it('replays saved inputs after deleting scenario JSON, catches broken firmware and verifies the fix', async () => {
    const path = join(root, 'examples/firmware-testing/scenarios/sensor-timeout.json')
    const first = await tests.run({ ...request(), path, compiler })
    await unlink(path)
    const broken = await tests.run({ ...request(), replay: first.reportPath, compiler, firmware: 'examples/firmware-testing/fixtures/broken-timeout.ino' })
    expect(broken.report.exitCode).toBe(1)
    const result = broken.report.results[0]
    expect('assertions' in result && result.assertions.some(a => a.id === 'sensor-timeout-shutdown' && !a.passed)).toBe(true)
    expect(broken.notes.join(' ')).toContain('source changed')
    const fixed = await tests.run({ ...request(), replay: first.reportPath, compiler })
    expect(fixed.report.exitCode).toBe(0)
  }, 60_000)
  it('reserves a run before async work, rejects duplicates and cancels with no successful result', async () => {
    const pending = tests.run({ ...request(), compiler, firmware: 'examples/firmware-testing/fixtures/hanging.ino' })
    await expect(tests.run({ ...request(), id: 'run-2', compiler })).rejects.toThrow(/already running/)
    await tests.stop('run-1')
    const cancelled = await pending
    expect(cancelled.report.exitCode).toBe(2)
    expect(cancelled.notes.join(' ')).toContain('cancelled')
    const replay = await tests.run({ ...request(), compiler, replay: cancelled.reportPath, firmware: 'examples/firmware-testing/controller.ino' })
    expect(replay.report.exitCode).toBe(0)
  }, 90_000)
  it('never saves results into a project that changed during execution', async () => {
    const pending = tests.run({ ...request(), compiler })
    files.setWorkspaceRoot(null)
    await expect(pending).rejects.toThrow(/project changed/)
  })
  it('admits a project opened through its own directory link', async () => {
    const alias = join(root, 'project-alias')
    await symlink(join(root, 'examples/firmware-testing'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    files.setWorkspaceRoot(alias)
    const result = await tests.run({ id: 'run-1', workspaceRoot: alias, path: 'scenarios/normal.json', compiler })
    expect(result.report.exitCode).toBe(0)
  }, 30_000)
})
