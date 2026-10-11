import { act, createElement, useLayoutEffect } from 'react'
import * as React from 'react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { langFromPath } from '../src/shared/languages'
import type { SimPart } from '../src/shared/simCircuit'
import { createHost, invoke, type HostNode } from './reactHost'

vi.stubGlobal('window', { api: {}, addEventListener: () => undefined, removeEventListener: () => undefined })
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined })
vi.stubGlobal('navigator', { userAgent: 'Windows fixture' })
vi.stubGlobal('React', React)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const { useStore } = await import('../src/renderer/src/store/useStore')
const { default: SimulatorView } = await import('../src/renderer/src/components/SimulatorView')
const initial = useStore.getState()
const rootPath = 'C:/owned-simulator-view-fixture'
const path = `${rootPath}/main.ino`
const led = (): SimPart => ({ id: 'led', type: 'led', x: 100, y: 100, rotation: 0, pins: { sig: null, gnd: null } })
let host: ReturnType<typeof createHost>
const textOf = (node: HostNode): string => node.type === '#text' ? String(node.props.text) : node.children.map(textOf).join('')
const text = (): string => host.nodes().filter((node) => node.type === '#text').map((node) => String(node.props.text)).join('')
const button = (label: string): HostNode => {
  const node = host.nodes().find((node) => node.type === 'button' && textOf(node) === label)
  if (!node) throw new Error(`Button missing: ${label}`)
  return node
}
const noInstructions = (): void => {
  expect(text()).not.toContain('Add a part above, then click it and a board pin to wire it.')
  expect(text()).not.toContain('Click a terminal to connect. Esc cancels.')
  expect(text()).not.toContain('Click a terminal or choose a board pin.')
}

function Fixture(): React.ReactElement {
  useLayoutEffect(() => {
    // This host models React refs but not the browser's scrolling method.
    for (const node of host.nodes()) Object.assign(node, { scrollIntoView: () => undefined })
  }, [])
  return createElement(SimulatorView)
}

beforeEach(async () => {
  useStore.setState({ ...initial, workspaceRoot: rootPath, tabs: [{ path, name: 'main.ino', content: 'void setup() {}\nvoid loop() {}', savedContent: 'void setup() {}\nvoid loop() {}', language: langFromPath(path), group: 0 }],
    activePath: path, sim3dBoard: 'uno', selectedFqbn: null, simParts: [], simWires: [], simWiring: null,
    simRunning: false, simSerial: [], simBlock: null, simDiagramError: null, simPinStates: {}, simPinModes: {}, simPinPwm: {} }, true)
  host = createHost()
  await host.render(createElement(Fixture))
})
afterEach(async () => { await host.render(null); useStore.setState(initial, true) })
afterAll(() => { vi.unstubAllGlobals() })

describe('actual simulator canvas without instructional clutter', () => {
  it.each(['empty', 'populated'])('keeps the %s 2D canvas clear while retaining parts and board labels', async (state) => {
    if (state === 'populated') await act(async () => { useStore.setState({ simParts: [led()] }) })
    expect(text()).toContain('D13')
    expect(text()).toContain('GND')
    expect(host.nodes().find((node) => node.props.title === 'Add LED')?.props.disabled).toBe(false)
    expect(host.nodes().find((node) => node.props['aria-label'] === 'Circuit board model')).toBeDefined()
    expect(host.nodes().find((node) => node.props['aria-label'] === 'Jumper connector type')).toBeDefined()
    noInstructions()
  })

  it('retains an armed connection source, board selector and cancellation without repeated instructions', async () => {
    await act(async () => { useStore.setState({ simParts: [led()] }) })
    const connector = host.nodes().find((node) => node.type === 'circle' && typeof node.props.onPointerDown === 'function')
    if (!connector) throw new Error('Part connector missing')
    await act(async () => { invoke(connector, 'onPointerDown', { stopPropagation: () => undefined }) })
    expect(useStore.getState().simWiring).toEqual({ partId: 'led', pinName: 'sig' })
    expect(host.nodes().find((node) => node.props.role === 'status' && textOf(node).includes('Connecting led.sig'))).toBeDefined()
    const selector = host.nodes().find((node) => node.props['aria-label'] === 'Connect to board pin')
    if (!selector) throw new Error('Board connection selector missing')
    expect(selector.children.some((node) => node.type === 'option' && textOf(node) === 'D13')).toBe(true)
    expect(button('Cancel connection')).toBeDefined()
    noInstructions()
    await act(async () => { invoke(selector, 'onChange', { target: { value: '13' } }) })
    expect(useStore.getState().simWires).toEqual([expect.objectContaining({ from: { kind: 'part', partId: 'led', pin: 'sig' }, to: { kind: 'board', pin: 13 } })])
    expect(useStore.getState().simWiring).toBeNull()
    await act(async () => { invoke(button('gnd'), 'onClick', {}) })
    await act(async () => { invoke(button('Cancel connection'), 'onClick', {}) })
    expect(useStore.getState().simWiring).toBeNull()
    expect(useStore.getState().simWires).toHaveLength(1)
  })

  it('preserves the blocked compiler error and remedy without allowing hidden part additions', async () => {
    await act(async () => { useStore.setState({ simBlock: { reason: 'compiler', path } }) })
    expect(text()).toContain('No C++ compiler found')
    expect(button('Recheck').props.disabled).toBe(false)
    expect(typeof button('Recheck').props.onClick).toBe('function')
    const palette = host.nodes().filter((node) => node.type === 'button' && node.props.title === 'Run a sketch first')
    expect(palette.length).toBeGreaterThan(0)
    expect(palette.every((node) => node.props.disabled === true)).toBe(true)
    noInstructions()
  })
})
