import { describe, it, expect } from 'vitest'
import {
  libsForCppSource,
  libsForPythonSource,
  parsePkgConfigFlags,
  msys2EnvOf,
  msys2PackageName,
  manualInstallCommand,
  libById
} from '../src/shared/nativeLibs'

describe('libsForCppSource', () => {
  it('detects OpenCV from its umbrella and module headers', () => {
    expect(libsForCppSource('#include <opencv2/opencv.hpp>\nint main(){}').map((l) => l.id)).toEqual(['opencv'])
    expect(libsForCppSource('#include "opencv2/core.hpp"').map((l) => l.id)).toEqual(['opencv'])
  })
  it('detects several libraries and ignores std headers', () => {
    const src = '#include <iostream>\n#include <raylib.h>\n  # include <SDL2/SDL.h>\n'
    expect(libsForCppSource(src).map((l) => l.id)).toEqual(['raylib', 'sdl2'])
  })
  it('does not match a header that merely contains a catalog name', () => {
    expect(libsForCppSource('#include "myraylib.h"\n#include <notopencv2/x.h>')).toEqual([])
  })
  it('ignores a commented-out include', () => {
    expect(libsForCppSource('// #include <opencv2/opencv.hpp>')).toEqual([])
  })
})

describe('libsForPythonSource', () => {
  it('maps cv2 to OpenCV', () => {
    expect(libsForPythonSource('import cv2\nimport numpy as np').map((l) => l.id)).toEqual(['opencv'])
    expect(libsForPythonSource('from cv2 import imread').map((l) => l.id)).toEqual(['opencv'])
  })
  it('does not treat a library with no Python package as importable', () => {
    expect(libsForPythonSource('import SDL2')).toEqual([])
  })
})

describe('parsePkgConfigFlags', () => {
  it('keeps include/lib dirs, libs and defines', () => {
    const out = '-IC:/msys64/ucrt64/include/opencv4 -LC:/msys64/ucrt64/lib -lopencv_core -lopencv_imgproc -DUSE_X=1'
    expect(parsePkgConfigFlags(out)).toEqual([
      '-IC:/msys64/ucrt64/include/opencv4',
      '-LC:/msys64/ucrt64/lib',
      '-lopencv_core',
      '-lopencv_imgproc',
      '-DUSE_X=1'
    ])
  })
  it('drops anything that could redirect the compiler', () => {
    const out = '-fplugin=./x.so -specs=evil @flags -B. -Wl,-rpath,. -o /tmp/x -lok'
    expect(parsePkgConfigFlags(out)).toEqual(['-lok'])
  })
})

describe('msys2', () => {
  it('finds the environment a compiler belongs to', () => {
    const winPath = ['C:', 'msys64', 'ucrt64', 'bin', 'g++.exe'].join(String.fromCharCode(92))
    expect(msys2EnvOf(winPath)).toEqual({ root: 'C:/msys64', env: 'ucrt64' })
    expect(msys2EnvOf('C:/msys64/mingw64/bin/g++.exe')).toEqual({ root: 'C:/msys64', env: 'mingw64' })
  })
  it('returns null for a non-MSYS2 compiler', () => {
    expect(msys2EnvOf('C:/Program Files/LLVM/bin/clang++.exe')).toBeNull()
  })
  it('builds the package name for the matching environment', () => {
    const opencv = libById('opencv')!
    expect(msys2PackageName(opencv, 'ucrt64')).toBe('mingw-w64-ucrt-x86_64-opencv')
    expect(msys2PackageName(opencv, 'mingw64')).toBe('mingw-w64-x86_64-opencv')
    expect(msys2PackageName(opencv, 'nope')).toBeNull()
  })
})

describe('manualInstallCommand', () => {
  it('gives a real command per OS, or null', () => {
    expect(manualInstallCommand(libById('opencv')!, 'mac')).toBe('brew install opencv')
    expect(manualInstallCommand(libById('opencv')!, 'linux')).toBe('sudo apt install libopencv-dev')
    expect(manualInstallCommand(libById('raylib')!, 'linux')).toBeNull()
  })
})

import { libForDiagnostic, libForHeader } from '../src/shared/nativeLibs'
import { diagnosticHint } from '../src/shared/diagnosticHints'

describe('libForDiagnostic', () => {
  it('maps a clangd missing include to the C++ install', () => {
    expect(libForDiagnostic("'opencv2/opencv.hpp' file not found")).toMatchObject({ target: 'cpp', lib: { id: 'opencv' } })
  })
  it('maps a pyright unresolved import to the Python install', () => {
    expect(libForDiagnostic('Import "cv2" could not be resolved')).toMatchObject({ target: 'python', lib: { id: 'opencv' } })
    expect(libForDiagnostic('Import "cv2.aruco" could not be resolved')).toMatchObject({ target: 'python' })
  })
  it('ignores other diagnostics and unknown headers', () => {
    expect(libForDiagnostic("'my_driver.h' file not found")).toBeNull()
    expect(libForDiagnostic('Import "numpy" could not be resolved')).toBeNull()
    expect(libForDiagnostic("use of undeclared identifier 'x'")).toBeNull()
  })
  it('finds a header owner', () => {
    expect(libForHeader('raylib.h')?.id).toBe('raylib')
    expect(libForHeader('stdio.h')).toBeUndefined()
  })
})

describe('diagnosticHint for a catalog library', () => {
  it('points at the Quick Fix and Settings instead of a generic spelling hint', () => {
    expect(diagnosticHint("'opencv2/opencv.hpp' file not found")).toMatch(/Install OpenCV.*Settings > Libraries/)
    expect(diagnosticHint('Import "cv2" could not be resolved')).toMatch(/not installed for Python/)
  })
})
