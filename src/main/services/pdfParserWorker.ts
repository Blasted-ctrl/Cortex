import { promises as fs } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { isAbsolute } from 'node:path'
import { assemblePdfText, validatePdfExtractResult, MAX_PDF_BYTES, MAX_PDF_PAGES, type PdfExtractResult } from './pdfTextLayout'

async function extract(): Promise<PdfExtractResult> {
  const input: unknown = workerData
  if (typeof input !== 'string' || !isAbsolute(input)) return { ok: false, error: 'Could not read the PDF: an absolute file path is required.' }
  let mod: typeof import('pdf2json')
  try {
    mod = await import('pdf2json')
  } catch {
    return { ok: false, error: 'PDF support is not available in this build.' }
  }
  try {
    const stat = await fs.stat(input)
    if (!stat.isFile()) return { ok: false, error: 'Could not read the PDF: the selected path is not a file.' }
    if (stat.size > MAX_PDF_BYTES) return { ok: false, error: `PDF is too large to import (${stat.size} bytes).` }
  } catch (error) {
    return { ok: false, error: `Could not read the PDF: ${error instanceof Error ? error.message : String(error)}` }
  }
  const parser = new mod.default(null, false)
  try {
    const data = await new Promise<unknown>((resolve, reject) => {
      let pages = 0
      parser.on('data', (page) => {
        if (page && ++pages > MAX_PDF_PAGES) reject(new Error('PDF exceeds the 400 pages import limit.'))
      })
      parser.on('pdfParser_dataError', (error) => reject(error instanceof Error ? error : error.parserError))
      parser.on('pdfParser_dataReady', resolve)
      void parser.loadPDF(input).catch(reject)
    })
    return assemblePdfText(data)
  } catch (error) {
    return { ok: false, error: `Could not parse the PDF: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    parser.removeAllListeners()
    parser.destroy()
  }
}

void extract().then((result) => parentPort?.postMessage(validatePdfExtractResult(result))).catch((error: unknown) => {
  parentPort?.postMessage(validatePdfExtractResult({ ok: false, error: `Could not parse the PDF: ${error instanceof Error ? error.message : String(error)}` }))
}).finally(() => parentPort?.close())
