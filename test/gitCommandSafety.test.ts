import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve, join } from 'node:path'

const fixtures = vi.hoisted(() => ({ run: vi.fn(), workspace: '' }))
vi.mock('child_process', () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: (...args: unknown[]) => fixtures.run(...args) })
}))
vi.mock('../src/main/services/commandResolver', () => ({ safeCommand: () => process.execPath, needsShell: () => false }))
vi.mock('../src/main/services/fsService', () => ({
  getWorkspaceRoot: () => fixtures.workspace,
  withinWorkspace: (path: string) => path === fixtures.workspace || path.startsWith(fixtures.workspace + '/') || path.startsWith(fixtures.workspace + '\\')
}))
import * as git from '../src/main/services/gitService'

beforeEach(() => {
  fixtures.workspace = resolve('test', 'isolated-mocked-git-workspace')
  fixtures.run.mockReset()
  fixtures.run.mockImplementation(async (_command: string, args: string[]) => {
    if (args.includes('--show-toplevel')) return { stdout: fixtures.workspace + '\n' }
    if (args.includes('status')) return { stdout: '## main\0 M firmware.cpp\0' }
    return { stdout: '' }
  })
})

describe('Git command boundary', () => {
  it('bounds every read-only command, disables repository monitors, and uses literal paths without a shell', async () => {
    expect(await git.status()).toMatchObject({ isRepo: true, branch: 'main' })
    for (const [, args, options] of fixtures.run.mock.calls) {
      expect(args).toContain('--literal-pathspecs')
      expect(args).toContain('core.fsmonitor=false')
      expect(options).toMatchObject({ timeout: 15_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
      expect(options.shell).toBeUndefined()
      expect(options.env.GIT_TERMINAL_PROMPT).toBe('0')
    }
  })

  it('reports failed root discovery and refuses initialization instead of treating the failure as a new project', async () => {
    fixtures.run.mockRejectedValue({ killed: true })
    expect(await git.status()).toMatchObject({ error: expect.stringContaining('Could not locate') })
    expect(await git.init()).toMatchObject({ ok: false, error: expect.stringContaining('Could not verify') })
    expect(fixtures.run.mock.calls.every(([, args]) => !args.includes('init'))).toBe(true)
  })

  it('reports status buffer or access failures instead of fabricating a clean tree', async () => {
    fixtures.run.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return { stdout: fixtures.workspace + '\n' }
      throw { stderr: 'fatal: permission denied' }
    })
    expect(await git.status()).toMatchObject({ isRepo: true, error: 'Could not read git status.' })
  })

  it('bounds mutations and excludes command text from reported failure messages', async () => {
    fixtures.run.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return { stdout: fixtures.workspace + '\n' }
      throw { stderr: 'fatal: unable to create index.lock', message: 'Command failed: secret commit message' }
    })
    expect(await git.commit('secret commit message')).toEqual({ ok: false, error: 'fatal: unable to create index.lock' })
    const [, , options] = fixtures.run.mock.calls.find(([, args]) => args.includes('commit'))!
    expect(options.timeout).toBe(60_000)
    expect(options.env.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('refuses a mutation if the user changes projects during repository discovery', async () => {
    const before = fixtures.workspace
    fixtures.run.mockImplementation(async () => {
      fixtures.workspace = join(before, 'other-project')
      return { stdout: before + '\n' }
    })
    expect((await git.commit('Do not commit the wrong project')).ok).toBe(false)
    expect(fixtures.run.mock.calls).toHaveLength(1)
  })

  it('distinguishes runaway hook output from a network timeout', async () => {
    fixtures.run.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return { stdout: fixtures.workspace + '\n' }
      throw { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }
    })
    expect(await git.commit('bounded output')).toEqual({ ok: false, error: 'Git output exceeded the capture limit. Check repository hooks and try again.' })
  })

  it('redacts remote credentials and token parameters from error notifications', async () => {
    fixtures.run.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes('--show-toplevel')) return { stdout: fixtures.workspace + '\n' }
      throw { stderr: "fatal: unable to access 'https://user:private-secret@example.invalid/repo?access_token=another-secret&branch=main': connection failed" }
    })
    const result = await git.commit('remote hook error')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('[redacted]')
    expect(result.error).not.toContain('private-secret')
    expect(result.error).not.toContain('another-secret')
  })
})
