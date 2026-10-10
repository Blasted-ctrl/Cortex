import { describe, expect, it } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { prepareSimulation } from '../src/main/services/simBuild'

const run = promisify(execFile)
const hasGpp = spawnSync('g++', ['--version'], { timeout: 10000, windowsHide: true }).status === 0

it.skipIf(!process.env.CI)('has the host compiler required to verify automatic output modes in CI', () => {
  expect(hasGpp).toBe(true)
})

describe.skipIf(!hasGpp)('Arduino automatic output mode', () => {
  it.each([false, true])('matches core mode transitions and output ordering with virtual clock=%s', async (testMode) => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'cortex-output-modes-'))
    try {
      const filePath = join(dir, 'outputs.ino')
      await fs.writeFile(filePath, `void setup() {
  analogWrite(9, 128);
  analogWrite(9, 64);
  pinMode(9, INPUT);
  analogWrite(9, 0);
  pinMode(10, OUTPUT);
  analogWrite(10, 255);
  tone(8, 440);
  tone(8, 220, 10);
  pinMode(8, INPUT_PULLUP);
  tone(8, 660);
  noTone(8);
  pinMode(7, INPUT);
  digitalWrite(7, HIGH);
}
void loop() {}
`)
      const prepared = await prepareSimulation({
        filePath, simDir: join(dir, 'build'), compiler: 'g++', testMode,
        mainSource: `#include "Arduino.h"
extern void setup();
int main() {
${testMode ? '  __sim_test_init(42, 1000);' : ''}
  setup();
${testMode ? '  __sim_test_init(42, 1000);\n  analogWrite(9, 100);' : ''}
  __sim_exit(0);
}
`
      })
      await run('g++', prepared.args, { cwd: prepared.cwd, timeout: 120000, windowsHide: true })
      const { stdout } = await run(prepared.exePath, [], { cwd: prepared.cwd, timeout: 5000, windowsHide: true })
      const lines = stdout.trim().split(/\r?\n/)
      const signals = lines.filter((line) => !line.startsWith('@time '))
      expect(signals).toEqual([
        '@mode 9 1', '@pwm 9 128', '@pwm 9 64',
        '@mode 9 0', '@mode 9 1', '@pwm 9 0',
        '@mode 10 1', '@pwm 10 255',
        '@mode 8 1', '@tone 8 440', '@tone 8 220',
        '@mode 8 2', '@mode 8 1', '@tone 8 660', '@tone 8 0',
        '@mode 7 0', '@pin 7 1',
        ...(testMode ? ['@mode 9 1', '@pwm 9 100'] : [])
      ])
      if (testMode) for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('@time ')) expect(lines[i - 1]).toBe('@time 0')
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})
