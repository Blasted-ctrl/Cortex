import type { SuiteReport, SuiteResult } from '../../../shared/firmwareTest'

export interface TimingDelta { assertion: string; simMs: number; boardMs: number }
export interface ParityRow {
  scenario: string
  sim: string
  board: string
  passed: { sim: number; board: number; total: number }
  /** Assertions whose verdict differs between the simulator and the board. */
  disagreements: string[]
  /** When both runs matched an event assertion, the event time on each. */
  timing: TimingDelta[]
}

const id = (result: SuiteResult): string => 'scenario' in result ? result.scenario.id : result.scenarioPath

export function compareReports(sim: SuiteReport, board: SuiteReport): ParityRow[] {
  const simById = new Map(sim.results.map((r) => [id(r), r]))
  return board.results.map((boardResult) => {
    const simResult = simById.get(id(boardResult))
    const simAssertions = simResult && 'assertions' in simResult ? simResult.assertions : []
    const boardAssertions = 'assertions' in boardResult ? boardResult.assertions : []
    const simVerdicts = new Map(simAssertions.map((a) => [a.id, a]))
    const disagreements: string[] = []
    const timing: TimingDelta[] = []
    for (const b of boardAssertions) {
      const s = simVerdicts.get(b.id)
      if (!s) continue
      if (s.passed !== b.passed) disagreements.push(b.id)
      if (s.kind === 'event' && s.passed && b.passed && s.evidence[0] && b.evidence[0]) {
        timing.push({ assertion: b.id, simMs: s.evidence[0].atMs, boardMs: b.evidence[0].atMs })
      }
    }
    return {
      scenario: id(boardResult),
      sim: simResult?.status ?? 'not run',
      board: boardResult.status,
      passed: { sim: simAssertions.filter((a) => a.passed).length, board: boardAssertions.filter((a) => a.passed).length, total: boardAssertions.length || simAssertions.length },
      disagreements,
      timing
    }
  })
}

const ms = (value: number): string => `${Number(value.toFixed(3))}`

export function renderParity(rows: ParityRow[], target: string): string {
  const lines = [
    '# Simulation vs hardware', '',
    `Board: ${target}. The same scenario files and assertions ran in the host simulator and on the board.`, '',
    '| Scenario | Simulator | Board | Checks passed (sim / board) | Verdicts that differ | Largest event timing difference |',
    '| --- | --- | --- | --- | --- | ---: |'
  ]
  for (const row of rows) {
    const largest = row.timing.reduce((worst, t) => Math.max(worst, Math.abs(t.boardMs - t.simMs)), 0)
    lines.push(`| ${row.scenario} | ${row.sim} | ${row.board} | ${row.passed.sim} / ${row.passed.board} of ${row.passed.total} | ${row.disagreements.join(', ') || 'none'} | ${row.timing.length ? `${ms(largest)} ms` : '-'} |`)
  }
  for (const row of rows.filter((r) => r.timing.length)) {
    lines.push('', `## ${row.scenario}: when each matched event happened`, '', '| Assertion | Simulator ms | Board ms | Difference ms |', '| --- | ---: | ---: | ---: |')
    for (const t of row.timing) lines.push(`| ${t.assertion} | ${ms(t.simMs)} | ${ms(t.boardMs)} | ${ms(t.boardMs - t.simMs)} |`)
  }
  lines.push('', 'Simulator times are virtual and exact. Board times come from the MCU\'s own micros() clock, so USB latency is not',
    'included; they do include real loop overhead, delay() accuracy and the time spent writing the trace.', '')
  return lines.join('\n')
}
