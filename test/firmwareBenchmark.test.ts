import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BuildConfiguration, FirmwareReport, FirmwareScenario } from '../src/shared/firmwareTest'
import type { PreparedScenario } from '../src/main/firmwareTesting/runner'
import { benchmark, renderBenchmarkSummary } from '../src/main/firmwareTesting/benchmark'

const runner = vi.hoisted(() => ({
  prepareScenario: vi.fn(), executePrepared: vi.fn(), disposePrepared: vi.fn(),
}))
vi.mock('../src/main/firmwareTesting/runner', () => runner)

const scenario: FirmwareScenario = {
  version: 1, id: 'benchmark', description: 'Benchmark fixture',
  firmware: { board: 'uno', source: 'controller.ino' },
  seed: 42, initialState: [], inputs: [], assertions: [],
  limits: { durationMs: 60000, stepMs: 10, wallTimeoutMs: 5000, maxEvents: 10000 },
}

function prepared(directory = '/tmp/cortex-firmware-test-first'): PreparedScenario {
  const build: BuildConfiguration = {
    compiler: '/usr/bin/g++', compilerVersion: 'g++ 14.2.0',
    args: [`${directory}/sketch.cpp`, `${directory}/sim_main.cpp`, '-o', `${directory}/sim.exe`, '-std=c++23', '-I', directory, '-I', '/project/examples', '-O1'],
    sourcePath: '/project/examples/controller.ino', sourceSha256: 'source', shimSha256: 'shim', runnerSha256: 'runner',
    host: { platform: 'linux', arch: 'x64', release: '6.1.0', cpu: 'Test CPU', node: 'v22.20.0' },
    revision: 'revision', dirty: false, buildWallMs: 1000,
  }
  return { scenario, scenarioPath: '/project/examples/benchmark.json', build, compilerLog: '', exePath: `${directory}/sim.exe`, directory }
}

function execution(hostWallMs = 100): FirmwareReport {
  return {
    version: 1, scenarioPath: 'benchmark.json', scenario, status: 'passed',
    execution: { hostWallMs, virtualDurationMs: 60000, exitCode: 0, traceSha256: 'trace' },
    assertions: [], timeline: [
      { atMs: 0, kind: 'input', pin: 14, value: 50 },
      { atMs: 0, kind: 'pwm', pin: 9, value: 0 },
      { atMs: 1, kind: 'serial', text: 'RUNNING' },
    ],
    logs: { stdout: '', stderr: '', compiler: '' },
  }
}

let temporaryDirectory: string
beforeEach(async () => {
  vi.resetAllMocks()
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'cortex-benchmark-unit-'))
  runner.prepareScenario.mockResolvedValue(prepared())
  runner.executePrepared.mockResolvedValue(execution())
  runner.disposePrepared.mockResolvedValue(undefined)
})
afterEach(async () => {
  await rm(temporaryDirectory, { recursive: true, force: true })
})

async function baseline(): Promise<string> {
  const report = await benchmark('benchmark.json', { runs: 3 })
  const path = join(temporaryDirectory, 'baseline.json')
  await writeFile(path, JSON.stringify(report))
  return path
}

describe('repeatable firmware benchmarks', () => {
  it('builds once, excludes warmups and distinguishes virtual throughput from host time', async () => {
    for (const ms of [999, 888, 30, 10, 20]) runner.executePrepared.mockResolvedValueOnce(execution(ms))
    const report = await benchmark('benchmark.json', { runs: 3 })
    expect(runner.prepareScenario).toHaveBeenCalledTimes(1)
    expect(runner.executePrepared).toHaveBeenCalledTimes(5)
    expect(runner.disposePrepared).toHaveBeenCalledTimes(1)
    expect(report.samples.map(sample => sample.hostWallMs)).toEqual([30, 10, 20])
    expect(report.metrics?.hostWallMs).toEqual({ min: 10, median: 20, p95: 30, max: 30, mean: 20 })
    expect(report.samples[0].outputEvents).toBe(2)
    expect(report.samples[0].virtualMsPerHostSecond).toBe(2_000_000)
    expect(report.comparison.status).toBe('not-requested')
    expect(renderBenchmarkSummary(report)).toContain('model throughput')
  })

  it('compares across fresh build directories and repository paths while allowing code revisions to differ', async () => {
    const path = await baseline()
    const current = prepared('C:\\Temp\\cortex-firmware-test-second')
    current.build.sourcePath = 'C:\\clone\\examples\\controller.ino'
    current.build.args[current.build.args.length - 2] = 'C:\\clone\\examples'
    current.build.runnerSha256 = 'changed-runner'
    current.build.revision = 'changed-revision'
    current.build.host.release = 'new-kernel-patch'
    runner.prepareScenario.mockResolvedValue(current)
    const report = await benchmark('benchmark.json', { runs: 3, baseline: path })
    expect(report.comparison.status).toBe('compared')
    expect(report.comparison.measurements.every(measurement => measurement.changePercent === 0)).toBe(true)
  })

  it('keeps substantial performance regressions advisory', async () => {
    const path = await baseline()
    runner.executePrepared.mockResolvedValue(execution(150))
    const report = await benchmark('benchmark.json', { runs: 3, baseline: path })
    expect(report.status).toBe('passed')
    expect(report.comparison.regression).toBe(true)
    expect(report.comparison.measurements[0].changePercent).toBe(50)
    expect(renderBenchmarkSummary(report)).toContain('Advisory')
  })

  it('explains incompatible environments instead of comparing unlike hosts', async () => {
    const path = await baseline()
    const current = prepared()
    current.build.host.cpu = 'Different CPU'
    runner.prepareScenario.mockResolvedValue(current)
    const report = await benchmark('benchmark.json', { runs: 3, baseline: path })
    expect(report.status).toBe('passed')
    expect(report.comparison.status).toBe('incompatible')
    expect(report.comparison.reason).toContain('host cpu differs')
    expect(report.comparison.measurements).toEqual([])
  })

  it('fails when any warmup or measured trace differs', async () => {
    const changed = execution()
    changed.execution.traceSha256 = 'changed'
    runner.executePrepared.mockResolvedValueOnce(changed)
    const report = await benchmark('benchmark.json', { runs: 3 })
    expect(report.reproducible).toBe(false)
    expect(report.status).toBe('failed')
    expect(report.error).toContain('different simulation traces')
  })

  it('retains assertion failures and does not turn them into advisory-only performance alerts', async () => {
    const failure = execution()
    failure.status = 'failed'
    failure.assertions = [{ id: 'deadline', kind: 'state', passed: false, atMs: 500, message: 'PWM stayed on after timeout', evidence: [] }]
    runner.executePrepared.mockResolvedValueOnce(failure)
    const report = await benchmark('benchmark.json', { runs: 3 })
    expect(report.status).toBe('failed')
    expect(report.failures[0].assertions[0].id).toBe('deadline')
  })

  it('stops immediately on a warmup runner error and still disposes the build', async () => {
    const failure = execution()
    failure.status = 'error'
    failure.error = 'Wall-clock timeout'
    runner.executePrepared.mockResolvedValue(failure)
    const report = await benchmark('benchmark.json', { runs: 3 })
    expect(report.status).toBe('error')
    expect(report.error).toBe('Wall-clock timeout')
    expect(runner.executePrepared).toHaveBeenCalledTimes(1)
    expect(runner.disposePrepared).toHaveBeenCalledTimes(1)
  })

  it('reports missing and invalid explicit baselines as errors before building', async () => {
    await expect(benchmark('benchmark.json', { runs: 3, baseline: join(temporaryDirectory, 'missing.json') })).rejects.toThrow('Cannot load benchmark baseline')
    const path = join(temporaryDirectory, 'invalid.json')
    await writeFile(path, '{"version":1,"status":"passed"}')
    await expect(benchmark('benchmark.json', { runs: 3, baseline: path })).rejects.toThrow('Invalid benchmark baseline')
    expect(runner.prepareScenario).not.toHaveBeenCalled()
  })
})
