import { promises as fs } from 'fs'
import { dirname, join, resolve } from 'path'
import { isHostCpp } from '../../shared/security'
import { ARDUINO_SHIM } from './arduinoShim'

export const SIM_MAIN = `#include "Arduino.h"
extern void setup();
extern void loop();
int main() {
  setup();
  while (__sim_run) {
    loop();
    std::this_thread::sleep_for(std::chrono::microseconds(200));
  }
  // Returning races the desktop shim's detached stdin reader against static destruction.
  __sim_exit(0);
}
`

interface SimulationPreparation {
  filePath: string
  simDir: string
  mainSource: string
  compiler: string
  testMode?: boolean
}

export async function prepareSimulation(req: SimulationPreparation): Promise<{ exePath: string; args: string[]; cwd: string }> {
  if (!isHostCpp(req.compiler)) throw new Error(`Simulation requires a host g++ or clang++ compiler: ${req.compiler}`)
  const cwd = resolve(req.simDir)
  const filePath = resolve(req.filePath)
  await fs.mkdir(cwd, { recursive: true })
  const source = await fs.readFile(filePath, 'utf8')
  const needsInclude = !/#include\s*[<"]Arduino\.h[>"]/.test(source)
  // Preserve diagnostics against the actual sketch, including its original line numbers.
  const escaped = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const header = (needsInclude ? '#include "Arduino.h"\n' : '') + `#line 1 "${escaped}"\n`
  await Promise.all([
    fs.writeFile(join(cwd, 'Arduino.h'), ARDUINO_SHIM, 'utf8'),
    fs.writeFile(join(cwd, 'sketch.cpp'), header + source, 'utf8'),
    fs.writeFile(join(cwd, 'sim_main.cpp'), req.mainSource, 'utf8')
  ])
  const exePath = join(cwd, 'sim.exe')
  const args = [
    join(cwd, 'sketch.cpp'),
    join(cwd, 'sim_main.cpp'),
    '-o', exePath,
    '-std=c++23',
    '-I', cwd,
    '-I', dirname(filePath),
    '-pthread',
    '-O1',
    ...(req.testMode ? ['-DCORTEX_TEST=1'] : [])
  ]
  return { exePath, args, cwd }
}
