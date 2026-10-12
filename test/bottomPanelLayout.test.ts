import { act, createElement } from 'react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHost, invoke, type HostNode } from './reactHost'

vi.mock('../src/renderer/src/components/CommandPalette', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/ConfirmDialog', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/Toasts', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/TitleBar', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/Toolbar', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/ActivityBar', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/SideBar', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/EditorArea', () => ({ default: () => createElement('div', { 'aria-label': 'Fixture editor area' }) }))
vi.mock('../src/renderer/src/components/StatusBar', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/AiPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/DatasheetsDock', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/RightRail', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/SimulatorView', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/SettingsView', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/Welcome', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/Splash', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/OutputConsole', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/SerialMonitor', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/ProblemsPanel', () => ({ default: () => null }))

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
vi.stubGlobal('window', { api: new Proxy({}, { get: () => () => () => undefined }), addEventListener: () => undefined, removeEventListener: () => undefined })
vi.stubGlobal('document', { documentElement: { setAttribute: () => undefined, removeAttribute: () => undefined } })
vi.stubGlobal('React', React)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let available = 500
const observers = new Set<FixtureObserver>()
class FixtureObserver {
  target: HostNode | null = null
  constructor(private callback: () => void) { observers.add(this) }
  observe(target: HostNode): void {
    this.target = target
    const isColumn = target.props.className === 'flex min-h-0 min-w-0 flex-1 flex-col gap-2'
    target.getBoundingClientRect = () => ({ left: 0, top: 0, bottom: available, width: 600, height: isColumn ? available : 500 })
    this.callback()
  }
  disconnect(): void { observers.delete(this) }
  fire(): void { this.callback() }
}
vi.stubGlobal('ResizeObserver', FixtureObserver)
const { useStore } = await import('../src/renderer/src/store/useStore')
const { default: App } = await import('../src/renderer/src/App')
const initial = useStore.getState()
let host: ReturnType<typeof createHost>
const panel = (): HostNode => {
  const node = host.nodes().find((node) => !!node.props.style && typeof node.props.style === 'object' && 'height' in node.props.style)
  if (!node) throw new Error('Visible bottom panel is missing')
  return node
}
const height = (): number => Number((panel().props.style as { height: number }).height)
async function resize(next: number): Promise<void> {
  available = next
  await act(async () => { for (const observer of observers) observer.fire() })
}

function separator(): HostNode {
  const node = host.nodes().find((node) => node.props.role === 'separator' && node.props['aria-label'] === 'Bottom panel')
  if (!node) throw new Error('Named bottom panel separator missing')
  return node
}
function announcedHeight(): { min: number; max: number } {
  const node = separator()
  const min = Number(node.props['aria-valuemin'])
  const max = Number(node.props['aria-valuemax'])
  const value = Number(node.props['aria-valuenow'])
  expect(node.props.tabIndex).toBe(0)
  expect(node.props['aria-orientation']).toBe('horizontal')
  expect(node.props['aria-controls']).toEqual(expect.any(String))
  expect(host.nodes().find((controlled) => controlled.props.id === node.props['aria-controls'])).toBe(panel())
  expect([min, max, value].every(Number.isFinite)).toBe(true)
  expect(min).toBeGreaterThanOrEqual(0)
  expect(min).toBeLessThanOrEqual(value)
  expect(value).toBeLessThanOrEqual(max)
  expect(value).toBe(height())
  expect(node.props['aria-valuetext']).toMatch(/ pixels$/)
  return { min, max }
}
async function resizeKey(key: string): Promise<HostNode> {
  panel().getBoundingClientRect = () => ({ left: 0, top: 0, bottom: height(), width: 600, height: height() })
  const node = separator()
  await act(async () => {
    node.focus()
    invoke(node, 'onKeyDown', { key, currentTarget: node, target: node, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
      preventDefault: vi.fn(), stopPropagation: vi.fn() })
  })
  expect(host.focused()).toBe(node)
  return node
}
function expectPreference(preference: number): void {
  expect(useStore.getState().bottomHeight).toBe(preference)
  expect(storage.get('cortex.bottomHeight')).toBe(String(preference))
}

beforeEach(async () => {
  available = 500
  observers.clear()
  storage.clear()
  storage.set('cortex.bottomHeight', '640')
  useStore.setState({ ...initial, workspaceRoot: 'C:/owned-panel-fixture', bottomVisible: true, bottomView: 'output', mainView: 'editor', bottomHeight: 640, rightView: null,
    loadSettings: vi.fn().mockResolvedValue(undefined), detectToolchains: vi.fn().mockResolvedValue(undefined), refreshBoardStatus: vi.fn().mockResolvedValue(undefined) }, true)
  host = createHost()
  await host.render(createElement(App))
})
afterEach(async () => { await host.render(null) })

describe('actual App bottom panel layout', () => {
  it('caps a 640px saved panel to the editor column while preserving its preference', () => {
    expect(height()).toBe(363)
    expect(useStore.getState().bottomHeight).toBe(640)
    expect(storage.get('cortex.bottomHeight')).toBe('640')
    const column = [...observers].find((observer) => observer.target?.props.className === 'flex min-h-0 min-w-0 flex-1 flex-col gap-2')?.target
    expect(column?.parent && 'props' in column.parent && column.parent.props.className).toMatch(/(?:^|\s)min-h-0(?:\s|$)/)
  })

  it('recomputes the cap on smaller and larger window/zoom measurements', async () => {
    await resize(300)
    expect(height()).toBe(163)
    await resize(900)
    expect(height()).toBe(640)
    expect(useStore.getState().bottomHeight).toBe(640)
    expect(storage.get('cortex.bottomHeight')).toBe('640')
  })

  it('keeps panel chrome within a very short column and never assigns a negative height', async () => {
    await resize(80)
    expect(height()).toBe(34)
    await resize(12)
    expect(height()).toBe(0)
  })

  it('starts a small native-style drag at the displayed height, not the clamped preference', async () => {
    const visible = panel()
    visible.getBoundingClientRect = () => ({ left: 0, top: 0, bottom: height(), width: 600, height: height() })
    const splitter = host.nodes().find((node) => node.props.title === 'Resize panel' && node.props['aria-orientation'] === 'horizontal')!
    await act(async () => {
      invoke(splitter, 'onPointerDown', { clientY: 100, currentTarget: { setPointerCapture: () => undefined }, pointerId: 1 })
      invoke(splitter, 'onPointerMove', { clientY: 102 })
    })
    expect(useStore.getState().bottomHeight).toBe(361)
    expect(height()).toBe(361)
    expect(storage.get('cortex.bottomHeight')).toBe('361')
  })

  it('measures again when the mounted editor returns from a hidden view', async () => {
    await act(async () => { useStore.setState({ mainView: 'settings' }) })
    await resize(0)
    available = 450
    await act(async () => { useStore.setState({ mainView: 'editor' }) })
    expect(height()).toBe(313)
    expect(useStore.getState().bottomHeight).toBe(640)
  })

  it('disconnects measurement when the actual App unmounts', async () => {
    expect(observers.size).toBeGreaterThan(0)
    await host.render(null)
    expect(observers.size).toBe(0)
  })
})

describe('actual App bottom splitter keyboard ownership', () => {
  it.each([500, 300, 900])('controls the real panel and reaches announced endpoints at measured column height %i', async (available) => {
    await resize(available)
    expectPreference(640)
    const min = announcedHeight().min
    await resizeKey('Home')
    expect(height()).toBe(min)
    const max = announcedHeight().max
    await resizeKey('End')
    expect(height()).toBe(max)
    announcedHeight()
    expect(Number.isInteger(useStore.getState().bottomHeight)).toBe(true)
    expect(storage.get('cortex.bottomHeight')).toBe(String(useStore.getState().bottomHeight))
  })

  it('shrinks the bottom panel by ten pixels for each Down key and retains the focused handle', async () => {
    const before = height()
    const tabs = useStore.getState().tabs
    const handle = separator()
    for (let index = 0; index < 3; index++) await resizeKey('ArrowDown')
    expect(height()).toBe(before - 30)
    expectPreference(before - 30)
    await resizeKey('ArrowUp')
    expect(height()).toBe(before - 20)
    expectPreference(before - 20)
    announcedHeight()
    expect(host.focused()).toBe(handle)
    expect(useStore.getState().bottomVisible).toBe(true)
    expect(useStore.getState().bottomView).toBe('output')
    expect(useStore.getState().tabs).toBe(tabs)
  })

  it.each([80, 0])('announces equal disabled endpoints in a %ipx column, preserves preferences and recovers', async (available) => {
    await resize(available)
    const rendered = height()
    expect(announcedHeight()).toEqual({ min: rendered, max: rendered })
    expect(separator().props['aria-disabled']).toBe(true)
    const saved = [...storage]
    for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End']) await resizeKey(key)
    expect(height()).toBe(rendered)
    expect([...storage]).toEqual(saved)
    expectPreference(640)
    await resize(500)
    expect(height()).toBe(363)
    expect(separator().props['aria-disabled']).not.toBe(true)
    expectPreference(640)
    await resizeKey('ArrowDown')
    expect(height()).toBe(353)
    expectPreference(353)
  })

  it('removes the bottom frame below two pixels and restores it without changing preferences', async () => {
    const saved = [...storage]
    for (const extent of [0, 0.5, 1.984375, 2, 2.5]) {
      await resize(17 + extent)
      expect(height()).toBe(extent)
      expect(panel().props.className).toContain('rounded-lg border border-ide-border')
      expect((panel().props.style as { borderWidth?: number }).borderWidth).toBe(extent < 2 ? 0 : undefined)
      expect([...storage]).toEqual(saved)
      expectPreference(640)
    }
    await resize(500)
    expect(height()).toBe(363)
    expect((panel().props.style as { borderWidth?: number }).borderWidth).toBeUndefined()
    expect([...storage]).toEqual(saved)
    expectPreference(640)
  })

  it('removes the bottom handle when hidden and restores its stable actual-wrapper relationship', async () => {
    announcedHeight()
    const id = separator().props['aria-controls']
    await act(async () => { useStore.setState({ bottomVisible: false }) })
    expect(host.nodes().filter((node) => node.props.role === 'separator' && node.props['aria-orientation'] === 'horizontal')).toHaveLength(0)
    expectPreference(640)
    await act(async () => { useStore.setState({ bottomVisible: true }) })
    announcedHeight()
    expect(separator().props['aria-controls']).toBe(id)
    expectPreference(640)
  })

  it('keeps a hidden-view handle inside the hidden column and refreshes its reachable range on return', async () => {
    announcedHeight()
    const id = separator().props['aria-controls']
    await act(async () => { useStore.setState({ mainView: 'settings' }) })
    await resize(0)
    let ancestor = separator().parent
    const classes: unknown[] = []
    while (ancestor && 'props' in ancestor) { classes.push(ancestor.props.className); ancestor = ancestor.parent }
    expect(classes).toContain('hidden')
    expectPreference(640)
    available = 450
    await act(async () => { useStore.setState({ mainView: 'editor' }) })
    expect(height()).toBe(313)
    announcedHeight()
    expect(separator().props['aria-controls']).toBe(id)
    expectPreference(640)
    await resizeKey('ArrowDown')
    expect(height()).toBe(303)
    expectPreference(303)
  })
})
