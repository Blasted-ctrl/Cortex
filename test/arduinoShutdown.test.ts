import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ARDUINO_SHIM } from '../src/main/services/arduinoShim'

const run = promisify(execFile)
const hasGpp = spawnSync('g++', ['--version']).status === 0

describe('shutdown test environment', () => {
  it.skipIf(!process.env.CI)('requires g++ in CI rather than silently skipping native shutdown checks', () => {
    expect(hasGpp).toBe(true)
  })
})

describe.skipIf(!hasGpp)('native simulator process shutdown', () => {
  let directory: string | undefined
  let executable: string
  const expected = ['@serial 18446744073709551615', '@serial 4294967295', '@serial Ready...']

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'cortex-shutdown-'))
    writeFileSync(join(directory, 'Arduino.h'), ARDUINO_SHIM)
    writeFileSync(join(directory, 'sketch.cpp'), `#include "Arduino.h"
int main(int argc, char** argv) {
  Serial.println(18446744073709551615ULL);
  Serial.println(4294967295UL);
  Serial.print("Ready...");
  if (argc > 1) { fprintf(stderr, "Expected fixture error\\n"); fflush(stderr); }
  __sim_exit(argc > 1 ? std::atoi(argv[1]) : 0);
}
`)
    executable = join(directory, 'shutdown.exe')
    await run('g++', ['-std=c++23', '-I', directory, join(directory, 'sketch.cpp'), '-o', executable], {
      timeout: 120_000, windowsHide: true
    })
  }, 120_000)

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true })
  })

  it('rapid shutdown preserves output and exits successfully on repeated real process launches', async () => {
    // An immediate sketch exit can overlap the detached input reader's startup.
    // Windows/MSVCRT historically failed intermittently after correct stdout;
    // exercise that lifecycle rather than adding a sleep or retrying a failure.
    const trials = process.platform === 'win32' ? 500 : 40
    for (let trial = 0; trial < trials; trial++) {
      const result = await run(executable, [], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
      expect(result.stdout.trimEnd().split(/\r?\n/), `trial ${trial}`).toEqual(expected)
      expect(result.stderr, `trial ${trial}`).toBe('')
    }
  })

  it('preserves requested failure codes, final Serial residue and flushed diagnostics', async () => {
    for (let trial = 0; trial < 20; trial++) {
      const result = await run(executable, ['2'], {
        encoding: 'utf8', timeout: 5_000, windowsHide: true
      }).then(() => undefined, (error: Error & { code: number; stdout: string; stderr: string }) => error)
      expect(result, `trial ${trial} must fail`).toBeDefined()
      expect(result?.code, `trial ${trial}`).toBe(2)
      expect(result?.stdout.trimEnd().split(/\r?\n/), `trial ${trial}`).toEqual(expected)
      expect(result?.stderr.replace(/\r\n/g, '\n'), `trial ${trial}`).toBe('Expected fixture error\n')
    }
  })
})
