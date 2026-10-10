import type { Worker } from 'node:worker_threads'
import { validatePdfExtractResult, type PdfExtractResult } from './pdfTextLayout'

const EXTRACT_TIMEOUT_MS = 25_000

export function waitForPdfWorker(worker: Worker): Promise<PdfExtractResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = async (result: PdfExtractResult): Promise<void> => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        await worker.terminate()
        resolve(result)
      } catch (error) {
        resolve({ ok: false, error: `Could not stop the PDF parser: ${error instanceof Error ? error.message : String(error)}` })
      } finally {
        worker.removeListener('message', onMessage)
        worker.removeListener('messageerror', onMessageError)
        worker.removeListener('error', onError)
        worker.removeListener('exit', onExit)
      }
    }
    const onMessage = (message: unknown): void => { void finish(validatePdfExtractResult(message)) }
    const onMessageError = (): void => { void finish({ ok: false, error: 'Could not parse the PDF: invalid worker message.' }) }
    const onError = (error: Error): void => { void finish({ ok: false, error: `Could not parse the PDF: ${error.message}` }) }
    const onExit = (code: number): void => { void finish({ ok: false, error: `Could not parse the PDF: worker exited (${code}) without a result.` }) }
    const timer = setTimeout(() => { void finish({ ok: false, error: 'Could not parse the PDF: PDF parsing timed out.' }) }, EXTRACT_TIMEOUT_MS)
    worker.on('message', onMessage)
    worker.on('messageerror', onMessageError)
    worker.on('error', onError)
    worker.on('exit', onExit)
  })
}
