/**
 * 3D board registry for the simulator.
 *
 * World units are the 2D design pixels (see shared/simLayout), and every board
 * is centred at the world origin. A part's design (x, y) maps to world (x, z)
 * by subtracting the board centre, so the 2D canvas and the 3D Uno stay
 * spatially in sync and both wire by the same board pin number.
 *
 * Pin labels follow board references; geometry is deliberately stylized.
 * Board selection changes inspection and topology checks, not the CPU runtime.
 * Only the Uno host-shim workflow is supported for firmware execution.
 */

import type { SimBoardId } from '@shared/simCircuit'

export type PinKind = 'gpio' | 'analog' | 'power' | 'gnd'

export interface Pin3D {
  /** Signal GPIO number; negative IDs represent shared power/GND rails. */
  pin: number
  label: string
  x: number
  z: number
  kind: PinKind
  functions?: string[]
  face?: 'top' | 'bottom'
  /** Non-GPIO control pads can be inspected but not wired into the signal graph. */
  inspectOnly?: boolean
}

export interface Feature {
  kind: 'box' | 'cyl'
  pos: [number, number, number]
  /** box: [w, h, d]; cyl: [radius, height, radialSegments] */
  size: [number, number, number]
  color: string
  metal?: number
  rough?: number
}

export interface BoardDef {
  id: SimBoardId
  name: string
  size: { w: number; d: number; h: number }
  pcb: string
  pins: Pin3D[]
  features: Feature[]
  /** Silkscreen wordmark position. */
  labelPos: [number, number, number]
  /** An onboard LED that mirrors this pin (Uno's "L" on D13). */
  ledPin?: number
  ledPos?: [number, number, number]
  /** Initial camera position that frames this board. */
  camera: [number, number, number]
  notes: string[]
  source?: string
}

/** Where the 2D design space centres the Uno; used to map parts for every board. */
export const DESIGN_CENTER = { x: 330, y: 347.5 } as const

/** design (x, y) -> world (x, z). */
export function toWorld(x: number, y: number): [number, number] {
  return [x - DESIGN_CENTER.x, y - DESIGN_CENTER.y]
}

/** A wire lands on a pin tip; a part's wire leaves from here. */
export const pinTopY = (def: BoardDef): number => def.size.h + 6
export const PART_TOP_Y = 12

/** Frame the board and placed parts, with room for connector labels. */
export function frameWorkbench(def: BoardDef, parts: readonly { x: number; y: number }[], aspect: number): { target: [number, number, number]; distance: number; far: number } {
  const xs = [-def.size.w / 2, def.size.w / 2]
  const zs = [-def.size.d / 2, def.size.d / 2]
  for (const part of parts) {
    const [x, z] = toWorld(part.x, part.y)
    xs.push(x * def.size.w / 400)
    zs.push(z * def.size.d / 195)
  }
  const minX = Math.min(...xs) - 40, maxX = Math.max(...xs) + 40
  const minZ = Math.min(...zs) - 40, maxZ = Math.max(...zs) + 40
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const distance = Math.max(maxZ - minZ, (maxX - minX) / safeAspect) / (2 * Math.tan(19 * Math.PI / 180)) * 1.12
  // Reframing a tall board or scattered parts can move beyond Three's default
  // far plane. Include the allowed orbit distance and the whole workbench.
  return { target: [(minX + maxX) / 2, 0, (minZ + maxZ) / 2], distance, far: Math.max(4000, distance * 6) }
}

const kindOf = (label: string, gpio: number): PinKind => {
  if (/^(3V3|3.3V|5V|VIN|VCC)$/.test(label)) return 'power'
  if (label === 'GND') return 'gnd'
  if (/^A\d/.test(label)) return 'analog'
  return gpio >= 0 ? 'gpio' : 'power' // EN/RESET fall here
}

// ---- Arduino Uno --------------------------------------------------------

const UNO = { w: 400, d: 195, h: 8 }

function unoPins(): Pin3D[] {
  const pins: Pin3D[] = []
  const margin = 22
  const usableW = UNO.w - margin * 2
  const left = -UNO.w / 2 + margin
  const zBack = -UNO.d / 2 + 16
  const zFront = UNO.d / 2 - 16
  for (let i = 0; i < 14; i++) {
    const functions = ['Digital I/O', ...(i === 0 ? ['RX'] : i === 1 ? ['TX'] : []),
      ...([3, 5, 6, 9, 10, 11].includes(i) ? ['PWM'] : []),
      ...(i === 10 ? ['SS'] : i === 11 ? ['MOSI'] : i === 12 ? ['MISO'] : i === 13 ? ['SCK', 'LED'] : [])]
    pins.push({ pin: i, label: `D${i}`, x: left + (usableW * i) / 13, z: zBack, kind: 'gpio', functions })
  }
  const analogW = usableW * 0.6
  for (let i = 0; i < 6; i++) {
    pins.push({ pin: 14 + i, label: `A${i}`, x: left + (analogW * i) / 5, z: zFront, kind: 'analog', functions: ['Analog input', ...(i === 4 ? ['SDA'] : i === 5 ? ['SCL'] : [])] })
  }
  ;[['GND', -1], ['5V', -2], ['3.3V', -3], ['VIN', -4]].forEach(([label, pin], i) => {
    pins.push({ pin: Number(pin), label: String(label), x: 66 + i * 28, z: zFront, kind: label === 'GND' ? 'gnd' : 'power' })
  })
  return pins
}

const unoBoard: BoardDef = {
  id: 'uno',
  name: 'ARDUINO UNO',
  size: UNO,
  pcb: '#11734d',
  pins: unoPins(),
  labelPos: [-UNO.w / 2 + 44, UNO.h + 0.5, 40],
  ledPin: 13,
  ledPos: [UNO.w / 2 - 46, UNO.h + 2, -6],
  camera: [60, 300, 360],
  notes: ['Uno signal runtime. Board geometry is an inspection model, not a manufacturing drawing.', 'GPIO logic level: 5 V. Use a driver for motors and a current-limiting resistor for LEDs.'],
  source: 'https://docs.arduino.cc/hardware/uno-rev3/',
  features: [
    { kind: 'box', pos: [0, UNO.h + 1, -UNO.d / 2 + 16], size: [UNO.w * 0.86, 4, 9], color: '#0a0c10', rough: 0.8 },
    {
      kind: 'box',
      pos: [-UNO.w / 2 + 22 + (UNO.w - 44) * 0.3, UNO.h + 1, UNO.d / 2 - 16],
      size: [(UNO.w - 44) * 0.62, 4, 9],
      color: '#0a0c10',
      rough: 0.8
    },
    { kind: 'box', pos: [-UNO.w / 2 - 6, 9, -30], size: [28, 14, 32], color: '#9aa4b2', metal: 0.85, rough: 0.35 },
    { kind: 'box', pos: [-UNO.w / 2 - 4, 8, 45], size: [24, 15, 22], color: '#0a0c10', rough: 0.6 },
    { kind: 'box', pos: [36, UNO.h + 3, 12], size: [74, 6, 30], color: '#14181f', rough: 0.7 }
  ]
}

// ---- ESP32 DevKit (38-pin) ----------------------------------------------

const ESP = { w: 150, d: 330, h: 7 }

const ESP_LEFT = [
  '3V3', 'EN', 'IO36', 'IO39', 'IO34', 'IO35', 'IO32', 'IO33', 'IO25', 'IO26',
  'IO27', 'IO14', 'IO12', 'GND', 'IO13', 'IO9', 'IO10', 'IO11', 'VIN'
]
const ESP_RIGHT = [
  'GND', 'IO6', 'IO7', 'IO8', 'IO15', 'IO2', 'IO0', 'IO4', 'IO16', 'IO17',
  'IO5', 'IO18', 'IO19', 'GND', 'IO21', 'RX0', 'TX0', 'IO22', 'IO23'
]

function espGpio(label: string): number {
  if (label === 'GND') return -1
  if (label === '3V3') return -3
  if (label === 'VIN') return -4
  const m = label.match(/^IO(\d+)$/)
  if (m) return Number(m[1])
  if (label === 'RX0') return 3
  if (label === 'TX0') return 1
  return -1
}

function espColumn(labels: string[], x: number): Pin3D[] {
  const margin = 20
  const usable = ESP.d - margin * 2
  const top = -ESP.d / 2 + margin
  return labels.map((label, i) => {
    const gpio = espGpio(label)
    return { pin: gpio, label, x, z: top + (usable * i) / (labels.length - 1), kind: kindOf(label, gpio), inspectOnly: label === 'EN', functions: /^IO(34|35|36|39)$/.test(label) ? ['Input only'] : /^IO(6|7|8|9|10|11)$/.test(label) ? ['Reserved for flash; avoid external use'] : [] }
  })
}

const espBoard: BoardDef = {
  id: 'esp32',
  name: 'ESP32',
  size: ESP,
  pcb: '#13171e',
  pins: [...espColumn(ESP_LEFT, -ESP.w / 2 + 16), ...espColumn(ESP_RIGHT, ESP.w / 2 - 16)],
  labelPos: [0, ESP.h + 0.5, 96],
  camera: [70, 350, 400],
  notes: ['Inspection model only: Cortex does not emulate ESP32, WiFi, or Bluetooth.', 'GPIO logic level: 3.3 V. Some pins are input-only, boot-strapping, or connected to flash.'],
  source: 'https://docs.espressif.com/projects/esp-idf/en/stable/esp32/hw-reference/esp32/get-started-devkitc.html',
  features: [
    // ESP-WROOM-32 shield can
    { kind: 'box', pos: [0, ESP.h + 5, -ESP.d / 2 + 58], size: [118, 9, 78], color: '#c9ccd1', metal: 0.9, rough: 0.3 },
    // micro-USB
    { kind: 'box', pos: [0, 8, ESP.d / 2 - 4], size: [40, 10, 22], color: '#c9ccd1', metal: 0.85, rough: 0.35 },
    // EN + BOOT buttons
    { kind: 'box', pos: [-40, ESP.h + 2, ESP.d / 2 - 40], size: [16, 6, 12], color: '#1b2230', rough: 0.6 },
    { kind: 'box', pos: [40, ESP.h + 2, ESP.d / 2 - 40], size: [16, 6, 12], color: '#1b2230', rough: 0.6 }
  ]
}

// ---- Raspberry Pi 4 (40-pin) --------------------------------------------

const PI = { w: 480, d: 320, h: 8 }

const PI_ODD = [
  '3V3', 'GPIO2', 'GPIO3', 'GPIO4', 'GND', 'GPIO17', 'GPIO27', 'GPIO22', '3V3', 'GPIO10',
  'GPIO9', 'GPIO11', 'GND', 'GPIO0', 'GPIO5', 'GPIO6', 'GPIO13', 'GPIO19', 'GPIO26', 'GND'
]
const PI_EVEN = [
  '5V', '5V', 'GND', 'GPIO14', 'GPIO15', 'GPIO18', 'GND', 'GPIO23', 'GPIO24', 'GND',
  'GPIO25', 'GPIO8', 'GPIO7', 'GPIO1', 'GND', 'GPIO12', 'GND', 'GPIO16', 'GPIO20', 'GPIO21'
]

function piGpio(label: string): number {
  if (label === 'GND') return -1
  if (label === '3V3') return -3
  if (label === '5V') return -2
  const m = label.match(/^GPIO(\d+)$/)
  return m ? Number(m[1]) : -1
}

function piRow(labels: string[], z: number): Pin3D[] {
  const margin = 40
  const usable = PI.w - margin * 2
  const left = -PI.w / 2 + margin
  return labels.map((label, i) => {
    const gpio = piGpio(label)
    return { pin: gpio, label, x: left + (usable * i) / (labels.length - 1), z, kind: kindOf(label, gpio) }
  })
}

const piBoard: BoardDef = {
  id: 'pi',
  name: 'RASPBERRY PI',
  size: PI,
  pcb: '#13603f',
  // Physical pin 1 at the left corner; odd row nearer the edge, even row inboard.
  pins: [...piRow(PI_ODD, -PI.d / 2 + 26), ...piRow(PI_EVEN, -PI.d / 2 + 48)],
  labelPos: [-40, PI.h + 0.5, 70],
  camera: [90, 420, 500],
  notes: ['Inspection model only: Cortex does not emulate the Raspberry Pi CPU or Linux.', 'GPIO logic level: 3.3 V; never connect a 5 V supply to GPIO. Labels use BCM numbering.'],
  source: 'https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#gpio',
  features: [
    // BCM2711 SoC
    { kind: 'box', pos: [-20, PI.h + 5, 20], size: [82, 10, 82], color: '#1a1f27', metal: 0.3, rough: 0.5 },
    // USB 3.0 + 2.0 stacks on the right edge
    { kind: 'box', pos: [PI.w / 2 - 8, 13, -30], size: [62, 26, 44], color: '#2a4d8f', metal: 0.5, rough: 0.4 },
    { kind: 'box', pos: [PI.w / 2 - 8, 13, 40], size: [62, 26, 44], color: '#1b1f27', metal: 0.6, rough: 0.4 },
    // Ethernet
    { kind: 'box', pos: [PI.w / 2 - 8, 15, 110], size: [58, 30, 46], color: '#9aa4b2', metal: 0.85, rough: 0.3 },
    // USB-C power + micro-HDMI on the front long edge
    { kind: 'box', pos: [-150, 8, PI.d / 2 - 4], size: [22, 10, 18], color: '#c9ccd1', metal: 0.8, rough: 0.35 },
    { kind: 'box', pos: [-100, 8, PI.d / 2 - 4], size: [22, 10, 18], color: '#1b2230', rough: 0.5 },
    { kind: 'box', pos: [-58, 8, PI.d / 2 - 4], size: [22, 10, 18], color: '#1b2230', rough: 0.5 }
  ]
}

// Teensy 4.1: PJRC front/back reference card. The 42 edge pins and seven bottom
// pads are shown. SD, Ethernet, USB and QSPI connector geometries are not emulated.
const TEENSY = { w: 130, d: 380, h: 6 }
const teensyAnalog: Record<number, string> = Object.fromEntries([
  ...Array.from({ length: 10 }, (_, i) => [14 + i, `A${i}`]),
  ...Array.from({ length: 4 }, (_, i) => [24 + i, `A${10 + i}`]),
  ...Array.from({ length: 4 }, (_, i) => [38 + i, `A${14 + i}`])
])
function teensyPins(): Pin3D[] {
  const left = ['GND', ...Array.from({ length: 13 }, (_, i) => String(i)), '3.3V', ...Array.from({ length: 9 }, (_, i) => String(24 + i))]
  const right = ['VIN', 'GND', '3.3V', ...Array.from({ length: 11 }, (_, i) => String(23 - i)), 'GND', ...Array.from({ length: 9 }, (_, i) => String(41 - i))]
  const pwm = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18, 19, 22, 23, 24, 25, 28, 29, 33, 36, 37, 42, 43, 44, 45, 46, 47])
  const serial: Record<number, string> = { 0: 'RX1', 1: 'TX1', 7: 'RX2', 8: 'TX2', 14: 'TX3', 15: 'RX3', 16: 'RX4', 17: 'TX4', 20: 'TX5', 21: 'RX5', 24: 'TX6', 25: 'RX6', 28: 'RX7', 29: 'TX7', 34: 'RX8', 35: 'TX8' }
  const comm: Record<number, string> = { 10: 'CS', 11: 'MOSI', 12: 'MISO', 13: 'SCK', 18: 'SDA', 19: 'SCL', 16: 'SCL1', 17: 'SDA1', 24: 'SCL2', 25: 'SDA2' }
  const make = (label: string, x: number, z: number, face: 'top' | 'bottom' = 'top'): Pin3D => {
    const n = /^\d+$/.test(label) ? Number(label) : label === 'GND' ? -1 : label === '3.3V' ? -3 : -4
    return { pin: n, label, x, z, face, kind: kindOf(label, n), functions: n < 0 ? [label === 'GND' ? 'Ground reference' : label === 'VIN' ? '3.6 to 5.5 V input; USB backfeed risk' : '3.3 V rail; 250 mA maximum external draw'] : ['Digital I/O', 'Interrupt', ...(face === 'bottom' ? ['QSPI memory pad; shared with memory expansion'] : []), ...(teensyAnalog[n] ? [teensyAnalog[n]] : []), ...(pwm.has(n) || n === 51 || n === 54 ? ['PWM'] : []), ...(serial[n] ? [serial[n]] : []), ...(comm[n] ? [comm[n]] : [])] }
  }
  return [...left.map((l, i) => make(l, -50, -170 + i * 340 / 23)), ...right.map((l, i) => make(l, 50, -170 + i * 340 / 23)), ...Array.from({ length: 7 }, (_, i) => make(String(48 + i), -30 + (i % 3) * 30, 40 + Math.floor(i / 3) * 24, 'bottom'))]
}
const teensyBoard: BoardDef = {
  id: 'teensy41', name: 'TEENSY 4.1', size: TEENSY, pcb: '#146947', pins: teensyPins(),
  labelPos: [0, 7, 100], camera: [100, 340, 420], ledPin: 13, ledPos: [24, 8, -85],
  notes: ['Inspection model only: Cortex uses the Uno signal runtime, not the Teensy CPU or Teensyduino.', '3.3 V GPIO only; not 5 V tolerant. VIN accepts 3.6 to 5.5 V. Avoid USB/VIN backfeeding.', 'Underside GPIO pads 48-54 share the QSPI memory interface. SD-socket pins 42-47 and USB/Ethernet connectors are not modeled. Pad placement is illustrative.'],
  source: 'https://www.pjrc.com/store/teensy41.html',
  features: [
    { kind: 'box', pos: [0, 12, -182], size: [45, 12, 30], color: '#9aa4b2', metal: 0.8 },
    { kind: 'box', pos: [0, 11, -65], size: [58, 10, 58], color: '#14181f' },
    { kind: 'box', pos: [0, 9, 138], size: [80, 6, 60], color: '#9aa4b2', metal: 0.7 },
    { kind: 'box', pos: [0, -3, -40], size: [36, 6, 28], color: '#14181f' }
  ]
}

export const BOARDS: Record<SimBoardId, BoardDef> = {
  uno: unoBoard,
  esp32: espBoard,
  pi: piBoard,
  teensy41: teensyBoard
}
