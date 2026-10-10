import { execFile } from 'child_process'
import { promisify } from 'util'
import type { ToolchainInfo } from '../../shared/ipc'
import { getArduinoCli } from './arduinoCliService'

const execFileAsync = promisify(execFile)

interface Probe {
  id: string
  name: string
  kind: ToolchainInfo['kind']
  command: string
  args: string[]
  /** Extract a version string from stdout/stderr. */
  parse?: (out: string) => string
}

const firstLine = (s: string): string => (s.split(/\r?\n/)[0] || '').trim()

// Toolchains we probe for. Order is roughly "most common first".
const PROBES: Probe[] = [
  { id: 'gcc', name: 'GCC (g++)', kind: 'cpp', command: 'g++', args: ['--version'], parse: firstLine },
  { id: 'clang', name: 'Clang (clang++)', kind: 'cpp', command: 'clang++', args: ['--version'], parse: firstLine },
  { id: 'gcc-c', name: 'GCC (gcc)', kind: 'c', command: 'gcc', args: ['--version'], parse: firstLine },
  { id: 'clang-c', name: 'Clang (clang)', kind: 'c', command: 'clang', args: ['--version'], parse: firstLine },
  { id: 'arm-gcc', name: 'ARM GCC (arm-none-eabi-g++)', kind: 'embedded', command: 'arm-none-eabi-g++', args: ['--version'], parse: firstLine },
  { id: 'avr-gcc', name: 'AVR GCC (avr-g++)', kind: 'embedded', command: 'avr-g++', args: ['--version'], parse: firstLine },
  { id: 'python', name: 'Python 3', kind: 'python', command: 'python', args: ['--version'], parse: firstLine },
  { id: 'python3', name: 'Python 3 (python3)', kind: 'python', command: 'python3', args: ['--version'], parse: firstLine },
  { id: 'node', name: 'Node.js', kind: 'node', command: 'node', args: ['--version'], parse: firstLine },
  { id: 'rustc', name: 'Rust (rustc)', kind: 'rust', command: 'rustc', args: ['--version'], parse: firstLine },
  { id: 'cargo', name: 'Cargo', kind: 'rust', command: 'cargo', args: ['--version'], parse: firstLine },
  { id: 'cmake', name: 'CMake', kind: 'cmake', command: 'cmake', args: ['--version'], parse: firstLine },
  { id: 'ninja', name: 'Ninja', kind: 'other', command: 'ninja', args: ['--version'], parse: firstLine },
  { id: 'arduino-cli', name: 'Arduino CLI', kind: 'other', command: 'arduino-cli', args: ['version'], parse: firstLine },
  { id: 'platformio', name: 'PlatformIO', kind: 'other', command: 'pio', args: ['--version'], parse: firstLine },
  { id: 'openocd', name: 'OpenOCD', kind: 'other', command: 'openocd', args: ['--version'], parse: firstLine },
  { id: 'gdb', name: 'GDB', kind: 'other', command: 'gdb', args: ['--version'], parse: firstLine }
]

let cache: ToolchainInfo[] | null = null

/**
 * A timeout is indistinguishable from "not installed" here, so it has to be
 * long enough that a slow machine is never told its compiler is missing. Every
 * probe is a cold process spawn, all 16 run at once, and on Windows each one is
 * scanned by antivirus on first launch: 5s was tight enough that the detected
 * count visibly changed run to run on a loaded machine.
 *
 * It is still bounded, because startSim awaits this when nothing is detected
 * yet, so a hung probe would sit on the user's first Run.
 */
const PROBE_TIMEOUT_MS = 10000

async function probe(p: Probe): Promise<ToolchainInfo> {
  try {
    const cli = p.id === 'arduino-cli' ? await getArduinoCli() : null
    if (p.id === 'arduino-cli' && !cli) throw new Error('Board tools are not ready')
    const command = cli?.command ?? p.command
    const args = cli ? [...cli.args, ...p.args] : p.args
    const { stdout, stderr } = await execFileAsync(command, args, {
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      env: cli?.env
    })
    const out = (stdout || stderr || '').toString()
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      command,
      version: p.parse ? p.parse(out) : firstLine(out),
      available: true
    }
  } catch {
    return {
      id: p.id,
      name: p.name,
      kind: p.kind,
      command: p.command,
      version: '',
      available: false
    }
  }
}

export async function detectToolchains(force = false): Promise<ToolchainInfo[]> {
  if (cache && !force) return cache
  const results = await Promise.all(PROBES.map(probe))
  cache = results
  return results
}

