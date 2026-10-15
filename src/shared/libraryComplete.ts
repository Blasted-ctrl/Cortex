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
  /**
   * Further lowercased header basenames that also enable this entry. A library
   * like OpenCV is reached through many headers (opencv.hpp, imgproc.hpp, ...),
   * so one include is not enough to name it.
   */
  headers?: string[]
  /** The C++ namespace of `classes` and `functions` (e.g. "cv"); omitted for a global C API. */
  namespace?: string
  classes: Record<string, LibClass>
  /** Free functions, keyed by name. */
  functions?: Record<string, LibMember>
}
/** Keyed by lowercased header basename, e.g. "esp32servo.h". */
export type LibraryDict = Record<string, LibFile>

export interface LibIndexEntry {
  header: string
  /** `header` plus any alias headers: including any one of them enables the entry. */
  headers: readonly string[]
  namespace?: string
  def: LibClass
}

export interface LibFunctionEntry {
  name: string
  header: string
  headers: readonly string[]
  namespace?: string
  def: LibMember
}

/** True when the document includes any of the entry's headers. */
export function libEntryEnabled(entry: { header: string; headers?: readonly string[] }, included: ReadonlySet<string>): boolean {
  return included.has(entry.header) || (entry.headers ?? []).some((h) => included.has(h))
}

/** class name -> { header, class definition }. Built once. */
export function indexLibraries(dict: LibraryDict): Map<string, LibIndexEntry> {
  const out = new Map<string, LibIndexEntry>()
  for (const [header, file] of Object.entries(dict)) {
    const headers = [header, ...(file.headers ?? [])]
    for (const [className, def] of Object.entries(file.classes)) out.set(className, { header, headers, namespace: file.namespace, def })
  }
  return out
}

/** Every curated free function, with the headers and namespace that own it. Built once. */
export function indexLibraryFunctions(dict: LibraryDict): LibFunctionEntry[] {
  const out: LibFunctionEntry[] = []
  for (const [header, file] of Object.entries(dict)) {
    const headers = [header, ...(file.headers ?? [])]
    for (const [name, def] of Object.entries(file.functions ?? {})) out.push({ name, header, headers, namespace: file.namespace, def })
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
  kind: 'class' | 'member' | 'function'
  name: string
  /** The owning class for a member; the namespace (or '') for a function. */
  className: string
  description: string
  signature?: string
  example?: string
  docUrl?: string
}

/** `using namespace ns;` in comment-stripped code. */
function usesNamespace(docText: string, ns: string): boolean {
  return new RegExp('\\busing\\s+namespace\\s+' + escape(ns) + '\\s*;').test(docText)
}

/** True when text before a qualified name shows it is itself a member or nested lookup. */
function nestedLookup(before: string): boolean {
  return /(?:\.|->|::)\s*$/.test(before.trimEnd()) || /\p{ID_Continue}$/u.test(before)
}

const classMembers = (className: string, entry: LibIndexEntry): LibSuggestion[] =>
  Object.entries(entry.def.members).map(([name, m]) => ({
    kind: 'member' as const,
    name,
    className,
    description: m.description,
    signature: m.signature,
    example: m.example,
    docUrl: m.docUrl ?? entry.def.docUrl
  }))

const classSuggestion = (className: string, entry: LibIndexEntry): LibSuggestion => ({
  kind: 'class',
  name: className,
  className,
  description: entry.def.description,
  example: entry.def.example,
  docUrl: entry.def.docUrl
})

const functionSuggestion = (f: LibFunctionEntry): LibSuggestion => ({
  kind: 'function',
  name: f.name,
  className: f.namespace ?? '',
  description: f.def.description,
  signature: f.def.signature,
  example: f.def.example,
  docUrl: f.def.docUrl
})

/**
 * Suggestions for the cursor. `linePrefix` is the current line up to the
 * cursor. It resolves, in order:
 *  - `receiver.` / `receiver->` on a known-typed variable: that class's members;
 *  - `ns::` for a curated namespace (`cv::`): its functions and classes;
 *  - `Class::` / `ns::Class::` for a curated namespaced class: its members;
 *  - otherwise an unqualified name: the global C functions of an included
 *    library, plus a namespaced library's functions and classes when the file
 *    says `using namespace ns;`, plus every unnamespaced class.
 * An entry only applies when one of its headers is included, and a qualifier
 * that is not the entry's own namespace gets nothing. Returns [] when nothing applies.
 */
export function librarySuggestions(
  index: Map<string, LibIndexEntry>,
  docText: string,
  linePrefix: string,
  precomputedHeaders?: Set<string>,
  functions: readonly LibFunctionEntry[] = []
): LibSuggestion[] {
  if (index.size === 0 && functions.length === 0) return []
  const headers = precomputedHeaders ?? includedHeaders(docText)
  const member = linePrefix.match(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.|->)\s*[A-Za-z0-9_]*$/)
  if (member) {
    const beforeReceiver = linePrefix.slice(0, member.index)
    if (nestedLookup(beforeReceiver)) return []
    const known = new Set(index.keys())
    const className = inferKnownType(docText, member[1], known)
    if (!className) return []
    const entry = index.get(className)!
    if (!libEntryEnabled(entry, headers)) return []
    // A namespaced class must be declared through its own namespace: `cv::Mat m`
    // or `Mat m` after `using namespace cv;`, never `other::Mat m`.
    if (entry.namespace && !declaredInNamespace(docText, member[1], className, entry.namespace)) return []
    return classMembers(className, entry)
  }
  const qualified = /(?:\b([A-Za-z_]\w*)::)?\b([A-Za-z_]\w*)::\s*[A-Za-z0-9_]*$/.exec(linePrefix)
  if (qualified) {
    if (nestedLookup(linePrefix.slice(0, qualified.index))) return []
    const [, outer, q] = qualified
    if (!outer) {
      // `ns::` - everything curated in that namespace.
      const inNs = [...index.entries()].filter(([, e]) => e.namespace === q && libEntryEnabled(e, headers))
      const fns = functions.filter((f) => f.namespace === q && libEntryEnabled(f, headers))
      if (inNs.length || fns.length) return [...fns.map(functionSuggestion), ...inNs.map(([name, e]) => classSuggestion(name, e))]
    }
    // `Class::` after `using namespace ns;`, or `ns::Class::`.
    const entry = index.get(q)
    if (entry?.namespace && libEntryEnabled(entry, headers) && (outer ? entry.namespace === outer : usesNamespace(docText, entry.namespace))) {
      return classMembers(q, entry)
    }
    return []
  }
  // A qualified lookup belongs to its qualifier, not to a globally named
  // class in the dictionary (for example, another namespace's Servo).
  if (/(?:\.|->|::)\s*[A-Za-z0-9_]*$/.test(linePrefix)) return []
  const out: LibSuggestion[] = []
  for (const [className, entry] of index) {
    if (!libEntryEnabled(entry, headers)) continue
    if (entry.namespace && !usesNamespace(docText, entry.namespace)) continue
    out.push(classSuggestion(className, entry))
  }
  for (const f of functions) {
    if (!libEntryEnabled(f, headers)) continue
    if (f.namespace && !usesNamespace(docText, f.namespace)) continue
    out.push(functionSuggestion(f))
  }
  return out
}

/** True when `varName` is declared as `ns::Class name`, or as `Class name` with `using namespace ns;` in effect. */
function declaredInNamespace(docText: string, varName: string, className: string, ns: string): boolean {
  const re = new RegExp('(?:\\b([A-Za-z_]\\w*)::)?\\b' + escape(className) + '(?=[\\s*&])[\\s*&]*' + escape(varName) + '\\s*[;={([,)]', 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(docText))) {
    if (m[1] === ns) return true
    if (!m[1] && usesNamespace(docText, ns)) return true
  }
  return false
}

/** Markdown documentation for a suggestion, in the same shape the stdlib
 *  enrichment uses: description, then an example block, then a doc link. */
export function libSuggestionDoc(s: LibSuggestion): string {
  const sig = s.signature ? '```cpp\n' + s.signature + '\n```\n\n' : ''
  const example = s.example ? `\n\n**Example**\n\`\`\`cpp\n${s.example}\n\`\`\`` : ''
  const link = s.docUrl ? `\n\n[Documentation](${s.docUrl})` : ''
  return `${sig}${s.description}${example}${link}`
}
