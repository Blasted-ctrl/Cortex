import { beforeEach, expect, it, vi } from 'vitest'
import type * as monaco from 'monaco-editor'
import { registerNativeLibQuickFixes } from '../src/renderer/src/lsp/nativeLibQuickFix'

vi.mock('../src/renderer/src/store/useStore', () => ({ useStore: { getState: () => ({ installNativeLib: vi.fn() }) } }))

const providers = new Map<string, monaco.languages.CodeActionProvider>()
beforeEach(() => {
  providers.clear()
  registerNativeLibQuickFixes({
    editor: { registerCommand: vi.fn() },
    languages: { registerCodeActionProvider: (language: string, provider: monaco.languages.CodeActionProvider) => providers.set(language, provider) }
  } as unknown as typeof monaco)
})

it.each([
  ['#include <Arduino.h>\n#include <opencv2/core.hpp>', 0],
  ['#include <opencv2/core.hpp>\nint main() {}', 1]
])('offers a PC OpenCV install only for host source: %s', async (source, expected) => {
  const result = await providers.get('cpp')!.provideCodeActions(
    { getValue: () => source } as unknown as monaco.editor.ITextModel,
    {} as monaco.Range,
    { markers: [{ message: "'opencv2/core.hpp' file not found" }] } as monaco.languages.CodeActionContext,
    {} as monaco.CancellationToken
  )
  expect(result?.actions).toHaveLength(expected)
})
