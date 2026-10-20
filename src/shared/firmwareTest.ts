import type { ParsedSimEvent } from './simProtocol'

export type OutputKind = 'pin' | 'pwm' | 'tone'
export interface PinInput { pin: number; value: number }
export interface TimedInput extends PinInput { atMs: number }
interface AssertionBase { id: string }
interface WindowAssertion extends AssertionBase { fromMs: number; toMs: number }

export type FirmwareAssertion =
  | (WindowAssertion & { kind: 'event'; event: 'serial'; text: string })
  | (WindowAssertion & { kind: 'event'; event: OutputKind | 'mode'; pin: number; value: number })
  | (AssertionBase & { kind: 'state'; event: OutputKind; pin: number; value: number; atMs: number })
  | (WindowAssertion & { kind: 'range'; event: OutputKind; pin: number; min: number; max: number })
  | (WindowAssertion & { kind: 'sequence'; texts: string[] })

export interface FirmwareScenario {
  version: 1
  id: string
  description: string
  firmware: { board: 'uno'; source: string }
  seed: number
  initialState: PinInput[]
  inputs: TimedInput[]
  limits: { durationMs: number; stepMs: number; wallTimeoutMs: number; maxEvents: number }
  assertions: FirmwareAssertion[]
}

export type TimelineEvent = (ParsedSimEvent | { kind: 'input'; pin: number; value: number }) & { atMs: number }
export interface AssertionResult {
  id: string
  kind: FirmwareAssertion['kind']
  passed: boolean
  atMs: number
  message: string
  evidence: TimelineEvent[]
}

export interface BuildConfiguration {
  compiler: string
  compilerVersion: string
  args: string[]
  sourcePath: string
  sourceSha256: string
  shimSha256: string
  runnerSha256: string
  host: { platform: string; arch: string; release: string; cpu: string; node: string }
  revision: string | null
  dirty: boolean | null
  buildWallMs: number
}

export interface FirmwareReport {
  version: 1
  scenarioPath: string
  scenario: FirmwareScenario
  firmwarePath?: string
  status: 'passed' | 'failed' | 'error'
  error?: string
  build?: BuildConfiguration
  execution: { hostWallMs: number; virtualDurationMs: number; exitCode: number | null; traceSha256: string }
  assertions: AssertionResult[]
  timeline: TimelineEvent[]
  logs: { stdout: string; stderr: string; compiler: string }
}

export interface RunnerFailure { status: 'error'; scenarioPath: string; error: string }
export type SuiteResult = (FirmwareReport & { repeat?: number }) | RunnerFailure
export interface SuiteReport {
  version: 1
  generatedAt: string
  exitCode: number
  reproducible: boolean
  expectedNegativeTests?: boolean
  cancelled?: boolean
  /** Where the scenarios ran when it was not the host simulator, e.g. a board and port. */
  target?: string
  results: SuiteResult[]
}
export type FirmwareTestSelection = 'scenario' | 'scenarios' | 'report' | 'firmware'
export interface FirmwareTestRequest {
  id: string
  workspaceRoot: string
  path?: string
  replay?: string
  firmware?: string
  compiler?: string
}
export interface FirmwareTestResponse {
  report: SuiteReport
  reportPath: string
  summaryPath: string
  notes: string[]
}
