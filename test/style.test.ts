import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Enforces the house typography rules from docs/STYLE.md. These were previously
 * kept by hand and drifted back in twice: an em dash reached a UI string as a
 * "no pin" placeholder, and the unicode ellipsis spread to seven call sites
 * while the rest of the app used three dots.
 */

const ROOT = join(__dirname, '..')

/**
 * The whole repo, minus build output and dependencies. An allowlist of scanned
 * directories was the wrong shape: it was widened twice (once for examples/,
 * once for package.json) and a stray main.cpp at the repo root still slipped an
 * em dash past it. Excluding what cannot be ours is a rule that stays true as
 * files are added; listing what is ours is a rule that needs maintaining.
 */
const SKIP = new Set(['node_modules', 'out', 'dist', 'release', '.git', '.vscode', '.idea'])
// Dependency metadata, not our copy: other people's package descriptions are
// not ours to hold to this rule.
const SKIP_FILES = new Set(['package-lock.json'])
const SOURCE = /\.(ts|mts|tsx|css|md|js|json|yml|yaml|ino|cpp|h|hpp|py|rs|toml)$/

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry) || SKIP_FILES.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, acc)
    else if (SOURCE.test(entry)) acc.push(full)
  }
  return acc
}

const FILES = walk(ROOT)

/** Every offending line as "path:line: text", so a failure names the spot. */
function findChar(char: string): string[] {
  const hits: string[] = []
  for (const file of FILES) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((text, i) => {
      // This test file necessarily contains the characters it bans.
      if (file.endsWith('style.test.ts')) return
      if (text.includes(char)) hits.push(`${relative(ROOT, file)}:${i + 1}: ${text.trim()}`)
    })
  }
  return hits
}

describe('house style', () => {
  it('has scanned a real set of files', () => {
    expect(FILES.length).toBeGreaterThan(20)
  })

  it('uses no em dashes', () => {
    expect(findChar('—')).toEqual([])
  })

  it('uses no en dashes', () => {
    expect(findChar('–')).toEqual([])
  })

  it('uses ascii ... rather than the unicode ellipsis', () => {
    expect(findChar('…')).toEqual([])
  })
})
