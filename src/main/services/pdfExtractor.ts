import { Worker } from 'node:worker_threads'
import workerPath from './pdfParserWorker?modulePath'
import { waitForPdfWorker } from './pdfWorkerRunner'
import type { PdfExtractResult } from './pdfTextLayout'

export { joinLineRuns } from './pdfTextLayout'
export type { PdfExtractResult } from './pdfTextLayout'

let availability: Promise<boolean> | null = null

/** Cache only successful optional-module loads, so transient failures can retry. */
export function isPdfAvailable(): Promise<boolean> {
  if (!availability) {
    availability = import('pdf2json')
      .then(() => true)
      .catch(() => {
        availability = null
        return false
      })
  }
  return availability
}

/** Parsing and text reconstruction never run on Electron's main thread. */
export async function extractPdf(absPath: string): Promise<PdfExtractResult> {
  try {
    return await waitForPdfWorker(new Worker(workerPath, {
      workerData: absPath,
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    }))
  } catch (error) {
    return { ok: false, error: `Could not start the PDF parser: ${error instanceof Error ? error.message : String(error)}` }
  }
}
