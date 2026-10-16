/**
 * Catalog and pure logic for native libraries a host C/C++ or Python program
 * links against (OpenCV, raylib, ...). Cortex derives everything a build needs
 * from this: which library a source file uses, how to install it, and the exact
 * compiler flags. The project never supplies flags; at most it names a library,
 * so a cloned repo cannot steer the compiler (see docs/PROJECT-CONFIG.md).
 *
 * Add a library by adding one entry to NATIVE_LIBS. Everything else is data-driven.
 */

export interface NativeLib {
  id: string
  name: string
  /** One line on what it is for, shown beside the install button. */
  blurb: string
  /** A C/C++ `#include` path prefix or exact header that implies this library. */
  headers: readonly string[]
  /** The pkg-config module that reports the real include/link flags. */
  pkgConfig: string
  /** MSYS2 package suffix; the full name is `mingw-w64-<env>-x86_64-<suffix>`. */
  msys2: string
  brew?: string
  apt?: string
  /** PyPI package and the module name Python code imports. */
  pip?: { package: string; imports: readonly string[] }
}

export const NATIVE_LIBS: readonly NativeLib[] = [
  {
    id: 'opencv',
    name: 'OpenCV',
    blurb: 'Computer vision: images, video, camera, feature detection',
    headers: ['opencv2/'],
    pkgConfig: 'opencv4',
    msys2: 'opencv',
    brew: 'opencv',
    apt: 'libopencv-dev',
    pip: { package: 'opencv-python', imports: ['cv2'] }
  },
  {
    id: 'raylib',
    name: 'raylib',
    blurb: 'Simple 2D/3D game and graphics library',
    headers: ['raylib.h', 'raymath.h', 'rlgl.h'],
    pkgConfig: 'raylib',
    msys2: 'raylib',
    brew: 'raylib',
    pip: { package: 'raylib', imports: ['raylib', 'pyray'] }
  },
  {
    id: 'sdl2',
    name: 'SDL2',
    blurb: 'Windowing, input, audio and 2D rendering',
    headers: ['SDL2/', 'SDL.h'],
    pkgConfig: 'sdl2',
    msys2: 'SDL2',
    brew: 'sdl2',
    apt: 'libsdl2-dev'
  },
  {
    id: 'glfw',
    name: 'GLFW',
    blurb: 'OpenGL window and input handling',
    headers: ['GLFW/'],
    pkgConfig: 'glfw3',
    msys2: 'glfw',
    brew: 'glfw',
    apt: 'libglfw3-dev',
    pip: { package: 'glfw', imports: ['glfw'] }
  }
]

export interface NativeLibStatus {
  id: string
  name: string
  blurb: string
  /** Whether the active C++ toolchain can see it. */
  installed: boolean
  /** Whether the chosen Python interpreter can import it; null when it has no Python package. */
  python: boolean | null
  /** How Cortex will install it for C++, or why it cannot. */
  install: { kind: 'msys2'; package: string } | { kind: 'manual'; reason: string }
}

export interface NativeLibQuery {
  pythonPath?: string
  projectPython?: string
  cwd?: string
}

export interface NativeLibInstallRequest extends NativeLibQuery {
  id: string
  libId: string
  target: 'cpp' | 'python'
}

export function libById(id: string): NativeLib | undefined {
  return NATIVE_LIBS.find((l) => l.id === id)
}

const INCLUDE = /^[ \t]*#[ \t]*include[ \t]*[<"]([^>"\n]+)[>"]/gm

/** The catalog library a header belongs to, or undefined. Pure. */
export function libForHeader(header: string): NativeLib | undefined {
  return NATIVE_LIBS.find((lib) => lib.headers.some((h) => (h.endsWith('/') ? header.startsWith(h) : header === h)))
}

/** Libraries a C/C++ source implies, from its `#include` lines. Pure. */
export function libsForCppSource(source: string): NativeLib[] {
  const found = new Set<string>()
  for (const m of source.matchAll(INCLUDE)) {
    const lib = libForHeader(m[1].trim())
    if (lib) found.add(lib.id)
  }
  return NATIVE_LIBS.filter((l) => found.has(l.id))
}

/**
 * The library a compiler/analyzer diagnostic is about, and which side to install
 * it for: clangd's "'opencv2/opencv.hpp' file not found" (C++) or pyright's
 * 'Import "cv2" could not be resolved' (Python). Null for anything else. Pure.
 */
export function libForDiagnostic(message: string): { lib: NativeLib; target: 'cpp' | 'python' } | null {
  const header = /^'([^']+)' file not found/.exec(message)?.[1] ?? /^([^:\r\n]+): No such file or directory/.exec(message)?.[1]
  if (header) {
    const lib = libForHeader(header)
    return lib ? { lib, target: 'cpp' } : null
  }
  const mod = /^Import "([A-Za-z_][\w]*)(?:\.[\w.]*)?" could not be resolved/.exec(message)?.[1]
  if (mod) {
    const lib = NATIVE_LIBS.find((l) => l.pip?.imports.includes(mod))
    return lib ? { lib, target: 'python' } : null
  }
  return null
}

const PY_IMPORT = /^[ \t]*(?:import|from)[ \t]+([A-Za-z_][\w]*)/gm

/** Libraries a Python source implies, from its top-level `import`/`from` lines. Pure. */
export function libsForPythonSource(source: string): NativeLib[] {
  const modules = new Set<string>()
  for (const m of source.matchAll(PY_IMPORT)) modules.add(m[1])
  return NATIVE_LIBS.filter((l) => l.pip?.imports.some((i) => modules.has(i)))
}

/**
 * The compiler/linker flags worth trusting from a `pkg-config --cflags --libs`
 * report: include dirs, library dirs, library names and plain defines. Anything
 * else (`-Wl,`, `-specs=`, `-fplugin=`, `@file`, ...) is dropped, so a hostile or
 * broken .pc file cannot widen what the compiler is told to do. Pure.
 */
export function parsePkgConfigFlags(output: string): string[] {
  const keep: string[] = []
  for (const tok of output.split(/\s+/).filter(Boolean)) {
    if (/^-I\S+$/.test(tok) || /^-L\S+$/.test(tok) || /^-l[\w+.-]+$/.test(tok) || /^-D\w+(=\S*)?$/.test(tok)) keep.push(tok)
    else if (tok === '-pthread') keep.push(tok)
  }
  return keep
}

/** The MSYS2 environments a MinGW compiler can come from, and their package prefixes. */
export const MSYS2_ENVS: Record<string, string> = {
  ucrt64: 'mingw-w64-ucrt-x86_64',
  mingw64: 'mingw-w64-x86_64',
  clang64: 'mingw-w64-clang-x86_64'
}

/**
 * Which MSYS2 environment (and its root) a compiler binary belongs to, e.g.
 * `C:/msys64/ucrt64/bin/g++.exe` -> { root: 'C:/msys64', env: 'ucrt64' }. The
 * packages must come from the SAME environment as the compiler or the ABIs
 * differ and linking fails. Null for any other compiler. Pure.
 */
export function msys2EnvOf(compilerPath: string): { root: string; env: string } | null {
  const p = compilerPath.replace(/\\/g, '/')
  const m = /^(.*?)\/(ucrt64|mingw64|clang64)\/bin\/[^/]+$/i.exec(p)
  return m ? { root: m[1], env: m[2].toLowerCase() } : null
}

export function msys2PackageName(lib: NativeLib, env: string): string | null {
  const prefix = MSYS2_ENVS[env]
  return prefix ? `${prefix}-${lib.msys2}` : null
}

/** The shell command a person would run on this OS, for the platforms Cortex does not install for. */
export function manualInstallCommand(lib: NativeLib, os: 'windows' | 'mac' | 'linux'): string | null {
  if (os === 'mac') return lib.brew ? `brew install ${lib.brew}` : null
  if (os === 'linux') return lib.apt ? `sudo apt install ${lib.apt}` : null
  return null
}
