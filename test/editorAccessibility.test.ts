import { act, createElement } from 'react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { langFromPath } from '../src/shared/languages'
import { createHost, descendants, invoke, type HostNode } from './reactHost'

vi.mock('../src/renderer/src/components/CodeEditor', () => ({ default: () => createElement('textarea', { 'aria-label': 'Fixture editor' }) }))
vi.stubGlobal('window', { api: {} })
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
vi.stubGlobal('React', React)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const observers = new Set<FixtureObserver>()
class FixtureObserver {
  target: HostNode | null = null
  constructor(private callback: () => void) { observers.add(this) }
  observe(target: HostNode): void { this.target = target; this.callback() }
  disconnect(): void { observers.delete(this) }
  fire(): void { this.callback() }
}
vi.stubGlobal('ResizeObserver', FixtureObserver)
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
  observers.clear()
  storage.clear()
  storage.set('cortex.sidebarWidth', String(initial.sidebarWidth))
  storage.set('cortex.aiWidth', String(initial.aiWidth))
  storage.set('cortex.bottomHeight', String(initial.bottomHeight))
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

const editor = (): HostNode => {
  const node = host.nodes().find((node) => node.props.role === 'region' && node.props['aria-label'] === 'Editor')
  if (!node) throw new Error('Editor region missing')
  return node
}
const editorSplitter = (): HostNode => {
  const node = host.nodes().find((node) => node.props.role === 'separator' && node.props.title === 'Resize editor split')
  if (!node) throw new Error('Editor splitter missing')
  return node
}
const controlledLeftPane = (): HostNode => {
  const controls = editorSplitter().props['aria-controls']
  expect(controls).toEqual(expect.any(String))
  const node = host.nodes().find((node) => node.props.id === controls)
  expect(node).toBeDefined()
  if (!node) throw new Error('Controlled left editor pane missing')
  expect(descendants(node)).toContain(tab(paths[0]))
  return node
}
function expectLeftPercentage(value: number): void {
  expect(controlledLeftPane().props.style).toEqual({ flex: `0 0 ${value}%` })
  expect(editorSplitter().props['aria-valuenow']).toBeCloseTo(value, 6)
}
const editorState = (): object => {
  const state = useStore.getState()
  return {
    activePath: state.activePath, activeGroup: state.activeGroup, groupActive: { ...state.groupActive },
    tabs: state.tabs.map(({ path, content, savedContent, group }) => ({ path, content, savedContent, group })),
    mainView: state.mainView, sidebarView: state.sidebarView, sidebarVisible: state.sidebarVisible,
    rightView: state.rightView, bottomView: state.bottomView, bottomVisible: state.bottomVisible,
    sidebarWidth: state.sidebarWidth, aiWidth: state.aiWidth, bottomHeight: state.bottomHeight,
    storage: [...storage]
  }
}
async function measureEditor(width: number): Promise<void> {
  const target = editor()
  target.clientWidth = width
  await act(async () => { for (const observer of observers) if (observer.target === target) observer.fire() })
}
async function splitEditor(width: number): Promise<void> {
  await act(async () => { useStore.getState().moveTabToGroup(paths[2], 1) })
  await measureEditor(width)
}
async function splitterKey(value: string, repeat = false): Promise<ReturnType<typeof vi.fn>> {
  const target = editorSplitter()
  const preventDefault = vi.fn()
  await act(async () => {
    const handler = target.props.onKeyDown
    if (typeof handler === 'function') handler({ key: value, repeat, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      target, currentTarget: target, preventDefault, stopPropagation: () => undefined })
  })
  return preventDefault
}

describe('actual editor split keyboard layout', () => {
  it('names the focusable vertical handle and connects it to the actual left editor wrapper', async () => {
    await splitEditor(500)
    expect(editorSplitter().props).toMatchObject({ tabIndex: 0, 'aria-label': 'Left editor pane', 'aria-orientation': 'vertical',
      'aria-valuemin': 20, 'aria-valuemax': 80, 'aria-valuenow': 50 })
    expect(editorSplitter().props['aria-valuetext']).toMatch(/50\s*%/)
    const pane = controlledLeftPane()
    const before = editorState()
    await act(async () => { editorSplitter().focus() })
    expect(host.focused()).toBe(editorSplitter())
    expect(editorState()).toEqual(before)
    await act(async () => { useStore.getState().updateContent(paths[0], 'unsaved split fixture') })
    expect(controlledLeftPane()).toBe(pane)
    expectLeftPercentage(50)
  })

  it.each([
    { width: 500, key: 'ArrowRight', percentage: 52 },
    { width: 500, key: 'ArrowLeft', percentage: 48 },
    { width: 1000, key: 'ArrowRight', percentage: 51 }
  ])('moves ten CSS pixels for $key at measured width $width without selecting a file', async ({ width, key, percentage }) => {
    await splitEditor(width)
    await act(async () => { useStore.getState().updateContent(paths[2], 'unsaved right fixture'); editorSplitter().focus() })
    const before = editorState()
    const preventDefault = await splitterKey(key)
    expectLeftPercentage(percentage)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(host.focused()).toBe(editorSplitter())
    expect(editorState()).toEqual(before)
  })

  it('uses the latest measured width for the next move without resetting its local split ratio', async () => {
    await splitEditor(500)
    await act(async () => { editorSplitter().focus() })
    const before = editorState()
    await splitterKey('ArrowRight')
    expectLeftPercentage(52)
    await measureEditor(1000)
    expectLeftPercentage(52)
    await splitterKey('ArrowLeft')
    expectLeftPercentage(51)
    expect(host.focused()).toBe(editorSplitter())
    expect(editorState()).toEqual(before)
  })

  it.each([{ key: 'Home', percentage: 20 }, { key: 'End', percentage: 80 }])('reaches its announced percentage endpoint with $key', async ({ key, percentage }) => {
    await splitEditor(500)
    await act(async () => { editorSplitter().focus() })
    const before = editorState()
    const preventDefault = await splitterKey(key)
    expectLeftPercentage(percentage)
    expect(editorSplitter().props[key === 'Home' ? 'aria-valuemin' : 'aria-valuemax']).toBe(percentage)
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(host.focused()).toBe(editorSplitter())
    expect(editorState()).toEqual(before)
  })

  it('clamps repeated axis keys at both local percentage endpoints', async () => {
    await splitEditor(500)
    await act(async () => { editorSplitter().focus() })
    const before = editorState()
    await splitterKey('End')
    await splitterKey('ArrowRight', true)
    expectLeftPercentage(80)
    await splitterKey('Home')
    await splitterKey('ArrowLeft', true)
    expectLeftPercentage(20)
    expect(host.focused()).toBe(editorSplitter())
    expect(editorState()).toEqual(before)
  })

  it('announces equal disabled endpoints at zero width, ignores resizing and recovers after measurement', async () => {
    await splitEditor(0)
    expect(editorSplitter().props).toMatchObject({ tabIndex: 0, 'aria-disabled': true,
      'aria-valuemin': 50, 'aria-valuemax': 50, 'aria-valuenow': 50 })
    await act(async () => { editorSplitter().focus() })
    const before = editorState()
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) await splitterKey(key)
    expectLeftPercentage(50)
    expect(editorState()).toEqual(before)
    await measureEditor(500)
    expect(editorSplitter().props).toMatchObject({ 'aria-valuemin': 20, 'aria-valuemax': 80 })
    expect(editorSplitter().props['aria-disabled']).not.toBe(true)
    await splitterKey('ArrowRight')
    expectLeftPercentage(52)
    expect(host.focused()).toBe(editorSplitter())
    expect(editorState()).toEqual(before)
  })

  it('keeps an adjusted local ratio when width becomes zero and restores its reachable range later', async () => {
    await splitEditor(500)
    await act(async () => { editorSplitter().focus() })
    const before = editorState()
    await splitterKey('ArrowRight')
    expectLeftPercentage(52)
    await measureEditor(0)
    expect(editorSplitter().props).toMatchObject({ 'aria-disabled': true,
      'aria-valuemin': 52, 'aria-valuemax': 52, 'aria-valuenow': 52 })
    await splitterKey('Home')
    await splitterKey('End')
    expectLeftPercentage(52)
    await measureEditor(1000)
    expect(editorSplitter().props).toMatchObject({ 'aria-valuemin': 20, 'aria-valuemax': 80 })
    expect(editorSplitter().props['aria-disabled']).not.toBe(true)
    await splitterKey('ArrowLeft')
    expectLeftPercentage(51)
    expect(host.focused()).toBe(editorSplitter())
    expect(editorState()).toEqual(before)
  })

  it('preserves the real pointer delta path and rendered ratio after adding keyboard semantics', async () => {
    await splitEditor(500)
    const before = editorState()
    const splitter = editorSplitter()
    await act(async () => {
      invoke(splitter, 'onPointerDown', { clientX: 100, currentTarget: { setPointerCapture: () => undefined }, pointerId: 1 })
      invoke(splitter, 'onPointerMove', { clientX: 110 })
      invoke(splitter, 'onPointerUp', { currentTarget: { releasePointerCapture: () => undefined }, pointerId: 1 })
    })
    expectLeftPercentage(52)
    expect(editorState()).toEqual(before)
  })

  it('adds no editor splitter when unsplit and removes it when the second group collapses', async () => {
    expect(host.nodes().filter((node) => node.props.role === 'separator')).toHaveLength(0)
    await splitEditor(500)
    expect(editorSplitter().props.tabIndex).toBe(0)
    await act(async () => { useStore.getState().moveTabToGroup(paths[2], 0) })
    expect(host.nodes().filter((node) => node.props.role === 'separator')).toHaveLength(0)
  })

  it('observes the actual editor container and disconnects measurement on unmount', async () => {
    await splitEditor(500)
    expect([...observers].some((observer) => observer.target === editor())).toBe(true)
    await host.render(null)
    expect(observers.size).toBe(0)
  })
})
