import { act, createElement } from 'react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHost, invoke, type HostNode } from './reactHost'

const readDir = vi.fn()
const readFile = vi.fn()
vi.stubGlobal('window', { api: { readDir, readFile }, addEventListener: () => undefined, removeEventListener: () => undefined })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
vi.stubGlobal('React', React)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const { useStore } = await import('../src/renderer/src/store/useStore')
const { default: FileExplorer } = await import('../src/renderer/src/components/FileExplorer')
const initial = useStore.getState()
const rootPath = 'C:/owned-explorer-fixture'
const folder = { path: `${rootPath}/src`, name: 'src', isDir: true }
const child = { path: `${folder.path}/main.cpp`, name: 'main.cpp', isDir: false }
const file = { path: `${rootPath}/README.md`, name: 'README.md', isDir: false }
let host: ReturnType<typeof createHost>
const rows = (): HostNode[] => host.nodes().filter((node) => node.props.role === 'treeitem')
const row = (path: string): HostNode => {
  const node = host.nodes().find((node) => node.props.title === path)
  if (!node) throw new Error(`Row missing: ${path}`)
  return node
}
async function key(path: string, value: string, shiftKey = false): Promise<void> {
  const target = row(path)
  await act(async () => { invoke(target, 'onKeyDown', { key: value, shiftKey, target, currentTarget: target, preventDefault: () => undefined, stopPropagation: () => undefined }) })
}

beforeEach(async () => {
  readDir.mockReset().mockResolvedValue([child])
  readFile.mockReset().mockResolvedValue({ kind: 'text', content: 'int main() {}', size: 13, eol: '\n' })
  useStore.setState({ ...initial, workspaceRoot: rootPath, workspaceName: 'Fixture', tree: [folder, file], expanded: new Set(), childrenCache: {} }, true)
  host = createHost()
  await host.render(createElement(FileExplorer))
})
afterEach(async () => { await host.render(null) })

describe('Explorer keyboard and tree semantics', () => {
  it('exposes a labeled tree with one entry point and directory expansion state', () => {
    expect(host.nodes().filter((node) => node.props.role === 'tree' && node.props['aria-label'] === 'Project files')).toHaveLength(1)
    expect(rows()).toHaveLength(2)
    expect(rows().filter((node) => node.props.tabIndex === 0)).toHaveLength(1)
    expect(row(folder.path).props).toMatchObject({ role: 'treeitem', 'aria-expanded': false, 'aria-level': 1, 'aria-posinset': 1, 'aria-setsize': 2 })
    expect(row(file.path).props['aria-expanded']).toBeUndefined()
  })

  it('moves focus with arrows and Home/End without opening a file', async () => {
    await act(async () => { row(folder.path).focus() })
    await key(folder.path, 'ArrowDown')
    expect(host.focused()?.props.title).toBe(file.path)
    await key(file.path, 'Home')
    expect(host.focused()?.props.title).toBe(folder.path)
    await key(folder.path, 'End')
    expect(host.focused()?.props.title).toBe(file.path)
    await key(file.path, 'ArrowUp')
    expect(host.focused()?.props.title).toBe(folder.path)
    expect(useStore.getState().tabs).toHaveLength(0)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('expands before entering a child, and goes to the parent before collapsing it', async () => {
    await key(folder.path, 'ArrowRight')
    expect(useStore.getState().expanded.has(folder.path)).toBe(true)
    expect(host.focused()?.props.title).toBe(folder.path)
    expect(row(child.path).props).toMatchObject({ 'aria-level': 2, 'aria-posinset': 1, 'aria-setsize': 1 })
    expect(host.nodes().filter((node) => node.props.role === 'group')).toHaveLength(1)
    await key(folder.path, 'ArrowRight')
    expect(host.focused()?.props.title).toBe(child.path)
    await key(child.path, 'ArrowLeft')
    expect(host.focused()?.props.title).toBe(folder.path)
    expect(useStore.getState().expanded.has(folder.path)).toBe(true)
    await key(folder.path, 'ArrowLeft')
    expect(useStore.getState().expanded.has(folder.path)).toBe(false)
    expect(rows()).toHaveLength(2)
  })

  it('activates files with Enter and Space while selection remains separate from focus', async () => {
    await key(file.path, 'Enter')
    expect(useStore.getState().activePath).toBe(file.path)
    expect(useStore.getState().tabs[0].content).toBe('int main() {}')
    expect(row(file.path).props['aria-selected']).toBe(true)
    await key(file.path, 'ArrowUp')
    expect(row(file.path).props['aria-selected']).toBe(true)
    await key(folder.path, ' ')
    await key(child.path, ' ')
    expect(useStore.getState().activePath).toBe(child.path)
  })

  it('keeps mouse activation working after introducing tree semantics', async () => {
    await act(async () => { invoke(row(file.path).children[0], 'onClick', {}) })
    expect(useStore.getState().activePath).toBe(file.path)
    expect(useStore.getState().tabs[0].content).toBe('int main() {}')
  })

  it('does not intercept modified shortcuts or expand a leaf file', async () => {
    const target = row(file.path)
    const preventDefault = vi.fn()
    await act(async () => { invoke(target, 'onKeyDown', { key: 'ArrowDown', ctrlKey: true, target, currentTarget: target, preventDefault }) })
    expect(preventDefault).not.toHaveBeenCalled()
    await key(file.path, 'ArrowRight')
    expect(useStore.getState().expanded.size).toBe(0)
    expect(useStore.getState().tabs).toHaveLength(0)
  })

  it('reports directory loading failures without pretending to expand', async () => {
    readDir.mockRejectedValueOnce(new Error('Fixture directory unreadable'))
    await key(folder.path, 'ArrowRight')
    expect(useStore.getState().expanded.has(folder.path)).toBe(false)
    expect(useStore.getState().notifications.some((notice) => notice.detail?.includes('Fixture directory unreadable'))).toBe(true)
  })

  it('opens file actions by keyboard and Escape restores the originating row', async () => {
    await key(file.path, 'F10', true)
    expect(host.focused()?.type).toBe('button')
    const menu = host.nodes().find((node) => node.props['aria-label'] === 'File actions')
    expect(menu).toBeDefined()
    await act(async () => { invoke(menu!, 'onKeyDown', { key: 'Escape', preventDefault: () => undefined, stopPropagation: () => undefined }) })
    expect(host.focused()?.props.title).toBe(file.path)
  })

  it('repairs the entry point after a workspace replacement', async () => {
    await key(folder.path, 'End')
    const replacement = { path: 'C:/another-owned-fixture/new.cpp', name: 'new.cpp', isDir: false }
    await act(async () => { useStore.setState({ workspaceRoot: 'C:/another-owned-fixture', tree: [replacement], childrenCache: {}, expanded: new Set(), activePath: null }) })
    expect(rows()).toHaveLength(1)
    expect(rows()[0].props.tabIndex).toBe(0)
  })

  it('labels inline creation without letting tree shortcuts capture input keystrokes', async () => {
    const create = host.nodes().find((node) => node.props.title === 'New file')!
    await act(async () => { invoke(create, 'onClick', {}) })
    const input = host.nodes().find((node) => node.type === 'input')!
    expect(input.props['aria-label']).toBe('New file name')
    const stopPropagation = vi.fn()
    await act(async () => { invoke(input, 'onKeyDown', { key: 'ArrowDown', stopPropagation }) })
    expect(stopPropagation).toHaveBeenCalledOnce()
    expect(useStore.getState().tabs).toHaveLength(0)
  })
})
