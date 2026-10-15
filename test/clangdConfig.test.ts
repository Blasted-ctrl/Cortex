import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDriverOutput, buildClangdConfig, discoverIncludeDirs, pickPioToolchain, MARKER } from '../src/main/services/clangdConfig'

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
