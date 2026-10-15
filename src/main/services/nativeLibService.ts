import { spawn, execFile, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import * as runner from './runnerService'
import { safeCommand } from './commandResolver'
import { getWorkspaceRoot } from './fsService'
import { invalidateNativeFlags, nativeLibStatuses, resolveNativeToolchain } from './nativeLibFlags'
import {
  libById,
  manualInstallCommand,
  msys2PackageName,
  NATIVE_LIBS,
  type NativeLibInstallRequest,
  type NativeLibQuery,
  type NativeLibStatus
} from '../../shared/nativeLibs'

/**
 * Installs native libraries through the package manager that owns the toolchain:
 * MSYS2's pacman for a MinGW g++ on Windows, pip for Python. The set of things
 * that can be installed is the catalog in shared/nativeLibs.ts: a request names a
 * library id, never a package or a command, so nothing a renderer or repo sends
 * can reach the shell.
 */

const OS = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'

function finish(win: BrowserWindow, id: string, code: number, start: number): number {
  runner.sendRunExit(win, { id, code, signal: null, durationMs: Math.round(performance.now() - start), phase: 'run' })
  return code
}

/** Run one trusted command, streaming its output to the Output panel. Resolves with its exit code. */
function streamCommand(win: BrowserWindow, id: string, bin: string, args: string[], label: string): Promise<number> {
  const start = performance.now()
  runner.sendRunOutput(win, id, 'system', `$ ${label}\n`)
  return new Promise((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawn(bin, args, { windowsHide: true })
    } catch (err) {
      runner.sendRunOutput(win, id, 'stderr', `Failed to launch: ${String(err)}\n`)
      resolve(finish(win, id, 127, start))
      return
    }
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdin?.on('error', () => {})
    runner.trackProcess(id, proc)
    proc.stdout?.on('data', (d) => runner.sendRunOutput(win, id, 'stdout', String(d)))
    // pacman and pip both report progress on stderr; it is normal output.
    proc.stderr?.on('data', (d) => runner.sendRunOutput(win, id, 'stdout', String(d)))
    proc.on('error', (err) => runner.sendRunOutput(win, id, 'stderr', `${String(err)}\n`))
    proc.on('close', (code) => {
      runner.untrackProcess(id, proc)
      if (code === 0) runner.sendRunOutput(win, id, 'system', `Done in ${Math.round(performance.now() - start)}ms\n`)
      invalidateNativeFlags()
      resolve(finish(win, id, code ?? 1, start))
    })
  })
}

export async function installNativeLib(win: BrowserWindow, req: NativeLibInstallRequest): Promise<number> {
  const start = performance.now()
  const lib = libById(req.libId)
  if (!lib || (req.target !== 'cpp' && req.target !== 'python')) {
    runner.sendRunOutput(win, req.id, 'stderr', 'Unknown library.\n')
    return finish(win, req.id, 2, start)
  }

  if (req.target === 'python') {
    if (!lib.pip) {
      runner.sendRunOutput(win, req.id, 'stderr', `${lib.name} has no Python package in Cortex's catalog.\n`)
      return finish(win, req.id, 2, start)
    }
    const { py } = runner.pickPythonInterpreter({ pythonPath: req.pythonPath, projectPython: req.projectPython, cwd: req.cwd || getWorkspaceRoot() || '.' })
    const bin = safeCommand(py, getWorkspaceRoot())
    if (!bin) {
      runner.sendRunOutput(win, req.id, 'stderr', 'Python was not found. Install Python or choose an interpreter in Settings.\n')
      return finish(win, req.id, 127, start)
    }
    return streamCommand(win, req.id, bin, ['-m', 'pip', 'install', lib.pip.package], `python -m pip install ${lib.pip.package}`)
  }

  const tc = resolveNativeToolchain()
  const pkg = tc.msys ? msys2PackageName(lib, tc.msys.env) : null
  const bash = tc.msys ? join(tc.msys.root, 'usr', 'bin', 'bash.exe') : null
  if (!tc.msys || !pkg || !bash || !existsSync(bash)) {
    const cmd = manualInstallCommand(lib, OS)
    runner.sendRunOutput(
      win,
      req.id,
      'stderr',
      cmd
        ? `Cortex cannot install ${lib.name} automatically on this system. Run this in a terminal, then try again:\n  ${cmd}\n`
        : tc.compiler
          ? `Cortex installs libraries through MSYS2 on Windows, and this compiler (${tc.compiler}) is not from MSYS2. Install the MSYS2 g++ toolchain first.\n`
          : 'No C++ compiler was found. Install one first (Cortex shows how on the first run).\n'
    )
    return finish(win, req.id, 1, start)
  }
  // pkgconf comes along because it is how Cortex learns the library's flags.
  const pkgconf = msys2PackageName({ ...lib, msys2: 'pkgconf' }, tc.msys.env)
  const names = [pkgconf, pkg].filter((n): n is string => !!n).join(' ')
  return streamCommand(win, req.id, bash, ['-lc', `pacman -S --noconfirm --needed ${names}`], `pacman -S --needed ${names}`)
}

/** Which catalog libraries the given Python interpreter can import. */
export async function pythonLibStatuses(opts: NativeLibQuery): Promise<Record<string, boolean>> {
  const { py } = runner.pickPythonInterpreter({ ...opts, cwd: opts.cwd || getWorkspaceRoot() || '.' })
  const bin = safeCommand(py, getWorkspaceRoot())
  const result: Record<string, boolean> = {}
  for (const lib of NATIVE_LIBS) if (lib.pip) result[lib.id] = false
  if (!bin) return result
  await Promise.all(
    NATIVE_LIBS.filter((l) => l.pip).map(
      (lib) =>
        new Promise<void>((done) => {
          // Fixed module name from the catalog, run with isolated mode so a
          // sitecustomize/cwd module in the project cannot answer for the import.
          execFile(bin, ['-I', '-c', `import ${lib.pip!.imports[0]}`], { windowsHide: true, timeout: 15000 }, (err) => {
            result[lib.id] = !err
            done()
          })
        })
    )
  )
  return result
}

/** The catalog with C++ and Python install state, for the Libraries settings. */
export async function nativeLibOverview(opts: NativeLibQuery): Promise<NativeLibStatus[]> {
  const [cpp, py] = await Promise.all([nativeLibStatuses(), pythonLibStatuses(opts)])
  return cpp.map((c) => ({ ...c, python: libById(c.id)?.pip ? (py[c.id] ?? false) : null }))
}
