import { describe, expect, it } from 'vitest'
import { execFile, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { prepareSimulation } from '../src/main/services/simBuild'

const run = promisify(execFile)
const hasGpp = spawnSync('g++', ['--version']).status === 0

describe.skipIf(!hasGpp)('headless simulation preparation and virtual runtime', () => {
  it.each(['pulseIn(2, HIGH)', 'shiftIn(2, 3, 0)', 'shiftOut(2, 3, 0, 42)'])('rejects unsupported %s instead of returning fake success', async (call) => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'cortex-unsupported-'))
    try {
      const filePath = join(dir, 'unsupported.ino')
      await fs.writeFile(filePath, `void setup() { ${call}; }\nvoid loop() {}\n`)
      const prepared = await prepareSimulation({ filePath, simDir: join(dir, 'build'), compiler: 'g++', mainSource: '#include "Arduino.h"\nextern void setup();\nint main() { setup(); __sim_exit(0); }\n' })
      await run('g++', prepared.args, { cwd: prepared.cwd, timeout: 120_000 })
      const result = spawnSync(prepared.exePath, [], { cwd: prepared.cwd, encoding: 'utf8', timeout: 5000, windowsHide: true })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain(`does not support ${call.split('(')[0]}`)
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
  it('preserves local includes, stable input order, virtual delays, limits and seeded traces', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'cortex-virtual-'))
    try {
      const filePath = join(dir, 'controller.ino')
      await fs.writeFile(join(dir, 'controller.h'), '#define TEST_LED 13\n')
      await fs.writeFile(filePath, `#include "controller.h"
void setup() {
  pinMode(2, INPUT_PULLUP);
  Serial.println(digitalRead(2));
  Serial.println(analogRead(A0));
  digitalWrite(TEST_LED, HIGH);
  analogWrite(9, 128);
  tone(8, 440);
  Serial.println(random(1000));
  delayMicroseconds(500);
  Serial.println(micros());
  delay(2);
  Serial.println(analogRead(A0));
  Serial.println(millis());
  delay(500);
  Serial.println(micros());
  Serial.print("tail");
}
void loop() {}
`)
      const prepared = await prepareSimulation({
        filePath,
        simDir: join(dir, 'build'),
        compiler: 'g++',
        testMode: true,
        mainSource: `#include "Arduino.h"
extern void setup();
int main() {
  __sim_test_init(123, 3000);
  __sim_test_input(2000, 14, 30);
  __sim_test_input(0, 14, 10);
  __sim_test_input(2000, 14, 20);
  __sim_test_input(0, 2, 0);
  __sim_test_advance(0);
  setup();
  __sim_exit(0);
}
`
      })
      await run('g++', prepared.args, { cwd: prepared.cwd, timeout: 120_000 })
      const first = await run(prepared.exePath, [], { cwd: prepared.cwd, timeout: 5000 })
      const second = await run(prepared.exePath, [], { cwd: prepared.cwd, timeout: 5000 })
      expect(first.stdout).toBe(second.stdout)
      const lines = first.stdout.trim().split(/\r?\n/)
      expect(lines.slice(0, 8)).toEqual([
        '@time 0', '@input 14 10', '@time 0', '@input 2 0',
        '@time 0', '@mode 2 2', '@time 0', '@serial 0'
      ])
      expect(lines.filter((line) => line.startsWith('@input '))).toEqual([
        '@input 14 10', '@input 2 0', '@input 14 30', '@input 14 20'
      ])
      expect(lines.filter((line) => line.startsWith('@serial '))).toEqual([
        '@serial 0', '@serial 10', '@serial 798', '@serial 500',
        '@serial 20', '@serial 2', '@serial 3000', '@serial tail'
      ])
      for (let i = 0; i < lines.length; i++) {
        if (/^@(mode|pin|pwm|tone|serial|input) /.test(lines[i])) expect(lines[i - 1]).toMatch(/^@time \d+$/)
      }
      const times = lines.filter((line) => line.startsWith('@time ')).map((line) => Number(line.slice(6)))
      expect(times).toEqual([...times].sort((a, b) => a - b))
      expect(Math.max(...times)).toBe(3000)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('simulation compiler validation', () => {
  it('rejects an MCU cross compiler before preparing files', async () => {
    await expect(prepareSimulation({
      filePath: 'unused.ino', simDir: 'unused', mainSource: '', compiler: 'avr-g++'
    })).rejects.toThrow('requires a host g++ or clang++')
  })
})
