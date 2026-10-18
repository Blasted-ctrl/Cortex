import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDriverOutput, buildClangdConfig, discoverIncludeDirs, pickPioToolchain, ensureClangdConfig, MARKER } from '../src/main/services/clangdConfig'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), editorIncludeDirs: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))
vi.mock('../src/main/services/nativeLibFlags', () => ({ editorIncludeDirs: mocks.editorIncludeDirs }))
vi.mock('../src/main/services/commandResolver', () => ({
  safeCommand: (command: string) => command,
  needsShell: () => false
}))
vi.mock('../src/main/services/fsService', () => ({ getWorkspaceRoot: () => null }))

const { loadAll } = require('js-yaml') as { loadAll: (text: string) => ConfigFragment[] }
interface ConfigFragment {
  If?: { PathMatch?: string | string[]; PathExclude?: string | string[] }
  CompileFlags?: { Add?: string[]; Remove?: string[]; Compiler?: string; CompilationDatabase?: string }
}

function fragmentsFor(config: string, path: string): ConfigFragment[] {
  const matches = (patterns: string | string[], candidate: string): boolean =>
    (Array.isArray(patterns) ? patterns : [patterns]).some(pattern => new RegExp(`^(?:${pattern})$`).test(candidate))
  return loadAll(config).filter(fragment =>
    (!fragment.If?.PathMatch || matches(fragment.If.PathMatch, path)) &&
    (!fragment.If?.PathExclude || !matches(fragment.If.PathExclude, path)))
}

// A trimmed but representative `g++ -E -xc++ -v -` report (MSYS2 MinGW), with the
// CRLF line endings the driver emits on Windows.
const GXX_V = [
  'Using built-in specs.',
  'Target: x86_64-w64-mingw32',
  'Thread model: posix',
  'ignoring nonexistent directory "D:/a/msys64/mingw64/include"',
  '#include "..." search starts here:',
  '#include <...> search starts here:',
  ' C:/msys64/mingw64/include/c++/14.2.0',
  ' C:/msys64/mingw64/include/c++/14.2.0/x86_64-w64-mingw32',
  ' C:/msys64/mingw64/lib/gcc/x86_64-w64-mingw32/14.2.0/include',
  'End of search list.',
  'COMPILER_PATH=...'
].join('\r\n')

describe('parseDriverOutput', () => {
  it('extracts the target triple', () => {
    expect(parseDriverOutput(GXX_V).target).toBe('x86_64-w64-mingw32')
  })

  it('extracts every system include directory, trimmed', () => {
    expect(parseDriverOutput(GXX_V).includes).toEqual([
      'C:/msys64/mingw64/include/c++/14.2.0',
      'C:/msys64/mingw64/include/c++/14.2.0/x86_64-w64-mingw32',
      'C:/msys64/mingw64/lib/gcc/x86_64-w64-mingw32/14.2.0/include'
    ])
  })

  it('does not include the quoted-search or ignored-directory lines', () => {
    const inc = parseDriverOutput(GXX_V).includes
    expect(inc.some((d) => d.includes('nonexistent'))).toBe(false)
    expect(inc.some((d) => d.includes('search starts here'))).toBe(false)
  })

  it('returns empty when the report has no search block', () => {
    expect(parseDriverOutput('clang version 22\nTarget: none')).toEqual({ target: 'none', includes: [] })
  })

  it('handles LF-only output as well as CRLF', () => {
    expect(parseDriverOutput(GXX_V.replace(/\r\n/g, '\n')).includes).toHaveLength(3)
  })

  it('drops Apple Clang framework-directory lines (not valid -isystem paths)', () => {
    const appleClang = [
      'Target: arm64-apple-darwin23',
      '#include <...> search starts here:',
      ' /usr/local/include',
      ' /Library/Developer/CommandLineTools/usr/include/c++/v1',
      ' /System/Library/Frameworks (framework directory)',
      'End of search list.'
    ].join('\n')
    const inc = parseDriverOutput(appleClang).includes
    expect(inc).toEqual(['/usr/local/include', '/Library/Developer/CommandLineTools/usr/include/c++/v1'])
    expect(inc.some((d) => d.includes('framework directory'))).toBe(false)
  })
})

describe('buildClangdConfig', () => {
  const tc = { target: 'x86_64-w64-mingw32', includes: ['C:/a/inc', 'C:/b/inc'] }
  const cfg = buildClangdConfig(tc, 'c++23')

  it('starts with the Cortex marker so the writer can recognise its own file', () => {
    expect(cfg.startsWith(MARKER)).toBe(true)
  })

  it('adds the target and each include dir as -isystem to the global flags', () => {
    expect(cfg).toContain('"--target=x86_64-w64-mingw32"')
    expect(cfg).toContain('"-isystem"')
    expect(cfg).toContain('"C:/a/inc"')
    expect(cfg).toContain('"C:/b/inc"')
  })

  it('adds project include dirs as -I and library dirs as -isystem', () => {
    const withInc = buildClangdConfig(tc, 'c++23', 'c17', ['C:/proj/src', 'C:/proj/include'], ['C:/proj/.pio/libdeps/env/ESP32Servo/src'])
    // The global fragment is the first YAML doc.
    const globalFrag = withInc.split('\n---\n')[0]
    expect(globalFrag).toContain('"-I"')
    expect(globalFrag).toContain('"C:/proj/src"')
    expect(globalFrag).toContain('"C:/proj/include"')
    // Library dirs use -isystem (warnings off), and the library path appears.
    expect(globalFrag).toContain('"C:/proj/.pio/libdeps/env/ESP32Servo/src"')
    // The library path is preceded by -isystem, not -I.
    const idxLib = globalFrag.indexOf('"C:/proj/.pio/libdeps/env/ESP32Servo/src"')
    const before = globalFrag.slice(0, idxLib)
    expect(before.lastIndexOf('"-isystem"')).toBeGreaterThan(before.lastIndexOf('"-I"'))
  })

  it('scopes the C++ standard to C++ extensions and keeps it off .c files', () => {
    const frags = cfg.split('\n---\n')
    const cppFrag = frags.find((f) => f.includes('cpp|cxx'))
    const cFrag = frags.find((f) => /PathMatch: \[".*\\\\\.c"\]/.test(f))
    // The C++ fragment carries -std=c++23 (a hard error on a C file); the .c
    // fragment carries -std=c17, and the two never mix.
    expect(cppFrag).toBeDefined()
    expect(cppFrag).toContain('"-std=c++23"')
    expect(cppFrag).not.toContain('c17')
    expect(cFrag).toBeDefined()
    expect(cFrag).toContain('"-std=c17"')
    expect(cFrag).not.toContain('c++23')
  })

  it('uses the project C standard, not a hardcoded c17', () => {
    // Pinning c17 meant clangd flagged code the build accepts (and vice versa)
    // on any project whose toolbar C standard was not c17.
    const c99 = buildClangdConfig(tc, 'c++20', 'c99')
    const frags = c99.split('\n---\n')
    const cFrag = frags.find((f) => /PathMatch: \[".*\\\\\.c"\]/.test(f))
    expect(cFrag).toContain('"-std=c99"')
    expect(cFrag).not.toContain('c17')
    expect(frags.find((f) => f.includes('cpp|cxx'))).toContain('"-std=c++20"')
  })

  it('matches a literal .c++ file and drops the dead ipp/tpp/ino entries', () => {
    const cppFrag = cfg.split('\n---\n').find((f) => f.includes('cpp|cxx'))
    // c[+][+] matches ".c++" (a GNU C++ extension langForFile routes to clangd).
    expect(cppFrag).toContain('c[+][+]')
    // These were never routed to clangd by langForFile, so they must not appear.
    expect(cppFrag).not.toContain('ipp')
    expect(cppFrag).not.toContain('tpp')
    expect(cppFrag).not.toContain('ino')
  })

  it('marks the file machine-specific so it is not committed', () => {
    expect(cfg).toContain('do not commit')
  })

  it('never emits an em dash, en dash, or ellipsis (house style)', () => {
    // Built from code points so this file itself stays free of the characters
    // the house-style test forbids (en dash, em dash, ellipsis).
    const forbidden = new RegExp('[' + String.fromCharCode(0x2013, 0x2014, 0x2026) + ']')
    expect(forbidden.test(cfg)).toBe(false)
  })
})

describe('discoverIncludeDirs', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortex-inc-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('finds project include/src as project dirs and libraries as dep dirs', async () => {
    mkdirSync(join(root, 'include'))
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'lib', 'MyLib', 'src'), { recursive: true })
    mkdirSync(join(root, '.pio', 'libdeps', 'esp32dev', 'ESP32Servo', 'src'), { recursive: true })

    const { project, deps } = await discoverIncludeDirs(root)
    const rel = (p: string): string => p.slice(root.length + 1).replace(/\\/g, '/')
    expect(project.map(rel).sort()).toEqual(['include', 'src'])
    const depRel = deps.map(rel)
    expect(depRel).toContain('lib/MyLib')
    expect(depRel).toContain('lib/MyLib/src')
    expect(depRel).toContain('.pio/libdeps/esp32dev/ESP32Servo')
    expect(depRel).toContain('.pio/libdeps/esp32dev/ESP32Servo/src')
  })

  it('returns empty lists for a bare project with no include dirs', async () => {
    const { project, deps } = await discoverIncludeDirs(root)
    expect(project).toEqual([])
    expect(deps).toEqual([])
  })
})

describe('pickPioToolchain', () => {
  const pkgs = ['framework-arduinoespressif32', 'toolchain-gccarmnoneeabi-teensy', 'toolchain-xtensa-esp32', 'tool-esptoolpy']
  it('picks the xtensa toolchain for an ESP32 project', () => {
    expect(pickPioToolchain(pkgs, '[env:esp32dev]\nplatform = espressif32')).toBe('toolchain-xtensa-esp32')
  })
  it('infers ESP32 from the libdeps env name when platformio.ini is absent', () => {
    expect(pickPioToolchain(pkgs, '\nesp32dev')).toBe('toolchain-xtensa-esp32')
  })
  it('picks the ARM toolchain for a Teensy project', () => {
    expect(pickPioToolchain(pkgs, 'platform = teensy')).toBe('toolchain-gccarmnoneeabi-teensy')
  })
  it('falls back to the first toolchain when the platform is unknown', () => {
    expect(pickPioToolchain(pkgs, '')).toBe('toolchain-gccarmnoneeabi-teensy')
  })
  it('returns null when no toolchain is installed', () => {
    expect(pickPioToolchain(['tool-scons'], 'esp32')).toBeNull()
  })
})

describe('buildClangdConfig and GCC builtin headers', () => {
  it("leaves out GCC's private intrinsics directory but keeps the C++ library and include-fixed", () => {
    const tc = {
      target: 'x86_64-w64-mingw32',
      includes: [
        'C:/msys64/ucrt64/lib/gcc/x86_64-w64-mingw32/16.1.0/../../../../include/c++/16.1.0',
        'C:/msys64/ucrt64/lib/gcc/x86_64-w64-mingw32/16.1.0/include',
        'C:/msys64/ucrt64/lib/gcc/x86_64-w64-mingw32/16.1.0/include-fixed',
        'C:/msys64/ucrt64/include'
      ]
    }
    const cfg = buildClangdConfig(tc, 'c++23')
    expect(cfg).not.toContain('16.1.0/include"')
    expect(cfg).toContain('include/c++/16.1.0')
    expect(cfg).toContain('include-fixed')
    expect(cfg).toContain('C:/msys64/ucrt64/include')
  })
  it('also recognises a backslash path from a Windows compiler', () => {
    const bs = String.fromCharCode(92)
    const dir = ['c:', 'users', 'x', 'lib', 'gcc', 'xtensa-esp32-elf', '8.4.0', 'include'].join(bs)
    expect(buildClangdConfig({ target: null, includes: [dir] }, 'c++17')).not.toContain('xtensa-esp32-elf')
  })
})

import { buildPlatformioConfig, gccVersionOf } from '../src/main/services/clangdConfig'

describe('PlatformIO compile-database config', () => {
  const bs = String.fromCharCode(92)
  const xt = 'c:/users/x/.platformio/packages/toolchain-xtensa-esp32/bin/../lib/gcc/xtensa-esp32-elf/8.4.0'
  const tc = {
    target: null,
    includes: [`${xt}/../../../../xtensa-esp32-elf/include/c++/8.4.0`, `${xt}/include`, `${xt}/../../../../xtensa-esp32-elf/sys-include`]
  }

  it('reads the GCC version out of the toolchain include dirs, with either slash', () => {
    expect(gccVersionOf(tc.includes)).toBe('8.4.0')
    expect(gccVersionOf([['c:', 'x', 'lib', 'gcc', 'xtensa-esp32-elf', '15.2.1', 'include'].join(bs)])).toBe('15.2.1')
    expect(gccVersionOf(['/usr/include'])).toBeNull()
  })

  it('removes GCC-only flags, adds the board headers and the GCC version, and sets no target or -std', () => {
    const cfg = buildPlatformioConfig(tc)
    expect(cfg.startsWith(MARKER)).toBe(true)
    expect(cfg).toContain('"-mlongcalls"'.replace('-mlongcalls', '-m*'))
    expect(cfg).toContain('-fstrict-volatile-bitfields')
    expect(cfg).toContain('-fgnuc-version=8.4.0')
    expect(cfg).toContain('sys-include')
    expect(cfg).toContain('drv_unknown_argument')
    expect(cfg).not.toContain('--target')
    expect(cfg).not.toContain('-std=')
  })

  it('omits the GCC version flag when it cannot be determined', () => {
    expect(buildPlatformioConfig({ target: null, includes: ['/opt/x/include'] })).not.toContain('fgnuc')
  })
})

describe('ensureClangdConfig for firmware and desktop tools in one workspace', () => {
  let root: string
  let boardInclude: string
  let servoInclude: string
  const nativeInclude = 'C:/owned-native/include/opencv4'

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortex-mixed-clangd-'))
    const core = join(root, 'owned-pio-core')
    const bin = join(core, 'packages', 'toolchain-xtensa-esp32', 'bin')
    boardInclude = join(core, 'packages', 'toolchain-xtensa-esp32', 'lib', 'gcc', 'xtensa-esp32-elf', '8.4.0', 'include')
    servoInclude = join(root, '.pio', 'libdeps', 'esp32dev', 'ESP32Servo', 'src')
    mkdirSync(bin, { recursive: true })
    mkdirSync(servoInclude, { recursive: true })
    mkdirSync(join(root, '.cortex'))
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'tools'))
    writeFileSync(join(bin, 'xtensa-esp32-elf-g++.exe'), '')
    writeFileSync(join(root, 'platformio.ini'), '[env:esp32dev]\nplatform = espressif32\n')
    writeFileSync(join(root, '.cortex', 'config.json'), JSON.stringify({ compiler: 'g++', std: 'c++17', cStd: 'c99' }))
    writeFileSync(join(root, 'compile_commands.json'), JSON.stringify([{
      directory: root,
      file: join(root, 'src', 'main.cpp'),
      arguments: [join(bin, 'xtensa-esp32-elf-g++.exe'), '-std=gnu++11', '-mlongcalls', '-c', join(root, 'src', 'main.cpp')]
    }]))
    vi.stubEnv('PLATFORMIO_CORE_DIR', core)
    mocks.editorIncludeDirs.mockResolvedValue([nativeInclude])
    mocks.spawn.mockImplementation((compiler: string) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: vi.fn()
      })
      child.stdin.on('finish', () => queueMicrotask(() => {
        child.stderr.write(compiler.includes('xtensa')
          ? `Target: xtensa-esp32-elf\n#include <...> search starts here:\n ${boardInclude}\nEnd of search list.\n`
          : GXX_V)
        child.stdout.end()
        child.stderr.end()
        child.emit('close', 0)
      }))
      return child
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    rmSync(root, { recursive: true, force: true })
  })

  it('keeps the board database for firmware but analyzes tools with the host build settings', async () => {
    expect(await ensureClangdConfig(root)).toBe(true)
    const config = readFileSync(join(root, '.clangd'), 'utf8')
    const firmware = fragmentsFor(config, 'src/main.cpp')
    const desktop = fragmentsFor(config, 'tools/camera_preview.cpp')
    const desktopC = fragmentsFor(config, 'tools/native.c')
    const firmwareFlags = firmware.flatMap(fragment => fragment.CompileFlags?.Add ?? [])
    const desktopFlags = desktop.flatMap(fragment => fragment.CompileFlags?.Add ?? [])
    const desktopCFlags = desktopC.flatMap(fragment => fragment.CompileFlags?.Add ?? [])

    expect(desktop.some(fragment => fragment.CompileFlags?.CompilationDatabase === 'None')).toBe(true)
    expect(desktop.some(fragment => fragment.CompileFlags?.Compiler === 'g++')).toBe(true)
    expect(desktopFlags).toContain('--target=x86_64-w64-mingw32')
    expect(desktopFlags).toContain('-std=c++17')
    expect(desktopFlags).not.toContain('-std=c99')
    expect(desktopFlags).toContain(nativeInclude)
    expect(desktopFlags).toContain('C:/msys64/mingw64/include/c++/14.2.0')
    expect(desktopFlags).not.toContain(boardInclude)
    expect(desktopFlags).not.toContain(servoInclude)
    expect(desktopFlags.some(flag => flag.startsWith('-fgnuc-version='))).toBe(false)
    expect(desktop.flatMap(fragment => fragment.CompileFlags?.Remove ?? [])).not.toContain('-m*')
    expect(desktopCFlags).toContain('-std=c99')
    expect(desktopCFlags).not.toContain('-std=c++17')
    expect(desktopC.filter(fragment => fragment.CompileFlags?.Compiler).at(-1)?.CompileFlags?.Compiler).toBe('gcc')

    expect(firmwareFlags).toContain(boardInclude)
    expect(firmwareFlags).toContain(servoInclude)
    expect(firmwareFlags).toContain('-fgnuc-version=8.4.0')
    expect(firmwareFlags).not.toContain(nativeInclude)
    expect(firmwareFlags.some(flag => flag.startsWith('--target=') || flag.startsWith('-std='))).toBe(false)
    expect(firmware.some(fragment => fragment.CompileFlags?.CompilationDatabase === 'None')).toBe(false)
    expect(firmware.flatMap(fragment => fragment.CompileFlags?.Remove ?? [])).toContain('-m*')
    expect(fragmentsFor(config, 'firmware/custom.cpp').flatMap(fragment => fragment.CompileFlags?.Add ?? [])).toEqual(firmwareFlags)
    expect(await ensureClangdConfig(root)).toBe(false)
  })

  it('discovers installed board headers without starting a slow compiler process', async () => {
    const packageRoot = join(root, 'owned-pio-core', 'packages', 'toolchain-xtensa-esp32')
    const cppInclude = join(packageRoot, 'xtensa-esp32-elf', 'include', 'c++', '8.4.0')
    const boardHeaders = [
      cppInclude,
      join(cppInclude, 'xtensa-esp32-elf'),
      join(cppInclude, 'backward'),
      boardInclude,
      join(packageRoot, 'lib', 'gcc', 'xtensa-esp32-elf', '8.4.0', 'include-fixed'),
      join(packageRoot, 'xtensa-esp32-elf', 'include')
    ]
    for (const directory of boardHeaders) mkdirSync(directory, { recursive: true })

    expect(await ensureClangdConfig(root)).toBe(true)
    const config = readFileSync(join(root, '.clangd'), 'utf8')
    const firmware = fragmentsFor(config, 'src/main.cpp')
    const desktop = fragmentsFor(config, 'tools/camera_preview.cpp')
    const firmwareFlags = firmware.flatMap(fragment => fragment.CompileFlags?.Add ?? [])
    const desktopFlags = desktop.flatMap(fragment => fragment.CompileFlags?.Add ?? [])

    expect(mocks.spawn.mock.calls.some(([compiler]) => compiler.includes('xtensa'))).toBe(false)
    expect(firmwareFlags).toEqual(expect.arrayContaining(boardHeaders))
    expect(firmwareFlags).not.toContain(join(packageRoot, 'xtensa-esp32-elf', 'sys-include'))
    expect(firmwareFlags).toContain('-fgnuc-version=8.4.0')
    expect(firmware.flatMap(fragment => fragment.CompileFlags?.Remove ?? [])).toContain('-m*')
    expect(firmwareFlags.some(flag => flag.startsWith('--target=') || flag.startsWith('-std='))).toBe(false)
    expect(desktopFlags).toContain(nativeInclude)
    expect(desktopFlags).toContain('--target=x86_64-w64-mingw32')
    expect(desktopFlags).toContain('-std=c++17')
    expect(desktop.some(fragment => fragment.CompileFlags?.CompilationDatabase === 'None')).toBe(true)
    expect(desktopFlags).not.toContain(cppInclude)
    expect(desktopFlags).not.toContain('-fgnuc-version=8.4.0')
  })

  it('preserves the last working board configuration when a cold compiler probe fails', async () => {
    mkdirSync(boardInclude, { recursive: true })
    const previous = buildPlatformioConfig({ target: null, includes: [boardInclude] }, true) + '---\n' +
      buildClangdConfig(parseDriverOutput(GXX_V), 'c++17', 'c99', [join(root, 'src')], [nativeInclude], { compiler: 'g++' })
    writeFileSync(join(root, '.clangd'), previous)
    mocks.spawn.mockImplementationOnce(() => { throw new Error('Owned cold compiler probe failed') })

    expect(await ensureClangdConfig(root)).toBe(false)
    expect(readFileSync(join(root, '.clangd'), 'utf8')).toBe(previous)
  })

  it('does not replace a user-authored configuration in a mixed workspace', async () => {
    const userConfig = '# My configuration\nCompileFlags:\n  Add: [-DMY_CONFIG]\n'
    writeFileSync(join(root, '.clangd'), userConfig)
    expect(await ensureClangdConfig(root)).toBe(false)
    expect(readFileSync(join(root, '.clangd'), 'utf8')).toBe(userConfig)
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})
