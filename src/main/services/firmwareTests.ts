import { realpath, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import type { FirmwareScenario, FirmwareTestRequest, FirmwareTestResponse, FirmwareTestSelection, SuiteReport } from '../../shared/firmwareTest'
import { isWithin } from '../../shared/security'
import * as files from './fsService'
import { safeCommand } from './commandResolver'
import { readBoundedJson, replayEntries, scenarioPaths } from '../firmwareTesting/suiteEntries'
import type { ReplayEntry } from '../firmwareTesting/suiteEntries'
import { validateScenario } from '../firmwareTesting/scenario'
import { runScenario, sha256 } from '../firmwareTesting/runner'
import { renderSuiteSummary, suiteExitCode } from '../firmwareTesting/reports'

interface ActiveRun { id: string; controller: AbortController; done?: Promise<FirmwareTestResponse> }
let active: ActiveRun | null = null

function validateRequest(value: unknown): FirmwareTestRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid firmware test request')
  const request = value as Record<string, unknown>
  for (const key of Object.keys(request)) {
    if (!['id', 'workspaceRoot', 'path', 'replay', 'firmware', 'compiler'].includes(key)) throw new Error(`Unknown firmware test argument: ${key}`)
    if (typeof request[key] !== 'string' || !request[key] || (request[key] as string).length > 4096 || (request[key] as string).includes('\0')) throw new Error(`Invalid firmware test argument: ${key}`)
  }
  if (typeof request.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(request.id)) throw new Error('Invalid firmware test run id')
  if (typeof request.workspaceRoot !== 'string' || !files.isWorkspaceRoot(request.workspaceRoot)) throw new Error('Open the requested project before running firmware tests')
  if (request.path && request.replay) throw new Error('Use a scenario path or replay report, not both')
  if (request.compiler !== undefined && request.compiler !== 'g++' && request.compiler !== 'clang++') throw new Error('Desktop tests accept only the canonical g++ or clang++ host compiler')
  return request as unknown as FirmwareTestRequest
}

async function projectBoundary(root: string): Promise<{ physicalRoot: string; check: () => Promise<void>; admit: (path: string) => Promise<string> }> {
  const physicalRoot = await realpath(root)
  const check = async (): Promise<void> => {
    if (!files.isWorkspaceRoot(root) || await realpath(root) !== physicalRoot) throw new Error('The open project changed during firmware testing')
  }
  const admit = async (path: string): Promise<string> => {
    await check()
    const target = resolve(root, path)
    if (!isWithin(root, target) && !isWithin(physicalRoot, target)) throw new Error('Refused: firmware test path is outside the open project')
    const physical = await realpath(target)
    if (!isWithin(physicalRoot, physical)) throw new Error('Refused: firmware test path links outside the open project')
    return physical
  }
  return { physicalRoot, check, admit }
}

export async function validateSelection(kind: FirmwareTestSelection, path: string): Promise<string> {
  if (!['scenario', 'scenarios', 'report', 'firmware'].includes(kind)) throw new Error('Invalid firmware test selection')
  const root = files.getWorkspaceRoot()
  if (!root) throw new Error('Open a project before selecting firmware tests')
  const target = await (await projectBoundary(root)).admit(path)
  const info = await stat(target)
  if (kind === 'scenarios') {
    if (!info.isDirectory()) throw new Error('Select a scenario directory')
  } else {
    if (!info.isFile()) throw new Error('Select a regular file')
    if (kind === 'firmware' ? !/\.ino$/i.test(target) : !/\.json$/i.test(target)) throw new Error(kind === 'firmware' ? 'Select an .ino sketch' : 'Select a JSON file')
  }
  return target
}

export function run(value: unknown): Promise<FirmwareTestResponse> {
  let request: FirmwareTestRequest
  try {
    request = validateRequest(value)
    if (active) throw new Error('A firmware test suite is already running; stop it first')
  } catch (error) { return Promise.reject(error) }
  const operation: ActiveRun = { id: request.id, controller: new AbortController() }
  active = operation
  operation.done = execute(request, operation.controller).finally(() => { if (active === operation) active = null })
  return operation.done
}

async function execute(request: FirmwareTestRequest, controller: AbortController): Promise<FirmwareTestResponse> {
  const root = resolve(request.workspaceRoot)
  const boundary = await projectBoundary(root)
  const compiler = safeCommand(request.compiler || 'g++', root)
  if (!compiler) throw new Error('Host g++/clang++ was not found on PATH outside the project')
  const physicalCompiler = await realpath(compiler)
  if (isWithin(await realpath(root), physicalCompiler)) throw new Error('Refused: host compiler links inside the open project')
  const report: SuiteReport = { version: 1, generatedAt: new Date().toISOString(), exitCode: 0, reproducible: true, results: [] }
  const notes: string[] = []
  const timer = setTimeout(() => controller.abort(), 180_000)
  try {
    const defaultPath = await files.exists(join(root, '.cortex/scenarios')) ? '.cortex/scenarios' : 'examples/firmware-testing/scenarios'
    const entries: ReplayEntry[] = request.replay
      ? await replayEntries(await boundary.admit(request.replay))
      : (await scenarioPaths(await boundary.admit(request.path || defaultPath))).map(path => ({ path }))
    if (!entries.length || entries.length > 50) throw new Error('Desktop suites require 1..50 scenarios')
    // Validate the entire suite before compiling any native firmware.
    const admitted: { path: string; scenario: FirmwareScenario; firmware: string; sourceSha256?: string }[] = []
    for (const entry of entries) {
      const path = resolve(root, entry.path)
      if (!isWithin(root, path) && !isWithin(boundary.physicalRoot, path)) throw new Error('Refused: saved scenario path is outside the open project')
      const scenario = entry.scenario ?? validateScenario(await readBoundedJson(await boundary.admit(path), 2 * 1024 * 1024, 'Scenario'))
      const firmware = await boundary.admit(request.firmware || entry.firmware || resolve(dirname(path), scenario.firmware.source))
      if (!/\.ino$/i.test(firmware)) throw new Error('Firmware must be an .ino sketch')
      admitted.push({ path, scenario, firmware, sourceSha256: entry.sourceSha256 })
    }
    if (admitted.reduce((total, entry) => total + entry.scenario.limits.maxEvents, 0) > 100_000) throw new Error('Desktop suites allow at most 100000 aggregate maxEvents; reduce scenarios or their limits')
    if (Buffer.byteLength(JSON.stringify(admitted), 'utf8') > 2 * 1024 * 1024) throw new Error('Desktop suite configuration exceeds 2 MiB')
    const maxOutputBytes = Math.floor(4 * 1024 * 1024 / admitted.length)
    for (const entry of admitted) {
      await boundary.check()
      if (controller.signal.aborted) break
      const result = await runScenario(entry.path, { compiler, firmware: entry.firmware, scenario: entry.scenario, signal: controller.signal, maxOutputBytes })
      report.results.push(result)
      if (entry.sourceSha256 && result.build && entry.sourceSha256 !== result.build.sourceSha256) notes.push(`${result.scenario.id}: firmware source changed since the saved report; saved inputs ran against the current source.`)
      if (controller.signal.aborted) break
    }
    if (controller.signal.aborted) {
      report.cancelled = true
      notes.push('Firmware test suite cancelled or its 180-second host watchdog expired; remaining scenarios were not run.')
      for (const entry of admitted.slice(report.results.length)) report.results.push({
        version: 1, status: 'error', scenarioPath: entry.path, scenario: entry.scenario, firmwarePath: entry.firmware,
        error: 'Not executed: firmware test suite cancelled', assertions: [], timeline: [],
        execution: { hostWallMs: 0, virtualDurationMs: 0, exitCode: null, traceSha256: sha256('[]') },
        logs: { stdout: '', stderr: '', compiler: '' }
      })
    }
    report.exitCode = report.cancelled ? 2 : suiteExitCode(report.results)
    await boundary.check()
    const directory = join(root, '.cortex/test-results', randomUUID())
    await files.createDir(directory)
    await boundary.check()
    const reportPath = join(directory, 'report.json')
    const summaryPath = join(directory, 'summary.md')
    const json = JSON.stringify(report, null, 2) + '\n'
    if (Buffer.byteLength(json, 'utf8') > 32 * 1024 * 1024) throw new Error('Desktop report exceeds 32 MiB; reduce the suite output or assertion evidence')
    await files.writeFile(reportPath, json, null)
    await boundary.check()
    await files.writeFile(summaryPath, renderSuiteSummary(report), null)
    return { report, reportPath, summaryPath, notes }
  } finally { clearTimeout(timer) }
}

export async function stop(id: string): Promise<void> {
  if (typeof id !== 'string') throw new Error('Invalid firmware test run id')
  const operation = active
  if (!operation || operation.id !== id) return
  operation.controller.abort()
  await operation.done?.catch(() => {})
}

export function killAll(): void { active?.controller.abort() }
