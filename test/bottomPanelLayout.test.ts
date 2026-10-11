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
