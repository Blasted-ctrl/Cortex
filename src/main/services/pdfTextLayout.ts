import type { DatasheetSection } from '../../shared/datasheet'

export const MAX_PDF_BYTES = 20 * 1024 * 1024
export const MAX_PDF_PAGES = 400
export const MAX_PDF_TEXT_BYTES = 8 * 1024 * 1024
const SPACE_GAP = 0.2

export type PdfExtractResult =
  | { ok: true; text: string; sections: DatasheetSection[] }
  | { ok: false; error: string }

interface RawText {
  x: number
  y: number
  w?: number
  R?: { T?: string }[]
}
interface RawPage {
  Texts?: RawText[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tooMuchText(): PdfExtractResult {
  return { ok: false, error: 'PDF text is too large to import (8 MiB text limit).' }
}

function tooMuchResult(): PdfExtractResult {
  return { ok: false, error: 'PDF extraction is too large to import (20 MiB result limit).' }
}

function runText(t: RawText): string {
  return (t.R ?? []).map((r) => r.T ?? '').join('')
}

/** pdf2json v4 text is already UTF-8. Do not decode literal %XX text. */
export function joinLineRuns(runs: RawText[]): string {
  const sorted = [...runs].sort((a, b) => a.x - b.x)
  let out = ''
  let prevEnd: number | null = null
  for (const r of sorted) {
    const s = runText(r)
    if (out !== '') {
      const gap = prevEnd == null ? SPACE_GAP + 1 : r.x - prevEnd
      out += gap < SPACE_GAP ? '' : ' '
    }
    out += s
    prevEnd = typeof r.w === 'number' ? r.x + r.w : null
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim()
}

function pageLines(page: RawPage): { y: number; text: string }[] {
  const byLine = new Map<number, RawText[]>()
  for (const t of page.Texts ?? []) {
    const key = Math.round(t.y * 2) / 2
    const arr = byLine.get(key) ?? []
    arr.push(t)
    byLine.set(key, arr)
  }
  return [...byLine.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([y, ts]) => ({ y, text: joinLineRuns(ts) }))
    .filter((l) => l.text.length > 0)
}

function pageBlocks(lines: { y: number; text: string }[]): string[][] {
  if (lines.length <= 1) return lines.length ? [[lines[0].text]] : []
  const gaps = lines.slice(1).map((l, i) => l.y - lines[i].y).filter((g) => g > 0)
  const sorted = [...gaps].sort((a, b) => a - b)
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 1
  const threshold = Math.max(median * 1.8, median + 0.5)
  const blocks: string[][] = []
  let cur: string[] = [lines[0].text]
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].y - lines[i - 1].y > threshold) {
      blocks.push(cur)
      cur = []
    }
    cur.push(lines[i].text)
  }
  if (cur.length) blocks.push(cur)
  return blocks
}

export function assemblePdfText(data: unknown): PdfExtractResult {
  const malformed = (): PdfExtractResult => ({ ok: false, error: 'Could not parse the PDF: invalid text-layer data.' })
  if (!record(data) || !Array.isArray(data.Pages)) return malformed()
  if (data.Pages.length > MAX_PDF_PAGES) return { ok: false, error: 'PDF exceeds the 400 pages import limit.' }
  const pages: RawPage[] = []
  let rawTextBytes = 0
  for (const page of data.Pages) {
    if (!record(page) || !Array.isArray(page.Texts)) return malformed()
    const texts: RawText[] = []
    for (const t of page.Texts) {
      if (!record(t) || typeof t.x !== 'number' || !Number.isFinite(t.x) || typeof t.y !== 'number' || !Number.isFinite(t.y)) return malformed()
      if (t.w !== undefined && (typeof t.w !== 'number' || !Number.isFinite(t.w))) return malformed()
      if (t.R !== undefined && !Array.isArray(t.R)) return malformed()
      const runs: { T?: string }[] = []
      for (const run of t.R ?? []) {
        if (!record(run) || (run.T !== undefined && typeof run.T !== 'string')) return malformed()
        rawTextBytes += Buffer.byteLength(run.T ?? '', 'utf8')
        if (rawTextBytes > MAX_PDF_TEXT_BYTES) return tooMuchText()
        runs.push({ T: run.T })
      }
      texts.push({ x: t.x, y: t.y, w: t.w, R: runs })
    }
    pages.push({ Texts: texts })
  }

  const outLines: string[] = []
  const sections: DatasheetSection[] = []
  let textBytes = 0
  const addLine = (line: string): boolean => {
    textBytes += Buffer.byteLength(line, 'utf8') + 1
    if (textBytes > MAX_PDF_TEXT_BYTES) return false
    outLines.push(line)
    return true
  }
  for (let p = 0; p < pages.length; p++) {
    const lines = pageLines(pages[p])
    if (!lines.length) {
      if (outLines.length && !addLine('')) return tooMuchText()
      continue
    }
    if (outLines.length && !addLine('')) return tooMuchText()
    for (const block of pageBlocks(lines)) {
      const startLine = outLines.length + 1
      for (const line of block) if (!addLine(line)) return tooMuchText()
      sections.push({ line: startLine, page: p + 1, text: block.join('\n') })
    }
  }
  if (sections.length === 0) return { ok: false, error: 'No extractable text in this PDF. It looks scanned or image-only (OCR is not supported).' }
  const result: PdfExtractResult = { ok: true, text: outLines.join('\n') + '\n', sections }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_PDF_BYTES) return tooMuchResult()
  return result
}

export function validatePdfExtractResult(value: unknown): PdfExtractResult {
  const invalid = (): PdfExtractResult => ({ ok: false, error: 'Could not parse the PDF: invalid worker result.' })
  if (!record(value)) return invalid()
  if (value.ok === false) {
    if (typeof value.error !== 'string' || !value.error || Buffer.byteLength(value.error, 'utf8') > MAX_PDF_TEXT_BYTES) return invalid()
    return { ok: false, error: value.error }
  }
  if (value.ok !== true || typeof value.text !== 'string' || !value.text.endsWith('\n') || !Array.isArray(value.sections) || !value.sections.length) return invalid()
  if (Buffer.byteLength(value.text, 'utf8') > MAX_PDF_TEXT_BYTES) return tooMuchText()
  const sections: DatasheetSection[] = []
  let sectionBytes = 0
  let line = 1
  let offset = 0
  let lastLine = 0
  for (const section of value.sections) {
    if (!record(section) || typeof section.text !== 'string' || !section.text || typeof section.line !== 'number' || !Number.isSafeInteger(section.line) || section.line <= lastLine) return invalid()
    if (typeof section.page !== 'number' || !Number.isSafeInteger(section.page) || section.page < 1 || section.page > MAX_PDF_PAGES) return invalid()
    sectionBytes += Buffer.byteLength(section.text, 'utf8')
    if (sectionBytes > MAX_PDF_TEXT_BYTES) return tooMuchText()
    while (line < section.line) {
      const next = value.text.indexOf('\n', offset)
      if (next < 0) return invalid()
      offset = next + 1
      line++
    }
    if (!value.text.startsWith(section.text, offset) || value.text[offset + section.text.length] !== '\n') return invalid()
    sections.push({ line: section.line, page: section.page, text: section.text })
    lastLine = section.line
  }
  const result: PdfExtractResult = { ok: true, text: value.text, sections }
  return Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_PDF_BYTES ? tooMuchResult() : result
}
