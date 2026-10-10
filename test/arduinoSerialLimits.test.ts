import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile, spawnSync, type ExecFileException } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { prepareSimulation } from '../src/main/services/simBuild'

const run = promisify(execFile)
const hasGpp = spawnSync('g++', ['--version'], { timeout: 10000, windowsHide: true }).status === 0
it.skipIf(!process.env.CI)('has the host compiler required to verify bounded Serial output in CI', () => { expect(hasGpp).toBe(true) })

describe.skipIf(!hasGpp).each([false, true])('bounded Serial output with virtual clock=%s', (testMode) => {
  let directory: string
  let executable: string
  beforeAll(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), 'cortex-serial-limits-'))
    const filePath = join(directory, 'serial.ino')
    await fs.writeFile(filePath, 'void setup() {}\nvoid loop() {}\n')
    const prepared = await prepareSimulation({
      filePath, simDir: join(directory, 'build'), compiler: 'g++', testMode,
      mainSource: String.raw`#include "Arduino.h"
int main(int argc, char** argv) {
${testMode ? '  __sim_test_init(7, 1000);' : ''}
  const std::string mode = argc > 1 ? argv[1] : "";
  if (mode == "normal") { Serial.print("Ready"); Serial.print(42); Serial.println("!"); Serial.print("residue"); }
  if (mode == "repeated") { const std::string chunk(4096, 'x'); for (int i = 0; i < 257; i++) Serial.print(chunk); }
  if (mode == "single") Serial.print(std::string(1024 * 1024 + 1, 'x'));
  if (mode == "multiline") Serial.print(std::string(600000, 'a') + "\n" + std::string(600000, 'b') + "\n");
  __sim_exit(0);
}
`
    })
    await run('g++', prepared.args, { cwd: prepared.cwd, timeout: 120000, windowsHide: true })
    executable = prepared.exePath
  }, 120000)
  afterAll(async () => { if (directory) await fs.rm(directory, { recursive: true, force: true }) })
  async function trial(mode: string): Promise<{ code: number | string | null | undefined; stdout: string; stderr: string }> {
    try {
      const result = await run(executable, [mode], { timeout: 5000, maxBuffer: 4_000_000, windowsHide: true })
      return { code: 0, ...result }
    } catch (error) {
      const failure = error as ExecFileException & { stdout: string; stderr: string }
      return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr }
    }
  }
  it('preserves print concatenation, newlines and exit-time residue', async () => {
    const result = await trial('normal')
    expect(result.code).toBe(0)
    expect(result.stdout.split(/\r?\n/).filter((line) => line.startsWith('@serial '))).toEqual(['@serial Ready42!', '@serial residue'])
  })
  it.each(['repeated', 'single'])('fails explicitly before %s unterminated printing can grow beyond the limit', async (mode) => {
    const result = await trial(mode)
    expect(result.code).toBe(2)
    expect(result.stderr).toMatch(/Serial.*line.*limit/i)
    expect(result.stdout).not.toContain('@serial ')
  })
  it('allows a large multiline append when every logical line is bounded', async () => {
    const result = await trial('multiline')
    expect(result.code).toBe(0)
    const lines = result.stdout.split(/\r?\n/).filter((line) => line.startsWith('@serial '))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe('@serial ' + 'a'.repeat(600_000))
    expect(lines[1]).toBe('@serial ' + 'b'.repeat(600_000))
  })
})
