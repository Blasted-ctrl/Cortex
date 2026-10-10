import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { resolve } from 'path'
import type { BuildConfiguration, FirmwareReport } from '../../shared/firmwareTest'
import { disposePrepared, executePrepared, prepareScenario } from './runner'

export interface BenchmarkOptions {
  runs: number
  warmup?: number
  baseline?: string
  compiler?: string
  firmware?: string
}

export interface MetricSummary {
  min: number
  median: number
  p95: number
  max: number
  mean: number
}

export interface BenchmarkSample {
  run: number
  status: FirmwareReport['status']
  hostWallMs: number
  virtualDurationMs: number
  outputEvents: number
  virtualMsPerHostSecond: number
  outputEventsPerHostSecond: number
  traceSha256: string
}

type MetricName = 'hostWallMs' | 'virtualMsPerHostSecond' | 'outputEventsPerHostSecond'

export interface BenchmarkComparison {
  status: 'not-requested' | 'incompatible' | 'compared'
  baselinePath?: string
  reason?: string
  advisory: true
  thresholdPercent: 20
  regression: boolean
  measurements: Array<{
    metric: MetricName
    baseline: number
    current: number
    changePercent: number
    regression: boolean
  }>
}

export interface BenchmarkReport {
  version: 1
  generatedAt: string
  status: FirmwareReport['status']
  error?: string
  scenarioPath: string
  scenarioId: string
  workloadSha256: string
  runs: number
  warmup: number
  build: BuildConfiguration
  samples: BenchmarkSample[]
  metrics: Record<MetricName, MetricSummary> | null
  reproducible: boolean
  traceSha256: string | null
  failures: FirmwareReport[]
  comparison: BenchmarkComparison
  measurementScope: string
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
const positiveFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

function summarize(values: number[]): MetricSummary {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return {
    min: sorted[0],
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  }
}

async function loadBaseline(path: string): Promise<BenchmarkReport> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(resolve(path), 'utf8'))
  } catch (error) {
    throw new Error(`Cannot load benchmark baseline ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const value = parsed as Partial<BenchmarkReport> | null
  const metrics: MetricName[] = ['hostWallMs', 'virtualMsPerHostSecond', 'outputEventsPerHostSecond']
  if (!value || value.version !== 1 || value.status !== 'passed' || value.reproducible !== true ||
      typeof value.workloadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.workloadSha256) ||
      !Number.isInteger(value.runs) || Number(value.runs) < 1 || !Number.isInteger(value.warmup) || Number(value.warmup) < 0 ||
      !value.build || typeof value.build.compilerVersion !== 'string' || typeof value.build.sourcePath !== 'string' ||
      !Array.isArray(value.build.args) || !value.build.args.length || !value.build.args.every(argument => typeof argument === 'string') ||
      !value.build.host || !['platform', 'arch', 'release', 'cpu', 'node'].every(key =>
        typeof value.build?.host[key as keyof BuildConfiguration['host']] === 'string') ||
      !Array.isArray(value.samples) || value.samples.length !== value.runs ||
      !value.samples.every(sample => sample && typeof sample === 'object' && sample.status === 'passed' && positiveFinite(sample.hostWallMs) &&
        positiveFinite(sample.virtualMsPerHostSecond) && positiveFinite(sample.outputEventsPerHostSecond)) ||
      !value.metrics || !metrics.every(metric => {
        const summary = value.metrics?.[metric]
        return summary && ['min', 'median', 'p95', 'max', 'mean'].every(key =>
          positiveFinite(summary[key as keyof MetricSummary]))
      })) {
    throw new Error(`Invalid benchmark baseline ${path}: expected a successful, reproducible version 1 benchmark report with finite metrics and complete build metadata`)
  }
  return value as BenchmarkReport
}

function normalizedArgs(build: BuildConfiguration): string[] {
  // Builds use fresh temporary directories. Keep flags, but normalize generated paths.
  const sketch = build.args[0].replaceAll('\\', '/')
  const buildDirectory = sketch.slice(0, sketch.lastIndexOf('/'))
  const source = build.sourcePath.replaceAll('\\', '/')
  const sourceDirectory = source.slice(0, source.lastIndexOf('/'))
  return build.args.map(argument => {
    const normalized = argument.replaceAll('\\', '/')
    if (normalized === source) return '<firmware>'
    if (normalized === buildDirectory) return '<build>'
    if (normalized.startsWith(`${buildDirectory}/`)) return `<build>/${normalized.slice(buildDirectory.length + 1)}`
    if (normalized === sourceDirectory) return '<firmware-dir>'
    if (normalized.startsWith(`${sourceDirectory}/`)) return `<firmware-dir>/${normalized.slice(sourceDirectory.length + 1)}`
    return normalized
  })
}

function compare(report: BenchmarkReport, baseline: BenchmarkReport | undefined, baselinePath?: string): BenchmarkComparison {
  const comparison: BenchmarkComparison = {
    status: 'not-requested', advisory: true, thresholdPercent: 20, regression: false, measurements: [],
  }
  if (!baseline) {
    comparison.reason = 'No baseline requested; save this report after establishing normal host variability.'
    return comparison
  }
  comparison.baselinePath = resolve(baselinePath!)
  const differences: string[] = []
  if (report.status !== 'passed' || !report.reproducible) differences.push('current workload did not pass reproducibly')
  if (report.workloadSha256 !== baseline.workloadSha256) differences.push('scenario, firmware, or simulation shim changed')
  if (report.runs !== baseline.runs || report.warmup !== baseline.warmup) differences.push('run/warmup counts differ')
  if (report.build.compilerVersion !== baseline.build.compilerVersion) differences.push('compiler version differs')
  if (JSON.stringify(normalizedArgs(report.build)) !== JSON.stringify(normalizedArgs(baseline.build))) differences.push('compiler flags differ')
  for (const key of ['platform', 'arch', 'cpu', 'node'] as const) {
    if (report.build.host[key] !== baseline.build.host[key]) differences.push(`host ${key} differs`)
  }
  // Kernel patch releases can vary on hosted CI; platform, architecture, CPU and Node must match.
  if (differences.length) {
    comparison.status = 'incompatible'
    comparison.reason = differences.join('; ')
    return comparison
  }
  comparison.status = 'compared'
  for (const metric of ['hostWallMs', 'virtualMsPerHostSecond', 'outputEventsPerHostSecond'] as const) {
    const previous = baseline.metrics![metric].median
    const current = report.metrics![metric].median
    const changePercent = (current / previous - 1) * 100
    const regression = metric === 'hostWallMs' ? changePercent > 20 : changePercent < -20
    comparison.measurements.push({ metric, baseline: previous, current, changePercent, regression })
  }
  comparison.regression = comparison.measurements.some(measurement => measurement.regression)
  comparison.reason = comparison.regression
    ? 'Advisory: at least one median worsened by more than 20%; inspect host variability before treating this as a regression.'
    : 'All median measurements are within the advisory 20% regression threshold.'
  return comparison
}

/** Build once, then start a fresh simulator process for every warmup and measured run. */
export async function benchmark(scenarioPath: string, options: BenchmarkOptions): Promise<BenchmarkReport> {
  const warmup = options.warmup ?? 2
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 1000 ||
      !Number.isInteger(warmup) || warmup < 0 || warmup > 100) {
    throw new Error('Benchmark requires 1..1000 measured runs and 0..100 warmup runs')
  }
  const baseline = options.baseline ? await loadBaseline(options.baseline) : undefined
  const prepared = await prepareScenario(scenarioPath, { compiler: options.compiler, firmware: options.firmware })
  const report: BenchmarkReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    status: 'passed',
    scenarioPath: prepared.scenarioPath,
    scenarioId: prepared.scenario.id,
    workloadSha256: sha256(JSON.stringify({
      scenario: prepared.scenario,
      sourceSha256: prepared.build.sourceSha256,
      shimSha256: prepared.build.shimSha256,
    })),
    runs: options.runs,
    warmup,
    build: prepared.build,
    samples: [],
    metrics: null,
    reproducible: true,
    traceSha256: null,
    failures: [],
    comparison: { status: 'not-requested', advisory: true, thresholdPercent: 20, regression: false, measurements: [] },
    measurementScope: 'Host wall time includes simulator process startup, execution and output collection. Compilation and warmups are excluded. Virtual time is a model quantity, not hardware timing or host performance.',
  }
  try {
    for (let index = 0; index < warmup + options.runs; index++) {
      const execution = await executePrepared(prepared)
      if (execution.status !== 'passed') {
        report.failures.push(execution)
        report.status = execution.status === 'error' ? 'error' : report.status === 'error' ? 'error' : 'failed'
        report.error ??= execution.error ?? `Benchmark firmware assertions failed in ${index < warmup ? 'warmup' : 'measured'} run ${index < warmup ? index + 1 : index - warmup + 1}`
      }
      if (report.traceSha256 === null) report.traceSha256 = execution.execution.traceSha256
      else if (report.traceSha256 !== execution.execution.traceSha256) report.reproducible = false
      if (execution.status === 'error' && index < warmup) break
      if (index < warmup) continue
      const hostWallMs = execution.execution.hostWallMs
      const virtualDurationMs = execution.execution.virtualDurationMs
      const outputEvents = execution.timeline.filter(event => event.kind !== 'input').length
      if (!positiveFinite(hostWallMs)) {
        report.status = 'error'
        report.error ??= 'Runner returned a non-positive or non-finite host duration'
        break
      }
      report.samples.push({
        run: index - warmup + 1,
        status: execution.status,
        hostWallMs,
        virtualDurationMs,
        outputEvents,
        virtualMsPerHostSecond: virtualDurationMs * 1000 / hostWallMs,
        outputEventsPerHostSecond: outputEvents * 1000 / hostWallMs,
        traceSha256: execution.execution.traceSha256,
      })
      if (execution.status === 'error') break
    }
    if (!report.reproducible && report.status === 'passed') {
      report.status = 'failed'
      report.error = 'Identical benchmark runs produced different simulation traces'
    }
    if (report.samples.length) {
      report.metrics = {
        hostWallMs: summarize(report.samples.map(sample => sample.hostWallMs)),
        virtualMsPerHostSecond: summarize(report.samples.map(sample => sample.virtualMsPerHostSecond)),
        outputEventsPerHostSecond: summarize(report.samples.map(sample => sample.outputEventsPerHostSecond)),
      }
    }
    report.comparison = compare(report, baseline, options.baseline)
    return report
  } finally {
    await disposePrepared(prepared)
  }
}

export function renderBenchmarkSummary(report: BenchmarkReport): string {
  const lines = [
    `# Firmware benchmark: ${report.scenarioId}`,
    '',
    `Status: **${report.status.toUpperCase()}**. ${report.samples.length}/${report.runs} measured runs, ${report.warmup} warmups.`,
    `Identical traces: ${report.reproducible ? 'yes' : 'NO'}.`,
    '',
    report.measurementScope,
    '',
    `Host: ${report.build.host.platform}/${report.build.host.arch}; ${report.build.host.cpu}; Node ${report.build.host.node}.`,
    `Compiler: ${report.build.compilerVersion.split('\n')[0]}. Revision: ${report.build.revision ?? 'unknown'}${report.build.dirty ? ' (dirty worktree)' : ''}.`,
    `Workload SHA-256: \`${report.workloadSha256}\`.`,
    '',
  ]
  if (report.error) lines.push(`Error: ${report.error}`, '')
  if (report.metrics) {
    lines.push('| Measurement | Median | p95 | Min | Max |', '| --- | ---: | ---: | ---: | ---: |')
    const labels: Record<MetricName, string> = {
      hostWallMs: 'Host execution (ms)',
      virtualMsPerHostSecond: 'Virtual ms / host second (model throughput)',
      outputEventsPerHostSecond: 'Output events / host second',
    }
    for (const metric of ['hostWallMs', 'virtualMsPerHostSecond', 'outputEventsPerHostSecond'] as const) {
      const summary = report.metrics[metric]
      lines.push(`| ${labels[metric]} | ${summary.median.toFixed(2)} | ${summary.p95.toFixed(2)} | ${summary.min.toFixed(2)} | ${summary.max.toFixed(2)} |`)
    }
    lines.push('')
  }
  lines.push(`Baseline: ${report.comparison.status}. ${report.comparison.reason ?? ''}`, '')
  if (report.comparison.status === 'compared') {
    lines.push('| Median measurement | Baseline | Current | Change | Advisory |', '| --- | ---: | ---: | ---: | --- |')
    for (const measurement of report.comparison.measurements) {
      lines.push(`| ${measurement.metric} | ${measurement.baseline.toFixed(2)} | ${measurement.current.toFixed(2)} | ${measurement.changePercent >= 0 ? '+' : ''}${measurement.changePercent.toFixed(1)}% | ${measurement.regression ? 'Investigate' : 'Within threshold'} |`)
    }
    lines.push('')
  }
  lines.push('Performance comparisons are advisory and never change the exit status. Assertion errors and non-repeatable traces do fail the benchmark.', '')
  return lines.join('\n')
}
