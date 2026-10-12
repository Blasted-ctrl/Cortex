import { act, createElement } from 'react'
import * as React from 'react'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHost, invoke, type HostNode } from './reactHost'

vi.stubGlobal('React', React)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const { default: Splitter } = await import('../src/renderer/src/components/Splitter')

type SplitterInput = {
  dir: 'x' | 'y'
  label: string
  controls: string
  value: number
  min: number
  max: number
  unit: 'pixels' | 'percent'
  onDelta: (delta: number) => void
  onBoundary: (edge: 'min' | 'max') => void
  title?: string
}
type KeyOptions = { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean }
let host: ReturnType<typeof createHost>

async function mount(overrides: Partial<Omit<SplitterInput, 'onDelta' | 'onBoundary'>> = {}) {
  const onDelta = vi.fn<(delta: number) => void>()
  const onBoundary = vi.fn<(edge: 'min' | 'max') => void>()
  const input: SplitterInput = {
    dir: 'x', label: 'Sidebar width', controls: 'owned-sidebar', value: 240,
    min: 180, max: 560, unit: 'pixels', title: 'Resize sidebar', ...overrides,
    onDelta, onBoundary
  }
  await host.render(createElement('section', null,
    createElement('div', { id: input.controls }, 'Controlled pane'),
    createElement(Splitter, input),
    createElement('button', { type: 'button' }, 'Outside control')))
  const node = host.nodes().find(child => child.props.role === 'separator')
  if (!node) throw new Error('Actual Splitter missing')
  return { node, input, onDelta, onBoundary }
}

async function key(node: HostNode, value: string, options: KeyOptions = {}) {
  const preventDefault = vi.fn()
  const stopPropagation = vi.fn()
  await act(async () => {
    if (typeof node.props.onKeyDown === 'function') {
      invoke(node, 'onKeyDown', {
        key: value, currentTarget: node, target: node,
        ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false,
        ...options, preventDefault, stopPropagation
      })
    }
  })
  return { preventDefault, stopPropagation }
}

async function pointer(node: HostNode, handler: string, point: { clientX: number; clientY: number }, pointerId = 9) {
  await act(async () => { invoke(node, handler, { currentTarget: node, target: node, pointerId, ...point }) })
}

beforeEach(() => { host = createHost() })
afterEach(async () => { await host.render(null) })
afterAll(() => { vi.unstubAllGlobals() })

describe('actual Splitter local accessibility and input ownership', () => {
  it.each([
    { dir: 'x' as const, unit: 'pixels' as const, value: 240, min: 180, max: 560, orientation: 'vertical' },
    { dir: 'y' as const, unit: 'percent' as const, value: 50, min: 20, max: 80, orientation: 'horizontal' }
  ])('names and relates its $unit range on the $dir axis', async ({ dir, unit, value, min, max, orientation }) => {
    const { node, input } = await mount({ dir, unit, value, min, max })
    expect(node.props.tabIndex).toBe(0)
    expect(node.props['aria-label']).toBe(input.label)
    expect(node.props['aria-controls']).toBe(input.controls)
    expect(host.nodes().find(child => child.props.id === node.props['aria-controls'])?.type).toBe('div')
    expect(node.props['aria-orientation']).toBe(orientation)
    expect(node.props['aria-valuenow']).toBe(value)
    expect(node.props['aria-valuemin']).toBe(min)
    expect(node.props['aria-valuemax']).toBe(max)
    for (const field of ['aria-valuenow', 'aria-valuemin', 'aria-valuemax']) {
      expect(Number.isFinite(node.props[field])).toBe(true)
    }
    expect(String(node.props['aria-valuetext'])).toContain(String(value))
    expect(String(node.props['aria-valuetext'])).toMatch(unit === 'pixels' ? /pixels?|px/ : /percent|%/)
    expect(node.props['aria-disabled']).not.toBe(true)
    expect(node.props.title).toBe(input.title)
  })

  it.each([
    { dir: 'x' as const, negative: 'ArrowLeft', positive: 'ArrowRight' },
    { dir: 'y' as const, negative: 'ArrowUp', positive: 'ArrowDown' }
  ])('requests signed ten-pixel moves on the $dir axis without moving focus', async ({ dir, negative, positive }) => {
    const { node, onDelta, onBoundary } = await mount({ dir })
    await act(async () => { node.focus() })
    const first = await key(node, negative)
    expect(first.preventDefault).toHaveBeenCalledOnce()
    expect(onDelta.mock.calls).toEqual([[-10]])
    expect(host.focused()).toBe(node)
    const second = await key(node, positive)
    expect(second.preventDefault).toHaveBeenCalledOnce()
    expect(onDelta.mock.calls).toEqual([[-10], [10]])
    expect(onBoundary).not.toHaveBeenCalled()
    expect(host.focused()).toBe(node)
  })

  it.each(['x', 'y'] as const)('delegates Home and End to geometry-owned endpoints on the %s axis', async dir => {
    const { node, onDelta, onBoundary } = await mount({ dir })
    await act(async () => { node.focus() })
    const home = await key(node, 'Home')
    expect(home.preventDefault).toHaveBeenCalledOnce()
    expect(onBoundary.mock.calls).toEqual([['min']])
    const end = await key(node, 'End')
    expect(end.preventDefault).toHaveBeenCalledOnce()
    expect(onBoundary.mock.calls).toEqual([['min'], ['max']])
    expect(onDelta).not.toHaveBeenCalled()
    expect(host.focused()).toBe(node)
  })

  it.each([
    { dir: 'x' as const, keys: ['ArrowUp', 'ArrowDown'] },
    { dir: 'y' as const, keys: ['ArrowLeft', 'ArrowRight'] }
  ])('does not own wrong-axis arrows on the $dir separator', async ({ dir, keys }) => {
    const { node, onDelta, onBoundary } = await mount({ dir })
    await act(async () => { node.focus() })
    for (const value of keys) {
      const event = await key(node, value)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(event.stopPropagation).not.toHaveBeenCalled()
    }
    expect(onDelta).not.toHaveBeenCalled()
    expect(onBoundary).not.toHaveBeenCalled()
    expect(host.focused()).toBe(node)
  })

  it('leaves Tab, ShiftTab, Enter and unrelated keys to their normal owners', async () => {
    for (const dir of ['x', 'y'] as const) {
      const { node, onDelta, onBoundary } = await mount({ dir })
      await act(async () => { node.focus() })
      for (const value of ['Tab', 'Enter', ' ', 'Escape', 'F6', 'x']) {
        const event = await key(node, value)
        expect(event.preventDefault).not.toHaveBeenCalled()
        expect(event.stopPropagation).not.toHaveBeenCalled()
      }
      const backwardTab = await key(node, 'Tab', { shiftKey: true })
      expect(backwardTab.preventDefault).not.toHaveBeenCalled()
      expect(backwardTab.stopPropagation).not.toHaveBeenCalled()
      expect(onDelta).not.toHaveBeenCalled()
      expect(onBoundary).not.toHaveBeenCalled()
      expect(host.focused()).toBe(node)
    }
  })

  it.each([
    { modifier: 'Control', options: { ctrlKey: true } },
    { modifier: 'Meta', options: { metaKey: true } },
    { modifier: 'Alt', options: { altKey: true } },
    { modifier: 'Shift', options: { shiftKey: true } }
  ])('does not intercept $modifier-modified arrows or endpoints', async ({ options }) => {
    for (const dir of ['x', 'y'] as const) {
      const { node, onDelta, onBoundary } = await mount({ dir })
      const arrows = dir === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
      for (const value of [...arrows, 'Home', 'End']) {
        const event = await key(node, value, options)
        expect(event.preventDefault).not.toHaveBeenCalled()
        expect(event.stopPropagation).not.toHaveBeenCalled()
      }
      expect(onDelta).not.toHaveBeenCalled()
      expect(onBoundary).not.toHaveBeenCalled()
    }
  })

  it.each(['x', 'y'] as const)('keeps an equal-range %s handle focusable but blocks adjustments and scroll', async dir => {
    const { node, onDelta, onBoundary } = await mount({ dir, value: 0, min: 0, max: 0 })
    expect(node.props.tabIndex).toBe(0)
    expect(node.props['aria-disabled']).toBe(true)
    expect(node.props['aria-valuenow']).toBe(0)
    expect(node.props['aria-valuemin']).toBe(0)
    expect(node.props['aria-valuemax']).toBe(0)
    await act(async () => { node.focus() })
    const arrows = dir === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    for (const value of [...arrows, 'Home', 'End']) {
      const event = await key(node, value)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
    expect(onDelta).not.toHaveBeenCalled()
    expect(onBoundary).not.toHaveBeenCalled()
    expect(host.focused()).toBe(node)
  })

  it('recovers from an equal range using new owner values without replacing the focused handle', async () => {
    const collapsed = await mount({ value: 0, min: 0, max: 0 })
    await act(async () => { collapsed.node.focus() })
    await key(collapsed.node, 'ArrowRight')
    expect(collapsed.onDelta).not.toHaveBeenCalled()
    const restored = await mount({ value: 240, min: 180, max: 560 })
    expect(restored.node).toBe(collapsed.node)
    expect(restored.node.props['aria-disabled']).not.toBe(true)
    expect(restored.node.props['aria-valuenow']).toBe(240)
    expect(restored.node.props['aria-valuemin']).toBe(180)
    expect(restored.node.props['aria-valuemax']).toBe(560)
    const event = await key(restored.node, 'ArrowRight')
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(restored.onDelta.mock.calls).toEqual([[10]])
    expect(host.focused()).toBe(restored.node)
  })

  it('handles each repeated arrow event once instead of dropping or multiplying movement', async () => {
    const { node, onDelta, onBoundary } = await mount()
    for (const repeat of [false, true, true]) {
      const event = await key(node, 'ArrowRight', { repeat })
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
    expect(onDelta.mock.calls).toEqual([[10], [10], [10]])
    expect(onBoundary).not.toHaveBeenCalled()
  })

  it.each(['x', 'y'] as const)('retains incremental captured pointer movement and pointer-up cleanup on %s', async dir => {
    const { node, onDelta, onBoundary } = await mount({ dir })
    const capture = vi.fn()
    const release = vi.fn()
    Object.assign(node, { setPointerCapture: capture, releasePointerCapture: release })
    const point = (primary: number, cross: number) => dir === 'x'
      ? { clientX: primary, clientY: cross } : { clientX: cross, clientY: primary }
    await pointer(node, 'onPointerMove', point(90, 60))
    expect(onDelta).not.toHaveBeenCalled()
    await pointer(node, 'onPointerDown', point(100, 60))
    expect(capture.mock.calls).toEqual([[9]])
    await pointer(node, 'onPointerMove', point(100, 96))
    expect(onDelta).not.toHaveBeenCalled()
    await pointer(node, 'onPointerMove', point(106, 96))
    await pointer(node, 'onPointerMove', point(103, 96))
    expect(onDelta.mock.calls).toEqual([[6], [-3]])
    await pointer(node, 'onPointerUp', point(103, 96))
    expect(release.mock.calls).toEqual([[9]])
    await pointer(node, 'onPointerMove', point(120, 96))
    expect(onDelta.mock.calls).toEqual([[6], [-3]])
    expect(onBoundary).not.toHaveBeenCalled()
  })

  it('cancels pointer ownership and starts the next drag from its new origin', async () => {
    for (const dir of ['x', 'y'] as const) {
      const { node, onDelta } = await mount({ dir })
      const capture = vi.fn()
      const release = vi.fn()
      Object.assign(node, { setPointerCapture: capture, releasePointerCapture: release })
      const point = (primary: number) => dir === 'x'
        ? { clientX: primary, clientY: 60 } : { clientX: 60, clientY: primary }
      await pointer(node, 'onPointerDown', point(20))
      await pointer(node, 'onPointerMove', point(23))
      await pointer(node, 'onPointerCancel', point(23))
      await pointer(node, 'onPointerMove', point(80))
      expect(onDelta.mock.calls).toEqual([[3]])
      expect(release.mock.calls).toEqual([[9]])
      await pointer(node, 'onPointerDown', point(100), 10)
      await pointer(node, 'onPointerMove', point(98), 10)
      await pointer(node, 'onPointerUp', point(98), 10)
      expect(capture.mock.calls).toEqual([[9], [10]])
      expect(release.mock.calls).toEqual([[9], [10]])
      expect(onDelta.mock.calls).toEqual([[3], [-2]])
    }
  })
})
