import { describe, expect, it } from 'vitest'
import { captureSession, decodeSessions, sessionPath, sessionRelativePath, updateSessions } from '../src/shared/workspaceSession'

const root = 'C:/Project'
const state = {
  workspaceRoot: root, tabs: [{ path: `${root}/src/main.cpp`, group: 0, content: 'PRIVATE SOURCE' }, { path: `${root}/readme.md`, group: 1 }],
  activeGroup: 1, groupActive: { 0: `${root}/src/main.cpp`, 1: `${root}/readme.md` }, expanded: new Set([`${root}/src`])
}

describe('bounded workspace session metadata', () => {
  it('round trips relative paths and layout without any source bytes', () => {
    const session = captureSession(state)!
    expect(session).toMatchObject({ version: 1, root, tabs: [{ path: 'src/main.cpp', group: 0 }, { path: 'readme.md', group: 1 }], expanded: ['src'], activeGroup: 1, groupActive: { 0: 'src/main.cpp', 1: 'readme.md' } })
    expect(JSON.stringify(session)).not.toContain('PRIVATE SOURCE')
    expect(decodeSessions(JSON.stringify([session]))).toEqual([session])
  })
  it('confines paths and preserves POSIX case while deduplicating Windows case', () => {
    expect(sessionRelativePath(root, 'c:\\project\\src\\main.cpp')).toBe('src/main.cpp')
    expect(sessionRelativePath(root, 'C:/Project-other/a')).toBeNull()
    expect(sessionRelativePath('/project', '/Project/a')).toBeNull()
    expect(sessionRelativePath('/project', '/project/A')).toBe('A')
    const session = captureSession({ ...state, tabs: [...state.tabs, { path: 'c:/project/SRC/MAIN.cpp', group: 1 }, { path: 'C:/outside/secret', group: 0 }] })!
    expect(session.tabs).toHaveLength(2)
  })
  it.each(['../outside', 'a/../outside', '/outside', 'C:/outside', '\\\\server\\share', 'a\u0000b', 'a//b', './a', 'a:stream'])('rejects unsafe saved relative path %j', (path) => {
    expect(sessionPath(root, path)).toBeNull()
    expect(decodeSessions(JSON.stringify([{ ...captureSession(state), tabs: [{ path, group: 0 }] }]))[0]?.tabs).toEqual([])
  })
  it('ignores corrupt, future and oversized metadata', () => {
    expect(decodeSessions('{bad')).toEqual([])
    expect(decodeSessions(JSON.stringify([{ ...captureSession(state), version: 2 }]))).toEqual([])
    expect(decodeSessions(' '.repeat(512 * 1024 + 1))).toEqual([])
  })
  it('bounds tab/folder counts and saved projects with the current project first', () => {
    const session = captureSession({ ...state, tabs: Array.from({ length: 80 }, (_, i) => ({ path: `${root}/${i}.cpp`, group: 0 })), expanded: new Set(Array.from({ length: 150 }, (_, i) => `${root}/dir${i}`)) })!
    expect(session.tabs).toHaveLength(50)
    expect(session.expanded).toHaveLength(100)
    const sessions = Array.from({ length: 25 }, (_, i) => ({ ...session, root: `C:/project${i}` }))
    expect(updateSessions(sessions, session)).toHaveLength(20)
    expect(updateSessions(sessions, session)[0].root).toBe(root)
    expect(updateSessions([session], { ...session, root: 'c:/PROJECT' })).toHaveLength(1)
  })
  it('bounds individual long-path metadata before writing local storage', () => {
    const stem = 'x'.repeat(3900)
    const session = captureSession({ ...state, tabs: Array.from({ length: 50 }, (_, i) => ({ path: `${root}/${stem}${i}`, group: 0 })), expanded: new Set(Array.from({ length: 100 }, (_, i) => `${root}/${stem}/d${i}`)) })!
    expect(JSON.stringify(session).length).toBeLessThanOrEqual(128 * 1024)
    expect(decodeSessions(JSON.stringify([session]))).toEqual([session])
  })
})
