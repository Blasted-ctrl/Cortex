import type * as monaco from 'monaco-editor'
import { LSP_LANGUAGE_ID, langForFile, pathToUri, uriToPath, type LspLang } from '@shared/lsp'
import { applyTextEdits } from '@shared/textEdit'
import { maskCppNonCode } from '@shared/cppLexical'
import { withDiagnosticHint } from '@shared/diagnosticHints'
import { useStore } from '../store/useStore'
import { stdlibCompletionOwner, stdlibDocumentation, type StdlibOwner } from './stdlibDocumentation'
import pythonSnippets from '@shared/stdlib/python-snippets.json'
import cppSnippets from '@shared/stdlib/cpp-snippets.json'
import cppLibraries from '@shared/stdlib/cpp-libraries.json'
import {
  indexLibraries,
  includedHeaders,
  inferKnownType,
  librarySuggestions,
  libSuggestionDoc,
  type LibIndexEntry,
  type LibraryDict
} from '@shared/libraryComplete'

/**
 * Stable key for a document, independent of how a URI was encoded or cased.
 * Servers echo back a URI they re-canonicalized (RFC 3986 percent-encoding,
 * Windows drive-letter case), which need not match `pathToUri`'s output byte
 * for byte. Comparing decoded paths (with a lowercased drive on Windows)
 * instead means a diagnostics batch is never dropped over cosmetic drift.
 */
function docKey(uriOrPath: string): string {
  let p = uriToPath(uriOrPath.startsWith('file:') ? uriOrPath : pathToUri(uriOrPath)).replace(/\\/g, '/')
  // Fold only the drive letter (case-insensitive on Windows); the rest of the
  // path keeps its case, which matters on case-sensitive filesystems.
  if (/^[a-zA-Z]:/.test(p)) p = p[0].toLowerCase() + p.slice(1)
  return p
}

/**
 * Bridges Monaco to the language servers running in the main process. Registers
 * completion / hover / definition / signature-help providers, syncs the open
 * document (didOpen/didChange/didClose), and turns pushed diagnostics into
 * Monaco markers.
 *
 * Cortex shows one editor at a time, but providers still resolve their context
 * by model, so nothing breaks if that changes. A language with no installed
 * server is skipped, so the editor simply has no IntelliSense rather than
 * erroring.
 */

interface Doc {
  path: string
  root: string
  uri: string
  lang: LspLang
  version: number
}

type Mon = typeof monaco

interface CompletionOrigin {
  doc: Doc
  raw: LspCompletion
  label: string
  detail?: string
  documentation: string
  resolving?: object
}

const docsByModel = new Map<monaco.editor.ITextModel, Doc>()
const docsByUri = new Map<string, { model: monaco.editor.ITextModel; doc: Doc }>()
const changeTimers = new Map<string, ReturnType<typeof setTimeout>>()
// Latest text awaiting a debounced didChange, so a request can flush it first.
const pendingContent = new Map<string, string>()
// Which doc + raw LSP item a given Monaco suggestion came from, so
// resolveCompletionItem (called with only the item, no model/position) knows
// what to ask completionItem/resolve for. Monaco reuses the same object
// instance between provide and resolve, so the object itself is a valid key.
const completionOrigin = new WeakMap<monaco.languages.CompletionItem, CompletionOrigin>()

let available: Record<LspLang, boolean> = { cpp: false, python: false, rust: false }
let monacoRef: Mon | null = null

const toLspPos = (p: monaco.IPosition): { line: number; character: number } => ({
  line: p.lineNumber - 1,
  character: p.column - 1
})

interface LspRange {
  start: { line: number; character: number }
  end: { line: number; character: number }
}
const toMonacoRange = (r: LspRange): monaco.IRange => ({
  startLineNumber: r.start.line + 1,
  startColumn: r.start.character + 1,
  endLineNumber: r.end.line + 1,
  endColumn: r.end.character + 1
})

/** Same path, ignoring separator style and (Windows) case. */
function pathKeyEq(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
}

/** Flatten an LSP WorkspaceEdit (either shape) into path -> edits. */
function collectWorkspaceEdit(we: LspWorkspaceEdit): Map<string, LspTextEdit[]> {
  const out = new Map<string, LspTextEdit[]>()
  const add = (uri: string, edits: LspTextEdit[]): void => {
    const p = uriToPath(uri)
    out.set(p, (out.get(p) ?? []).concat(edits))
  }
  if (we.changes) for (const [uri, edits] of Object.entries(we.changes)) add(uri, edits)
  if (we.documentChanges) {
    for (const dc of we.documentChanges) if (dc.textDocument?.uri && dc.edits) add(dc.textDocument.uri, dc.edits)
  }
  return out
}

/** LSP CompletionItemKind (1-25) -> Monaco CompletionItemKind. */
function completionKind(m: Mon, k: number | undefined): monaco.languages.CompletionItemKind {
  const K = m.languages.CompletionItemKind
  const map: Record<number, monaco.languages.CompletionItemKind> = {
    1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field, 6: K.Variable,
    7: K.Class, 8: K.Interface, 9: K.Module, 10: K.Property, 11: K.Unit, 12: K.Value,
    13: K.Enum, 14: K.Keyword, 15: K.Snippet, 16: K.Color, 17: K.File, 18: K.Reference,
    19: K.Folder, 20: K.EnumMember, 21: K.Constant, 22: K.Struct, 23: K.Event,
    24: K.Operator, 25: K.TypeParameter
  }
  return (k && map[k]) ?? K.Text
}

type LspContents = string | { kind?: string; value: string } | Array<string | { language?: string; value: string }>
function contentsToMarkdown(c: LspContents): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x.value ? '```\n' + x.value + '\n```' : '')).join('\n\n')
  return c.value ?? ''
}

const LANG_LABEL: Record<LspLang, string> = { cpp: 'C++', python: 'Python', rust: 'Rust' }

/**
 * Monaco renders `detail` right-aligned on the suggestion row (VS Code's
 * IntelliSense look this is matching). Raw LSP detail is often just a type
 * ("int") or a full signature, or nothing at all for a pyright local - none of
 * which tells a user WHERE something comes from at a glance. This adds that
 * without inventing information the server didn't provide.
 */
function friendlyDetail(m: Mon, it: LspCompletion, owner: StdlibOwner | null | undefined): string | undefined {
  const K = m.languages.CompletionItemKind
  const kind = completionKind(m, it.kind)
  if (kind === K.Variable || kind === K.Field || kind === K.Property) {
    return it.detail ? `Variable · ${it.detail}` : 'Variable in this file'
  }
  if (kind === K.Constant) return it.detail ? `Constant · ${it.detail}` : 'Constant in this file'
  if (kind === K.Function || kind === K.Method || kind === K.Class || kind === K.Module) {
    if (owner) return 'C++ standard library'
  }
  return it.detail
}

/**
 * Auto-add call parens to a bare completion, cursor landing inside them, the
 * way VS Code/Pylance/CLion all do. Bare pyright does NOT do this itself
 * (`completeFunctionParens` is a Pylance-only setting, confirmed absent from
 * pyright's own source - see LANG_SETTINGS's comment in lspService.ts), so
 * without this "print" only ever completed to "print", not "print()".
 * Covers Class/Constructor too, not just Function/Method: `str`, `int`,
 * `list` etc. are LSP-typed as Class but are exactly as call-shaped as any
 * function in normal use (`str(x)`), and a completion in a call-position
 * beats one in a type-annotation position often enough that the request was
 * explicitly for "ALL functions", parens included. Only skipped when the
 * server's own insertText already has "(" in it - that's a real arg-snippet
 * from clangd/rust-analyzer, not something to double up on.
 */
function withCallParens(
  m: Mon,
  kind: monaco.languages.CompletionItemKind,
  insertText: string,
  alreadySnippet: boolean
): { insertText: string; asSnippet: boolean } {
  const K = m.languages.CompletionItemKind
  const isCallable = kind === K.Function || kind === K.Method || kind === K.Class || kind === K.Constructor
  if (isCallable && !alreadySnippet && !insertText.includes('(')) {
    return { insertText: `${insertText}($0)`, asSnippet: true }
  }
  return { insertText, asSnippet: alreadySnippet }
}

// ---- supplemental template snippets ------------------------------------
// A language server proposes symbols that already exist; it has no opinion on
// boilerplate you're about to write (a class skeleton, a for loop). These are
// editor-level snippets in the same VS Code sense, keyed by construct name so
// typing "cla" prefix-matches "class" the same way it matches any other
// completion label.
interface StdlibSnippet {
  label: string
  description: string
  insertText: string
}
const SNIPPET_FILES: Partial<Record<LspLang, Record<string, StdlibSnippet>>> = {
  python: pythonSnippets as Record<string, StdlibSnippet>,
  cpp: cppSnippets as Record<string, StdlibSnippet>
}

// ---- curated hardware-library completion ------------------------------
// Member/class completion for library types clangd cannot resolve under the
// host toolchain (see src/shared/libraryComplete.ts). C++ only for now.
let cppLibIndexCache: Map<string, LibIndexEntry> | null = null
function cppLibraryIndex(): Map<string, LibIndexEntry> {
  if (!cppLibIndexCache) cppLibIndexCache = indexLibraries(cppLibraries as LibraryDict)
  return cppLibIndexCache
}
// Cache the code view and header set per model version: completion and hover
// repeatedly scan unchanged buffers.
const libScanCache = new WeakMap<monaco.editor.ITextModel, { version: number; clean: string; headers: Set<string> }>()
function libScan(model: monaco.editor.ITextModel): { clean: string; headers: Set<string> } {
  const version = model.getVersionId()
  const cached = libScanCache.get(model)
  if (cached && cached.version === version) return cached
  const source = model.getValue()
  const clean = maskCppNonCode(source)
  const headerLines = maskCppNonCode(source, false).split('\n')
  // The code view gates directives; the comments-only view retains quoted
  // header names. Neither view alone distinguishes all fake includes.
  const directives = clean.split('\n').map((line, i) => /^\s*#\s*include\b/.test(line) ? headerLines[i] : '').join('\n')
  const entry = { version, clean, headers: includedHeaders(directives) }
  libScanCache.set(model, entry)
  return entry
}
/** Does the document include the header for at least one curated library? A
 *  cheap gate so a file that uses no curated library does no scanning work. */
function usesAnyCuratedLibrary(idx: Map<string, LibIndexEntry>, headers: Set<string>): boolean {
  for (const entry of idx.values()) if (headers.has(entry.header)) return true
  return false
}

/**
 * Library completions for the cursor, minus any label the language server
 * already provided: clangd wins where it resolved the class, the dictionary
 * fills the gap where it did not. So there are no duplicate members, and a real
 * signature always beats a curated one.
 */
function libraryCompletions(
  m: Mon,
  lang: LspLang,
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
  range: monaco.IRange,
  alreadyProvided: Set<string>
): monaco.languages.CompletionItem[] {
  if (lang !== 'cpp') return []
  const idx = cppLibraryIndex()
  if (idx.size === 0) return []
  const { clean, headers } = libScan(model)
  if (!usesAnyCuratedLibrary(idx, headers)) return []
  const linePrefix = clean.slice(
    model.getOffsetAt({ lineNumber: position.lineNumber, column: 1 }),
    model.getOffsetAt(position)
  )
  const K = m.languages.CompletionItemKind
  return librarySuggestions(idx, clean, linePrefix, headers)
    .filter((s) => !alreadyProvided.has(s.name))
    .map((s) => {
      const isMember = s.kind === 'member'
      return {
        label: s.name,
        kind: isMember ? K.Method : K.Class,
        // Methods insert with parens and the cursor between them; a class name
        // is a type, so it inserts bare.
        insertText: isMember ? `${s.name}($0)` : s.name,
        insertTextRules: isMember ? m.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
        detail: s.signature || (isMember ? `${s.className} member` : `${LANG_LABEL[lang]} library class`),
        documentation: { value: libSuggestionDoc(s) },
        // Members rank at the top after a dot (a real LSP member, if any, was
        // already filtered out above); a class suggestion ranks below real symbols.
        sortText: isMember ? `00_${s.name}` : `zz_lib_${s.name}`,
        range
      }
    })
}

/** Hover markdown for a library class name or a known-typed variable's member,
 *  or null. Works even when clangd returned no hover for the symbol. */
function libraryHover(
  lang: LspLang,
  model: monaco.editor.ITextModel,
  position: monaco.IPosition,
  word: monaco.editor.IWordAtPosition
): string | null {
  if (lang !== 'cpp') return null
  const idx = cppLibraryIndex()
  if (idx.size === 0) return null
  const { clean: docText, headers } = libScan(model)
  if (!usesAnyCuratedLibrary(idx, headers)) return null
  const wordOffset = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn })
  if (docText.slice(wordOffset, wordOffset + word.word.length) !== word.word) return null
  const lineStart = model.getOffsetAt({ lineNumber: position.lineNumber, column: 1 })
  const prefix = docText.slice(lineStart, wordOffset)
  const receiver = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.|->)\s*$/.exec(prefix)
  if (receiver) {
    // Do not reinterpret the tail of a chain or namespace as a simple local.
    const beforeReceiver = prefix.slice(0, receiver.index)
    if (/(?:\.|->|::)$/.test(beforeReceiver.trimEnd()) || /\p{ID_Continue}$/u.test(beforeReceiver)) return null
    const className = inferKnownType(docText, receiver[1], new Set(idx.keys()))
    const entry = className ? idx.get(className) : undefined
    const member = entry?.def.members[word.word]
    if (entry && member && headers.has(entry.header)) {
      return libSuggestionDoc({
        kind: 'member',
        name: word.word,
        className: className!,
        description: member.description,
        signature: member.signature,
        example: member.example,
        docUrl: member.docUrl ?? entry.def.docUrl
      })
    }
    return null
  }
  // Calls, subscripts and parenthesized receivers are not local identifiers.
  if (/(?:\.|->)\s*$/.test(prefix)) return null
  const cls = idx.get(word.word)
  if (cls && headers.has(cls.header)) {
    return libSuggestionDoc({
      kind: 'class',
      name: word.word,
      className: word.word,
      description: cls.def.description,
      example: cls.def.example,
      docUrl: cls.def.docUrl
    })
  }
  return null
}

function snippetSuggestions(m: Mon, lang: LspLang, range: monaco.IRange): monaco.languages.CompletionItem[] {
  const snippets = SNIPPET_FILES[lang]
  if (!snippets) return []
  return Object.values(snippets).map((s) => ({
    label: s.label,
    kind: m.languages.CompletionItemKind.Snippet,
    insertText: s.insertText,
    insertTextRules: m.languages.CompletionItemInsertTextRule.InsertAsSnippet,
    detail: 'Snippet',
    documentation: { value: s.description },
    sortText: `zzz_${s.label}`, // real symbols first; a snippet is a fallback, not competing with a real completion
    range
  }))
}

/** Send any debounced edit for a doc immediately, so a following request sees
 * the current buffer rather than the version clangd last heard about. */
function flushChange(doc: Doc): void {
  const content = pendingContent.get(doc.uri)
  if (content === undefined) return
  pendingContent.delete(doc.uri)
  const t = changeTimers.get(doc.uri)
  if (t) {
    clearTimeout(t)
    changeTimers.delete(doc.uri)
  }
  doc.version += 1
  void window.api.lspNotify({
    lang: doc.lang,
    root: doc.root,
    method: 'textDocument/didChange',
    params: { textDocument: { uri: doc.uri, version: doc.version }, contentChanges: [{ text: content }] }
  })
}

async function lspRequest<T = unknown>(doc: Doc, method: string, params: object): Promise<T | null> {
  if (!available[doc.lang]) return null
  flushChange(doc) // the server must see edits before it answers about them
  const res = await window.api.lspRequest({ lang: doc.lang, root: doc.root, method, params })
  return (res as T) ?? null
}

// Which Monaco language ids each server answers for. Monaco registers `c` and
// `cpp` as SEPARATE ids, so registering only 'cpp' left every .c file with a
// green clangd badge and working squiggles but dead completion/hover/F12.
const REGISTRATIONS: Array<[LspLang, string]> = [
  ['cpp', 'cpp'],
  ['cpp', 'c'],
  ['python', 'python'],
  ['rust', 'rust']
]

function registerProviders(m: Mon): void {
  for (const [lang, id] of REGISTRATIONS) {
    m.languages.registerCompletionItemProvider(id, {
      triggerCharacters: ['.', '>', ':', '<', '"', '/', '*'],
      async provideCompletionItems(model, position, _context, token) {
        const doc = docsByModel.get(model)
        if (!doc) return { suggestions: [] }
        const res = await lspRequest<{ items?: LspCompletion[] } | LspCompletion[]>(doc, 'textDocument/completion', {
          textDocument: { uri: doc.uri },
          position: toLspPos(position)
        })
        if (token.isCancellationRequested) return { suggestions: [] }
        const items = Array.isArray(res) ? res : (res?.items ?? [])
        const word = model.getWordUntilPosition(position)
        const range: monaco.IRange = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn
        }
        const base = items.slice(0, 200).map((it) => {
            const rawDoc = it.documentation ? contentsToMarkdown(it.documentation as LspContents) : ''
            const owner = stdlibCompletionOwner(lang, it.label, it.detail)
            const enriched = stdlibDocumentation(owner, rawDoc)
            const kind = completionKind(m, it.kind)
            const baseInsert = it.insertText ?? it.textEdit?.newText ?? it.label
            const wasSnippet = it.insertTextFormat === 2
            const { insertText, asSnippet } = withCallParens(m, kind, baseInsert, wasSnippet)
            const suggestion: monaco.languages.CompletionItem = {
              label: it.label,
              kind,
              insertText,
              insertTextRules: asSnippet ? m.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              detail: friendlyDetail(m, it, owner),
              documentation: enriched.trim() ? { value: enriched } : undefined,
              sortText: it.sortText,
              filterText: it.filterText,
              additionalTextEdits: it.additionalTextEdits?.map((edit) => ({
                range: toMonacoRange(edit.range), text: edit.newText
              })),
              range
            }
            // Servers send full documentation lazily (resolveCompletionItem
            // below), not eagerly for every one of 200 items - stash what that
            // follow-up request needs to ask for THIS one.
            completionOrigin.set(suggestion, {
              doc, raw: it, label: it.label, detail: it.detail, documentation: rawDoc
            })
            return suggestion
          })
        // Library completions defer to whatever the server already offered:
        // clangd's real members win, the curated dictionary fills the gap.
        // Dedup on the BARE name, not the label: without labelDetailsSupport
        // clangd folds the signature into the label ("write(int value)"), so a
        // label compare would never match the curated member "write" and both
        // would show. filterText carries the bare name; fall back to stripping
        // the signature/template off the label.
        const bareName = (it: LspCompletion): string => it.filterText || it.label.replace(/[(<:].*$/s, '').trim()
        const providedLabels = new Set(items.map(bareName))
        return {
          suggestions: base
            .concat(snippetSuggestions(m, lang, range))
            .concat(libraryCompletions(m, lang, model, position, range, providedLabels))
        }
      },
      async resolveCompletionItem(item, token) {
        const origin = completionOrigin.get(item)
        if (!origin || token.isCancellationRequested) return item
        const resolving = {}
        origin.resolving = resolving
        try {
          // Always send the initial server payload, including opaque data, not
          // a rendered suggestion or a previous partial resolve response.
          const resolved = await lspRequest<Partial<LspCompletion>>(origin.doc, 'completionItem/resolve', origin.raw as object)
          if (token.isCancellationRequested || origin.resolving !== resolving) return item
          const label = typeof resolved?.label === 'string' ? resolved.label : origin.label
          const detail = typeof resolved?.detail === 'string' ? resolved.detail : origin.detail
          const rawDoc = resolved?.documentation != null
            ? contentsToMarkdown(resolved.documentation as LspContents)
            : origin.documentation
          const owner = stdlibCompletionOwner(lang, label, detail)
          const enriched = stdlibDocumentation(owner, rawDoc)
          const displayedDetail = friendlyDetail(m, { ...origin.raw, label, detail }, owner)
          const edits = resolved?.additionalTextEdits?.map((edit) => ({
            range: toMonacoRange(edit.range), text: edit.newText
          }))
          // Convert all fields before committing. Omitted/null documentation
          // preserves accepted raw text; an explicit blank clears it.
          origin.label = label
          origin.detail = detail
          origin.documentation = rawDoc
          item.documentation = enriched.trim() ? { value: enriched } : undefined
          item.detail = displayedDetail
          if (edits !== undefined) item.additionalTextEdits = edits
          return item
        } finally {
          // An older request finishing first must not release a newer owner.
          if (origin.resolving === resolving) delete origin.resolving
        }
      }
    })

    m.languages.registerHoverProvider(id, {
      async provideHover(model, position, token) {
        const doc = docsByModel.get(model)
        if (!doc) return null
        const res = await lspRequest<{ contents: LspContents; range?: LspRange }>(doc, 'textDocument/hover', {
          textDocument: { uri: doc.uri },
          position: toLspPos(position)
        })
        if (token.isCancellationRequested) return null
        // clangd may have nothing for a library type it could not resolve; the
        // library dictionary still answers, so do not bail on an empty result.
        const raw = res?.contents ? contentsToMarkdown(res.contents) : ''
        const word = model.getWordAtPosition(position)
        const libDoc = word ? libraryHover(lang, model, position, word) : null
        let value: string
        if (libDoc) {
          value = raw.trim() ? `${libDoc}\n\n---\n${raw}` : libDoc
        } else if (raw.trim()) {
          // Hover has no trusted owner contract here; a bare cursor word or
          // Markdown signature is not enough to select stdlib documentation.
          value = raw
        } else {
          return null
        }
        if (!value.trim()) return null
        return { contents: [{ value }], range: res?.range ? toMonacoRange(res.range) : undefined }
      }
    })

    m.languages.registerDefinitionProvider(id, {
      async provideDefinition(model, position, token) {
        const doc = docsByModel.get(model)
        if (!doc) return null
        const res = await lspRequest<LspLocation | LspLocation[] | LspLocationLink[]>(doc, 'textDocument/definition', {
          textDocument: { uri: doc.uri },
          position: toLspPos(position)
        })
        if (token.isCancellationRequested) return null
        const arr = Array.isArray(res) ? res : res ? [res] : []
        return arr.map((l) => {
          const uri = 'uri' in l ? l.uri : l.targetUri
          const range = 'range' in l ? l.range : l.targetSelectionRange
          return { uri: m.Uri.parse(uri), range: toMonacoRange(range) }
        })
      }
    })

    m.languages.registerSignatureHelpProvider(id, {
      signatureHelpTriggerCharacters: ['(', ','],
      async provideSignatureHelp(model, position, token) {
        const doc = docsByModel.get(model)
        if (!doc) return null
        const res = await lspRequest<LspSignatureHelp>(doc, 'textDocument/signatureHelp', {
          textDocument: { uri: doc.uri },
          position: toLspPos(position)
        })
        if (token.isCancellationRequested || !res?.signatures?.length) return null
        return {
          value: {
            signatures: res.signatures.map((s) => ({
              label: s.label,
              documentation: s.documentation ? { value: contentsToMarkdown(s.documentation as LspContents) } : undefined,
              parameters: (s.parameters ?? []).map((p) => ({
                label: p.label,
                documentation: p.documentation ? { value: contentsToMarkdown(p.documentation as LspContents) } : undefined
              }))
            })),
            activeSignature: res.activeSignature ?? 0,
            activeParameter: res.activeParameter ?? 0
          },
          dispose: () => {}
        }
      }
    })

    // Find all references (Shift+F12 / the references peek). Same-file
    // references resolve fully; cross-file ones list their real location.
    m.languages.registerReferenceProvider(id, {
      async provideReferences(model, position, context, token) {
        const doc = docsByModel.get(model)
        if (!doc) return []
        const res = await lspRequest<LspLocation[]>(doc, 'textDocument/references', {
          textDocument: { uri: doc.uri },
          position: toLspPos(position),
          context: { includeDeclaration: context.includeDeclaration }
        })
        if (token.isCancellationRequested || !Array.isArray(res)) return []
        return res.map((l) => ({ uri: m.Uri.parse(l.uri), range: toMonacoRange(l.range) }))
      }
    })

    // Document formatting (the previously-dead Auto Format menu item, and
    // Shift+Alt+F). clangd and rust-analyzer format; pyright has no formatter
    // and simply returns nothing, so this is a real no-op there rather than a
    // broken action.
    m.languages.registerDocumentFormattingEditProvider(id, {
      async provideDocumentFormattingEdits(model, options, token) {
        const doc = docsByModel.get(model)
        if (!doc) return []
        const res = await lspRequest<LspTextEdit[]>(doc, 'textDocument/formatting', {
          textDocument: { uri: doc.uri },
          options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces }
        })
        if (token.isCancellationRequested || !Array.isArray(res)) return []
        return res.map((e) => ({ range: toMonacoRange(e.range), text: e.newText }))
      }
    })

    // Rename symbol (F2). The server only knows the ACTIVE file's live buffer,
    // so applying its edits to another file that has unsaved changes could land
    // them at stale offsets. Rather than risk a bad edit, we refuse that case;
    // otherwise the active file's edits go through Monaco (undoable) and every
    // other affected file is rewritten on disk and its open tab kept in sync.
    m.languages.registerRenameProvider(id, {
      async provideRenameEdits(model, position, newName, token) {
        const doc = docsByModel.get(model)
        if (!doc) return { edits: [] }
        const res = await lspRequest<LspWorkspaceEdit>(doc, 'textDocument/rename', {
          textDocument: { uri: doc.uri },
          position: toLspPos(position),
          newName
        })
        if (token.isCancellationRequested || !res) return { edits: [] }
        const byPath = collectWorkspaceEdit(res)
        if (byPath.size === 0) return { edits: [], rejectReason: 'This symbol cannot be renamed here.' }

        const store = useStore.getState()
        for (const p of byPath.keys()) {
          if (pathKeyEq(p, doc.path)) continue
          const tab = store.tabs.find((t) => pathKeyEq(t.path, p))
          if (tab && tab.content !== tab.savedContent) {
            return { edits: [], rejectReason: `Save changes in ${p.split(/[\\/]/).pop()} before renaming across files.` }
          }
        }

        let activeEdits: LspTextEdit[] = []
        for (const [p, edits] of byPath) {
          if (pathKeyEq(p, doc.path)) {
            activeEdits = edits
            continue
          }
          try {
            const tab = store.tabs.find((t) => pathKeyEq(t.path, p))
            let base: string
            if (tab) base = tab.savedContent
            else {
              const read = await window.api.readFile(p)
              base = read.kind === 'text' ? read.content : ''
            }
            const next = applyTextEdits(base, edits)
            await window.api.writeFile(p, next)
            if (tab) store.applyExternalEdit(p, next)
          } catch {
            /* skip an unreadable target rather than fail the whole rename */
          }
        }
        if (token.isCancellationRequested) return { edits: [] }
        return {
          edits: activeEdits.map((e) => ({
            resource: model.uri,
            textEdit: { range: toMonacoRange(e.range), text: e.newText },
            versionId: undefined
          }))
        }
      }
    })
  }
}

/** Project facts the diagnostic hints depend on, read from the open workspace. */
function hintContext(): { platformio: boolean } {
  return { platformio: useStore.getState().tree.some((n) => n.name === 'platformio.ini') }
}

function severity(m: Mon, s: number | undefined): monaco.MarkerSeverity {
  const S = m.MarkerSeverity
  return s === 1 ? S.Error : s === 2 ? S.Warning : s === 4 ? S.Hint : S.Info
}

/**
 * Call with the Monaco instance. Idempotent, and safe to call concurrently: the
 * promise is memoized, so a second caller awaits the SAME initialisation rather
 * than racing past a boolean that was set before `available` was populated
 * (which left that document permanently without a server).
 */
let initPromise: Promise<void> | null = null
export function initLsp(m: Mon): Promise<void> {
  if (!initPromise) initPromise = doInitLsp(m)
  return initPromise
}

async function doInitLsp(m: Mon): Promise<void> {
  monacoRef = m
  available = (await window.api.lspServers().catch(() => ({ cpp: false, python: false, rust: false }))) as Record<LspLang, boolean>
  // Surface availability to the status bar (read outside React via the store).
  useStore.getState().setLspServers({ ...available })
  registerProviders(m)

  // Read-only introspection for diagnostics/support: which servers are live and
  // which documents are open. No behaviour depends on it.
  ;(window as unknown as { __cortexLsp?: unknown }).__cortexLsp = {
    available: (): Record<LspLang, boolean> => ({ ...available }),
    openDocs: (): string[] => [...docsByUri.keys()]
  }

  window.api.onLspDiagnostics(({ uri, diagnostics }) => {
    const entry = docsByUri.get(docKey(uri))
    if (!entry || entry.model.isDisposed()) return
    // No `code`/`source` on the marker itself: Monaco's own hover renders those
    // as a trailing "source(code)" line (e.g. "lsp(undeclared_var_use)"), which
    // is compiler-internals noise on top of an already-plain-English message.
    const markers: monaco.editor.IMarkerData[] = (diagnostics as LspDiagnostic[]).map((d) => ({
      severity: severity(m, d.severity),
      message: entry.doc.lang === 'cpp' ? withDiagnosticHint(d.message, hintContext()) : d.message,
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1
    }))
    try {
      m.editor.setModelMarkers(entry.model, 'lsp', markers)
    } catch {
      /* model disposed mid-update */
    }
  })

  // A server that died is respawned lazily on the next request, but that fresh
  // process has never heard of the documents this renderer already opened. Replay
  // didOpen (with the current buffer) for every open doc of the dead server so
  // completion/hover/diagnostics keep working instead of going silently dead.
  window.api.onLspBusy(({ lang, busy }) => {
    useStore.getState().setLspBusy(lang, busy)
  })

  window.api.onLspServerExit(({ lang, root, givenUp }) => {
    // Main gave up restarting this server (it crashed repeatedly). Replaying
    // didOpen is what respawns it, so replaying now would restart the loop main
    // just broke. Report it as off instead of leaving a green badge over an
    // IntelliSense that will never answer.
    if (givenUp) {
      useStore.getState().setLspServers({ ...useStore.getState().lspServers, [lang]: false })
      // Retract this server's squiggles as well. Diagnostics are only ever
      // cleared by a server publishing an empty set, and there is no server left
      // to do it: every marker it had published would otherwise stay frozen on
      // screen for the rest of the session, including on lines the user has
      // since fixed.
      for (const [model, doc] of docsByModel) {
        if (doc.lang !== lang || doc.root !== root || model.isDisposed()) continue
        monacoRef?.editor.setModelMarkers(model, 'lsp', [])
      }
      return
    }
    for (const [model, doc] of docsByModel) {
      if (doc.lang !== lang || doc.root !== root || model.isDisposed()) continue
      doc.version += 1
      pendingContent.delete(doc.uri)
      void window.api.lspNotify({
        lang,
        root,
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri: doc.uri,
            languageId: LSP_LANGUAGE_ID[lang],
            version: doc.version,
            text: model.getValue()
          }
        }
      })
    }
  })
}

/** Open (or re-open) a document for the given file, if a server handles it. */
export function openDoc(path: string, root: string, model: monaco.editor.ITextModel, content: string): void {
  const lang = langForFile(path)
  if (!lang || !available[lang] || !root) return
  const uri = pathToUri(path)
  const doc: Doc = { path, root, uri, lang, version: 1 }
  docsByModel.set(model, doc)
  docsByUri.set(docKey(uri), { model, doc })
  void window.api.lspNotify({
    lang,
    root,
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, languageId: LSP_LANGUAGE_ID[lang], version: 1, text: content } }
  })
}

/** Full-document change, debounced (clangd advertises full sync; simplest correct).
 * A pending edit can be flushed early by flushChange when a request needs it. */
export function changeDoc(model: monaco.editor.ITextModel, content: string): void {
  const doc = docsByModel.get(model)
  if (!doc) return
  pendingContent.set(doc.uri, content)
  const prev = changeTimers.get(doc.uri)
  if (prev) clearTimeout(prev)
  changeTimers.set(doc.uri, setTimeout(() => flushChange(doc), 300))
}

export function closeDoc(model: monaco.editor.ITextModel): void {
  const doc = docsByModel.get(model)
  if (!doc) return
  const t = changeTimers.get(doc.uri)
  if (t) clearTimeout(t)
  changeTimers.delete(doc.uri)
  pendingContent.delete(doc.uri)
  docsByModel.delete(model)
  docsByUri.delete(docKey(doc.uri))
  void window.api.lspNotify({
    lang: doc.lang,
    root: doc.root,
    method: 'textDocument/didClose',
    params: { textDocument: { uri: doc.uri } }
  })
  if (monacoRef && !model.isDisposed()) monacoRef.editor.setModelMarkers(model, 'lsp', [])
}

// ---- LSP payload shapes we read ------------------------------------------

interface LspCompletion {
  label: string
  kind?: number
  insertText?: string
  insertTextFormat?: number
  textEdit?: { newText: string }
  additionalTextEdits?: LspTextEdit[]
  detail?: string
  documentation?: unknown
  sortText?: string
  filterText?: string
  // Opaque correlation token for completionItem/resolve. Servers send back
  // richer detail/documentation for ONE item on demand rather than eagerly for
  // every item in a 200-deep list; `data` is what tells the server which one.
  data?: unknown
}
interface LspLocation {
  uri: string
  range: LspRange
}
interface LspTextEdit {
  range: LspRange
  newText: string
}
interface LspWorkspaceEdit {
  changes?: Record<string, LspTextEdit[]>
  documentChanges?: Array<{ textDocument?: { uri: string }; edits?: LspTextEdit[] }>
}
interface LspLocationLink {
  targetUri: string
  targetSelectionRange: LspRange
}
interface LspSignatureHelp {
  signatures: Array<{
    label: string
    documentation?: unknown
    parameters?: Array<{ label: string | [number, number]; documentation?: unknown }>
  }>
  activeSignature?: number
  activeParameter?: number
}
interface LspDiagnostic {
  range: LspRange
  message: string
  severity?: number
  source?: string
  code?: string | number | { value: string | number }
}
