import { act, createElement } from 'react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHost, invoke, type HostNode } from './reactHost'

vi.mock('../src/renderer/src/components/CommandPalette', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/ConfirmDialog', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/TitleBar', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/Toolbar', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/ActivityBar', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/FileExplorer', () => ({ default: () => createElement('div', { 'aria-label': 'Fixture explorer' }) }))
vi.mock('../src/renderer/src/components/SearchPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/BoardsManagerPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/LibraryManagerPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/HardwarePanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/EnvironmentPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/DebugPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/DevicesPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/VcsPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/EditorArea', () => ({ default: () => createElement('div', { 'aria-label': 'Fixture editor area' }) }))
vi.mock('../src/renderer/src/components/BottomPanel', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/StatusBar', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/AgentView', () => ({ default: () => createElement('div', { 'aria-label': 'Fixture agent' }) }))
vi.mock('../src/renderer/src/components/DatasheetsPanel', () => ({ default: () => createElement('div', { 'aria-label': 'Fixture datasheets' }) }))
vi.mock('../src/renderer/src/components/RightRail', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/SimulatorView', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/SettingsView', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/Welcome', () => ({ default: () => null }))
vi.mock('../src/renderer/src/components/Splash', () => ({ default: () => null }))

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
vi.stubGlobal('window', { api: new Proxy({}, { get: () => () => () => undefined }), addEventListener: () => undefined, removeEventListener: () => undefined })
vi.stubGlobal('document', { documentElement: { setAttribute: () => undefined, removeAttribute: () => undefined } })
vi.stubGlobal('React', React)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
let innerWidth = 1270
const observers = new Set<FixtureObserver>()
const isWorkbench = (node: HostNode): boolean => node.props.className === 'flex min-h-0 min-w-0 flex-1 gap-2 p-2'
class FixtureObserver {
  target: HostNode | null = null
  constructor(private callback: () => void) { observers.add(this) }
  observe(target: HostNode): void {
    this.target = target
    target.getBoundingClientRect = () => ({ left: 48, top: 0, bottom: 500, width: isWorkbench(target) ? innerWidth : 600, height: 500 })
    this.callback()
  }
  disconnect(): void { observers.delete(this) }
  fire(): void { this.callback() }
}
vi.stubGlobal('ResizeObserver', FixtureObserver)
const { useStore, LAYOUT_LIMITS } = await import('../src/renderer/src/store/useStore')
const { default: App } = await import('../src/renderer/src/App')
const initial = useStore.getState()
let host: ReturnType<typeof createHost>

function dock(label: string): HostNode {
  let node = host.nodes().find((node) => node.props['aria-label'] === label)
  while (node && !(node.props.style && typeof node.props.style === 'object' && 'width' in node.props.style)) {
    node = node.parent && 'props' in node.parent ? node.parent : undefined
  }
  if (!node) throw new Error(`Dock missing: ${label}`)
  return node
}
const width = (label: string): number => Number((dock(label).props.style as { width: number }).width)
async function showSaveFailure(): Promise<void> {
  await act(async () => { useStore.getState().notify('error', 'Could not save settings', 'Your change was not saved. Retry saving.') })
  expect(host.nodes().some((node) => node.type === '#text' && node.props.text === 'Could not save settings')).toBe(true)
}
function expectToastInset(rightWidth: number): void {
  const region = host.nodes().find((node) => node.props['aria-live'] === 'polite')
  if (!region) throw new Error('Notification region missing')
  const desired = 64 + (useStore.getState().rightView ? rightWidth + 8 : 0)
  expect(region.props.style).toEqual({ right: `min(${desired}px, max(16px, calc(100vw - 20rem - 16px)))` })
  expect(region.props.className).toContain('w-80 max-w-[calc(100vw-2rem)]')
  const viewport = innerWidth + 96
  const inset = Math.min(desired, Math.max(16, viewport - 320 - 16))
  const toastWidth = Math.min(320, viewport - 32)
  expect(viewport - inset - toastWidth).toBeGreaterThanOrEqual(16)
  expect(viewport - inset).toBeLessThanOrEqual(viewport - 16)
}
function expectPreferences(sidebar = 560, right = 620): void {
  expect(useStore.getState().sidebarWidth).toBe(sidebar)
  expect(useStore.getState().aiWidth).toBe(right)
  expect(storage.get('cortex.sidebarWidth')).toBe(String(sidebar))
  expect(storage.get('cortex.aiWidth')).toBe(String(right))
}
async function resize(next: number): Promise<void> {
  innerWidth = next
  await act(async () => { for (const observer of observers) if (observer.target && isWorkbench(observer.target)) observer.fire() })
}
async function drag(side: 'sidebar' | 'right', delta: number, measured?: { sidebar: number; right: number }): Promise<void> {
  for (const label of ['Fixture explorer', 'Fixture agent', 'Fixture datasheets']) {
    if (!host.nodes().some((node) => node.props['aria-label'] === label)) continue
    const node = dock(label)
    node.getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 500,
      width: (label === 'Fixture explorer' ? measured?.sidebar : measured?.right) ?? width(label), height: 500 })
  }
  const splitter = host.nodes().find((node) => node.props.title === (side === 'sidebar' ? 'Resize sidebar' : 'Resize panel') && node.props['aria-orientation'] === 'vertical')
  if (!splitter) throw new Error('Horizontal splitter missing')
  await act(async () => {
    invoke(splitter, 'onPointerDown', { clientX: 100, currentTarget: { setPointerCapture: () => undefined }, pointerId: 1 })
    invoke(splitter, 'onPointerMove', { clientX: 100 + delta })
    invoke(splitter, 'onPointerUp', { currentTarget: { releasePointerCapture: () => undefined }, pointerId: 1 })
  })
}

beforeEach(async () => {
  innerWidth = 1270
  observers.clear()
  storage.clear()
  storage.set('cortex.sidebarWidth', '560')
  storage.set('cortex.aiWidth', '620')
  useStore.setState({ ...initial, workspaceRoot: 'C:/owned-horizontal-fixture', sidebarView: 'explorer', sidebarVisible: true, rightView: 'agent', agentMode: true,
    mainView: 'editor', bottomVisible: false, sidebarWidth: 560, aiWidth: 620,
    loadSettings: vi.fn().mockResolvedValue(undefined), detectToolchains: vi.fn().mockResolvedValue(undefined), refreshBoardStatus: vi.fn().mockResolvedValue(undefined) }, true)
  host = createHost()
  await host.render(createElement(App))
})

afterEach(async () => { await host.render(null) })

describe('actual App horizontal dock layout', () => {
  it('fits both maximum preferences at 1366px outer width while retaining a 320px center', () => {
    expect(width('Fixture explorer')).toBeCloseTo(900 * 560 / 1180, 6)
    expect(width('Fixture agent')).toBeCloseTo(900 * 620 / 1180, 6)
    expect(innerWidth - 16 - 34 - width('Fixture explorer') - width('Fixture agent')).toBeCloseTo(320, 6)
    expectPreferences()
    expect([...observers].some((observer) => observer.target && isWorkbench(observer.target))).toBe(true)
  })

  it('fits below saved minima at 900px and restores preferences when the window grows', async () => {
    await resize(804)
    expect(width('Fixture explorer')).toBeCloseTo(434 * 560 / 1180, 6)
    expect(width('Fixture agent')).toBeCloseTo(434 * 620 / 1180, 6)
    expect(width('Fixture agent')).toBeLessThan(LAYOUT_LIMITS.ai.min)
    expectPreferences()
    await resize(1600)
    expect(width('Fixture explorer')).toBe(560)
    expect(width('Fixture agent')).toBe(620)
    expectPreferences()
  })

  it.each([
    { sidebarVisible: true, rightView: 'agent' as const, sidebar: 434 * 560 / 1180, right: 434 * 620 / 1180, separators: 2 },
    { sidebarVisible: true, rightView: null, sidebar: 451, right: null, separators: 1 },
    { sidebarVisible: false, rightView: 'agent' as const, sidebar: 0, right: 451, separators: 1 },
    { sidebarVisible: false, rightView: null, sidebar: 0, right: null, separators: 0 }
  ])('accounts only for visible dock spacing: $sidebarVisible / $rightView', async ({ sidebarVisible, rightView, sidebar, right, separators }) => {
    await resize(804)
    await act(async () => { useStore.setState({ sidebarVisible, rightView }) })
    expect(width('Fixture explorer')).toBeCloseTo(sidebar, 6)
    if (right !== null) expect(width('Fixture agent')).toBeCloseTo(right, 6)
    else expect(host.nodes().some((node) => node.props['aria-label'] === 'Fixture agent')).toBe(false)
    expect(host.nodes().filter((node) => node.props['aria-orientation'] === 'vertical')).toHaveLength(separators)
    expect(dock('Fixture explorer').props.className).toMatch(sidebarVisible ? /(?:^|\s)flex(?:\s|$)/ : /(?:^|\s)hidden(?:\s|$)/)
    expectPreferences()
  })

  it('feeds the same fitted width to actual AI and datasheets wrappers across view switches', async () => {
    await act(async () => { useStore.setState({ rightView: 'datasheets', mainView: 'settings' }) })
    expect(width('Fixture datasheets')).toBeCloseTo(900 * 620 / 1180, 6)
    await resize(804)
    expect(width('Fixture datasheets')).toBeCloseTo(434 * 620 / 1180, 6)
    await act(async () => { useStore.setState({ rightView: 'agent', mainView: 'editor' }) })
    expect(width('Fixture agent')).toBeCloseTo(434 * 620 / 1180, 6)
    expectPreferences()
  })

  it.each(['agent', 'datasheets'] as const)('keeps a real settings error toast inside a 900px viewport with the fitted %s dock', async (rightView) => {
    await resize(804)
    await act(async () => { useStore.setState({ rightView }) })
    await showSaveFailure()
    expectToastInset(width(rightView === 'agent' ? 'Fixture agent' : 'Fixture datasheets'))
    expectPreferences()
  })

  it('repositions the real error toast when fitted docks grow back to their saved widths', async () => {
    await resize(804)
    await showSaveFailure()
    expectToastInset(width('Fixture agent'))
    await resize(1600)
    expectToastInset(620)
    expectPreferences()
  })

  it('keeps the real error toast contained when the right dock hides and changes view', async () => {
    await resize(804)
    await showSaveFailure()
    await act(async () => { useStore.setState({ rightView: null }) })
    expectToastInset(0)
    await act(async () => { useStore.setState({ rightView: 'datasheets' }) })
    expectToastInset(width('Fixture datasheets'))
    await act(async () => { useStore.setState({ rightView: 'agent' }) })
    expectToastInset(width('Fixture agent'))
    expectPreferences()
  })

  it('caps the real toast inset in a 300px CSS viewport without rewriting dock preferences', async () => {
    await resize(204)
    await showSaveFailure()
    expect(width('Fixture explorer')).toBe(0)
    expect(width('Fixture agent')).toBe(0)
    expectToastInset(0)
    expectPreferences()
  })

  it.each([1270, 804])('moves a fitted sidebar by two pixels without a stored-preference dead zone at inner width %i', async (available) => {
    await resize(available)
    const sidebar = width('Fixture explorer')
    const right = width('Fixture agent')
    await drag('sidebar', 2)
    expect(width('Fixture explorer')).toBeCloseTo(sidebar + 2, 0)
    expect(width('Fixture agent')).toBeCloseTo(right - 2, 0)
    expect(useStore.getState().sidebarWidth).toBeGreaterThanOrEqual(LAYOUT_LIMITS.sidebar.min)
    expect(useStore.getState().sidebarWidth).toBeLessThanOrEqual(LAYOUT_LIMITS.sidebar.max)
    expect(useStore.getState().aiWidth).toBeGreaterThanOrEqual(LAYOUT_LIMITS.ai.min)
    expect(useStore.getState().aiWidth).toBeLessThanOrEqual(LAYOUT_LIMITS.ai.max)
    expect(storage.get('cortex.sidebarWidth')).toBe(String(useStore.getState().sidebarWidth))
    expect(storage.get('cortex.aiWidth')).toBe(String(useStore.getState().aiWidth))
  })

  it.each([1270, 804])('moves a fitted right dock by two pixels with the right splitter direction at inner width %i', async (available) => {
    await resize(available)
    const sidebar = width('Fixture explorer')
    const right = width('Fixture agent')
    await drag('right', -2)
    expect(width('Fixture explorer')).toBeCloseTo(sidebar - 2, 0)
    expect(width('Fixture agent')).toBeCloseTo(right + 2, 0)
  })

  it('starts paired dragging from actual dock rectangles, not their computed widths', async () => {
    await drag('sidebar', 2, { sidebar: 420, right: 480 })
    expect(width('Fixture explorer')).toBe(422)
    expect(width('Fixture agent')).toBe(478)
    expectPreferences(422, 478)
  })

  it.each([
    { side: 'sidebar' as const, delta: -2, sidebar: 558, right: 620 },
    { side: 'right' as const, delta: 2, sidebar: 560, right: 618 }
  ])('resizes only the selected preference when both docks have spare center space: $side', async ({ side, delta, sidebar, right }) => {
    await resize(1600)
    await drag(side, delta)
    expect(width('Fixture explorer')).toBe(sidebar)
    expect(width('Fixture agent')).toBe(right)
    expectPreferences(sidebar, right)
  })

  it.each(['sidebar', 'right'] as const)('starts a single fitted dock drag at its displayed width: %s', async (side) => {
    await resize(804)
    await act(async () => { useStore.setState({ sidebarVisible: side === 'sidebar', rightView: side === 'right' ? 'agent' : null }) })
    await drag(side, side === 'sidebar' ? -2 : 2)
    expect(width(side === 'sidebar' ? 'Fixture explorer' : 'Fixture agent')).toBe(449)
    expectPreferences(side === 'sidebar' ? 449 : 560, side === 'right' ? 449 : 620)
  })

  it('bounds extreme paired drags to achievable saved ratios rather than jumping at the minima', async () => {
    await resize(804)
    await drag('sidebar', 10000)
    expect(width('Fixture explorer')).toBeCloseTo(434 * 560 / 820, 6)
    expect(width('Fixture agent')).toBeCloseTo(434 * 260 / 820, 6)
    await drag('sidebar', -10000)
    expect(width('Fixture explorer')).toBeCloseTo(434 * 180 / 800, 6)
    expect(width('Fixture agent')).toBeCloseTo(434 * 620 / 800, 6)
  })

  it('gives the available center priority in tiny measurements without negative widths or preference changes', async () => {
    await resize(250)
    expect(width('Fixture explorer')).toBe(0)
    expect(width('Fixture agent')).toBe(0)
    await resize(12)
    expect(width('Fixture explorer')).toBe(0)
    expect(width('Fixture agent')).toBe(0)
    await drag('sidebar', 2)
    expectPreferences()
  })

  it.each([NaN, Infinity, -Infinity])('normalizes nonfinite preferences without writing them: %s', async (invalid) => {
    await resize(1600)
    storage.set('cortex.sidebarWidth', String(invalid))
    storage.set('cortex.aiWidth', String(invalid))
    await act(async () => { useStore.setState({ sidebarWidth: invalid, aiWidth: invalid }) })
    expect(width('Fixture explorer')).toBe(256)
    expect(width('Fixture agent')).toBe(320)
    expectPreferences(invalid, invalid)
  })

  it('clamps finite out-of-range preferences against existing limits without persisting automatic normalization', async () => {
    await resize(1600)
    storage.set('cortex.sidebarWidth', '-50')
    storage.set('cortex.aiWidth', '9999')
    await act(async () => { useStore.setState({ sidebarWidth: -50, aiWidth: 9999 }) })
    expect(width('Fixture explorer')).toBe(180)
    expect(width('Fixture agent')).toBe(620)
    expectPreferences(-50, 9999)
  })

  it('disconnects every measurement observer when the actual App unmounts', async () => {
    expect(observers.size).toBeGreaterThan(0)
    await host.render(null)
    expect(observers.size).toBe(0)
  })
})
