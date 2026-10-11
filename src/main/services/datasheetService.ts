import { promises as fs } from 'fs'
import { join, basename, extname } from 'path'
import * as fsService from './fsService'
import { buildProjectModel } from './projectModelService'
import { extractPdf, isPdfAvailable } from './pdfExtractor'
import { buildHardwareGraph, KNOWN_DEVICES, type HardwareGraph } from '../../shared/hardwareGraph'
import { isWithin } from '../../shared/security'
import {
  sectionize,
  buildIndex,
  queryIndex,
  enrichQueryFromGraph,
  matchDeviceForDoc,
  type DatasheetDoc,
  type DatasheetSection,
  type DatasheetHit,
  type DatasheetDocMeta,
  type DatasheetImportResult,
  type DocIndex
} from '../../shared/datasheet'

/**
 * The datasheet / document intelligence gatherer: imports engineering documents
 * into the project, extracts them into sections with line provenance, and serves
 * BM25 retrieval with citations (the scoring/formatting lives in the pure
 * ../../shared/datasheet module; this file does only the file IO and caching).
 *
 * Security: the corpus is confined to <workspace>/.cortex/datasheets/ on the
 * PHYSICAL filesystem, not by a string prefix. The manifest travels with a
 * cloned repo, so it is UNTRUSTED: a corpus read ignores the manifest's path
 * beyond its basename (forcing it into the corpus dir), rejects a symlink via
 * lstat, and requires the corpus dir's realpath to stay inside the workspace -
 * so a crafted manifest cannot read `../etc/passwd`, a workspace file like
 * `src/secrets.h` / `.env`, or a symlink to a secret into the AI context. The
 * ONLY read outside the corpus is the one user-chosen file at import time, whose
 * path comes from a native open dialog invoked in the main process (the
 * DATASHEET_IMPORT handler), never from the renderer or the AI. Imports refuse
 * to write THROUGH a symlink and confine the corpus dir's realpath. Reads are
 * bounded (readFile refuses binaries and oversized files), so a PDF or a huge
 * blob is rejected with an honest message rather than parsed into garbage.
 */

type StoredDoc = DatasheetDocMeta
interface Manifest {
  docs: StoredDoc[]
}

function dir(root: string): string {
  return join(root, '.cortex', 'datasheets')
}
function manifestPath(root: string): string {
  return join(dir(root), 'manifest.json')
}
function relPath(name: string): string {
  return `.cortex/datasheets/${name}`
}

/** A filesystem-safe stored name: strip any directory, keep only a conservative
 *  charset so a crafted source name can never traverse out of the corpus dir. */
function safeName(srcPath: string): string {
  const base = basename(srcPath).replace(/[^A-Za-z0-9._-]/g, '_')
  return base.replace(/^\.+/, '') || 'document.txt'
}

function kindOf(name: string): 'markdown' | 'text' {
  return /\.(md|markdown|mdx)$/i.test(name) ? 'markdown' : 'text'
}

async function readManifest(root: string): Promise<Manifest> {
  try {
    const raw = await fs.readFile(manifestPath(root), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.docs)) {
      const docs: StoredDoc[] = parsed.docs.filter(
        (d: unknown): d is StoredDoc =>
          !!d && typeof d === 'object' &&
          typeof (d as StoredDoc).id === 'string' &&
          typeof (d as StoredDoc).name === 'string' &&
          typeof (d as StoredDoc).path === 'string'
      )
      return { docs }
    }
  } catch {
    /* no manifest yet */
  }
  return { docs: [] }
}

async function writeManifest(root: string, m: Manifest): Promise<void> {
  await ensureCorpusDir(root)
  await fs.writeFile(manifestPath(root), JSON.stringify(m, null, 2) + '\n', 'utf8')
}

/**
 * Create the corpus dir and return its REAL path, confined to the workspace. If
 * the dir (or a link on its path) resolves outside the workspace, refuse - so an
 * import can never write through a planted directory symlink. Returns null when
 * confinement fails.
 */
async function ensureCorpusDir(root: string): Promise<string | null> {
  const d = dir(root)
  await fs.mkdir(d, { recursive: true })
  try {
    const real = await fs.realpath(d)
    const workspace = await fsService.getPhysicalWorkspaceRoot()
    return workspace && isWithin(workspace, real) ? real : null
  } catch {
    return null
  }
}

/**
 * Resolve a stored document to a path that is safe to read: a direct, regular
 * (non-symlink) file inside the corpus dir. The manifest is untrusted, so only
 * the basename is honored (any dir components / `..` / absolute part is dropped),
 * the final component must not be a symlink (lstat), and the corpus dir itself
 * must resolve inside the workspace. Returns null to skip anything that does not
 * meet all three.
 */
async function safeCorpusPath(root: string, storedName: string): Promise<string | null> {
  const base = basename(storedName)
  if (!base || base === '..' || base === '.') return null
  const abs = join(dir(root), base)
  try {
    const st = await fs.lstat(abs)
    if (!st.isFile() || st.isSymbolicLink()) return null // no symlink, no dir/special
    const realDir = await fs.realpath(dir(root))
    const workspace = await fsService.getPhysicalWorkspaceRoot()
    if (!workspace || !isWithin(workspace, realDir)) return null // corpus dir escaped the workspace
    return abs
  } catch {
    return null // missing (e.g. a manifest path that pointed outside the corpus)
  }
}

/** Write a file into the (already realpath-confined) corpus dir, refusing to
 *  write THROUGH a symlink planted at the destination name. Returns an error
 *  string, or null on success. */
async function safeWrite(realDir: string, name: string, content: string): Promise<string | null> {
  const dest = join(realDir, name)
  try {
    const existing = await fs.lstat(dest).catch(() => null)
    if (existing && existing.isSymbolicLink()) return `Refused: a symlink occupies ${name}.`
    await fs.writeFile(dest, content, 'utf8')
    return null
  } catch (e) {
    return `Could not store ${name}: ${e instanceof Error ? e.message : String(e)}`
  }
}

/** Validate a PDF doc's extracted-sections sidecar (our own file, but a cloned
 *  repo could ship a crafted one). It supplies display text + line/page numbers,
 *  never a path. line/page must be positive integers (a bogus L:NaN / L:-5 /
 *  L:Infinity citation resolves nowhere), and the served text is cross-checked
 *  against the stored .txt by the caller so a crafted sidecar cannot inject a
 *  "verbatim" passage that is not in the extracted document. */
function parseSidecarSections(raw: string): DatasheetSection[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1
  const out: DatasheetSection[] = []
  for (const s of parsed) {
    if (!s || typeof s !== 'object') continue
    const sec = s as Record<string, unknown>
    if (!posInt(sec.line) || typeof sec.text !== 'string') continue
    const section: DatasheetSection = { line: sec.line, text: sec.text }
    if (posInt(sec.page)) section.page = sec.page
    if (typeof sec.title === 'string') section.title = sec.title
    out.push(section)
  }
  return out
}

// In-memory cache, one workspace at a time (the panel and the agent both query
// the open project). Holds the BM25 index, the parsed docs, and the hardware
// graph used for query enrichment - so retrieval never re-walks the project on
// every chat message / doc search. Invalidated on import.
let cache: { root: string; index: DocIndex; docs: DatasheetDoc[]; graph: HardwareGraph | null } | null = null

/** Drop the cached index (call after any corpus change). */
export function invalidate(root?: string): void {
  if (!root || cache?.root === root) cache = null
}

/** The imported documents' metadata (no section bodies), for the panel list. */
export async function list(root: string): Promise<StoredDoc[]> {
  if (!root) return []
  return (await readManifest(root)).docs
}

/**
 * Import a user-chosen document. `srcPath` is an absolute path from the native
 * open dialog (main-process, user-authorized). A markdown/text file is copied
 * verbatim into the corpus; a PDF is extracted (pdfExtractor) into a stored
 * plain-text rendering plus a sections sidecar carrying page provenance. All
 * corpus writes are symlink-safe and confined to the realpath'd corpus dir. The
 * manifest entry, and the record returned to the renderer, follow.
 */
export async function importFile(root: string, srcPath: string): Promise<DatasheetImportResult> {
  if (!root) return { ok: false, error: 'No workspace is open.' }
  if (!srcPath) return { ok: false, error: 'No file selected.' }
  const realDir = await ensureCorpusDir(root)
  if (!realDir) return { ok: false, error: 'Refused: the corpus directory resolves outside the workspace.' }

  const origName = basename(srcPath)
  const isPdf = extname(srcPath).toLowerCase() === '.pdf'
  // Read the manifest up front so an import can refuse to clobber a stored file
  // that belongs to a DIFFERENT existing document (see wouldCollide).
  const existing = (await readManifest(root)).docs
  const entry = isPdf
    ? await importPdf(realDir, srcPath, origName, existing)
    : await importText(realDir, srcPath, origName, existing)
  if (!entry.ok) return entry

  // Replace an existing entry with the same stored path (a true re-import
  // overwrites). The id is the (unique) stored name.
  const docs = existing.filter((d) => d.path !== entry.doc.path)
  docs.push(entry.doc)
  docs.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  await writeManifest(root, { docs })
  invalidate(root)
  return { ok: true, name: origName, deviceKey: entry.doc.deviceKey }
}

type StoreResult = { ok: true; doc: StoredDoc } | { ok: false; error: string }

/** The stored file basenames an existing doc owns (its text and, for a PDF, its
 *  sidecar). */
function occupiedNames(d: StoredDoc): string[] {
  return [basename(d.path), d.sectionsPath ? basename(d.sectionsPath) : ''].filter(Boolean)
}

/**
 * The first target name that would overwrite a file owned by a DIFFERENT
 * document, or null when clear. A true same-kind re-import of the same stored
 * name is allowed (it intentionally overwrites its own file); a collision with a
 * different doc - e.g. a text import named `x.pdf.txt` landing on a PDF's stored
 * text, or on any doc's sidecar - is refused so no import silently destroys
 * another.
 */
function wouldCollide(existing: StoredDoc[], targets: string[], isSelf: (d: StoredDoc, target: string) => boolean): string | null {
  for (const d of existing) {
    const occ = occupiedNames(d)
    for (const t of targets) {
      if (occ.includes(t) && !isSelf(d, t)) return t
    }
  }
  return null
}

/** Copy a markdown/text source into the corpus (refusing binaries). */
async function importText(realDir: string, srcPath: string, origName: string, existing: StoredDoc[]): Promise<StoreResult> {
  let content: string
  try {
    const r = await fsService.readFile(srcPath)
    if (r.kind === 'binary') {
      return { ok: false, error: `${origName} is not a text document. Import a markdown/text file, or a PDF.` }
    }
    if (r.kind === 'too-large') return { ok: false, error: `${origName} is too large to import (${r.size} bytes).` }
    content = r.content
  } catch (e) {
    return { ok: false, error: `Could not read the file: ${e instanceof Error ? e.message : String(e)}` }
  }
  const name = safeName(srcPath)
  // Self = an existing non-PDF doc stored under exactly this name (re-import).
  const clash = wouldCollide(existing, [name], (d, t) => d.kind !== 'pdf' && d.path === relPath(t))
  if (clash) return { ok: false, error: `A different document already uses "${clash}". Remove it first.` }
  const werr = await safeWrite(realDir, name, content)
  if (werr) return { ok: false, error: werr }
  return { ok: true, doc: { id: name, name: origName, path: relPath(name), kind: kindOf(name), deviceKey: matchDeviceForDoc(name, KNOWN_DEVICES) } }
}

/** Extract a PDF's text layer into the corpus: a revealable `.txt` plus a
 *  sections sidecar carrying page provenance. Both stored under a `.pdf.*`
 *  namespace so a PDF's artifacts cannot collide with a plausible markdown/text
 *  import name (e.g. `notes.txt` vs a `notes.pdf` import). */
async function importPdf(realDir: string, srcPath: string, origName: string, existing: StoredDoc[]): Promise<StoreResult> {
  if (!(await isPdfAvailable())) {
    return { ok: false, error: 'PDF support is not available in this build. Import a markdown or text document instead.' }
  }
  const stem = safeName(srcPath).replace(/\.[^.]+$/, '') || 'document'
  const txtName = `${stem}.pdf.txt`
  const sidecarName = `${stem}.pdf.sections.json`
  // Self = an existing PDF doc that already owns these exact artifact names.
  const clash = wouldCollide(existing, [txtName, sidecarName], (d) => d.kind === 'pdf' && d.path === relPath(txtName))
  if (clash) return { ok: false, error: `A different document already uses "${clash}". Remove it first.` }
  const res = await extractPdf(srcPath)
  if (!res.ok) return { ok: false, error: res.error }
  const werr = await safeWrite(realDir, txtName, res.text)
  if (werr) return { ok: false, error: werr }
  const serr = await safeWrite(realDir, sidecarName, JSON.stringify(res.sections))
  if (serr) return { ok: false, error: serr }
  return {
    ok: true,
    doc: {
      id: txtName,
      name: origName,
      path: relPath(txtName),
      kind: 'pdf',
      sectionsPath: relPath(sidecarName),
      deviceKey: matchDeviceForDoc(origName, KNOWN_DEVICES)
    }
  }
}

/** Read the stored corpus, sectionize it, and build the BM25 index + the
 *  enrichment graph (all cached together, rebuilt only on invalidate). */
async function loadCorpus(root: string): Promise<{ index: DocIndex; docs: DatasheetDoc[]; graph: HardwareGraph | null }> {
  if (cache && cache.root === root) return cache
  const stored = (await readManifest(root)).docs
  const docs: DatasheetDoc[] = []
  for (const s of stored) {
    // Resolve to a real, non-symlink file inside the corpus dir; the manifest's
    // path is untrusted, so only its basename is honored (see safeCorpusPath).
    const abs = await safeCorpusPath(root, s.path)
    if (!abs) continue
    // The citation path is recomputed from the trusted basename, never the raw
    // manifest path, so a citation always resolves inside the corpus dir.
    const path = relPath(basename(abs))
    try {
      let sections: DatasheetSection[]
      if (s.kind === 'pdf') {
        // Page provenance can't be recovered by re-sectionizing plain text, so a
        // PDF's sections come from its sidecar (equally confined to the corpus).
        const sidecarAbs = s.sectionsPath && (await safeCorpusPath(root, s.sectionsPath))
        if (!sidecarAbs) continue
        const parsed = parseSidecarSections(await fs.readFile(sidecarAbs, 'utf8'))
        if (!parsed) continue
        // Honesty cross-check: the served/cited passage must actually appear in
        // the revealable stored .txt, so a crafted sidecar cannot inject a
        // "verbatim" passage that is not in the extracted document. A legitimate
        // sidecar's text is always a slice of the .txt, so this only drops fakes.
        const txt = await fsService.readFile(abs)
        if (txt.kind !== 'text') continue
        sections = parsed.filter((sec) => txt.content.includes(sec.text))
        if (sections.length === 0) continue
      } else {
        const r = await fsService.readFile(abs)
        if (r.kind !== 'text') continue
        sections = sectionize(r.content, s.kind === 'markdown' ? 'markdown' : 'text')
      }
      docs.push({ id: s.id, name: s.name, path, deviceKey: s.deviceKey, sections })
    } catch {
      /* skip a doc that vanished from disk */
    }
  }
  const index = buildIndex(docs)
  // Build the enrichment graph once, only when there is a corpus to search. This
  // keeps buildProjectModel (a full project scan) off the per-query hot path.
  let graph: HardwareGraph | null = null
  if (docs.length) {
    try {
      graph = buildHardwareGraph(await buildProjectModel(root))
    } catch {
      /* enrichment optional */
    }
  }
  cache = { root, index, docs, graph }
  return cache
}

/**
 * Retrieve the passages most relevant to `query`, enriched by the project's
 * hardware graph so a question about "the I2C sensor" biases toward the datasheet
 * of the part actually on the bus. Returns cited, verbatim passages ranked by
 * BM25. The enrichment graph is cached with the index, so retrieval never
 * re-walks the project per query.
 */
export async function search(root: string, query: string, k = 5): Promise<DatasheetHit[]> {
  if (!root || !query.trim()) return []
  const { index, graph } = await loadCorpus(root)
  if (index.n === 0) return []
  const extraTerms = graph ? enrichQueryFromGraph(graph, query).terms : []
  return queryIndex(index, query, k, extraTerms)
}
