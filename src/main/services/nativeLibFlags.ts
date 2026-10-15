import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { safeCommand } from './commandResolver'
import { getWorkspaceRoot } from './fsService'
import { NATIVE_LIBS, msys2EnvOf, msys2PackageName, parsePkgConfigFlags, type NativeLib, type NativeLibStatus } from '../../shared/nativeLibs'

/**
 * Asks the build's own package manager where a native library lives, so Cortex
 * can hand the compiler the real flags. Nothing here reads the project: the
 * answer comes from pkg-config over what is actually installed on this machine.
 *
 * On Windows the compiler comes from an MSYS2 environment (ucrt64, mingw64,
 * clang64) and libraries must come from the SAME one, so everything is keyed off
 * where the resolved compiler lives. Anywhere else, pkg-config on PATH is used.
 */

export interface NativeToolchain {
  /** The resolved host compiler, or null when none was found. */
  compiler: string | null
  msys: { root: string; env: string } | null
  /** The pkg-config-compatible binary, or null when none is available. */
  pkgConfig: string | null
}

export function resolveNativeToolchain(compiler = 'g++'): NativeToolchain {
  const bin = safeCommand(compiler, getWorkspaceRoot())
  const msys = bin ? msys2EnvOf(bin) : null
  let pkg: string | null = null
  if (msys) {
    for (const name of ['pkgconf.exe', 'pkg-config.exe']) {
      const p = join(msys.root, msys.env, 'bin', name)
      if (existsSync(p)) {
        pkg = p
        break
      }
    }
  } else {
    pkg = safeCommand('pkg-config', getWorkspaceRoot()) || safeCommand('pkgconf', getWorkspaceRoot())
  }
  return { compiler: bin, msys, pkgConfig: pkg }
}

function run(bin: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { windowsHide: true, timeout: 8000, maxBuffer: 1 << 20 }, (err, stdout) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? (err as unknown as { code: number }).code : 1) : 0
      resolve({ code, stdout: String(stdout ?? '') })
    })
  })
}

// Only a successful answer is cached: a library installed a moment later must be
// found by the very next build, so a miss is always re-asked.
const hits = new Map<string, string[]>()

export function invalidateNativeFlags(): void {
  hits.clear()
}

/** pkg-config flags for one library, or null when it is not installed. */
export async function nativeLibFlags(tc: NativeToolchain, lib: NativeLib): Promise<string[] | null> {
  if (!tc.pkgConfig) return null
  const key = `${tc.pkgConfig}|${lib.pkgConfig}`
  const cached = hits.get(key)
  if (cached) return cached
  // -static is NOT requested: the DLLs are found at run time through PATH.
  const { code, stdout } = await run(tc.pkgConfig, ['--cflags', '--libs', lib.pkgConfig])
  if (code !== 0) return null
  const flags = parsePkgConfigFlags(stdout)
  hits.set(key, flags)
  return flags
}

/** Every catalog library and whether the active toolchain can see it. */
export async function nativeLibStatuses(compiler?: string): Promise<Omit<NativeLibStatus, 'python'>[]> {
  const tc = resolveNativeToolchain(compiler)
  return Promise.all(
    NATIVE_LIBS.map(async (lib) => {
      const installed = (await nativeLibFlags(tc, lib)) !== null
      const pkg = tc.msys ? msys2PackageName(lib, tc.msys.env) : null
      const install: NativeLibStatus['install'] = pkg
        ? { kind: 'msys2', package: pkg }
        : {
            kind: 'manual',
            reason: tc.compiler
              ? 'Cortex installs libraries through MSYS2 on Windows. Install the MSYS2 g++ toolchain first.'
              : 'No C++ compiler was found. Install one first.'
          }
      return { id: lib.id, name: lib.name, blurb: lib.blurb, installed, install }
    })
  )
}

/**
 * Compiler/linker flags for the given libraries, plus the ones that are not
 * installed. Library order is preserved because the linker is order-sensitive.
 */
export async function resolveBuildFlags(libs: readonly NativeLib[], compiler?: string): Promise<{ flags: string[]; missing: NativeLib[] }> {
  const tc = resolveNativeToolchain(compiler)
  const flags: string[] = []
  const missing: NativeLib[] = []
  for (const lib of libs) {
    const f = await nativeLibFlags(tc, lib)
    if (f) flags.push(...f)
    else missing.push(lib)
  }
  return { flags, missing }
}

/**
 * Include dirs and defines of every INSTALLED catalog library, for the editor.
 * clangd needs these to resolve `#include <opencv2/opencv.hpp>` even before any
 * build has run. Link flags are not relevant to analysis, so they are dropped.
 */
export async function editorIncludeDirs(compiler?: string): Promise<string[]> {
  const tc = resolveNativeToolchain(compiler)
  const dirs: string[] = []
  for (const lib of NATIVE_LIBS) {
    for (const f of (await nativeLibFlags(tc, lib)) ?? []) if (f.startsWith('-I')) dirs.push(f.slice(2))
  }
  return [...new Set(dirs)]
}
