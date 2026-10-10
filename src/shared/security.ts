import { cppDriver } from './languages'

/**
 * Security helpers shared by the main-process services. Pure and testable.
 *
 * The renderer supplies the compiler/interpreter command (toolbar selection,
 * settings) and file paths. A compromised or buggy renderer must not be able to
 * spawn arbitrary executables or touch files outside the open workspace, so we
 * validate both here.
 */

/** Executables Cortex is allowed to launch (matched by base name, no extension). */
const ALLOWED_COMMANDS = new Set([
  'g++',
  'gcc',
  'clang++',
  'clang',
  'arm-none-eabi-g++',
  'arm-none-eabi-gcc',
  'avr-g++',
  'avr-gcc',
  'rustc',
  'cargo',
  'python',
  'python3',
  'node',
  'arduino-cli',
  'pio',
  // Windows process-tree kill, used to stop a run and everything it started.
  'taskkill',
  // Language servers (LSP).
  'clangd',
  'pyright-langserver',
  'rust-analyzer'
])

/** Base name of a command path, without a Windows .exe/.cmd/.bat suffix. */
export function commandBaseName(cmd: string): string {
  const base = cmd.replace(/\\/g, '/').split('/').pop() || cmd
  return base.replace(/\.(exe|cmd|bat|com)$/i, '')
}

export function isAllowedCommand(cmd: string): boolean {
  if (!cmd) return false
  return ALLOWED_COMMANDS.has(commandBaseName(cmd))
}

/**
 * True when `cmd` is a bare command name (no path separator), the only form an
 * UNTRUSTED source may supply. isAllowedCommand matches on base name only, so a
 * path like `C:/evil/g++.exe` would pass it while running an arbitrary binary;
 * requiring a bare name (resolved via PATH) closes that. A trusted absolute
 * compiler path belongs in app settings, never in a workspace's config file.
 */
export function isBareCommand(cmd: string): boolean {
  return !!cmd && !/[\\/]/.test(cmd)
}

/** Optimization levels Cortex will pass through. Anything else is a flag. */
// '-O' is here because it is a real GCC level (an alias for -O1) AND because
// the Rust build-profile dropdown used to persist exactly that string into
// .cortex/config.json; rejecting it would silently downgrade an existing
// project's C++ build to -O0.
export const OPT_LEVELS = ['-O', '-O0', '-O1', '-O2', '-O3', '-Os', '-Ofast', '-Og']

/**
 * Extra compiler flags a project may carry in .cortex/config.json.
 *
 * That file travels with a cloned repo, and its contents are splatted onto a
 * gcc/g++ command line. Several driver flags are compile-time code execution or
 * redirect the build somewhere else entirely:
 *
 *   -fplugin=./x.so   loads a repo-supplied shared object into the compiler
 *   -B.               points the driver at a repo-local as/ld/cc1
 *   -specs=./evil     rewrites the whole driver spec
 *   @file             reads more arguments from a repo file
 *   -o <path>         a second -o wins, so the executable lands anywhere
 *   -Wl,...           hands arbitrary options to the linker
 *   a bare filename   adds another translation unit to the build
 *
 * So this is an allowlist of NAMED FLAGS, not a blocklist and not open prefixes:
 * an argument has to be one whose whole purpose is describing this translation
 * unit (defines, include/library search, warnings, target/codegen tuning).
 * A rejected argument is reported, never silently dropped.
 *
 * Named, because a prefix rule like /^-f(?!plugin)./ blocks the spelling you
 * thought of and nothing else: it still admitted clang's -fpass-plugin=<dso>
 * (the same dlopen-into-the-compiler primitive under another name) and the whole
 * -fdump-*=<path> / -ftime-trace=<path> family, each writing a file anywhere on
 * disk. Enumerating what is allowed means a rename cannot walk through again.
 */
const EXTRA_ARG_ALLOWED: RegExp[] = [
  // Preprocessor
  /^-D[A-Za-z_]\w*(=.*)?$/,
  /^-U[A-Za-z_]\w*$/,
  // Spaces are legal here: 'C:/Program Files/x/include' is an ordinary path.
  // The dangerous forms are handled above (UNC, URL, response file).
  /^-[IL].+$/,
  // Linking. -l takes a library NAME, so no '=' and no path separators.
  /^-l[\w.+-]+$/,
  /^-(pthread|nostdlib|static|static-libgcc|static-libstdc\+\+)$/,
  // Warnings. The comma is what makes -Wl,<linker opt> and -Wa,<asm opt> pass
  // arbitrary options to another tool, so it is not in the character class.
  /^-W[\w-]+(=[\w-]+)?$/,
  // Target and codegen
  /^-m(32|64|avx|avx2|sse|sse2|sse3|sse4|fma|popcnt|fpmath=\w+)$/,
  /^-m(arch|tune|cpu|fpu|float-abi)=[\w.+-]+$/,
  /^-f(no-)?(exceptions|rtti|openmp|PIC|PIE|pic|pie|fast-math|inline|unroll-loops|strict-aliasing|omit-frame-pointer|permissive|signed-char|unsigned-char|short-enums|threadsafe-statics|char8_t|coroutines|stack-protector|stack-protector-all|stack-protector-strong)$/,
  /^-fsanitize=[\w,+-]+$/,
  /^-fvisibility=(default|hidden|internal|protected)$/,
  /^-std=[\w+]+$/,
  /^-g[0-3]?$/
]

/** Flags whose VALUE is the next argv token: `-I include`, not `-Iinclude`. */
const VALUE_FLAGS = new Set(['-D', '-U', '-I', '-L', '-isystem', '-include'])

/**
 * A path that would make the compiler reach off this machine. On Windows the
 * driver stat()s every -I directory, so a UNC value makes the SMB client connect
 * outbound and authenticate to whoever the repo names, and lets an attacker's
 * share substitute the headers being reviewed.
 */
function isReachableOffHost(value: string): boolean {
  return /^(\\\\|\/\/)/.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
}

export function isAllowedExtraArg(arg: string): boolean {
  if (typeof arg !== 'string' || !arg) return false
  const value = arg.replace(/^-[IL]/, '')
  if (isReachableOffHost(value)) return false
  // `-I@file` is expanded by the driver as a response file before it is ever
  // read as an include path, so it is argv injection wearing an -I prefix.
  if (value.startsWith('@')) return false
  return EXTRA_ARG_ALLOWED.some((re) => re.test(arg))
}

/**
 * Partition project extraArgs into the ones we will pass and the ones we will
 * not. Value-consuming flags are handled as PAIRS, which does two things at
 * once: it accepts the separated spellings gcc has always taken (`-I include`),
 * which the old per-token rule rejected and then mislabelled as an attack; and
 * it means any flag NOT on that list cannot smuggle a value through its
 * successor, which is how `-mllvm -load=./pwn.so` got in.
 */
export function sanitizeExtraArgs(args: unknown): { kept: string[]; dropped: string[] } {
  if (!Array.isArray(args)) return { kept: [], dropped: [] }
  const kept: string[] = []
  const dropped: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (typeof a !== 'string') {
      dropped.push(String(a))
      continue
    }
    if (VALUE_FLAGS.has(a)) {
      const value = args[i + 1]
      // The value must be a plain token: not another flag, not off-host, and
      // NOT a response file. Both drivers expand `@file` over the whole argv
      // before parsing options, so they never learn the token was meant as -I's
      // operand - it splices the file's contents in as real arguments, which
      // re-admits -fplugin=, -B, -specs= and -o. The one character that turns a
      // path into arbitrary argv.
      if (
        typeof value === 'string' &&
        value &&
        !value.startsWith('-') &&
        !value.startsWith('@') &&
        !isReachableOffHost(value)
      ) {
        kept.push(a, value)
        i++
      } else {
        dropped.push(a)
      }
      continue
    }
    if (isAllowedExtraArg(a)) kept.push(a)
    else dropped.push(a)
  }
  return { kept, dropped }
}

/** Host C++ compilers: the ones that can build and run code on this machine. */
const HOST_CPP = new Set(['g++', 'clang++'])

/**
 * True when `cmd` builds executables that run on THIS machine, which is what
 * the simulator needs. avr-g++ and arm-none-eabi-g++ are allowlisted and are
 * genuinely C++, but they emit firmware for a chip, so they cannot run a sketch
 * here.
 *
 * Shared because three files disagreed about what "C++ is available" meant: the
 * toolchain probe called the cross-compilers `kind: 'cpp'`, the store's guard
 * trusted that and skipped its install-a-compiler remedy, and simService knew
 * better and silently substituted a g++ that was not there. The user got
 * "spawn g++ ENOENT" while the Toolchains panel showed a green check under
 * "C / C++".
 */
export function isHostCpp(cmd: string): boolean {
  if (!cmd) return false
  return isAllowedCommand(cmd) && HOST_CPP.has(commandBaseName(cmd))
}

/**
 * A project-supplied compiler normalized to its canonical HOST C++ driver, or
 * undefined when it is not one. Shared because two places read the same
 * untrusted field independently - the build path and the `.clangd` writer - and
 * when only one of them normalized, clangd analysed the code with a different
 * toolchain than the one that compiled it.
 */
export function hostCppOrNull(cmd: string | undefined): string | undefined {
  if (!cmd) return undefined
  const canonical = cppDriver(cmd)
  return isHostCpp(canonical) ? canonical : undefined
}

/**
 * True when `target` resolves to a location at or under `root`. Pure string
 * logic (POSIX and Windows separators) so it can be unit tested; the main
 * process pairs it with path.resolve for the real check.
 */
export function isWithin(root: string, target: string): boolean {
  const windows = /^[a-z]:[\\/]/i.test(root) || /^(\\\\|\/\/)/.test(root)
  const norm = (p: string): string => {
    const path = (windows ? p.replace(/\\/g, '/') : p).replace(/\/+$/, '')
    return windows ? path.toLowerCase() : path
  }
  const r = norm(root)
  const t = norm(target)
  return t === r || t.startsWith(r + '/')
}
