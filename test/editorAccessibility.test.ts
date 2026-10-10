import { act, createElement } from 'react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { langFromPath } from '../src/shared/languages'
import { createHost, invoke, type HostNode } from './reactHost'

vi.mock('../src/renderer/src/components/CodeEditor', () => ({ default: () => createElement('textarea', { 'aria-label': 'Fixture editor' }) }))
vi.stubGlobal('window', { api: {} })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
vi.stubGlobal('React', React)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const { useStore } = await import('../src/renderer/src/store/useStore')
const { default: EditorArea } = await import('../src/renderer/src/components/EditorArea')
const initial = useStore.getState()
const rootPath = 'C:/owned-editor-fixture'
const paths = ['a.cpp', 'b.cpp', 'c.cpp'].map((name) => `${rootPath}/${name}`)
let host: ReturnType<typeof createHost>
const tab = (path: string): HostNode => {
  const node = host.nodes().find((node) => node.props.title === path)
  if (!node) throw new Error(`Tab missing: ${path}`)
  return node
}
async function key(path: string, value: string): Promise<void> {
  const target = tab(path)
  await act(async () => { invoke(target, 'onKeyDown', { key: value, preventDefault: () => undefined, stopPropagation: () => undefined }) })
}
const fixtureTab = (path: string, group = 0) => ({ path, name: path.split('/').at(-1)!, content: 'saved', savedContent: 'saved', language: langFromPath(path), group })

beforeEach(async () => {
  useStore.setState({ ...initial, workspaceRoot: rootPath, tabs: paths.map((path) => fixtureTab(path)), activePath: paths[0], activeGroup: 0, groupActive: { 0: paths[0], 1: null } }, true)
  host = createHost()
  await host.render(createElement(EditorArea))
})
afterEach(async () => { await host.render(null) })

describe('editor tab keyboard and relationships', () => {
  it('labels its tablist and connects tabs to their panels with one keyboard entry', () => {
    expect(host.nodes().filter((node) => node.props.role === 'tablist' && node.props['aria-label'] === 'Editor tabs')).toHaveLength(1)
    const tabs = host.nodes().filter((node) => node.props.role === 'tab')
    expect(tabs).toHaveLength(3)
    expect(tabs.filter((node) => node.props.tabIndex === 0)).toHaveLength(1)
    expect(tabs.filter((node) => node.props['aria-selected'] === true)).toEqual([tab(paths[0])])
    for (const current of tabs) {
      const panel = host.nodes().find((node) => node.props.id === current.props['aria-controls'])
      expect(panel?.props).toMatchObject({ role: 'tabpanel', 'aria-labelledby': current.props.id })
    }
  })

  it('wraps focus with arrows and Home/End without activating until Enter or Space', async () => {
    await act(async () => { tab(paths[0]).focus() })
    await key(paths[0], 'ArrowLeft')
    expect(host.focused()?.props.title).toBe(paths[2])
    expect(useStore.getState().activePath).toBe(paths[0])
    await key(paths[2], 'ArrowRight')
    expect(host.focused()?.props.title).toBe(paths[0])
    await key(paths[0], 'End')
    expect(host.focused()?.props.title).toBe(paths[2])
    await key(paths[2], 'Enter')
    expect(useStore.getState().activePath).toBe(paths[2])
    await key(paths[2], 'Home')
    await key(paths[0], ' ')
    expect(useStore.getState().activePath).toBe(paths[0])
  })

  it('does not use vertical arrows or modified shortcuts to change the selected file', async () => {
    await act(async () => { tab(paths[0]).focus() })
    await key(paths[0], 'ArrowDown')
    expect(host.focused()?.props.title).toBe(paths[0])
    const preventDefault = vi.fn()
    await act(async () => { invoke(tab(paths[0]), 'onKeyDown', { key: 'ArrowRight', ctrlKey: true, preventDefault }) })
    expect(preventDefault).not.toHaveBeenCalled()
    expect(useStore.getState().activePath).toBe(paths[0])
  })

  it('cancels a dirty keyboard close without losing the buffer or its focus', async () => {
    await act(async () => { useStore.getState().updateContent(paths[0], 'unsaved fixture') })
    await key(paths[0], 'Delete')
    expect(useStore.getState().confirmDialog?.title).toBe('Discard unsaved changes?')
    await act(async () => { useStore.getState().answerConfirm(false) })
    expect(useStore.getState().tabs.find((current) => current.path === paths[0])?.content).toBe('unsaved fixture')
    expect(host.focused()?.props.title).toBe(paths[0])
  })

  it('closes only the confirmed dirty tab and focuses the surviving selection', async () => {
    await act(async () => { useStore.getState().updateContent(paths[0], 'unsaved fixture') })
    await key(paths[0], 'Delete')
    await act(async () => { useStore.getState().answerConfirm(true) })
    expect(useStore.getState().tabs.map((current) => current.path)).toEqual([paths[1], paths[2]])
    expect(host.focused()?.props.title).toBe(useStore.getState().activePath)
  })

  it('does not open a second confirmation for a repeated close while one is pending', async () => {
    await act(async () => { useStore.getState().updateContent(paths[0], 'unsaved fixture') })
    await key(paths[0], 'Delete')
    const confirmation = useStore.getState().confirmDialog
    await key(paths[0], 'Delete')
    expect(useStore.getState().confirmDialog).toBe(confirmation)
    await act(async () => { useStore.getState().answerConfirm(false) })
    expect(useStore.getState().tabs).toHaveLength(3)
  })

  it('gives each split pane its own entry point and keyboard focus selects the pane', async () => {
    await act(async () => { useStore.getState().moveTabToGroup(paths[2], 1) })
    expect(host.nodes().filter((node) => node.props.role === 'tablist')).toHaveLength(2)
    expect(host.nodes().filter((node) => node.props.role === 'tab' && node.props.tabIndex === 0)).toHaveLength(2)
    await act(async () => { tab(paths[0]).focus() })
    expect(useStore.getState().activeGroup).toBe(0)
    await act(async () => { tab(paths[2]).focus() })
    expect(useStore.getState().activeGroup).toBe(1)
    expect(useStore.getState().activePath).toBe(paths[2])
    await key(paths[2], 'ArrowRight')
    expect(host.focused()?.props.title).toBe(paths[2])
  })

  it('names close controls and makes closing the final tab return focus to the editor', async () => {
    const close = host.nodes().find((node) => node.props['aria-label'] === 'Close a.cpp')
    expect(close?.props.tabIndex).toBe(-1)
    await act(async () => { useStore.setState({ tabs: [fixtureTab(paths[0])], activePath: paths[0], groupActive: { 0: paths[0], 1: null } }) })
    await key(paths[0], 'Delete')
    expect(useStore.getState().tabs).toHaveLength(0)
    expect(host.focused()?.props['aria-label']).toBe('Editor')
  })

  it('provides a keyboard stop on read-only content and safe relationships for unusual filenames', async () => {
    const path = `${rootPath}/odd-\ud800.cpp`
    await act(async () => { useStore.setState({ tabs: [{ ...fixtureTab(path), readOnlyReason: 'Fixture is not editable' }], activePath: path, groupActive: { 0: path, 1: null } }) })
    const active = tab(path)
    const panel = host.nodes().find((node) => node.props.id === active.props['aria-controls'])
    expect(panel?.props).toMatchObject({ role: 'tabpanel', 'aria-labelledby': active.props.id, tabIndex: 0 })
  })
})
