import { useRef, useState } from 'react'
import { useStore, type SimPart, INPUT_PARTS, PART_PINS } from '../store/useStore'
import { ADC_MAX, PWM_MAX } from '@shared/simProtocol'
import { motorDrive, connectedBoardPins, type SimTerminal } from '@shared/simCircuit'
import CircuitInspector from './CircuitInspector'
import { BOARDS } from './sim3d/board3d'
// Design space and board rect. Shared with the store, which places new parts
// relative to the board: two copies of these numbers is what let parts spawn
// on top of the pins.
import { W, H, BOARD, rotateOffset } from '@shared/simLayout'

interface PinPos {
  pin: number
  label: string
  x: number
  y: number
}

// Both headers sit at a board edge, as they do on real hardware, so their
// silkscreen labels point INWARD. Labelling outward ran A0-A5 straight through
// the bottom edge and left the D labels floating on the black header.
const HDR = { h: 18, top: BOARD.y + 5, bottom: BOARD.y + BOARD.h - 23 }
const PAD_TOP_Y = HDR.top + HDR.h / 2
const PAD_BOT_Y = HDR.bottom + HDR.h / 2

function buildPins(): PinPos[] {
  const pins: PinPos[] = []
  const topN = 14
  const topPad = 26
  const topSpan = BOARD.w - topPad * 2
  for (let i = 0; i < topN; i++) {
    pins.push({ pin: i, label: `D${i}`, x: BOARD.x + topPad + (topSpan * i) / (topN - 1), y: PAD_TOP_Y })
  }
  const anaN = 6
  const anaSpan = (BOARD.w - topPad * 2) * 0.55
  for (let i = 0; i < anaN; i++) {
    pins.push({ pin: 14 + i, label: `A${i}`, x: BOARD.x + topPad + (anaSpan * i) / (anaN - 1), y: PAD_BOT_Y })
  }
  ;[['GND', -1], ['5V', -2], ['3.3V', -3], ['VIN', -4]].forEach(([label, pin], i) => pins.push({ pin: Number(pin), label: String(label), x: BOARD.x + 260 + i * 34, y: PAD_BOT_Y }))
  return pins
}
const PINS = buildPins()

// Per-pin connector offsets (local part coords). Single-pin parts use 'sig'.
const CONNECTORS: Partial<Record<SimPart['type'], Record<string, { x: number; y: number }>>> = {
  rgb: { r: { x: -14, y: 28 }, g: { x: 0, y: 32 }, b: { x: 14, y: 28 } },
  sevenseg: {
    a: { x: -21, y: 40 },
    b: { x: -15, y: 40 },
    c: { x: -9, y: 40 },
    d: { x: -3, y: 40 },
    e: { x: 3, y: 40 },
    f: { x: 9, y: 40 },
    g: { x: 15, y: 40 },
    dp: { x: 21, y: 40 }
  }
}
const connFor = (type: SimPart['type'], name: string): { x: number; y: number } => {
  const names = PART_PINS[type]
  return CONNECTORS[type]?.[name] ?? { x: names.length > 1 ? (names.indexOf(name) - (names.length - 1) / 2) * 14 : 0, y: 34 }
}

const WIRE_COLOR: Record<string, string> = { r: '#E05561', g: '#6FB65A', b: '#5B9DF0' }

interface Reading {
  value: number
  pwm: boolean
}

function PartBody({
  part,
  read,
  onButton
}: {
  part: SimPart
  read: (name: string) => Reading
  onButton: (down: boolean) => void
}): JSX.Element {
  const sig = read('sig')
  const b = sig.pwm ? sig.value / PWM_MAX : sig.value > 0 ? 1 : 0
  switch (part.type) {
    case 'led': {
      const c = part.color || '#6FB65A'
      return (
        <>
          <line x1={0} y1={16} x2={0} y2={30} stroke="#7D8899" strokeWidth={2} />
          <circle cx={0} cy={0} r={15} fill={c} opacity={0.18 + b * 0.82} stroke={c} strokeWidth={1.5} style={{ filter: b > 0.05 ? `drop-shadow(0 0 ${5 + b * 16}px ${c})` : 'none' }} />
        </>
      )
    }
    case 'rgb': {
      const chan = (n: string): number => {
        const r = read(n)
        return r.pwm ? r.value : r.value > 0 ? 255 : 0
      }
      const r = chan('r')
      const g = chan('g')
      const bl = chan('b')
      const bright = Math.max(r, g, bl) / PWM_MAX
      const col = `rgb(${r},${g},${bl})`
      return (
        <circle cx={0} cy={0} r={16} fill={col} opacity={0.16 + bright * 0.84} stroke="#3A4557" strokeWidth={1.5} style={{ filter: bright > 0.05 ? `drop-shadow(0 0 ${5 + bright * 18}px ${col})` : 'none' }} />
      )
    }
    case 'button':
      return (
        // No stopPropagation: the parent part group needs the pointerdown to
        // select/drag this part, otherwise a button can never be moved, rotated,
        // deleted or wired.
        <g onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); onButton(true) }} onPointerUp={() => onButton(false)} onPointerCancel={() => onButton(false)} onLostPointerCapture={() => onButton(false)} style={{ cursor: 'pointer' }}>
          <rect x={-18} y={-18} width={36} height={36} rx={5} fill="#171D28" stroke="#3A4557" strokeWidth={1.5} />
          <circle cx={0} cy={0} r={10} fill={part.color ?? '#232B38'} stroke="#7D8899" />
        </g>
      )
    case 'buzzer':
      return (
        <>
          <circle cx={0} cy={0} r={16} fill="#11161F" stroke="#3A4557" strokeWidth={1.5} />
          <circle cx={0} cy={0} r={4} fill={sig.value ? '#E8B44A' : '#7D8899'} />
          {sig.value > 0 && (
            <g stroke="#E8B44A" fill="none" strokeWidth={1.5} opacity={0.8}>
              <path d="M 18 -8 Q 24 0 18 8" />
              <path d="M 22 -12 Q 31 0 22 12" />
            </g>
          )}
        </>
      )
    case 'resistor':
      return (
        <>
          <line x1={-24} y1={0} x2={-12} y2={0} stroke="#7D8899" strokeWidth={2} />
          <line x1={12} y1={0} x2={24} y2={0} stroke="#7D8899" strokeWidth={2} />
          <rect x={-12} y={-7} width={24} height={14} rx={3} fill="#C9A26B" />
          <rect x={-6} y={-7} width={2.5} height={14} fill="#8B4513" />
          <rect x={0} y={-7} width={2.5} height={14} fill="#E05561" />
          <rect x={5} y={-7} width={2.5} height={14} fill="#E8B44A" />
        </>
      )
    case 'potentiometer': {
      const angle = -135 + (Math.min(ADC_MAX, Math.max(0, sig.value)) / ADC_MAX) * 270
      return (
        <>
          <circle cx={0} cy={0} r={18} fill="#171D28" stroke="#3A4557" strokeWidth={1.5} />
          <line x1={0} y1={0} x2={0} y2={-14} stroke="#E8952B" strokeWidth={3} strokeLinecap="round" transform={`rotate(${angle})`} />
        </>
      )
    }
    case 'servo': {
      const angle = sig.pwm ? (sig.value / PWM_MAX) * 180 - 90 : 0
      return (
        <>
          <rect x={-20} y={-12} width={40} height={24} rx={3} fill="#2E6FE0" opacity={0.85} />
          <circle cx={0} cy={-12} r={5} fill="#11161F" />
          <line x1={0} y1={-12} x2={0} y2={-30} stroke="#E6EBF4" strokeWidth={3} strokeLinecap="round" transform={`rotate(${angle} 0 -12)`} />
        </>
      )
    }
    case 'motor':
    case 'stepper': {
      const angle = part.type === 'stepper' ? read('__steps').value / (part.props?.stepsPerRevolution ?? 200) * 360 : read('__drive').value * 180
      return <><rect x={-20} y={-20} width={40} height={40} rx={part.type === 'stepper' ? 3 : 12} fill="#39424f" stroke="#7D8899" /><circle r={7} fill="#9aa4b2" /><line x1={0} y1={0} x2={0} y2={-16} transform={`rotate(${angle})`} stroke="#E8952B" strokeWidth={3} /></>
    }
    case 'actuator': {
      const extension = Math.min(1, read('__position').value / (part.props?.travelMm ?? 100)) * 28
      return <><rect x={-9} y={-18} width={18} height={36} rx={3} fill="#39424f" stroke="#7D8899" /><rect x={-3} y={-28 - extension} width={6} height={20 + extension} fill="#9aa4b2" /><line x1={-10} y1={-28 - extension} x2={10} y2={-28 - extension} stroke="#E8952B" strokeWidth={3} /></>
    }
    case 'power':
      return <><rect x={-25} y={-20} width={50} height={40} rx={4} fill="#232b38" stroke="#7D8899" /><text x={0} y={0} textAnchor="middle" fill="#6FB65A" fontSize={10}>{part.props?.volts ?? 5} V</text><text x={-10} y={12} fill="#E05561" fontSize={10}>+</text><text x={10} y={12} fill="#7D8899" fontSize={10}>-</text></>
    case 'ldr': {
      const lit = Math.min(ADC_MAX, Math.max(0, sig.value)) / ADC_MAX
      return (
        <>
          <circle cx={0} cy={0} r={16} fill="#171D28" stroke="#3A4557" strokeWidth={1.5} />
          <path d="M -10 6 Q 0 -12 10 6 M -10 0 Q 0 -18 10 0" fill="none" stroke="#E8B44A" strokeWidth={1.5} opacity={0.4 + lit * 0.6} />
          <circle cx={0} cy={2} r={4} fill="#E8B44A" opacity={0.3 + lit * 0.7} />
        </>
      )
    }
    case 'thermistor': {
      const t = Math.min(ADC_MAX, Math.max(0, sig.value)) / ADC_MAX
      return (
        <>
          <rect x={-4} y={-16} width={8} height={22} rx={4} fill="#171D28" stroke="#3A4557" strokeWidth={1.5} />
          <circle cx={0} cy={10} r={7} fill="#171D28" stroke="#3A4557" strokeWidth={1.5} />
          <rect x={-2} y={-14 + (1 - t) * 18} width={4} height={14 + 10 * t} rx={2} fill="#E05561" opacity={0.5 + t * 0.5} />
          <circle cx={0} cy={10} r={4} fill="#E05561" />
        </>
      )
    }
    case 'sevenseg': {
      const on = (n: string): boolean => read(n).value > 0
      const seg = (n: string, x: number, y: number, horizontal: boolean): JSX.Element => {
        const w = horizontal ? 15 : 5
        const h = horizontal ? 5 : 15
        const lit = on(n)
        return (
          <rect
            x={x - w / 2}
            y={y - h / 2}
            width={w}
            height={h}
            rx={2.5}
            fill={lit ? '#FF4444' : '#2a1618'}
            opacity={lit ? 1 : 0.55}
            style={lit ? { filter: 'drop-shadow(0 0 4px #E05561)' } : undefined}
          />
        )
      }
      return (
        <>
          <rect x={-20} y={-30} width={40} height={60} rx={4} fill="#0d0d0d" stroke="#3A4557" strokeWidth={1.5} />
          {seg('a', 0, -21, true)}
          {seg('f', -10, -11, false)}
          {seg('b', 10, -11, false)}
          {seg('g', 0, 0, true)}
          {seg('e', -10, 11, false)}
          {seg('c', 10, 11, false)}
          {seg('d', 0, 21, true)}
          <circle cx={15} cy={22} r={2.5} fill={on('dp') ? '#FF4444' : '#2a1618'} opacity={on('dp') ? 1 : 0.55} />
        </>
      )
    }
    default:
      return <circle r={14} fill="#7D8899" />
  }
}

/**
 * The real part symbol, for the palette. Reuses PartBody so the button in the
 * toolbar is the exact thing that lands on the canvas (a lucide dash standing in
 * for a resistor reads as a toy).
 */
export function PartGlyph({ type, size = 20 }: { type: SimPart['type']; size?: number }): JSX.Element {
  const part: SimPart = {
    id: 'glyph',
    type,
    x: 0,
    y: 0,
    rotation: 0,
    color: type === 'led' ? '#6FB65A' : undefined,
    pins: {}
  }
  // Render each symbol in its "on" state so it reads at 20px.
  const read = (n: string): Reading =>
    type === 'rgb'
      ? { value: n === 'r' ? 230 : n === 'g' ? 90 : 200, pwm: true }
      : { value: 1, pwm: false }
  return (
    <svg width={size} height={size} viewBox="-26 -34 52 68" className="shrink-0">
      <PartBody part={part} read={read} onButton={() => {}} />
    </svg>
  )
}

export default function SimCanvas(): JSX.Element {
  const {
    simParts,
    simWires,
    sim3dBoard,
    simStepperStates,
    simActuatorStates,
    simPinStates,
    simPinPwm,
    simWiring,
    movePart,
    beginWire,
    attachWire,
    cancelWire,
    setPartButton,
    simInputs
  } = useStore()

  const svgRef = useRef<SVGSVGElement>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const def = BOARDS[sim3dBoard]
  const pins: PinPos[] = sim3dBoard === 'uno' ? PINS : def.pins.filter((p) => !p.inspectOnly).map((p) => ({ pin: p.pin, label: p.label, x: BOARD.x + BOARD.w / 2 + p.x / def.size.w * (BOARD.w - 30), y: BOARD.y + BOARD.h / 2 + p.z / def.size.d * (BOARD.h - 30) }))
  const position = (t: SimTerminal): { x: number; y: number } | undefined => {
    if (t.kind === 'board') return pins.find((p) => p.pin === t.pin)
    const part = simParts.find((p) => p.id === t.partId)
    if (!part) return undefined
    const off = rotateOffset(connFor(part.type, t.pin), part.rotation)
    return { x: part.x + off.x, y: part.y + off.y }
  }
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)

  // The SVG scales to fit its container (viewBox), so client pixels must be
  // mapped back through the current transform rather than a naive rect offset.
  const toSvg = (e: React.PointerEvent): { x: number; y: number } => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const ctm = svg.getScreenCTM()
    if (!ctm) {
      const rect = svg.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const p = pt.matrixTransform(ctm.inverse())
    return { x: p.x, y: p.y }
  }
  const onPartDown = (e: React.PointerEvent, part: SimPart): void => {
    e.stopPropagation()
    setSelected(part.id)
    const p = toSvg(e)
    drag.current = { id: part.id, dx: p.x - part.x, dy: p.y - part.y }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag.current) return
    const p = toSvg(e)
    movePart(drag.current.id, Math.round(p.x - drag.current.dx), Math.round(p.y - drag.current.dy))
  }

  const readFor = (part: SimPart) => (name: string): Reading => {
    if (name === '__drive') return { value: motorDrive(part, simPinStates, simPinPwm), pwm: false }
    if (name === '__steps') return { value: simStepperStates[part.id]?.steps ?? 0, pwm: false }
    if (name === '__position') return { value: simActuatorStates[part.id]?.positionMm ?? 0, pwm: false }
    const bp = name === 'sig' && (INPUT_PARTS.includes(part.type) || part.type === 'button') ? connectedBoardPins(simParts, simWires, { kind: 'part', partId: part.id, pin: name })[0] : part.pins[name]
    if (bp === null || bp === undefined) return { value: 0, pwm: false }
    if (INPUT_PARTS.includes(part.type)) return { value: simInputs[bp] ?? 0, pwm: false }
    return { value: simPinStates[bp] ?? 0, pwm: simPinPwm[bp] ?? false }
  }

  const wiring = !!simWiring

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#080b11]">
      <CircuitInspector selectedId={selected} onSelect={setSelected} />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onClick={() => {
          setSelected(null)
          if (wiring) cancelWire()
        }}
        className="block h-full w-full"
      >
        <defs>
          <pattern id="grid" width={24} height={24} patternUnits="userSpaceOnUse">
            <path d="M 24 0 L 0 0 0 24" fill="none" stroke="#111722" strokeWidth={1} />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#grid)" />

        {/* board: real Uno vocabulary, not a green rectangle. The black 0.1in
            female header strips are the actual visual signature of an Arduino;
            without them the pins read as loose circles floating on a slab. */}
        <g>
          <rect x={BOARD.x} y={BOARD.y} width={BOARD.w} height={BOARD.h} rx={10} fill="#0b3d2e" stroke="#12603f" strokeWidth={2} />

          {sim3dBoard === 'uno' && <g>

          {/* header strips behind the pin rows, flush with the board edges */}
          <rect x={BOARD.x + 14} y={HDR.top} width={BOARD.w - 28} height={HDR.h} rx={3} fill="#0a0c10" stroke="#1c2430" />
          <rect x={BOARD.x + 14} y={HDR.bottom} width={BOARD.w * 0.62} height={HDR.h} rx={3} fill="#0a0c10" stroke="#1c2430" />

          {/* USB-B jack and barrel jack on the left edge */}
          <rect x={BOARD.x - 14} y={BOARD.y + 46} width={28} height={26} rx={2} fill="#9aa4b2" stroke="#6d7684" />
          <rect x={BOARD.x - 10} y={BOARD.y + 50} width={20} height={18} rx={1} fill="#7d8899" />
          <rect x={BOARD.x - 12} y={BOARD.y + 116} width={26} height={22} rx={4} fill="#0a0c10" stroke="#1c2430" />

          {/* ATmega328P + crystal */}
          <rect x={BOARD.x + BOARD.w * 0.42} y={BOARD.y + BOARD.h * 0.52} width={104} height={30} rx={2} fill="#12161c" stroke="#242c38" />
          <circle cx={BOARD.x + BOARD.w * 0.42 + 8} cy={BOARD.y + BOARD.h * 0.52 + 15} r={3} fill="#2a3340" />
          <text x={BOARD.x + BOARD.w * 0.42 + 52} y={BOARD.y + BOARD.h * 0.52 + 19} fill="#5b6675" fontSize={7} textAnchor="middle">ATMEGA328P</text>
          <rect x={BOARD.x + BOARD.w * 0.30} y={BOARD.y + BOARD.h * 0.55} width={22} height={11} rx={5} fill="#8a9099" />

          {/* reset button, clear of the D-pin silkscreen row above it */}
          <rect x={BOARD.x + 22} y={BOARD.y + 50} width={16} height={16} rx={2} fill="#7a2f38" stroke="#a04049" />

          {/* onboard 'L' LED really is wired to D13, so mirror it */}
          <circle
            cx={BOARD.x + BOARD.w - 40}
            cy={BOARD.y + BOARD.h * 0.42}
            r={4}
            fill="#E8B44A"
            opacity={(simPinStates[13] ?? 0) > 0 ? 1 : 0.2}
            style={(simPinStates[13] ?? 0) > 0 ? { filter: 'drop-shadow(0 0 5px #E8B44A)' } : undefined}
          />
          <text x={BOARD.x + BOARD.w - 32} y={BOARD.y + BOARD.h * 0.42 + 3} fill="#5b6675" fontSize={7}>L</text>
          </g>}

          {/* Silkscreen is white ink on real hardware. Bright green read as a
              highlighted UI label rather than something printed on the board. */}
          <text x={BOARD.x + 22} y={BOARD.y + 90} fill="#dfe5ec" opacity={0.45} fontSize={11} fontWeight={600} letterSpacing={0.5}>
            {def.name}
          </text>

          {pins.map((p, i) => (
            <g key={`${p.pin}-${i}`} onClick={(e) => { e.stopPropagation(); if (wiring) attachWire(p.pin) }} style={{ cursor: wiring ? 'crosshair' : 'default' }}>
              <title>{p.label}: {def.pins.find((q) => q.pin === p.pin)?.functions?.join(', ') || 'Board terminal'}</title>
              {/* square pad inside the header, like a real socket */}
              <rect
                x={p.x - 4}
                y={p.y - 4}
                width={8}
                height={8}
                rx={1}
                fill={(simPinStates[p.pin] ?? 0) > 0 ? '#6FB65A' : '#05070a'}
                stroke={wiring ? '#E8952B' : '#3a4557'}
                strokeWidth={wiring ? 1.5 : 1}
                className={wiring ? 'animate-pulse' : ''}
              />
              {/* Silkscreen points inward, away from the board edge the header sits on. */}
              <text x={p.x} y={p.y + (p.y < BOARD.y + BOARD.h / 2 ? 18 : -16)} fill="#7D8899" fontSize={7} textAnchor="middle">
                {p.label}
              </text>
            </g>
          ))}
        </g>

        {/* wires */}
        {simWires.map((wire) => {
          const a = position(wire.from), b = position(wire.to)
          if (!a || !b) return null
          const midY = (a.y + b.y) / 2
          return <path key={wire.id} d={`M ${a.x} ${a.y} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y}`} fill="none" stroke={wire.color ?? '#E8952B'} strokeWidth={2.5} strokeLinecap="round" strokeDasharray={wire.kind === 'alligator' ? '6 3' : undefined} opacity={0.85}><title>{wire.kind} jumper</title></path>
        })}

        {/* parts */}
        {simParts.map((part) => {
          const read = readFor(part)
          return (
            <g key={part.id} transform={`translate(${part.x} ${part.y})`} onPointerDown={(e) => onPartDown(e, part)} onClick={(e) => e.stopPropagation()} style={{ cursor: 'grab' }}>
              {selected === part.id && <circle r={32} fill="none" stroke="#2E6FE0" strokeWidth={1.5} strokeDasharray="4 3" />}
              <g transform={`rotate(${part.rotation})`}>
                {/* ADC scale, like every other @in producer. Sending a bare 1
                    for HIGH was indistinguishable from a pot sitting at ~0V in
                    the same slot, which is why the shim could not threshold. */}
                <PartBody
                  part={part}
                  read={read}
                  onButton={(down) => setPartButton(part.id, down)}
                />
              </g>
              {PART_PINS[part.type].map((name) => {
                // Same helper as the wire endpoint above, so the dot the user
                // clicks and the wire that lands on it can never disagree.
                const off = rotateOffset(connFor(part.type, name), part.rotation)
                const bound = part.pins[name] != null
                const armed = simWiring?.partId === part.id && simWiring.pinName === name
                return (
                  <g key={name}>
                    <circle cx={off.x} cy={off.y} r={4} fill={bound ? '#6FB65A' : armed ? '#E8952B' : '#232B38'} stroke="#7D8899" onPointerDown={(e) => { e.stopPropagation(); setSelected(part.id); beginWire(part.id, name) }} style={{ cursor: 'crosshair' }} />
                    {PART_PINS[part.type].length > 1 && <text x={off.x} y={off.y + 12} fill="#7D8899" fontSize={7} textAnchor="middle">{name}</text>}
                  </g>
                )
              })}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
