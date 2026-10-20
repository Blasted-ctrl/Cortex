import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { cpus, release, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { BuildConfiguration, FirmwareScenario, SuiteReport, SuiteResult } from '../../../shared/firmwareTest'
import { safeCommand } from '../../services/commandResolver'
import { runProcess } from '../process'
import { suiteExitCode, writeSuiteReport } from '../reports'
import { runScenario } from '../runner'
import { loadScenario } from '../scenario'
import { scenarioPaths } from '../suiteEntries'
import { BoardLink, choosePort, compileAndUpload, describePort, listPorts, resolveArduinoCli } from './board'
import { compareReports, renderParity } from './parity'
import { boardReport, encodeSchedule, TraceParser, type BoardRun } from './protocol'
import { deviceDirectory, writeHilSketch } from './sketch'

const HELP = `Cortex hardware-in-the-loop tests

  npm run hil:test -- [scenario.json | directory] [options]
  npm run hil:selftest -- [options]
  npm run hil:ports

Runs the same scenario files in the host simulator and on a connected board, writes
the usual reports for each and a simulation-vs-hardware comparison.

Options:
  --fqbn <fqbn>          Board, e.g. teensy:avr:teensy41 (default: CORTEX_HIL_FQBN)
  --port <port>          Serial port (default: CORTEX_HIL_PORT, else the only connected board)
  --firmware <path.ino>  Sketch to test (default: the scenarios' firmware.source)
  --report-dir <path>    Default: .cortex/hil-results
  --no-upload            Do not flash; the board already runs the matching build
  --arduino-cli <path>   arduino-cli binary (default: ARDUINO_CLI, PATH, then Cortex's own copy)
  --compiler g++|clang++ Host compiler for the simulator side

Exit codes: 0 every board check passed, 1 a board check failed, 2 build, upload,
connection or timeout error. Flashing happens only through these commands.
`

interface Arguments {
  command: 'test' | 'selftest' | 'ports'
  path?: string
  fqbn?: string
  port?: string
  firmware?: string
  reportDir: string
  upload: boolean
  arduinoCli?: string
  compiler?: string
}

function parseArguments(argv: string[]): Arguments {
  const command = argv[0]
  if (command !== 'test' && command !== 'selftest' && command !== 'ports') throw new Error('Expected test, selftest or ports; use --help')
  const args: Arguments = {
    command, reportDir: '.cortex/hil-results', upload: true,
    fqbn: process.env['CORTEX_HIL_FQBN'] || undefined, port: process.env['CORTEX_HIL_PORT'] || undefined
  }
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]
    if (!flag.startsWith('-')) {
      if (args.path || command !== 'test') throw new Error(`Unexpected argument: ${flag}`)
      args.path = flag
      continue
    }
    if (flag === '--no-upload') { args.upload = false; continue }
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    if (flag === '--fqbn') args.fqbn = value
    else if (flag === '--port') args.port = value
    else if (flag === '--firmware') args.firmware = value
    else if (flag === '--report-dir') args.reportDir = value
    else if (flag === '--arduino-cli') args.arduinoCli = value
    else if (flag === '--compiler') args.compiler = value
    else throw new Error(`Unknown option: ${flag}`)
  }
  if (command !== 'ports' && !args.fqbn) throw new Error('Set the board with --fqbn or CORTEX_HIL_FQBN, e.g. teensy:avr:teensy41')
  if (args.fqbn && !/^[\w.-]+:[\w.-]+:[\w.-]+(:[\w.=,-]+)?$/.test(args.fqbn)) throw new Error(`Not a board FQBN: ${args.fqbn}`)
  return args
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

async function gitState(cwd: string): Promise<{ revision: string | null; dirty: boolean | null }> {
  const git = safeCommand('git')
  if (!git) return { revision: null, dirty: null }
  const rev = await runProcess(git, ['rev-parse', 'HEAD'], { cwd, timeoutMs: 5000 })
  const status = await runProcess(git, ['status', '--porcelain'], { cwd, timeoutMs: 5000 })
  return { revision: rev.code === 0 ? rev.stdout.trim() : null, dirty: status.code === 0 ? !!status.stdout.trim() : null }
}

/** Writes the markdown to the GitHub Actions job summary when running there. */
async function toJobSummary(markdown: string): Promise<void> {
  const summary = process.env['GITHUB_STEP_SUMMARY']
  if (summary) await appendFile(summary, `${markdown}\n`, 'utf8')
}

async function boardPort(args: Arguments): Promise<string> {
  return choosePort(await listPorts(), args.port)
}

/** One scenario on the board. The board restarts afterwards so the next one starts from fresh globals. */
async function runOnBoard(link: BoardLink, scenario: FirmwareScenario, last: boolean): Promise<BoardRun> {
  const started = performance.now()
  const trace = new TraceParser()
  const stop = (error: string): BoardRun => ({ trace, output: link.takeOutput(), hostWallMs: performance.now() - started, error })
  let ready = await link.waitFor((l) => l.startsWith('@hil ready'), 3000)
  if (!ready) {
    await link.reset()
    ready = await link.waitFor((l) => l.startsWith('@hil ready'), 15_000)
  }
  if (!ready) return stop('The board never announced "@hil ready". Is the HIL build flashed (omit --no-upload)?')
  for (const line of encodeSchedule(scenario)) await link.send(line)
  const accepted = await link.waitFor((l) => l.startsWith('@hil scheduled') || l.startsWith('@hil error'), 5000)
  if (!accepted?.startsWith('@hil scheduled')) return stop(`The board did not accept the schedule${accepted ? `: ${accepted}` : ''}`)
  await link.send('@hil go')
  const limitMs = scenario.limits.durationMs + Math.max(scenario.limits.wallTimeoutMs, 5000)
  const deadline = Date.now() + limitMs
  for (;;) {
    const line = await link.next(Math.max(0, deadline - Date.now()))
    if (line === null) return stop(`The board did not finish within ${limitMs} ms`)
    if (line === '@hil done') break
    trace.push(line)
  }
  const run: BoardRun = { trace, output: link.takeOutput(), hostWallMs: performance.now() - started }
  if (!last) await link.reset()
  return run
}

async function testCommand(args: Arguments): Promise<number> {
  const paths = await scenarioPaths(args.path || 'examples/firmware-testing/scenarios')
  const scenarios = await Promise.all(paths.map((p) => loadScenario(p)))
  const sources = new Set(scenarios.map((s, i) => resolve(dirname(paths[i]), s.firmware.source)))
  if (!args.firmware && sources.size !== 1) throw new Error('These scenarios name different sketches; choose one with --firmware (one board build per run)')
  const firmware = args.firmware ? resolve(args.firmware) : [...sources][0]
  const reportDir = resolve(args.reportDir)
  await mkdir(reportDir, { recursive: true })

  console.log(`Simulator: ${paths.length} scenario(s) against ${firmware}`)
  const simResults: SuiteResult[] = []
  for (const path of paths) {
    const result = await runScenario(path, { compiler: args.compiler, firmware })
    simResults.push(result)
    console.log(`  ${result.status.toUpperCase()} ${'scenario' in result ? result.scenario.id : path}`)
  }
  const simReport: SuiteReport = { version: 1, generatedAt: new Date().toISOString(), exitCode: suiteExitCode(simResults), reproducible: true, results: simResults }
  await writeSuiteReport(join(reportDir, 'sim'), simReport)

  const port = await boardPort(args)
  const cli = resolveArduinoCli(args.arduinoCli)
  const fqbn = args.fqbn!
  const target = `${fqbn} on ${port}`
  const work = await mkdtemp(join(tmpdir(), 'cortex-hil-'))
  const boardResults: SuiteResult[] = []
  try {
    const started = performance.now()
    const sketch = await writeHilSketch(firmware, work)
    console.log(`Board: building ${fqbn}${args.upload ? ` and flashing ${port}` : ` (not flashing; ${port} must already run this build)`}`)
    const built = await compileAndUpload(cli, fqbn, sketch.sketchDir, join(work, 'build'), args.upload ? port : null)
    const { revision, dirty } = await gitState(dirname(firmware))
    const build: BuildConfiguration = {
      compiler: cli, compilerVersion: `${built.version}; board ${fqbn}`, args: built.args, sourcePath: firmware,
      sourceSha256: sketch.sourceSha256, shimSha256: sketch.layerSha256, runnerSha256: sketch.sketchSha256,
      host: { platform: process.platform, arch: process.arch, release: release(), cpu: cpus()[0]?.model || 'unknown', node: process.version },
      revision, dirty, buildWallMs: performance.now() - started
    }
    if (args.upload) await sleep(1500)
    const link = new BoardLink(port)
    await link.open()
    try {
      for (let i = 0; i < scenarios.length; i++) {
        const run = await runOnBoard(link, scenarios[i], i === scenarios.length - 1)
        const report = boardReport(resolve(paths[i]), scenarios[i], firmware, build, built.log, run)
        boardResults.push(report)
        console.log(`  ${report.status.toUpperCase()} ${scenarios[i].id}: ${report.assertions.filter((a) => a.passed).length}/${report.assertions.length} assertions; ${report.execution.virtualDurationMs}ms board time`)
        if (report.error) console.error(`    ${report.error.split('\n')[0]}`)
        for (const failed of report.assertions.filter((a) => !a.passed)) console.error(`    FAIL ${failed.id} at ${failed.atMs}ms: ${failed.message}`)
      }
    } finally {
      await link.close()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    boardResults.push({ status: 'error', scenarioPath: args.path || 'examples/firmware-testing/scenarios', error: message })
    console.error(`ERROR ${message.split('\n')[0]}`)
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  }
  const boardSuite: SuiteReport = { version: 1, generatedAt: new Date().toISOString(), exitCode: suiteExitCode(boardResults), reproducible: true, target, results: boardResults }
  await writeSuiteReport(join(reportDir, 'board'), boardSuite)
  const rows = compareReports(simReport, boardSuite)
  const parity = renderParity(rows, target)
  await writeFile(join(reportDir, 'parity.md'), parity, 'utf8')
  await writeFile(join(reportDir, 'parity.json'), JSON.stringify({ target, rows }, null, 2) + '\n', 'utf8')
  await toJobSummary(parity)
  console.log(`\n${parity}`)
  console.log(`Reports: ${reportDir} (sim/, board/, parity.md)`)
  return boardSuite.exitCode
}

interface Check { name: string; expected: string; actual: string; passed: boolean }

async function selftestCommand(args: Arguments): Promise<number> {
  const port = await boardPort(args)
  const cli = resolveArduinoCli(args.arduinoCli)
  const reportDir = resolve(args.reportDir)
  await mkdir(reportDir, { recursive: true })
  const work = await mkdtemp(join(tmpdir(), 'cortex-hil-selftest-'))
  const checks: Check[] = []
  let error: string | undefined
  try {
    console.log(`Self-test: building for ${args.fqbn}${args.upload ? ` and flashing ${port}` : ''}`)
    await compileAndUpload(cli, args.fqbn!, join(deviceDirectory(), 'selftest'), join(work, 'build'), args.upload ? port : null)
    if (args.upload) await sleep(1500)
    const link = new BoardLink(port)
    await link.open()
    try {
      // The sketch repeats its checks every second; read one complete block.
      if (!await link.waitFor((l) => l === 'HIL selftest begin', 20_000)) throw new Error('The self-test sketch did not report; is it flashed?')
      for (;;) {
        const line = await link.next(10_000)
        if (line === null) throw new Error('The self-test stopped reporting')
        if (line.startsWith('HIL_DONE')) break
        const match = line.match(/^HIL selftest (\S+) (\S+) (\S+) (PASS|FAIL)$/)
        if (match) checks.push({ name: match[1], expected: match[2], actual: match[3], passed: match[4] === 'PASS' })
      }
    } finally {
      await link.close()
    }
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure)
  } finally {
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
  }
  const exitCode = error || checks.length === 0 ? 2 : checks.every((c) => c.passed) ? 0 : 1
  const markdown = [
    '# Electrical self-test', '', `Board: ${args.fqbn} on ${port}. Wiring: docs/HIL.md. Exit code ${exitCode}.`, '',
    ...(error ? ['```text', error, '```', ''] : []),
    '| Check | Expected | Actual | Result |', '| --- | --- | --- | --- |',
    ...checks.map((c) => `| ${c.name} | ${c.expected} | ${c.actual} | ${c.passed ? 'PASS' : 'FAIL'} |`), ''
  ].join('\n')
  await writeFile(join(reportDir, 'selftest.md'), markdown, 'utf8')
  await writeFile(join(reportDir, 'selftest.json'), JSON.stringify({ fqbn: args.fqbn, port, exitCode, error: error ?? null, checks }, null, 2) + '\n', 'utf8')
  await toJobSummary(markdown)
  console.log(markdown)
  return exitCode
}

async function portsCommand(args: Arguments): Promise<number> {
  const ports = await listPorts()
  for (const port of ports) console.log(`  ${describePort(port)}`)
  console.log(`Chosen: ${choosePort(ports, args.port)}`)
  return 0
}

export async function main(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return 0 }
  try {
    const args = parseArguments(argv)
    return args.command === 'test' ? await testCommand(args) : args.command === 'selftest' ? await selftestCommand(args) : await portsCommand(args)
  } catch (error) {
    console.error(`HIL error: ${error instanceof Error ? error.message : String(error)}`)
    return 2
  }
}

if (require.main === module) void main(process.argv.slice(2)).then((code) => { process.exitCode = code })
