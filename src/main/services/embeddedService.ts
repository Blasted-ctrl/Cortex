import { spawn, execFile, ChildProcess } from 'child_process'
import { promisify } from 'util'
import { dirname } from 'path'
import type { BrowserWindow } from 'electron'
import type {
  BoardStatus,
  BoardPort,
  BoardTarget,
  BoardCompileRequest,
  BoardUploadRequest
} from '../../shared/ipc'
import * as runner from './runnerService'
import { getArduinoCli } from './arduinoCliService'
import { createCompilerDiagnostics, COMPILER_DIAGNOSTIC_LIMITS } from './compilerDiagnostics'

const execFileAsync = promisify(execFile)

const CLI = 'arduino-cli'

/** Is arduino-cli installed and usable? */
export async function status(): Promise<BoardStatus> {
  try {
    const cli = await getArduinoCli()
    if (!cli) throw new Error('Board tools are not ready')
    const { stdout, stderr } = await execFileAsync(cli.command, [...cli.args, 'version'], {
      timeout: 6000,
      windowsHide: true,
      env: cli.env
    })
    return { available: true, version: (stdout || stderr).toString().trim().split(/\r?\n/)[0], source: cli.source }
  } catch {
    return {
      available: false,
      version: '',
      hint:
        'Cortex can set up board tools for you. Select Set up board tools to compile, upload, ' +
        'and manage libraries without installing Arduino CLI yourself.'
    }
  }
}

async function readCli(args: string[], timeout: number): Promise<string> {
  const cli = await getArduinoCli()
  if (!cli) throw new Error('Board tools are not ready. Use Set up board tools in Cortex and retry.')
  const { stdout } = await execFileAsync(cli.command, [...cli.args, ...args], { timeout, windowsHide: true, env: cli.env })
  return stdout.toString()
}

interface RawBoard {
  name?: string
  fqbn?: string
  FQBN?: string
}
interface RawPort {
  port?: { address?: string; protocol?: string; label?: string }
  matching_boards?: RawBoard[]
  boards?: RawBoard[] // legacy bare-array shape
  address?: string
  protocol?: string
}

/** Physically connected boards (`arduino-cli board list`). */
export async function listConnected(): Promise<BoardPort[]> {
  try {
    const stdout = await readCli(['board', 'list', '--format', 'json'], 12000)
    const parsed = JSON.parse(stdout || '{}')
    // Newer CLIs: { detected_ports: [...] }. Older: a bare array of ports.
    const list: RawPort[] = Array.isArray(parsed) ? parsed : parsed.detected_ports ?? []
    return list
      .map((entry): BoardPort | null => {
        const address = entry.port?.address ?? entry.address
        const protocol = entry.port?.protocol ?? entry.protocol ?? 'serial'
        if (!address) return null
        const match = entry.matching_boards?.[0] ?? entry.boards?.[0]
        return {
          address,
          protocol,
          label: entry.port?.label,
          boardName: match?.name,
          fqbn: match?.fqbn ?? match?.FQBN
        }
      })
      .filter((b): b is BoardPort => b !== null)
  } catch {
    return []
  }
}

/** Known/installable boards from installed cores (`arduino-cli board listall`). */
export async function listAll(): Promise<BoardTarget[]> {
  try {
    const stdout = await readCli(['board', 'listall', '--format', 'json'], 15000)
    const parsed = JSON.parse(stdout || '{}')
    const boards: { name?: string; fqbn?: string }[] = parsed.boards ?? []
    return boards
      .filter((b) => b.name && b.fqbn)
      .map((b) => ({ name: b.name as string, fqbn: b.fqbn as string }))
  } catch {
    return []
  }
}

/**
 * The board's actual MCU from `arduino-cli board details` (build.mcu, e.g.
 * "esp32", "esp32s3", "atmega328p"). This is the ground truth for the silicon,
 * which pin-capability facts key on - the board id in the fqbn cannot be trusted
 * (several esp32:esp32 boards run on the ESP32-S3 die). Returns null on any
 * failure (CLI missing, core not installed, board unknown, parse error) so an
 * undetermined MCU yields no hardware claim. The fqbn is passed as an execFile
 * argument (no shell), so it is never interpolated into a command line.
 */
export async function boardMcu(fqbn: string): Promise<string | null> {
  if (!fqbn) return null
  try {
    // board details is genuinely slow (it loads every build property of the
    // core, ~8s for esp32), and it may run alongside the package-snapshot reads,
    // so the timeout is generous - a tight one returns null under contention and
    // suppresses an otherwise-certain MCU fact.
    const stdout = await readCli(['board', 'details', '--fqbn', fqbn, '--format', 'json'], 25000)
    const parsed = JSON.parse(stdout || '{}')
    const props: string[] = Array.isArray(parsed.build_properties) ? parsed.build_properties : []
    const mcu = props.find((p) => typeof p === 'string' && p.startsWith('build.mcu='))
    return mcu ? mcu.slice('build.mcu='.length).trim() || null : null
  } catch {
    return null
  }
}

async function streamCli(
  win: BrowserWindow,
  id: string,
  args: string[],
  sketchPath: string
): Promise<void> {
  const cancellation = runner.beginRunStart(win, id)
  const sketchDir = dirname(sketchPath)
  runner.sendRunOutput(win, id, 'system', `$ ${CLI} ${args.join(' ')}\n`)
  const start = performance.now()
  let proc: ChildProcess
  try {
    if (runner.runStartCancelled(win, id, cancellation, 'compile')) return
    const cli = await getArduinoCli()
    if (runner.runStartCancelled(win, id, cancellation, 'compile')) return
    if (!cli) throw new Error('Board tools are not ready. Use Set up board tools in Cortex and retry.')
    proc = spawn(cli.command, [...cli.args, ...args], { cwd: sketchDir, windowsHide: true, env: cli.env })
    // Decode UTF-8 across chunk boundaries (see runnerService).
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    runner.trackProcess(id, proc)
  } catch (err) {
    if (runner.runStartCancelled(win, id, cancellation, 'compile')) return
    runner.sendRunOutput(win, id, 'stderr', `Failed to launch ${CLI}: ${String(err)}\n`)
    runner.sendRunExit(win, { id, code: 127, signal: null, durationMs: 0, phase: 'compile' })
    return
  } finally {
    runner.finishRunStart(id, cancellation)
  }
  proc.stdin?.on('error', () => {})
  const capture = createCompilerDiagnostics({ cwd: sketchDir, format: 'text', ...COMPILER_DIAGNOSTIC_LIMITS })
  proc.stdout?.on('data', (d) => runner.sendRunOutput(win, id, 'stdout', d.toString()))
  proc.stderr?.on('data', (d) => {
    const text = d.toString()
    capture.write(text)
    runner.sendRunOutput(win, id, 'stderr', text)
  })
  proc.on('error', (err) => runner.sendRunOutput(win, id, 'stderr', `${String(err)}\n`))
  proc.on('close', (code, signal) => {
    runner.untrackProcess(id, proc)
    // arduino-cli surfaces the underlying gcc diagnostics on stderr.
    runner.emitCapturedDiagnostics(win, id, capture.finish())
    const durationMs = Math.round(performance.now() - start)
    if (code === 0) runner.sendRunOutput(win, id, 'system', `Done in ${durationMs}ms\n`)
    runner.sendRunExit(win, { id, code, signal, durationMs, phase: 'compile' })
  })
}

/** Verify (compile) a sketch for the given board. */
export async function compile(win: BrowserWindow, req: BoardCompileRequest): Promise<void> {
  await streamCli(win, req.id, ['compile', '--fqbn', req.fqbn, req.sketchPath], req.sketchPath)
}

/** Compile and upload a sketch to a connected board. */
export async function upload(win: BrowserWindow, req: BoardUploadRequest): Promise<void> {
  await streamCli(
    win,
    req.id,
    ['compile', '--upload', '--fqbn', req.fqbn, '-p', req.port, req.sketchPath],
    req.sketchPath
  )
}
