import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript'
import { IPC } from '../src/shared/ipc'

function preload() {
  const listeners = new Map<string, (event: unknown, value: unknown) => void>()
  const calls: string[] = []
  let api: {
    onRunOutput: (callback: (payload: unknown) => void) => () => void
    onRunExit: (callback: (payload: unknown) => void) => () => void
  }
  const ipcRenderer = {
    on: (channel: string, callback: (event: unknown, value: unknown) => void) => listeners.set(channel, callback),
    removeListener: (channel: string) => listeners.delete(channel),
    send: (channel: string, token: string) => calls.push(`${channel}:${token}`)
  }
  const source = readFileSync(join(__dirname, '../src/preload/index.ts'), 'utf8')
  const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText
  runInNewContext(code, {
    exports: {},
    require: (specifier: string) => {
      if (specifier === 'electron') return { ipcRenderer, contextBridge: { exposeInMainWorld: (_name: string, bridge: typeof api) => { api = bridge } } }
      if (specifier === '../shared/ipc') return { IPC }
      throw new Error(`Unexpected runtime dependency in sandboxed preload: ${specifier}`)
    }
  })
  return { api: api!, calls, listeners }
}

describe('actual sandboxed preload output acknowledgements', () => {
  it.each([
    ['onRunOutput', IPC.RUN_OUTPUT], ['onRunExit', IPC.RUN_EXIT]
  ] as const)('ACKs %s only after its synchronous renderer callback completes', (method, channel) => {
    const { api, calls, listeners } = preload()
    const remove = api[method](() => { expect(calls).toEqual([]); calls.push('renderer handled') })
    listeners.get(channel)?.({}, { id: 'run', deliveryToken: 'current' })
    expect(calls).toEqual(['renderer handled', `${IPC.RUN_OUTPUT_ACK}:current`])
    remove()
    expect(listeners.has(channel)).toBe(false)
  })

  it.each([
    ['onRunOutput', IPC.RUN_OUTPUT], ['onRunExit', IPC.RUN_EXIT]
  ] as const)('preserves a throwing %s callback while returning delivery credit', (method, channel) => {
    const { api, calls, listeners } = preload()
    const failure = new Error('Renderer callback failed')
    api[method](() => { throw failure })
    expect(() => listeners.get(channel)?.({}, { id: 'run', deliveryToken: 'exception' })).toThrow(failure)
    expect(calls).toEqual([`${IPC.RUN_OUTPUT_ACK}:exception`])
  })

  it('does not invent ACK tokens for old payloads or missing listeners', () => {
    const { api, calls, listeners } = preload()
    expect(listeners.size).toBe(0)
    api.onRunOutput(() => {})
    listeners.get(IPC.RUN_OUTPUT)?.({}, { id: 'old', data: 'legacy', stream: 'stdout' })
    expect(calls).toEqual([])
  })
})
