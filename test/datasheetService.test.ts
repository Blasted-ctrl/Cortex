import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fsService from '../src/main/services/fsService'
import * as datasheet from '../src/main/services/datasheetService'
import { makePdf } from './makePdf'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: {
  isPackaged: false,
  getPath: (name: string) => {
    if (name !== 'userData' || !electron.userData) throw new Error('Unexpected Electron path')
    return electron.userData
  }
} }))

/**
 * Integration test for the datasheet service's real file IO - the one part not
 * covered by the pure datasheet.test.ts and not reachable via the CDP live check
 * (import opens a native dialog). Uses a real temp workspace so importFile's
 * copy + manifest write, the binary refusal, path sanitization, and search over
 * the stored corpus all run against the actual filesystem.
 */

let ws: string

beforeEach(async () => {
  ws = await fs.mkdtemp(join(tmpdir(), 'cortex-ds-'))
  electron.userData = join(ws, 'owned-user-data')
  fsService.setWorkspaceRoot(ws)
  datasheet.invalidate()
})

afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true }).catch(() => {})
})

const MPU = `# PWR_MGMT_1 (0x6B)
Clear the SLEEP bit (bit 6) to wake the device from sleep.

# I2C address
The address is 0x68, or 0x69 when AD0 is high.`

async function writeSource(name: string, content: string): Promise<string> {
  // A source file OUTSIDE the .cortex corpus (as a user-picked file would be).
  const dir = join(ws, 'downloads')
  await fs.mkdir(dir, { recursive: true })
  const p = join(dir, name)
  await fs.writeFile(p, content, 'utf8')
  return p
}

describe('datasheetService.importFile', () => {
  it('imports and searches documents through an admitted project-root alias', async () => {
    const project = join(ws, 'project')
    const alias = join(ws, 'admitted project alias')
    await fs.mkdir(project)
    await fs.symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir')
    fsService.setWorkspaceRoot(alias)
    expect(await datasheet.importFile(alias, await writeSource('MPU6050.md', MPU))).toMatchObject({ ok: true, deviceKey: 'mpu6050' })
    expect(await fs.readFile(join(project, '.cortex', 'datasheets', 'MPU6050.md'), 'utf8')).toBe(MPU)
    expect((await datasheet.search(alias, 'PWR_MGMT_1 sleep', 5))[0].text).toContain('SLEEP bit')
  })

  it('refuses a corpus directory escaping an admitted project-root alias', async () => {
    const project = join(ws, 'project')
    const outside = join(ws, 'outside')
    const alias = join(ws, 'admitted project alias')
    await fs.mkdir(project)
    await fs.mkdir(join(outside, 'datasheets'), { recursive: true })
    await fs.symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await fs.symlink(outside, join(project, '.cortex'), process.platform === 'win32' ? 'junction' : 'dir')
    fsService.setWorkspaceRoot(alias)
    const corpus = join(outside, 'datasheets')
    await fs.writeFile(join(corpus, 'private.md'), '# Private\nprivatealiasdocument')
    await fs.writeFile(join(corpus, 'manifest.json'), JSON.stringify({ docs: [{ id: 'private', name: 'private', path: '.cortex/datasheets/private.md', kind: 'markdown' }] }))
    expect(await datasheet.importFile(alias, await writeSource('MPU6050.md', MPU))).toMatchObject({ ok: false, error: expect.stringContaining('outside') })
    expect((await fs.readdir(corpus)).sort()).toEqual(['manifest.json', 'private.md'])
    expect(await datasheet.search(alias, 'privatealiasdocument', 5)).toEqual([])
    expect(await fs.readFile(join(corpus, 'private.md'), 'utf8')).toBe('# Private\nprivatealiasdocument')
  })

  it('copies a text doc into .cortex/datasheets, writes a manifest, and auto-links the device', async () => {
    const src = await writeSource('MPU6050.md', MPU)
    const res = await datasheet.importFile(ws, src)
    expect(res.ok).toBe(true)
    expect(res.deviceKey).toBe('mpu6050') // name matched a known device

    const stored = await fs.readFile(join(ws, '.cortex', 'datasheets', 'MPU6050.md'), 'utf8')
    expect(stored).toBe(MPU) // verbatim copy

    const list = await datasheet.list(ws)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'MPU6050.md', path: '.cortex/datasheets/MPU6050.md', kind: 'markdown', deviceKey: 'mpu6050' })
  })

  it('refuses a malformed .pdf with a parse error and stores nothing', async () => {
    const src = await writeSource('scanned.pdf', 'PDFbinary')
    const res = await datasheet.importFile(ws, src)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/parse|extractable|pdf/i)
    // Nothing was stored.
    expect(await datasheet.list(ws)).toEqual([])
  })

  it('refuses a genuine non-text binary (NUL byte) that is not a PDF', async () => {
    const src = await writeSource('logo.png', '\u0000PNG binary data')
    const res = await datasheet.importFile(ws, src)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not a text document/i)
    expect(await datasheet.list(ws)).toEqual([])
  })

  it('sanitizes the stored name so a crafted source name cannot escape the corpus', async () => {
    const src = await writeSource('weird name!.txt', 'analog input on A0')
    const res = await datasheet.importFile(ws, src)
    expect(res.ok).toBe(true)
    const files = await fs.readdir(join(ws, '.cortex', 'datasheets'))
    // No path separators or spaces survived into the stored file name.
    expect(files.some((f) => /[/\\]/.test(f))).toBe(false)
    expect(files).toContain('weird_name_.txt')
  })

  it('extracts a PDF into a stored .txt + sections sidecar, and searches it with page citations', async () => {
    const dir = join(ws, 'downloads')
    await fs.mkdir(dir, { recursive: true })
    const src = join(dir, 'MPU6050.pdf')
    await fs.writeFile(
      src,
      makePdf([
        ['MPU6050 Power Management', 'PWR_MGMT_1 register at 0x6B', 'Clear the SLEEP bit to wake the device'],
        ['I2C Address', 'The address is 0x68 or 0x69 when AD0 is high']
      ])
    )
    const res = await datasheet.importFile(ws, src)
    expect(res.ok).toBe(true)
    expect(res.deviceKey).toBe('mpu6050') // the original .pdf name still auto-links

    // Stored artifacts: a revealable .txt and a sections sidecar; the manifest
    // records kind 'pdf' and points path at the .txt.
    const files = await fs.readdir(join(ws, '.cortex', 'datasheets'))
    expect(files).toContain('MPU6050.pdf.txt')
    expect(files).toContain('MPU6050.pdf.sections.json')
    const list = await datasheet.list(ws)
    expect(list[0]).toMatchObject({ name: 'MPU6050.pdf', kind: 'pdf', path: '.cortex/datasheets/MPU6050.pdf.txt' })

    // Retrieval works and carries PAGE provenance from the PDF.
    const hits = await datasheet.search(ws, 'wake from sleep PWR_MGMT_1', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].citation.page).toBe(1)
    expect(hits[0].text).toContain('PWR_MGMT_1')
    // A page-2 term cites page 2.
    const addr = await datasheet.search(ws, '0x68 AD0 address', 5)
    expect(addr[0].citation.page).toBe(2)
  })

  it('does not let a PDF import clobber a same-stem text document (namespaced artifacts)', async () => {
    // A text "notes.txt" and a PDF "notes.pdf" must coexist, not overwrite (the
    // PDF stores notes.pdf.txt, not notes.txt) - no silent data loss.
    await datasheet.importFile(ws, await writeSource('notes.txt', '# Notes\nkeep these user notes'))
    const dir = join(ws, 'downloads')
    await fs.writeFile(join(dir, 'notes.pdf'), makePdf([['Extracted PDF content about ctrl_meas 0xF4']]))
    const res = await datasheet.importFile(ws, join(dir, 'notes.pdf'))
    expect(res.ok).toBe(true)
    const paths = (await datasheet.list(ws)).map((d) => d.path).sort()
    expect(paths).toEqual(['.cortex/datasheets/notes.pdf.txt', '.cortex/datasheets/notes.txt'])
    // The user's text notes are still readable.
    expect(await fs.readFile(join(ws, '.cortex', 'datasheets', 'notes.txt'), 'utf8')).toContain('keep these user notes')
  })
})

describe('datasheetService.search (over the stored corpus)', () => {
  it('returns cited passages ranked for the query', async () => {
    await datasheet.importFile(ws, await writeSource('MPU6050.md', MPU))
    const hits = await datasheet.search(ws, 'how to wake from sleep, PWR_MGMT_1', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].citation).toMatchObject({ docName: 'MPU6050.md', title: 'PWR_MGMT_1 (0x6B)', line: 1 })
    expect(hits[0].text).toContain('SLEEP bit')
  })

  it('finds a section by a hex address and returns nothing for an unrelated query', async () => {
    await datasheet.importFile(ws, await writeSource('MPU6050.md', MPU))
    expect((await datasheet.search(ws, '0x68', 5))[0].citation.title).toBe('I2C address')
    expect(await datasheet.search(ws, 'brushless motor commutation', 5)).toEqual([])
  })

  it('returns nothing when there is no corpus', async () => {
    expect(await datasheet.search(ws, 'anything', 5)).toEqual([])
    expect(await datasheet.list(ws)).toEqual([])
  })

  it('gives distinct ids to two source names that would slug identically', async () => {
    await datasheet.importFile(ws, await writeSource('mpu-6050.md', MPU))
    await datasheet.importFile(ws, await writeSource('mpu_6050.md', MPU))
    const ids = (await datasheet.list(ws)).map((d) => d.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2) // no id collision (finding 7)
  })
})

/**
 * Security regressions for the confused-deputy defects the review found: the
 * manifest travels with a cloned repo, so it is untrusted. A crafted manifest
 * must not be able to read a file outside .cortex/datasheets (an in-workspace
 * secret, a ../ escape, or a symlink to an external secret) into the corpus.
 */
describe('datasheetService corpus confinement (untrusted manifest)', () => {
  const SECRET = 'SUPER_SECRET_TOKEN_ghp_abcdef123456'

  async function seedManifest(docs: unknown[]): Promise<void> {
    const dir = join(ws, '.cortex', 'datasheets')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify({ docs }), 'utf8')
    datasheet.invalidate()
  }

  it('does not read an in-workspace file the manifest points at outside the corpus dir', async () => {
    await fs.writeFile(join(ws, 'secrets.env'), `API_KEY=${SECRET}`, 'utf8')
    // The manifest path claims a workspace file; only its basename is honored, so
    // it resolves to .cortex/datasheets/secrets.env, which does not exist.
    await seedManifest([{ id: 'x', name: 'notes', path: 'secrets.env', kind: 'text' }])
    const hits = await datasheet.search(ws, SECRET, 5)
    expect(hits).toEqual([])
  })

  it('does not follow a ../ escape in a manifest path', async () => {
    await fs.mkdir(join(ws, '..'), { recursive: true }).catch(() => {})
    await seedManifest([{ id: 'y', name: 'passwd', path: '../../../../etc/passwd', kind: 'text' }])
    // basename('../../../../etc/passwd') = 'passwd' -> .cortex/datasheets/passwd (absent) -> skipped.
    expect(await datasheet.search(ws, 'root daemon bin', 5)).toEqual([])
  })

  it('skips a symlinked corpus entry rather than following it out of the workspace', async () => {
    await fs.writeFile(join(ws, 'external-secret.txt'), SECRET, 'utf8')
    const link = join(ws, '.cortex', 'datasheets', 'leak.md')
    await fs.mkdir(join(ws, '.cortex', 'datasheets'), { recursive: true })
    let symlinkOk = true
    try {
      await fs.symlink(join(ws, 'external-secret.txt'), link)
    } catch {
      symlinkOk = false // Windows without privilege: cannot create a symlink here
    }
    if (!symlinkOk) return // environment cannot exercise this path; unit-tested logic still holds
    await seedManifest([{ id: 'z', name: 'leak.md', path: '.cortex/datasheets/leak.md', kind: 'text' }])
    const hits = await datasheet.search(ws, SECRET, 5)
    expect(hits).toEqual([]) // symlink skipped, secret never indexed
  })

  it('still serves a legitimate corpus doc alongside a rejected malicious entry', async () => {
    await fs.mkdir(join(ws, '.cortex', 'datasheets'), { recursive: true })
    await fs.writeFile(join(ws, '.cortex', 'datasheets', 'MPU6050.md'), MPU, 'utf8')
    await fs.writeFile(join(ws, 'secrets.env'), `API_KEY=${SECRET}`, 'utf8')
    await seedManifest([
      { id: 'good', name: 'MPU6050.md', path: '.cortex/datasheets/MPU6050.md', kind: 'markdown' },
      { id: 'evil', name: 'x', path: 'secrets.env', kind: 'text' }
    ])
    expect((await datasheet.search(ws, 'PWR_MGMT_1 sleep', 5)).length).toBeGreaterThan(0)
    expect(await datasheet.search(ws, SECRET, 5)).toEqual([])
  })

  it('reflects a re-import (cache is invalidated on import)', async () => {
    await datasheet.importFile(ws, await writeSource('MPU6050.md', '# Empty\nnothing relevant here'))
    expect(await datasheet.search(ws, 'PWR_MGMT_1', 5)).toEqual([]) // not in the first version
    await datasheet.importFile(ws, await writeSource('MPU6050.md', MPU)) // overwrite same stored path
    expect((await datasheet.search(ws, 'PWR_MGMT_1', 5)).length).toBeGreaterThan(0) // now present
  })

  // A crafted PDF sidecar must not be able to inject a "verbatim" passage that
  // is not actually in the stored .txt, nor a citation with a bogus line/page.
  it('drops a fabricated PDF sidecar passage not present in the stored .txt', async () => {
    const dir = join(ws, '.cortex', 'datasheets')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'x.pdf.txt'), 'Absolute maximum ratings\nVdd max 3.6V\n', 'utf8')
    await fs.writeFile(
      join(dir, 'x.pdf.sections.json'),
      JSON.stringify([
        { line: 1, page: 1, text: 'Absolute maximum ratings\nVdd max 3.6V' }, // real (substring of .txt)
        { line: 2, page: 9, text: 'Vdd max 12V absolute rating' } // FABRICATED (not in .txt)
      ]),
      'utf8'
    )
    await seedManifest([{ id: 'x.pdf.txt', name: 'x.pdf', path: '.cortex/datasheets/x.pdf.txt', kind: 'pdf', sectionsPath: '.cortex/datasheets/x.pdf.sections.json' }])
    // The real figure is retrievable; the fabricated 12V passage is not served.
    expect((await datasheet.search(ws, 'Vdd max absolute', 5)).some((h) => h.text.includes('3.6V'))).toBe(true)
    expect((await datasheet.search(ws, '12V absolute rating', 5)).some((h) => h.text.includes('12V'))).toBe(false)
  })

  it('drops a PDF sidecar section with a non-positive-integer line/page', async () => {
    const dir = join(ws, '.cortex', 'datasheets')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(join(dir, 'y.pdf.txt'), 'keeperalpha content\nrejectbravo content\n', 'utf8')
    await fs.writeFile(
      join(dir, 'y.pdf.sections.json'),
      JSON.stringify([
        { line: 1, page: 1, text: 'keeperalpha content' },
        { line: -5, page: 1, text: 'rejectbravo content' } // invalid line -> dropped
      ]),
      'utf8'
    )
    await seedManifest([{ id: 'y.pdf.txt', name: 'y.pdf', path: '.cortex/datasheets/y.pdf.txt', kind: 'pdf', sectionsPath: '.cortex/datasheets/y.pdf.sections.json' }])
    expect((await datasheet.search(ws, 'keeperalpha', 5)).length).toBeGreaterThan(0)
    expect(await datasheet.search(ws, 'rejectbravo', 5)).toEqual([]) // the -5 line section was rejected
  })
})
