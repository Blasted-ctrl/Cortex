import type { LspLang } from '@shared/lsp'
import cppStdlib from '@shared/stdlib/cpp.json'

interface StdlibSymbol {
  description: string
  example?: string
  since?: string | null
  docUrl?: string
}
interface StdlibLibrary {
  since?: string | null
  symbols: Record<string, StdlibSymbol>
}

export interface StdlibOwner {
  library: string
  symbol: string
}

const cppLibraries: Record<string, StdlibLibrary> = cppStdlib
// These are dictionary identities, not an inference from arbitrary std:: text.
const cppOwners: Record<string, string> = { 'std::vector': 'vector', 'std::chrono': 'chrono' }
const index = new Map<string, Map<string, { entry: StdlibSymbol; libSince: string | null }>>()
for (const [library, data] of Object.entries(cppLibraries)) {
  const symbols = new Map<string, { entry: StdlibSymbol; libSince: string | null }>()
  for (const [symbol, entry] of Object.entries(data.symbols)) {
    symbols.set(symbol, { entry, libSince: data.since ?? null })
  }
  index.set(library, symbols)
}

// A deliberately finite presentation grammar: simple template arguments are
// supported, but nested templates, operators and arbitrary server prose are not.
const identifier = '[A-Za-z_][A-Za-z0-9_]*'
const component = `${identifier}(?:<[^<>()[\\]{};=\\r\\n]+>)?`
const qualified = `${component}(?:::${component})+`
const qualifiedLabel = new RegExp(`^${qualified}$`)
// Unknown unqualified words ("Use", "Widget", etc.) cannot distinguish prose
// from a return type. Accept built-ins and the finite dictionary's aliases;
// qualified return types are syntax only and never establish symbol ownership.
const knownReturnType = '(?:void|bool|char|wchar_t|char8_t|char16_t|char32_t|int|float|double|signed|unsigned|long|short|auto|size_t|size_type|reference|const_reference|iterator|const_iterator)'
const returnType = `(?:(?:const|volatile|static|inline|constexpr|virtual|signed|unsigned|long|short)\\s+)*(?:${knownReturnType}|${qualified})\\s*[*&]*\\s+`
const functionDeclaration = new RegExp(`^${returnType}(${qualified})\\([^()\\r\\n]*\\)(?:\\s+(?:const|volatile|noexcept|override|final))*\\s*;?$`)
const typeDeclaration = new RegExp(`^(?:class|struct|namespace)\\s+(${qualified})\\s*;?$`)

function qualifiedOwner(name: string): StdlibOwner | null {
  const parts = name.replace(/<[^<>]*>/g, '').split('::')
  const symbol = parts.pop()!
  const library = cppOwners[parts.join('::')]
  return library && index.get(library)?.has(symbol) ? { library, symbol } : null
}

/** undefined means no supported owner evidence; null means explicit foreign or
 * contradictory evidence. Documentation, return/argument types and opaque LSP
 * data are intentionally not inputs to this policy. */
export function stdlibCompletionOwner(lang: LspLang, label: string, detail?: string): StdlibOwner | null | undefined {
  if (lang !== 'cpp') return undefined
  const labelName = qualifiedLabel.test(label) ? label : undefined
  const declaration = detail?.trim()
  const detailName = declaration
    ? functionDeclaration.exec(declaration)?.[1] ?? typeDeclaration.exec(declaration)?.[1]
    : undefined
  if (!labelName && !detailName) return undefined
  const fromLabel = labelName ? qualifiedOwner(labelName) : undefined
  const fromDetail = detailName ? qualifiedOwner(detailName) : undefined
  if (fromLabel === null || fromDetail === null) return null
  if (fromLabel && fromDetail && (fromLabel.library !== fromDetail.library || fromLabel.symbol !== fromDetail.symbol)) return null
  const owner = fromLabel ?? fromDetail
  // A detail declarator must name the completion itself, not another symbol.
  if (owner && !labelName && label !== owner.symbol) return null
  return owner
}

/** Keep authoritative server prose separate so repeated resolution never feeds
 * already-enriched Markdown back through the dictionary. */
export function stdlibDocumentation(owner: StdlibOwner | null | undefined, raw: string): string {
  const found = owner ? index.get(owner.library)?.get(owner.symbol) : undefined
  if (!found) return raw
  const since = found.entry.since ?? found.libSince
  const sinceNote = since ? `_Since ${since}._\n\n` : ''
  const exampleBlock = found.entry.example
    ? `\n\n**Example**\n\`\`\`cpp\n${found.entry.example}\n\`\`\``
    : ''
  const linkBlock = found.entry.docUrl ? `\n\n[Documentation](${found.entry.docUrl})` : ''
  const serverBlock = raw.trim() ? `\n\n---\n${raw}` : ''
  return `${sinceNote}${found.entry.description}${exampleBlock}${linkBlock}${serverBlock}`
}
