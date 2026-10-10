import { decodeSimDiagram, PART_PINS, type SimDiagram, type SimPart, type SimPartType, type SimTerminal } from './simCircuit'
import { freeSpawnPoint } from './simLayout'

// The documented exchange format, not the proprietary Wokwi simulation engine.
const TYPES: Partial<Record<SimPartType, string>> = { led: 'wokwi-led', button: 'wokwi-pushbutton', potentiometer: 'wokwi-potentiometer', buzzer: 'wokwi-buzzer' }
const TERMINALS: Partial<Record<SimPartType, Record<string, string>>> = { led: { A: 'sig', C: 'gnd' }, button: { '1.l': 'sig', '1.r': 'sig', '2.l': 'gnd', '2.r': 'gnd' }, potentiometer: { SIG: 'sig', VCC: 'vcc', GND: 'gnd' }, buzzer: { '1': 'gnd', '2': 'sig' } }
const COLORS: Record<string, string> = { red: '#ff0000', green: '#00ff00', blue: '#0000ff', black: '#000000', white: '#ffffff', orange: '#ff8800', yellow: '#ffff00', purple: '#800080', gray: '#808080' }
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
function color(x: unknown): string {
  if (typeof x !== 'string') throw new Error('Wire and LED colors must be strings.')
  const normalized = COLORS[x.toLowerCase()] ?? x
  if (!/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(normalized)) throw new Error(`Unsupported Wokwi color: ${x}`)
  return normalized
}
function boardPin(x: string): number {
  if (/^\d+$/.test(x) && Number(x) <= 13) return Number(x)
  if (/^A[0-5]$/.test(x)) return 14 + Number(x.slice(1))
  if (/^GND(?:\.[123])?$/.test(x)) return -1
  if (x === '5V') return -2
  if (x === 'VIN') return -4
  throw new Error(`Unsupported Uno terminal: ${x}`)
}
export function importWokwiDiagram(raw: unknown): SimDiagram {
  if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.parts) || !Array.isArray(raw.connections)) throw new Error('Expected a Wokwi diagram.json version 1 with parts and connections.')
  if (raw.parts.length > 257 || raw.connections.length > 2048) throw new Error('Wokwi diagram exceeds Cortex circuit limits.')
  const ids = new Set<string>()
  let boardId: string | undefined
  const parts: SimPart[] = []
  for (const entry of raw.parts) {
    if (!record(entry) || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.id) || ids.has(entry.id)) throw new Error('Invalid or duplicate Wokwi part identifier.')
    ids.add(entry.id)
    if (entry.attrs !== undefined && !record(entry.attrs)) throw new Error(`Invalid attributes for ${entry.id}.`)
    const attrs = entry.attrs ?? {}
    if (entry.type === 'wokwi-arduino-uno') {
      if (boardId) throw new Error('Only one Arduino Uno is supported for circuit exchange.')
      if (Object.keys(attrs).length) throw new Error('Custom Uno attributes (including frequency) are not modeled. Import cancelled.')
      boardId = entry.id
      continue
    }
    const type = (Object.keys(TYPES) as SimPartType[]).find((t) => TYPES[t] === entry.type)
    if (!type) throw new Error(`Unsupported Wokwi part: ${String(entry.type)} (${entry.id}). Import cancelled; nothing was dropped.`)
    const accepted = type === 'led' ? ['color'] : type === 'button' ? ['color', 'bounce'] : []
    for (const key of Object.keys(attrs)) if (!accepted.includes(key)) throw new Error(`Unsupported Wokwi attribute ${entry.id}.${key}.`)
    if (type === 'button' && attrs.bounce !== '0') throw new Error('Button bounce is not modeled. Set bounce to "0" before importing.')
    if (entry.rotate !== undefined && (typeof entry.rotate !== 'number' || !Number.isFinite(entry.rotate))) throw new Error(`Invalid rotation for ${entry.id}.`)
    // Wokwi coordinates use a different board scale. Preserve wiring and use
    // Cortex's bounded placement rather than claim geometrical equivalence.
    parts.push({ id: entry.id, type, ...freeSpawnPoint(parts), rotation: Number(entry.rotate ?? 0), pins: Object.fromEntries(PART_PINS[type].map((p) => [p, null])), ...(attrs.color !== undefined ? { color: color(attrs.color) } : {}) })
  }
  if (!boardId) throw new Error('This exchange supports an Arduino Uno diagram only.')
  const endpoint = (value: unknown): SimTerminal => {
    if (typeof value !== 'string') throw new Error('Invalid Wokwi connection endpoint.')
    const index = value.indexOf(':')
    if (index < 1) throw new Error(`Invalid endpoint: ${value}`)
    const id = value.slice(0, index), terminal = value.slice(index + 1)
    if (id === boardId) return { kind: 'board', pin: boardPin(terminal) }
    const part = parts.find((p) => p.id === id)
    const pin = part && TERMINALS[part.type]?.[terminal]
    if (!part || !pin) throw new Error(`Unsupported Wokwi terminal: ${value}.`)
    return { kind: 'part', partId: id, pin }
  }
  const wires = raw.connections.map((entry, i) => {
    if (!Array.isArray(entry) || entry.length < 3 || entry.length > 4 || (entry[3] !== undefined && !Array.isArray(entry[3]))) throw new Error('Invalid Wokwi connection.')
    const from = endpoint(entry[0]), to = endpoint(entry[1])
    if (JSON.stringify(from) === JSON.stringify(to)) throw new Error('Connections across equivalent button contacts are unsupported; remove the redundant wire.')
    return { id: `wokwi-wire-${i}`, from, to, kind: 'male-male' as const, color: color(entry[2]) }
  })
  return decodeSimDiagram({ version: 3, board: 'uno', parts, wires })
}
export function exportWokwiDiagram(diagram: SimDiagram): Record<string, unknown> {
  const data = decodeSimDiagram(diagram)
  if (data.board !== 'uno') throw new Error('Only the Uno circuit subset can be exported to Wokwi.')
  let boardId = 'cortexUno'
  let suffix = 0
  while (data.parts.some((p) => p.id === boardId)) boardId = `cortexUno_${++suffix}`
  const endpoint = (t: SimTerminal): string => {
    if (t.kind === 'board') {
      const pin = t.pin
      const label = pin === -1 ? 'GND.1' : pin === -2 ? '5V' : pin === -4 ? 'VIN' : pin >= 0 && pin <= 13 ? String(pin) : pin >= 14 && pin <= 19 ? `A${pin - 14}` : null
      if (!label) throw new Error(`Unsupported Uno pin for Wokwi export: ${pin}`)
      return `${boardId}:${label}`
    }
    const part = data.parts.find((p) => p.id === t.partId)
    const terminal = part && Object.entries(TERMINALS[part.type] ?? {}).find(([, pin]) => pin === t.pin)?.[0]
    if (!terminal) throw new Error(`Unsupported Wokwi terminal ${t.partId}.${t.pin}.`)
    return `${t.partId}:${terminal}`
  }
  return { version: 1, author: 'Cortex', editor: 'wokwi', parts: [{ type: 'wokwi-arduino-uno', id: boardId, top: 250, left: 130, attrs: {} }, ...data.parts.map((p) => {
    if (!TYPES[p.type]) throw new Error(`Wokwi export does not support ${p.type}. Nothing was exported.`)
    return { type: TYPES[p.type], id: p.id, top: p.y, left: p.x, rotate: p.rotation, attrs: p.type === 'led' ? { color: p.color ?? '#6fb65a' } : p.type === 'button' ? { bounce: '0', ...(p.color ? { color: p.color } : {}) } : {} }
  })], connections: data.wires.map((w) => [endpoint(w.from), endpoint(w.to), w.color ?? '#e8952b', []]) }
}
