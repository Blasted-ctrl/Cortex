import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFile } from '../src/main/services/fsService'
import { langFromPath } from '../src/shared/languages'

/**
 * A bare utf8 read opened .bin/.elf/.o/.png as editable mojibake, and saving
 * that tab wrote U+FFFD back over the artifact. The reader must report what it
 * found so the UI can refuse to mount an editor.
 */
describe('readFile binary guard', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortex-read-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads normal source as text', async () => {
    const p = join(dir, 'main.cpp')
    writeFileSync(p, 'int main() { return 0; }\n')
    const r = await readFile(p)
    expect(r.kind).toBe('text')
    if (r.kind === 'text') expect(r.content).toContain('int main')
  })

  it('refuses a file containing a NUL byte', async () => {
    const p = join(dir, 'firmware.elf')
    writeFileSync(p, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01, 0x02, 0x03]))
    expect((await readFile(p)).kind).toBe('binary')
  })

  it('still reads an empty file as text', async () => {
    const p = join(dir, 'empty.txt')
    writeFileSync(p, '')
    const r = await readFile(p)
    expect(r.kind).toBe('text')
    if (r.kind === 'text') expect(r.content).toBe('')
  })

  it('refuses invalid UTF-8 instead of replacing bytes on the next save', async () => {
    const p = join(dir, 'legacy.cpp')
    writeFileSync(p, Buffer.from([0x2f, 0x2f, 0x20, 0xe9, 0x0a]))
    expect((await readFile(p)).kind).toBe('binary')
  })

  it('preserves a UTF-8 BOM and a literal replacement character', async () => {
    const p = join(dir, 'unicode.cpp')
    const content = '\ufeff// \ufffd is intentional\n'
    writeFileSync(p, content)
    expect(await readFile(p)).toEqual({ kind: 'text', content })
  })

  it('reads a .hex file, which is ASCII despite being firmware', async () => {
    const p = join(dir, 'blink.hex')
    writeFileSync(p, ':100000000C9434000C943E000C943E000C943E0082\n:00000001FF\n')
    expect((await readFile(p)).kind).toBe('text')
  })

  it('detects a NUL that appears after the first line', async () => {
    const p = join(dir, 'mixed.dat')
    writeFileSync(p, Buffer.concat([Buffer.from('looks like text\n'), Buffer.from([0x00, 0xff])]))
    expect((await readFile(p)).kind).toBe('binary')
  })

  it('detects a NUL far past any leading sniff window', async () => {
    // A PDF/tar whose first pages are ASCII would pass an 8KB-only sniff and
    // then be decoded lossily; the scan must cover the whole buffer.
    const p = join(dir, 'doc.pdf')
    const asciiPrologue = Buffer.from('%PDF-1.7\n' + 'x'.repeat(64 * 1024) + '\n')
    writeFileSync(p, Buffer.concat([asciiPrologue, Buffer.from([0x00, 0x01, 0x02])]))
    expect((await readFile(p)).kind).toBe('binary')
  })

  it('does not misreport a large all-text file as binary', async () => {
    const p = join(dir, 'big.txt')
    writeFileSync(p, 'line of text\n'.repeat(20000))
    expect((await readFile(p)).kind).toBe('text')
  })
})

describe('ancillary file grammars', () => {
  it('highlights the non-code files an embedded repo is full of', () => {
    const cases: Array<[string, string]> = [
      ['README.md', 'markdown'],
      ['ci.yml', 'yaml'],
      ['config.yaml', 'yaml'],
      ['platformio.ini', 'ini'],
      ['manifest.xml', 'xml'],
      ['flash.sh', 'shell'],
      ['tsconfig.json', 'json']
    ]
    for (const [file, monaco] of cases) {
      expect(langFromPath(file).monaco, file).toBe(monaco)
    }
  })

  it('leaves genuinely unknown files as plaintext', () => {
    expect(langFromPath('notes.xyz').monaco).toBe('plaintext')
  })
})
