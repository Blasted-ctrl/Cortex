import { describe, expect, it } from 'vitest'
import { importWokwiDiagram, exportWokwiDiagram } from '../src/shared/wokwiDiagram'

const fixture = () => ({ version: 1, parts: [{ type: 'wokwi-arduino-uno', id: 'uno' }, { type: 'wokwi-led', id: 'led', attrs: { color: 'red' } }, { type: 'wokwi-pushbutton', id: 'btn', attrs: { bounce: '0' } }], connections: [['uno:13', 'led:A', 'green', []], ['led:C', 'uno:GND.1', 'black', []], ['btn:1.l', 'uno:2', 'orange', []], ['btn:2.r', 'uno:GND.2', 'black', []]] })
describe('documented Wokwi circuit subset', () => {
  it.each([{ frequency: '8m' }, { frequency: '16m' }, { unknown: 'value' }, 'bad'])('rejects unsupported Uno attributes before changing a circuit %#', (attrs) => {
    expect(() => importWokwiDiagram({ ...fixture(), parts: [{ type: 'wokwi-arduino-uno', id: 'uno', attrs }] })).toThrow()
  })
  it('keeps exported board IDs bounded even with long colliding component IDs', () => {
    const data = importWokwiDiagram({ version: 1, parts: [{ type: 'wokwi-arduino-uno', id: 'uno' }, ...Array.from({ length: 120 }, (_, i) => ({ type: 'wokwi-led', id: 'cortexUno' + '_'.repeat(i) }))], connections: [] })
    expect(() => importWokwiDiagram(exportWokwiDiagram(data))).not.toThrow()
  })
  it('retains supported button color, and rejects invalid color settings', () => {
    const data = { version: 1, parts: [{ type: 'wokwi-arduino-uno', id: 'uno' }, { type: 'wokwi-pushbutton', id: 'btn', attrs: { bounce: '0', color: 'red' } }], connections: [] }
    expect(importWokwiDiagram(exportWokwiDiagram(importWokwiDiagram(data))).parts[0].color).toBe('#ff0000')
    data.parts[1].attrs!.color = 'invalid'; expect(() => importWokwiDiagram(data)).toThrow('Unsupported Wokwi color')
  })
  it('uses the documented buzzer polarity: terminal 1 is GND, 2 is signal', () => {
    const data = { version: 1, parts: [{ id: 'uno', type: 'wokwi-arduino-uno' }, { id: 'bz', type: 'wokwi-buzzer' }], connections: [['bz:1', 'uno:GND.1', 'black'], ['bz:2', 'uno:8', 'red']] }
    const imported = importWokwiDiagram(data)
    expect(imported.parts[0].pins).toEqual({ sig: 8, gnd: -1 })
    expect((exportWokwiDiagram(imported).connections as string[][])[0][0]).toBe('bz:1')
  })
  it('does not imply Wokwi Uno 3.3V is functionally available', () => {
    const data = fixture(); data.connections[0][0] = 'uno:3.3V'
    expect(() => importWokwiDiagram(data)).toThrow('Unsupported Uno terminal')
  })
  it('rejects unspecified button bounce rather than silently removing default bounce', () => {
    const data = { version: 1, parts: [{ id: 'uno', type: 'wokwi-arduino-uno' }, { id: 'b', type: 'wokwi-pushbutton' }], connections: [] }
    expect(() => importWokwiDiagram(data)).toThrow('bounce')
  })
  it('preserves supported signal and ground connections through import/export', () => {
    const first = importWokwiDiagram(fixture())
    expect(first.parts[0]).toMatchObject({ type: 'led', color: '#ff0000', pins: { sig: 13, gnd: -1 } })
    expect(first.parts[1].pins).toEqual({ sig: 2, gnd: -1 })
    const second = importWokwiDiagram(exportWokwiDiagram(first))
    expect(second.parts.map((p) => p.pins)).toEqual(first.parts.map((p) => p.pins))
    expect(second.wires.map((w) => w.color)).toEqual(first.wires.map((w) => w.color))
  })
  it('rejects unsupported parts without silently dropping them', () => {
    const data = fixture(); data.parts.push({ type: 'wokwi-a4988', id: 'driver' })
    expect(() => importWokwiDiagram(data)).toThrow('Import cancelled; nothing was dropped')
  })
  it.each([
    { ...fixture(), version: 2 },
    { ...fixture(), parts: [...fixture().parts, { type: 'wokwi-led', id: 'led' }] },
    { ...fixture(), connections: [['uno:RESET', 'led:A', 'red', []]] },
    { ...fixture(), connections: [['uno:13', 'unknown:A', 'red', []]] },
    { ...fixture(), connections: [['uno:13', 'led:A', 'url(https://evil)', []]] },
    { ...fixture(), parts: [{ type: 'wokwi-arduino-uno', id: 'uno' }, { type: 'wokwi-pushbutton', id: 'b', attrs: { bounce: '1' } }] },
    { ...fixture(), parts: [{ type: 'wokwi-arduino-uno', id: 'uno' }, { type: 'wokwi-potentiometer', id: 'p', attrs: { value: '1023' } }] }
  ])('rejects malformed or behaviorally unsupported input %#', (data) => { expect(() => importWokwiDiagram(data)).toThrow() })
  it('rejects non-Uno export', () => { const data = importWokwiDiagram(fixture()); data.board = 'teensy41'; expect(() => exportWokwiDiagram(data)).toThrow('Only the Uno') })
  it('rejects export of unsupported native driver parts', () => { const data = importWokwiDiagram(fixture()); data.parts.push({ id: 'motor', type: 'motor', x: 100, y: 100, rotation: 0, pins: { pwm: null, dir: null, vcc: null, gnd: null } }); expect(() => exportWokwiDiagram(data)).toThrow('does not support motor') })
  it('does not collide with an imported component called cortexUno', () => { const data = fixture(); data.parts[1].id = 'cortexUno'; data.connections[0][1] = 'cortexUno:A'; data.connections[1][0] = 'cortexUno:C'; expect(importWokwiDiagram(exportWokwiDiagram(importWokwiDiagram(data))).parts[0].pins.sig).toBe(13) })
})
