import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as monaco from 'monaco-editor'

// Items are shaped like the ones a real clangd returned for OpenCV: the label is
// the full signature (a leading bullet means "will add the include"), filterText
// is the bare name, detail is the return type, and documentation is raw doxygen.
const DOXYGEN = '@brief Loads an image from a file. @param filename Name of file to be loaded.'

function modelFixture(initialText: string) {
  const text = initialText
  const lineStart = (lineNumber: number): number => {
    let offset = 0
    for (let line = 1; line < lineNumber; line++) offset = text.indexOf('\n', offset) + 1
    return offset
  }
  const lineContent = (lineNumber: number): string => {
    const start = lineStart(lineNumber)
    const newline = text.indexOf('\n', start)
    return text.slice(start, newline < 0 ? text.length : newline)
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
    getVersionId: () => 1,
    getValue: () => text,
    getLineContent: lineContent,
    getOffsetAt: offsetAt,
    getWordAtPosition: wordAt,
    getWordUntilPosition: (position: monaco.IPosition) => {
      const word = wordAt(position)
      return word ? { ...word, word: word.word.slice(0, position.column - word.startColumn), endColumn: position.column }
        : { word: '', startColumn: position.column, endColumn: position.column }
    },
    getValueInRange: () => '',
    isDisposed: () => false
  } as unknown as monaco.editor.ITextModel
  return {
    api,
    after(needle: string): monaco.IPosition {
      const offset = text.indexOf(needle)
      if (offset < 0) throw new Error(`Missing fixture prefix: ${needle}`)
      return positionAt(offset + needle.length)
    },
    at(needle: string): monaco.IPosition {
      const match = [...text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].find((m) => m[0] === needle)
      if (!match) throw new Error(`Missing fixture word: ${needle}`)
      return positionAt(match.index!)
    }
  }
}

let lsp: typeof import('../src/renderer/src/lsp/lspClient')
let request: ReturnType<typeof vi.fn>
let completions: Map<string, monaco.languages.CompletionItemProvider>
let hovers: Map<string, monaco.languages.HoverProvider>
let models: monaco.editor.ITextModel[]
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
  const host = {
    editor: { setModelMarkers: vi.fn(), registerCommand: vi.fn() },
    languages: {
      registerCodeActionProvider: vi.fn(),
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

function open(source: string) {
  const model = modelFixture(source)
  models.push(model.api)
  lsp.openDoc(`C:/cortex-owned-lsp/file-${models.length}.cpp`, 'C:/cortex-owned-lsp', model.api, source)
  return model
}

const INC = '#include <opencv2/opencv.hpp>\n'

async function completeAt(source: string, prefix: string, items: object[]) {
  const model = open(source)
  request.mockResolvedValueOnce(items)
  const list = await completions.get('cpp')!.provideCompletionItems(model.api, model.after(prefix), { triggerKind: 0 }, token)
  return list?.suggestions ?? []
}

const imread = {
  label: '\u2022imread(const String &filename, int flags = IMREAD_COLOR_BGR)',
  filterText: 'imread',
  kind: 3,
  detail: 'Mat',
  documentation: DOXYGEN
}

describe('OpenCV completion documentation', () => {
  it('replaces the raw doxygen on cv::imread with the curated description, signature and example', async () => {
    const items = await completeAt(`${INC}int main() {\n  cv::imre\n}\n`, 'cv::imre', [imread])
    const item = items.find((s) => s.label === imread.label)!
    const doc = item.documentation as { value: string }
    expect(doc.value).toContain('Loads an image from a file and returns it as a Mat in BGR channel order')
    expect(doc.value).toContain('cv::Mat img = cv::imread("photo.jpg", cv::IMREAD_COLOR);')
    expect(doc.value).toContain('Mat imread(const String& filename, int flags = IMREAD_COLOR)')
    expect(doc.value).not.toContain('@brief')
    expect(item.detail).toBe('Mat imread(const String& filename, int flags = IMREAD_COLOR)')
  })

  it('documents a cv::Mat member through its declaration', async () => {
    const clone = { label: ' clone() const', filterText: 'clone', kind: 2, detail: 'Mat', documentation: 'Creates a full copy of the array.' }
    const items = await completeAt(`${INC}int main() {\n  cv::Mat m;\n  m.clon\n}\n`, 'm.clon', [clone])
    const doc = items.find((s) => s.label === clone.label)!.documentation as { value: string }
    expect(doc.value).toContain('deep copy')
  })

  it('documents a field such as rows, not only methods', async () => {
    const rows = { label: ' rows', filterText: 'rows', kind: 5, detail: 'int' }
    const items = await completeAt(`${INC}int main() {\n  cv::Mat m;\n  m.ro\n}\n`, 'm.ro', [rows])
    const doc = items.find((s) => s.label === rows.label)!.documentation as { value: string }
    expect(doc.value).toContain('image height')
  })

  it('documents a bare Mat member after "using namespace cv;"', async () => {
    const clone = { label: ' clone() const', filterText: 'clone', kind: 2, detail: 'Mat' }
    const items = await completeAt(`${INC}using namespace cv;\nint main() {\n  Mat m;\n  m.clon\n}\n`, 'm.clon', [clone])
    expect((items.find((s) => s.label === clone.label)!.documentation as { value: string }).value).toContain('deep copy')
  })

  it('documents the camera class on cv::VideoCapture', async () => {
    const cap = { label: '\u2022VideoCapture', filterText: 'VideoCapture', kind: 7, detail: 'class VideoCapture', documentation: '@brief Class for video capturing' }
    const items = await completeAt(`${INC}int main() {\n  cv::VideoCap\n}\n`, 'cv::VideoCap', [cap])
    const doc = items.find((s) => s.label === cap.label)!.documentation as { value: string }
    expect(doc.value).toContain('Reads frames from a camera')
    expect(doc.value).toContain('cv::VideoCapture cap(0);')
  })

  it('documents a global C function once its header is included', async () => {
    const init = { label: 'InitWindow(int width, int height, const char *title)', filterText: 'InitWindow', kind: 3, detail: 'void', documentation: 'raw' }
    const items = await completeAt('#include <raylib.h>\nint main() {\n  InitWin\n}\n', 'InitWin', [init])
    expect((items.find((s) => s.label === init.label)!.documentation as { value: string }).value).toContain('Opens the window')
  })
})

describe('OpenCV documentation boundaries', () => {
  it('keeps the raw text when the OpenCV header is not included', async () => {
    const items = await completeAt('int main() {\n  cv::imre\n}\n', 'cv::imre', [imread])
    expect((items.find((s) => s.label === imread.label)!.documentation as { value: string }).value).toBe(DOXYGEN)
  })

  it('keeps the raw text for the same name outside the cv namespace', async () => {
    const items = await completeAt(`${INC}int main() {\n  other::imre\n}\n`, 'other::imre', [imread])
    expect((items.find((s) => s.label === imread.label)!.documentation as { value: string }).value).toBe(DOXYGEN)
  })

  it('keeps the raw text for an unqualified name without "using namespace cv;"', async () => {
    const items = await completeAt(`${INC}int main() {\n  imre\n}\n`, 'imre', [imread])
    expect((items.find((s) => s.label === imread.label)!.documentation as { value: string }).value).toBe(DOXYGEN)
  })

  it("does not give another namespace's Mat the OpenCV member docs", async () => {
    const clone = { label: ' clone() const', filterText: 'clone', kind: 2, detail: 'Widget', documentation: 'Widget copy.' }
    const items = await completeAt(`${INC}int main() {\n  other::Mat m;\n  m.clon\n}\n`, 'm.clon', [clone])
    expect((items.find((s) => s.label === clone.label)!.documentation as { value: string }).value).toBe('Widget copy.')
  })

  it('ignores a commented-out include and a commented-out using directive', async () => {
    const commented = '// #include <opencv2/opencv.hpp>\nint main() {\n  cv::imre\n}\n'
    const items = await completeAt(commented, 'cv::imre', [imread])
    expect((items.find((s) => s.label === imread.label)!.documentation as { value: string }).value).toBe(DOXYGEN)
  })
})

describe('OpenCV hover documentation', () => {
  const hover = async (source: string, word: string, raw: string | null) => {
    const model = open(source)
    request.mockResolvedValueOnce(raw === null ? null : { contents: raw })
    return hovers.get('cpp')!.provideHover(model.api, model.at(word), token)
  }

  it('shows the curated entry for cv::imread, keeping the server text below it', async () => {
    const result = await hover(`${INC}int main() {\n  cv::Mat a = cv::imread("x.png");\n}\n`, 'imread', 'Server hover text')
    const value = (result!.contents[0] as { value: string }).value
    expect(value).toContain('Loads an image from a file and returns it as a Mat')
    expect(value.endsWith('---\nServer hover text')).toBe(true)
  })

  it('answers even when clangd has nothing for the symbol', async () => {
    const result = await hover(`${INC}int main() {\n  cv::Mat m;\n  m.clone();\n}\n`, 'clone', null)
    expect((result!.contents[0] as { value: string }).value).toContain('deep copy')
  })

  it('shows a bare function after "using namespace cv;"', async () => {
    const result = await hover(`${INC}using namespace cv;\nint main() {\n  Mat g;\n  Canny(g, g, 50, 150);\n}\n`, 'Canny', null)
    expect((result!.contents[0] as { value: string }).value).toContain('Canny edge detector')
  })

  it('shows nothing curated for a foreign namespace or a missing include', async () => {
    expect(await hover(`${INC}int main() {\n  other::imread("x");\n}\n`, 'imread', null)).toBeNull()
    expect(await hover('int main() {\n  cv::imread("x");\n}\n', 'imread', null)).toBeNull()
  })
})
