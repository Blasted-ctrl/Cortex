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
  getCargoBuildOutcome,
  cargoRenderedMessage
} from '../../shared/diagnostics'
import { isAllowedCommand, isBareCommand, commandBaseName, sanitizeExtraArgs, OPT_LEVELS } from '../../shared/security'
import { withinWorkspace, getWorkspaceRoot } from './fsService'
import { libsForCppSource } from '../../shared/nativeLibs'
import { resolveBuildFlags } from './nativeLibFlags'
import { safeCommand, commandMissing, needsShell } from './commandResolver'
import { reserveRunOutput, deliverRunOutput, deliverRunExit, finishRunOutput, acknowledgeRunOutput, disposeRunOutput } from './runOutputDelivery'
import { COMPILER_DIAGNOSTIC_LIMITS, createCompilerDiagnostics, createCompilerRecordStream, type CompilerDiagnosticsResult } from './compilerDiagnostics'

const IS_WIN = platform() === 'win32'

// How long a possible-machine-record partial may be withheld before it is shown
// without claiming it proves compilation succeeded.
const PARTIAL_HOLD_MS = 250

interface ActiveRun {
  child: ChildProcess
  startedAt: number
  window: BrowserWindow
}

const active = new Map<string, ActiveRun>()
// Reserve an ID before any async preparation. Stop/quit must still work while
// no child exists, and a duplicate start must not replace the first child.
const pending = new Map<string, { controller: AbortController; window: BrowserWindow }>()

export function beginRunStart(win: BrowserWindow, id: string): AbortSignal {
  if (active.has(id) || pending.has(id)) throw new Error('This run id is still active or cancelling. Wait for it to stop, then retry the run.')
  reserveRunOutput(win, id)
  const controller = new AbortController()
  pending.set(id, { controller, window: win })
  return controller.signal
}

export function finishRunStart(id: string, signal: AbortSignal): void {
  const reservation = pending.get(id)
  if (reservation?.controller.signal !== signal) return
  pending.delete(id)
  if (!active.has(id)) finishRunOutput(reservation.window, id)
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
  deliverRunOutput(win, id, stream, data)
}

function exit(win: BrowserWindow, payload: RunExit): void {
  deliverRunExit(win, payload)
  if (!pending.has(payload.id) && !active.has(payload.id)) finishRunOutput(win, payload.id)
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

/** Publish a bounded, already cwd-normalized compilation result. */
export function emitCapturedDiagnostics(win: BrowserWindow, id: string, result: CompilerDiagnosticsResult): Diagnostic[] {
  send(win, IPC.RUN_DIAGNOSTICS, { id, ...result })
  return result.diagnostics
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
  // Libraries the source itself asks for (#include <opencv2/...>) get their real
  // flags from the package manager, never from the repo. They follow the
  // project's own flags so a hand-written -l still links in a sensible order.
  const needed = libsForCppSource(await fs.readFile(req.filePath, 'utf8').catch(() => ''))
  const native = needed.length ? await resolveBuildFlags(needed, compiler) : { flags: [], missing: [] }
  args.push(req.filePath, ...kept, ...native.flags, '-o', exePath)
  if (native.missing.length) {
    out(
      win,
      req.id,
      'system',
      `This file uses ${native.missing.map((l) => l.name).join(', ')}, which is not installed. Open Settings > Libraries and press Install (or use the Quick Fix on the #include).
`
    )
  }

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
    active.set(req.id, { child: proc, startedAt: start, window: win })
    // Decode as UTF-8 across chunk boundaries. Without this each Buffer is
    // decoded in isolation, so a multi-byte character split by a pipe read
    // becomes U+FFFD before the line buffer ever sees it - and the raw bytes
    // are gone by then, so no amount of line reassembly can repair it.
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdin?.on('error', () => {})
    const capture = createCompilerDiagnostics({ cwd: req.cwd, format: 'text', ...COMPILER_DIAGNOSTIC_LIMITS })
    proc.stdout?.on('data', (d) => out(win, req.id, 'stdout', d.toString()))
    proc.stderr?.on('data', (d) => {
      const text = d.toString()
      capture.write(text)
      out(win, req.id, 'stderr', text)
    })
    proc.on('error', (err) => {
      out(win, req.id, 'stderr', spawnErrorText(compiler, err))
    })
    proc.on('close', (code, signal) => {
      if (active.get(req.id)?.child === proc) active.delete(req.id)
      const durationMs = elapsed(start)
      // Parse diagnostics on both success (warnings) and failure (errors).
      emitCapturedDiagnostics(win, req.id, capture.finish())
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
    active.set(req.id, { child: proc, startedAt: start, window: win })
    // Decode as UTF-8 across chunk boundaries. Without this each Buffer is
    // decoded in isolation, so a multi-byte character split by a pipe read
    // becomes U+FFFD before the line buffer ever sees it - and the raw bytes
    // are gone by then, so no amount of line reassembly can repair it.
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdin?.on('error', () => {})
    proc.stdout?.on('data', (d) => out(win, req.id, 'stdout', d.toString()))
    let omissionShown = false
    const capture = createCompilerDiagnostics({
      cwd: req.cwd, format: 'rust', ...COMPILER_DIAGNOSTIC_LIMITS,
      onRecord(record) {
        const rendered = renderRustJsonLine(record)
        if (rendered) out(win, req.id, 'stderr', rendered)
      },
      onOmitted(bytes) {
        if (!bytes || omissionShown) return
        omissionShown = true
        out(win, req.id, 'system', 'An oversized compiler record was skipped; diagnostics may be incomplete.\n')
      }
    })
    proc.stderr?.on('data', (d) => capture.write(d.toString()))
    proc.on('error', (err) => out(win, req.id, 'stderr', spawnErrorText('rustc', err)))
    proc.on('close', (code, signal) => {
      if (active.get(req.id)?.child === proc) active.delete(req.id)
      const durationMs = elapsed(start)
      emitCapturedDiagnostics(win, req.id, capture.finish())
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
  /** Rewrite a stdout line for display; return null to hide it entirely.
   * Used to keep cargo's machine records out of the panel while still showing
   * the human text they carry. Side effects (emitting diagnostics) belong here
   * too, so they happen as records arrive rather than at exit. */
  mapStdoutLine?: (line: string) => string | null
  machineCaptureFinished?: () => boolean
  onOmitted?: (bytes: number) => void
  onClose?: (current: boolean) => void
}

function runProcess(
  win: BrowserWindow,
  req: RunRequest,
  command: string,
  args: string[],
  cwd: string,
  opts: RunProcessOpts = {}
): ChildProcess | null {
  out(win, req.id, 'system', `$ ${command} ${args.join(' ')}\n`)
  // The built executable arrives here as an absolute path we produced, but so do
  // `python`, `node` and `cargo` as bare names - and this spawn's cwd is inside
  // the project, which libuv searches before PATH on Windows.
  const commandBin = safeCommand(command, getWorkspaceRoot())
  if (!commandBin) {
    out(win, req.id, 'stderr', `Refusing to run a program from inside the workspace: ${command}\n`)
    opts.onClose?.(true)
    exit(win, { id: req.id, code: 126, signal: null, durationMs: 0, phase: 'run' })
    return null
  }
  const start = performance.now()
  let proc: ChildProcess
  try {
    proc = spawn(commandBin, args, { cwd, windowsHide: true, shell: needsShell(commandBin) })
  } catch (err) {
    out(win, req.id, 'stderr', `Failed to launch '${command}': ${String(err)}\n`)
    opts.onClose?.(true)
    exit(win, { id: req.id, code: 127, signal: null, durationMs: 0, phase: 'run' })
    return null
  }
  active.set(req.id, { child: proc, startedAt: start, window: win })
  // Same reason as the compile paths: decode UTF-8 across chunk boundaries, so
  // the line buffer below reassembles lines out of whole characters.
  proc.stdout?.setEncoding('utf8')
  proc.stderr?.setEncoding('utf8')
  proc.stdin?.on('error', () => {})
  let programLine = false
  let closed = false
  let holdTimer: NodeJS.Timeout | null = null
  const cancelHold = (): void => {
    if (holdTimer) clearTimeout(holdTimer)
    holdTimer = null
  }
  const records = opts.mapStdoutLine ? createCompilerRecordStream({
    ...COMPILER_DIAGNOSTIC_LIMITS,
    onRecord(record, terminated) {
      const line = record.endsWith('\r') ? record.slice(0, -1) : record
      const shown = opts.mapStdoutLine!(line)
      if (shown !== null) out(win, req.id, 'stdout', shown + (terminated ? '\n' : ''))
      if (opts.machineCaptureFinished?.()) return false
    },
    onOmitted(bytes) { opts.onOmitted?.(bytes) }
  }) : null
  const holdExpired = (): void => {
    holdTimer = null
    if (closed || active.get(req.id)?.child !== proc || !records?.partial) return
    // Show the waiting prefix and fence its displayed suffix without parsing
    // fragments or certifying compilation. Account the whole skipped record.
    out(win, req.id, 'stdout', records.partial)
    records.discardPartial()
    programLine = true
  }
  proc.stdout?.on('data', (d) => {
    const text = d.toString()
    if (!records) {
      out(win, req.id, 'stdout', text)
      return
    }
    if (closed || active.get(req.id)?.child !== proc) return
    cancelHold()
    let remaining = text
    // Once a prefix is displayed, its suffix cannot become a
    // standalone machine record just because it starts with JSON syntax.
    if (programLine) {
      const newline = remaining.indexOf('\n')
      const end = newline < 0 ? remaining.length : newline + 1
      out(win, req.id, 'stdout', remaining.slice(0, end))
      if (records.discarding) records.write(remaining.slice(0, end))
      remaining = remaining.slice(end)
      if (newline < 0) return
      programLine = false
    }
    const passthrough = records.write(remaining)
    if (passthrough) {
      out(win, req.id, 'stdout', passthrough)
    }
    if (records.partial && !records.partial.trimStart().startsWith('{')) {
      out(win, req.id, 'stdout', records.takePartial())
      programLine = true
    }
    if (records.partial) holdTimer = setTimeout(holdExpired, PARTIAL_HOLD_MS)
  })
  proc.stderr?.on('data', (d) => out(win, req.id, 'stderr', d.toString()))
  proc.on('error', (err) => out(win, req.id, 'stderr', spawnErrorText(command, err)))
  proc.on('close', (code, signal) => {
    if (closed) return
    closed = true
    const current = active.get(req.id)?.child === proc
    cancelHold()
    if (current) records?.finish()
    opts.onClose?.(current)
    if (current) active.delete(req.id)
    if (current) exit(win, { id: req.id, code, signal, durationMs: elapsed(start), phase: 'run' })
  })
  return proc
}

function reject(win: BrowserWindow, id: string, msg: string): void {
  out(win, id, 'stderr', msg + '\n')
  exit(win, { id, code: 126, signal: null, durationMs: 0, phase: 'compile' })
}

export async function startRun(win: BrowserWindow, req: RunRequest): Promise<void> {
  const cancellation = beginRunStart(win, req.id)
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
        const capture = createCompilerDiagnostics({ cwd: cargoRoot, format: 'cargo', ...COMPILER_DIAGNOSTIC_LIMITS })
        const compileStart = performance.now()
        let inRunPhase = false
        let buildOutcome: boolean | null = null
        const enterRunPhase = (): void => {
          if (inRunPhase || buildOutcome !== true) return
          inRunPhase = true
          exit(win, { id: req.id, code: 0, signal: null, durationMs: elapsed(compileStart), phase: 'compile' })
        }
        let flushQueued = false
        let captureFinished = false
        let retired = false
        let cargoChild: ChildProcess | null = null
        const flushDiagnostics = (): void => {
          if (flushQueued || captureFinished || retired) return
          flushQueued = true
          setImmediate(() => {
            flushQueued = false
            if (!captureFinished && !retired && active.get(req.id)?.child === cargoChild) {
              emitCapturedDiagnostics(win, req.id, capture.snapshot())
            }
          })
        }
        const finishCapture = (): void => {
          if (captureFinished || retired) return
          captureFinished = true
          emitCapturedDiagnostics(win, req.id, capture.finish())
        }
        cargoChild = runProcess(win, req, 'cargo', cargoArgs, cargoRoot, {
          // cargo writes its machine records to STDOUT, interleaved with the
          // program's own output. Show the human text a diagnostic carries, drop
          // the rest (they turn "run my program" into a wall of JSON), and pass
          // the program's own lines through untouched.
          machineCaptureFinished: () => buildOutcome !== null,
          onOmitted(bytes) {
            capture.gap(bytes)
            flushDiagnostics()
          },
          onClose(current) {
            if (current) finishCapture()
            else capture.finish()
            retired = true
          },
          mapStdoutLine: (line) => {
            // After cargo's own build-finished record, nothing further can be a
            // cargo record: cargo emits it last. Continuing to shape-match meant
            // a program that prints cargo-like JSON (a wrapper, or anything
            // forwarding --message-format=json) had those lines DELETED from its
            // output, and a compiler-message-shaped one injected fabricated
            // errors into Problems pointing at paths under the crate root.
            if (buildOutcome !== null) return line
            // Procedural macros can print ordinary text during compilation;
            // only Cargo's successful terminal record proves the run can begin.
            if (!isCargoJsonLine(line)) return line
            capture.record(line)
            const outcome = getCargoBuildOutcome(line)
            if (outcome !== null) {
              buildOutcome = outcome
              finishCapture()
              if (outcome) enterRunPhase()
            } else {
              flushDiagnostics()
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
      const chosen = pickPythonInterpreter(req)
      const py = chosen.py
      if (chosen.ignoredPin) {
        // Say why, rather than silently running a different interpreter than
        // the one the project asked for.
        out(
          win,
          req.id,
          'system',
          `Ignoring the interpreter pinned in .cortex/config.json (${chosen.ignoredPin}): it must be a Python command on PATH, or a path inside this workspace.
`
        )
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

/**
 * The Python interpreter a run (or a package install into it) should use.
 * Two sources with two trust levels: `pythonPath` is an app setting and trusted;
 * `projectPython` comes from the workspace's .cortex/config.json, which travels
 * with a cloned repo, so it is accepted only as a Python command on PATH or a
 * path inside the open workspace (a venv). `ignoredPin` names a pin that was refused.
 */
export function pickPythonInterpreter(req: { pythonPath?: string; projectPython?: unknown; cwd: string }): { py: string; ignoredPin?: string } {
  let py = req.pythonPath || 'python'
  // A cloned repo's config is whatever JSON.parse produced, so this may not be a
  // string at all; isBareCommand string-coerces and commandBaseName then threw.
  const pinned = typeof req.projectPython === 'string' ? req.projectPython : ''
  if (!pinned) return { py }
  // A relative pin (`.venv/Scripts/python.exe`) is relative to the PROJECT; node
  // would resolve it against process.cwd(), so resolve it here once.
  const abs = isBareCommand(pinned) ? pinned : resolve(req.cwd, pinned)
  // Scoped to Python, not the whole spawn allowlist: a repo pinning
  // "pyright-langserver" would otherwise become the interpreter and hang the run.
  const isPython = ['python', 'python3'].includes(commandBaseName(abs))
  if (isPython && isAllowedCommand(abs) && (isBareCommand(abs) || withinWorkspace(abs))) return { py: abs }
  return { py, ignoredPin: pinned }
}

export function stopRun(id: string): void {
  pending.get(id)?.controller.abort()
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
  const reservation = pending.get(id)
  if (reservation) active.set(id, { child, startedAt: performance.now(), window: reservation.window })
}

export function untrackProcess(id: string, child: ChildProcess): void {
  if (active.get(id)?.child === child) active.delete(id)
}

export function sendInput(id: string, data: string): void {
  const run = active.get(id)
  run?.child.stdin?.write(data)
}

export function killAll(): void {
  const windows = new Set([...pending.values(), ...active.values()].map(run => run.window))
  for (const { controller } of pending.values()) controller.abort()
  // Tree kill here too: quitting the app must not leave a `cargo run` child
  // running on the user's machine.
  for (const [, run] of active) killTree(run.child)
  active.clear()
  for (const window of windows) disposeRunOutput(window)
}

export function acknowledgeOutput(win: BrowserWindow, token: unknown): void { acknowledgeRunOutput(win, token) }

export function disposeWindowRuns(win: BrowserWindow): void {
  for (const reservation of pending.values()) if (reservation.window === win) reservation.controller.abort()
  for (const run of active.values()) if (run.window === win) killTree(run.child)
  disposeRunOutput(win)
}
