import { existsSync, statSync } from 'fs'
import { homedir } from 'os'
import { delimiter, isAbsolute, join, normalize, resolve } from 'path'
import { isBareCommand } from '../../shared/security'

/**
 * Resolve a command to an absolute executable path BEFORE spawning it.
 *
 * The whole command-trust model rested on "a bare name is safe, because it is
 * resolved via PATH". On Windows that is false for the runtime this app ships:
 * libuv's process spawn searches the CHILD'S WORKING DIRECTORY before it scans
 * PATH. Every spawn here runs with a cwd inside the user's project - the runner
 * uses the file's directory, the LSP uses the workspace root - so a repository
 * containing `main.py` next to a malicious `python.exe` executed that binary the
 * moment the user pressed Run. No config file, no setting, no prompt.
 *
 * Verified on this machine against electron 33's libuv: a planted
 * `<repo>/python.exe` ran in place of the real interpreter.
 *
 * Setting NoDefaultCurrentDirectoryInExePath in the child's environment does not
 * help, because the search happens in the parent. The fix is to do the lookup
 * ourselves, from PATH only, and hand spawn an absolute path.
 */

const IS_WIN = process.platform === 'win32'

/**
 * Windows executable extensions, in the order the shell would try them.
 *
 * `cmd` decides whether the bare (no-extension) form belongs at the front or
 * not at all. An npm-installed tool (pyright, notably) puts BOTH a `.cmd`
 * shim AND a bare, extensionless POSIX shell shim in the same PATH directory
 * (for Git-Bash/WSL). Trying '' first, unconditionally, matched that POSIX
 * shim ahead of the real `.cmd` - a file Windows cannot execute at all, so
 * the spawn failed instantly rather than the tool ever running. '' only
 * belongs first when the caller already named an extension explicitly (e.g.
 * "clangd.exe"): then it is cmd matching itself, not a wrong file winning a
 * bare-name race.
 */
function extensions(cmd: string): string[] {
  if (!IS_WIN) return ['']
  const pathext = process.env['PATHEXT'] || '.COM;.EXE;.BAT;.CMD'
  // Lowercased: PATHEXT is conventionally uppercase, the filesystem is
  // case-insensitive either way, and 'python.EXE' in the Output panel's command
  // line looks like a bug.
  const exts = pathext.split(';').filter(Boolean).map((e) => e.toLowerCase())
  if (exts.some((e) => cmd.toLowerCase().endsWith(e))) return ['']
  return exts
}

function isExecutableFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Look `cmd` up in PATH and return an absolute path, or null when it is not
 * found. Only PATH is consulted: never the cwd, and never a relative entry in
 * PATH (an attacker-influenced relative entry would reintroduce the same hole).
 */
export function resolveOnPath(cmd: string): string | null {
  const search = (): string | null => {
    const dirs = (process.env['PATH'] || '').split(delimiter).filter((d) => d && isAbsolute(d))
    for (const dir of dirs) {
      for (const ext of extensions(cmd)) {
        const candidate = join(dir, cmd + ext)
        if (isExecutableFile(candidate)) return candidate
      }
    }
    return null
  }
  const found = search()
  if (found) return found
  // A toolchain installed after Cortex started (or installed without touching
  // PATH, as MSYS2's pacman does) is invisible to this process's frozen PATH.
  // Only for toolchain commands: MSYS2 also ships python, node and others, and
  // silently substituting those for a missing interpreter would be a surprise.
  if (!TOOLCHAIN_COMMANDS.has(cmd.toLowerCase().replace(/\.exe$/, ''))) return null
  return addKnownToolDirs() ? search() : null
}

/** Commands found in the known tool directories (compilers, PlatformIO) when they are not on PATH. */
const TOOLCHAIN_COMMANDS = new Set([
  'g++',
  'gcc',
  'c++',
  'cc',
  'clang',
  'clang++',
  'gdb',
  'make',
  'mingw32-make',
  'pkg-config',
  'pkgconf',
  'pio',
  'platformio'
])

/**
 * Where Windows toolchain installers put compilers without adding them to PATH.
 * Fixed, absolute, system-level locations only: never anything under the
 * workspace, so this cannot reintroduce the planted-binary hole above.
 */
const KNOWN_WIN_TOOL_DIRS = ['C:/msys64/ucrt64/bin', 'C:/msys64/mingw64/bin', 'C:/msys64/clang64/bin']

/**
 * Append any existing known toolchain directory missing from this process's PATH.
 * Appended (never prepended) so anything the user already put on PATH still wins,
 * and set on process.env so every child inherits it: a MinGW g++ cannot start its
 * own cc1plus, and a program it built cannot start, without its bin directory on
 * PATH. Returns true when PATH changed.
 */
export function addKnownToolDirs(): boolean {
  const key = (d: string): string => normalize(d).replace(/[\\/]+$/, '').toLowerCase()
  const have = new Set((process.env['PATH'] || '').split(delimiter).filter(Boolean).map(key))
  // PlatformIO's own installer and the VS Code extension keep `pio` in its private
  // virtualenv under the user's home without putting it on PATH. Every platform.
  const pioBin = join(homedir(), '.platformio', 'penv', IS_WIN ? 'Scripts' : 'bin')
  const candidates = [...(IS_WIN ? KNOWN_WIN_TOOL_DIRS : []), pioBin]
  const add = candidates.map((d) => normalize(d)).filter((d) => !have.has(key(d)) && existsSync(d))
  if (add.length === 0) return false
  process.env['PATH'] = [process.env['PATH'] || '', ...add].filter(Boolean).join(delimiter)
  return true
}

/**
 * The command to hand to spawn/execFile, or null when it cannot be run safely.
 *
 * - A **bare name** is resolved against PATH, so the cwd can never win. This is
 *   the whole point: it is the only form whose meaning the cwd could change.
 * - An **absolute path** passes through. Callers already gate those on their own
 *   terms, and two legitimate ones deliberately live inside the workspace: the
 *   executable Cortex just built into `.cortex/build`, and a project's venv
 *   interpreter. Refusing in-workspace absolutes here would break both.
 * - A **relative path** is refused. It resolves against the project and there is
 *   no reading of it we can defend.
 *
 * `unsafeRoot` is a defence in depth on the PATH lookup itself: if PATH somehow
 * contains a directory inside the open project, a hit there is refused.
 *
 * Returning null rather than throwing lets each caller report the failure in the
 * way its own surface already does (install hints, debug state, silence).
 */
export function safeCommand(cmd: string, unsafeRoot?: string | null): string | null {
  if (!cmd) return null
  if (isAbsolute(cmd)) return cmd
  if (!isBareCommand(cmd)) return null
  const found = resolveOnPath(cmd)
  // NOT-FOUND MUST STILL BE null. Handing the bare name back to spawn moves the
  // lookup straight back into libuv, which searches the child's cwd first - so
  // the fallback restored the exact hole this file exists to close, on precisely
  // the machines a drive-by targets: the ones missing the tool the repo needs.
  // Callers distinguish "not installed" from "refused" with commandMissing().
  if (!found) return null
  return withinRoot(found, unsafeRoot) ? null : found
}

/**
 * True when `cmd` is simply not installed, as opposed to refused. Lets a caller
 * keep its "install this tool" message instead of reporting a security refusal
 * for a machine that just does not have the toolchain.
 */
export function commandMissing(cmd: string): boolean {
  return isBareCommand(cmd) && resolveOnPath(cmd) === null
}

/**
 * True when a `safeCommand`-resolved binary needs a shell to actually launch.
 * CreateProcess cannot execute a .bat/.cmd directly (only cmd.exe can), so an
 * npm-installed tool - its Windows shim is always a .cmd, never a .exe - passes
 * resolveOnPath's isExecutableFile check yet fails (or silently does nothing)
 * at spawn() without this. clangd, gdb, host compilers and arduino-cli all ship
 * as a real .exe and never need it; pyright, being an npm package, does.
 */
export function needsShell(bin: string): boolean {
  return IS_WIN && /\.(cmd|bat)$/i.test(bin)
}

/** True when `p` sits at or under `root`. Case-insensitive on Windows. */
function withinRoot(p: string, root?: string | null): boolean {
  if (!root) return false
  const norm = (x: string): string => {
    const s = resolve(x).replace(/\\/g, '/').replace(/\/+$/, '')
    return IS_WIN ? s.toLowerCase() : s
  }
  const r = norm(root)
  const t = norm(p)
  return t === r || t.startsWith(r + '/')
}
