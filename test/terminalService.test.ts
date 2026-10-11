import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guards the security-critical wiring of the integrated terminal. The service
 * imports node-pty and Electron, so (like the store tests) this asserts on the
 * source text rather than importing the module under node. The invariants here
 * are the ones a reviewer must never let regress: the shell's cwd is the trusted
 * workspace root and never a renderer-supplied path; the shell is spawned as
 * file + argv (never a shell string built from user input); and every session is
 * killed on teardown so no shell outlives the app.
 */

const SERVICE = readFileSync(
  join(__dirname, '..', 'src', 'main', 'services', 'terminalService.ts'),
  'utf8'
)
const INDEX = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')

describe('terminalService security invariants', () => {
  it('derives the cwd from the trusted workspace root, not from the request', () => {
    expect(SERVICE).toContain('getWorkspaceRoot() || homedir()')
    // The request type carries no cwd field, and the service must not read one.
    expect(SERVICE).not.toMatch(/req\.cwd/)
  })

  it('spawns the shell as file + argv, never a shell string', () => {
    // pickShell returns { file, args }; spawn takes them positionally.
    expect(SERVICE).toMatch(/m\.spawn\(shell\.file,\s*shell\.args/)
    // No shell:true, no exec of a concatenated command line.
    expect(SERVICE).not.toMatch(/shell:\s*true/)
    expect(SERVICE).not.toContain('exec(')
  })

  it('enforces a session cap', () => {
    expect(SERVICE).toContain('MAX_TERMINALS')
    expect(SERVICE).toMatch(/sessions\.size >= MAX_TERMINALS/)
  })

  it('drops a session from the map when its shell exits', () => {
    const onExit = SERVICE.slice(SERVICE.indexOf('pty.onExit'))
    expect(onExit.slice(0, 200)).toContain('sessions.delete(req.id)')
  })

  it('only writes when the payload is a string', () => {
    expect(SERVICE).toMatch(/typeof data === 'string'/)
  })

  it('killAll kills every session and clears the map', () => {
    const killAll = SERVICE.slice(SERVICE.indexOf('export function killAll'))
    expect(killAll).toContain('p.kill()')
    expect(killAll).toContain('sessions.clear()')
  })
})

describe('terminal IPC wiring', () => {
  it('registers create as invoke and input/resize/kill as fire-and-forget', () => {
    expect(INDEX).toMatch(/handle\(IPC\.TERMINAL_CREATE/)
    expect(INDEX).toMatch(/on\(IPC\.TERMINAL_INPUT/)
    expect(INDEX).toMatch(/on\(IPC\.TERMINAL_RESIZE/)
    expect(INDEX).toMatch(/on\(IPC\.TERMINAL_KILL/)
    expect(INDEX).toMatch(/ipcMain\.handle\(channel, guardRendererInvoke\(/)
    expect(INDEX).toMatch(/ipcMain\.on\(channel, guardRendererEvent\(/)
    expect(INDEX).not.toMatch(/ipcMain\.(handle|on)\(IPC\.TERMINAL_/)
  })

  it('kills all terminals on window-all-closed and committed application quit', () => {
    const closed = INDEX.slice(INDEX.indexOf("app.on('window-all-closed'"), INDEX.indexOf("app.on('before-quit'"))
    const quit = INDEX.slice(INDEX.indexOf("app.on('will-quit'"))
    expect(closed).toContain('terminal.killAll()')
    expect(quit).toContain('terminal.killAll()')
  })

  it('does not retire terminals before a quit request can be cancelled by failed saves', () => {
    const beforeQuit = INDEX.indexOf("app.on('before-quit'")
    const willQuit = INDEX.indexOf("app.on('will-quit'")
    expect(willQuit).toBeGreaterThan(beforeQuit)
    expect(INDEX.slice(beforeQuit, willQuit)).not.toContain('terminal.killAll()')
    expect(INDEX.slice(willQuit)).toContain('terminal.killAll()')
  })
})
