import type * as monaco from 'monaco-editor'
import { libForDiagnostic } from '@shared/nativeLibs'
import { useStore } from '../store/useStore'
import { includedHeaders } from '@shared/libraryComplete'

const COMMAND = 'cortex.installNativeLib'

/**
 * Quick Fix (Ctrl+.) for a missing native library: an unresolved
 * `#include <opencv2/...>` in C/C++ or `import cv2` in Python becomes an
 * "Install OpenCV" action. It runs the same install as Settings > Libraries, so
 * it streams to the Output panel and refreshes the editor when it finishes.
 */
export function registerNativeLibQuickFixes(m: typeof monaco): void {
  m.editor.registerCommand(COMMAND, (_accessor, libId: string, target: 'cpp' | 'python') => {
    void useStore.getState().installNativeLib(libId, target)
  })
  for (const lang of ['c', 'cpp', 'python']) {
    m.languages.registerCodeActionProvider(lang, {
      provideCodeActions(model, _range, context) {
        const seen = new Set<string>()
        const actions: monaco.languages.CodeAction[] = []
        for (const marker of context.markers) {
          const hit = libForDiagnostic(marker.message)
          if (!hit || seen.has(`${hit.lib.id}:${hit.target}`)) continue
          if (hit.lib.id === 'opencv' && hit.target === 'cpp' && includedHeaders(model.getValue()).has('arduino.h')) continue
          seen.add(`${hit.lib.id}:${hit.target}`)
          const title = `Install ${hit.lib.name} for ${hit.target === 'cpp' ? 'C/C++' : 'Python'}`
          actions.push({
            title,
            kind: 'quickfix',
            diagnostics: [marker],
            isPreferred: true,
            command: { id: COMMAND, title, arguments: [hit.lib.id, hit.target] }
          })
        }
        return { actions, dispose: () => {} }
      }
    })
  }
}
