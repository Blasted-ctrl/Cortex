import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { SuiteResult, SuiteReport } from '../../shared/firmwareTest'
export type { RunnerFailure, SuiteResult, SuiteReport } from '../../shared/firmwareTest'

export function suiteExitCode(results: SuiteResult[], reproducible = true): number {
  return results.some(r => r.status === 'error') ? 2 : !reproducible || results.some(r => r.status === 'failed') ? 1 : 0
}

function escapeCell(value: string): string { return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ') }

export function renderSuiteSummary(report: SuiteReport): string {
  const counts = (status: string): number => report.results.filter(r => r.status === status).length
  const lines = [
    report.expectedNegativeTests ? '# Cortex harness self-test (expected negative fixtures)' : '# Cortex firmware tests', '',
    `${counts('passed')} passed, ${counts('failed')} failed, ${counts('error')} runner errors. Exit code: ${report.exitCode}.`,
    `Repeated scenario traces are ${report.reproducible ? 'identical' : 'NOT identical'}.`, '',
    report.target
      ? `Target: ${report.target}. Timestamps below are board milliseconds from the MCU's own clock. Host time is reported separately.`
      : 'All timestamps below are virtual simulation milliseconds. Host time is reported separately.', '',
    `| Scenario / run | Status | Host ms | ${report.target ? 'Board' : 'Virtual'} ms |`, '| --- | --- | ---: | ---: |'
  ]
  if (report.expectedNegativeTests) lines.splice(2, 0, `The broken firmware must fail its shutdown assertion and the hanging firmware must cause a watchdog error. Harness verification ${report.exitCode === 0 ? 'PASSED' : 'FAILED'}.`, '')
  if (report.cancelled) lines.splice(2, 0, 'Suite cancelled or its host watchdog expired. Unexecuted scenarios retain their configuration and are runner errors, not passes.', '')
  for (const r of report.results) {
    if ('scenario' in r) {
      lines.push(`| ${r.scenario.id}${r.repeat ? ` / ${r.repeat}` : ''} | ${r.status} | ${r.execution.hostWallMs.toFixed(2)} | ${r.execution.virtualDurationMs} |`)
    } else lines.push(`| ${escapeCell(r.scenarioPath)} | error | - | - |`)
  }
  for (const r of report.results) {
    const name = 'scenario' in r ? r.scenario.id : r.scenarioPath
    lines.push('', `## ${name}${'repeat' in r && r.repeat ? ` / run ${r.repeat}` : ''}`, '')
    if (r.error) lines.push('```text', r.error, '```', '')
    if (!('scenario' in r)) continue
    if (r.firmwarePath) lines.push(`Firmware path: \`${r.firmwarePath}\`.`, '')
    if (r.build) {
      lines.push(`Compiler: ${r.build.compilerVersion.split('\n')[0]}.`,
        `Source: \`${r.build.sourcePath}\` (SHA-256 \`${r.build.sourceSha256}\`).`,
        `Revision: ${r.build.revision ?? 'unknown'}${r.build.dirty ? ' (dirty worktree)' : ''}.`, '')
    }
    lines.push('| Assertion | Result | Virtual ms | Detail |', '| --- | --- | ---: | --- |')
    for (const a of r.assertions) {
      lines.push(`| ${escapeCell(a.id)} | ${a.passed ? 'PASS' : 'FAIL'} | ${a.atMs} | ${escapeCell(a.message)} |`)
    }
    const failures = r.assertions.filter(a => !a.passed)
    if (failures.length) {
      const latest = Math.max(...failures.map(a => a.atMs))
      const inputs = r.timeline.filter(e => e.kind === 'input' && e.atMs <= latest).slice(-8)
      lines.push('', 'Relevant inputs before the failure:', '', '```json', JSON.stringify(inputs, null, 2), '```', '')
      for (const failure of failures) {
        lines.push(`${failure.id} evidence:`, '', '```json', JSON.stringify(failure.evidence, null, 2), '```', '')
      }
    }
    const serial = r.timeline.filter(e => e.kind === 'serial').map(e => `${e.atMs}ms: ${e.text}`)
    lines.push('', 'Firmware Serial log:', '', '```text', serial.join('\n') || '(empty)', '```', '')
    if (r.logs.stderr) lines.push('Firmware stderr:', '', '```text', r.logs.stderr, '```', '')
  }
  lines.push('', 'report.json contains the complete scenario configuration, input/output timeline, assertion evidence, raw logs and build metadata.', '')
  return lines.join('\n')
}

export async function writeSuiteReport(directory: string, report: SuiteReport): Promise<void> {
  const path = resolve(directory)
  await mkdir(path, { recursive: true })
  await Promise.all([
    writeFile(join(path, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8'),
    writeFile(join(path, 'summary.md'), renderSuiteSummary(report), 'utf8')
  ])
}
