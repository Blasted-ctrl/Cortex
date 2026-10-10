import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
const { verifyRelease } = createRequire(import.meta.url)('../scripts/release-guard.cjs')
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
