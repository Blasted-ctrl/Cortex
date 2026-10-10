import { build, type Plugin } from 'vite'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { builtinModules, createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Vitest's transform server does not implement electron-vite's modulePath
 * imports. Build the same real worker in owned Temp; only its path is adapted. */
export function pdfWorkerTestPath(): Plugin {
  let directory: string | undefined
  let built: Promise<string> | undefined
  const workerSource = resolve(__dirname, '../src/main/services/pdfParserWorker.ts')
  const buildWorker = async (): Promise<string> => {
    const parserModule = pathToFileURL(createRequire(import.meta.url).resolve('pdf2json')).href
    directory = await fs.mkdtemp(join(tmpdir(), 'cortex-pdf-worker-build-'))
    await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        outDir: directory,
        emptyOutDir: false,
        lib: { entry: workerSource, formats: ['cjs'], fileName: () => 'pdfParserWorker.cjs' },
        rollupOptions: {
          external: (id) => id === 'pdf2json' || id.startsWith('node:') || builtinModules.includes(id),
          output: { paths: { pdf2json: parserModule } }
        }
      }
    })
    return join(directory, 'pdfParserWorker.cjs')
  }
  return {
    name: 'test:pdf-worker-path',
    enforce: 'pre',
    resolveId(id) {
      if (id.endsWith('/pdfParserWorker?modulePath')) return '\0test:pdf-worker-path'
    },
    async load(id) {
      if (id !== '\0test:pdf-worker-path') return
      built ??= buildWorker()
      return `export default ${JSON.stringify(await built)}`
    },
    async closeBundle() {
      if (directory) await fs.rm(directory, { recursive: true, force: true })
    }
  }
}
