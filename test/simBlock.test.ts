import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guards the simulator "blocked" panel against the regression review found: the
 * block used to be cleared only on a real run or a workspace switch, so switching
 * files left a full-height panel plastered over a now-valid sketch, with a message
 * that could even name a file you had closed.
 *
 * The fix ties the block to the file that raised it (SimBlock.path) and renders
 * the panel only while that file is active. These modules pull in React and the
 * store (which reaches for window), and the test env is node with no jsdom, so
 * this asserts on the source text, the same approach as workspaceReset.test.ts.
 */

const STORE = readFileSync(join(__dirname, '..', 'src', 'renderer', 'src', 'store', 'useStore.ts'), 'utf8')
const VIEW = readFileSync(
  join(__dirname, '..', 'src', 'renderer', 'src', 'components', 'SimulatorView.tsx'),
  'utf8'
)

describe('SimBlock carries the file it was raised for', () => {
  it('both variants of the type include a path', () => {
    const type = STORE.slice(STORE.indexOf('export type SimBlock'), STORE.indexOf('export type SimBlock') + 260)
    expect(type).toMatch(/reason: 'compiler';\s*path: string/)
    expect(type).toMatch(/reason: 'not-sketch';\s*path: string/)
  })

  it('both places that raise a block set the path to the active file', () => {
    // The compiler wall and the not-a-sketch guard, both in startSim.
    expect(STORE).toContain("simBlock: { reason: 'compiler', path: activePath }")
    // The set-site is an object literal (comma), not the type declaration (semicolon).
    const notSketch = STORE.slice(STORE.indexOf("reason: 'not-sketch',"))
    expect(notSketch.slice(0, 80)).toContain('path: activePath')
  })
})

describe('SimulatorView shows the block only over its own file', () => {
  it('gates on the block path matching the active file', () => {
    expect(VIEW).toContain('simBlock.path === activePath')
  })

  it('renders the panel, hides the wiring hint, and disables the palette on that flag', () => {
    // The panel replaces the canvas only when blocked...
    expect(VIEW).toMatch(/\{blocked \? \(/)
    // ...the "add a part" hint does not sit on top of it...
    expect(VIEW).toContain('!blocked && simParts.length === 0')
    // ...and the palette cannot add parts onto a hidden canvas.
    expect(VIEW).toContain('disabled={blocked || !workspaceRoot}')
  })
})
