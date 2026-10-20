import type { BuildConfiguration, FirmwareReport, FirmwareScenario, TimelineEvent } from '../../../shared/firmwareTest'
import { parseSimLine } from '../../../shared/simProtocol'
import { evaluateAssertions } from '../assertions'
import { sha256 } from '../runner'

/** Must match CORTEX_HIL_MAX_INPUTS in device/cortex_hil.h. */
export const MAX_BOARD_INPUTS = 128

interface ScheduledInput { atMs: number; pin: number; value: number }

/**
 * Initial state at time 0, then the inputs in time order with JSON order kept for
 * equal times: the order the simulator applies them in.
 */
export function scheduledInputs(scenario: FirmwareScenario): ScheduledInput[] {
  return [
    ...scenario.initialState.map((e) => ({ atMs: 0, pin: e.pin, value: e.value })),
    ...scenario.inputs.map((e) => ({ atMs: e.atMs, pin: e.pin, value: e.value }))
  ].map((e, order) => ({ ...e, order })).sort((a, b) => a.atMs - b.atMs || a.order - b.order)
    .map(({ atMs, pin, value }) => ({ atMs, pin, value }))
}

/** The lines the host sends before "@hil go"; times go to the board in microseconds. */
export function encodeSchedule(scenario: FirmwareScenario): string[] {
  const inputs = scheduledInputs(scenario)
  if (inputs.length > MAX_BOARD_INPUTS) throw new Error(`${scenario.id} has ${inputs.length} inputs; the board layer holds at most ${MAX_BOARD_INPUTS}`)
  return [`@hil schedule ${scenario.limits.durationMs} ${inputs.length}`, ...inputs.map((e) => `${e.atMs * 1000} ${e.pin} ${e.value}`)]
}

/**
 * Turns the board's output into timeline events. Anything before "@hil started" is boot
 * noise (an ESP32 prints its ROM log, for example) and is ignored.
 */
export class TraceParser {
  readonly events: TimelineEvent[] = []
  readonly errors: string[] = []
  started = false
  doneUs: number | null = null
  private atMs = 0

  push(raw: string): void {
    const line = raw.replace(/\r$/, '')
    if (!this.started) {
      if (line === '@hil started') this.started = true
      return
    }
    if (this.doneUs !== null) return
    if (line.startsWith('@time ')) {
      if (!/^@time \d+$/.test(line)) return void this.errors.push(`Malformed clock event: ${line}`)
      const atMs = Number(line.slice(6)) / 1000
      if (atMs < this.atMs) this.errors.push(`Board clock went backwards: ${line}`)
      this.atMs = atMs
      return
    }
    if (line.startsWith('@done ')) {
      if (!/^@done \d+$/.test(line)) return void this.errors.push(`Malformed completion event: ${line}`)
      this.doneUs = Number(line.slice(6))
      return
    }
    if (line.startsWith('@hil ')) {
      if (line.startsWith('@hil error')) this.errors.push(line)
      return
    }
    const event = parseSimLine(line)
    if (!event) return void this.errors.push(`Unknown board output: ${line}`)
    this.events.push({ atMs: this.atMs, ...event })
  }
}

export interface BoardRun {
  trace: TraceParser
  /** Every line the board sent, for the report's stdout log. */
  output: string
  hostWallMs: number
  /** Set when the run could not complete (timeout, lost connection). */
  error?: string
}

/**
 * The same report shape the simulator writes. Input events come from the schedule:
 * on the board, as in the simulator, a value is present from its scheduled time and the
 * firmware sees it on its next read.
 */
export function boardReport(scenarioPath: string, scenario: FirmwareScenario, firmwarePath: string, build: BuildConfiguration, compilerLog: string, run: BoardRun): FirmwareReport {
  const inputs: TimelineEvent[] = scheduledInputs(scenario).map((e) => ({ atMs: e.atMs, kind: 'input', pin: e.pin, value: e.value }))
  const timeline = [...inputs.map((e, i) => ({ e, rank: 0, i })), ...run.trace.events.map((e, i) => ({ e, rank: 1, i }))]
    .sort((a, b) => a.e.atMs - b.e.atMs || a.rank - b.rank || a.i - b.i).map((entry) => entry.e)
  let error = run.error
  if (!error && run.trace.errors.length) error = run.trace.errors.join('\n')
  if (!error && !run.trace.started) error = 'The board never started the scenario'
  if (!error && run.trace.doneUs === null) error = 'The board did not report the end of the scenario'
  if (!error && timeline.length > scenario.limits.maxEvents) error = `The board exceeded maxEvents (${scenario.limits.maxEvents})`
  const assertions = error ? [] : evaluateAssertions(scenario.assertions, timeline)
  return {
    version: 1, scenarioPath, scenario: structuredClone(scenario), firmwarePath,
    status: error ? 'error' : assertions.every((a) => a.passed) ? 'passed' : 'failed',
    ...(error ? { error } : {}), build,
    execution: {
      hostWallMs: run.hostWallMs, virtualDurationMs: run.trace.doneUs === null ? 0 : run.trace.doneUs / 1000,
      exitCode: null, traceSha256: sha256(JSON.stringify(timeline))
    },
    assertions, timeline,
    logs: { stdout: run.output, stderr: '', compiler: compilerLog }
  }
}
