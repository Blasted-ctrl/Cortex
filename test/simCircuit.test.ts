import { describe, expect, it } from 'vitest'
import {
  BOARD_RAILS,
  PART_PINS,
  advanceActuator,
  connectedBoardPins,
  decodeSimDiagram,
  defaultPartProps,
  exposedBoardPins,
  inspectCircuit,
  motorDrive,
  resolveCircuitParts,
  updateStepper,
  wiresFromParts,
  type SimDiagram,
  type SimPart,
  type SimTerminal,
  type SimWire
} from '../src/shared/simCircuit'

const part = (type: SimPart['type'], id: string = type): SimPart => ({
  id, type, x: 100, y: 100, rotation: 0,
  pins: Object.fromEntries(PART_PINS[type].map((name) => [name, null])),
  props: defaultPartProps(type)
})
const board = (pin: number): SimTerminal => ({ kind: 'board', pin })
const terminal = (partId: string, pin: string): SimTerminal => ({ kind: 'part', partId, pin })
const wire = (id: string, from: SimTerminal, to: SimTerminal): SimWire => ({ id, from, to, kind: 'male-male' })
const diagram = (parts: SimPart[], wires: SimWire[] = []): SimDiagram => ({ version: 3, board: 'uno', parts, wires })

describe('diagram boundary', () => {
  it('round-trips a v3 diagram with supply voltage and physical connector kind', () => {
    const supply = part('power')
    supply.props = { volts: 12 }
    const layout = diagram([supply], [{ ...wire('lead', terminal('power', 'negative'), board(BOARD_RAILS.GND)), kind: 'alligator', color: '#112233' }])
    layout.parts = resolveCircuitParts(layout.parts, layout.wires)
    expect(decodeSimDiagram(JSON.parse(JSON.stringify(layout)))).toEqual(layout)
  })

  it('migrates legacy single pin and rescales v1 positions without losing the connection', () => {
    const result = decodeSimDiagram({ parts: [{ id: 'led-1', type: 'led', x: 920, y: 640, rotation: 0, pin: 13 }] })
    expect(result).toMatchObject({ version: 3, board: 'uno', parts: [{ id: 'led-1', pins: { sig: 13 } }] })
    expect(result.parts[0].x).toBeLessThan(660)
    expect(result.parts[0].y).toBeLessThan(520)
    expect(result.wires[0]).toMatchObject({ from: terminal('led-1', 'sig'), to: board(13) })
  })

  it('migrates v2 multi-pin parts without changing connections', () => {
    const rgb = { ...part('rgb'), pins: { r: 3, g: 5, b: 6 } }
    const result = decodeSimDiagram({ version: 2, parts: [rgb] })
    expect(result.parts[0].pins).toEqual({ ...rgb.pins, gnd: null })
    expect(result.wires).toHaveLength(3)
  })

  it.each(['led', 'button', 'buzzer', 'potentiometer', 'servo', 'ldr', 'thermistor'] as const)('adds explicit unconnected return terminals to legacy %s without inventing wiring', (type) => {
    const result = decodeSimDiagram({ version: 2, parts: [{ ...part(type), pins: { sig: 3 } }] })
    expect(result.parts[0].pins).toMatchObject({ sig: 3, gnd: null })
    expect(result.wires).toHaveLength(1)
    expect(result.wires[0]).toMatchObject({ from: terminal(type, 'sig'), to: board(3) })
    if (['potentiometer', 'servo', 'ldr', 'thermistor'].includes(type)) expect(result.parts[0].pins.vcc).toBeNull()
  })

  it('brings stranded v2 parts back into the visible design space', () => {
    const result = decodeSimDiagram({ version: 2, parts: [{ ...part('button'), x: -9000, y: 9999 }] })
    expect(result.parts[0]).toMatchObject({ x: 36, y: 484 })
  })

  it.each([
    null,
    [],
    { version: 99, parts: [] },
    { version: '2', parts: [] },
    { version: 2, parts: 'wrong' },
    { version: 2, parts: [{ ...part('led'), type: 'unimplemented' }] },
    { version: 2, parts: [part('led'), part('button', 'led')] },
    { version: 2, parts: [{ ...part('led'), id: '__proto__' }] },
    { version: 2, parts: [{ ...part('led'), x: '100' }] },
    { version: 2, parts: [{ ...part('led'), x: NaN }] },
    { version: 2, parts: [{ ...part('led'), pins: { sig: 64 } }] },
    { version: 2, parts: [{ ...part('led'), pins: { sig: -99 } }] },
    { version: 2, parts: [{ ...part('led'), pins: { sig: 2.5 } }] },
    { version: 2, parts: [{ ...part('led'), pins: { mystery: 13 } }] },
    { version: 2, parts: [{ ...part('led'), color: 'url(https://bad.invalid)' }] },
    { version: 3, board: 'unknown', parts: [], wires: [] },
    { version: 3, board: 'uno', parts: [], wires: 'wrong' },
    diagram([part('power')], [wire('bad', terminal('missing', 'positive'), board(3))]),
    diagram([part('power')], [wire('bad', terminal('power', 'wrong'), board(3))]),
    diagram([part('power')], [wire('bad', board(3), board(3))]),
    { ...diagram([part('power')]), wires: [{ ...wire('bad', board(3), board(4)), kind: 'unknown' }] },
    diagram([{ ...part('power'), props: { volts: -1 } }]),
    diagram([{ ...part('power'), props: { volts: Infinity } }]),
    diagram([{ ...part('actuator'), props: { travelMm: 0 } }])
  ])('rejects invalid external data without making renderer assumptions: %j', (input) => {
    expect(() => decodeSimDiagram(input)).toThrow()
  })

  it('rejects duplicate wire identifiers', () => {
    expect(() => decodeSimDiagram(diagram([], [wire('same', board(1), board(2)), wire('same', board(2), board(3))]))).toThrow(/duplicate/i)
  })

  it('bounds imported part count', () => {
    expect(() => decodeSimDiagram({ version: 2, parts: Array.from({ length: 257 }, (_, n) => part('led', `led-${n}`)) })).toThrow(/256/)
  })
})

describe('terminal graph', () => {
  it('fans input routing out to every GPIO on a cyclic net, never to rails', () => {
    const button = part('button')
    const connections = [wire('a', terminal('button', 'sig'), board(2)), wire('b', board(2), board(3)), wire('c', board(3), terminal('button', 'sig')), wire('ground', board(3), board(BOARD_RAILS.GND))]
    expect(connectedBoardPins([button], connections, terminal('button', 'sig'))).toEqual([2, 3])
    expect(connectedBoardPins([button], [], terminal('button', 'sig'))).toEqual([])
  })

  it('resolves signal connections through another part terminal', () => {
    const led = part('led')
    const button = part('button')
    const connections = [wire('one', board(13), terminal('button', 'sig')), wire('two', terminal('button', 'sig'), terminal('led', 'sig'))]
    expect(resolveCircuitParts([led, button], connections).map((p) => p.pins.sig)).toEqual([13, 13])
  })

  it('does not pick an arbitrary GPIO from a conflicting net', () => {
    const connections = [wire('one', board(13), terminal('led', 'sig')), wire('two', board(12), terminal('led', 'sig'))]
    expect(resolveCircuitParts([part('led')], connections)[0].pins.sig).toBeNull()
  })

  it('resolves a single known output feeding known inputs without inventing a driver for unknown pins', () => {
    const connections = [wire('one', board(13), terminal('led', 'sig')), wire('two', board(12), terminal('led', 'sig'))]
    expect(resolveCircuitParts([part('led')], connections, { 13: 1, 12: 0 })[0].pins.sig).toBe(13)
    expect(resolveCircuitParts([part('led')], connections, { 13: 1, 12: 2 })[0].pins.sig).toBe(13)
    expect(resolveCircuitParts([part('led')], connections, { 13: 1 })[0].pins.sig).toBeNull()
  })

  it('keeps multi-output and output-to-rail nets unresolved even when modes are known', () => {
    const connections = [wire('one', board(13), terminal('led', 'sig')), wire('two', board(12), terminal('led', 'sig'))]
    expect(resolveCircuitParts([part('led')], connections, { 13: 1, 12: 1 })[0].pins.sig).toBeNull()
    const rail = [connections[0], wire('ground', terminal('led', 'sig'), board(BOARD_RAILS.GND))]
    expect(resolveCircuitParts([part('led')], rail, { 13: 1 })[0].pins.sig).toBeNull()
  })

  it('resolves ground and power rails without making them GPIO input values', () => {
    const motor = part('motor')
    const connections = [wire('ground', terminal('motor', 'gnd'), board(BOARD_RAILS.GND)), wire('power', terminal('motor', 'vcc'), board(BOARD_RAILS.V5))]
    expect(resolveCircuitParts([motor], connections)[0].pins).toMatchObject({ gnd: -1, vcc: -2, pwm: null })
  })

  it('migrates direct mappings deterministically and does not mutate parts', () => {
    const original = { ...part('rgb'), pins: { r: 3, g: 5, b: null } }
    expect(wiresFromParts([original])).toEqual(wiresFromParts([original]))
    expect(wiresFromParts([original])).toHaveLength(2)
    expect(original.pins).toEqual({ r: 3, g: 5, b: null })
  })
})

describe('conservative circuit checks', () => {
  it('describes exposed board terminals including each board’s real power rails', () => {
    expect(exposedBoardPins('uno')).toEqual(expect.arrayContaining([0, 19, BOARD_RAILS.V5, BOARD_RAILS.VIN]))
    expect(exposedBoardPins('teensy41')).toEqual(expect.arrayContaining([0, 41, 48, 54, BOARD_RAILS.V3V3]))
    expect(exposedBoardPins('teensy41')).not.toEqual(expect.arrayContaining([42, BOARD_RAILS.V5]))
    expect(exposedBoardPins('esp32')).not.toContain(20)
    expect(exposedBoardPins('esp32')).not.toContain(BOARD_RAILS.V5)
    expect(exposedBoardPins('pi')).not.toContain(BOARD_RAILS.VIN)
  })

  it.each([['esp32', 20], ['esp32', 24], ['esp32', 28], ['esp32', 37], ['teensy41', 42], ['teensy41', 47], ['teensy41', BOARD_RAILS.V5], ['esp32', BOARD_RAILS.V5], ['pi', BOARD_RAILS.VIN]] as const)('warns when %s imports a wire to unexposed terminal %d', (boardId, pin) => {
    const layout = { ...diagram([part('led')], [wire('unexposed', terminal('led', 'sig'), board(pin))]), board: boardId }
    expect(inspectCircuit(layout)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'unsupported-pin' })]))
  })

  it('does not warn about unused unexposed rails or supported Teensy underside GPIOs', () => {
    expect(inspectCircuit({ ...diagram([]), board: 'esp32' })).toEqual([])
    const layout = { ...diagram([], [wire('tie', board(48), board(49))]), board: 'teensy41' as const }
    expect(inspectCircuit(layout).filter((f) => f.kind === 'unsupported-pin')).toEqual([])
  })

  it.each([34, 35, 36, 39])('rejects output use on ESP32 input-only GPIO %d', (pin) => {
    const layout = { ...diagram([part('led')], [wire('input-only', terminal('led', 'sig'), board(pin))]), board: 'esp32' as const }
    expect(inspectCircuit(layout, {}, { [pin]: 1 })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'input-only-output', severity: 'error' })]))
    expect(inspectCircuit(layout, {}, { [pin]: 0 }).filter((f) => f.kind === 'input-only-output')).toEqual([])
  })

  it('warns before use of ESP32 flash-connected GPIO, even without a running sketch', () => {
    const layout = { ...diagram([part('led')], [wire('flash', terminal('led', 'sig'), board(6))]), board: 'esp32' as const }
    expect(inspectCircuit(layout)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'reserved-pin', severity: 'warning' })]))
  })

  it('warns about floating released button input only when INPUT mode is actually known', () => {
    const layout = diagram([part('button')], [wire('input', terminal('button', 'sig'), board(2)), wire('ground', terminal('button', 'gnd'), board(BOARD_RAILS.GND))])
    expect(inspectCircuit(layout, {}, { 2: 0 })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'floating-button-input', partId: 'button' })]))
    expect(inspectCircuit(layout, {}, { 2: 2 }).filter((f) => f.kind === 'floating-button-input')).toEqual([])
    expect(inspectCircuit(layout).filter((f) => f.kind === 'floating-button-input')).toEqual([])
  })

  it('warns that a grounded button can short a pin configured as output', () => {
    const layout = diagram([part('button')], [wire('output', terminal('button', 'sig'), board(2)), wire('ground', terminal('button', 'gnd'), board(BOARD_RAILS.GND))])
    expect(inspectCircuit(layout, { 2: 1 }, { 2: 1 })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'button-on-output', partId: 'button', severity: 'warning' })]))
    expect(inspectCircuit(layout, { 2: 0 }, { 2: 2 }).filter((f) => f.kind === 'button-on-output')).toEqual([])
  })

  it.each(['led', 'button', 'buzzer', 'potentiometer', 'servo', 'ldr', 'thermistor', 'rgb', 'sevenseg'] as const)('warns about a missing explicit return for %s', (type) => {
    const item = part(type)
    expect(inspectCircuit(diagram([item]))).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'missing-ground', partId: type })]))
    const grounded = diagram([item], [wire('return', terminal(type, 'gnd'), board(BOARD_RAILS.GND))])
    expect(inspectCircuit(grounded).filter((finding) => finding.kind === 'missing-ground')).toEqual([])
  })

  it('round-trips explicit GPIO, supply and return terminals on a potentiometer', () => {
    const pot = part('potentiometer')
    const layout = diagram([pot], [wire('sig', terminal(pot.id, 'sig'), board(14)), wire('vcc', terminal(pot.id, 'vcc'), board(BOARD_RAILS.V5)), wire('gnd', terminal(pot.id, 'gnd'), board(BOARD_RAILS.GND))])
    expect(decodeSimDiagram(layout).parts[0].pins).toEqual({ sig: 14, vcc: BOARD_RAILS.V5, gnd: BOARD_RAILS.GND })
  })

  it('does not imply ordinary Servo library sketches are supported by a PWM animation', () => {
    expect(inspectCircuit(diagram([part('servo')]))).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'unsupported-servo-model', severity: 'warning' })]))
  })

  it('warns when an external supply is used without a shared return', () => {
    const connections = [wire('power', terminal('power', 'positive'), terminal('motor', 'vcc')), wire('ground', terminal('motor', 'gnd'), board(BOARD_RAILS.GND))]
    expect(inspectCircuit(diagram([part('power'), part('motor')], connections))).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'missing-ground', partId: 'power' })]))
  })

  it('identifies a supply short across its positive and negative terminals', () => {
    const connections = [wire('short', terminal('power', 'positive'), terminal('power', 'negative'))]
    expect(inspectCircuit(diagram([part('power')], connections))).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'supply-short', severity: 'error' })]))
  })

  it('warns about applying a 5V supply to a Teensy 3.3V GPIO', () => {
    const layout = { ...diagram([part('power')], [wire('bad-voltage', terminal('power', 'positive'), board(4))]), board: 'teensy41' as const }
    expect(inspectCircuit(layout)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'gpio-overvoltage', severity: 'error' })]))
  })

  it('checks Teensy VIN separately from GPIO', () => {
    const layout = { ...diagram([{ ...part('power'), props: { volts: 12 } }], [wire('vin', terminal('power', 'positive'), board(BOARD_RAILS.VIN))]), board: 'teensy41' as const }
    expect(inspectCircuit(layout)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'vin-overvoltage' })]))
  })

  it('does not call a same-voltage external supply safe or suppress missing ground', () => {
    const connections = [wire('power', terminal('motor', 'vcc'), board(BOARD_RAILS.V5))]
    const findings = inspectCircuit(diagram([part('motor')], connections))
    expect(findings.some((f) => f.kind === 'missing-ground')).toBe(true)
    expect(findings.some((f) => /safe|all clear/i.test(f.title))).toBe(false)
  })

  it('warns when a motor power terminal is wired directly to GPIO', () => {
    const connections = [wire('bad-power', terminal('motor', 'vcc'), board(9))]
    expect(inspectCircuit(diagram([part('motor')], connections))).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'gpio-load', partId: 'motor' })]))
  })

  it('distinguishes a control signal from directly powering a motor', () => {
    const connections = [wire('control', terminal('motor', 'pwm'), board(9)), wire('power', terminal('motor', 'vcc'), board(BOARD_RAILS.V5)), wire('ground', terminal('motor', 'gnd'), board(BOARD_RAILS.GND))]
    const findings = inspectCircuit(diagram([part('motor')], connections))
    expect(findings.filter((f) => f.kind === 'gpio-load' || f.kind === 'missing-ground')).toEqual([])
  })

  it('finds incompatible positive supply sources connected through the graph', () => {
    const low = { ...part('power', 'low'), props: { volts: 5 } }
    const high = { ...part('power', 'high'), props: { volts: 12 } }
    const connections = [wire('conflict', terminal('low', 'positive'), terminal('high', 'positive'))]
    expect(inspectCircuit(diagram([low, high], connections))).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'supply-conflict' })]))
  })

  it('detects opposing output drivers but does not guess modes for unset pins', () => {
    const layout = diagram([], [wire('tie', board(3), board(4))])
    expect(inspectCircuit(layout, { 3: 1, 4: 0 }, { 3: 1, 4: 1 })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'output-conflict' })]))
    expect(inspectCircuit(layout, { 3: 1, 4: 0 })).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'output-conflict' })]))
  })

  it.each([0, 2, undefined])('warns that an output net does not feed another GPIO input mode %s back to firmware', (inputMode) => {
    const layout = diagram([part('led')], [wire('output', terminal('led', 'sig'), board(13)), wire('input', terminal('led', 'sig'), board(2))])
    const findings = inspectCircuit(layout, { 13: 1 }, { 13: 1, ...(inputMode === undefined ? {} : { 2: inputMode }) })
    expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'unsupported-gpio-feedback', severity: 'warning', detail: expect.stringMatching(/digitalRead.*not.*propagat/i)
    })]))
  })

  it('does not confuse external sensor fanout or independent GPIO nets with unsupported feedback', () => {
    const fanout = diagram([part('potentiometer')], [wire('first', terminal('potentiometer', 'sig'), board(14)), wire('second', terminal('potentiometer', 'sig'), board(15))])
    expect(inspectCircuit(fanout, {}, { 14: 0, 15: 0 }).filter((f) => f.kind === 'unsupported-gpio-feedback')).toEqual([])
    const independent = diagram([part('led'), part('button')], [wire('output', terminal('led', 'sig'), board(13)), wire('input', terminal('button', 'sig'), board(2))])
    expect(inspectCircuit(independent, { 13: 1 }, { 13: 1, 2: 2 }).filter((f) => f.kind === 'unsupported-gpio-feedback')).toEqual([])
  })

  it('compares normalized digital and PWM duty rather than incompatible raw event scales', () => {
    const layout = diagram([], [wire('tie', board(3), board(4))])
    expect(inspectCircuit(layout, { 3: 1, 4: 255 }, { 3: 1, 4: 1 }, { 4: true }).filter((f) => f.kind === 'output-conflict')).toEqual([])
    expect(inspectCircuit(layout, { 3: 1, 4: 128 }, { 3: 1, 4: 1 }, { 4: true })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'output-conflict' })]))
  })

  it('identifies partial PWM against either fixed ground or a positive rail', () => {
    for (const rail of [BOARD_RAILS.GND, BOARD_RAILS.V5]) {
      const layout = diagram([], [wire('tie', board(3), board(rail))])
      expect(inspectCircuit(layout, { 3: 128 }, { 3: 1 }, { 3: true })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'output-rail-conflict' })]))
    }
    const positive = diagram([], [wire('tie', board(3), board(BOARD_RAILS.V5))])
    expect(inspectCircuit(positive, { 3: 255 }, { 3: 1 }, { 3: true }).filter((f) => f.kind === 'output-rail-conflict')).toEqual([])
  })

  it('does not treat Uno output HIGH as compatible with a fixed lower-voltage rail', () => {
    const layout = diagram([], [wire('tie', board(3), board(BOARD_RAILS.V3V3))])
    expect(inspectCircuit(layout, { 3: 1 }, { 3: 1 })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'output-rail-conflict' })]))
  })

  it('checks GPIO shorted to ground or power only when the GPIO is driven', () => {
    const layout = diagram([], [wire('tie', board(3), board(BOARD_RAILS.GND))])
    expect(inspectCircuit(layout, { 3: 1 }, { 3: 1 })).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'output-rail-conflict' })]))
    expect(inspectCircuit(layout, { 3: 0 }, { 3: 1 }).filter((f) => f.kind === 'output-rail-conflict')).toEqual([])
  })
})

describe('signal-controlled loads', () => {
  const motor = { ...part('motor'), pins: { pwm: 9, dir: 8, vcc: -2, gnd: -1 } }
  const stepper = { ...part('stepper'), pins: { step: 2, dir: 3, enable: 4, vcc: -2, gnd: -1 } }
  const actuator = { ...part('actuator'), pins: { pwm: 9, dir: 8, vcc: -2, gnd: -1 }, props: { travelMm: 20, speedMmPerSecond: 10 } }

  it('normalizes motor PWM duty and direction without claiming torque', () => {
    expect(motorDrive(motor, { 9: 128, 8: 1 }, { 9: true })).toBeCloseTo(128 / 255)
    expect(motorDrive(motor, { 9: 255, 8: 0 }, { 9: true })).toBe(-1)
    expect(motorDrive(motor, { 9: 0, 8: 1 }, {})).toBe(0)
    expect(motorDrive(motor, { 9: 1, 8: 1 }, {})).toBe(1)
  })

  it('honors a grounded direction input without reading a fake negative GPIO slot', () => {
    expect(motorDrive({ ...motor, pins: { ...motor.pins, dir: BOARD_RAILS.GND } }, { 9: 1 }, {})).toBe(-1)
  })

  it('holds the stepper disabled when ENABLE is tied to a positive logic rail', () => {
    const tied = { ...stepper, pins: { ...stepper.pins, enable: BOARD_RAILS.V3V3 } }
    expect(updateStepper(tied, { steps: 0, lastStep: 0 }, { kind: 'pin', pin: 2, value: 1 }, { 3: 1 }).steps).toBe(0)
  })

  it('never treats a negative rail as a motor control GPIO', () => {
    expect(motorDrive({ ...motor, pins: { ...motor.pins, pwm: -2 } }, { '-2': 1, 8: 1 }, {})).toBe(0)
  })

  it('counts every rising STEP edge and ignores repeated high values', () => {
    let state = { steps: 0, lastStep: 0 }
    state = updateStepper(stepper, state, { kind: 'pin', pin: 2, value: 1 }, { 2: 1, 3: 1, 4: 0 })
    expect(state).toEqual({ steps: 1, lastStep: 1 })
    state = updateStepper(stepper, state, { kind: 'pin', pin: 2, value: 1 }, { 2: 1, 3: 1, 4: 0 })
    expect(state.steps).toBe(1)
    state = updateStepper(stepper, state, { kind: 'pin', pin: 2, value: 0 }, { 2: 0, 3: 1, 4: 0 })
    state = updateStepper(stepper, state, { kind: 'pin', pin: 2, value: 1 }, { 2: 1, 3: 1, 4: 0 })
    expect(state.steps).toBe(2)
  })

  it('honors active-low stepper enable and direction at the actual edge', () => {
    expect(updateStepper(stepper, { steps: 10, lastStep: 0 }, { kind: 'pin', pin: 2, value: 1 }, { 2: 1, 3: 0, 4: 0 }).steps).toBe(9)
    expect(updateStepper(stepper, { steps: 10, lastStep: 0 }, { kind: 'pin', pin: 2, value: 1 }, { 2: 1, 3: 0, 4: 1 }).steps).toBe(10)
  })

  it('does not turn PWM, tone or pin-mode events into step pulses', () => {
    for (const kind of ['pwm', 'tone', 'mode']) {
      expect(updateStepper(stepper, { steps: 1, lastStep: 0 }, { kind, pin: 2, value: 1 }, { 3: 1, 4: 0 })).toEqual({ steps: 1, lastStep: 0 })
    }
  })

  it('advances the actuator at configured ideal speed and stops at each travel limit', () => {
    const initial = { positionMm: 0, atMin: true, atMax: false }
    const advanced = advanceActuator(actuator, initial, 500, { 9: 255, 8: 1 }, { 9: true })
    expect(advanced).toEqual({ positionMm: 5, atMin: false, atMax: false })
    const maximum = advanceActuator(actuator, advanced, 10000, { 9: 255, 8: 1 }, { 9: true })
    expect(maximum).toEqual({ positionMm: 20, atMin: false, atMax: true })
    const minimum = advanceActuator(actuator, maximum, 10000, { 9: 255, 8: 0 }, { 9: true })
    expect(minimum).toEqual(initial)
  })

  it('makes equal actuator simulation steps reproducible and rejects invalid elapsed time', () => {
    const initial = { positionMm: 5, atMin: false, atMax: false }
    const one = advanceActuator(actuator, initial, 1000, { 9: 128, 8: 1 }, { 9: true })
    const half = advanceActuator(actuator, initial, 500, { 9: 128, 8: 1 }, { 9: true })
    const two = advanceActuator(actuator, half, 500, { 9: 128, 8: 1 }, { 9: true })
    expect(two.positionMm).toBeCloseTo(one.positionMm)
    expect(() => advanceActuator(actuator, initial, -1, {}, {})).toThrow(/elapsed/i)
  })
})
