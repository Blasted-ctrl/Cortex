import type { Plugin } from 'vite'

const CALLS = [
  'this.runDelayer.trigger(() => { this._onPositionChanged(e); })',
  'this.runDelayer.trigger(() => { this._run(); })'
]

/** Backport the upstream word-highlighter cancellation fix to Monaco 0.52.2.
 * Only these owned promises are handled; unrelated renderer errors still surface.
 * https://github.com/microsoft/monaco-editor/issues/4859
 * https://github.com/microsoft/vscode/blob/main/src/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.ts
 */
export function patchMonacoWordHighlighter(source: string): string {
  if (!source.includes('import { onUnexpectedError, onUnexpectedExternalError }')) {
    throw new Error('Monaco word-highlighter changed: review or remove the cancellation backport.')
  }
  let patched = source
  for (const call of CALLS) {
    const original = `${call};`
    const fixed = `${call}.catch(onUnexpectedError);`
    const originalCount = patched.split(original).length - 1
    const fixedCount = patched.split(fixed).length - 1
    if (originalCount + fixedCount !== 1) {
      throw new Error('Monaco word-highlighter changed: review or remove the cancellation backport.')
    }
    patched = patched.replace(original, fixed)
  }
  return patched
}

export function monacoCancellationPatch(): Plugin {
  return {
    name: 'cortex-monaco-word-highlight-cancellation',
    enforce: 'pre',
    transform(source, id) {
      const path = id.split('?')[0].replace(/\\/g, '/')
      if (!path.endsWith('/monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js')) return null
      return { code: patchMonacoWordHighlighter(source), map: null }
    }
  }
}
