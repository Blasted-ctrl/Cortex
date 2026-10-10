import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Most suites are pure and finish in milliseconds. test/arduinoShim.test.ts
    // spawns a real g++ per case, which is seconds cold and much worse when
    // several compile at once, so the default 5s would fail on a slow machine
    // rather than on a real defect.
    testTimeout: 120_000
  }
})
