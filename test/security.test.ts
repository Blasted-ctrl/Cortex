import { describe, it, expect } from 'vitest'
import { isAllowedCommand, isBareCommand, commandBaseName, isWithin, isHostCpp } from '../src/shared/security'

describe('commandBaseName', () => {
  it('strips directories and .exe', () => expect(commandBaseName('C:/msys64/bin/g++.exe')).toBe('g++'))
  it('handles bare names', () => expect(commandBaseName('python3')).toBe('python3'))
  it('handles posix paths', () => expect(commandBaseName('/usr/bin/clang++')).toBe('clang++'))
})

describe('isAllowedCommand', () => {
  it('allows known compilers/interpreters', () => {
    for (const c of ['g++', 'clang++', 'rustc', 'python', 'node', 'arduino-cli']) {
      expect(isAllowedCommand(c)).toBe(true)
    }
  })
  it('allows a full path to an allowed exe', () => expect(isAllowedCommand('C:/tools/g++.exe')).toBe(true))
  it('rejects arbitrary executables', () => {
    for (const c of ['calc.exe', 'powershell', 'rm', 'evilg++', '']) {
      expect(isAllowedCommand(c)).toBe(false)
    }
  })
})

/**
 * isAllowedCommand matches on base name only, so it cannot be the gate for an
 * untrusted source: `C:/evil/g++.exe` passes it while running an arbitrary
 * binary. isBareCommand is the extra gate untrusted sources (workspace config)
 * must apply so only a PATH-resolved name is spawned.
 */
describe('isBareCommand', () => {
  it('accepts bare command names (optionally with an extension)', () => {
    for (const c of ['g++', 'clang++', 'pyright-langserver', 'g++.exe']) {
      expect(isBareCommand(c)).toBe(true)
    }
  })
  it('rejects anything with a path separator, which is how the allowlist is bypassed', () => {
    for (const c of ['C:/evil/g++.exe', 'C:\\evil\\g++.exe', './g++', 'tools/g++', '/usr/bin/g++', '']) {
      expect(isBareCommand(c)).toBe(false)
    }
  })
})

/**
 * The simulator builds and runs the sketch on this machine. A cross-compiler is
 * allowlisted and is real C++, but it emits firmware for a chip, so it cannot
 * do that. Three files disagreed about this and the user saw "spawn g++ ENOENT"
 * while the Toolchains panel showed a green check under "C / C++".
 */
describe('isHostCpp', () => {
  it('accepts host C++ compilers', () => {
    for (const c of ['g++', 'clang++']) expect(isHostCpp(c)).toBe(true)
  })

  it('accepts an absolute path to one', () => {
    expect(isHostCpp('C:/msys64/ucrt64/bin/g++.exe')).toBe(true)
    expect(isHostCpp('/usr/bin/clang++')).toBe(true)
  })

  it('rejects cross-compilers, which cannot build for this machine', () => {
    for (const c of ['avr-g++', 'arm-none-eabi-g++', 'avr-gcc', 'arm-none-eabi-gcc']) {
      expect(isHostCpp(c), c).toBe(false)
    }
  })

  it('rejects C compilers, which cannot build the C++ shim', () => {
    for (const c of ['gcc', 'clang']) expect(isHostCpp(c), c).toBe(false)
  })

  it('rejects non-compilers and anything off the allowlist', () => {
    for (const c of ['python', 'node', 'rustc', 'curl', 'powershell', '']) expect(isHostCpp(c), c).toBe(false)
  })

  it('is narrower than the spawn allowlist, never wider', () => {
    for (const c of ['g++', 'clang++', 'avr-g++', 'gcc', 'python', 'curl']) {
      if (isHostCpp(c)) expect(isAllowedCommand(c), c).toBe(true)
    }
  })
})

describe('isWithin', () => {
  it('accepts a path under the root', () => expect(isWithin('C:/proj', 'C:/proj/src/main.cpp')).toBe(true))
  it('accepts the root itself', () => expect(isWithin('C:/proj', 'C:/proj')).toBe(true))
  it('is separator-insensitive', () => expect(isWithin('C:\\proj', 'C:/proj/a.txt')).toBe(true))
  it('rejects a sibling directory', () => expect(isWithin('C:/proj', 'C:/projedit/x')).toBe(false))
  it('rejects a path outside the root', () => expect(isWithin('C:/proj', 'C:/other/secret.txt')).toBe(false))
  it('does not authorize a different case-sensitive POSIX project', () => {
    expect(isWithin('/home/alice/Proj', '/home/alice/proj/secret.txt')).toBe(false)
    expect(isWithin('/home/alice/Proj', '/home/alice/Proj/main.cpp')).toBe(true)
  })
  it('still folds Windows drive and UNC path case', () => {
    expect(isWithin('C:/PROJ', 'c:/proj/main.cpp')).toBe(true)
    expect(isWithin('\\\\Server\\Share\\Proj', '\\\\server\\share\\proj\\main.cpp')).toBe(true)
  })
})
