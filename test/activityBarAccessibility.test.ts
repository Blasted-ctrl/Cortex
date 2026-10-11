import { act, createElement } from 'react'
import * as React from 'react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHost, descendants, invoke, type HostNode } from './reactHost'

type BrowserListener = (event: object) => void
const listeners = new Map<string, Set<BrowserListener>>()
const addEventListener = vi.fn((type: string, listener: BrowserListener) => {
  const registered = listeners.get(type) ?? new Set<BrowserListener>()
  registered.add(listener)
  listeners.set(type, registered)
})
const removeEventListener = vi.fn((type: string, listener: BrowserListener) => { listeners.get(type)?.delete(listener) })
const storage = new Map<string, string>()
vi.stubGlobal('window', { api: {}, addEventListener, removeEventListener })
vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
vi.stubGlobal('React', React)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const { useStore } = await import('../src/renderer/src/store/useStore')
const { default: ActivityBar } = await import('../src/renderer/src/components/ActivityBar')
const initial = useStore.getState()
const tools = [
  { view: 'boards' as const, label: 'Boards Manager', letter: 'b' },
  { view: 'libraries' as const, label: 'Library Manager', letter: 'l' },
  { view: 'debug' as const, label: 'Debug', letter: 'd' }
]
let host: ReturnType<typeof createHost>
const text = (node: HostNode): string => [node, ...descendants(node)].filter(child => child.type === '#text').map(child => child.props.text).join('').trim()
const menu = (): HostNode | undefined => host.nodes().find(node => node.props.role === 'menu')
const items = (): HostNode[] => host.nodes().filter(node => node.props.role === 'menuitem')
function trigger(): HostNode {
  const node = host.nodes().find(child => child.type === 'button' && child.props['aria-label'] === 'More tools')
  if (!node) throw new Error('More tools trigger missing')
  return node
}
function item(label: string): HostNode {
  const node = items().find(child => text(child) === label)
  if (!node) throw new Error(`Menu item missing: ${label}`)
  return node
}
const sidebar = () => ({ view: useStore.getState().sidebarView, visible: useStore.getState().sidebarVisible })
async function click(node: HostNode): Promise<void> {
  await act(async () => { invoke(node, 'onClick', {}) })
}
async function open(): Promise<void> {
  await act(async () => { trigger().focus() })
  await click(trigger())
}
async function key(target: HostNode, value: string, modifiers: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean } = {}) {
  let stopped = false
  const preventDefault = vi.fn()
  const stopPropagation = vi.fn(() => { stopped = true })
  await act(async () => {
    let current: HostNode | null = target
    while (current) {
      if (typeof current.props.onKeyDown === 'function') {
        invoke(current, 'onKeyDown', { key: value, target, currentTarget: current, ...modifiers, preventDefault, stopPropagation })
      }
      if (stopped) break
      current = current.parent && 'props' in current.parent ? current.parent : null
    }
  })
  return { preventDefault, stopPropagation }
}

beforeEach(async () => {
  listeners.clear()
  addEventListener.mockClear()
  removeEventListener.mockClear()
  storage.clear()
  useStore.setState({ ...initial, workspaceRoot: 'C:/owned-menu-fixture', sidebarView: 'explorer', sidebarVisible: true,
    mainView: 'editor', bottomVisible: false }, true)
  host = createHost()
  await host.render(createElement(ActivityBar))
})
afterEach(async () => {
  await host.render(null)
  useStore.setState(initial, true)
  vi.useRealTimers()
})
afterAll(() => { vi.unstubAllGlobals() })

describe('actual ActivityBar More tools navigation', () => {
  it('labels its menu relationship and gives items no separate Tab entries', async () => {
    const button = trigger()
    expect(button.props['aria-haspopup']).toBe('menu')
    expect(button.props['aria-expanded']).toBe(false)
    expect(button.props.id).toEqual(expect.any(String))
    expect(button.props.id).not.toBe('')
    await open()
    expect(trigger().props['aria-expanded']).toBe(true)
    expect(trigger().props['aria-controls']).toBe(menu()?.props.id)
    expect(menu()?.props.id).toEqual(expect.any(String))
    const labelledBy = menu()?.props['aria-labelledby']
    const label = host.nodes().find(node => node.props.id === labelledBy)
    expect(menu()?.props['aria-label'] ?? label?.props['aria-label'] ?? (label && text(label))).toBe('More tools')
    expect(items().map(text)).toEqual(tools.map(tool => tool.label))
    expect(items().map(node => node.props.tabIndex)).toEqual([-1, -1, -1])
  })

  it('opens by click with the first item focused without selecting a sidebar', async () => {
    const before = sidebar()
    await open()
    expect(host.focused()).toBe(item('Boards Manager'))
    expect(sidebar()).toEqual(before)
  })

  it.each([
    { value: 'ArrowDown', label: 'Boards Manager' },
    { value: 'ArrowUp', label: 'Debug' }
  ])('opens with $value and focuses $label without selecting it', async ({ value, label }) => {
    const before = sidebar()
    await act(async () => { trigger().focus() })
    const event = await key(trigger(), value)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(host.focused()).toBe(item(label))
    expect(sidebar()).toEqual(before)
  })

  it('keeps trigger and menu identities stable across close and reopen', async () => {
    await open()
    const triggerId = trigger().props.id
    const menuId = menu()?.props.id
    expect(triggerId).toEqual(expect.any(String))
    expect(menuId).toEqual(expect.any(String))
    await key(item('Boards Manager'), 'Escape')
    await open()
    expect(menu()).toBeDefined()
    expect(trigger().props.id).toBe(triggerId)
    expect(menu()?.props.id).toBe(menuId)
    expect(trigger().props['aria-controls']).toBe(menuId)
  })

  it('wraps Up and Down through every item without activating one', async () => {
    await open()
    const before = sidebar()
    await act(async () => { item('Boards Manager').focus() })
    for (const label of ['Library Manager', 'Debug', 'Boards Manager']) {
      const event = await key(host.focused()!, 'ArrowDown')
      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(host.focused()).toBe(item(label))
      expect(sidebar()).toEqual(before)
    }
    for (const label of ['Debug', 'Library Manager', 'Boards Manager']) {
      await key(host.focused()!, 'ArrowUp')
      expect(host.focused()).toBe(item(label))
      expect(sidebar()).toEqual(before)
    }
  })

  it('uses Home and End to focus the menu edges without changing the sidebar', async () => {
    await open()
    const before = sidebar()
    await act(async () => { item('Library Manager').focus() })
    await key(item('Library Manager'), 'End')
    expect(host.focused()).toBe(item('Debug'))
    await key(item('Debug'), 'Home')
    expect(host.focused()).toBe(item('Boards Manager'))
    expect(sidebar()).toEqual(before)
  })

  it.each(tools)('focuses $label with its unmodified letter without activation', async ({ letter, label }) => {
    await open()
    const before = sidebar()
    const start = item(label === 'Debug' ? 'Boards Manager' : 'Debug')
    for (const value of [letter, letter.toUpperCase()]) {
      await act(async () => { start.focus() })
      const event = await key(start, value)
      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(host.focused()).toBe(item(label))
      expect(sidebar()).toEqual(before)
    }
  })

  it.each(tools.flatMap(tool => [
    { ...tool, state: 'another visible tool', current: 'explorer' as const, visible: true, expectedVisible: true },
    { ...tool, state: 'the visible current tool', current: tool.view, visible: true, expectedVisible: false },
    { ...tool, state: 'the hidden current tool', current: tool.view, visible: false, expectedVisible: true }
  ]))('selecting $label from $state performs one existing toggle and restores focus', async ({ view, label, current, visible, expectedVisible }) => {
    await act(async () => { useStore.setState({ sidebarView: current, sidebarVisible: visible }) })
    await open()
    const transitions: ReturnType<typeof sidebar>[] = []
    const unsubscribe = useStore.subscribe((next, previous) => {
      if (next.sidebarView !== previous.sidebarView || next.sidebarVisible !== previous.sidebarVisible) {
        transitions.push({ view: next.sidebarView, visible: next.sidebarVisible })
      }
    })
    try { await click(item(label)) } finally { unsubscribe() }
    expect(transitions).toEqual([{ view, visible: expectedVisible }])
    expect(sidebar()).toEqual({ view, visible: expectedVisible })
    expect(menu()).toBeUndefined()
    expect(trigger().props['aria-expanded']).toBe(false)
    expect(host.focused()).toBe(trigger())
    expect(trigger().props['aria-pressed']).toBe(expectedVisible)
    expect(useStore.getState().mainView).toBe('editor')
  })

  it.each(['Enter', ' '])('leaves %j native button activation to its click path, without duplicate selection', async value => {
    // This host does not generate browser clicks from keys; native activation is verified separately.
    const initialSidebar = sidebar()
    await act(async () => { trigger().focus() })
    const triggerKey = await key(trigger(), value)
    expect(triggerKey.preventDefault).not.toHaveBeenCalled()
    expect(menu()).toBeUndefined()
    await click(trigger())
    expect(host.focused()).toBe(item('Boards Manager'))
    const target = item('Library Manager')
    await act(async () => { target.focus() })
    const itemKey = await key(target, value)
    expect(itemKey.preventDefault).not.toHaveBeenCalled()
    expect(sidebar()).toEqual(initialSidebar)
    expect(menu()).toBeDefined()
    await click(target)
    expect(sidebar()).toEqual({ view: 'libraries', visible: true })
    expect(menu()).toBeUndefined()
    expect(host.focused()).toBe(trigger())
  })

  it('closes Escape locally and returns focus without changing the selected tool', async () => {
    await open()
    const before = sidebar()
    await act(async () => { item('Library Manager').focus() })
    const event = await key(item('Library Manager'), 'Escape')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).toHaveBeenCalledOnce()
    expect(menu()).toBeUndefined()
    expect(host.focused()).toBe(trigger())
    expect(sidebar()).toEqual(before)
  })

  it.each(tools.flatMap(tool => [
    { ...tool, shiftKey: false, direction: 'forward' },
    { ...tool, shiftKey: true, direction: 'backward' }
  ]))('returns from $label to the trigger before allowing native $direction Tab exit', async ({ label, shiftKey }) => {
    await open()
    const before = sidebar()
    const target = item(label)
    await act(async () => { target.focus() })
    const button = trigger()
    const focus = button.focus
    let menuPresentOnFocus = false
    const restoreFocus = vi.spyOn(button, 'focus').mockImplementation(() => {
      menuPresentOnFocus = menu() !== undefined
      focus()
    })
    const event = await key(target, 'Tab', { shiftKey })
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(restoreFocus).toHaveBeenCalledOnce()
    expect(menuPresentOnFocus).toBe(true)
    expect(menu()).toBeUndefined()
    expect(host.focused()).toBe(trigger())
    expect(sidebar()).toEqual(before)
  })

  it('dismisses an outside pointer without pulling focus back to the trigger', async () => {
    await open()
    const before = sidebar()
    const outside = host.nodes().find(node => node.type === 'button' && node.props['aria-label'] === 'Explorer')!
    await act(async () => { outside.focus() })
    const overlay = host.nodes().find(node => node.props.className === 'fixed inset-0 z-40')
    expect(overlay).toBeDefined()
    await click(overlay!)
    expect(menu()).toBeUndefined()
    expect(host.focused()).toBe(outside)
    expect(sidebar()).toEqual(before)
  })

  it('does not intercept modified trigger or menu shortcuts', async () => {
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
      await act(async () => { trigger().focus() })
      const event = await key(trigger(), 'ArrowDown', modifiers)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(menu()).toBeUndefined()
      expect(host.focused()).toBe(trigger())
    }
    await open()
    const target = item('Library Manager')
    await act(async () => { target.focus() })
    const before = sidebar()
    for (const modifiers of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) {
      for (const value of ['ArrowDown', 'Home', 'b', 'Escape']) {
        const event = await key(target, value, modifiers)
        expect(event.preventDefault).not.toHaveBeenCalled()
        expect(event.stopPropagation).not.toHaveBeenCalled()
        expect(host.focused()).toBe(target)
        expect(menu()).toBeDefined()
        expect(sidebar()).toEqual(before)
      }
    }
  })

  it('ignores closed-menu and unrelated keys instead of stealing shortcuts', async () => {
    await act(async () => { trigger().focus() })
    for (const value of ['Escape', 'Home', 'End', 'b', 'ArrowLeft', 'Tab']) {
      const event = await key(trigger(), value)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(menu()).toBeUndefined()
    }
    await open()
    const target = item('Library Manager')
    await act(async () => { target.focus() })
    for (const value of ['ArrowLeft', 'ArrowRight', 'x', 'F5']) {
      const event = await key(target, value)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(host.focused()).toBe(target)
      expect(menu()).toBeDefined()
    }
    expect(sidebar()).toEqual({ view: 'explorer', visible: true })
  })

  it('does not own a window-wide Escape handler or intercept another surface', async () => {
    await open()
    const outside = host.nodes().find(node => node.type === 'button' && node.props['aria-label'] === 'Explorer')!
    await act(async () => { outside.focus() })
    const preventDefault = vi.fn()
    await act(async () => { for (const listener of listeners.get('keydown') ?? []) listener({ key: 'Escape', preventDefault }) })
    expect(addEventListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(0)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(menu()).toBeDefined()
    expect(host.focused()).toBe(outside)
    expect(sidebar()).toEqual({ view: 'explorer', visible: true })
  })

  it('unmounts an open menu without retained listeners or delayed focus', async () => {
    vi.useFakeTimers()
    await open()
    const triggerFocus = vi.spyOn(trigger(), 'focus')
    const itemFocus = vi.spyOn(item('Boards Manager'), 'focus')
    await host.render(null)
    await act(async () => { await vi.runAllTimersAsync() })
    expect([...listeners.values()].reduce((count, registered) => count + registered.size, 0)).toBe(0)
    expect(triggerFocus).not.toHaveBeenCalled()
    expect(itemFocus).not.toHaveBeenCalled()
    expect(host.nodes()).toHaveLength(0)
    expect(sidebar()).toEqual({ view: 'explorer', visible: true })
  })
})
