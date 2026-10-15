import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { safeCommand, resolveOnPath, commandMissing } from '../src/main/services/commandResolver'

/**
 * The command-trust model used to rest on "a bare name is safe, because it is
 * resolved via PATH". On Windows that is false for the runtime this app ships:
 * libuv searches the CHILD'S cwd before PATH, and every spawn here runs with a
 * cwd inside the user's project. Verified against electron 33 by planting a
 * <repo>/python.exe, which ran in place of the real interpreter.
 */

const IS_WIN = process.platform === 'win32'
const EXE = IS_WIN ? '.exe' : ''

let dir: string
let pathDir: string
let repoDir: string
const origPath = process.env['PATH']

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cortex-resolve-'))
  pathDir = join(dir, 'realbin')
  repoDir = join(dir, 'repo')
  mkdirSync(pathDir)
  mkdirSync(repoDir)
  writeFileSync(join(pathDir, `python${EXE}`), '')
  // The planted binary: same name, inside the untrusted project.
  writeFileSync(join(repoDir, `python${EXE}`), '')
  process.env['PATH'] = pathDir
})

afterEach(() => {
  process.env['PATH'] = origPath
  rmSync(dir, { recursive: true, force: true })
})

describe('resolveOnPath', () => {
  it('finds a bare command in PATH and returns an absolute path', () => {
    expect(resolveOnPath('python')).toBe(join(pathDir, `python${EXE}`))
  })

  it('returns null when the command is nowhere on PATH', () => {
    expect(resolveOnPath('definitely-not-a-real-tool')).toBeNull()
  })

  it('never consults the working directory', () => {
    // The whole point: even with the process cwd inside the repo, only PATH is
    // searched, so the planted binary is not a candidate.
    const before = process.cwd()
    try {
      process.chdir(repoDir)
      expect(resolveOnPath('python')).toBe(join(pathDir, `python${EXE}`))
    } finally {
      process.chdir(before)
    }
  })

  it('ignores a relative PATH entry, which would reintroduce the same hole', () => {
    process.env['PATH'] = 'repo'
    const before = process.cwd()
    try {
      process.chdir(dir)
      expect(resolveOnPath('python')).toBeNull()
    } finally {
      process.chdir(before)
    }
  })
})

describe('safeCommand', () => {
  it('turns a bare name into the PATH copy, not the project copy', () => {
    const resolved = safeCommand('python', repoDir)
    expect(resolved).toBe(join(pathDir, `python${EXE}`))
    expect(resolved).not.toContain('repo')
  })

  it('passes an absolute path through', () => {
    // Callers gate these on their own terms, and two legitimate ones live INSIDE
    // the workspace: the executable Cortex just built, and a venv interpreter.
    const built = join(repoDir, '.cortex', 'build', `app${EXE}`)
    expect(safeCommand(built, repoDir)).toBe(built)
  })

  it('refuses a relative path, which resolves against the project', () => {
    expect(safeCommand('./python', repoDir)).toBeNull()
    expect(safeCommand('.cortex/python', repoDir)).toBeNull()
  })

  it('refuses a PATH hit that lands inside the open workspace', () => {
    // Defence in depth: if PATH itself names a directory in the project, a hit
    // there is exactly the binary we are trying not to run.
    process.env['PATH'] = repoDir
    expect(safeCommand('python', repoDir)).toBeNull()
  })

  it('refuses a command PATH cannot resolve, instead of handing back the bare name', () => {
    // Returning the bare name moved the lookup straight back into libuv, which
    // searches the child's cwd first - restoring the exact hole this module
    // exists to close, on precisely the machines a drive-by targets: the ones
    // missing the tool the repo needs. Callers tell the two cases apart with
    // commandMissing() so a machine without the toolchain still gets the
    // install hint rather than a security refusal.
    expect(safeCommand('definitely-not-a-real-tool', repoDir)).toBeNull()
    expect(commandMissing('definitely-not-a-real-tool')).toBe(true)
    expect(commandMissing('python')).toBe(false)
  })

  it('refuses an empty command', () => {
    expect(safeCommand('', repoDir)).toBeNull()
  })
})

import { existsSync as existsForMsys } from 'node:fs'
import { addKnownToolDirs as addDirs, resolveOnPath as resolveOn } from '../src/main/services/commandResolver'

// Machine-dependent by nature (needs a real MSYS2 install), so it only asserts
// where one exists.
describe.skipIf(!existsForMsys('C:/msys64/ucrt64/bin/g++.exe'))('known toolchain directories', () => {
  it('finds an MSYS2 g++ that is not on PATH, and puts its bin on PATH for children', () => {
    const saved = process.env['PATH']
    try {
      process.env['PATH'] = 'C:/WINDOWS/system32'
      expect(resolveOn('g++')?.toLowerCase()).toContain('msys64')
      expect((process.env['PATH'] || '').toLowerCase().split(String.fromCharCode(92)).join('/')).toContain('c:/msys64/ucrt64/bin')
      expect(addDirs()).toBe(false) // idempotent: nothing left to add
    } finally {
      process.env['PATH'] = saved
    }
  })

  it('does not substitute an MSYS2 python or node for a missing interpreter', () => {
    const saved = process.env['PATH']
    try {
      process.env['PATH'] = 'C:/WINDOWS/system32'
      expect(resolveOn('python')).toBeNull()
      expect(resolveOn('node')).toBeNull()
    } finally {
      process.env['PATH'] = saved
    }
  })
})
