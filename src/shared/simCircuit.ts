import { clampToSpace, W, H, V1_SPACE } from './simLayout'
import { PWM_MAX } from './simProtocol'

export type SimBoardId = 'uno' | 'esp32' | 'pi' | 'teensy41'
export type SimPartType = 'led' | 'rgb' | 'button' | 'buzzer' | 'resistor' | 'potentiometer' | 'servo' | 'ldr' | 'thermistor' | 'sevenseg' | 'motor' | 'stepper' | 'actuator' | 'power'
export type JumperKind = 'male-male' | 'female-female' | 'alligator'

export const BOARD_RAILS = { GND: -1, V5: -2, V3V3: -3, VIN: -4 } as const
export const PART_PINS: Record<SimPartType, string[]> = {
  led: ['sig', 'gnd'],
  rgb: ['r', 'g', 'b', 'gnd'],
  button: ['sig', 'gnd'],
  buzzer: ['sig', 'gnd'],
  resistor: ['sig'],
  potentiometer: ['sig', 'vcc', 'gnd'],
  servo: ['sig', 'vcc', 'gnd'],
  ldr: ['sig', 'vcc', 'gnd'],
  thermistor: ['sig', 'vcc', 'gnd'],
  sevenseg: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp', 'gnd'],
  motor: ['pwm', 'dir', 'vcc', 'gnd'],
  stepper: ['step', 'dir', 'enable', 'vcc', 'gnd'],
  actuator: ['pwm', 'dir', 'vcc', 'gnd'],
  power: ['positive', 'negative']
}

export interface SimPartProps {
  volts?: number
  speedRpm?: number
  stepsPerRevolution?: number
  travelMm?: number
  speedMmPerSecond?: number
  resistanceOhms?: number
}

export interface SimPart {
  id: string
  type: SimPartType
  x: number
  y: number
  rotation: number
  color?: string
  pins: Record<string, number | null>
  props?: SimPartProps
}

export type SimTerminal = { kind: 'board'; pin: number } | { kind: 'part'; partId: string; pin: string }
export interface SimWire {
  id: string
  from: SimTerminal
  to: SimTerminal
  kind: JumperKind
  color?: string
}
export interface SimDiagram {
  version: 3
  board: SimBoardId
  parts: SimPart[]
  wires: SimWire[]
}
export interface CircuitFinding {
  id: string
  kind: 'supply-short' | 'supply-conflict' | 'gpio-overvoltage' | 'vin-overvoltage' | 'missing-ground' | 'gpio-load' | 'output-conflict' | 'output-rail-conflict' | 'unsupported-pin' | 'input-only-output' | 'reserved-pin' | 'floating-button-input' | 'button-on-output' | 'unsupported-servo-model' | 'unsupported-gpio-feedback'
  severity: 'warning' | 'error'
  title: string
  detail: string
  partId?: string
  wireId?: string
}
export interface StepperState { steps: number; lastStep: number }
export interface ActuatorState { positionMm: number; atMin: boolean; atMax: boolean }

export function defaultPartProps(type: SimPartType): SimPartProps | undefined {
  switch (type) {
    case 'power': return { volts: 5 }
    case 'motor': return { speedRpm: 3000 }
    case 'stepper': return { stepsPerRevolution: 200 }
    case 'actuator': return { travelMm: 100, speedMmPerSecond: 10 }
    case 'resistor': return { resistanceOhms: 220 }
    default: return undefined
  }
}

const BOARD_IDS: SimBoardId[] = ['uno', 'esp32', 'pi', 'teensy41']
const JUMPER_KINDS: JumperKind[] = ['male-male', 'female-female', 'alligator']
const railIds: number[] = Object.values(BOARD_RAILS)
// These sets describe the rendered connectors, not all package-level MCU pins.
// ESP32 DevKitC: GPIO 34..39 are input-only; 6..11 connect to module flash.
// Teensy 4.1: 42..47 belong to the SD socket; QSPI pads 48..54 are exposed.
const EXPOSED_BOARD_PINS: Record<SimBoardId, readonly number[]> = {
  uno: Object.freeze([...Array.from({ length: 20 }, (_, n) => n), ...railIds]),
  esp32: Object.freeze([...Array.from({ length: 20 }, (_, n) => n), 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39, BOARD_RAILS.GND, BOARD_RAILS.V3V3, BOARD_RAILS.VIN]),
  pi: Object.freeze([...Array.from({ length: 28 }, (_, n) => n), BOARD_RAILS.GND, BOARD_RAILS.V5, BOARD_RAILS.V3V3]),
  teensy41: Object.freeze([...Array.from({ length: 42 }, (_, n) => n), ...Array.from({ length: 7 }, (_, n) => 48 + n), BOARD_RAILS.GND, BOARD_RAILS.V3V3, BOARD_RAILS.VIN])
}

export function exposedBoardPins(board: SimBoardId): readonly number[] {
  return EXPOSED_BOARD_PINS[board]
}

const validPin = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && ((value >= 0 && value <= 63) || railIds.includes(value))
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const validColor = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value)
const terminalKey = (terminal: SimTerminal): string => terminal.kind === 'board' ? `b:${terminal.pin}` : `p:${terminal.partId}:${terminal.pin}`

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) {
    throw new Error(`${label} must be a nonempty identifier of at most 128 characters.`)
  }
  return value
}

function requireFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number.`)
  return value
}

const PROP_LIMITS: Record<keyof SimPartProps, [number, number]> = {
  volts: [0, 60], speedRpm: [1, 100000], stepsPerRevolution: [1, 100000],
  travelMm: [0.001, 10000], speedMmPerSecond: [0.001, 10000], resistanceOhms: [0.001, 1e9]
}

function decodeProps(value: unknown, type: SimPartType): SimPartProps | undefined {
  const defaults = defaultPartProps(type)
  if (value === undefined) return defaults
  if (!isRecord(value)) throw new Error('Part properties must be an object.')
  const props: SimPartProps = { ...defaults }
  for (const [name, raw] of Object.entries(value)) {
    if (!Object.hasOwn(PROP_LIMITS, name)) throw new Error(`Unknown part property: ${name}.`)
    const key = name as keyof SimPartProps
    const number = requireFinite(raw, name)
    const [min, max] = PROP_LIMITS[key]
    if (number < min || number > max) throw new Error(`${name} must be between ${min} and ${max}.`)
    if (key === 'stepsPerRevolution' && !Number.isInteger(number)) throw new Error('stepsPerRevolution must be an integer.')
    props[key] = number
  }
  return Object.keys(props).length ? props : undefined
}

function decodePart(value: unknown, version: number): SimPart {
  if (!isRecord(value)) throw new Error('Every part must be an object.')
  const id = requireId(value.id, 'Part id')
  if (typeof value.type !== 'string' || !Object.hasOwn(PART_PINS, value.type)) throw new Error(`Unsupported part type in ${id}.`)
  const type = value.type as SimPartType
  const x = requireFinite(value.x, `${id}.x`)
  const y = requireFinite(value.y, `${id}.y`)
  const rotation = requireFinite(value.rotation ?? 0, `${id}.rotation`)
  if (value.color !== undefined && !validColor(value.color)) throw new Error(`Invalid color in ${id}.`)
  const rawPins = value.pins ?? (version < 2 ? { sig: value.pin ?? null } : undefined)
  if (!isRecord(rawPins)) throw new Error(`Missing or invalid pins in ${id}.`)
  const pins: Record<string, number | null> = Object.fromEntries(PART_PINS[type].map((pin) => [pin, null]))
  for (const [name, pin] of Object.entries(rawPins)) {
    if (!PART_PINS[type].includes(name)) throw new Error(`Unsupported terminal ${id}.${name}.`)
    if (pin !== null && !validPin(pin)) throw new Error(`Invalid board pin for ${id}.${name}; use GPIO 0..63 or a supported power rail.`)
    pins[name] = pin as number | null
  }
  const position = clampToSpace(version < 2 ? { x: Math.round(x * W / V1_SPACE.w), y: Math.round(y * H / V1_SPACE.h) } : { x, y })
  const props = decodeProps(value.props, type)
  return {
    id, type, ...position, rotation: ((rotation % 360) + 360) % 360,
    ...(value.color === undefined ? {} : { color: value.color as string }),
    pins,
    ...(props ? { props } : {})
  }
}

function decodeTerminal(value: unknown, parts: Map<string, SimPart>): SimTerminal {
  if (!isRecord(value)) throw new Error('Every wire endpoint must be an object.')
  if (value.kind === 'board') {
    if (!validPin(value.pin)) throw new Error('Invalid board wire endpoint; use GPIO 0..63 or a supported power rail.')
    return { kind: 'board', pin: value.pin }
  }
  if (value.kind === 'part') {
    const partId = requireId(value.partId, 'Endpoint part id')
    const part = parts.get(partId)
    if (!part || typeof value.pin !== 'string' || !PART_PINS[part.type].includes(value.pin)) throw new Error(`Unknown wire terminal on ${partId}.`)
    return { kind: 'part', partId, pin: value.pin }
  }
  throw new Error('Wire endpoints must refer to a board or a part.')
}

export function wiresFromParts(parts: SimPart[]): SimWire[] {
  return parts.flatMap((part, index) => Object.entries(part.pins).flatMap(([pin, boardPin]) => boardPin === null ? [] : [{
    id: `legacy-${index}-${pin}`,
    from: { kind: 'part' as const, partId: part.id, pin },
    to: { kind: 'board' as const, pin: boardPin },
    kind: 'male-male' as const
  }]))
}

export function decodeSimDiagram(value: unknown): SimDiagram {
  if (!isRecord(value)) throw new Error('Circuit layout must be an object.')
  const version = value.version === undefined ? 1 : value.version
  if (version !== 1 && version !== 2 && version !== 3) throw new Error(`Unsupported circuit layout version: ${String(version)}.`)
  if (!Array.isArray(value.parts) || value.parts.length > 256) throw new Error('Circuit layout must contain an array of at most 256 parts.')
  const parts = value.parts.map((entry) => decodePart(entry, version))
  const byId = new Map(parts.map((part) => [part.id, part]))
  if (byId.size !== parts.length) throw new Error('Circuit layout contains duplicate part identifiers.')
  if (version < 3) return { version: 3, board: 'uno', parts, wires: wiresFromParts(parts) }
  if (typeof value.board !== 'string' || !BOARD_IDS.includes(value.board as SimBoardId)) throw new Error('Unsupported circuit board.')
  if (!Array.isArray(value.wires) || value.wires.length > 2048) throw new Error('Circuit layout must contain an array of at most 2048 wires.')
  const ids = new Set<string>()
  const wires = value.wires.map((raw): SimWire => {
    if (!isRecord(raw)) throw new Error('Every wire must be an object.')
    const id = requireId(raw.id, 'Wire id')
    if (ids.has(id)) throw new Error('Circuit layout contains duplicate wire identifiers.')
    ids.add(id)
    const from = decodeTerminal(raw.from, byId)
    const to = decodeTerminal(raw.to, byId)
    if (terminalKey(from) === terminalKey(to)) throw new Error(`Wire ${id} connects a terminal to itself.`)
    if (typeof raw.kind !== 'string' || !JUMPER_KINDS.includes(raw.kind as JumperKind)) throw new Error(`Unsupported jumper connector type in ${id}.`)
    if (raw.color !== undefined && !validColor(raw.color)) throw new Error(`Invalid wire color in ${id}.`)
    return { id, from, to, kind: raw.kind as JumperKind, ...(raw.color === undefined ? {} : { color: raw.color as string }) }
  })
  return { version: 3, board: value.board as SimBoardId, parts: resolveCircuitParts(parts, wires), wires }
}

function circuitNets(parts: SimPart[], wires: SimWire[]): { root: (terminal: SimTerminal) => string; nets: Map<string, SimTerminal[]> } {
  const parents = new Map<string, string>()
  const terminals = new Map<string, SimTerminal>()
  const add = (terminal: SimTerminal): string => {
    const key = terminalKey(terminal)
    if (!parents.has(key)) { parents.set(key, key); terminals.set(key, terminal) }
    return key
  }
  const find = (key: string): string => {
    let result = key
    while (parents.get(result) !== result) result = parents.get(result)!
    while (key !== result) {
      const next = parents.get(key)!
      parents.set(key, result)
      key = next
    }
    return result
  }
  for (const pin of railIds) add({ kind: 'board', pin })
  for (const part of parts) for (const pin of PART_PINS[part.type]) add({ kind: 'part', partId: part.id, pin })
  for (const wire of wires) {
    const from = find(add(wire.from))
    const to = find(add(wire.to))
    if (from !== to) parents.set(from, to)
  }
  const nets = new Map<string, SimTerminal[]>()
  for (const [key, terminal] of terminals) {
    const net = find(key)
    const list = nets.get(net) ?? []
    list.push(terminal)
    nets.set(net, list)
  }
  return { root: (terminal) => find(add(terminal)), nets }
}

export function resolveCircuitParts(parts: SimPart[], wires: SimWire[], modes?: Record<number, number>): SimPart[] {
  const { root, nets } = circuitNets(parts, wires)
  return parts.map((part) => ({
    ...part,
    pins: Object.fromEntries(PART_PINS[part.type].map((pin) => {
      const boardPins = (nets.get(root({ kind: 'part', partId: part.id, pin })) ?? []).filter((terminal): terminal is Extract<SimTerminal, { kind: 'board' }> => terminal.kind === 'board')
      if (boardPins.length === 1) return [pin, boardPins[0].pin]
      const outputs = boardPins.filter((terminal) => modes?.[terminal.pin] === 1)
      const knownSignalNet = !!modes && boardPins.every((terminal) => terminal.pin >= 0 && [0, 1, 2].includes(modes[terminal.pin]))
      return [pin, knownSignalNet && outputs.length === 1 ? outputs[0].pin : null]
    }))
  }))
}

export function connectedBoardPins(parts: SimPart[], wires: SimWire[], terminal: SimTerminal): number[] {
  const { root, nets } = circuitNets(parts, wires)
  return (nets.get(root(terminal)) ?? []).flatMap((entry) => entry.kind === 'board' && entry.pin >= 0 ? [entry.pin] : []).sort((a, b) => a - b)
}

export function inspectCircuit(diagram: SimDiagram, states: Record<number, number> = {}, modes: Record<number, number> = {}, pwm: Record<number, boolean> = {}): CircuitFinding[] {
  const { root, nets } = circuitNets(diagram.parts, diagram.wires)
  const findings: CircuitFinding[] = []
  const logicVolts = diagram.board === 'uno' ? 5 : 3.3
  const ground = root({ kind: 'board', pin: BOARD_RAILS.GND })
  const netSources = new Map<string, { volts: number; name: string }[]>()
  const addSource = (net: string, volts: number, name: string): void => {
    const sources = netSources.get(net) ?? []
    sources.push({ volts, name })
    netSources.set(net, sources)
  }
  addSource(ground, 0, 'Board GND')
  addSource(root({ kind: 'board', pin: BOARD_RAILS.V5 }), 5, 'Board 5V')
  addSource(root({ kind: 'board', pin: BOARD_RAILS.V3V3 }), 3.3, 'Board 3.3V')
  for (const part of diagram.parts) {
    if (part.type === 'power') {
      const positive = root({ kind: 'part', partId: part.id, pin: 'positive' })
      const negative = root({ kind: 'part', partId: part.id, pin: 'negative' })
      const volts = part.props?.volts ?? 5
      addSource(positive, volts, part.id)
      if (positive === negative && volts > 0) findings.push({
        id: `short-${part.id}`, kind: 'supply-short', severity: 'error', partId: part.id,
        title: 'Power supply is shorted', detail: `${part.id} connects its positive and negative terminals on the same net. Remove that connection before powering real hardware.`
      })
      if ((nets.get(positive)?.length ?? 0) > 1 && negative !== ground) findings.push({
        id: `ground-${part.id}`, kind: 'missing-ground', severity: 'warning', partId: part.id,
        title: 'Power supply needs a shared return', detail: `${part.id} negative is not connected to board GND. Connect the return for this board-controlled circuit; these checks do not model isolated driver interfaces.`
      })
    }
    if (part.type === 'servo') findings.push({
      id: `servo-model-${part.id}`, kind: 'unsupported-servo-model', severity: 'warning', partId: part.id,
      title: 'Servo animation is not a Servo library model', detail: 'This view maps PWM duty to an illustrative angle. Servo.h, pulse widths, timing and mechanical loads are not modeled; verify a real servo with supported firmware and hardware.'
    })
    const isDriver = part.type === 'motor' || part.type === 'stepper' || part.type === 'actuator'
    if (PART_PINS[part.type].includes('gnd') && root({ kind: 'part', partId: part.id, pin: 'gnd' }) !== ground) findings.push({
      id: `ground-${part.id}`, kind: 'missing-ground', severity: 'warning', partId: part.id,
      title: isDriver ? 'Driver needs a common ground' : 'Part needs an explicit ground return', detail: `${part.id} GND is not connected to board GND. Connect a shared signal reference; its animation does not validate real electrical operation.`
    })
    if (part.type === 'button') {
      const contacts = (nets.get(root({ kind: 'part', partId: part.id, pin: 'sig' })) ?? []).filter((terminal): terminal is Extract<SimTerminal, { kind: 'board' }> => terminal.kind === 'board' && terminal.pin >= 0)
      if (root({ kind: 'part', partId: part.id, pin: 'gnd' }) === ground && contacts.some((terminal) => modes[terminal.pin] === 1)) findings.push({
        id: `button-output-${part.id}`, kind: 'button-on-output', severity: 'warning', partId: part.id,
        title: 'Grounded button is connected to an output', detail: `${part.id} closes an OUTPUT pin to GND when pressed. A HIGH output would be shorted; rewire to an input with an appropriate pull-up. The preview refuses to force output pins and does not calculate short-circuit current.`
      })
      if (contacts.some((terminal) => modes[terminal.pin] === 0) && !contacts.some((terminal) => modes[terminal.pin] === 1 || modes[terminal.pin] === 2)) findings.push({
        id: `floating-${part.id}`, kind: 'floating-button-input', severity: 'warning', partId: part.id,
        title: 'Released button input may float', detail: `${part.id} is connected to an INPUT without a modeled pull-up. Use INPUT_PULLUP with a grounded button or a suitable external resistor on real hardware. The preview defaults an unpowered input to zero; it does not predict a floating voltage or solve resistors.`
      })
    }
    if (!isDriver) continue
    const power = root({ kind: 'part', partId: part.id, pin: 'vcc' })
    if ((nets.get(power) ?? []).some((terminal) => terminal.kind === 'board' && terminal.pin >= 0)) findings.push({
      id: `load-${part.id}`, kind: 'gpio-load', severity: 'error', partId: part.id,
      title: 'Do not power a motor from GPIO', detail: `${part.id} VCC is on a GPIO net. Use a suitably rated motor driver and an external supply; GPIO should connect only to driver control inputs.`
    })
  }
  for (const [net, terminals] of nets) {
    const sources = netSources.get(net) ?? []
    if (new Set(sources.map((source) => source.volts)).size > 1) findings.push({
      id: `supplies-${net}`, kind: 'supply-conflict', severity: 'error',
      title: 'Different supply voltages are tied together', detail: `${sources.map((source) => `${source.name} (${source.volts}V)`).join(', ')} share a net, assuming their returns reference board GND. Separate the supplies; floating supplies, current and protection behavior require independent verification.`
    })
    const boardPins = terminals.filter((terminal): terminal is Extract<SimTerminal, { kind: 'board' }> => terminal.kind === 'board')
    const gpio = boardPins.filter((terminal) => terminal.pin >= 0)
    if (gpio.some((terminal) => modes[terminal.pin] === 1) && gpio.some((terminal) => modes[terminal.pin] !== 1)) findings.push({
      id: `feedback-${net}`, kind: 'unsupported-gpio-feedback', severity: 'warning',
      title: 'GPIO-to-GPIO input feedback is not simulated', detail: `GPIO ${gpio.map((terminal) => terminal.pin).join(', ')} share an output net. The canvas can display its driver signal, but digitalRead/analogRead on another GPIO do not receive propagated output values. Test feedback-dependent firmware on supported hardware; these diagram wires are not runtime GPIO aliases.`
    })
    const voltage = Math.max(-1, ...sources.map((source) => source.volts))
    if (gpio.length && voltage > logicVolts) findings.push({
      id: `voltage-${net}`, kind: 'gpio-overvoltage', severity: 'error',
      title: `${voltage}V exceeds the board's ${logicVolts}V GPIO level`, detail: `GPIO ${gpio.map((terminal) => terminal.pin).join(', ')} is connected to a configured higher-voltage source, assuming a shared board GND reference. Floating supplies require independent verification. Use an appropriate level shifter; do not apply this wiring to real hardware.`
    })
    if (diagram.board === 'teensy41' && boardPins.some((terminal) => terminal.pin === BOARD_RAILS.VIN) && voltage > 5.5) findings.push({
      id: `vin-${net}`, kind: 'vin-overvoltage', severity: 'error',
      title: 'Supply exceeds Teensy VIN rating', detail: `${voltage}V is above the documented 5.5V maximum for Teensy 4.1 VIN. Lower the supply voltage before connecting real hardware.`
    })
    const outputs = gpio.filter((terminal) => modes[terminal.pin] === 1 && states[terminal.pin] !== undefined)
    if (new Set(outputs.map((terminal) => outputDuty(states[terminal.pin], pwm[terminal.pin]))).size > 1) findings.push({
      id: `outputs-${net}`, kind: 'output-conflict', severity: 'error',
      title: 'Output pins disagree on the same wire', detail: `GPIO ${outputs.map((terminal) => terminal.pin).join(', ')} drive different values on one net. Disconnect competing outputs before using real hardware.`
    })
    if (outputs.some((terminal) => sources.some((source) => source.volts === 0 ? outputDuty(states[terminal.pin], pwm[terminal.pin]) > 0 : outputDuty(states[terminal.pin], pwm[terminal.pin]) < 1 || source.volts !== logicVolts))) findings.push({
      id: `rail-output-${net}`, kind: 'output-rail-conflict', severity: 'error',
      title: 'An output is driving against a power rail', detail: 'A driven GPIO is wired to an opposing ground or supply rail, or a rail different from the board GPIO level. Remove that connection; the signal simulator does not model resulting short-circuit current.'
    })
    for (const terminal of boardPins.filter((terminal) => terminals.length > 1 && !exposedBoardPins(diagram.board).includes(terminal.pin))) findings.push({
      id: `unsupported-pin-${terminal.pin}`, kind: 'unsupported-pin', severity: 'warning',
      title: `${terminal.pin >= 0 ? `GPIO ${terminal.pin}` : terminal.pin === BOARD_RAILS.V5 ? '5V' : terminal.pin === BOARD_RAILS.V3V3 ? '3.3V' : terminal.pin === BOARD_RAILS.VIN ? 'VIN' : 'GND'} is not exposed by this board`, detail: 'The saved wire references a terminal outside this board model. Select the intended board or rewire it; a host-simulation slot is not proof of a physical connector.'
    })
    if (diagram.board === 'esp32') for (const terminal of gpio) {
      if ([34, 35, 36, 39].includes(terminal.pin) && modes[terminal.pin] === 1) findings.push({
        id: `input-only-${terminal.pin}`, kind: 'input-only-output', severity: 'error',
        title: `ESP32 GPIO ${terminal.pin} is input-only`, detail: 'This firmware configures an input-only connector as OUTPUT. Rewire to an output-capable GPIO; host-shim behavior does not prove the ESP32 can drive this pin.'
      })
      if (terminal.pin >= 6 && terminal.pin <= 11) findings.push({
        id: `reserved-${terminal.pin}`, kind: 'reserved-pin', severity: 'warning',
        title: `ESP32 GPIO ${terminal.pin} is connected to flash`, detail: 'GPIO 6-11 are reserved for the module flash interface on this DevKit model. Avoid external use; a working signal preview does not validate flash access or boot behavior.'
      })
    }
  }
  return findings
}

function controlHigh(pin: number | null | undefined, states: Record<number, number>): boolean {
  if (pin === BOARD_RAILS.V5 || pin === BOARD_RAILS.V3V3) return true
  return pin !== null && pin !== undefined && pin >= 0 && (states[pin] ?? 0) > 0
}

function outputDuty(value: number, pwm: boolean | undefined): number {
  return Math.min(1, Math.max(0, pwm ? value / PWM_MAX : value > 0 ? 1 : 0))
}

export function motorDrive(part: SimPart, states: Record<number, number>, pwm: Record<number, boolean>): number {
  const pin = part.pins.pwm
  if (pin === null || pin === undefined || pin < 0) return 0
  const raw = states[pin] ?? 0
  const duty = outputDuty(raw, pwm[pin])
  const direction = part.pins.dir
  return duty * (direction === null || direction === undefined || controlHigh(direction, states) ? 1 : -1)
}

export function updateStepper(part: SimPart, previous: StepperState, event: { kind: string; pin?: number; value?: number }, states: Record<number, number>): StepperState {
  const step = part.pins.step
  if (step === null || step === undefined || step < 0 || event.kind !== 'pin' || event.pin !== step) return previous
  const high = (event.value ?? 0) > 0 ? 1 : 0
  const enable = part.pins.enable
  const enabled = !controlHigh(enable, states)
  const direction = part.pins.dir
  const forwards = controlHigh(direction, states)
  return { steps: previous.steps + (high && !previous.lastStep && enabled ? forwards ? 1 : -1 : 0), lastStep: high }
}

export function advanceActuator(part: SimPart, previous: ActuatorState, elapsedMs: number, states: Record<number, number>, pwm: Record<number, boolean>): ActuatorState {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('Actuator elapsed time must be a finite nonnegative number.')
  const travel = part.props?.travelMm ?? 100
  const speed = part.props?.speedMmPerSecond ?? 10
  const positionMm = Math.min(travel, Math.max(0, previous.positionMm + motorDrive(part, states, pwm) * speed * elapsedMs / 1000))
  return { positionMm, atMin: positionMm === 0, atMax: positionMm === travel }
}
