import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir, cpus, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { ARDUINO_SHIM } from '../services/arduinoShim'
import { prepareSimulation } from '../services/simBuild'
import { safeCommand } from '../services/commandResolver'
import { isHostCpp } from '../../shared/security'
import { parseSimLine } from '../../shared/simProtocol'
import type { BuildConfiguration, FirmwareReport, FirmwareScenario, TimelineEvent } from '../../shared/firmwareTest'
import { loadScenario, validateScenario } from './scenario'
import { evaluateAssertions } from './assertions'
import { runProcess } from './process'

export interface RunnerOptions {
  compiler?: string
  firmware?: string
  scenario?: FirmwareScenario
  signal?: AbortSignal
  maxOutputBytes?: number
}

export interface PreparedScenario {
  scenario: FirmwareScenario
  scenarioPath: string
  build: BuildConfiguration
  compilerLog: string
  exePath: string
  directory: string
}

export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')

export class ScenarioPreparationError extends Error {
  constructor(public readonly report: FirmwareReport) { super(report.error) }
}

function testMain(scenario: FirmwareScenario): string {
  const inputs = [
    ...scenario.initialState.map(e => ({ atMs: 0, ...e })),
    ...scenario.inputs
  ].map(e => `  __sim_test_input(${e.atMs * 1000}ULL, ${e.pin}, ${e.value});`).join('\n')
  return `#include "Arduino.h"
extern void setup();
extern void loop();
int main() {
  __sim_test_init(${scenario.seed}U, ${scenario.limits.durationMs * 1000}ULL);
${inputs}
  __sim_test_advance(0);
  setup();
  while (__sim_run && __sim_time_us < __sim_limit_us) {
    const auto before = __sim_time_us;
    loop();
    if (__sim_time_us == before) __sim_test_advance(${scenario.limits.stepMs * 1000}ULL);
  }
  Serial.__flushResidue();
  printf("@done %llu\\n", (unsigned long long)__sim_time_us);
  __sim_exit(0);
}
`
}

export async function prepareScenario(scenarioPath: string, options: RunnerOptions = {}): Promise<PreparedScenario> {
  const started = performance.now()
  const path = resolve(scenarioPath)
  const scenario = options.scenario ? validateScenario(options.scenario) : await loadScenario(path)
  const sourcePath = options.firmware ? resolve(options.firmware) : resolve(dirname(path), scenario.firmware.source)
  const directory = await mkdtemp(join(tmpdir(), 'cortex-firmware-test-'))
  let build: BuildConfiguration | undefined
  let compilerLog = ''
  try {
    if (!/\.ino$/i.test(sourcePath)) throw new Error('Firmware override must name a .ino sketch')
    const source = await readFile(sourcePath, 'utf8')
    const wanted = options.compiler || 'g++'
    if (!isHostCpp(wanted)) throw new Error(`Unsupported compiler ${wanted}; use a host g++ or clang++`)
    const compiler = safeCommand(wanted, dirname(path))
    if (!compiler) throw new Error(`Host compiler ${wanted} was not found on PATH or was refused; install g++/clang++ outside the project`)
    const version = await runProcess(compiler, ['--version'], { cwd: directory, timeoutMs: 5000, signal: options.signal })
    if (version.error || version.code !== 0) throw new Error(version.error || version.stderr || 'Compiler version probe failed')
    const driver = testMain(scenario)
    const prepared = await prepareSimulation({ filePath: sourcePath, simDir: directory, compiler, mainSource: driver, testMode: true })
    const git = safeCommand('git')
    let revision: string | null = null
    let dirty: boolean | null = null
    if (git) {
      const rev = await runProcess(git, ['rev-parse', 'HEAD'], { cwd: dirname(path), timeoutMs: 5000, signal: options.signal })
      const status = await runProcess(git, ['status', '--porcelain'], { cwd: dirname(path), timeoutMs: 5000, signal: options.signal })
      if (rev.code === 0 && !rev.error) revision = rev.stdout.trim()
      if (status.code === 0 && !status.error) dirty = !!status.stdout.trim()
    }
    build = {
      compiler, compilerVersion: version.stdout.replace(/\r\n/g, '\n').trim(), args: prepared.args,
      sourcePath, sourceSha256: sha256(source), shimSha256: sha256(ARDUINO_SHIM), runnerSha256: sha256(driver),
      host: { platform: process.platform, arch: process.arch, release: release(), cpu: cpus()[0]?.model || 'unknown', node: process.version },
      revision, dirty, buildWallMs: performance.now() - started
    }
    const compiled = await runProcess(compiler, prepared.args, { cwd: directory, timeoutMs: 60_000, signal: options.signal, maxBytes: options.maxOutputBytes })
    compilerLog = compiled.stdout + compiled.stderr
    build.buildWallMs = performance.now() - started
    if (compiled.error || compiled.code !== 0) throw new Error(`${compiled.error || `Compilation failed (exit ${compiled.code})`}\n${compilerLog}`)
    return { scenario, scenarioPath: path, build, compilerLog, exePath: prepared.exePath, directory }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw new ScenarioPreparationError({
      version: 1, scenarioPath: path, scenario, firmwarePath: sourcePath,
      status: 'error', error: error instanceof Error ? error.message : String(error),
      ...(build ? { build } : {}),
      execution: { hostWallMs: 0, virtualDurationMs: 0, exitCode: null, traceSha256: sha256('[]') },
      assertions: [], timeline: [], logs: { stdout: '', stderr: '', compiler: compilerLog }
    })
  }
}

export async function executePrepared(prepared: PreparedScenario, signal?: AbortSignal, maxOutputBytes?: number): Promise<FirmwareReport> {
  const { scenario } = prepared
  const timeline: TimelineEvent[] = []
  let buffer = ''
  let atMs = 0
  let completed = false
  let virtualDurationMs = 0
  const parse = (line: string): void => {
    if (!line) return
    if (line.startsWith('@time ')) {
      if (!/^@time \d+$/.test(line)) throw new Error(`Malformed clock event: ${line}`)
      const next = Number(line.slice(6)) / 1000
      if (!Number.isFinite(next) || next < atMs || next > scenario.limits.durationMs) throw new Error(`Invalid virtual clock ${next}ms`)
      atMs = next
      return
    }
    if (line.startsWith('@done ')) {
      if (!/^@done \d+$/.test(line) || completed) throw new Error(`Malformed completion event: ${line}`)
      virtualDurationMs = Number(line.slice(6)) / 1000
      if (virtualDurationMs !== scenario.limits.durationMs) throw new Error(`Firmware stopped at ${virtualDurationMs}ms before the scenario completed`)
      completed = true
      return
    }
    let event: TimelineEvent
    if (line.startsWith('@input ')) {
      const parts = line.match(/^@input (\d+) (\d+)$/)
      if (!parts) throw new Error(`Malformed input event: ${line}`)
      event = { atMs, kind: 'input', pin: Number(parts[1]), value: Number(parts[2]) }
    } else {
      const parsed = parseSimLine(line)
      if (!parsed) throw new Error(`Unknown or malformed simulation output: ${line}`)
      event = { atMs, ...parsed }
    }
    timeline.push(event)
    if (timeline.length > scenario.limits.maxEvents) throw new Error(`Simulation exceeded maxEvents (${scenario.limits.maxEvents})`)
  }
  const execution = await runProcess(prepared.exePath, [], {
    cwd: prepared.directory, timeoutMs: scenario.limits.wallTimeoutMs, signal, maxBytes: maxOutputBytes,
    onStdout(chunk) {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || ''
      for (const line of lines) parse(line)
    }
  })
  let error = execution.error
  if (!error && buffer) {
    try { parse(buffer) } catch (e) { error = e instanceof Error ? e.message : String(e) }
  }
  if (!error && execution.code !== 0) error = `Firmware exited unexpectedly (exit ${execution.code})`
  if (!error && !completed) error = 'Firmware did not emit the scenario completion marker'
  if (!error) {
    const expectedInputs = [
      ...scenario.initialState.map(e => ({ atMs: 0, kind: 'input', ...e })),
      ...scenario.inputs.map(e => ({ kind: 'input', ...e }))
    ].sort((a, b) => a.atMs - b.atMs).map(e => ({ atMs: e.atMs, kind: e.kind, pin: e.pin, value: e.value }))
    const applied = timeline.filter(e => e.kind === 'input').map(e => ({ atMs: e.atMs, kind: e.kind, pin: e.pin, value: e.value }))
    if (sha256(JSON.stringify(applied)) !== sha256(JSON.stringify(expectedInputs))) error = 'Applied inputs do not match the scenario schedule'
  }
  const assertions = error ? [] : evaluateAssertions(scenario.assertions, timeline)
  return {
    version: 1, scenarioPath: prepared.scenarioPath, scenario: structuredClone(scenario), firmwarePath: prepared.build.sourcePath,
    status: error ? 'error' : assertions.every(a => a.passed) ? 'passed' : 'failed',
    ...(error ? { error } : {}), build: prepared.build,
    execution: { hostWallMs: execution.wallMs, virtualDurationMs, exitCode: execution.code, traceSha256: sha256(JSON.stringify(timeline)) },
    assertions, timeline,
    logs: { stdout: execution.stdout, stderr: execution.stderr, compiler: prepared.compilerLog }
  }
}

export async function disposePrepared(prepared: PreparedScenario): Promise<void> {
  await rm(prepared.directory, { recursive: true, force: true })
}

export async function runScenario(path: string, options: RunnerOptions = {}): Promise<FirmwareReport> {
  try {
    const prepared = await prepareScenario(path, options)
    try { return await executePrepared(prepared, options.signal, options.maxOutputBytes) } finally { await disposePrepared(prepared) }
  } catch (error) {
    if (error instanceof ScenarioPreparationError) return error.report
    throw error
  }
}
