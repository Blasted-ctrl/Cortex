import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { disposePrepared, executePrepared, prepareScenario, runScenario, ScenarioPreparationError } from './runner'
import { replayEntries, scenarioPaths } from './suiteEntries'
import type { ReplayEntry } from './suiteEntries'
import { benchmark, renderBenchmarkSummary } from './benchmark'
import { suiteExitCode, writeSuiteReport } from './reports'
import type { SuiteReport } from './reports'

const HELP = `Cortex firmware tests (host Arduino Uno model)

  npm run firmware:test -- [scenario.json | directory] [options]
  npm run firmware:test -- --replay report.json [options]
  npm run firmware:selftest
  npm run firmware:bench -- [scenario.json] [options]

Test options:
  --compiler g++|clang++  Host compiler (absolute tool path also accepted)
  --firmware path.ino    Override the sketch, for a failure/fix comparison
  --report-dir path      Default: .cortex/test-results
  --repeat N             Repeat each scenario with fresh state (1..100)
  --replay report.json   Rerun embedded scenario configs against saved source paths

Benchmark options:
  --runs N               Measured repetitions (default 10)
  --warmup N             Unmeasured repetitions (default 2)
  --baseline path        Compare an existing successful benchmark report
  --save-baseline path   Save a successful, repeatable run as a baseline
  --report-dir path      Default: .cortex/benchmarks
  --compiler / --firmware as above

Exit codes: 0 pass, 1 behavior/reproducibility failure, 2 runner/configuration error.
Performance alerts are advisory. Tests run trusted native firmware on the host.
`

interface Arguments {
  command: 'test' | 'selftest' | 'bench'
  path?: string
  compiler?: string
  firmware?: string
  reportDir: string
  repeat: number
  runs: number
  warmup: number
  baseline?: string
  saveBaseline?: string
  replay?: string
}

function numberOption(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} must be an integer from ${min} to ${max}`)
  return Number(value)
}

function parseArguments(argv: string[]): Arguments {
  const command = argv[0]
  if (command !== 'test' && command !== 'bench' && command !== 'selftest') throw new Error('Expected test, bench or selftest command; use --help')
  const args: Arguments = {
    command, reportDir: command === 'bench' ? '.cortex/benchmarks' : command === 'selftest' ? '.cortex/selftest-results' : '.cortex/test-results',
    repeat: 1, runs: 10, warmup: 2
  }
  const seen = new Set<string>()
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]
    if (!flag.startsWith('-')) {
      if (args.path || command === 'selftest') throw new Error(`Unexpected positional argument: ${flag}`)
      args.path = flag
      continue
    }
    const common = ['--compiler', '--firmware', '--report-dir']
    const allowed = command === 'test' ? [...common, '--repeat', '--replay']
      : command === 'bench' ? [...common, '--runs', '--warmup', '--baseline', '--save-baseline'] : ['--compiler', '--report-dir']
    if (!allowed.includes(flag)) throw new Error(`Unknown option for ${command}: ${flag}`)
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`)
    seen.add(flag)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    if (flag === '--compiler') args.compiler = value
    if (flag === '--firmware') args.firmware = value
    if (flag === '--report-dir') args.reportDir = value
    if (flag === '--repeat') args.repeat = numberOption(value, flag, 1, 100)
    if (flag === '--runs') args.runs = numberOption(value, flag, 1, 1000)
    if (flag === '--warmup') args.warmup = numberOption(value, flag, 0, 100)
    if (flag === '--baseline') args.baseline = value
    if (flag === '--save-baseline') args.saveBaseline = value
    if (flag === '--replay') args.replay = value
  }
  if (args.path && args.replay) throw new Error('Use a scenario path or --replay, not both')
  return args
}

async function testSuite(args: Arguments): Promise<number> {
  const report: SuiteReport = { version: 1, generatedAt: new Date().toISOString(), exitCode: 0, reproducible: true, results: [] }
  let entries: ReplayEntry[]
  try {
    entries = args.replay ? await replayEntries(args.replay) : (await scenarioPaths(args.path || 'examples/firmware-testing/scenarios')).map(path => ({ path }))
  } catch (error) {
    report.results.push({ status: 'error', scenarioPath: args.replay || args.path || 'default suite', error: error instanceof Error ? error.message : String(error) })
    entries = []
  }
  for (const entry of entries) {
    let prepared: Awaited<ReturnType<typeof prepareScenario>> | undefined
    try {
      prepared = await prepareScenario(entry.path, { compiler: args.compiler, firmware: args.firmware || entry.firmware, scenario: entry.scenario })
      if (entry.sourceSha256 && entry.sourceSha256 !== prepared.build.sourceSha256) console.log(`NOTE ${prepared.scenario.id}: firmware source changed since the saved report; rerunning saved inputs against the current source.`)
      let trace: string | undefined
      for (let index = 0; index < args.repeat; index++) {
        const result = await executePrepared(prepared)
        if (trace && trace !== result.execution.traceSha256) report.reproducible = false
        trace = result.execution.traceSha256
        report.results.push({ ...result, repeat: index + 1 })
        console.log(`${result.status.toUpperCase()} ${result.scenario.id}${args.repeat > 1 ? ` (${index + 1}/${args.repeat})` : ''}: ${result.assertions.filter(a => a.passed).length}/${result.assertions.length} assertions; ${result.execution.virtualDurationMs}ms virtual, ${result.execution.hostWallMs.toFixed(2)}ms host`)
        if (result.error) console.error(result.error)
        for (const failed of result.assertions.filter(a => !a.passed)) console.error(`  FAIL ${failed.id} at ${failed.atMs}ms: ${failed.message}`)
        if (result.status === 'error') break
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      report.results.push(error instanceof ScenarioPreparationError ? error.report : { status: 'error', scenarioPath: entry.path, error: message })
      console.error(`ERROR ${entry.path}: ${message}`)
    } finally {
      if (prepared) await disposePrepared(prepared)
    }
  }
  report.exitCode = suiteExitCode(report.results, report.reproducible)
  await writeSuiteReport(args.reportDir, report)
  if (!report.reproducible) console.error('FAIL: identical scenarios produced different virtual traces')
  console.log(`Reports: ${resolve(args.reportDir)} (report.json, summary.md)`)
  return report.exitCode
}

async function selftest(args: Arguments): Promise<number> {
  const path = resolve('examples/firmware-testing/scenarios/sensor-timeout.json')
  const broken = await runScenario(path, { compiler: args.compiler, firmware: 'examples/firmware-testing/fixtures/broken-timeout.ino' })
  const scenario = structuredClone(broken.scenario)
  scenario.limits.wallTimeoutMs = 1000
  const hung = await runScenario(path, { compiler: args.compiler, scenario, firmware: 'examples/firmware-testing/fixtures/hanging.ino' })
  const catchesBroken = broken.status === 'failed' && broken.assertions.some(a => a.id === 'sensor-timeout-shutdown' && !a.passed)
  const catchesHang = hung.status === 'error' && !!hung.error?.includes('Wall-clock timeout')
  const exitCode = catchesBroken && catchesHang ? 0 : 2
  const report: SuiteReport = { version: 1, generatedAt: new Date().toISOString(), exitCode, reproducible: true, expectedNegativeTests: true, results: [broken, hung] }
  await writeSuiteReport(args.reportDir, report)
  console.log(`${catchesBroken ? 'PASS' : 'ERROR'} harness catches sensor-timeout-shutdown assertion in broken firmware`)
  console.log(`${catchesHang ? 'PASS' : 'ERROR'} independent watchdog terminates hanging firmware as a runner error`)
  console.log(`Expected negative-test reports: ${resolve(args.reportDir)}`)
  return exitCode
}

async function runBenchmark(args: Arguments): Promise<number> {
  const report = await benchmark(args.path || 'examples/firmware-testing/benchmark.json', {
    runs: args.runs, warmup: args.warmup, baseline: args.baseline, compiler: args.compiler, firmware: args.firmware
  })
  const path = resolve(args.reportDir)
  await mkdir(path, { recursive: true })
  const json = JSON.stringify(report, null, 2) + '\n'
  await Promise.all([
    writeFile(join(path, 'benchmark.json'), json, 'utf8'),
    writeFile(join(path, 'summary.md'), renderBenchmarkSummary(report), 'utf8')
  ])
  if (args.saveBaseline) {
    if (report.status !== 'passed' || !report.reproducible) throw new Error('Refusing to save a failing or non-repeatable benchmark as a baseline')
    const baselinePath = resolve(args.saveBaseline)
    await mkdir(dirname(baselinePath), { recursive: true })
    await writeFile(baselinePath, json, 'utf8')
    console.log(`Saved baseline: ${baselinePath}`)
  }
  console.log(renderBenchmarkSummary(report))
  console.log(`Reports: ${path}`)
  return report.status === 'error' ? 2 : report.status === 'failed' ? 1 : 0
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return 0 }
  try {
    const args = parseArguments(argv)
    return args.command === 'test' ? await testSuite(args) : args.command === 'bench' ? await runBenchmark(args) : await selftest(args)
  } catch (error) {
    console.error(`Runner error: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

if (require.main === module) void main(process.argv.slice(2)).then(code => { process.exitCode = code })
