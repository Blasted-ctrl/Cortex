import { spawn, execFile, ChildProcess } from 'child_process'
import { promisify } from 'util'
import { join, dirname, basename } from 'path'
import { mkdir } from 'fs/promises'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc'
import type { DebugStartRequest, DebugState, DebugFrame, DebugVariable } from '../../shared/ipc'
import { isAllowedCommand, isBareCommand, sanitizeExtraArgs } from '../../shared/security'
import { withinWorkspace, getWorkspaceRoot } from './fsService'
import { emitDiagnostics } from './runnerService'
import { safeCommand, needsShell } from './commandResolver'
import { parseMiLine, asString, asArray, asTuple, type MiTuple, type MiValue } from '../../shared/gdbmi'

const execFileAsync = promisify(execFile)
const IS_WIN = process.platform === 'win32'

/**
 * Host C/C++ debugger driven by gdb's MI2 interface. Compiles the file with
 * debug symbols, launches gdb, and translates MI async records into a single
 * DebugState the renderer renders (call stack, variables, current line). One
 * session at a time, mirroring the single Run.
 */

interface Pending {
  resolve: (r: MiTuple) => void
  reject: (e: unknown) => void
}

class GdbSession {
  private gdb: ChildProcess | null = null
  private outputChild: ChildProcess | null = null
  private disposed = false
  private buf = ''
  private token = 1
  private readonly pending = new Map<number, Pending>()
  private status: DebugState['status'] = 'starting'
  private breakpoints: { file: string; line: number }[]
  private selectedFrame = 0

  constructor(
    private readonly win: BrowserWindow,
    private readonly exe: string,
    private readonly cwd: string,
    breakpoints: { file: string; line: number }[]
  ) {
    this.breakpoints = breakpoints
  }

  private send(cmd: string): void {
    // A stray newline would inject a second MI command; never write one.
    if (/[\r\n]/.test(cmd)) return
    this.gdb?.stdin?.write(cmd + '\n')
  }

  private isActive(child: ChildProcess | null = this.gdb): boolean {
    return !this.disposed && child !== null && this.gdb === child
  }

  /** Send an MI command and resolve with its result record. */
  private command(cmd: string): Promise<MiTuple> {
    if (!this.isActive() || this.win.isDestroyed()) return Promise.reject('debug session ended')
    return new Promise((resolve, reject) => {
      const t = this.token++
      this.pending.set(t, { resolve, reject })
      this.send(`${t}${cmd}`)
    })
  }

  /** Fail every in-flight command so an awaited command() cannot hang after gdb
   * dies. */
  private rejectAllPending(reason: string): void {
    this.pending.forEach((p) => p.reject(reason))
    this.pending.clear()
  }

  private out(stream: 'program' | 'gdb' | 'system', text: string): void {
    if (!this.disposed && !this.win.isDestroyed()) this.win.webContents.send(IPC.DEBUG_OUTPUT, { stream, text })
  }

  async start(): Promise<void> {
    if (this.disposed) return
    let gdb: ChildProcess
    try {
      // PATH-resolved, never cwd-resolved: this cwd is the user's project and
      // libuv searches it first on Windows, so a repo shipping gdb.exe would run.
      const gdbBin = safeCommand('gdb', getWorkspaceRoot())
      if (!gdbBin) throw new Error('gdb resolved inside the workspace')
      gdb = spawn(gdbBin, ['--interpreter=mi2', this.exe], { cwd: this.cwd, windowsHide: true, shell: needsShell(gdbBin) })
    } catch (e) {
      this.pushState({ status: 'exited', error: `Failed to launch gdb: ${String(e)}` })
      return
    }
    this.gdb = gdb
    this.outputChild = gdb
    const current = (): boolean => this.isActive(gdb) && !this.win.isDestroyed()
    const ownsOutput = (): boolean => !this.disposed && this.outputChild === gdb && !this.win.isDestroyed()
    // Decode across chunk boundaries: a multi-byte character split by a pipe
    // read would otherwise be two U+FFFD before the MI parser ever sees it.
    gdb.stdout?.setEncoding('utf8')
    gdb.stderr?.setEncoding('utf8')
    gdb.stdout?.on('data', (d: string) => { if (ownsOutput()) this.onData(d) })
    gdb.stderr?.on('data', (d: string) => { if (ownsOutput()) this.out('gdb', d) })
    gdb.stdin?.on('error', () => {})
    gdb.on('error', (e) => {
      if (!this.isActive(gdb)) return
      this.gdb = null
      this.status = 'exited'
      this.rejectAllPending(String(e))
      this.pushState({ status: 'exited', error: String(e) })
    })
    gdb.on('exit', () => {
      if (!this.isActive(gdb)) return
      this.gdb = null
      this.rejectAllPending('gdb exited')
      if (this.status !== 'exited') {
        this.status = 'exited'
        this.pushState({ status: 'exited' })
      }
    })
    gdb.on('close', () => {
      if (this.outputChild !== gdb) return
      this.outputChild = null
      this.buf = ''
    })

    // Windows: keep the inferior in this console so its stdout reaches us as MI
    // target-stream records rather than a detached window.
    if (IS_WIN) await this.command('-gdb-set new-console off').catch(() => ({}))
    if (!current()) return
    // Async so gdb keeps reading MI while the inferior runs, which is what lets
    // -exec-interrupt (Pause) actually work.
    await this.command('-gdb-set mi-async on').catch(() => ({}))
    if (!current()) return
    for (const bp of this.breakpoints) {
      if (/[\r\n]/.test(bp.file)) continue
      await this.command(`-break-insert ${miPath(bp.file)}:${bp.line}`).catch(() => ({}))
      if (!current()) return
    }
    this.out('system', 'Starting debugger...\n')
    // -exec-run starts the program; it stops at the first breakpoint or exits.
    this.command('-exec-run').catch(() => ({}))
    if (!current()) return
    this.status = 'running'
    this.pushState({ status: 'running' })
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    const rec = parseMiLine(line)
    if (rec.kind === 'result') {
      if (rec.token !== null) {
        const p = this.pending.get(rec.token)
        if (p) {
          this.pending.delete(rec.token)
          if (rec.class === 'error') p.reject(asString(rec.results.msg) || 'gdb error')
          else p.resolve(rec.results)
        }
      }
      return
    }
    if (rec.kind === 'stream') {
      // Console (~) is gdb chatter; target (@) is the inferior's own output.
      if (rec.type === 'target') this.out('program', rec.text)
      else if (rec.type === 'console') this.out('gdb', rec.text)
      return
    }
    if (rec.kind === 'async' && rec.type === 'exec') {
      if (!this.isActive()) return
      if (rec.class === 'stopped') void this.onStopped(rec.results)
      else if (rec.class === 'running') {
        this.status = 'running'
        this.pushState({ status: 'running' })
      }
      return
    }
    // Anything that is not an MI record is the INFERIOR writing to the console
    // it shares with gdb. Only MSYS2/mingw gdb wraps program output in target
    // (@) stream records; the Windows build hands the child the same stdout
    // handle, so a printf arrives here as a plain line. Dropping `unknown` meant
    // a debugged program's output was invisible for the whole session - you
    // could step through printf and never see what it printed.
    if (rec.kind === 'unknown' && rec.text) this.out('program', rec.text + '\n')
  }

  private async onStopped(results: MiTuple): Promise<void> {
    const reason = asString(results.reason)
    if (reason.startsWith('exited')) {
      // gdb formats exit-code in octal ("052" for 42), so parse base 8.
      const code = asString(results['exit-code'])
      this.status = 'exited'
      this.pushState({ status: 'exited', reason, exitCode: code ? parseInt(code, 8) : 0 })
      return
    }
    this.status = 'stopped'
    this.selectedFrame = 0
    await this.refreshStopped(reason)
  }

  /** Pull the call stack + selected-frame variables and push a full state. */
  private async refreshStopped(reason?: string): Promise<void> {
    const stack = await this.command('-stack-list-frames')
      .then((r) => parseFrames(r.stack))
      .catch(() => [] as DebugFrame[])
    if (!this.isActive()) return
    const vars = await this.variablesForFrame(this.selectedFrame)
    if (!this.isActive()) return
    const top = stack[this.selectedFrame] ?? stack[0]
    this.pushState({
      status: 'stopped',
      reason,
      stack,
      frame: this.selectedFrame,
      variables: vars,
      currentFile: top?.fullname || top?.file,
      currentLine: top?.line
    })
  }

  private async variablesForFrame(level: number): Promise<DebugVariable[]> {
    return this.command(`-stack-list-variables --thread 1 --frame ${level} --all-values`)
      .then((r) => parseVariables(r.variables))
      .catch(() =>
        // Older gdb rejects the --frame form; fall back to the current frame.
        this.isActive() ? this.command('-stack-list-variables --all-values')
          .then((r) => parseVariables(r.variables))
          .catch(() => [] as DebugVariable[])
          : [] as DebugVariable[]
      )
  }

  private pushState(partial: Partial<DebugState>): void {
    if (this.disposed || this.win.isDestroyed()) return
    const state: DebugState = {
      status: this.status,
      stack: [],
      frame: this.selectedFrame,
      variables: [],
      ...partial
    }
    this.win.webContents.send(IPC.DEBUG_STATE, state)
  }

  // ---- commands driven by the UI -----------------------------------------

  cont(): void {
    this.command('-exec-continue').catch(() => ({}))
  }
  stepOver(): void {
    this.command('-exec-next').catch(() => ({}))
  }
  stepInto(): void {
    this.command('-exec-step').catch(() => ({}))
  }
  stepOut(): void {
    this.command('-exec-finish').catch(() => ({}))
  }
  pause(): void {
    // Interrupt the running inferior. Never kill the gdb process: on Windows
    // kill() maps to TerminateProcess and would end the whole session. With
    // mi-async on, gdb is reading MI and -exec-interrupt stops at the current
    // line.
    this.command('-exec-interrupt').catch(() => ({}))
  }

  async selectFrame(level: number): Promise<void> {
    if (!this.isActive()) return
    this.selectedFrame = level
    await this.command(`-stack-select-frame ${level}`).catch(() => ({}))
    if (!this.isActive()) return
    const vars = await this.variablesForFrame(level)
    if (!this.isActive()) return
    const stack = await this.command('-stack-list-frames')
      .then((r) => parseFrames(r.stack))
      .catch(() => [] as DebugFrame[])
    if (!this.isActive()) return
    const f = stack[level]
    this.pushState({
      status: 'stopped',
      stack,
      frame: level,
      variables: vars,
      currentFile: f?.fullname || f?.file,
      currentLine: f?.line
    })
  }

  async setBreakpoints(file: string, lines: number[]): Promise<void> {
    // A newline would inject an MI command; a path outside the workspace has no
    // business in this session.
    if (/[\r\n]/.test(file) || !withinWorkspace(file)) return
    // Clear this file's breakpoints, then re-insert. Simplest correct approach.
    this.breakpoints = this.breakpoints.filter((b) => b.file !== file)
    await this.command('-break-list')
      .then(async (r) => {
        const rows = asArray(asTuple(r.BreakpointTable).body)
        for (const row of rows) {
          if (!this.isActive()) return
          const t = asTuple(row)
          if (basename(asString(t.fullname) || asString(t.file)) === basename(file)) {
            await this.command(`-break-delete ${asString(t.number)}`).catch(() => ({}))
          }
        }
      })
      .catch(() => ({}))
    for (const line of lines) {
      if (!this.isActive()) return
      this.breakpoints.push({ file, line })
      await this.command(`-break-insert ${miPath(file)}:${line}`).catch(() => ({}))
    }
  }

  async evaluate(expr: string): Promise<string> {
    return this.command(`-data-evaluate-expression ${JSON.stringify(expr)}`)
      .then((r) => asString(r.value))
      .catch((e) => `<${String(e)}>`)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.outputChild = null
    this.buf = ''
    this.rejectAllPending('debug session ended')
    try {
      this.send('-gdb-exit')
    } catch {
      /* already gone */
    }
    const child = this.gdb
    this.gdb = null
    try {
      child?.kill()
    } catch {
      /* already gone */
    }
  }
}

function parseFrames(v: MiValue | undefined): DebugFrame[] {
  return asArray(v).map((f) => {
    const t = asTuple(f)
    return {
      level: parseInt(asString(t.level) || '0', 10),
      func: asString(t.func),
      file: asString(t.file),
      fullname: asString(t.fullname),
      line: parseInt(asString(t.line) || '0', 10),
      addr: asString(t.addr)
    }
  })
}

function parseVariables(v: MiValue | undefined): DebugVariable[] {
  return asArray(v).map((x) => {
    const t = asTuple(x)
    return { name: asString(t.name), value: asString(t.value), type: asString(t.type) || undefined }
  })
}

/** gdb wants forward slashes even on Windows for break-insert file specs. */
function miPath(p: string): string {
  return p.replace(/\\/g, '/')
}

// ---- public API ------------------------------------------------------------

let session: GdbSession | null = null
// Bumped by every start() and stop(); a compile whose generation is stale (the
// user pressed Stop, or a newer start superseded it) is abandoned before gdb
// launches, so a cancel during compile is honoured and overlapping starts never
// orphan a gdb process.
let startGen = 0
// The in-flight debug compile, so Stop and app-quit can reach it. Without this
// a heavy template build kept running after Stop - and that is exactly the case
// where a user reaches for Stop.
let compileChild: ChildProcess | null = null

/** Compile with debug symbols, then start a gdb session. */
export async function start(win: BrowserWindow, req: DebugStartRequest): Promise<void> {
  stop() // one session at a time; stop() bumps startGen
  const myGen = startGen // the generation this start owns
  const current = (): boolean => myGen === startGen && !win.isDestroyed()
  const compiler = req.compiler || 'g++'
  // Gate exactly as Run does (isAllowedCommand alone). Requiring a BARE name
  // here refused the one form app settings exist to hold: an absolute path to a
  // compiler that is not on PATH, which is the normal MSYS2 install. Run and
  // Simulate accepted it and Debug reported "Compiler not allowed" for every
  // file, permanently. The untrusted source of this value is already stripped
  // of non-bare names in projectConfigService, so the bare check only ever
  // fired on the trusted one.
  if (!isAllowedCommand(compiler)) {
    win.webContents.send(IPC.DEBUG_STATE, blank('exited', `Compiler not allowed: ${compiler}`))
    return
  }
  // Confine to the open workspace, like the fs and LSP paths: never compile or
  // run code outside it.
  if (!withinWorkspace(req.cwd) || !withinWorkspace(req.filePath)) {
    win.webContents.send(IPC.DEBUG_STATE, blank('exited', 'File is outside the open workspace.'))
    return
  }
  const buildDir = join(req.cwd, '.cortex', 'debug')
  await mkdir(buildDir, { recursive: true }).catch(() => {})
  if (!current()) return
  const base = basename(req.filePath).replace(/\.[^.]+$/, '')
  const exe = join(buildDir, IS_WIN ? `${base}.exe` : base)
  const isC = /\.c$/i.test(req.filePath)
  const { kept, dropped } = sanitizeExtraArgs(req.extraArgs)
  const args = ['-g', '-O0']
  // Apply whichever standard fits the language. Skipping it for C dropped
  // the project's C standard entirely on debug builds.
  if (req.std && (isC ? !req.std.startsWith('c++') : true)) args.push(`-std=${req.std}`)
  // Same order and the same sanitizer as the Run path: after the translation
  // unit (so -L/-l link) and before -o.
  args.push(req.filePath, ...kept, '-o', exe)
  if (dropped.length) {
    win.webContents.send(IPC.DEBUG_OUTPUT, {
      stream: 'system',
      text: `Ignoring ${dropped.length} flag(s) from .cortex/config.json that could redirect the build: ${dropped.join(' ')}
`
    })
  }

  win.webContents.send(IPC.DEBUG_STATE, blank('starting'))
  win.webContents.send(IPC.DEBUG_OUTPUT, { stream: 'system', text: `$ ${compiler} ${args.join(' ')}\n` })
  // Was execFileAsync with its default 1 MiB stderr cap and a 60s timeout, so a
  // build that merely produced a lot of diagnostics (a template backtrace is
  // easily megabytes) was SIGTERMed and reported as "Build failed" with the
  // error cut mid-line - while Run, which streams, built the same file fine.
  // Cancellation is already handled by the startGen check below, so the timeout
  // bought nothing either.
  const compilerBin = safeCommand(compiler, getWorkspaceRoot())
  if (!compilerBin) {
    win.webContents.send(IPC.DEBUG_STATE, blank('exited', `Refusing a compiler from inside the workspace: ${compiler}`))
    return
  }
  const build = await new Promise<{ ok: boolean; stderr: string }>((done) => {
    let buf = ''
    let cp: ChildProcess
    try {
      cp = spawn(compilerBin, args, { cwd: req.cwd, windowsHide: true, shell: needsShell(compilerBin) })
      // Tracked so Stop and app-quit can reach it: an untracked compile child
      // survived both, and a heavy template build is exactly the case where a
      // user reaches for Stop.
      compileChild = cp
    } catch (e) {
      win.webContents.send(IPC.DEBUG_OUTPUT, { stream: 'gdb', text: String(e) })
      return done({ ok: false, stderr: String(e) })
    }
    cp.stdout?.setEncoding('utf8')
    cp.stderr?.setEncoding('utf8')
    cp.stdin?.on('error', () => {})
    cp.stderr?.on('data', (d: string) => {
      if (!current() || compileChild !== cp) return
      buf += d
      win.webContents.send(IPC.DEBUG_OUTPUT, { stream: 'gdb', text: d })
    })
    cp.on('error', (e) => {
      if (current() && compileChild === cp) win.webContents.send(IPC.DEBUG_OUTPUT, { stream: 'gdb', text: `${String(e)}
` })
      if (compileChild === cp) compileChild = null
      done({ ok: false, stderr: buf })
    })
    cp.on('close', (code) => {
      if (compileChild === cp) compileChild = null
      done({ ok: code === 0, stderr: buf })
    })
  })
  // Warnings on success, errors on failure: both belong in Problems. Run has
  // done this all along (emitDiagnostics is exported for exactly this reuse);
  // Debug reported build errors as loose text, so Problems read "No problems"
  // while the build had just failed and there was no way to click to the line.
  // BEFORE any state is written. Stop, or a newer Debug, already superseded us:
  // a dead build's terminal state would otherwise overwrite the live session's
  // (the renderer applies DEBUG_STATE unconditionally), flipping a running
  // session to "Build failed" for a build nobody is waiting on.
  if (!current()) return
  emitDiagnostics(win, req.runId, build.stderr, req.cwd)
  if (!build.ok) {
    win.webContents.send(IPC.DEBUG_STATE, blank('exited', 'Build failed. Fix the errors and try again.'))
    return
  }
  // Stop pressed, or a newer start() superseded us, during the compile: abandon.
  if (!current()) return
  // The inferior's cwd, and it must match Run's (req.cwd, the workspace root).
  // Using the file's directory meant a program opening "data.txt" relative to
  // the project found it under Run and not under Debug.
  session = new GdbSession(win, exe, req.cwd, req.breakpoints)
  await session.start()
}

function blank(status: DebugState['status'], error?: string): DebugState {
  return { status, stack: [], frame: 0, variables: [], error }
}

export function stop(): void {
  startGen++ // cancel any in-flight compile awaiting its generation
  const child = compileChild
  compileChild = null
  if (child) {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
  const stopped = session
  session = null
  stopped?.dispose()
}
export function cont(): void {
  session?.cont()
}
export function stepOver(): void {
  session?.stepOver()
}
export function stepInto(): void {
  session?.stepInto()
}
export function stepOut(): void {
  session?.stepOut()
}
export function pause(): void {
  session?.pause()
}
export function selectFrame(level: number): void {
  void session?.selectFrame(level)
}
export function setBreakpoints(file: string, lines: number[]): void {
  void session?.setBreakpoints(file, lines)
}
export function evaluate(expr: string): Promise<string> {
  return session ? session.evaluate(expr) : Promise.resolve('')
}
