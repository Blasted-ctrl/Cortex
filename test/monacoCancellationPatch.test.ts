import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { patchMonacoWordHighlighter, monacoCancellationPatch } from '../build/monacoCancellationPatch'

const path = 'monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js'
const source = readFileSync(`node_modules/${path}`, 'utf8')

describe('Monaco word-highlighter cancellation backport', () => {
  it('handles exactly the two discarded delayed promises in the installed source', () => {
    const fixed = patchMonacoWordHighlighter(source)
    expect(fixed.split('.catch(onUnexpectedError);').length - source.split('.catch(onUnexpectedError);').length).toBe(2)
    expect(patchMonacoWordHighlighter(fixed)).toBe(fixed)
    expect(fixed.replaceAll('.catch(onUnexpectedError);', ';')).toBe(source.replaceAll('.catch(onUnexpectedError);', ';'))
  })

  it.each(['_onPositionChanged(e)', '_run()'])('attaches a rejection handler before cancelling %s', async (action) => {
    const fixed = patchMonacoWordHighlighter(source)
    const statement = fixed.split('\n').find((line) => line.includes(`this.runDelayer.trigger(() => { this.${action}; })`))!
    const error = new Error('Controlled highlight task failure')
    const report = vi.fn()
    const run = new Function('onUnexpectedError', 'e', statement)
    run.call({ runDelayer: { trigger: () => Promise.reject(error) } }, report, {})
    await Promise.resolve()
    expect(report).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(error)
  })

  it('fails visibly when an upgrade changes the source instead of silently omitting the fix', () => {
    expect(() => patchMonacoWordHighlighter('new incompatible module')).toThrow('review or remove')
    expect(() => patchMonacoWordHighlighter(source.replace('this._onPositionChanged(e)', 'this._newPosition(e)'))).toThrow('review or remove')
  })

  it('does not transform other dependencies or application code', () => {
    const plugin = monacoCancellationPatch()
    const transform = plugin.transform as (code: string, id: string) => { code: string } | null
    expect(transform('unchanged', '/app/CodeEditor.tsx')).toBeNull()
    expect(transform(source, `C:\\deps\\node_modules\\${path.replaceAll('/', '\\')}`)?.code).toBe(patchMonacoWordHighlighter(source))
  })
})
