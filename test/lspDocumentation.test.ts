import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as monaco from 'monaco-editor'
import type { LspLang } from '../src/shared/lsp'

const VECTOR_CLEAR_DOC = 'Destroys every element, leaving size() == 0. Capacity is unspecified but typically unchanged, so it does NOT necessarily free the underlying allocation (use shrink_to_fit() for that).'
  + '\n\n**Example**\n```cpp\nv.clear();\nassert(v.empty());\n```'
  + '\n\n[Documentation](https://en.cppreference.com/w/cpp/container/vector/clear)'
const CHRONO_CLOCK_DOC = '_Since c++11._\n\nA monotonic clock that never gets adjusted (no NTP jumps, no DST). Use this, not system_clock, for measuring elapsed time or intervals.'
  + '\n\n**Example**\n```cpp\nauto t0 = std::chrono::steady_clock::now();\n/* work */\nauto elapsed = std::chrono::steady_clock::now() - t0;\n```'
  + '\n\n[Documentation](https://en.cppreference.com/w/cpp/chrono/steady_clock)'
const SERVO_WRITE_DOC = '```cpp\nvoid write(int value)\n```\n\nSets the servo position. A value below 500 is treated as an angle in degrees (0 to 180); a value of 500 or more is treated as a pulse width in microseconds. Out-of-range values are clamped.'
  + '\n\n**Example**\n```cpp\nmyservo.write(90); // 90 degrees\n```'
  + '\n\n[Documentation](https://github.com/madhephaestus/ESP32Servo)'
const SERVO_CLASS_DOC = "Controls an RC servo on an ESP32. Create an instance, attach() it to a GPIO pin, then write() an angle or writeMicroseconds() a pulse width. Uses fixed-frequency PWM (50 Hz by default) through the ESP32's MCPWM or LEDC hardware, so it works on the pins that support PWM output."
  + '\n\n**Example**\n```cpp\n#include <ESP32Servo.h>\nServo myservo;\nvoid setup() {\n  myservo.setPeriodHertz(50);   // standard 50 Hz servo\n  myservo.attach(18, 500, 2400); // pin, min us, max us\n  myservo.write(90);            // center\n}\n```'
  + '\n\n[Documentation](https://github.com/madhephaestus/ESP32Servo)'

const includeEdit = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  newText: '#include <vector>\n'
}
const initialMonacoEdit = {
  range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
  text: '#include <vector>\n'
}
type RawCompletion = {
  label: string
  kind?: number
  detail?: string
  documentation?: unknown
  insertText?: string
  insertTextFormat?: number
  additionalTextEdits?: typeof includeEdit[]
  data?: unknown
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function modelFixture(initialText: string) {
  let text = initialText
  let version = 1
  const lineStart = (lineNumber: number): number => {
    let offset = 0
    for (let line = 1; line < lineNumber; line++) {
      const newline = text.indexOf('\n', offset)
      if (newline < 0) throw new Error('Fixture position is outside its source')
      offset = newline + 1
    }
    return offset
  }
  const lineContent = (lineNumber: number): string => {
    const start = lineStart(lineNumber)
    const newline = text.indexOf('\n', start)
    return text.slice(start, newline < 0 ? text.length : newline).replace(/\r$/, '')
  }
  const offsetAt = (position: monaco.IPosition): number => lineStart(position.lineNumber) + position.column - 1
  const positionAt = (offset: number): monaco.IPosition => {
    const preceding = text.slice(0, offset)
    return { lineNumber: preceding.split('\n').length, column: offset - preceding.lastIndexOf('\n') }
  }
  const wordAt = (position: monaco.IPosition): monaco.editor.IWordAtPosition | null => {
    const line = lineContent(position.lineNumber)
    const offset = position.column - 1
    for (const match of line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const start = match.index!
      const end = start + match[0].length
      if (offset >= start && offset <= end) return { word: match[0], startColumn: start + 1, endColumn: end + 1 }
    }
    return null
  }
  const api = {
    getVersionId: () => version,
    getValue: () => text,
    getLineContent: lineContent,
    getOffsetAt: offsetAt,
    getWordAtPosition: wordAt,
    getWordUntilPosition: (position: monaco.IPosition) => {
      const word = wordAt(position)
      return word ? { ...word, word: word.word.slice(0, position.column - word.startColumn), endColumn: position.column }
        : { word: '', startColumn: position.column, endColumn: position.column }
    },
    getValueInRange: (range: monaco.IRange) => text.slice(
      offsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }),
      offsetAt({ lineNumber: range.endLineNumber, column: range.endColumn })
    ),
    isDisposed: () => false
  } as unknown as monaco.editor.ITextModel
  return {
    api,
    at(needle: string, occurrence = 1): monaco.IPosition {
      const words = [...text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].filter(match => match[0] === needle)
      const match = words[occurrence - 1]
      if (!match) throw new Error(`Missing fixture word: ${needle}`)
      return positionAt(match.index!)
    },
    after(needle: string): monaco.IPosition {
      const offset = text.indexOf(needle)
      if (offset < 0) throw new Error(`Missing fixture prefix: ${needle}`)
      return positionAt(offset + needle.length)
    },
    replace(next: string): void { text = next; version++ }
  }
}

let lsp: typeof import('../src/renderer/src/lsp/lspClient')
let request: ReturnType<typeof vi.fn>
let completions: Map<string, monaco.languages.CompletionItemProvider>
let hovers: Map<string, monaco.languages.HoverProvider>
let models: monaco.editor.ITextModel[]
let host: typeof monaco
const token = { isCancellationRequested: false } as monaco.CancellationToken

beforeEach(async () => {
  vi.resetModules()
  request = vi.fn()
  completions = new Map()
  hovers = new Map()
  models = []
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) }
  })
  vi.stubGlobal('window', {
    api: {
      lspServers: vi.fn().mockResolvedValue({ cpp: true, python: true, rust: true }),
      lspRequest: request,
      lspNotify: vi.fn().mockResolvedValue(undefined),
      onLspDiagnostics: vi.fn(), onLspBusy: vi.fn(), onLspServerExit: vi.fn()
    }
  })
  const kinds = [
    'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class',
    'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword',
    'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant',
    'Struct', 'Event', 'Operator', 'TypeParameter'
  ]
  host = {
    editor: { setModelMarkers: vi.fn() },
    languages: {
      CompletionItemKind: Object.fromEntries(kinds.map((kind, index) => [kind, index])),
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (id: string, provider: monaco.languages.CompletionItemProvider) => { completions.set(id, provider) },
      registerHoverProvider: (id: string, provider: monaco.languages.HoverProvider) => { hovers.set(id, provider) },
      registerDefinitionProvider: vi.fn(), registerSignatureHelpProvider: vi.fn(),
      registerReferenceProvider: vi.fn(), registerDocumentFormattingEditProvider: vi.fn(), registerRenameProvider: vi.fn()
    }
  } as unknown as typeof monaco
  lsp = await import('../src/renderer/src/lsp/lspClient')
  await lsp.initLsp(host)
})

afterEach(() => {
  for (const model of models) lsp.closeDoc(model)
  vi.unstubAllGlobals()
})

function open(source = 'target', lang: LspLang = 'cpp') {
  const model = modelFixture(source)
  models.push(model.api)
  const extension = lang === 'cpp' ? 'cpp' : lang === 'python' ? 'py' : 'rs'
  lsp.openDoc(`C:/cortex-owned-lsp/file-${models.length}.${extension}`, 'C:/cortex-owned-lsp', model.api, source)
  return model
}

async function complete(raw: RawCompletion, lang: LspLang = 'cpp') {
  const model = open('target', lang)
  request.mockResolvedValueOnce([raw])
  const list = await completions.get(lang)!.provideCompletionItems(model.api, model.after('target'), { triggerKind: 0 }, token)
  const item = list?.suggestions.find(suggestion => suggestion.label === raw.label)
  if (!item) throw new Error('The actual provider did not return the supplied completion')
  return item
}

async function resolve(item: monaco.languages.CompletionItem, response: Partial<RawCompletion> | null, lang: LspLang = 'cpp') {
  request.mockResolvedValueOnce(response)
  return completions.get(lang)!.resolveCompletionItem!(item, token)
}

async function hover(model: ReturnType<typeof modelFixture>, needle: string, occurrence = 1, raw: string | null = null) {
  request.mockResolvedValueOnce(raw === null ? null : { contents: raw })
  return hovers.get('cpp')!.provideHover(model.api, model.at(needle, occurrence), token)
}

describe('actual completion documentation ownership', () => {
  it('shows Servo documentation on the real class completion, not unrelated header prose', async () => {
    const model = open('#include <ESP32Servo.h>\nServ')
    request.mockResolvedValueOnce([{ label: 'Servo', kind: 7, detail: 'class Servo', documentation: 'LEDC channel mapping.' }])
    const list = await completions.get('cpp')!.provideCompletionItems(model.api, model.after('Serv'), { triggerKind: 0 }, token)
    const servo = list?.suggestions.filter(item => item.label === 'Servo')
    expect(servo).toHaveLength(1)
    expect(servo![0].documentation).toEqual({ value: SERVO_CLASS_DOC })
    expect(servo![0].detail).toBe('Servo library class')
    await resolve(servo![0], { label: 'Servo', documentation: 'Arduino Servo Library calls' })
    expect(servo![0].documentation).toEqual({ value: SERVO_CLASS_DOC })
  })

  it('documents real Servo methods and keeps their server insertion and edits', async () => {
    const model = open('#include <ESP32Servo.h>\nServo my_s;\nmy_s.att')
    const raw = { label: 'attach(int pin)', filterText: 'attach', kind: 2, detail: 'int Servo::attach(int pin)', documentation: 'Arduino Servo Library calls', insertText: 'attach(${1:pin})', insertTextFormat: 2, additionalTextEdits: [includeEdit] }
    request.mockResolvedValueOnce([raw])
    const list = await completions.get('cpp')!.provideCompletionItems(model.api, model.after('my_s.att'), { triggerKind: 0 }, token)
    const attach = list?.suggestions.filter(item => item.label === raw.label)
    expect(attach).toHaveLength(1)
    expect(attach![0].documentation?.value).toContain('Attaches the servo to a GPIO pin')
    expect(attach![0].documentation?.value).not.toContain('Arduino Servo Library calls')
    expect(attach![0].insertText).toBe(raw.insertText)
    expect(attach![0].additionalTextEdits).toEqual([initialMonacoEdit])
    await resolve(attach![0], { label: raw.label, documentation: 'Generic header comment.' })
    expect(attach![0].documentation?.value).toContain('Attaches the servo to a GPIO pin')
  })

  it('does not attribute a foreign method or qualified class to ESP32Servo', async () => {
    const model = open('#include <ESP32Servo.h>\nServo my_s;\nmy_s.write')
    request.mockResolvedValueOnce([{ label: 'write', kind: 2, detail: 'void Widget::write()', documentation: 'Widget docs.' }])
    const list = await completions.get('cpp')!.provideCompletionItems(model.api, model.after('my_s.write'), { triggerKind: 0 }, token)
    expect(list?.suggestions.find(item => item.label === 'write')?.documentation).toEqual({ value: 'Widget docs.' })

    const classModel = open('#include <ESP32Servo.h>\nServ')
    request.mockResolvedValueOnce([{ label: 'Servo', kind: 7, detail: 'class Widget::Servo', documentation: 'Widget class.' }])
    const classes = await completions.get('cpp')!.provideCompletionItems(classModel.api, classModel.after('Serv'), { triggerKind: 0 }, token)
    expect(classes?.suggestions.find(item => item.label === 'Servo')?.documentation).toEqual({ value: 'Widget class.' })
  })

  it.each([
    ['qualified vector label', { label: 'std::vector::clear', kind: 2, detail: 'void clear()' }, VECTOR_CLEAR_DOC],
    ['qualified vector declarator', { label: 'clear', kind: 2, detail: 'void std::vector::clear()' }, VECTOR_CLEAR_DOC],
    ['qualified templated vector declarator', { label: 'clear', kind: 2, detail: 'void std::vector<int>::clear()' }, VECTOR_CLEAR_DOC],
    ['qualified chrono label', { label: 'std::chrono::steady_clock', kind: 7, detail: 'class steady_clock' }, CHRONO_CLOCK_DOC]
  ] as const)('supplements only the supported owner: %s', async (_name, raw, curated) => {
    const item = await complete({ ...raw, documentation: 'Authoritative server prose.' })
    expect(item.documentation).toEqual({ value: curated + '\n\n---\nAuthoritative server prose.' })
    expect(item.detail).toBe('C++ standard library')
  })

  it.each([
    ['bare user member', { label: 'clear', kind: 2, detail: 'void clear()' }],
    ['foreign qualified label', { label: 'Widget::clear', kind: 2, detail: 'void clear()' }],
    ['foreign qualified declarator', { label: 'clear', kind: 2, detail: 'void Widget::clear()' }],
    ['uncurated standard owner', { label: 'clear', kind: 2, detail: 'void std::map::clear()' }],
    ['uncurated symbol', { label: 'std::vector::missing', kind: 2, detail: 'void missing()' }],
    ['standard return type', { label: 'clear', kind: 2, detail: 'std::vector<int> clear()' }],
    ['standard return with foreign declarator', { label: 'clear', kind: 2, detail: 'std::vector<int> Widget::clear()' }],
    ['standard parameter', { label: 'clear', kind: 2, detail: 'void clear(std::vector<int> input)' }],
    ['standard detail prose', { label: 'clear', kind: 2, detail: 'Local helper; std::vector::clear is called later.' }],
    ['prose before a qualified declarator', { label: 'clear', kind: 2, detail: 'Use void std::vector::clear()' }],
    ['prose mistaken for a return type', { label: 'clear', kind: 2, detail: 'Use std::vector::clear()' }],
    ['unknown unqualified return type', { label: 'clear', kind: 2, detail: 'Widget std::vector::clear()' }],
    ['standard prose', { label: 'clear', kind: 2, detail: 'void clear()', documentation: 'Local code calls std::vector::clear as an example.' }],
    ['opaque data', { label: 'clear', kind: 2, detail: 'void clear()', data: { owner: 'std::vector', symbol: 'clear' } }],
    ['contradictory owners', { label: 'std::vector::clear', kind: 2, detail: 'void Widget::clear()' }]
  ] as const)('preserves raw text without an invented badge: %s', async (_name, raw) => {
    const documentation = 'documentation' in raw ? raw.documentation : 'Only the server knows this symbol.'
    const item = await complete({ ...raw, documentation })
    expect(item.documentation).toEqual({ value: documentation })
    expect(item.detail).toBe(raw.detail)
  })

  it.each([
    ['python', { label: 'sleep', kind: 3, detail: '(seconds: float) -> None', documentation: 'A local sleep; examples may mention time.sleep.' }],
    ['rust', { label: 'clear', kind: 2, detail: 'fn clear(input: std::vec::Vec<u8>)', documentation: 'User code mentioning std::vec::Vec.' }]
  ] as const)('keeps %s documentation and origin raw', async (lang, raw) => {
    const item = await complete(raw, lang)
    expect(item.documentation).toEqual({ value: raw.documentation })
    expect(item.detail).toBe(raw.detail)
  })

  it('preserves variable and constant friendly details independently of stdlib ownership', async () => {
    const variable = await complete({ label: 'local', kind: 6, detail: 'std::vector<int>', documentation: 'A variable.' })
    const constant = await complete({ label: 'limit', kind: 21, detail: 'int', documentation: 'A constant.' })
    expect(variable.detail).toBe('Variable \u00b7 std::vector<int>')
    expect(variable.documentation).toEqual({ value: 'A variable.' })
    expect(constant.detail).toBe('Constant \u00b7 int')
    expect(constant.documentation).toEqual({ value: 'A constant.' })
  })
})

describe('actual lazy completion accepted state', () => {
  it('retains initial qualified prose and edits through partial and null responses', async () => {
    const raw = { label: 'clear', kind: 2, detail: 'void std::vector::clear()', documentation: 'Initial server prose.', additionalTextEdits: [includeEdit], data: { opaque: ['same', 7] } }
    const original = structuredClone(raw)
    const item = await complete(raw)
    for (const response of [{ label: 'clear' }, { label: 'clear', documentation: null }, null]) {
      await resolve(item, response)
      expect(item.documentation).toEqual({ value: VECTOR_CLEAR_DOC + '\n\n---\nInitial server prose.' })
      expect(item.detail).toBe('C++ standard library')
      expect(item.additionalTextEdits).toEqual([initialMonacoEdit])
    }
    expect(item.insertText).toBe('clear($0)')
    expect(item.insertTextRules).toBe(host.languages.CompletionItemInsertTextRule.InsertAsSnippet)
    expect(item.kind).toBe(host.languages.CompletionItemKind.Method)
    const resolutions = request.mock.calls.filter(([req]) => req.method === 'completionItem/resolve')
    expect(resolutions.map(([req]) => req.params)).toEqual([original, original, original])
    expect(raw).toEqual(original)
  })

  it('retains richer resolved prose and replaces edits once, including after null', async () => {
    const item = await complete({ label: 'clear', kind: 2, detail: 'void std::vector::clear()', documentation: 'Initial.', additionalTextEdits: [includeEdit] })
    const richerEdit = { ...includeEdit, newText: '#include <vector>\n// resolved\n' }
    await resolve(item, { label: 'clear', documentation: { kind: 'markdown', value: 'Richer server prose.' }, additionalTextEdits: [richerEdit] })
    await resolve(item, null)
    expect(item.documentation).toEqual({ value: VECTOR_CLEAR_DOC + '\n\n---\nRicher server prose.' })
    expect(item.detail).toBe('C++ standard library')
    expect(item.additionalTextEdits).toEqual([{ ...initialMonacoEdit, text: richerEdit.newText }])
  })

  it.each(['', { kind: 'markdown', value: '' }])('does not resurrect explicitly cleared qualified raw prose after null: %j', async documentation => {
    const item = await complete({ label: 'clear', kind: 2, detail: 'void std::vector::clear()', documentation: 'Must be cleared.' })
    await resolve(item, { label: 'clear', documentation })
    expect(item.documentation).toEqual({ value: VECTOR_CLEAR_DOC })
    await resolve(item, null)
    expect(item.documentation).toEqual({ value: VECTOR_CLEAR_DOC })
    expect(item.detail).toBe('C++ standard library')
  })

  it.each(['', { kind: 'markdown', value: '' }])('clears displayed unqualified prose rather than retaining its old rendering: %j', async documentation => {
    const item = await complete({ label: 'local', kind: 3, detail: 'void local()', documentation: 'Must be cleared.' })
    await resolve(item, { label: 'local', documentation })
    expect(item.documentation).toBeUndefined()
    await resolve(item, null)
    expect(item.documentation).toBeUndefined()
    expect(item.detail).toBe('void local()')
  })

  it('accepts owner proof supplied during resolution without duplicating supplemental text', async () => {
    const item = await complete({ label: 'clear', kind: 2, detail: 'void clear()', documentation: 'Initial raw.' })
    expect(item.documentation).toEqual({ value: 'Initial raw.' })
    await resolve(item, { label: 'clear', detail: 'void std::vector::clear()', documentation: 'Resolved raw.' })
    await resolve(item, { label: 'clear' })
    expect(item.documentation).toEqual({ value: VECTOR_CLEAR_DOC + '\n\n---\nResolved raw.' })
    expect(item.detail).toBe('C++ standard library')
  })

  it('retracts prior curated prose and badge when resolved ownership contradicts a qualified label', async () => {
    const item = await complete({ label: 'std::vector::clear', kind: 2, detail: 'void clear()', documentation: 'Initial vector.' })
    await resolve(item, { label: 'std::vector::clear', detail: 'void Widget::clear()', documentation: 'Actually foreign.' })
    expect(item.documentation).toEqual({ value: 'Actually foreign.' })
    expect(item.detail).toBe('void Widget::clear()')
    await resolve(item, null)
    expect(item.documentation).toEqual({ value: 'Actually foreign.' })
    expect(item.detail).toBe('void Widget::clear()')
  })

  it('retracts prior curated prose and badge when resolution supplies a foreign label', async () => {
    const raw = { label: 'std::vector::clear', kind: 2, detail: 'void clear()', documentation: 'Initial vector.', data: { token: 'unchanged' } }
    const original = structuredClone(raw)
    const item = await complete(raw)
    await resolve(item, { label: 'Widget::clear', documentation: 'Foreign label documentation.' })
    expect(item.documentation).toEqual({ value: 'Foreign label documentation.' })
    expect(item.detail).toBe('void clear()')
    await resolve(item, null)
    expect(item.documentation).toEqual({ value: 'Foreign label documentation.' })
    expect(item.detail).toBe('void clear()')
    expect(request.mock.calls.filter(([req]) => req.method === 'completionItem/resolve').map(([req]) => req.params)).toEqual([original, original])
    expect(raw).toEqual(original)
  })

  it('drops prior owner proof when resolution replaces a qualified label with a bare label', async () => {
    const raw = { label: 'std::vector::clear', kind: 2, detail: 'void clear()', documentation: 'Initial vector prose.', data: { opaque: { token: ['original', 9] } } }
    const original = structuredClone(raw)
    const item = await complete(raw)
    await resolve(item, { label: 'localClear', documentation: 'Bare replacement prose.' })
    expect(item.documentation).toEqual({ value: 'Bare replacement prose.' })
    expect(item.detail).toBe('void clear()')
    await resolve(item, null)
    expect(item.documentation).toEqual({ value: 'Bare replacement prose.' })
    expect(item.detail).toBe('void clear()')
    expect(request.mock.calls.filter(([req]) => req.method === 'completionItem/resolve').map(([req]) => req.params)).toEqual([original, original])
    expect(raw).toEqual(original)
  })

  it.each(['void clear()', ''])('drops prior detail-only proof when resolution explicitly replaces that detail: %j', async detail => {
    const raw = { label: 'clear', kind: 2, detail: 'void std::vector::clear()', documentation: 'Initial vector prose.', data: { opaque: 'original' } }
    const original = structuredClone(raw)
    const item = await complete(raw)
    await resolve(item, { detail, documentation: 'Replacement server prose.' })
    expect(item.documentation).toEqual({ value: 'Replacement server prose.' })
    expect(item.detail).toBe(detail)
    await resolve(item, null)
    expect(item.documentation).toEqual({ value: 'Replacement server prose.' })
    expect(item.detail).toBe(detail)
    expect(request.mock.calls.filter(([req]) => req.method === 'completionItem/resolve').map(([req]) => req.params)).toEqual([original, original])
    expect(raw).toEqual(original)
  })

  it('ignores deferred cancelled documentation, ownership and edits in raw state as well as display', async () => {
    const item = await complete({ label: 'clear', kind: 2, detail: 'void std::vector::clear()', documentation: 'Accepted.', additionalTextEdits: [includeEdit] })
    const pending = deferred<RawCompletion>()
    request.mockReturnValueOnce(pending.promise)
    const cancellation = { isCancellationRequested: false }
    const resolving = completions.get('cpp')!.resolveCompletionItem!(item, cancellation as monaco.CancellationToken)
    cancellation.isCancellationRequested = true
    pending.resolve({ label: 'clear', detail: 'void Widget::clear()', documentation: 'Cancelled.', additionalTextEdits: [] })
    await resolving
    await resolve(item, null)
    expect(item.documentation).toEqual({ value: VECTOR_CLEAR_DOC + '\n\n---\nAccepted.' })
    expect(item.detail).toBe('C++ standard library')
    expect(item.additionalTextEdits).toEqual([initialMonacoEdit])
  })

  it.each(['older-first', 'newer-first'] as const)('only the latest overlapping resolution commits: %s', async order => {
    const raw = { label: 'clear', kind: 2, detail: 'void std::vector::clear()', documentation: 'Initial.', additionalTextEdits: [includeEdit], data: { token: 'original', nested: [1, 2] } }
    const original = structuredClone(raw)
    const item = await complete(raw)
    const older = deferred<RawCompletion>()
    const newer = deferred<RawCompletion>()
    request.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const provider = completions.get('cpp')!
    const first = provider.resolveCompletionItem!(item, token)
    const second = provider.resolveCompletionItem!(item, token)
    const oldResult = { label: 'clear', detail: 'void Widget::clear()', documentation: 'Older.', additionalTextEdits: [] }
    const newEdit = { ...includeEdit, newText: '#include <vector>\n// latest\n' }
    const newResult = { label: 'clear', detail: 'void std::vector::clear()', documentation: 'Latest.', additionalTextEdits: [newEdit] }
    if (order === 'older-first') {
      older.resolve(oldResult)
      await first
      expect(item.documentation).toEqual({ value: VECTOR_CLEAR_DOC + '\n\n---\nInitial.' })
      expect(item.detail).toBe('C++ standard library')
      expect(item.additionalTextEdits).toEqual([initialMonacoEdit])
      newer.resolve(newResult)
      await second
    } else {
      newer.resolve(newResult)
      await second
      older.resolve(oldResult)
      await first
    }
    await resolve(item, null)
    expect(item.documentation).toEqual({ value: VECTOR_CLEAR_DOC + '\n\n---\nLatest.' })
    expect(item.detail).toBe('C++ standard library')
    expect(item.additionalTextEdits).toEqual([{ ...initialMonacoEdit, text: newEdit.newText }])
    expect(request.mock.calls.filter(([req]) => req.method === 'completionItem/resolve').map(([req]) => req.params)).toEqual([original, original, original])
    expect(raw).toEqual(original)
  })
})

describe('actual hover provenance and selected receiver', () => {
  it('keeps standard-library server hover raw with its original converted range', async () => {
    const model = open('clear')
    request.mockResolvedValueOnce({ contents: 'Server-only clear signature.', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } })
    expect(await hovers.get('cpp')!.provideHover(model.api, model.at('clear'), token)).toEqual({
      contents: [{ value: 'Server-only clear signature.' }],
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 6 }
    })
  })

  it('does not invent an unresolved standard-library hover', async () => {
    expect(await hover(open('clear'), 'clear')).toBeNull()
  })

  it.each([
    'servo.write(90); widget.write(1);',
    'widget.write(1); servo.write(90);'
  ])('uses each selected receiver instead of the first same-line match: %s', async calls => {
    const model = open('#include <ESP32Servo.h>\nServo servo; Widget widget;\n' + calls)
    const servoOccurrence = calls.startsWith('servo') ? 1 : 2
    const widgetOccurrence = servoOccurrence === 1 ? 2 : 1
    expect(await hover(model, 'write', servoOccurrence)).toEqual({ contents: [{ value: SERVO_WRITE_DOC }], range: undefined })
    expect(await hover(model, 'write', widgetOccurrence)).toBeNull()
    expect(await hover(model, 'write', widgetOccurrence, 'Actual Widget documentation.')).toEqual({ contents: [{ value: 'Actual Widget documentation.' }], range: undefined })
  })

  it.each([
    'servo.write(90);', 'servo -> write(90);', 'servo  .  write(90);',
    'return servo.write(90);', 'co_return servo.write(90);'
  ])('retains genuine simple receiver hover: %s', async call => {
    const declaration = call.includes('->') ? 'Servo* servo;' : 'Servo servo;'
    const model = open('#include <ESP32Servo.h>\n' + declaration + '\n' + call)
    expect(await hover(model, 'write', 1, 'Server member details.')).toEqual({ contents: [{ value: SERVO_WRITE_DOC + '\n\n---\nServer member details.' }], range: undefined })
  })

  it('retains genuine class hover with an included header', async () => {
    expect(await hover(open('#include <ESP32Servo.h>\nServo servo;'), 'Servo')).toEqual({ contents: [{ value: SERVO_CLASS_DOC }], range: undefined })
  })

  it.each([
    ['missing header', 'Servo servo;\nservo.write(90);'],
    ['unknown receiver', '#include <ESP32Servo.h>\nWidget servo;\nservo.write(90);']
  ])('refuses guessed hardware hover for %s', async (_name, source) => {
    expect(await hover(open(source), 'write')).toBeNull()
  })

  it.each([
    'object.servo.write(90);', 'object->servo.write(90);', 'ns::servo.write(90);',
    'makeServo().write(90);', 'servos[0].write(90);', '(servo).write(90);'
  ])('does not shorten a compound receiver into known hardware: %s', async call => {
    expect(await hover(open('#include <ESP32Servo.h>\nServo servo;\n' + call), 'write')).toBeNull()
  })

  it('preserves CRLF and supplementary-Unicode offsets before the selected word', async () => {
    const source = '#include <ESP32Servo.h>\r\nServo servo; Widget widget;\r\n/* \u{1f642} */ widget.write(1); servo . write(90);'
    const model = open(source)
    const position = model.at('write', 2)
    expect(model.api.getOffsetAt(position)).toBe(source.lastIndexOf('write'))
    expect(await hover(model, 'write', 2)).toEqual({ contents: [{ value: SERVO_WRITE_DOC }], range: undefined })
    expect(await hover(model, 'write', 1)).toBeNull()
  })

  it('invalidates header and type inference when the same model changes version', async () => {
    const model = open('#include <ESP32Servo.h>\nServo servo;\nservo.write(90);')
    expect(await hover(model, 'write')).toEqual({ contents: [{ value: SERVO_WRITE_DOC }], range: undefined })
    model.replace('#include <ESP32Servo.h>\nWidget servo;\nservo.write(90);')
    lsp.changeDoc(model.api, model.api.getValue())
    expect(await hover(model, 'write')).toBeNull()
    model.replace('Servo servo;\nservo.write(90);')
    lsp.changeDoc(model.api, model.api.getValue())
    expect(await hover(model, 'write')).toBeNull()
  })
})

describe('actual hardware lexical and header boundaries', () => {
  it.each(['#include <ESP32Servo.h>', '# include "vendor/ESP32Servo.h"'])('accepts a genuine header: %s', async header => {
    expect(await hover(open(header + '\nServo servo;\nservo.write(90);'), 'write')).toEqual({ contents: [{ value: SERVO_WRITE_DOC }], range: undefined })
  })

  it.each([
    '// #include <ESP32Servo.h>',
    '/*\n#include <ESP32Servo.h>\n*/',
    'const char* text = "#include <ESP32Servo.h>";',
    'const char* text = R"tag(\n#include <ESP32Servo.h>\n)tag";',
    'const char* text = R"tag(\n#include "ESP32Servo.h"\n)tag";'
  ])('rejects pseudo-includes while retaining a real declaration: %s', async header => {
    expect(await hover(open(header + '\nServo servo;\nservo.write(90);'), 'write')).toBeNull()
  })

  it.each([
    ['line comment member', '// servo.write(90);', 'write'],
    ['block comment member', '/* servo.write(90); */', 'write'],
    ['string member', 'const char* text = "servo.write(90);";', 'write'],
    ['raw member', 'const char* text = R"tag(servo.write(90);)tag";', 'write'],
    ['unfinished string member', 'const char* text = "servo.write(90);', 'write'],
    ['unfinished raw member', 'const char* text = R"tag(servo.write(90);', 'write'],
    ['line comment class', '// Servo', 'Servo'],
    ['string class', 'const char* text = "Servo";', 'Servo'],
    ['character literal class', "const auto text = 'Servo';", 'Servo'],
    ['raw class', 'const char* text = R"tag(Servo)tag";', 'Servo']
  ])('rejects a masked cursor before class/member lookup: %s', async (_name, body, word) => {
    const source = '#include <ESP32Servo.h>\nServo servo;\n' + body
    const occurrence = word === 'Servo' ? 2 : 1
    expect(await hover(open(source), word, occurrence)).toBeNull()
  })

  it.each([
    'const char* text = R"tag(" Servo fake;)tag";',
    'const char* text = "Servo fake;'
  ])('does not infer a genuine receiver from a fake literal declaration: %s', async literal => {
    const model = open('#include <ESP32Servo.h>\n' + literal + '\nfake.write(90);')
    expect(await hover(model, 'write')).toBeNull()
  })

  it.each([
    ['real type', 'Servo fake;', true],
    ['raw literal type', 'const char* text = R"tag(" Servo fake;)tag";', false],
    ['unfinished literal type', 'const char* text = "Servo fake;', false]
  ])('uses the same real lexical view for hardware completion: %s', async (_name, declaration, expected) => {
    const model = open('#include <ESP32Servo.h>\n' + declaration + '\nfake.')
    request.mockResolvedValueOnce([])
    const list = await completions.get('cpp')!.provideCompletionItems(model.api, model.after('fake.'), { triggerKind: 0 }, token)
    const writes = list?.suggestions.filter(item => item.label === 'write')
    if (expected) {
      expect(writes).toHaveLength(1)
      expect(writes![0].documentation).toEqual({ value: SERVO_WRITE_DOC })
      expect(writes![0].detail).toBe('void write(int value)')
      expect(writes![0].insertText).toBe('write($0)')
      expect(writes![0].kind).toBe(host.languages.CompletionItemKind.Method)
    } else expect(writes).toEqual([])
  })

  it.each([
    '// servo.',
    '/* servo. */',
    'const char* text = "servo.";',
    'const char* text = R"tag(servo.)tag";',
    'const char* text = "servo.',
    'const char* text = R"tag(servo.'
  ])('does not infer hardware members from a masked completion prefix: %s', async body => {
    const model = open('#include <ESP32Servo.h>\nServo servo;\n' + body)
    request.mockResolvedValueOnce([])
    const list = await completions.get('cpp')!.provideCompletionItems(model.api, model.after('servo.'), { triggerKind: 0 }, token)
    expect(list?.suggestions.filter(item => item.kind === host.languages.CompletionItemKind.Method)).toEqual([])
  })

  it('retains genuine hardware completion after a same-line comment', async () => {
    const model = open('#include <ESP32Servo.h>\nServo servo;\n/* context */ servo.')
    request.mockResolvedValueOnce([])
    const list = await completions.get('cpp')!.provideCompletionItems(model.api, model.after('servo.'), { triggerKind: 0 }, token)
    expect(list?.suggestions.find(item => item.label === 'write')?.documentation).toEqual({ value: SERVO_WRITE_DOC })
  })
})
