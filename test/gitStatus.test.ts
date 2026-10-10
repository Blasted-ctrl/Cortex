import { describe, it, expect } from 'vitest'
import { parsePorcelain } from '../src/shared/gitStatus'

// Records are NUL-separated with -z; build fixtures the same way.
const z = (...records: string[]): string => records.join('\0')

describe('parsePorcelain', () => {
  it('reads the branch, upstream, and ahead/behind from the header', () => {
    const r = parsePorcelain(z('## main...origin/main [ahead 2, behind 1]'))
    expect(r.branch).toBe('main')
    expect(r.upstream).toBe('origin/main')
    expect(r.ahead).toBe(2)
    expect(r.behind).toBe(1)
    expect(r.files).toEqual([])
  })

  it('handles a branch with no upstream', () => {
    const r = parsePorcelain(z('## feature-x'))
    expect(r.branch).toBe('feature-x')
    expect(r.upstream).toBeUndefined()
    expect(r.ahead).toBe(0)
    expect(r.behind).toBe(0)
  })

  it('keeps a dot in the branch name (splits only on the ... separator)', () => {
    const r = parsePorcelain(z('## release/1.0...origin/release/1.0 [ahead 3]'))
    expect(r.branch).toBe('release/1.0')
    expect(r.ahead).toBe(3)
  })

  it('reads the branch when there are no commits yet', () => {
    const r = parsePorcelain(z('## No commits yet on main'))
    expect(r.branch).toBe('main')
  })

  it('classifies staged, unstaged, and untracked files by X/Y', () => {
    const r = parsePorcelain(z('## main', 'M  staged.c', ' M unstaged.c', '?? new.c', 'A  added.c', ' D gone.c'))
    expect(r.files).toEqual([
      { path: 'staged.c', index: 'M', worktree: ' ' },
      { path: 'unstaged.c', index: ' ', worktree: 'M' },
      { path: 'new.c', index: '?', worktree: '?' },
      { path: 'added.c', index: 'A', worktree: ' ' },
      { path: 'gone.c', index: ' ', worktree: 'D' }
    ])
  })

  it('reads a file staged AND modified (MM)', () => {
    const r = parsePorcelain(z('## main', 'MM both.c'))
    expect(r.files[0]).toEqual({ path: 'both.c', index: 'M', worktree: 'M' })
  })

  it('consumes the original path of a rename as the next record', () => {
    const r = parsePorcelain(z('## main', 'R  new/name.c', 'old/name.c', ' M after.c'))
    expect(r.files).toEqual([
      { path: 'new/name.c', index: 'R', worktree: ' ', orig: 'old/name.c' },
      { path: 'after.c', index: ' ', worktree: 'M' }
    ])
  })

  it('preserves a path containing spaces (NUL-delimited)', () => {
    const r = parsePorcelain(z('## main', ' M src/a file.c'))
    expect(r.files[0].path).toBe('src/a file.c')
  })

  it('consumes rename and copy origins in the working-tree column as well as the index', () => {
    const r = parsePorcelain(z('## main', ' R new.c', 'old.c', ' C copy.c', 'source.c', ' M after.c'))
    expect(r.files).toEqual([
      { path: 'new.c', index: ' ', worktree: 'R', orig: 'old.c' },
      { path: 'copy.c', index: ' ', worktree: 'C', orig: 'source.c' },
      { path: 'after.c', index: ' ', worktree: 'M' }
    ])
  })

  it('preserves newline characters in filenames and reports unmerged paths', () => {
    const r = parsePorcelain(z('## main', 'UU firmware\nconflict.cpp', '?? new\nfile.cpp'))
    expect(r.files).toEqual([
      { path: 'firmware\nconflict.cpp', index: 'U', worktree: 'U' },
      { path: 'new\nfile.cpp', index: '?', worktree: '?' }
    ])
  })

  it('returns an empty file list for a clean tree', () => {
    const r = parsePorcelain(z('## main...origin/main'))
    expect(r.files).toEqual([])
    expect(r.branch).toBe('main')
  })

  it('tolerates a trailing NUL and empty records', () => {
    const r = parsePorcelain(z('## main', 'M  a.c', ''))
    expect(r.files).toHaveLength(1)
  })
})
