import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractPdf, isPdfAvailable, joinLineRuns } from '../src/main/services/pdfExtractor'
import { makePdf } from './makePdf'

/**
 * Integration test for the PDF adapter against a real, generated PDF (pdf2json
 * runs for real - no mock). Verifies text extraction, PAGE + line provenance,
 * and the honest empty-result path for a no-text (scanned-like) PDF.
 */

let d: string
beforeEach(async () => {
  d = await fs.mkdtemp(join(tmpdir(), 'cortex-pdf-'))
})
afterEach(async () => {
  await fs.rm(d, { recursive: true, force: true }).catch(() => {})
})

async function writePdf(name: string, pages: string[][]): Promise<string> {
  const p = join(d, name)
  await fs.writeFile(p, makePdf(pages))
  return p
}

describe('pdfExtractor', () => {
  it('is available (pdf2json loads)', async () => {
    expect(await isPdfAvailable()).toBe(true)
  })

  it('extracts text with page and line provenance from a multi-page PDF', async () => {
    const p = await writePdf('mpu.pdf', [
      ['MPU6050 Power Management', 'PWR_MGMT_1 register at 0x6B', 'Clear the SLEEP bit to wake the device'],
      ['I2C Address', 'The address is 0x68 or 0x69 when AD0 is high']
    ])
    const res = await extractPdf(p)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // Every section carries a 1-based page and a line into the assembled text.
    expect(res.sections.length).toBeGreaterThanOrEqual(2)
    expect(res.sections.every((s) => (s.page ?? 0) >= 1 && s.line >= 1)).toBe(true)
    expect(new Set(res.sections.map((s) => s.page))).toEqual(new Set([1, 2]))
    // Content is present and page-attributed.
    const p1 = res.sections.filter((s) => s.page === 1).map((s) => s.text).join('\n')
    const p2 = res.sections.filter((s) => s.page === 2).map((s) => s.text).join('\n')
    expect(p1).toContain('PWR_MGMT_1')
    expect(p1).toContain('0x6B')
    expect(p2).toContain('0x68')
    // A section's line indexes into the assembled text at the section's start.
    const textLines = res.text.split('\n')
    const s0 = res.sections[0]
    expect(textLines[s0.line - 1]).toBe(s0.text.split('\n')[0])
  })

  it('reports an honest empty result for a PDF with no text layer', async () => {
    const p = await writePdf('scanned.pdf', [[]]) // a page with no text runs
    const res = await extractPdf(p)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/no extractable text|scanned|image-only/i)
  })

  it('fails gracefully on a missing / non-PDF file', async () => {
    expect((await extractPdf(join(d, 'nope.pdf'))).ok).toBe(false)
    const junk = join(d, 'junk.pdf')
    await fs.writeFile(junk, 'this is not a pdf at all')
    expect((await extractPdf(junk)).ok).toBe(false)
  })

  it('does not corrupt literal %XX text (pdf2json v4 is already plain UTF-8)', async () => {
    // The regression: decodeURIComponent would turn 0x%02X into 0x<STX>X and %2d
    // into '-'. Text must come out byte-identical to the page.
    const p = await writePdf('regs.pdf', [['Set format printf 0x%02X and %2d and 100% done']])
    const res = await extractPdf(p)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.text).toContain('0x%02X')
    expect(res.text).toContain('%2d')
    expect(res.text).toContain('100% done')
    expect(res.text.includes('\u0002')).toBe(false) // no injected STX control byte
  })

  it('refuses more than 400 pages instead of silently importing a partial document', async () => {
    const p = await writePdf('over-page-limit.pdf', Array.from({ length: 401 }, (_, page) => [`Page ${page + 1} register data`]))
    const res = await extractPdf(p)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toMatch(/400 pages|page limit/i)
  })

  it('refuses a file above the 20 MiB input bound before parsing', async () => {
    const p = join(d, 'oversized.pdf')
    const file = await fs.open(p, 'w')
    try {
      await file.truncate(20 * 1024 * 1024 + 1)
    } finally {
      await file.close()
    }
    const res = await extractPdf(p)
    expect(res).toMatchObject({ ok: false })
    if (res.ok) return
    expect(res.error).toMatch(/too large.*20971521/i)
  })
})

describe('joinLineRuns (gap-aware token reconstruction)', () => {
  const run = (x: number, w: number, T: string): { x: number; y: number; w: number; R: { T: string }[] } => ({ x, y: 1, w, R: [{ T }] })

  it('merges kerning-split runs of one token but spaces genuine word breaks', () => {
    // "0x" then "68" directly adjacent (gap 0) -> "0x68"; a wide gap -> a space.
    expect(joinLineRuns([run(0, 0.5, '0x'), run(0.5, 0.5, '68')])).toBe('0x68')
    expect(joinLineRuns([run(0, 0.5, 'Vdd'), run(2, 0.5, 'max')])).toBe('Vdd max')
  })

  it('orders runs left-to-right regardless of input order', () => {
    expect(joinLineRuns([run(2, 0.5, 'max'), run(0, 0.5, 'Vdd')])).toBe('Vdd max')
  })
})
