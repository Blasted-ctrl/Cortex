import { spawn, ChildProcess } from 'child_process'
import { join, dirname } from 'path'
import type { BrowserWindow } from 'electron'
import type { SimStartRequest, SimEvent } from '../../shared/ipc'
import { IPC } from '../../shared/ipc'
import { prepareSimulation, SIM_MAIN } from './simBuild'
import { parseSimLine } from '../../shared/simProtocol'
import { isHostCpp, commandBaseName } from '../../shared/security'
import * as runner from './runnerService'
import { safeCommand } from './commandResolver'
import { getWorkspaceRoot } from './fsService'
import { SIM_BUFFER_LIMIT_BYTES } from './arduinoShim'

const active = new Map<string, ChildProcess>()
const pending = new Set<string>()
const cancelled = new Set<string>()

function emit(win: BrowserWindow, ev: SimEvent): void {
  if (!win.isDestroyed()) win.webContents.send(IPC.SIM_EVENT, ev)
}
function system(win: BrowserWindow, id: string, text: string): void {
  emit(win, { id, kind: 'system', text })
}
function exit(win: BrowserWindow, id: string, code: number | null): void {
  if (!win.isDestroyed()) win.webContents.send(IPC.SIM_EXIT, { id, code })
}

function stopOverflow(win: BrowserWindow, id: string, child: ChildProcess, label: string): void {
  system(win, id, `${label} exceeded the ${SIM_BUFFER_LIMIT_BYTES}-byte buffer limit. Stopping simulation; reduce the output or add newlines.\n`)
  exit(win, id, 2)
  // Retain the handle until close, so quit can retry if termination is delayed.
  try { child.kill('SIGKILL') } catch { /* already gone; close still drains */ }
}

export async function start(win: BrowserWindow, req: SimStartRequest): Promise<void> {
  if (active.has(req.id) || pending.has(req.id)) return
  pending.add(req.id)
  cancelled.delete(req.id)
  try {
    await prepareAndStart(win, req)
  } catch (err) {
    if (!cancelled.has(req.id) && !win.isDestroyed()) throw err
    cancelled.delete(req.id)
    exit(win, req.id, null)
  } finally {
    pending.delete(req.id)
  }
}

async function prepareAndStart(win: BrowserWindow, req: SimStartRequest): Promise<void> {
  if (win.isDestroyed()) return
  const simDir = join(req.cwd, '.cortex', 'sim')

  // Only host C++ compilers may run the sim: a cross-compiler emits firmware
  // for a chip and cannot produce something this machine can execute.
  const wanted = req.compiler || 'g++'
  const compiler = isHostCpp(wanted) ? wanted : 'g++'
  if (wanted !== compiler) {
    // Say so. Substituting in silence is why picking avr-g++ in the toolbar
    // surfaced as a bare "spawn g++ ENOENT" with nothing connecting the two.
    system(win, req.id, `${commandBaseName(wanted)} builds firmware, not host programs. Using ${compiler} instead.\n`)
  }
  const { exePath, args: compileArgs } = await prepareSimulation({
    filePath: req.filePath, simDir, mainSource: SIM_MAIN, compiler
  })
  if (cancelled.has(req.id) || win.isDestroyed()) {
    cancelled.delete(req.id)
    exit(win, req.id, null)
    return
  }

  system(win, req.id, `Compiling simulation with ${compiler}...\n`)
  let cc: ChildProcess
  try {
    const ccBin = safeCommand(compiler, getWorkspaceRoot())
    if (!ccBin) throw new Error(`Refusing a compiler from inside the workspace: ${compiler}`)
    cc = spawn(ccBin, compileArgs, { cwd: simDir, windowsHide: true })
    // Decode UTF-8 across chunk boundaries (see runnerService).
    cc.stdout?.setEncoding('utf8')
    cc.stderr?.setEncoding('utf8')
  } catch (err) {
    system(win, req.id, `Failed to launch ${compiler}: ${String(err)}\n`)
    exit(win, req.id, 127)
    return
  }
  // Track the compiler child so a Stop during compilation actually cancels it.
  active.set(req.id, cc)
  let cerr = ''
  let cerrBytes = 0
  let overflow = false
  cc.stdin?.on('error', () => {})
  cc.stderr?.on('data', (d) => {
    if (overflow) return
    const text = d.toString()
    const bytes = Buffer.byteLength(text)
    if (bytes > SIM_BUFFER_LIMIT_BYTES - cerrBytes) {
      overflow = true
      runner.emitDiagnostics(win, req.id, cerr, dirname(req.filePath))
      cerr = ''
      stopOverflow(win, req.id, cc, 'Compiler diagnostics')
      return
    }
    cerr += text
    cerrBytes += bytes
  })
  cc.on('error', (err) => system(win, req.id, `Failed to launch ${compiler}: ${String(err)}\n`))
  cc.on('close', (code) => {
    active.delete(req.id)
    if (overflow) { cancelled.delete(req.id); return }
    if (cancelled.has(req.id)) {
      cancelled.delete(req.id)
      exit(win, req.id, code)
      return
    }
    // Emit UNCONDITIONALLY, like the native path: on success this publishes an
    // empty list, which is what clears stale problems and squiggles once the
    // user fixes the error. Only emitting on failure left them forever.
    // Thanks to #line these name the user's real .ino, not sketch.cpp.
    runner.emitDiagnostics(win, req.id, cerr, dirname(req.filePath))
    if (code !== 0) {
      system(win, req.id, cerr || 'Compilation failed.\n')
      exit(win, req.id, code)
      return
    }
    launch(win, req, exePath, simDir)
  })
}

function launch(win: BrowserWindow, req: SimStartRequest, exePath: string, cwd: string): void {
  if (cancelled.has(req.id) || win.isDestroyed()) {
    cancelled.delete(req.id)
    exit(win, req.id, null)
    return
  }
  system(win, req.id, 'Simulation running.\n')
  let child: ChildProcess
  try {
    child = spawn(exePath, [], { cwd, windowsHide: true })
    // Decode UTF-8 across chunk boundaries (see runnerService).
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
  } catch (err) {
    system(win, req.id, `Failed to start simulation: ${String(err)}\n`)
    exit(win, req.id, 1)
    return
  }
  active.set(req.id, child)
  child.stdin?.on('error', () => {})
  child.on('error', (err) => {
    active.delete(req.id)
    system(win, req.id, `Failed to start simulation: ${String(err)}\n`)
    exit(win, req.id, 1)
  })
  let buf = ''
  let bufBytes = 0
  let overflow = false
  child.stdout?.on('data', (d) => {
    if (overflow) return
    const fragments = d.toString().split('\n')
    for (let i = 0; i < fragments.length; i++) {
      const fragment = fragments[i]
      const bytes = Buffer.byteLength(fragment)
      if (bytes > SIM_BUFFER_LIMIT_BYTES - bufBytes) {
        overflow = true
        buf = ''
        stopOverflow(win, req.id, child, 'Simulation protocol line')
        return
      }
      buf += fragment
      bufBytes += bytes
      if (i === fragments.length - 1) break
      const parsed = parseSimLine(buf.endsWith('\r') ? buf.slice(0, -1) : buf)
      if (parsed) emit(win, { id: req.id, ...parsed } as SimEvent)
      buf = ''
      bufBytes = 0
    }
  })
  child.stderr?.on('data', (d) => { if (!overflow) system(win, req.id, d.toString()) })
  child.on('close', (code) => {
    active.delete(req.id)
    cancelled.delete(req.id)
    if (overflow) return
    // Drain whatever never got its newline. The shim flushes its own residue at
    // exit, but a killed process cannot, and dropping the tail here would lose
    // the last thing the sketch said.
    if (buf) {
      const parsed = parseSimLine(buf)
      if (parsed) emit(win, { id: req.id, ...parsed } as SimEvent)
      buf = ''
    }
    exit(win, req.id, code)
  })
}

/**
 * How long a sketch gets to notice @stop and leave through __sim_exit, which is
 * what flushes a partial Serial.print and yields exit 0. Killing in the same
 * tick as the write meant the sketch never read it: every stop reported exit
 * null and dropped the sketch's last output, which made the shim's whole flush
 * path dead code in the product. Long enough for a loop() iteration, short
 * enough that Stop still feels instant.
 */
const STOP_GRACE_MS = 250

export function stop(id: string): void {
  const child = active.get(id)
  if (!child && !pending.has(id)) return
  cancelled.add(id) // guard the compile->launch handoff even if we kill mid-compile
  if (!child) return
  child.stdin?.write('@stop\n', () => {})
  const t = setTimeout(() => child.kill(), STOP_GRACE_MS)
  // Removal belongs to the close handler, which also drains the last partial
  // line. Deleting here dropped both.
  child.once('exit', () => clearTimeout(t))
}

export function input(id: string, pin: number, value: number): void {
  const child = active.get(id)
  if (child?.stdin?.writable) child.stdin.write(`@in ${pin} ${value}\n`, () => {})
}

/**
 * Quit path: no grace window on purpose. The window is going away, so there is
 * nobody left to read a flushed line, and a per-child wait would only make quit
 * feel slow.
 */
export function killAll(): void {
  for (const id of pending) cancelled.add(id)
  for (const [id, child] of active) {
    cancelled.add(id)
    child.kill()
  }
  active.clear()
}
