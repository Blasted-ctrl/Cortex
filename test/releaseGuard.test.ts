import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import testConfig from '../vitest.config.mts'
const require = createRequire(import.meta.url)
const { verifyRelease } = require('../scripts/release-guard.cjs')
const { FileMatcher } = require('app-builder-lib/out/fileMatcher')
const { load } = require('js-yaml')
const config = { repository: 'Blasted-ctrl/Cortex', tag: 'v0.1.0', token: 'fixture-not-a-real-token' }
describe('native compiler scheduling', () => {
  it('does not multiply within-file native compiler jobs', () => {
    expect(testConfig).toHaveProperty('test.maxConcurrency', 1)
  })
  it('prevents test files from competing for native compiler resources', () => {
    expect(testConfig).toHaveProperty('test.fileParallelism', false)
  })
})
describe('fail-closed release publication guard', () => {
  it.each([[404, {}, 'absent'], [200, { draft: true }, 'draft']])('allows only verified absence or draft (%i)', async (status, body, expected) => {
    const fetchImpl = vi.fn().mockResolvedValue({ status, json: async () => body })
    await expect(verifyRelease({ ...config, fetchImpl })).resolves.toBe(expected)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.github.com/repos/Blasted-ctrl/Cortex/releases/tags/v0.1.0')
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('error')
  })
  it.each([401, 403, 429, 500, 503, 302])('blocks ambiguous or failed HTTP %i', async (status) => {
    await expect(verifyRelease({ ...config, fetchImpl: async () => ({ status }) })).rejects.toThrow('refusing to publish')
  })
  it.each([{ draft: false }, {}, { draft: 'true' }])('does not accept a published or malformed release %#', async (body) => {
    await expect(verifyRelease({ ...config, fetchImpl: async () => ({ status: 200, json: async () => body }) })).rejects.toThrow('already has a published release')
  })
  it('blocks a network failure', async () => {
    await expect(verifyRelease({ ...config, fetchImpl: async () => { throw new Error('network') } })).rejects.toThrow('network')
  })
  it('validates repository before sending credentials', async () => {
    const fetchImpl = vi.fn()
    await expect(verifyRelease({ ...config, repository: '../evil', fetchImpl })).rejects.toThrow('configuration')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('manual publication safety', () => {
  const root = resolve(__dirname, '..')
  const manifest = () => JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  const packaging = () => load(readFileSync(resolve(root, 'electron-builder.yml'), 'utf8'))
  let npmDirectory = ''
  let npmCli = ''
  beforeAll(() => {
    npmDirectory = mkdtempSync(join(tmpdir(), 'cortex-manual-release-npm-'))
    mkdirSync(join(npmDirectory, 'bin'))
    writeFileSync(join(npmDirectory, 'package.json'), JSON.stringify({ name: 'npm' }))
    writeFileSync(join(npmDirectory, 'bin', 'npm-cli.js'), '// Owned fixture; never executed.\n')
    npmCli = realpathSync(join(npmDirectory, 'bin', 'npm-cli.js'))
  })
  afterAll(() => { if (npmDirectory) rmSync(npmDirectory, { recursive: true, force: true }) })
  const env = () => ({
    npm_execpath: npmCli,
    GH_TOKEN: 'fixture-not-a-real-token',
    PATH: 'fixture-only-path'
  })
  const manualRelease = (options: Record<string, unknown>) => require('../scripts/manual-release.cjs').manualRelease(options)
  const plan = (metadata: unknown, configuration: unknown, environment = env(), argv: string[] = []) =>
    require('../scripts/manual-release.cjs').releasePlan(metadata, configuration, environment, argv)
  const success = () => ({ status: 0, signal: null })
  const absentOrEmptyList = async (url: string) => url.endsWith('/releases?per_page=100')
    ? { status: 200, json: async () => [] }
    : { status: 404 }

  it('routes release through verification and prevents distribution commands from auto-publishing', () => {
    const scripts = manifest().scripts
    expect(scripts.release).toBe('node scripts/manual-release.cjs')
    for (const name of ['dist', 'dist:win', 'dist:dir']) expect(scripts[name], name).toContain('--publish never')
    expect(packaging().publish).toEqual({ provider: 'github', owner: 'Blasted-ctrl', repo: 'Cortex', releaseType: 'draft' })
  })

  it.each([404, 200])('passes every gate before checking the exact tag and publishing only a draft (%i)', async status => {
    const order: string[] = []
    const runCommand = vi.fn((command: string, args: string[]) => {
      order.push(args[0] === env().npm_execpath ? (args[1] === 'run' ? args[2] : args[1]) : 'builder')
      return success()
    })
    const fetchImpl = vi.fn(async (url: string) => {
      order.push('guard')
      if (url.endsWith('/releases?per_page=100')) return { status: 200, json: async () => status === 200 ? [{ tag_name: 'v0.1.0', draft: true }] : [] }
      return { status: url.endsWith('/v0.1.0') ? status : 404, json: async () => ({ draft: true }) }
    })
    await expect(manualRelease({ argv: [], env: env(), runCommand, fetchImpl })).resolves.toEqual(success())
    expect(order.slice(0, 6)).toEqual(['typecheck', 'test', 'audit', 'build', 'guard', 'guard'])
    expect(runCommand.mock.calls).toHaveLength(5)
    expect(runCommand.mock.calls[0].slice(0, 2)).toEqual([process.execPath, [env().npm_execpath, 'run', 'typecheck']])
    expect(runCommand.mock.calls[1][1]).toEqual([env().npm_execpath, 'test'])
    expect(runCommand.mock.calls[2][1]).toEqual([env().npm_execpath, 'audit', '--include=dev', '--include=optional', '--audit-level=high'])
    expect(runCommand.mock.calls[3][1]).toEqual([env().npm_execpath, 'run', 'build'])
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual([
      'https://api.github.com/repos/Blasted-ctrl/Cortex/releases/tags/v0.1.0',
      'https://api.github.com/repos/Blasted-ctrl/Cortex/releases/tags/0.1.0',
      'https://api.github.com/repos/Blasted-ctrl/Cortex/releases?per_page=100'
    ])
    const invocation = runCommand.mock.calls[4] as unknown as [string, string[], { env: Record<string, string>; cwd: string; shell: boolean }]
    expect(invocation[0]).toBe(process.execPath)
    expect(invocation[1]).toContain('--publish=always')
    expect(invocation[1]).toContain('--config.publish.provider=github')
    expect(invocation[1]).toContain('--config.publish.owner=Blasted-ctrl')
    expect(invocation[1]).toContain('--config.publish.repo=Cortex')
    expect(invocation[1]).toContain('--config.publish.releaseType=draft')
    expect(invocation[1]).toContain('--config.publish.vPrefixedTagName=true')
    expect(invocation[1]).toContain('--config.extraMetadata.version=0.1.0')
    expect(invocation[2].env.EP_DRAFT).toBe('true')
    expect(invocation[2].cwd).toBe(root)
    expect(invocation[2].shell).toBe(false)
  })

  it.each([0, 1, 2, 3])('stops after a failed gate without lookup or publication (stage %i)', async failed => {
    let calls = 0
    const runCommand = vi.fn(() => ++calls === failed + 1 ? { status: 17, signal: null } : success())
    const fetchImpl = vi.fn()
    await expect(manualRelease({ argv: [], env: env(), runCommand, fetchImpl })).resolves.toEqual({ status: 17, signal: null })
    expect(runCommand).toHaveBeenCalledTimes(failed + 1)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it.each([{ status: null, signal: 'SIGTERM' }, { status: null, signal: null, error: new Error('fixture private vendor error') }])('stops on child signal or spawn failure (%#)', async result => {
    const runCommand = vi.fn(() => result)
    const fetchImpl = vi.fn()
    const outcome = await manualRelease({ argv: [], env: env(), runCommand, fetchImpl })
    expect(outcome).toEqual(result.signal ? { status: null, signal: 'SIGTERM' } : { status: 1, signal: null })
    expect(runCommand).toHaveBeenCalledOnce()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('propagates a failed publisher exit without continuing', async () => {
    let calls = 0
    const runCommand = vi.fn(() => ++calls === 5 ? { status: 23, signal: null } : success())
    await expect(manualRelease({ argv: [], env: env(), runCommand, fetchImpl: absentOrEmptyList })).resolves.toEqual({ status: 23, signal: null })
    expect(runCommand).toHaveBeenCalledTimes(5)
  })

  it.each([401, 403, 429, 500, 302])('does not publish after failed release lookup HTTP %i', async status => {
    const runCommand = vi.fn(success)
    await expect(manualRelease({ argv: [], env: env(), runCommand, fetchImpl: async () => ({ status }) })).rejects.toThrow(/refusing to publish/)
    expect(runCommand).toHaveBeenCalledTimes(4)
  })

  it.each([{ draft: false }, {}, { draft: 'true' }])('blocks published or malformed API responses (%#)', async body => {
    const runCommand = vi.fn(success)
    await expect(manualRelease({ argv: [], env: env(), runCommand, fetchImpl: async () => ({ status: 200, json: async () => body }) })).rejects.toThrow(/published/)
    expect(runCommand).toHaveBeenCalledTimes(4)
  })

  it('blocks network errors without exposing credential-bearing vendor details', async () => {
    const runCommand = vi.fn(success)
    await expect(manualRelease({ argv: [], env: env(), runCommand, fetchImpl: async () => { throw new Error('https://fixture-secret@example.invalid/private') } })).rejects.toThrow('Release lookup failed or the tag is already published; refusing to publish.')
    expect(runCommand).toHaveBeenCalledTimes(4)
  })

  it('refuses an alternate bare-version draft that the installed publisher could adopt', async () => {
    const runCommand = vi.fn(success)
    const fetchImpl = async (url: string) => url.endsWith('/releases?per_page=100')
      ? { status: 200, json: async () => [] }
      : { status: url.endsWith('/v0.1.0') ? 404 : 200, json: async () => ({ draft: true }) }
    await expect(manualRelease({ argv: [], env: env(), runCommand, fetchImpl })).rejects.toThrow(/alternate/)
    expect(runCommand).toHaveBeenCalledTimes(4)
  })

  it.each([
    [{ tag_name: '0.1.0', draft: true }], [{ tag_name: '0.1.0', draft: false }],
    [{ tag_name: 'v0.1.0', draft: false }], {}, null, [null], [{ draft: true }],
    [{ tag_name: 'v0.1.0', draft: 'true' }]
  ])('refuses unsafe or malformed release listings even when both tag lookups return404 (%#)', async listing => {
    const runCommand = vi.fn(success)
    const fetchImpl = vi.fn(async (url: string) => url.endsWith('/releases?per_page=100') ? { status: 200, json: async () => listing } : { status: 404 })
    await expect(manualRelease({ argv: [], env: env(), runCommand, fetchImpl })).rejects.toThrow(/refusing to publish/)
    expect(runCommand).toHaveBeenCalledTimes(4)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it.each([401, 403, 404, 429, 500, 302])('fails closed on release list HTTP %i after valid tag lookups', async status => {
    const runCommand = vi.fn(success)
    const fetchImpl = async (url: string) => ({ status: url.endsWith('/releases?per_page=100') ? status : 404 })
    await expect(manualRelease({ argv: [], env: env(), runCommand, fetchImpl })).rejects.toThrow(/refusing to publish/)
    expect(runCommand).toHaveBeenCalledTimes(4)
  })

  it('fails closed on a release list network error after valid tag lookups', async () => {
    const runCommand = vi.fn(success)
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/releases?per_page=100')) throw new Error('fixture-secret-network-error')
      return { status: 404 }
    }
    await expect(manualRelease({ argv: [], env: env(), runCommand, fetchImpl })).rejects.toThrow('Release lookup failed or the tag is already published; refusing to publish.')
    expect(runCommand).toHaveBeenCalledTimes(4)
  })

  it('refuses publisher configuration changed during the awaited GitHub lookup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cortex-manual-release-drift-'))
    try {
      writeFileSync(join(directory, 'package.json'), readFileSync(resolve(root, 'package.json')))
      writeFileSync(join(directory, 'electron-builder.yml'), readFileSync(resolve(root, 'electron-builder.yml')))
      const module = { exports: {} as { manualRelease: (options: Record<string, unknown>) => Promise<unknown> } }
      runInNewContext(readFileSync(resolve(root, 'scripts/manual-release.cjs'), 'utf8'), { require: createRequire(resolve(root, 'scripts/manual-release.cjs')), module, __dirname: join(directory, 'scripts'), process, fetch, AbortSignal })
      const runCommand = vi.fn(success)
      const fetchImpl = vi.fn(async (url: string) => {
        writeFileSync(join(directory, 'electron-builder.yml'), 'publish:\n  provider: github\n  owner: elsewhere\n  repo: other\n  releaseType: release\nwin:\n  publish:\n    provider: generic\n    url: https://example.invalid/unvalidated\n')
        return absentOrEmptyList(url)
      })
      await expect(module.exports.manualRelease({ argv: [], env: env(), runCommand, fetchImpl })).rejects.toThrow(/configuration changed/)
      expect(fetchImpl).toHaveBeenCalledTimes(3)
      expect(runCommand).toHaveBeenCalledTimes(4)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it.each([success(), { status: 23, signal: null }, { status: null, signal: 'SIGTERM' }, { status: null, signal: null, error: new Error('fixture spawn error') }])('publishes from an owned immutable configuration and cleans it after child completion (%#)', async childResult => {
    const directory = mkdtempSync(join(tmpdir(), 'cortex-manual-release-snapshot-'))
    try {
      writeFileSync(join(directory, 'package.json'), readFileSync(resolve(root, 'package.json')))
      writeFileSync(join(directory, 'electron-builder.yml'), readFileSync(resolve(root, 'electron-builder.yml')))
      const module = { exports: {} as { manualRelease: (options: Record<string, unknown>) => Promise<unknown> } }
      runInNewContext(readFileSync(resolve(root, 'scripts/manual-release.cjs'), 'utf8'), { require: createRequire(resolve(root, 'scripts/manual-release.cjs')), module, __dirname: join(directory, 'scripts'), process, fetch, AbortSignal })
      let snapshotPath = ''
      let snapshotSource = ''
      let builderArgs: string[] = []
      let builderEnvironment: Record<string, string> = {}
      const runCommand = vi.fn((command: string, args: string[], options: { env: Record<string, string> }) => {
        if (args[0] === env().npm_execpath) return success()
        snapshotPath = args[args.indexOf('--config') + 1]
        builderArgs = args
        builderEnvironment = options.env
        writeFileSync(join(directory, 'electron-builder.yml'), 'publish:\n  provider: github\n  owner: elsewhere\n  repo: other\n  releaseType: release\nwin:\n  publish:\n    provider: generic\n    url: https://example.invalid/unvalidated\n')
        snapshotSource = readFileSync(snapshotPath, 'utf8')
        expect(snapshotPath).not.toBe(join(directory, 'electron-builder.yml'))
        expect(JSON.parse(snapshotSource).publish).toMatchObject({ provider: 'github', owner: 'Blasted-ctrl', repo: 'Cortex', releaseType: 'draft' })
        expect(snapshotSource).not.toContain(env().GH_TOKEN)
        return childResult
      })
      const expected = childResult.error ? { status: 1, signal: null } : childResult
      await expect(module.exports.manualRelease({ argv: [], env: env(), runCommand, fetchImpl: absentOrEmptyList })).resolves.toEqual(expected)
      expect(runCommand).toHaveBeenCalledTimes(5)
      expect(snapshotPath).not.toBe('')
      expect(existsSync(snapshotPath)).toBe(false)
      expect(existsSync(resolve(snapshotPath, '..'))).toBe(false)

      const proofPath = join(directory, 'verified-config.json')
      writeFileSync(proofPath, snapshotSource)
      const { createYargs, configureBuildCommand, normalizeOptions } = require('electron-builder/out/builder')
      const options = normalizeOptions(configureBuildCommand(createYargs()).parse(builderArgs.slice(1)))
      expect(options.config.extends).toBe(snapshotPath)
      const { Packager } = require('app-builder-lib/out/packager')
      const packager = new Packager({ ...options, projectDir: directory, config: { ...options.config, extends: proofPath } })
      await packager.validateConfig()
      const effective = packager.config
      expect(options.publish).toBe('always')
      expect(effective.publish).toEqual({ provider: 'github', owner: 'Blasted-ctrl', repo: 'Cortex', releaseType: 'draft', vPrefixedTagName: true })
      expect(effective.extraMetadata.version).toBe(manifest().version)
      expect(effective.afterPack).toBe(packaging().afterPack)
      expect(effective.directories).toEqual(packaging().directories)
      expect(effective.win.publish).toBeUndefined()
      expect(packager.projectDir).toBe(directory)
      expect(packager.appDir).toBe(directory)
      expect(packager.buildResourcesDir).toBe(resolve(directory, packaging().directories.buildResources))
      expect(resolve(packager.projectDir, effective.directories.output.replace('${version}', manifest().version))).toBe(resolve(directory, 'release', manifest().version))
      expect(resolve(process.cwd(), effective.afterPack)).toBe(resolve(root, 'scripts/bundle-arduino-cli.cjs'))

      const publisherPath = require.resolve('electron-publish/out/gitHubPublisher')
      const exports = {} as { GitHubPublisher: new (...args: unknown[]) => { tag: string; releaseType: string; token: string; _release: { hasValue: boolean } } }
      runInNewContext(readFileSync(publisherPath, 'utf8'), { require: createRequire(publisherPath), exports, module: { exports }, process: { env: builderEnvironment } })
      const publisher = new exports.GitHubPublisher({}, effective.publish, effective.extraMetadata.version, { publish: options.publish })
      expect(publisher.tag).toBe(`v${manifest().version}`)
      expect(publisher.releaseType).toBe('draft')
      expect(publisher.token).toBe(env().GH_TOKEN)
      expect(publisher._release.hasValue).toBe(false)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('uses the publisher-preferred token consistently, without exposing it to verification children', async () => {
    const environment = { ...env(), GITHUB_RELEASE_TOKEN: 'fixture-preferred-token', GITHUB_TOKEN: 'fixture-lower-token', EP_DRAFT: 'false', EP_PRE_RELEASE: 'true' }
    const runCommand = vi.fn(success)
    const fetchImpl = vi.fn(absentOrEmptyList)
    await manualRelease({ argv: [], env: environment, runCommand, fetchImpl })
    for (const call of runCommand.mock.calls.slice(0, 4) as unknown as [string, string[], { env: Record<string, string> }][]) {
      expect(call[2].env.GH_TOKEN).toBeUndefined()
      expect(call[2].env.GITHUB_TOKEN).toBeUndefined()
      expect(call[2].env.GITHUB_RELEASE_TOKEN).toBeUndefined()
    }
    for (const call of fetchImpl.mock.calls as unknown as [string, { headers: { Authorization: string } }][]) expect(call[1].headers.Authorization).toBe('Bearer fixture-preferred-token')
    const builderEnv = (runCommand.mock.calls[4] as unknown as [string, string[], { env: Record<string, string> }])[2].env
    expect(builderEnv.GITHUB_RELEASE_TOKEN).toBe('fixture-preferred-token')
    expect(builderEnv.EP_DRAFT).toBe('true')
  })

  it.each(['compiler', 'audit'])('enforces release verification despite a production-only caller environment (%s)', async gate => {
    const environment = { ...env(), CI: 'false', NODE_ENV: 'production', npm_config_omit: 'dev' }
    const runCommand = vi.fn(success)
    await manualRelease({ argv: [], env: environment, runCommand, fetchImpl: absentOrEmptyList })
    const calls = runCommand.mock.calls as unknown as [string, string[], { env: Record<string, string> }][]
    if (gate === 'compiler') for (const call of calls.slice(0, 4)) expect(call[2].env.CI).toBe('true')
    else expect(calls[2][1]).toEqual([env().npm_execpath, 'audit', '--include=dev', '--include=optional', '--audit-level=high'])
    expect(calls).toHaveLength(5)
  })

  it('does not claim publication was unauthorized when cleanup fails after the publisher ran', async () => {
    const directories: string[] = []
    const realFs = require('node:fs')
    const runCommand = vi.fn(success)
    const module = { exports: {} }
    const nativeRequire = createRequire(resolve(root, 'scripts/manual-release.cjs'))
    const fixtureRequire = Object.assign((specifier: string) => {
      if (specifier === 'node:child_process') return { spawnSync: runCommand }
      if (specifier === 'node:fs') return {
        ...realFs,
        mkdtempSync: (prefix: string) => {
          const directory = realFs.mkdtempSync(prefix)
          directories.push(directory)
          return directory
        },
        rmSync: () => { throw new Error('Fixture cleanup failed after publisher invocation') }
      }
      return nativeRequire(specifier)
    }, { main: module, resolve: nativeRequire.resolve })
    let finish: () => void = () => {}
    const completed = new Promise<void>(resolveCompleted => { finish = resolveCompleted })
    const write = vi.fn((message: string) => { finish() })
    const fixtureProcess = { execPath: process.execPath, argv: [process.execPath, 'manual-release.cjs'], env: env(), stderr: { write }, exitCode: undefined }
    try {
      runInNewContext(readFileSync(resolve(root, 'scripts/manual-release.cjs'), 'utf8'), { require: fixtureRequire, module, __dirname: join(root, 'scripts'), process: fixtureProcess, fetch: absentOrEmptyList, AbortSignal })
      await completed
      expect(runCommand).toHaveBeenCalledTimes(5)
      expect(fixtureProcess.exitCode).toBe(1)
      expect(write).toHaveBeenCalledOnce()
      expect(write.mock.calls[0][0]).toContain('Manual release failed or was refused')
      expect(write.mock.calls[0][0]).not.toContain('No publication was authorized')
      expect(write.mock.calls[0][0]).not.toContain('Fixture cleanup')
    } finally { for (const directory of directories) realFs.rmSync(directory, { recursive: true, force: true }) }
  })

  it.each([
    { GH_REPO: 'somewhere/else' }, { RELEASE_TAG: 'v9.9.9' },
    { GH_TOKEN: '' }, { GH_TOKEN: 'invalid\nprivate-token' }, { npm_execpath: 'npm && other-command' }
  ])('rejects mismatched release identity or unsafe process credentials before any child (%#)', async overrides => {
    const runCommand = vi.fn(success)
    const fetchImpl = vi.fn()
    await expect(manualRelease({ argv: [], env: { ...env(), ...overrides }, runCommand, fetchImpl })).rejects.toThrow(/configuration|token|npm/)
    expect(runCommand).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects forwarded builder or audit overrides before any child', async () => {
    const runCommand = vi.fn(success)
    await expect(manualRelease({ argv: ['--config.publish.owner=elsewhere', '--audit-level=critical'], env: env(), runCommand, fetchImpl: vi.fn() })).rejects.toThrow(/arguments/)
    expect(runCommand).not.toHaveBeenCalled()
  })

  it.each(['v0.1.0', '0.1.0;other-command', '0.1.0\n', '01.1.0'])('rejects invalid or injected package version %j', version => {
    expect(() => plan({ ...manifest(), version }, packaging())).toThrow(/version/)
  })

  it.each([
    { publish: { provider: 'github', owner: 'someone-else', repo: 'Cortex', releaseType: 'draft' } },
    { publish: { provider: 'github', owner: 'Blasted-ctrl', repo: 'Cortex', releaseType: 'release' } },
    { publish: [{ provider: 'github', owner: 'Blasted-ctrl', repo: 'Cortex', releaseType: 'draft' }] },
    { win: { publish: { provider: 'generic', url: 'https://example.invalid' } } },
    { extends: 'other-config.yml' },
    { extraMetadata: { version: '9.9.9' } }
  ])('refuses publisher configuration drift or inherited overrides (%#)', override => {
    expect(() => plan(manifest(), { ...packaging(), ...override })).toThrow(/configuration/)
  })
})

describe('packaged application file selection', () => {
  it('excludes tooling configs, internal notes and previous packages while keeping the built application', () => {
    const root = resolve(__dirname, '..')
    const packaging = load(readFileSync(resolve(root, 'electron-builder.yml'), 'utf8'))
    const matcher = new FileMatcher(root, resolve(root, 'release'), (pattern: string) => pattern, ['**/*', ...packaging.files])
    const includes = matcher.createFilter()
    const fileStat = statSync(resolve(root, 'package.json'))

    for (const name of ['electron.vite', 'vitest']) {
      for (const extension of ['js', 'ts', 'mjs', 'cjs', 'mts', 'cts']) {
        const file = `${name}.config.${extension}`
        expect(includes(resolve(root, file), fileStat), file).toBe(false)
      }
    }
    for (const file of ['.turbo/handoff/session.md', '.claude/settings.json', 'docs/media/cortex-demo.mp4', 'scripts/demo/record-demo.ts',
      'release/0.1.0/win-unpacked/resources/app.asar', 'dist/cortex-setup.exe']) {
      expect(includes(resolve(root, file), fileStat), file).toBe(false)
    }
    for (const file of ['package.json', 'out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
      expect(includes(resolve(root, file), fileStat), file).toBe(true)
    }
  })
})

describe('CI security and compiler prerequisites', () => {
  const workflow = (name: string) => load(readFileSync(resolve(__dirname, '..', '.github', 'workflows', name), 'utf8'))

  it.each(['ci.yml', 'firmware-tests.yml'])('pins checkout and Node actions with credential persistence disabled (%s)', (name) => {
    const definition = workflow(name)
    const job = Object.values(definition.jobs)[0] as { steps: { uses?: string; with?: Record<string, unknown> }[] }
    const checkout = job.steps.find(step => step.uses?.startsWith('actions/checkout@'))
    const node = job.steps.find(step => step.uses?.startsWith('actions/setup-node@'))
    expect(checkout?.uses).toBe('actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683')
    expect(checkout?.with?.['persist-credentials']).toBe(false)
    expect(node?.uses).toBe('actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020')
    expect(node?.with?.['node-version']).toBe('22.20.0')
  })

  it.each(['ci.yml', 'firmware-tests.yml'])('grants only contents read access and bounds job execution (%s)', (name) => {
    const definition = workflow(name)
    expect(definition.permissions).toEqual({ contents: 'read' })
    for (const job of Object.values(definition.jobs) as { 'timeout-minutes': number; 'continue-on-error'?: boolean }[]) {
      expect(job['timeout-minutes']).toBeGreaterThan(0)
      expect(job['timeout-minutes']).toBeLessThanOrEqual(20)
      expect(job['continue-on-error']).not.toBe(true)
    }
  })

  it.each([['ci.yml', 'Test'], ['firmware-tests.yml', 'Unit tests']])('requires a working host g++ before compiler-gated tests (%s)', (name, testStep) => {
    const definition = workflow(name)
    const job = Object.values(definition.jobs)[0] as { steps: { name?: string; run?: string; if?: string; 'continue-on-error'?: boolean }[] }
    const compilerIndex = job.steps.findIndex(step => step.run?.split(/\r?\n/).includes('g++ --version'))
    const testIndex = job.steps.findIndex(step => step.name === testStep)
    expect(compilerIndex).toBeGreaterThanOrEqual(0)
    expect(testIndex).toBeGreaterThan(compilerIndex)
    expect(job.steps[compilerIndex].if).toBeUndefined()
    expect(job.steps[compilerIndex]['continue-on-error']).not.toBe(true)
  })

  it('retains all ordinary CI gates and fails on high/critical dependency findings', () => {
    const definition = workflow('ci.yml')
    expect(definition.on).toHaveProperty('pull_request')
    expect(definition.on.push.branches).toContain('main')
    const steps = definition.jobs.build.steps as { run?: string; if?: string; 'continue-on-error'?: boolean }[]
    for (const command of ['npm ci', 'npm run typecheck', 'npm test', 'npm run build', 'npm audit --audit-level=high']) {
      const step = steps.find(candidate => candidate.run === command)
      expect(step, command).toBeDefined()
      expect(step?.if, command).toBeUndefined()
      expect(step?.['continue-on-error'], command).not.toBe(true)
    }
  })

  it('uses stable CI host labels and prepares Windows/Linux compilers without allowing skipped suites', () => {
    const definition = workflow('ci.yml')
    expect(definition.jobs.build.strategy.matrix.os).toEqual(['ubuntu-24.04', 'windows-2022'])
    const steps = definition.jobs.build.steps as { name?: string; run?: string; if?: string }[]
    expect(steps.find(step => step.name === 'Install Linux host compiler')?.run).toContain('apt-get install --yes g++-14')
    const windows = steps.find(step => step.name === 'Locate Windows host compiler')
    expect(windows?.if).toBe("runner.os == 'Windows'")
    expect(windows?.run).toContain("throw 'A host g++ is required; refusing to skip firmware tests.'")
    expect(windows?.run).toContain('GITHUB_PATH')
  })
})
