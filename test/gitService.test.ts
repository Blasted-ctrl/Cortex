import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setWorkspaceRoot } from '../src/main/services/fsService'
import { resolveOnPath } from '../src/main/services/commandResolver'
import * as git from '../src/main/services/gitService'

const binary = resolveOnPath('git')
let temporary: string
let repo: string

function command(cwd: string, ...args: string[]): string {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete env[key]
  return execFileSync(binary!, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 15_000 })
}

function initialize(path: string): void {
  mkdirSync(path, { recursive: true })
  command(path, 'init', '--initial-branch=main')
  command(path, 'config', 'user.name', 'Cortex test')
  command(path, 'config', 'user.email', 'cortex-test@example.invalid')
  command(path, 'config', 'commit.gpgsign', 'false')
  command(path, 'config', 'core.autocrlf', 'false')
  mkdirSync(join(path, '.empty-hooks'))
  command(path, 'config', 'core.hooksPath', join(path, '.empty-hooks'))
  writeFileSync(join(path, '.gitignore'), '.empty-hooks/\n')
}

function initialCommit(): void {
  writeFileSync(join(repo, 'firmware.cpp'), 'initial\n')
  command(repo, 'add', '--', '.gitignore', 'firmware.cpp')
  command(repo, 'commit', '-m', 'Initial test fixture')
}

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), 'cortex-git-service-'))
  repo = join(temporary, 'project with spaces')
  initialize(repo)
  setWorkspaceRoot(repo)
})

afterEach(() => {
  setWorkspaceRoot(resolve('.'))
  if (temporary && temporary.startsWith(join(tmpdir(), 'cortex-git-service-'))) rmSync(temporary, { recursive: true, force: true })
})

describe.skipIf(!binary)('Git service using isolated real repositories', () => {
  it('operates through an admitted root alias without following paths outside the project', async () => {
    initialCommit()
    const alias = join(temporary, 'admitted project alias')
    symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir')
    setWorkspaceRoot(alias)
    writeFileSync(join(repo, 'firmware.cpp'), 'through alias\n')
    expect(await git.status()).toMatchObject({ isRepo: true, files: [{ path: 'firmware.cpp' }] })
    expect(await git.fileDiff('firmware.cpp', 'unstaged')).toMatchObject({ oldContent: 'initial\n', newContent: 'through alias\n' })
    expect(await git.stage(['firmware.cpp'])).toEqual({ ok: true })
    expect(await git.fileDiff('firmware.cpp', 'staged')).toMatchObject({ newContent: 'through alias\n' })
    expect(await git.commit('Owned alias fixture')).toEqual({ ok: true })
    expect(command(repo, 'rev-list', '--count', 'HEAD').trim()).toBe('2')
    expect(await git.createBranch('feature/alias')).toEqual({ ok: true })
    expect(await git.switchBranch('main')).toEqual({ ok: true })
    const outside = join(temporary, 'outside alias project')
    mkdirSync(outside)
    writeFileSync(join(outside, 'private.cpp'), 'outside content\n')
    symlinkSync(outside, join(repo, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await git.fileDiff('external/private.cpp', 'untracked')).toBeNull()
    expect((await git.stage(['external/private.cpp'])).ok).toBe(false)
    expect(readFileSync(join(outside, 'private.cpp'), 'utf8')).toBe('outside content\n')
  })

  it('confines an admitted subfolder alias and refuses repository-wide mutations', async () => {
    initialCommit()
    const sketch = join(repo, 'sketch')
    mkdirSync(sketch)
    writeFileSync(join(sketch, 'sketch.cpp'), 'sketch\n')
    writeFileSync(join(repo, 'hidden.cpp'), 'hidden staged file\n')
    command(repo, 'add', '--', 'hidden.cpp')
    command(repo, 'branch', 'other')
    const alias = join(temporary, 'admitted sketch alias')
    symlinkSync(sketch, alias, process.platform === 'win32' ? 'junction' : 'dir')
    setWorkspaceRoot(alias)
    expect((await git.status()).files.map((file) => file.path)).toEqual(['sketch/sketch.cpp'])
    expect(await git.stage(['sketch/sketch.cpp'])).toEqual({ ok: true })
    expect(await git.fileDiff('sketch/sketch.cpp', 'staged')).toMatchObject({ newContent: 'sketch\n' })
    expect(await git.fileDiff('hidden.cpp', 'staged')).toBeNull()
    expect((await git.stage(['hidden.cpp'])).ok).toBe(false)
    for (const result of [await git.commit('Unsafe hidden commit'), await git.switchBranch('other'), await git.createBranch('unsafe'), await git.push(), await git.fetch(), await git.pull()]) {
      expect(result.error).toContain('repository root')
    }
    expect(command(repo, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    expect(command(repo, 'branch', '--show-current').trim()).toBe('main')
    expect(command(repo, 'diff', '--cached', '--name-only')).toBe('hidden.cpp\nsketch/sketch.cpp\n')
  })

  it('stages, compares, unstages and commits exact disk content, preserving further working edits', async () => {
    initialCommit()
    writeFileSync(join(repo, 'firmware.cpp'), 'staged\n')
    expect(await git.stage(['firmware.cpp'])).toEqual({ ok: true })
    writeFileSync(join(repo, 'firmware.cpp'), 'working\n')
    expect((await git.status()).files[0]).toMatchObject({ path: 'firmware.cpp', index: 'M', worktree: 'M' })
    expect(await git.fileDiff('firmware.cpp', 'staged')).toMatchObject({ oldContent: 'initial\n', newContent: 'staged\n' })
    expect(await git.fileDiff('firmware.cpp', 'unstaged')).toMatchObject({ oldContent: 'staged\n', newContent: 'working\n' })
    expect(await git.unstage(['firmware.cpp'])).toEqual({ ok: true })
    expect(readFileSync(join(repo, 'firmware.cpp'), 'utf8')).toBe('working\n')
    await git.stage(['firmware.cpp'])
    expect(await git.commit('Working firmware\n\nLiteral $(not a command); text')).toEqual({ ok: true })
    expect((await git.status()).files).toEqual([])
    expect(command(repo, 'log', '-1', '--format=%B')).toContain('Literal $(not a command); text')
  })

  it('supports names with spaces and leading dashes without staging unrelated files', async () => {
    writeFileSync(join(repo, '-firmware with spaces.cpp'), 'firmware\n')
    writeFileSync(join(repo, 'unrelated.cpp'), 'leave alone\n')
    expect(await git.stage(['-firmware with spaces.cpp'])).toEqual({ ok: true })
    expect(command(repo, 'diff', '--cached', '--name-only')).toBe('-firmware with spaces.cpp\n')
  })

  it('treats Git pathspec magic and wildcards literally instead of staging the whole project', async () => {
    writeFileSync(join(repo, 'unrelated.cpp'), 'leave alone\n')
    expect((await git.stage([':(glob)**'])).ok).toBe(false)
    expect((await git.stage(['*.cpp'])).ok).toBe(false)
    expect(command(repo, 'diff', '--cached', '--name-only')).toBe('')
  })

  it('rejects traversal, absolute paths and Git internals at the mutation boundary', async () => {
    for (const path of ['../outside.cpp', join(repo, 'firmware.cpp'), '.git/config', 'folder/../../other']) {
      expect(await git.stage([path])).toEqual({ ok: false, error: 'Invalid path.' })
    }
    mkdirSync(join(repo, 'nested'))
    expect(await git.stage(['nested'])).toEqual({ ok: false, error: 'Invalid path.' })
  })

  it('keeps an added and subsequently edited file when unstaging before the first commit', async () => {
    writeFileSync(join(repo, 'new.cpp'), 'staged\n')
    await git.stage(['new.cpp'])
    writeFileSync(join(repo, 'new.cpp'), 'working\n')
    expect(await git.unstage(['new.cpp'])).toEqual({ ok: true })
    expect(readFileSync(join(repo, 'new.cpp'), 'utf8')).toBe('working\n')
    expect((await git.status()).files.find((file) => file.path === 'new.cpp')).toMatchObject({ index: '?' })
  })

  it('compares staged renamed files with their original content and unstages both sides', async () => {
    initialCommit()
    renameSync(join(repo, 'firmware.cpp'), join(repo, 'new firmware.cpp'))
    await git.stage(['firmware.cpp', 'new firmware.cpp'])
    const file = (await git.status()).files[0]
    expect(file).toMatchObject({ path: 'new firmware.cpp', index: 'R', orig: 'firmware.cpp' })
    expect(await git.fileDiff(file.path, 'staged', file.orig)).toMatchObject({ oldContent: 'initial\n', newContent: 'initial\n' })
    expect(await git.unstage([file.path, file.orig!])).toEqual({ ok: true })
    expect(command(repo, 'diff', '--cached', '--name-only')).toBe('')
  })

  it('prevents a subfolder view from committing hidden staged sibling files or changing the whole repository branch', async () => {
    initialCommit()
    mkdirSync(join(repo, 'sketch'))
    writeFileSync(join(repo, 'sketch', 'sketch.cpp'), 'sketch\n')
    writeFileSync(join(repo, 'hidden.cpp'), 'not visible\n')
    command(repo, 'add', '--', 'hidden.cpp')
    command(repo, 'branch', 'other')
    setWorkspaceRoot(join(repo, 'sketch'))
    expect(await git.stage(['sketch/sketch.cpp'])).toEqual({ ok: true })
    expect((await git.status()).files.map((file) => file.path)).toEqual(['sketch/sketch.cpp'])
    expect((await git.commit('Unsafe hidden commit')).error).toContain('repository root')
    expect((await git.switchBranch('other')).error).toContain('repository root')
    expect((await git.push()).error).toContain('repository root')
    expect(command(repo, 'rev-list', '--count', 'HEAD').trim()).toBe('1')
    expect(command(repo, 'branch', '--show-current').trim()).toBe('main')
  })

  it('ignores inherited Git repository and index redirects', async () => {
    initialCommit()
    const other = join(temporary, 'other')
    initialize(other)
    writeFileSync(join(repo, 'firmware.cpp'), 'real project\n')
    const names = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']
    const before = names.map((name) => process.env[name])
    try {
      process.env.GIT_DIR = join(other, '.git')
      process.env.GIT_WORK_TREE = other
      process.env.GIT_INDEX_FILE = join(other, 'alternate-index')
      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'core.worktree'
      process.env.GIT_CONFIG_VALUE_0 = other
      expect((await git.status()).files[0].path).toBe('firmware.cpp')
      expect(await git.stage(['firmware.cpp'])).toEqual({ ok: true })
    } finally {
      names.forEach((name, i) => {
        if (before[i] === undefined) delete process.env[name]
        else process.env[name] = before[i]
      })
    }
    expect(command(repo, 'diff', '--cached', '--name-only')).toBe('firmware.cpp\n')
    expect(command(other, 'diff', '--cached', '--name-only')).toBe('')
  })

  it('refuses a diff whose rename origin is outside the open project', async () => {
    initialCommit()
    mkdirSync(join(repo, 'sketch'))
    writeFileSync(join(repo, 'sketch', 'new.cpp'), 'new\n')
    setWorkspaceRoot(join(repo, 'sketch'))
    expect(await git.fileDiff('sketch/new.cpp', 'staged', 'firmware.cpp')).toBeNull()
  })

  it('does not load oversized files or follow a directory link outside the project', async () => {
    writeFileSync(join(repo, 'huge.cpp'), 'x'.repeat(4 * 1024 * 1024 + 1))
    expect(await git.fileDiff('huge.cpp', 'untracked')).toBeNull()
    const outside = join(temporary, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'private.cpp'), 'outside content\n')
    symlinkSync(outside, join(repo, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await git.fileDiff('external/private.cpp', 'untracked')).toBeNull()
    expect((await git.stage(['external/private.cpp'])).ok).toBe(false)
  })

  it('does not execute a repository-configured filesystem monitor while reading status', async () => {
    const marker = join(repo, '.empty-hooks', 'executed')
    const monitor = join(repo, '.empty-hooks', 'monitor.cjs')
    writeFileSync(monitor, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`)
    command(repo, 'config', 'core.fsmonitor', `"${process.execPath}" "${monitor}"`)
    expect((await git.status()).isRepo).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('supports newline and backslash characters in actual POSIX filenames', async () => {
    const name = 'firmware\nback\\slash.cpp'
    writeFileSync(join(repo, name), 'safe literal path\n')
    expect(await git.stage([name])).toEqual({ ok: true })
    expect((await git.status()).files.find((file) => file.path === name)).toBeDefined()
    expect(await git.fileDiff(name, 'staged')).toMatchObject({ newContent: 'safe literal path\n' })
  })

  it('refuses nonexistent and option-like branches and creates a valid local branch', async () => {
    initialCommit()
    for (const name of ['--force', 'missing', 'bad\nbranch']) expect((await git.switchBranch(name)).ok).toBe(false)
    expect((await git.createBranch('bad branch')).ok).toBe(false)
    expect((await git.createBranch('@{-1}')).ok).toBe(false)
    expect(await git.createBranch('feature/motor-control')).toEqual({ ok: true })
    expect((await git.branches()).current).toBe('feature/motor-control')
    expect(await git.switchBranch('main')).toEqual({ ok: true })
  })

  it('reports missing remotes and upstreams rather than appearing to synchronize', async () => {
    initialCommit()
    expect((await git.fetch()).error).toContain('No remote')
    expect((await git.pull()).error).toContain('no upstream')
    expect((await git.push()).ok).toBe(false)
  })

  it('refuses nested initialization and initializes an untracked project locally', async () => {
    expect((await git.init()).error).toContain('already belongs')
    const fresh = join(temporary, 'fresh project')
    mkdirSync(fresh)
    setWorkspaceRoot(fresh)
    expect(await git.init()).toEqual({ ok: true })
    expect(await git.status()).toMatchObject({ isRepo: true, branch: 'main' })
  })

  it('fetches and fast-forwards from an isolated local remote, then refuses dirty and divergent pulls', async () => {
    initialCommit()
    const remote = join(temporary, 'remote.git')
    mkdirSync(remote)
    command(remote, 'init', '--bare', '--initial-branch=main')
    command(repo, 'remote', 'add', 'origin', remote)
    command(repo, 'push', '-u', 'origin', 'main')
    const teammate = join(temporary, 'teammate')
    command(temporary, 'clone', remote, teammate)
    command(teammate, 'config', 'user.name', 'Cortex teammate test')
    command(teammate, 'config', 'user.email', 'teammate@example.invalid')
    command(teammate, 'config', 'commit.gpgsign', 'false')
    command(teammate, 'config', 'core.autocrlf', 'false')
    command(teammate, 'config', 'core.hooksPath', join(repo, '.empty-hooks'))
    writeFileSync(join(teammate, 'firmware.cpp'), 'teammate update\n')
    command(teammate, 'commit', '-am', 'Update firmware')
    command(teammate, 'push')
    expect(await git.fetch()).toEqual({ ok: true })
    expect(await git.status()).toMatchObject({ behind: 1 })
    expect(readFileSync(join(repo, 'firmware.cpp'), 'utf8')).toBe('initial\n')
    writeFileSync(join(repo, 'untracked.cpp'), 'protect this\n')
    expect((await git.pull()).error).toContain('local changes')
    rmSync(join(repo, 'untracked.cpp'))
    expect(await git.pull()).toEqual({ ok: true })
    expect(readFileSync(join(repo, 'firmware.cpp'), 'utf8')).toBe('teammate update\n')
    writeFileSync(join(repo, 'local.cpp'), 'local\n')
    await git.stage(['local.cpp'])
    await git.commit('Local change')
    writeFileSync(join(teammate, 'remote.cpp'), 'remote\n')
    command(teammate, 'add', '--', 'remote.cpp')
    command(teammate, 'commit', '-m', 'Remote change')
    command(teammate, 'push')
    const head = command(repo, 'rev-parse', 'HEAD')
    expect((await git.pull()).ok).toBe(false)
    expect(command(repo, 'rev-parse', 'HEAD')).toBe(head)
    expect(command(repo, 'status', '--porcelain')).toBe('')
  })

  it('pushes only the current upstream branch even when Git defaults to pushing all matching branches', async () => {
    initialCommit()
    const remote = join(temporary, 'remote.git')
    mkdirSync(remote)
    command(remote, 'init', '--bare', '--initial-branch=main')
    command(repo, 'remote', 'add', 'origin', remote)
    command(repo, 'push', '-u', 'origin', 'main')
    command(repo, 'branch', 'other')
    command(repo, 'push', 'origin', 'other')
    const oldOther = command(remote, 'rev-parse', 'refs/heads/other')
    command(repo, 'switch', 'other')
    writeFileSync(join(repo, 'other.cpp'), 'private branch\n')
    command(repo, 'add', '--', 'other.cpp')
    command(repo, 'commit', '-m', 'Do not publish this branch')
    command(repo, 'switch', 'main')
    writeFileSync(join(repo, 'main.cpp'), 'publish this branch\n')
    await git.stage(['main.cpp'])
    await git.commit('Publish only main')
    command(repo, 'config', 'push.default', 'matching')
    expect(await git.push()).toEqual({ ok: true })
    expect(command(remote, 'rev-parse', 'refs/heads/main')).toBe(command(repo, 'rev-parse', 'HEAD'))
    expect(command(remote, 'rev-parse', 'refs/heads/other')).toBe(oldOther)
  })
})
