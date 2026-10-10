import { describe, it, expect } from 'vitest'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ARDUINO_SHIM } from '../src/main/services/arduinoShim'
import { SIM_MAIN } from '../src/main/services/simBuild'

const run = promisify(execFile)
const hasGpp = (await run('g++', ['--version']).then(() => true, () => false)) as boolean

/**
 * The stop handshake, end to end, against a REAL sim binary.
 *
 * test/arduinoShim.test.ts cannot cover this: it substitutes its own
 * `int main(){ setup(); __sim_exit(0); }`, which never calls loop(), never
 * enters the run loop and never stops. That is why the shim's flush path could
 * be entirely dead in the product while its suite stayed green. This test uses
 * the product's own SIM_MAIN and the product's own stop sequence.
 */

const ROOT = join(__dirname, '..')
const SVC = readFileSync(join(ROOT, 'src', 'main', 'services', 'simService.ts'), 'utf8')
const PROTO = readFileSync(join(ROOT, 'src', 'shared', 'simProtocol.ts'), 'utf8')

/** The product's grace window, read from source for the same reason. */
function stopGraceMs(): number {
  const m = SVC.match(/const STOP_GRACE_MS = (\d+)/)
  expect(m, 'STOP_GRACE_MS must exist').toBeTruthy()
  return Number(m![1])
}

/** ARDUINO_SHIM is a String.raw template; resolve its interpolations. */
function shimSource(): string {
  const num = (n: string): number => Number(PROTO.match(new RegExp(`export const ${n} = (\\d+)`))![1])
  const consts: Record<string, number> = {
    ADC_MAX: num('ADC_MAX'),
    LOGIC_THRESHOLD: num('LOGIC_THRESHOLD'),
    PWM_MAX: num('PWM_MAX')
  }
  // ARDUINO_SHIM is already interpolated at import; this only asserts it.
  for (const [k, v] of Object.entries(consts)) {
    expect(ARDUINO_SHIM, `${k} must be interpolated into the shim`).toContain(String(v))
  }
  return ARDUINO_SHIM
}

async function buildSim(sketch: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'cortex-stop-'))
  writeFileSync(join(dir, 'Arduino.h'), shimSource())
  writeFileSync(join(dir, 'sketch.cpp'), `#include "Arduino.h"\n${sketch}`)
  writeFileSync(join(dir, 'sim_main.cpp'), SIM_MAIN)
  const exe = join(dir, 'sim.exe')
  await run('g++', [
    join(dir, 'sketch.cpp'),
    join(dir, 'sim_main.cpp'),
    '-o',
    exe,
    '-std=c++23',
    '-I',
    dir,
    '-pthread',
    '-O1'
  ])
  return exe
}

interface Trial {
  code: number | null
  out: string
}

/** Mirrors simService.stop(): write @stop, then kill only after the grace. */
function runAndStop(exe: string, graceMs: number): Promise<Trial> {
  return new Promise((resolve) => {
    const child = spawn(exe, [], { windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stdin.on('error', () => {})
    setTimeout(() => {
      child.stdin.write('@stop\n', () => {})
      if (graceMs <= 0) child.kill()
      else {
        const t = setTimeout(() => child.kill(), graceMs)
        child.once('exit', () => clearTimeout(t))
      }
    }, 300)
    child.on('close', (code) => resolve({ code, out }))
  })
}

const serialLines = (out: string): string[] =>
  out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('@serial '))
    .map((l) => l.slice('@serial '.length))

describe.skipIf(!hasGpp)('sim stop handshake', () => {
  // A partial print is the probe: it only ever reaches stdout if the sketch
  // exits through __sim_exit rather than being killed mid-loop.
  const SKETCH = 'void setup() { Serial.print("Ready..."); }\nvoid loop() { delay(10); }\n'

  it('exits cleanly and flushes the last partial line when stopped', async () => {
    const exe = await buildSim(SKETCH)
    const r = await runAndStop(exe, stopGraceMs())
    expect(r.code, 'a stopped sketch must exit 0, not be killed').toBe(0)
    expect(serialLines(r.out)).toContain('Ready...')
  }, 120_000)

  // The no-grace case (write @stop, kill in the same tick) is deliberately NOT
  // asserted: whether the child reads @stop and flushes before the kill lands
  // is a race, so it flushes on some runs and not others. That race is the
  // whole reason the grace window exists, but a test that asserts a racy
  // outcome flakes, which is worse than no test. The positive case above is the
  // real guard: with the grace window, the flush is deterministic.

  it('keeps a grace window long enough for a loop iteration', () => {
    expect(stopGraceMs()).toBeGreaterThanOrEqual(100)
  })
})

/**
 * The renderer half. stopSim must NOT clear simRunId: the flush arrives after
 * @stop, and both sim event handlers drop anything whose id does not match, so
 * clearing it there discards the output this whole handshake exists to deliver.
 */
describe('stopSim keeps the run id until the process is gone', () => {
  const STORE = readFileSync(join(ROOT, 'src', 'renderer', 'src', 'store', 'useStore.ts'), 'utf8')
  const slice = (from: string, to: string): string => STORE.slice(STORE.indexOf(from), STORE.indexOf(to))

  it('stopSim does not null simRunId', () => {
    const body = slice('async stopSim()', 'handleSimEvent(e)')
    expect(body).toContain('simRunning: false')
    expect(body).not.toMatch(/simRunId:\s*null/)
  })

  it('handleSimExit is the one that clears it', () => {
    const body = slice('handleSimExit(e)', 'addPart(type)')
    expect(body).toMatch(/simRunId:\s*null/)
  })

  it('both handlers still guard on the id', () => {
    expect(STORE.match(/if \(e\.id !== get\(\)\.simRunId\) return/g) ?? []).toHaveLength(2)
  })
})
