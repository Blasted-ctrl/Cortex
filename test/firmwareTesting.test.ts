import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FirmwareAssertion, FirmwareScenario, TimelineEvent } from '../src/shared/firmwareTest'
import { validateScenario } from '../src/main/firmwareTesting/scenario'
import { evaluateAssertions } from '../src/main/firmwareTesting/assertions'
import { disposePrepared, executePrepared, prepareScenario, runScenario } from '../src/main/firmwareTesting/runner'
import { suiteExitCode, renderSuiteSummary } from '../src/main/firmwareTesting/reports'
import { main } from '../src/main/firmwareTesting/cli'

const examplePath = resolve('examples/firmware-testing/scenarios/sensor-timeout.json')
const example = JSON.parse(await readFile(examplePath, 'utf8')) as FirmwareScenario

describe('firmware scenario trust boundary', () => {
  it('accepts every documented version 1 example and benchmark', async () => {
    for (const file of ['scenarios/normal.json', 'scenarios/sensor-timeout.json', 'scenarios/invalid-input.json', 'benchmark.json']) {
      const value = JSON.parse(await readFile(resolve('examples/firmware-testing', file), 'utf8'))
      expect(validateScenario(value).version).toBe(1)
    }
  })

  it.each([
    ['unsupported version', (s: Record<string, unknown>) => { s.version = 2 }, /version/],
    ['unsupported board', (s: Record<string, unknown>) => { (s.firmware as Record<string, unknown>).board = 'esp32' }, /board/],
    ['unknown option', (s: Record<string, unknown>) => { s.extraCompilerFlags = ['-fplugin=x'] }, /unknown field/],
    ['non-ADC input', (s: Record<string, unknown>) => { (s.inputs as Record<string, unknown>[])[0].value = 1024 }, /value/],
    ['event beyond duration', (s: Record<string, unknown>) => { (s.inputs as Record<string, unknown>[])[0].atMs = 651 }, /atMs/],
    ['negative time', (s: Record<string, unknown>) => { (s.inputs as Record<string, unknown>[])[0].atMs = -1 }, /atMs/],
    ['fractional clock', (s: Record<string, unknown>) => { (s.limits as Record<string, unknown>).stepMs = 0.5 }, /stepMs/],
    ['unbounded watchdog', (s: Record<string, unknown>) => { (s.limits as Record<string, unknown>).wallTimeoutMs = 0 }, /wallTimeoutMs/],
    ['duplicate assertion ID', (s: Record<string, unknown>) => { (s.assertions as unknown[]).push((s.assertions as unknown[])[0]) }, /duplicate assertion/],
    ['duplicate initial pin', (s: Record<string, unknown>) => { (s.initialState as unknown[]).push((s.initialState as unknown[])[0]) }, /duplicate initial/],
    ['reversed assertion window', (s: Record<string, unknown>) => { (s.assertions as Record<string, unknown>[])[1].fromMs = 500 }, /toMs/],
    ['output scale mismatch', (s: Record<string, unknown>) => { (s.assertions as Record<string, unknown>[])[0].value = 256 }, /value/],
    ['no behavioral assertions', (s: Record<string, unknown>) => { s.assertions = [] }, /nonempty/],
    ['remote source', (s: Record<string, unknown>) => { (s.firmware as Record<string, unknown>).source = '//server/sketch.ino' }, /local/],
  ])('rejects %s', (_name, mutate, message) => {
    const value = structuredClone(example) as unknown as Record<string, unknown>
    mutate(value)
    expect(() => validateScenario(value)).toThrow(message)
  })

  it('returns isolated validated configuration', () => {
    const original = structuredClone(example)
    const validated = validateScenario(original)
    validated.inputs[0].value = 10
    expect(original.inputs[0].value).toBe(300)
  })
})

describe('behavior assertions', () => {
  const timeline: TimelineEvent[] = [
    { atMs: 0, kind: 'pwm', pin: 9, value: 0 },
    { atMs: 0, kind: 'serial', text: 'BOOT' },
    { atMs: 20, kind: 'pwm', pin: 9, value: 180 },
    { atMs: 20, kind: 'serial', text: 'HEATING' },
    { atMs: 470, kind: 'pwm', pin: 9, value: 0 },
    { atMs: 470, kind: 'serial', text: 'TIMEOUT' }
  ]

  function check(assertion: FirmwareAssertion, events = timeline) { return evaluateAssertions([assertion], events)[0] }

  it('accepts exact inclusive deadlines and names a missing-event deadline', () => {
    expect(check({ id: 'deadline', kind: 'event', event: 'serial', text: 'TIMEOUT', fromMs: 470, toMs: 470 }).passed).toBe(true)
    const result = check({ id: 'late', kind: 'event', event: 'serial', text: 'TIMEOUT', fromMs: 0, toMs: 469 })
    expect(result).toMatchObject({ passed: false, atMs: 469 })
    expect(result.evidence.some(e => e.kind === 'serial' && e.text === 'HEATING')).toBe(true)
  })

  it('checks latched output state, including last same-time write', () => {
    expect(check({ id: 'latched', kind: 'state', event: 'pwm', pin: 9, value: 180, atMs: 460 }).passed).toBe(true)
    expect(check({ id: 'off', kind: 'state', event: 'pwm', pin: 9, value: 0, atMs: 470 }).passed).toBe(true)
    expect(check({ id: 'last', kind: 'state', event: 'pwm', pin: 9, value: 20, atMs: 0 }, [
      { atMs: 0, kind: 'pwm', pin: 9, value: 10 }, { atMs: 0, kind: 'pwm', pin: 9, value: 20 }
    ]).passed).toBe(true)
  })

  it('names digital outputs once in failure messages', () => {
    const events: TimelineEvent[] = [{ atMs: 0, kind: 'pin', pin: 13, value: 0 }, { atMs: 0, kind: 'pwm', pin: 9, value: 0 }]
    expect(check({ id: 'fault', kind: 'event', event: 'pin', pin: 13, value: 1, fromMs: 0, toMs: 10 }, events).message).toBe('pin 13 = 1 not observed within [0, 10]ms')
    expect(check({ id: 'fault-state', kind: 'state', event: 'pin', pin: 13, value: 1, atMs: 5 }, events).message).toBe('pin 13 at 5ms: expected 1, observed 0')
    expect(check({ id: 'heat', kind: 'state', event: 'pwm', pin: 9, value: 180, atMs: 5 }, events).message).toBe('pwm pin 9 at 5ms: expected 180, observed 0')
  })

  it('fails unknown output instead of assuming a safe default', () => {
    expect(check({ id: 'unknown', kind: 'state', event: 'pwm', pin: 10, value: 0, atMs: 0 }).passed).toBe(false)
    expect(check({ id: 'range', kind: 'range', event: 'pwm', pin: 10, min: 0, max: 180, fromMs: 0, toMs: 100 }).passed).toBe(false)
  })

  it('catches an unsafe value held from before a range window', () => {
    const result = check({ id: 'unsafe', kind: 'range', event: 'pwm', pin: 9, min: 0, max: 0, fromMs: 460, toMs: 480 })
    expect(result).toMatchObject({ passed: false, atMs: 460 })
    expect(result.evidence[0]).toMatchObject({ atMs: 20, value: 180 })
  })

  it('catches a brief excursion even when final output is safe', () => {
    const result = check({ id: 'spike', kind: 'range', event: 'pwm', pin: 9, min: 0, max: 180, fromMs: 0, toMs: 100 }, [
      { atMs: 0, kind: 'pwm', pin: 9, value: 0 },
      { atMs: 50, kind: 'pwm', pin: 9, value: 200 },
      { atMs: 50, kind: 'pwm', pin: 9, value: 0 }
    ])
    expect(result).toMatchObject({ passed: false, atMs: 50 })
  })

  it('checks ordered state transitions, allowing unrelated logs between states', () => {
    expect(check({ id: 'states', kind: 'sequence', texts: ['BOOT', 'HEATING', 'TIMEOUT'], fromMs: 0, toMs: 500 }).passed).toBe(true)
    expect(check({ id: 'wrong-order', kind: 'sequence', texts: ['BOOT', 'TIMEOUT', 'HEATING'], fromMs: 0, toMs: 500 }).passed).toBe(false)
  })
})

describe('runner exit codes and report diagnostics', () => {
  it('gives runner errors precedence and treats irreproducibility as failure', () => {
    expect(suiteExitCode([])).toBe(0)
    expect(suiteExitCode([{ status: 'error', scenarioPath: 'bad.json', error: 'bad config' }])).toBe(2)
    expect(suiteExitCode([], false)).toBe(1)
  })

  it('returns configuration exit code 2 and saves an actionable report', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cortex-cli-report-'))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(await main(['test', join(directory, 'missing.json'), '--report-dir', directory])).toBe(2)
      const report = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))
      expect(report.results[0]).toMatchObject({ status: 'error', scenarioPath: join(directory, 'missing.json') })
      expect(renderSuiteSummary(report)).toContain('1 runner errors')
    } finally { log.mockRestore(); await rm(directory, { recursive: true, force: true }) }
  })

  it('rejects unknown CLI options', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try { expect(await main(['test', '--typo', '1'])).toBe(2) } finally { log.mockRestore() }
  })
})

const hasCompiler = spawnSync('g++', ['--version'], { windowsHide: true }).status === 0

describe.skipIf(!hasCompiler)('real compiled firmware testing', () => {
  let prepared: Awaited<ReturnType<typeof prepareScenario>>
  beforeAll(async () => { prepared = await prepareScenario(examplePath) }, 120_000)
  afterAll(async () => { if (prepared) await disposePrepared(prepared) })

  it('passes the timeout workflow and repeats its complete virtual trace exactly', async () => {
    const runs = [await executePrepared(prepared), await executePrepared(prepared), await executePrepared(prepared)]
    for (const report of runs) {
      expect(report.status, report.error).toBe('passed')
      expect(report.assertions).toHaveLength(7)
      expect(report.execution.virtualDurationMs).toBe(650)
      expect(report.build?.args).toContain('-DCORTEX_TEST=1')
      expect(report.timeline.filter(e => e.kind === 'serial').map(e => e.text)).toEqual(['BOOT', 'HEATING', 'TIMEOUT'])
    }
    expect(runs[1].timeline).toEqual(runs[0].timeline)
    expect(runs[2].execution.traceSha256).toBe(runs[0].execution.traceSha256)
    expect(suiteExitCode(runs)).toBe(0)
  })

  it('reports deliberately broken timeout logic as a firmware failure with evidence', async () => {
    const report = await runScenario(examplePath, { firmware: 'examples/firmware-testing/fixtures/broken-timeout.ino' })
    expect(report.status, report.error).toBe('failed')
    expect(report.assertions.find(a => a.id === 'sensor-timeout-shutdown')).toMatchObject({ passed: false, atMs: 480 })
    expect(report.assertions.find(a => a.id === 'stale-sensor-stays-off')?.evidence[0]).toMatchObject({ kind: 'pwm', value: 180 })
    expect(suiteExitCode([report])).toBe(1)
    const summary = renderSuiteSummary({ version: 1, generatedAt: '', exitCode: 1, reproducible: true, results: [report] })
    expect(summary).toContain('sensor-timeout-shutdown')
    expect(summary).toContain('"atMs": 220')
  })

  it('kills stuck firmware using the independent wall clock, retaining partial logs', async () => {
    const scenario = structuredClone(example)
    scenario.limits.wallTimeoutMs = 1500
    const report = await runScenario(examplePath, { scenario, firmware: 'examples/firmware-testing/fixtures/hanging.ino' })
    expect(report.status).toBe('error')
    expect(report.error).toContain('Wall-clock timeout')
    expect(report.logs.stdout).toContain('HANGING_FIXTURE')
    expect(report.assertions).toEqual([])
    expect(suiteExitCode([report])).toBe(2)
  })

  it('enforces the scenario output bound as a runner error', async () => {
    const limit = prepared.scenario.limits.maxEvents
    try {
      prepared.scenario.limits.maxEvents = 1
      const report = await executePrepared(prepared)
      expect(report.status).toBe('error')
      expect(report.error).toContain('maxEvents')
    } finally { prepared.scenario.limits.maxEvents = limit }
  })

  it('preserves compilation errors and replays saved configuration after the scenario file is removed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cortex-compile-replay-'))
    const config = join(directory, 'scenario.json')
    const firmware = join(directory, 'controller.ino')
    const reports = join(directory, 'reports')
    const replayed = join(directory, 'replayed')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await writeFile(config, JSON.stringify(example))
      await writeFile(firmware, '#error deliberate compilation failure\nvoid setup() {}\nvoid loop() {}\n')
      expect(await main(['test', config, '--firmware', firmware, '--report-dir', reports])).toBe(2)
      const failed = JSON.parse(await readFile(join(reports, 'report.json'), 'utf8'))
      expect(failed.results[0]).toMatchObject({ status: 'error', scenario: example, firmwarePath: firmware })
      expect(failed.results[0].build.compilerVersion.length).toBeGreaterThan(0)
      expect(failed.results[0].build.args).toContain('-DCORTEX_TEST=1')
      expect(failed.results[0].logs.compiler).toContain('deliberate compilation failure')
      await rm(config)
      await writeFile(firmware, await readFile(resolve('examples/firmware-testing/controller.ino'), 'utf8'))
      expect(await main(['test', '--replay', join(reports, 'report.json'), '--report-dir', replayed])).toBe(0)
      const success = JSON.parse(await readFile(join(replayed, 'report.json'), 'utf8'))
      expect(success.results[0].status).toBe('passed')
      expect(success.results[0].scenario).toEqual(example)
      expect(success.results[0].build.sourceSha256).not.toBe(failed.results[0].build.sourceSha256)
    } finally {
      log.mockRestore()
      error.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
