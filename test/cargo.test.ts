import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  isCargoJsonLine,
  isBuildFinished,
  getCargoBuildOutcome,
  cargoRenderedMessage,
  parseCargoDiagnostics
} from '../src/shared/diagnostics'

/**
 * Fixtures captured from real `cargo build --message-format=json` runs
 * (cargo 1.97.1) against examples/rustproj: one clean build, one with an
 * undefined identifier inside a module.
 */
const ok = readFileSync(join(__dirname, 'tmp', 'cargo-ok.json'), 'utf8')
const err = readFileSync(join(__dirname, 'tmp', 'cargo-err.json'), 'utf8')

describe('isCargoJsonLine', () => {
  it('recognises cargo machine records', () => {
    const records = err.split(/\r?\n/).filter((l) => l.trim().startsWith('{'))
    expect(records.length).toBeGreaterThan(0)
    for (const r of records) expect(isCargoJsonLine(r), r.slice(0, 60)).toBe(true)
  })

  it('leaves the program’s own output alone', () => {
    // These must reach the Output panel untouched.
    for (const line of ['smoothed = 825', '', 'Hello {world}', '{ not json']) {
      expect(isCargoJsonLine(line), line).toBe(false)
    }
  })

  it('does not claim a JSON object that has no cargo reason', () => {
    expect(isCargoJsonLine('{"level":"error","message":"x"}')).toBe(false)
  })
})

describe('getCargoBuildOutcome', () => {
  it.each([
    ['successful build', '{"reason":"build-finished","success":true}', true],
    ['failed build', '{"reason":"build-finished","success":false}', false],
    ['surrounding whitespace', ' \t{"reason":"build-finished","success":false}\r\n', false],
    ['other cargo record', '{"reason":"compiler-artifact","success":true}', null],
    ['program reason', '{"reason":"sensor overheated","success":false}', null],
    ['missing reason', '{"success":true}', null],
    ['numeric reason', '{"reason":1,"success":true}', null],
    ['missing success', '{"reason":"build-finished"}', null],
    ['null success', '{"reason":"build-finished","success":null}', null],
    ['string true', '{"reason":"build-finished","success":"true"}', null],
    ['string false', '{"reason":"build-finished","success":"false"}', null],
    ['numeric true', '{"reason":"build-finished","success":1}', null],
    ['numeric false', '{"reason":"build-finished","success":0}', null],
    ['array success', '{"reason":"build-finished","success":[]}', null],
    ['object success', '{"reason":"build-finished","success":{}}', null],
    ['array record', '[{"reason":"build-finished","success":true}]', null],
    ['null record', 'null', null],
    ['scalar record', 'true', null],
    ['plain output', 'build-finished: true', null],
    ['truncated JSON', '{"reason":"build-finished","success":', null],
    ['malformed JSON', '{not json}', null],
    ['multiple records', '{"reason":"build-finished","success":true}\n{"reason":"build-finished","success":false}', null]
  ] as const)('recognises only a boolean terminal outcome for %s', (_name, line, expected) => {
    expect(getCargoBuildOutcome(line)).toBe(expected)
  })

  it('reads the successful terminal outcome from the recorded clean build', () => {
    const terminal = ok.split(/\r?\n/).find((line) => line.includes('"build-finished"'))
    expect(terminal).toBeDefined()
    expect(getCargoBuildOutcome(terminal!)).toBe(true)
  })

  it('reads the failed terminal outcome from the recorded failing build', () => {
    const terminal = err.split(/\r?\n/).find((line) => line.includes('"build-finished"'))
    expect(terminal).toBeDefined()
    expect(getCargoBuildOutcome(terminal!)).toBe(false)
  })
})

describe('isBuildFinished keeps its success-only contract', () => {
  it.each([
    ['{"reason":"build-finished","success":true}', true],
    ['{"reason":"build-finished","success":false}', false],
    ['{"reason":"build-finished","success":"true"}', false],
    ['{"reason":"build-finished"}', false]
  ] as const)('returns the success-only boolean for %s', (line, expected) => {
    expect(isBuildFinished(line)).toBe(expected)
  })
})

describe('cargoRenderedMessage', () => {
  it('returns the human text of a compiler-message record', () => {
    const rendered = err
      .split(/\r?\n/)
      .map(cargoRenderedMessage)
      .filter((x): x is string => x !== null)
      .join('')
    expect(rendered).toContain('cannot find value')
    // The user must never see the machine record itself.
    expect(rendered).not.toContain('"reason"')
    expect(rendered).not.toContain('compiler-artifact')
  })

  it('returns null for artifact and build-finished records', () => {
    const artifacts = ok.split(/\r?\n/).filter((l) => l.includes('compiler-artifact') || l.includes('build-finished'))
    expect(artifacts.length).toBeGreaterThan(0)
    for (const a of artifacts) expect(cargoRenderedMessage(a)).toBeNull()
  })
})

describe('parseCargoDiagnostics', () => {
  it('extracts the real span from a module file, not the open file', () => {
    const d = parseCargoDiagnostics(err)
    expect(d.length).toBeGreaterThan(0)
    const e = d.find((x) => x.code === 'E0425')
    expect(e).toBeDefined()
    expect(e!.file).toContain('filter.rs')
    expect(e!.severity).toBe('error')
    expect(e!.line).toBeGreaterThan(0)
    expect(e!.column).toBeGreaterThan(0)
  })

  it('finds nothing in a clean build', () => {
    expect(parseCargoDiagnostics(ok)).toEqual([])
  })
})

describe('isCargoJsonLine only claims cargo’s own records', () => {
  it('does not swallow program output that is JSON with a "reason" field', () => {
    // A program printing its own JSON telemetry must reach the Output panel.
    expect(isCargoJsonLine('{"reason":"sensor overheated","mv":3300}')).toBe(false)
    expect(isCargoJsonLine('{"reason":"ok"}')).toBe(false)
  })

  it('still claims every real cargo reason', () => {
    for (const r of ['compiler-artifact', 'compiler-message', 'build-script-executed', 'build-finished']) {
      expect(isCargoJsonLine(`{"reason":"${r}"}`), r).toBe(true)
    }
  })
})
