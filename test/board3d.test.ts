import { describe, it, expect } from 'vitest'
import { exposedBoardPins } from '../src/shared/simCircuit'
import {
  BOARDS,
  DESIGN_CENTER,
  toWorld,
  pinTopY,
  PART_TOP_Y,
  frameWorkbench,
  type BoardDef
} from '../src/renderer/src/components/sim3d/board3d'

/**
 * The 3D board registry is pure data + math (no three, no DOM), so it can be
 * tested directly. This guards the pinouts (ESP32/Pi came from datasheets and
 * are easy to fat-finger) and the drag coordinate math, which is the custom
 * part of 3D part dragging.
 */

const boards: [string, BoardDef][] = Object.entries(BOARDS)

describe('board registry', () => {
  it.each(boards)('%s: fits board and outlying parts in a narrow top/underside viewport', (_id, def) => {
    const parts = [{ x: 40, y: 40 }, { x: 620, y: 490 }]
    const frame = frameWorkbench(def, parts, 0.8)
    const halfVisibleHeight = frame.distance * Math.tan(19 * Math.PI / 180)
    expect(frame.far).toBeGreaterThan(Math.max(1100, frame.distance * 2.5) + Math.hypot(def.size.w, def.size.d))
    for (const [x, z] of [[-def.size.w / 2, -def.size.d / 2], [def.size.w / 2, def.size.d / 2], ...parts.map((p) => { const [x, z] = toWorld(p.x, p.y); return [x * def.size.w / 400, z * def.size.d / 195] })]) {
      expect(Math.abs(x - frame.target[0]) + 35).toBeLessThan(halfVisibleHeight * 0.8)
      expect(Math.abs(z - frame.target[2]) + 35).toBeLessThan(halfVisibleHeight)
    }
    expect(Number.isFinite(frameWorkbench(def, [], Number.NaN).distance)).toBe(true)
  })
  it.each(boards)('%s: every wireable pin matches topology checker capabilities', (_id, def) => {
    expect([...new Set(def.pins.filter((p) => !p.inspectOnly).map((p) => p.pin))].sort((a, b) => a - b)).toEqual([...exposedBoardPins(def.id)].sort((a, b) => a - b))
  })
  it('has the supported inspection boards, each self-identifying', () => {
    expect(Object.keys(BOARDS).sort()).toEqual(['esp32', 'pi', 'teensy41', 'uno'])
    for (const [id, def] of boards) expect(def.id).toBe(id)
  })

  it.each(boards)('%s: every pin sits within the board footprint', (_id, def) => {
    const hx = def.size.w / 2 + 20
    const hz = def.size.d / 2 + 20
    for (const p of def.pins) {
      expect(Math.abs(p.x), `${p.label} x`).toBeLessThanOrEqual(hx)
      expect(Math.abs(p.z), `${p.label} z`).toBeLessThanOrEqual(hz)
    }
  })

  it.each(boards)('%s: a wire lands above the board surface', (_id, def) => {
    expect(pinTopY(def)).toBeGreaterThan(def.size.h)
    expect(pinTopY(def)).toBeGreaterThan(PART_TOP_Y - 10)
  })

  it.each(boards)('%s: wire-driven pin numbers are unique', (_id, def) => {
    const driven = def.pins.filter((p) => p.pin >= 0).map((p) => p.pin)
    expect(new Set(driven).size, 'duplicate pin number would wire two sockets at once').toBe(driven.length)
  })
})

describe('pinouts match the datasheets', () => {
  it('exposes Uno ground and power separately from GPIO', () => {
    expect(BOARDS.uno.pins.some((p) => p.kind === 'gnd')).toBe(true)
    expect(BOARDS.uno.pins.find((p) => p.label === '5V')?.pin).toBe(-2)
    expect(BOARDS.uno.pins.find((p) => p.label === '3.3V')?.pin).toBe(-3)
  })
  it('Teensy 4.1 has its 42 edge GPIOs, underside pads, and 3.3 V warning', () => {
    const teensy = BOARDS.teensy41
    for (let i = 0; i < 42; i++) expect(teensy.pins.find((p) => p.pin === i)?.face).not.toBe('bottom')
    for (let i = 48; i <= 54; i++) expect(teensy.pins.find((p) => p.pin === i)?.face).toBe('bottom')
    for (let i = 42; i <= 47; i++) expect(teensy.pins.some((p) => p.pin === i)).toBe(false)
    expect(teensy.pins.find((p) => p.pin === 53)?.functions).not.toContain('PWM')
    expect(teensy.pins.find((p) => p.pin === 14)?.functions).toContain('A0')
    expect(teensy.pins.find((p) => p.pin === 18)?.functions).toContain('SDA')
    expect(teensy.pins.filter((p) => p.kind === 'gnd').length).toBeGreaterThan(1)
    expect(teensy.notes.join(' ')).toContain('not 5 V tolerant')
    expect(teensy.ledPin).toBe(13)
  })
  it('Uno has D0-D13 and A0-A5, and the L LED is on 13', () => {
    const uno = BOARDS.uno
    for (let d = 0; d <= 13; d++) expect(uno.pins.find((p) => p.pin === d)?.label).toBe(`D${d}`)
    for (let a = 0; a < 6; a++) expect(uno.pins.find((p) => p.label === `A${a}`)?.pin).toBe(14 + a)
    expect(uno.ledPin).toBe(13)
    expect(uno.pins.some((p) => p.pin === 13)).toBe(true)
  })

  it('ESP32 maps IOn to GPIO n, and RX0/TX0 to 3/1', () => {
    const esp = BOARDS.esp32
    expect(esp.pins.find((p) => p.label === 'IO13')?.pin).toBe(13)
    expect(esp.pins.find((p) => p.label === 'IO2')?.pin).toBe(2)
    expect(esp.pins.find((p) => p.label === 'RX0')?.pin).toBe(3)
    expect(esp.pins.find((p) => p.label === 'TX0')?.pin).toBe(1)
    // Power/ground are not wire-driven.
    expect(esp.pins.find((p) => p.label === '3V3')?.pin).toBeLessThan(0)
    expect(esp.pins.filter((p) => p.label === 'GND').every((p) => p.pin < 0)).toBe(true)
    expect(esp.pins).toHaveLength(38)
  })

  it('Pi has 40 pins, GPIOn -> n, and 8 grounds', () => {
    const pi = BOARDS.pi
    expect(pi.pins).toHaveLength(40)
    expect(pi.pins.find((p) => p.label === 'GPIO18')?.pin).toBe(18)
    expect(pi.pins.find((p) => p.label === 'GPIO2')?.pin).toBe(2)
    expect(pi.pins.filter((p) => p.label === 'GND')).toHaveLength(8)
    expect(pi.pins.filter((p) => p.label === '5V')).toHaveLength(2)
  })
})

describe('drag coordinate math', () => {
  // 3D part dragging feeds movePart(worldX + DESIGN_CENTER.x, worldZ + .y); the
  // Uno reads parts back with toWorld. The two must be exact inverses or a
  // dragged part drifts.
  it.each([
    [0, 0],
    [140, -237.5],
    [-155, 60],
    [199, -199]
  ])('toWorld inverts the drag mapping at (%s, %s)', (wx, wz) => {
    const [rx, rz] = toWorld(wx + DESIGN_CENTER.x, wz + DESIGN_CENTER.y)
    expect(rx).toBeCloseTo(wx, 6)
    expect(rz).toBeCloseTo(wz, 6)
  })
})
