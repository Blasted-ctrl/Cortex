import { createElement, useLayoutEffect } from 'react'
import * as React from 'react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEdit, AppSettings } from '../src/renderer/src/store/useStore'
import { createHost, descendants, type HostNode } from './reactHost'

vi.stubGlobal('window', { api: {} })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
vi.stubGlobal('React', React)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const { useStore } = await import('../src/renderer/src/store/useStore')
const { default: AgentView } = await import('../src/renderer/src/components/AgentView')
const initial = useStore.getState()
const root = 'C:/owned-agent-card-fixture'
const settings: AppSettings = {
  theme: 'dark', defaultCppCompiler: '', defaultCppStandard: 'c++23', pythonPath: 'python',
  ai: { provider: 'local', model: 'presentation-fixture', apiKey: '', apiKeySet: false, baseUrl: '' },
  serial: { baudRate: 115200 }, boards: { additionalUrls: [] }
}
let host: ReturnType<typeof createHost>
const text = (node: HostNode): string => [node, ...descendants(node)].filter(child => child.type === '#text').map(child => child.props.text).join('').trim()

function Fixture(): React.ReactElement {
  useLayoutEffect(() => {
    // Only the browser scrolling primitive is absent from the real React host.
    for (const node of host.nodes()) Object.assign(node, { scrollIntoView: () => undefined })
  }, [])
  return createElement(AgentView)
}

beforeEach(() => {
  useStore.setState({ ...initial, workspaceRoot: root, settings: structuredClone(settings), agentRunning: false,
    agentLog: [{ type: 'edit', editId: 'edit-1' }], agentEdits: [] }, true)
  host = createHost()
})
afterEach(async () => { await host.render(null); useStore.setState(initial, true) })
afterAll(() => { vi.unstubAllGlobals() })

describe('actual proposal cards use reviewed existence, not empty contents', () => {
  it.each([
    { name: 'confirmed absent', originalExists: false, oldContent: '', error: undefined, isNew: true },
    { name: 'existing empty', originalExists: true, oldContent: '', error: undefined, isNew: false },
    { name: 'legacy empty', originalExists: undefined, oldContent: '', error: undefined, isNew: false },
    { name: 'refused absent', originalExists: false, oldContent: '', error: 'Cannot review this file', isNew: false },
    { name: 'legacy nonempty', originalExists: undefined, oldContent: '// original\n', error: undefined, isNew: false }
  ])('labels $name accurately and retains its review controls', async ({ originalExists, oldContent, error, isNew }) => {
    const edit: AgentEdit = { id: 'edit-1', path: `${root}/main.cpp`, oldContent, newContent: '// replacement\n',
      originalExists, error, status: error ? 'failed' : 'pending' }
    useStore.setState({ agentEdits: [edit] })
    await host.render(createElement(Fixture))
    const header = host.nodes().find(node => node.type === 'span' && node.props.title === 'main.cpp')
    expect(header).toBeDefined()
    const badges = descendants(header!).filter(node => node.type === 'span' && text(node) === 'new')
    expect(badges).toHaveLength(isNew ? 1 : 0)
    expect(text(header!)).toBe(isNew ? 'main.cppnew' : 'main.cpp')
    const controls = host.nodes().filter(node => node.type === 'button' && ['Apply this edit', 'Discard this edit'].includes(String(node.props.title)))
    expect(controls).toHaveLength(error ? 0 : 2)
    if (error) expect(host.nodes().some(node => text(node) === error)).toBe(true)
    else expect(controls.map(text)).toEqual(['Approve', 'Reject'])
  })
})
