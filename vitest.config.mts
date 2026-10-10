import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { pdfWorkerTestPath } from './test/pdfWorkerBuild'

export default defineConfig({
  plugins: [pdfWorkerTestPath()],
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Native integration files and concurrent shim cases start real compilers.
    // Serialize files and cases to avoid CPU contention on development laptops.
    // File isolation, explicit races within a case and deadlines stay unchanged.
    fileParallelism: false,
    maxConcurrency: 1,
    // Most suites are pure and finish in milliseconds. test/arduinoShim.test.ts
    // spawns a real g++ per case, which is seconds cold and much worse when
    // several compile at once, so the default 5s would fail on a slow machine
    // rather than on a real defect.
    testTimeout: 120_000
  }
})
