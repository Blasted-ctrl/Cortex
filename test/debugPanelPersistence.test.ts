import { act, createElement } from 'react'
import * as React from 'react'
import Reconciler from 'react-reconciler'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { langFromPath } from '../src/shared/languages'

vi.mock('../src/renderer/src/components/FileExplorer', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/SearchPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/BoardsManagerPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/LibraryManagerPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/HardwarePanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/EnvironmentPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/DevicesPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/VcsPanel', () => ({ default: () => null }))

const evaluate = vi.fn<(expression: string) => Promise<string>>()
vi.stubGlobal('window', { api: { debugEvaluate: evaluate } })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
vi.stubGlobal('React', React)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

const { useStore } = await import('../src/renderer/src/store/useStore')
const { default: SideBar } = await import('../src/renderer/src/components/SideBar')
const initial = useStore.getState()
const sidebarProps = { id: 'owned-debug-sidebar', width: initial.sidebarWidth, panelRef: React.createRef<HTMLDivElement>() }

type Node = { type: string; props: Record<string, unknown>; children: Node[] }
type Container = { children: Node[] }
const append = (parent: Container, child: Node): void => {
  const old = parent.children.indexOf(child)
  if (old !== -1) parent.children.splice(old, 1)
  parent.children.push(child)
}
const remove = (parent: Container, child: Node): void => {
  parent.children.splice(parent.children.indexOf(child), 1)
}
const insert = (parent: Container, child: Node, before: Node): void => {
  const old = parent.children.indexOf(child)
  if (old !== -1) parent.children.splice(old, 1)
  parent.children.splice(parent.children.indexOf(before), 0, child)
}

// Use Fiber's installed reconciler to exercise real hooks without a DOM package
// or native gdb; only unrelated panels and the IPC evaluation boundary are fake.
const renderer = Reconciler({
  supportsMutation: true, supportsPersistence: false, supportsHydration: false,
  isPrimaryRenderer: false, now: Date.now, noTimeout: -1,
  scheduleTimeout: setTimeout, cancelTimeout: clearTimeout,
  getRootHostContext: () => null, getChildHostContext: () => null,
  getPublicInstance: (node: Node) => node,
  createInstance: (type: string, props: Record<string, unknown>): Node => ({ type, props, children: [] }),
  createTextInstance: (text: string): Node => ({ type: '#text', props: { text }, children: [] }),
  appendInitialChild: append, appendChild: append, appendChildToContainer: append,
  removeChild: remove, removeChildFromContainer: remove,
  insertBefore: insert, insertInContainerBefore: insert,
  prepareUpdate: () => true,
  commitUpdate: (node: Node, _update: boolean, _type: string, _old: unknown, props: Record<string, unknown>) => { node.props = props },
  commitTextUpdate: (node: Node, _old: string, text: string) => { node.props = { text } },
  shouldSetTextContent: () => false, finalizeInitialChildren: () => false,
  prepareForCommit: () => null, resetAfterCommit: () => undefined,
  preparePortalMount: () => undefined, detachDeletedInstance: () => undefined,
  clearContainer: (container: Container) => { container.children = [] },
  getCurrentEventPriority: () => 16
})

let tree: Container
let root: ReturnType<typeof renderer.createContainer>
const nodes = (parent: Container): Node[] => parent.children.flatMap((node) => [node, ...nodes(node)])
const text = (): string => nodes(tree).filter((node) => node.type === '#text').map((node) => node.props.text).join('|')
function input(placeholder: string): Node {
  const node = nodes(tree).find((node) => node.type === 'input' && node.props.placeholder === placeholder)
  if (!node) throw new Error(`Input missing: ${placeholder}`)
  return node
}
function invoke(node: Node, handler: string, event: object): void {
  const callback = node.props[handler]
  if (typeof callback !== 'function') throw new Error(`Handler missing: ${handler}`)
  callback(event)
}
async function enter(placeholder: string, expression: string): Promise<void> {
  await act(async () => { invoke(input(placeholder), 'onChange', { target: { value: expression } }) })
  await act(async () => { invoke(input(placeholder), 'onKeyDown', { key: 'Enter' }) })
}
const setState = async (patch: Parameters<typeof useStore.setState>[0]): Promise<void> => {
  await act(async () => { useStore.setState(patch) })
}

beforeEach(async () => {
  evaluate.mockReset().mockResolvedValue('42')
  const path = 'C:/owned-debug-fixture/main.cpp'
  useStore.setState({
    ...initial, workspaceRoot: 'C:/owned-debug-fixture', sidebarView: 'debug', sidebarVisible: true,
    debug: { status: 'stopped', stack: [], frame: 0, variables: [] }, breakpoints: {},
    tabs: [{ path, name: 'main.cpp', content: '', savedContent: '', language: langFromPath(path), group: 0 }],
    activePath: path
  }, true)
  tree = { children: [] }
  root = renderer.createContainer(tree, 0, null, false, null, '', (error) => { throw error }, null)
  await act(async () => { renderer.updateContainer(createElement(SideBar, sidebarProps), root) })
})
afterEach(async () => { await act(async () => { renderer.updateContainer(null, root) }) })

describe('debugger UI lifetime', () => {
  it('preserves watches, console results, drafts and history across tool switches', async () => {
    await enter('Add expression...', 'counter')
    await enter('Evaluate expression...', 'counter + 1')
    expect(text()).toContain('counter + 1')
    expect(nodes(tree).filter((node) => node.props.title === 'Remove watch')).toHaveLength(1)
    await act(async () => { invoke(input('Add expression...'), 'onChange', { target: { value: 'nextWatch' } }) })
    await act(async () => { invoke(input('Evaluate expression...'), 'onChange', { target: { value: 'nextEvaluation' } }) })
    await setState({ sidebarView: 'explorer' })
    await setState({ sidebarView: 'debug' })
    expect(text()).toContain('counter + 1')
    expect(nodes(tree).filter((node) => node.props.title === 'Remove watch')).toHaveLength(1)
    expect(input('Add expression...').props.value).toBe('nextWatch')
    expect(input('Evaluate expression...').props.value).toBe('nextEvaluation')
    await act(async () => { invoke(input('Evaluate expression...'), 'onKeyDown', { key: 'ArrowUp', preventDefault: () => undefined }) })
    expect(input('Evaluate expression...').props.value).toBe('counter + 1')
  })

  it('hides the collapsed sidebar without discarding its debugger state', async () => {
    await enter('Add expression...', 'counter')
    await setState({ sidebarVisible: false })
    expect(tree.children[0].props.className).toMatch(/(?:^|\s)hidden(?:\s|$)/)
    await setState({ sidebarVisible: true })
    expect(tree.children[0].props.className).not.toMatch(/(?:^|\s)hidden(?:\s|$)/)
    expect(nodes(tree).filter((node) => node.props.title === 'Remove watch')).toHaveLength(1)
  })

  it('clears watches, console results and drafts when the workspace changes', async () => {
    await enter('Add expression...', 'counter')
    await enter('Evaluate expression...', 'counter + 1')
    await act(async () => { invoke(input('Add expression...'), 'onChange', { target: { value: 'oldDraft' } }) })
    await setState({ workspaceRoot: 'C:/other-owned-fixture' })
    expect(text()).not.toContain('counter + 1')
    expect(nodes(tree).filter((node) => node.props.title === 'Remove watch')).toHaveLength(0)
    expect(input('Add expression...').props.value).toBe('')
    await act(async () => { invoke(input('Evaluate expression...'), 'onKeyDown', { key: 'ArrowUp', preventDefault: () => undefined }) })
    expect(input('Evaluate expression...').props.value).toBe('')
  })

  it('resets hidden debugger state when a different workspace opens', async () => {
    await enter('Add expression...', 'counter')
    await setState({ sidebarView: 'explorer', workspaceRoot: 'C:/other-owned-fixture' })
    await setState({ sidebarView: 'debug' })
    expect(nodes(tree).filter((node) => node.props.title === 'Remove watch')).toHaveLength(0)
  })

  it('keeps watch definitions but clears old values and console history for a new session', async () => {
    await enter('Add expression...', 'counter')
    await enter('Evaluate expression...', 'counter + 1')
    await setState({ debug: { status: 'starting', stack: [], frame: 0, variables: [] } })
    expect(nodes(tree).filter((node) => node.props.title === 'Remove watch')).toHaveLength(1)
    expect(text()).not.toContain('42')
    expect(text()).not.toContain('counter + 1')
    evaluate.mockResolvedValue('99')
    await setState({ debug: { status: 'stopped', stack: [], frame: 0, variables: [] } })
    expect(text()).toContain('99')
    await act(async () => { invoke(input('Evaluate expression...'), 'onKeyDown', { key: 'ArrowUp', preventDefault: () => undefined }) })
    expect(input('Evaluate expression...').props.value).toBe('')
  })

  it('does not apply a late watch result from the preceding session', async () => {
    let resolve!: (value: string) => void
    evaluate.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done }))
    await enter('Add expression...', 'counter')
    await setState({ debug: { status: 'starting', stack: [], frame: 0, variables: [] } })
    evaluate.mockResolvedValue('new-session-value')
    await setState({ debug: { status: 'stopped', stack: [], frame: 0, variables: [] } })
    await act(async () => { resolve('old-session-value') })
    expect(text()).toContain('new-session-value')
    expect(text()).not.toContain('old-session-value')
  })

  it('does not populate a new session console with a late old result', async () => {
    let resolve!: (value: string) => void
    evaluate.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done }))
    await enter('Evaluate expression...', 'counter')
    await setState({ debug: { status: 'starting', stack: [], frame: 0, variables: [] } })
    evaluate.mockResolvedValue('new-console-value')
    await setState({ debug: { status: 'stopped', stack: [], frame: 0, variables: [] } })
    await enter('Evaluate expression...', 'counter')
    await act(async () => { resolve('old-console-value') })
    expect(text()).toContain('new-console-value')
    expect(text()).not.toContain('old-console-value')
  })

  it('does not leak a pending evaluation into a different project', async () => {
    let resolve!: (value: string) => void
    evaluate.mockImplementationOnce(() => new Promise<string>((done) => { resolve = done }))
    await enter('Evaluate expression...', 'oldProjectCounter')
    await setState({ workspaceRoot: 'C:/other-owned-fixture' })
    evaluate.mockResolvedValue('new-project-value')
    await enter('Evaluate expression...', 'newProjectCounter')
    await act(async () => { resolve('old-project-value') })
    expect(text()).toContain('new-project-value')
    expect(text()).not.toContain('oldProjectCounter')
    expect(text()).not.toContain('old-project-value')
  })

  it('does not mount the debugger until its first open', async () => {
    await act(async () => { renderer.updateContainer(null, root) })
    await setState({ sidebarView: 'explorer' })
    await act(async () => { renderer.updateContainer(createElement(SideBar, sidebarProps), root) })
    expect(text()).not.toContain('Debug')
    await setState({ sidebarView: 'debug' })
    expect(text()).toContain('Debug')
    await enter('Add expression...', 'counter')
    expect(text()).toContain('42')
  })
})
