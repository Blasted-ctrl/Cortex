import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
const require = createRequire(import.meta.url)
const { verifyRelease } = require('../scripts/release-guard.cjs')
const { FileMatcher } = require('app-builder-lib/out/fileMatcher')
const { load } = require('js-yaml')
const config = { repository: 'Blasted-ctrl/Cortex', tag: 'v0.1.0', token: 'fixture-not-a-real-token' }
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

    for (const extension of ['js', 'ts', 'mjs', 'cjs', 'mts', 'cts']) {
      const file = `electron.vite.config.${extension}`
      expect(includes(resolve(root, file), fileStat), file).toBe(false)
    }
    for (const file of ['package.json', 'out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']) {
      expect(includes(resolve(root, file), fileStat), file).toBe(true)
    }
  })
})
