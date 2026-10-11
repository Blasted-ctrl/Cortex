/**
 * Header-gated fallback completion for library classes the server cannot resolve
 * on its own. A firmware project includes a library like ESP32Servo.h, but
 * clangd analysing under the host toolchain often cannot follow that library's
 * transitive core includes, so `Servo myservo; myservo.` offers nothing. This
 * supplements (never replaces) the server: for a curated set of library classes
 * it infers a variable's type from its declaration in the same file and offers
 * that class's members, with descriptions and argument docs. Pure and
 * dependency-free so it is unit-tested and reusable in the renderer.
 *
 * The curated data lives in src/shared/stdlib/cpp-libraries.json and is grown by
 * the recurring dictionary agent (see docs/STDLIB-DICTIONARY-WORKFLOW.md).
 */

export interface LibMember {
  signature?: string
  description: string
  example?: string
  docUrl?: string
}
export interface LibClass {
  description: string
  docUrl?: string
  since?: string
  example?: string
  members: Record<string, LibMember>
}
export interface LibFile {
  url?: string
  classes: Record<string, LibClass>
}
/** Keyed by lowercased header basename, e.g. "esp32servo.h". */
export type LibraryDict = Record<string, LibFile>

export interface LibIndexEntry {
  header: string
  def: LibClass
}

/** class name -> { header, class definition }. Built once. */
export function indexLibraries(dict: LibraryDict): Map<string, LibIndexEntry> {
  const out = new Map<string, LibIndexEntry>()
  for (const [header, file] of Object.entries(dict)) {
    for (const [className, def] of Object.entries(file.classes)) out.set(className, { header, def })
  }
  return out
}

/**
 * Blank out block comments, line comments, and double-quoted string bodies so a
 * commented-out `#include` or a declaration inside a string is not treated as
 * live code. Positions are not preserved (comments become spaces), which is
 * fine: the scans below only look for the presence of includes and
 * declarations, never map an offset back to the editor.
 */
export function stripCommentsAndStrings(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
}

/** The set of header basenames (lowercased) the document `#include`s. Pass
 *  comment-stripped text (see stripCommentsAndStrings) to ignore dead includes. */
export function includedHeaders(text: string): Set<string> {
  const out = new Set<string>()
  const re = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) out.add(m[1].split('/').pop()!.toLowerCase())
  return out
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The declared type of `varName`, if it is one of `knownClasses`. Matches a
 * declaration of the form `Class` then an optional pointer/reference sigil then
 * `varName` then a declaration terminator, anywhere in the file
 * (locals, members, and parameters), including the pointer/reference styles
 * where the sigil is glued to the variable (`Servo *sp`, `Servo &r`) as well as
 * to the type (`Servo* p`). The lookahead requires at least one separator
 * (whitespace or a sigil) between the type and the name, so a single glued
 * identifier like `Servosp` is not mis-split. Deliberately narrow: it only
 * recognizes known class names in the supplied whole-file code view. It does
 * not resolve lexical scopes, local shadowing or aliases, so a matching
 * declaration is a fallback hint rather than semantic proof of this use.
 */
export function inferKnownType(text: string, varName: string, knownClasses: Set<string>): string | null {
  const re = new RegExp('\\b([A-Za-z_][A-Za-z0-9_]*)(?=[\\s*&])[\\s*&]*' + escape(varName) + '\\s*[;={([,)]', 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (knownClasses.has(m[1])) return m[1]
  }
  return null
}

export interface LibSuggestion {
  kind: 'class' | 'member'
  name: string
  className: string
  description: string
  signature?: string
  example?: string
  docUrl?: string
}

/**
 * Suggestions for the cursor. `linePrefix` is the current line up to the
 * cursor. If it ends in `receiver.` / `receiver->` and `receiver` is a
 * known-typed variable whose header is included, returns that class's members.
 * Otherwise returns the known classes whose header is included (so typing
 * `Serv` offers `Servo`). Returns [] when nothing applies.
 */
export function librarySuggestions(
  index: Map<string, LibIndexEntry>,
  docText: string,
  linePrefix: string,
  precomputedHeaders?: Set<string>
): LibSuggestion[] {
  if (index.size === 0) return []
  const headers = precomputedHeaders ?? includedHeaders(docText)
  const member = linePrefix.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.|->)\s*[A-Za-z0-9_]*$/)
  if (member) {
    const known = new Set(index.keys())
    const className = inferKnownType(docText, member[1], known)
    if (!className) return []
    const entry = index.get(className)!
    if (!headers.has(entry.header)) return []
    return Object.entries(entry.def.members).map(([name, m]) => ({
      kind: 'member' as const,
      name,
      className,
      description: m.description,
      signature: m.signature,
      example: m.example,
      docUrl: m.docUrl ?? entry.def.docUrl
    }))
  }
  const out: LibSuggestion[] = []
  for (const [className, entry] of index) {
    if (!headers.has(entry.header)) continue
    out.push({
      kind: 'class',
      name: className,
      className,
      description: entry.def.description,
      example: entry.def.example,
      docUrl: entry.def.docUrl
    })
  }
  return out
}

/** Markdown documentation for a suggestion, in the same shape the stdlib
 *  enrichment uses: description, then an example block, then a doc link. */
export function libSuggestionDoc(s: LibSuggestion): string {
  const sig = s.signature ? '```cpp\n' + s.signature + '\n```\n\n' : ''
  const example = s.example ? `\n\n**Example**\n\`\`\`cpp\n${s.example}\n\`\`\`` : ''
  const link = s.docUrl ? `\n\n[Documentation](${s.docUrl})` : ''
  return `${sig}${s.description}${example}${link}`
}
