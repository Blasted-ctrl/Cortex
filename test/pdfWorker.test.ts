import { describe, it, expect, afterEach } from 'vitest'
import { Worker } from 'node:worker_threads'
import { waitForPdfWorker } from '../src/main/services/pdfWorkerRunner'
import { assemblePdfText } from '../src/main/services/pdfTextLayout'

const success = { ok: true, text: 'Vdd max 3.6V\n', sections: [{ line: 1, page: 1, text: 'Vdd max 3.6V' }] }
const workers = new Set<Worker>()
const tracked = (worker: Worker): Worker => { workers.add(worker); return worker }
afterEach(async () => {
  await Promise.all([...workers].map((worker) => worker.terminate()))
  workers.clear()
})

describe('PDF worker lifecycle (real Node workers)', () => {
  it.each([
    ['success', success],
    ['parser error', { ok: false, error: 'Could not parse the PDF: invalid xref.' }]
  ])('waits for termination after a %s result, even if the worker stays busy', async (_name, result) => {
    const worker = tracked(new Worker(`require('node:worker_threads').parentPort.postMessage(${JSON.stringify(result)}); while (true) {}`, { eval: true }))
    const res = await waitForPdfWorker(worker)
    expect(res).toEqual(result)
    expect(worker.threadId).toBe(-1)
    expect(worker.listenerCount('message')).toBe(0)
    expect(worker.listenerCount('error')).toBe(0)
    expect(worker.listenerCount('exit')).toBe(0)
  })

  it('returns a failure and releases the worker after an uncaught exception', async () => {
    const worker = tracked(new Worker("throw new Error('isolated parser failure')", { eval: true }))
    expect(await waitForPdfWorker(worker)).toEqual({ ok: false, error: 'Could not parse the PDF: isolated parser failure' })
    expect(worker.threadId).toBe(-1)
  })

  it('does not turn an exit without a result into a successful import', async () => {
    const worker = tracked(new Worker('process.exit(0)', { eval: true }))
    const res = await waitForPdfWorker(worker)
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toMatch(/without.*result/i)
    expect(worker.threadId).toBe(-1)
  })

  it.each([
    null,
    { ok: true, text: 'made up', sections: [{ line: 0, page: 1, text: 'made up' }] },
    { ok: true, text: 'real\n', sections: [{ line: 1, page: 401, text: 'real' }] },
    { ok: true, text: 'real\n', sections: [{ line: 1, page: 1, text: 'fabricated' }] },
    { ok: true, text: 'x'.repeat(8 * 1024 * 1024 + 1), sections: [{ line: 1, page: 1, text: 'x' }] }
  ])('rejects malformed or oversized result %# and stops the worker', async (result) => {
    const worker = tracked(new Worker("require('node:worker_threads').parentPort.postMessage(require('node:worker_threads').workerData); while (true) {}", { eval: true, workerData: result }))
    const res = await waitForPdfWorker(worker)
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toMatch(/invalid|too large|limit/i)
    expect(worker.threadId).toBe(-1)
  })

  it('the independent 25-second deadline terminates a CPU-stuck worker while the main loop stays responsive', async () => {
    const worker = tracked(new Worker('while (true) {}', { eval: true }))
    let heartbeat = 0
    const interval = setInterval(() => { heartbeat++ }, 100)
    const started = performance.now()
    try {
      const res = await waitForPdfWorker(worker)
      expect(res).toEqual({ ok: false, error: 'Could not parse the PDF: PDF parsing timed out.' })
      expect(heartbeat).toBeGreaterThan(0)
      expect(performance.now() - started).toBeGreaterThanOrEqual(25_000)
      expect(worker.threadId).toBe(-1)
      expect(worker.listenerCount('message')).toBe(0)
    } finally {
      clearInterval(interval)
      await worker.terminate()
    }
  })
})

describe('bounded PDF text reconstruction', () => {
  const page = (text: string): { Texts: { x: number; y: number; R: { T: string }[] }[] } => ({ Texts: [{ x: 0, y: 1, R: [{ T: text }] }] })

  it('accepts all 400 pages with exact last-page provenance', () => {
    const res = assemblePdfText({ Pages: Array.from({ length: 400 }, (_, i) => page(`Page ${i + 1}`)) })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.sections).toHaveLength(400)
    expect(res.sections[399]).toEqual({ page: 400, line: 799, text: 'Page 400' })
  })

  it('refuses a text layer above the existing 8 MiB readable-document bound', () => {
    const res = assemblePdfText({ Pages: [page('x'.repeat(8 * 1024 * 1024))] })
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toMatch(/8 MiB|text.*large/i)
  })

  it('accepts the exact 8 MiB text boundary including the trailing newline', () => {
    const res = assemblePdfText({ Pages: [page('x'.repeat(8 * 1024 * 1024 - 1))] })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(Buffer.byteLength(res.text, 'utf8')).toBe(8 * 1024 * 1024)
  })

  it('measures UTF-8 bytes, not just JavaScript string length', () => {
    const res = assemblePdfText({ Pages: [page('\u00e9'.repeat(4 * 1024 * 1024))] })
    expect(res).toMatchObject({ ok: false })
  })

  it('bounds serialized text plus sections before a result crosses into the main thread', () => {
    const res = assemblePdfText({ Pages: [page('"'.repeat(6 * 1024 * 1024))] })
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toMatch(/20 MiB result limit/i)
  })

  it.each([null, {}, { Pages: [{ Texts: [{ x: Number.NaN, y: 1, R: [{ T: 'not real' }] }] }] }])('does not invent text from malformed parser data %#', (data) => {
    const res = assemblePdfText(data)
    expect(res).toMatchObject({ ok: false })
  })

  it('counts the combined pages and their separators, not just each individual page', () => {
    const res = assemblePdfText({ Pages: [page('x'.repeat(4 * 1024 * 1024)), page('y'.repeat(4 * 1024 * 1024))] })
    expect(res).toMatchObject({ ok: false })
  })

  it('keeps an empty middle page honest and preserves literal percent text', () => {
    expect(assemblePdfText({ Pages: [page('0x%02X'), { Texts: [] }, page('100% done')] })).toEqual({
      ok: true,
      text: '0x%02X\n\n\n100% done\n',
      sections: [{ line: 1, page: 1, text: '0x%02X' }, { line: 4, page: 3, text: '100% done' }]
    })
  })
})
