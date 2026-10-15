import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as files from '../src/main/services/fsService'
import { pickPythonInterpreter } from '../src/main/services/runnerService'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortex-py-'))
  files.setWorkspaceRoot(root)
})
afterEach(() => {
  files.setWorkspaceRoot(null)
  rmSync(root, { recursive: true, force: true })
})

describe('pickPythonInterpreter', () => {
  it('defaults to python and honours the trusted app setting', () => {
    expect(pickPythonInterpreter({ cwd: root })).toEqual({ py: 'python' })
    expect(pickPythonInterpreter({ cwd: root, pythonPath: 'python3' })).toEqual({ py: 'python3' })
  })

  it('accepts a venv interpreter inside the workspace, resolved against the project', () => {
    const out = pickPythonInterpreter({ cwd: root, projectPython: '.venv/Scripts/python.exe' })
    expect(out.ignoredPin).toBeUndefined()
    expect(out.py.replace(/\\/g, '/')).toBe(join(root, '.venv/Scripts/python.exe').replace(/\\/g, '/'))
  })

  it('refuses a pinned interpreter outside the workspace and says which pin was refused', () => {
    const out = pickPythonInterpreter({ cwd: root, pythonPath: 'python', projectPython: '../../elsewhere/python.exe' })
    expect(out).toEqual({ py: 'python', ignoredPin: '../../elsewhere/python.exe' })
  })

  it('refuses a pin that is not a Python at all', () => {
    expect(pickPythonInterpreter({ cwd: root, projectPython: 'pyright-langserver' }).ignoredPin).toBe('pyright-langserver')
  })

  it('does not throw on a non-string pin from a hostile config', () => {
    expect(pickPythonInterpreter({ cwd: root, projectPython: { evil: true } })).toEqual({ py: 'python' })
  })
})
