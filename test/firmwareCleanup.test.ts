import { afterEach, describe, expect, it, vi } from 'vitest'

// On Windows a firmware executable that has just exited can stay locked briefly, and
// deleting the scratch directory fails with EPERM. That happened in a real desktop run
// and turned three finished scenarios into "Firmware tests failed to run".
const rm = vi.fn()
vi.mock('node:fs/promises', async (original) => ({ ...(await original<typeof import('node:fs/promises')>()), rm }))

const { disposePrepared } = await import('../src/main/firmwareTesting/runner')
const prepared = { directory: 'C:\\Temp\\cortex-firmware-test-x' } as Parameters<typeof disposePrepared>[0]

afterEach(() => rm.mockReset())

describe('scenario scratch cleanup', () => {
  it('retries transient Windows locks instead of giving up on the first EPERM', async () => {
    rm.mockResolvedValue(undefined)
    await disposePrepared(prepared)
    expect(rm).toHaveBeenCalledWith(prepared.directory, expect.objectContaining({ recursive: true, force: true, maxRetries: 5 }))
  })

  it('does not fail a finished run when the directory still cannot be removed', async () => {
    rm.mockRejectedValue(Object.assign(new Error("EPERM: operation not permitted, unlink 'sim.exe'"), { code: 'EPERM' }))
    await expect(disposePrepared(prepared)).resolves.toBeUndefined()
  })
})
