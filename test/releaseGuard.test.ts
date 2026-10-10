import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
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

describe('packaged application file selection', () => {
  it('excludes tooling config formats while keeping the built application', () => {
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
