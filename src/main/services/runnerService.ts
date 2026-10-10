import { spawn, ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import { join, dirname, basename, extname, isAbsolute, resolve } from 'path'
import { platform } from 'os'
import type { BrowserWindow } from 'electron'
import type { RunRequest, RunExit, Diagnostic } from '../../shared/ipc'
import { IPC } from '../../shared/ipc'
import {
  parseDiagnostics,
  parseRustJsonDiagnostics,
  renderRustJsonLine,
  isCargoJsonLine,
  isBuildFinished,
  cargoRenderedMessage,
  parseCargoDiagnostics
} from '../../shared/diagnostics'
import { isAllowedCommand, isBareCommand, commandBaseName, sanitizeExtraArgs, OPT_LEVELS } from '../../shared/security'
import { withinWorkspace, getWorkspaceRoot } from './fsService'
import { safeCommand, commandMissing, needsShell } from './commandResolver'

const IS_WIN = platform() === 'win32'

/** Longest un-newlined stdout run held back while deciding if it is a machine
 * record. Cargo's records are one short line; anything larger is program output. */
// A cargo record is one line, but a diagnostic with a large `rendered` field on
// generic-heavy code can be hundreds of KB, so the bound has to clear a real
// record comfortably. Past it we assume program output and let it through.
const MAX_PARTIAL_BYTES = 1024 * 1024
/** Same ceiling parseDiagnostics uses per build, so streaming per record cannot
 * regress it into "500 per record, unbounded overall". */
const MAX_DIAGNOSTICS = 500
// How long a possible-machine-record partial may be withheld before it is shown
// as program output. Long enough that a record split across chunks reassembles,
// short enough that a blocked prompt does not read as a hang.
const PARTIAL_HOLD_MS = 250

interface ActiveRun {
  child: ChildProcess
  startedAt: number
}

const active = new Map<string, ActiveRun>()
// Reserve an ID before any async preparation. Stop/quit must still work while
// no child exists, and a duplicate start must not replace the first child.
const pending = new Map<string, AbortController>()

export function beginRunStart(id: string): AbortSignal | null {
  if (active.has(id) || pending.has(id)) return null
  const controller = new AbortController()
  pending.set(id, controller)
  return controller.signal
}

export function finishRunStart(id: string, signal: AbortSignal): void {
  if (pending.get(id)?.signal === signal) pending.delete(id)
}

export function runStartCancelled(win: BrowserWindow, id: string, signal: AbortSignal, phase: RunExit['phase']): boolean {
  if (!signal.aborted && !win.isDestroyed()) return false
  exit(win, { id, code: null, signal: null, durationMs: 0, phase })
  return true
}

function send(win: BrowserWindow, channel: string, payload: unknown): void {
  if (!win.isDestroyed()) win.webContents.send(channel, payload)
}

function out(win: BrowserWindow, id: string, stream: 'stdout' | 'stderr' | 'system', data: string): void {
  send(win, IPC.RUN_OUTPUT, { id, stream, data })
}

function exit(win: BrowserWindow, payload: RunExit): void {
  send(win, IPC.RUN_EXIT, payload)
}

/** Parse compiler stderr and emit structured diagnostics with absolute paths. */
export function emitDiagnostics(win: BrowserWindow, id: string, stderr: string, cwd: string): Diagnostic[] {
  const diagnostics = parseDiagnostics(stderr).map((d) => ({
    ...d,
    file: isAbsolute(d.file) ? d.file : resolve(cwd, d.file)
  }))
  send(win, IPC.RUN_DIAGNOSTICS, { id, diagnostics })
  return diagnostics
}

/**
 * Same, for rustc's `--error-format=json` records: exact spans, no regex.
 * Falls back to the textual parser so a plain rustc invocation (or a wrapper
 * that strips the flag) still populates the Problems panel.
 */
export function emitRustDiagnostics(win: BrowserWindow, id: string, stderr: string, cwd: string): Diagnostic[] {
  const parsed = parseRustJsonDiagnostics(stderr)
  const diagnostics = (parsed.length ? parsed : parseDiagnostics(stderr)).map((d) => ({
    ...d,
    file: isAbsolute(d.file) ? d.file : resolve(cwd, d.file)
  }))
  send(win, IPC.RUN_DIAGNOSTICS, { id, diagnostics })
  return diagnostics
}

/** hrtime-based elapsed ms without relying on Date.now(). */
function elapsed(start: number): number {
  return Math.round((performance.now() - start))
}

/** How to get each tool Cortex may fail to launch. */
const INSTALL_HINT: Record<string, string> = {
  'g++': 'Install GCC (MSYS2: pacman -S mingw-w64-x86_64-gcc) or Clang, then rescan in Settings.',
  gcc: 'Install GCC (MSYS2: pacman -S mingw-w64-x86_64-gcc) or Clang, then rescan in Settings.',
  'clang++': 'Install LLVM/Clang (winget install LLVM.LLVM), then rescan in Settings.',
  clang: 'Install LLVM/Clang (winget install LLVM.LLVM), then rescan in Settings.',
  rustc: 'Install Rust (winget install Rustlang.Rustup, or https://rustup.rs), then rescan in Settings.',
  node: 'Install Node.js (winget install OpenJS.NodeJS), then rescan in Settings.',
  python: 'Install Python (winget install Python.Python.3.12), or set an interpreter in Settings.',
  python3: 'Install Python (winget install Python.Python.3.12), or set an interpreter in Settings.'
}

/**
 * Why a command could not be launched. safeCommand returns null for two very
 * different reasons and they must not be reported the same way: a machine that
 * simply lacks the toolchain needs the install hint, not a security refusal.
 */
export function missingOrRefused(cmd: string): string {
  if (commandMissing(cmd)) return spawnErrorText(cmd, { code: 'ENOENT' })
  return `Refusing to run '${cmd}': it resolves to a file inside the open workspace.\n`
}

/**
 * Node reports a missing executable ASYNCHRONOUSLY on the child's 'error'
 * event, so a try/catch around spawn() never fires. Say what is missing and how
 * to get it, instead of leaking `Error: spawn rustc ENOENT` and `exit -4058`.
 */
function spawnErrorText(cmd: string, err: unknown): string {
  const code = (err as { code?: string }).code
  if (code === 'ENOENT') {
    const hint = INSTALL_HINT[commandBaseName(cmd)]
    return `'${cmd}' was not found on your PATH.${hint ? `\n${hint}` : ''}\n`
  }
  return `${String(err)}\n`
}

/** Compile a C/C++ program, returning the output executable path, or null on failure. */
async function compileNative(win: BrowserWindow, req: RunRequest, cancellation: AbortSignal): Promise<string | null> {
  // Branch on the language BEFORE consulting req: the renderer always sends a
  // std (default 'c++23'), so `req.std || ...` made both C fallbacks dead code
  // and every .c file was built by g++ with a C++ standard - which silently
  // changes the source language and rejects valid C (void* conversions).
  const isC = req.language === 'c'
  const compiler = req.compiler || (isC ? 'gcc' : 'g++')
  const std = isC ? (req.std && !req.std.startsWith('c++') ? req.std : undefined) : req.std || 'c++23'
  const buildDir = join(req.cwd, '.cortex', 'build')
  await fs.mkdir(buildDir, { recursive: true })
  if (runStartCancelled(win, req.id, cancellation, 'compile')) return null

  const base = basename(req.filePath, extname(req.filePath))
  const exePath = join(buildDir, IS_WIN ? `${base}.exe` : base)

  // These arrive from .cortex/config.json, which travels with a cloned repo.
  const { kept, dropped } = sanitizeExtraArgs(req.extraArgs)
  const args: string[] = []
  if (std) args.push(`-std=${std}`)
  // Same reason: the level is a raw argv token, so `-fplugin=./x.so` in the
  // optimization field would be loaded into the compiler process.
  args.push(OPT_LEVELS.includes(req.optimization ?? '') ? req.optimization! : '-O0')
  args.push('-Wall', '-g')
  // Project flags go AFTER the translation unit and BEFORE -o. ld resolves
  // inputs in order against the symbols still undefined, so `-lmylib main.cpp`
  // discards the archive and the link fails on the user's own source; and
  // keeping them ahead of -o means a stray -o could not win anyway (the
  // sanitizer cannot admit one, but the ordering costs nothing).
  args.push(req.filePath, ...kept, '-o', exePath)

  if (dropped.length) {
    out(
      win,
      req.id,
      'system',
      `Ignoring ${dropped.length} flag(s) from .cortex/config.json that could redirect the build: ${dropped.join(' ')}\n`
    )
  }
  out(win, req.id, 'system', `$ ${compiler} ${args.join(' ')}\n`)

  const start = performance.now()
  // Resolve from PATH before spawning: libuv searches the child's cwd FIRST on
  // Windows, and that cwd is inside the user's project.
  const compilerBin = safeCommand(compiler, getWorkspaceRoot())
  if (!compilerBin) {
    out(win, req.id, 'stderr', missingOrRefused(compiler))
    exit(win, { id: req.id, code: 126, signal: null, durationMs: 0, phase: 'compile' })
    return null
  }
  return new Promise((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawn(compilerBin, args, { cwd: req.cwd, windowsHide: true, shell: needsShell(compilerBin) })
    } catch (err) {
      out(win, req.id, 'stderr', `Failed to launch compiler '${compiler}': ${String(err)}\n`)
      exit(win, { id: req.id, code: 127, signal: null, durationMs: 0, phase: 'compile' })
      resolve(null)
      return
    }
    active.set(req.id, { child: proc, startedAt: start })
    // Decode as UTF-8 across chunk boundaries. Without this each Buffer is
    // decoded in isolation, so a multi-byte character split by a pipe read
    // becomes U+FFFD before the line buffer ever sees it - and the raw bytes
    // are gone by then, so no amount of line reassembly can repair it.
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdin?.on('error', () => {})
    let stderrBuf = ''
    proc.stdout?.on('data', (d) => out(win, req.id, 'stdout', d.toString()))
    proc.stderr?.on('data', (d) => {
      const text = d.toString()
      stderrBuf += text
      out(win, req.id, 'stderr', text)
    })
    proc.on('error', (err) => {
      out(win, req.id, 'stderr', spawnErrorText(compiler, err))
    })
    proc.on('close', (code, signal) => {
      active.delete(req.id)
      const durationMs = elapsed(start)
      // Parse diagnostics on both success (warnings) and failure (errors).
      emitDiagnostics(win, req.id, stderrBuf, req.cwd)
      if (cancellation.aborted || win.isDestroyed()) {
        exit(win, { id: req.id, code: null, signal, durationMs, phase: 'compile' })
        resolve(null)
      } else if (code === 0) {
        out(win, req.id, 'system', `Compiled in ${durationMs}ms\n`)
        // The renderer advances runPhase compile -> run on this event. Without it
        // the phase stays 'compile' for the whole run, so anything gated on the
        // run phase (the stdin box) never appears.
        exit(win, { id: req.id, code: 0, signal: null, durationMs, phase: 'compile' })
        resolve(exePath)
      } else {
        exit(win, { id: req.id, code, signal, durationMs, phase: 'compile' })
        resolve(null)
      }
    })
  })
}

/**
 * Nearest ancestor directory containing Cargo.toml, or null for a loose .rs
 * file. rustc does resolve sibling `mod` files on its own, but it cannot
 * resolve the dependencies declared in Cargo.toml, nor apply cargo's
 * profiles/features/workspace layout, so a crate has to be built by cargo.
 */
export async function findCargoRoot(startDir: string, stopAt?: string): Promise<string | null> {
  let dir = resolve(startDir)
  const stop = stopAt ? resolve(stopAt) : null
  for (;;) {
    try {
      await fs.access(join(dir, 'Cargo.toml'))
      return dir
    } catch {
      /* keep walking up */
    }
    if (stop && dir === stop) return null
    const parent = dirname(dir)
    if (parent === dir) return null // filesystem root
    dir = parent
  }
}

/** Compile a single-file Rust program with rustc, returning the exe path or null. */
async function compileRust(win: BrowserWindow, req: RunRequest, cancellation: AbortSignal): Promise<string | null> {
  const buildDir = join(req.cwd, '.cortex', 'build')
  await fs.mkdir(buildDir, { recursive: true })
  if (runStartCancelled(win, req.id, cancellation, 'compile')) return null
  const base = basename(req.filePath, extname(req.filePath))
  const exePath = join(buildDir, IS_WIN ? `${base}.exe` : base)
  const args = [req.filePath, '-o', exePath, '--edition', req.rustEdition || '2021']
  if (req.optimization && req.optimization !== '-O0') args.push('-O')
  // Exact spans instead of scraping the human-readable form. rustc writes these
  // JSON records to stderr, one per line.
  args.push('--error-format=json')

  out(win, req.id, 'system', `$ rustc ${args.join(' ')}\n`)
  const rustcBin = safeCommand('rustc', getWorkspaceRoot())
  const start = performance.now()
  return new Promise((resolve) => {
    let proc: ChildProcess
    try {
      // No `?? 'rustc'` fallback: that re-bared the command precisely when
      // safeCommand had refused it, handing the lookup back to libuv (which
      // searches the child's cwd first) and undoing the refusal.
      if (!rustcBin) {
        out(win, req.id, 'stderr', missingOrRefused('rustc'))
        exit(win, { id: req.id, code: 127, signal: null, durationMs: 0, phase: 'compile' })
        resolve(null)
        return
      }
      proc = spawn(rustcBin, args, { cwd: req.cwd, windowsHide: true, shell: needsShell(rustcBin) })
    } catch (err) {
      out(win, req.id, 'stderr', `Failed to launch rustc: ${String(err)}\n`)
      exit(win, { id: req.id, code: 127, signal: null, durationMs: 0, phase: 'compile' })
      resolve(null)
      return
    }
    active.set(req.id, { child: proc, startedAt: start })
    // Decode as UTF-8 across chunk boundaries. Without this each Buffer is
    // decoded in isolation, so a multi-byte character split by a pipe read
    // becomes U+FFFD before the line buffer ever sees it - and the raw bytes
    // are gone by then, so no amount of line reassembly can repair it.
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdin?.on('error', () => {})
    proc.stdout?.on('data', (d) => out(win, req.id, 'stdout', d.toString()))
    // Buffer the raw JSON for span-accurate diagnostics, but show the user
    // rustc's own `rendered` text: with --error-format=json the stream is JSON
    // records, and dumping those into the Output panel would be unreadable.
    // Chunks split mid-line, so carry the partial line across events.
    let stderrBuf = ''
    let partial = ''
    proc.stderr?.on('data', (d) => {
      const text = d.toString()
      stderrBuf += text
      partial += text
      const lines = partial.split(/\r?\n/)
      partial = lines.pop() ?? ''
      const rendered = lines.map(renderRustJsonLine).join('')
      if (rendered) out(win, req.id, 'stderr', rendered)
    })
    proc.on('error', (err) => out(win, req.id, 'stderr', spawnErrorText('rustc', err)))
    proc.on('close', (code, signal) => {
      active.delete(req.id)
      const durationMs = elapsed(start)
      // Flush any trailing partial line, then emit span-accurate diagnostics
      // from the JSON records (on success too, so warnings surface).
      if (partial) {
        const tail = renderRustJsonLine(partial)
        if (tail) out(win, req.id, 'stderr', tail)
      }
      emitRustDiagnostics(win, req.id, stderrBuf, req.cwd)
      if (cancellation.aborted || win.isDestroyed()) {
        exit(win, { id: req.id, code: null, signal, durationMs, phase: 'compile' })
        resolve(null)
      } else if (code === 0) {
        out(win, req.id, 'system', `Compiled in ${durationMs}ms\n`)
        exit(win, { id: req.id, code: 0, signal: null, durationMs, phase: 'compile' })
        resolve(exePath)
      } else {
        exit(win, { id: req.id, code, signal, durationMs, phase: 'compile' })
        resolve(null)
      }
    })
  })
}

interface RunProcessOpts {
  /** Called when runProcess decides a run of stdout is the program's own output
   *  rather than a machine record (the spill paths). mapStdoutLine only ever
   *  sees whole, unspilled lines, so without this a spilled record silently
   *  disabled every build-finished signal the caller was waiting for. */
  onProgramOutput?: () => void
  /** Rewrite a stdout line for display; return null to hide it entirely.
   * Used to keep cargo's machine records out of the panel while still showing
   * the human text they carry. Side effects (emitting diagnostics) belong here
   * too, so they happen as records arrive rather than at exit. */
  mapStdoutLine?: (line: string) => string | null
}

function runProcess(
  win: BrowserWindow,
  req: RunRequest,
  command: string,
  args: string[],
  cwd: string,
  opts: RunProcessOpts = {}
): void {
  out(win, req.id, 'system', `$ ${command} ${args.join(' ')}\n`)
  // The built executable arrives here as an absolute path we produced, but so do
  // `python`, `node` and `cargo` as bare names - and this spawn's cwd is inside
  // the project, which libuv searches before PATH on Windows.
  const commandBin = safeCommand(command, getWorkspaceRoot())
  if (!commandBin) {
    out(win, req.id, 'stderr', `Refusing to run a program from inside the workspace: ${command}\n`)
    exit(win, { id: req.id, code: 126, signal: null, durationMs: 0, phase: 'run' })
    return
  }
  const start = performance.now()
  let proc: ChildProcess
  try {
    proc = spawn(commandBin, args, { cwd, windowsHide: true, shell: needsShell(commandBin) })
  } catch (err) {
    out(win, req.id, 'stderr', `Failed to launch '${command}': ${String(err)}\n`)
    exit(win, { id: req.id, code: 127, signal: null, durationMs: 0, phase: 'run' })
    return
  }
  active.set(req.id, { child: proc, startedAt: start })
  // Same reason as the compile paths: decode UTF-8 across chunk boundaries, so
  // the line buffer below reassembles lines out of whole characters.
  proc.stdout?.setEncoding('utf8')
  proc.stderr?.setEncoding('utf8')
  proc.stdin?.on('error', () => {})
  let stdoutPartial = ''
  let spilling = false
  // A '{'-leading partial is held in case it is an unfinished machine record.
  // A program that prints a bare `{` and then blocks on stdin would sit there
  // until exit, looking hung, so give the record a short grace period and then
  // treat the text as the program's own output.
  let holdTimer: NodeJS.Timeout | null = null
  const cancelHold = (): void => {
    if (holdTimer) clearTimeout(holdTimer)
    holdTimer = null
  }
  const holdExpired = (): void => {
    holdTimer = null
    if (!stdoutPartial) return
    spilling = true
    opts.onProgramOutput?.()
    out(win, req.id, 'stdout', stdoutPartial)
    stdoutPartial = ''
  }
  proc.stdout?.on('data', (d) => {
    const text = d.toString()
    if (!opts.mapStdoutLine) {
      out(win, req.id, 'stdout', text)
      return
    }
    // Line-buffer so a machine record split across chunks is still recognised.
    cancelHold()
    stdoutPartial += text
    const lines = stdoutPartial.split(/\r?\n/)
    stdoutPartial = lines.pop() ?? ''
    // We already gave up on the current physical line and emitted its head, so
    // its tail is a fragment, not a line: passing it to mapStdoutLine would try
    // to parse half a JSON object. Emit it raw and resume filtering after the
    // newline that ends it.
    if (spilling && lines.length) {
      opts.onProgramOutput?.()
      out(win, req.id, 'stdout', lines.shift()! + '\n')
      spilling = false
    }
    const shown = lines.map((l) => opts.mapStdoutLine!(l)).filter((l): l is string => l !== null)
    let emit = shown.length ? shown.join('\n') + '\n' : ''
    // A trailing partial that cannot be a machine record is the program's own
    // output: an unterminated `print!("Enter name: ")` prompt, or a `\r`
    // progress line. Holding it until exit makes a waiting program look hung.
    // A '{'-leading partial might still be an unfinished machine record, so it
    // is held - but only up to a bound. Past that it cannot be a cargo record
    // (they are single-line and small), and holding it would both hang the
    // program's output and re-split an ever-growing string on every chunk.
    if (stdoutPartial && (!stdoutPartial.trimStart().startsWith('{') || stdoutPartial.length > MAX_PARTIAL_BYTES)) {
      if (stdoutPartial.trimStart().startsWith('{')) spilling = true
      opts.onProgramOutput?.()
      emit += stdoutPartial
      stdoutPartial = ''
    }
    if (emit) out(win, req.id, 'stdout', emit)
    if (stdoutPartial) holdTimer = setTimeout(holdExpired, PARTIAL_HOLD_MS)
  })
  proc.stderr?.on('data', (d) => out(win, req.id, 'stderr', d.toString()))
  proc.on('error', (err) => out(win, req.id, 'stderr', spawnErrorText(command, err)))
  proc.on('close', (code, signal) => {
    active.delete(req.id)
    cancelHold()
    // Flush any trailing partial line that passed the filter.
    if (opts.mapStdoutLine && stdoutPartial) {
      const tail = spilling ? stdoutPartial : opts.mapStdoutLine(stdoutPartial)
      if (tail !== null) out(win, req.id, 'stdout', tail)
    }
    exit(win, { id: req.id, code, signal, durationMs: elapsed(start), phase: 'run' })
  })
}

function reject(win: BrowserWindow, id: string, msg: string): void {
  out(win, id, 'stderr', msg + '\n')
  exit(win, { id, code: 126, signal: null, durationMs: 0, phase: 'compile' })
}

export async function startRun(win: BrowserWindow, req: RunRequest): Promise<void> {
  const cancellation = beginRunStart(req.id)
  if (!cancellation) return
  try {
    await startReservedRun(win, req, cancellation)
  } catch (err) {
    if (!runStartCancelled(win, req.id, cancellation, 'compile')) throw err
  } finally {
    finishRunStart(req.id, cancellation)
  }
}

async function startReservedRun(win: BrowserWindow, req: RunRequest, cancellation: AbortSignal): Promise<void> {
  if (runStartCancelled(win, req.id, cancellation, 'compile')) return

  switch (req.language) {
    case 'c':
    case 'cpp': {
      const compiler = req.compiler || (req.language === 'c' ? 'gcc' : 'g++')
      if (!isAllowedCommand(compiler)) return reject(win, req.id, `Compiler not allowed: ${compiler}`)
      const exe = await compileNative(win, req, cancellation)
      if (exe && !runStartCancelled(win, req.id, cancellation, 'run')) runProcess(win, req, exe, [], req.cwd)
      break
    }
    case 'rust': {
      // A Cargo project must be built by cargo: rustc alone cannot resolve the
      // dependencies in Cargo.toml, nor apply its profiles/features.
      const cargoRoot = await findCargoRoot(dirname(req.filePath), req.cwd)
      if (runStartCancelled(win, req.id, cancellation, 'compile')) return
      if (cargoRoot) {
        // Plain `json`, not `json-render-diagnostics`: the latter renders
        // diagnostics to stderr as text and emits NO compiler-message records,
        // so the Problems panel would stay empty. With `json` we get the exact
        // spans AND each record's own `rendered` text to show the user.
        const cargoArgs = ['run', '--message-format=json']
        if (req.optimization && req.optimization !== '-O0') cargoArgs.push('--release')
        // Accumulated as records arrive. Emitting only at exit meant a server or
        // a loop kept Problems empty for the whole session, and pressing Stop
        // dropped them entirely (stopRun nulls runId before close).
        const seen: Diagnostic[] = []
        let capped = false
        // The renderer replaces its whole list per push, so a naive send-per-record
        // resends the entire array on every one of hundreds of records. Coalesce
        // to one send per tick: cargo delivers records in bursts.
        // One synthetic compile-phase exit, whichever evidence arrives first:
        // cargo's build-finished record, or the program's first line of output.
        const compileStart = performance.now()
        let inRunPhase = false
        // Set ONLY by cargo's terminal record, never by the heuristics.
        let buildFinished = false
        const enterRunPhase = (): void => {
          if (inRunPhase) return
          inRunPhase = true
          exit(win, { id: req.id, code: 0, signal: null, durationMs: elapsed(compileStart), phase: 'compile' })
        }
        let flushQueued = false
        const flushDiagnostics = (): void => {
          if (flushQueued || !seen.length) return
          flushQueued = true
          setImmediate(() => {
            flushQueued = false
            send(win, IPC.RUN_DIAGNOSTICS, { id: req.id, diagnostics: [...seen] })
          })
        }
        runProcess(win, req, 'cargo', cargoArgs, cargoRoot, {
          // cargo writes its machine records to STDOUT, interleaved with the
          // program's own output. Show the human text a diagnostic carries, drop
          // the rest (they turn "run my program" into a wall of JSON), and pass
          // the program's own lines through untouched.
          onProgramOutput: enterRunPhase,
          mapStdoutLine: (line) => {
            // After cargo's own build-finished record, nothing further can be a
            // cargo record: cargo emits it last. Continuing to shape-match meant
            // a program that prints cargo-like JSON (a wrapper, or anything
            // forwarding --message-format=json) had those lines DELETED from its
            // output, and a compiler-message-shaped one injected fabricated
            // errors into Problems pointing at paths under the crate root.
            if (buildFinished) return line
            if (!isCargoJsonLine(line)) {
              // cargo builds AND runs in one process, so there is no second
              // spawn to hang the compile -> run transition on. Without this the
              // renderer stays in 'compile' for the program's whole life, the
              // status bar says "Compiling...", and the stdin box (gated on the
              // run phase) never appears - so an interactive cargo program can
              // never be fed input. The first line cargo did not write is the
              // program's own output, which means the build is done.
              enterRunPhase()
              return line
            }
            if (seen.length < MAX_DIAGNOSTICS) {
              for (const d of parseCargoDiagnostics(line)) {
                if (seen.length >= MAX_DIAGNOSTICS) break
                seen.push({ ...d, file: isAbsolute(d.file) ? d.file : resolve(cargoRoot, d.file) })
              }
              flushDiagnostics()
            } else if (!capped && parseCargoDiagnostics(line).length) {
              // Only when a diagnostic was actually discarded. Gating on "another
              // record arrived" fired on cargo's own trailing build-finished
              // record, claiming problems were dropped when none were.
              capped = true
              out(win, req.id, 'system', `Cortex is showing the first ${MAX_DIAGNOSTICS} problems; there are more.\n`)
            }
            if (isBuildFinished(line)) {
              buildFinished = true
              enterRunPhase()
            }
            const rendered = cargoRenderedMessage(line)
            return rendered === null ? null : rendered.replace(/\n$/, '')
          }
        })
        break
      }
      const exe = await compileRust(win, req, cancellation)
      if (exe && !runStartCancelled(win, req.id, cancellation, 'run')) runProcess(win, req, exe, [], req.cwd)
      break
    }
    case 'python': {
      // Two sources with two trust levels. `projectPython` comes from the
      // workspace's .cortex/config.json, which travels with a cloned repo, and
      // isAllowedCommand only matches a base name - so 'C:/anywhere/python.exe'
      // would pass it. A venv interpreter IS a path, so paths stay allowed, but
      // an untrusted one only inside the open workspace, where running the
      // repo's own code is already what the user asked for.
      let py = req.pythonPath || 'python'
      // A cloned repo's config is whatever JSON.parse produced, so this may not
      // be a string at all; isBareCommand string-coerces and commandBaseName
      // then threw, killing the whole run before any spawn.
      const pinned = typeof req.projectPython === 'string' ? req.projectPython : ''
      if (pinned) {
        // A relative pin (`.venv/Scripts/python.exe`, the natural way to write
        // one) is relative to the PROJECT. Node would resolve a relative command
        // against process.cwd() rather than the child's cwd, so resolve it here
        // and both the check and the spawn use the same absolute path.
        const abs = isBareCommand(pinned) ? pinned : resolve(req.cwd, pinned)
        // Scoped to Python, not to the whole spawn allowlist: that list also
        // holds node, cargo, arduino-cli and the language servers, so a repo
        // pinning "pyright-langserver" became the interpreter and the run hung
        // forever waiting on LSP frames.
        const isPython = ['python', 'python3'].includes(commandBaseName(abs))
        if (isPython && isAllowedCommand(abs) && (isBareCommand(abs) || withinWorkspace(abs))) py = abs
        else {
          // Say why, rather than silently running a different interpreter than
          // the one the project asked for.
          out(
            win,
            req.id,
            'system',
            `Ignoring the interpreter pinned in .cortex/config.json (${pinned}): it must be a Python command on PATH, or a path inside this workspace.\n`
          )
        }
      }
      if (!isAllowedCommand(py)) return reject(win, req.id, `Interpreter not allowed: ${py}`)
      runProcess(win, req, py, ['-u', req.filePath], dirname(req.filePath))
      break
    }
    case 'javascript': {
      runProcess(win, req, 'node', [req.filePath], dirname(req.filePath))
      break
    }
    default:
      out(win, req.id, 'system', `No runner configured for language '${req.language}'.\n`)
      exit(win, { id: req.id, code: null, signal: null, durationMs: 0, phase: 'run' })
  }
}

export function stopRun(id: string): void {
  pending.get(id)?.abort()
  const run = active.get(id)
  if (!run) return
  killTree(run.child)
  // Removal belongs to the close handler, which also drains the last partial
  // line and emits the final RUN_EXIT. Deleting here dropped both, and put the
  // process beyond the reach of killAll() at quit.
}

/**
 * Kill a child AND anything it started.
 *
 * `cargo run` builds a binary and then runs it as a real child, inheriting our
 * pipe write ends. Killing only cargo left that program alive: the pipes never
 * closed, so 'close' never fired, the run never emitted its exit, and the
 * process outlived Cortex with no way left to stop it. The UI said "stopped"
 * while the program kept running.
 */
function killTree(child: ChildProcess): void {
  if (IS_WIN && child.pid) {
    // Windows has no process groups to signal; taskkill /T walks the tree.
    // Resolved from PATH like every other command: it is spawned with our
    // inherited cwd, and it would be the one spawn this fix missed.
    const tk = safeCommand('taskkill', getWorkspaceRoot())
    if (tk) {
      try {
        const killer = spawn(tk, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        // An unhandled 'error' on a spawned child throws on the process. And if
        // taskkill cannot run at all, the tree kill silently did nothing, so
        // fall back to the handle-based kill rather than leaving it running.
        killer.on('error', () => {
          try {
            child.kill()
          } catch {
            /* already gone */
          }
        })
        return
      } catch {
        /* fall through to the plain kill */
      }
    }
  }
  try {
    child.kill()
  } catch {
    /* already gone */
  }
}

// ---- shared plumbing reused by the embedded/board service -----------------

export function sendRunOutput(
  win: BrowserWindow,
  id: string,
  stream: 'stdout' | 'stderr' | 'system',
  data: string
): void {
  out(win, id, stream, data)
}

export function sendRunExit(win: BrowserWindow, payload: RunExit): void {
  exit(win, payload)
}

export function trackProcess(id: string, child: ChildProcess): void {
  active.set(id, { child, startedAt: performance.now() })
}

export function untrackProcess(id: string): void {
  active.delete(id)
}

export function sendInput(id: string, data: string): void {
  const run = active.get(id)
  run?.child.stdin?.write(data)
}

export function killAll(): void {
  for (const controller of pending.values()) controller.abort()
  // Tree kill here too: quitting the app must not leave a `cargo run` child
  // running on the user's machine.
  for (const [, run] of active) killTree(run.child)
  active.clear()
}
