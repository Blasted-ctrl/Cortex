import { readFile } from 'node:fs/promises'
import type { FirmwareAssertion, FirmwareScenario } from '../../shared/firmwareTest'

function object(value: unknown, path: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}: expected an object`)
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) throw new Error(`${path}.${key}: unknown field`)
  }
  for (const key of keys) {
    if (!(key in record)) throw new Error(`${path}.${key}: required field`)
  }
  return record
}

function integer(value: unknown, path: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${path}: expected an integer from ${min} to ${max}`)
  }
  return value as number
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || value.includes('\0')) {
    throw new Error(`${path}: expected nonempty text (maximum 4096 characters)`)
  }
  return value
}

function array(value: unknown, path: string, max: number, nonempty = false): unknown[] {
  if (!Array.isArray(value) || value.length > max || (nonempty && !value.length)) {
    throw new Error(`${path}: expected ${nonempty ? 'a nonempty' : 'an'} array with at most ${max} entries`)
  }
  return value
}

export function validateScenario(value: unknown): FirmwareScenario {
  const s = object(value, 'scenario', ['version', 'id', 'description', 'firmware', 'seed', 'initialState', 'inputs', 'limits', 'assertions'])
  if (s.version !== 1) throw new Error('scenario.version: only version 1 is supported')
  text(s.id, 'scenario.id')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(s.id as string)) throw new Error('scenario.id: use 1-80 letters, digits, underscores or hyphens')
  text(s.description, 'scenario.description')
  const firmware = object(s.firmware, 'scenario.firmware', ['board', 'source'])
  if (firmware.board !== 'uno') throw new Error('scenario.firmware.board: only uno is supported')
  const source = text(firmware.source, 'scenario.firmware.source')
  if (!/\.ino$/i.test(source) || /^(\\\\|\/\/|[a-z]+:\/\/)/i.test(source)) {
    throw new Error('scenario.firmware.source: expected a local .ino sketch path')
  }
  integer(s.seed, 'scenario.seed', 0, 0xffffffff)
  const limits = object(s.limits, 'scenario.limits', ['durationMs', 'stepMs', 'wallTimeoutMs', 'maxEvents'])
  const duration = integer(limits.durationMs, 'scenario.limits.durationMs', 1, 3_600_000)
  integer(limits.stepMs, 'scenario.limits.stepMs', 1, duration)
  integer(limits.wallTimeoutMs, 'scenario.limits.wallTimeoutMs', 1, 120_000)
  integer(limits.maxEvents, 'scenario.limits.maxEvents', 1, 100_000)
  const initialPins = new Set<number>()
  for (const [i, entry] of array(s.initialState, 'scenario.initialState', 20).entries()) {
    const path = `scenario.initialState[${i}]`
    const input = object(entry, path, ['pin', 'value'])
    const pin = integer(input.pin, `${path}.pin`, 0, 19)
    integer(input.value, `${path}.value`, 0, 1023)
    if (initialPins.has(pin)) throw new Error(`${path}.pin: duplicate initial pin ${pin}`)
    initialPins.add(pin)
  }
  for (const [i, entry] of array(s.inputs, 'scenario.inputs', 10_000).entries()) {
    const path = `scenario.inputs[${i}]`
    const input = object(entry, path, ['atMs', 'pin', 'value'])
    integer(input.atMs, `${path}.atMs`, 0, duration)
    integer(input.pin, `${path}.pin`, 0, 19)
    integer(input.value, `${path}.value`, 0, 1023)
  }
  const ids = new Set<string>()
  for (const [i, entry] of array(s.assertions, 'scenario.assertions', 1000, true).entries()) {
    const path = `scenario.assertions[${i}]`
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${path}: expected an object`)
    const a = entry as Record<string, unknown>
    const id = text(a.id, `${path}.id`)
    if (ids.has(id)) throw new Error(`${path}.id: duplicate assertion id ${id}`)
    ids.add(id)
    if (a.kind === 'state') {
      object(a, path, ['id', 'kind', 'event', 'pin', 'value', 'atMs'])
      integer(a.atMs, `${path}.atMs`, 0, duration)
    } else if (a.kind === 'event' || a.kind === 'range' || a.kind === 'sequence') {
      const fields = a.kind === 'range' ? ['event', 'pin', 'min', 'max']
        : a.kind === 'sequence' ? ['texts']
          : a.event === 'serial' ? ['event', 'text'] : ['event', 'pin', 'value']
      object(a, path, ['id', 'kind', 'fromMs', 'toMs', ...fields])
      const start = integer(a.fromMs, `${path}.fromMs`, 0, duration)
      integer(a.toMs, `${path}.toMs`, start, duration)
    } else throw new Error(`${path}.kind: expected event, state, range or sequence`)
    if (a.kind === 'sequence') {
      for (const [n, t] of array(a.texts, `${path}.texts`, 1000, true).entries()) text(t, `${path}.texts[${n}]`)
    } else if (a.kind === 'event' && a.event === 'serial') {
      text(a.text, `${path}.text`)
    } else {
      const kinds = a.kind === 'event' ? ['pin', 'pwm', 'tone', 'mode'] : ['pin', 'pwm', 'tone']
      if (!kinds.includes(a.event as string)) throw new Error(`${path}.event: expected ${kinds.join(', ')}`)
      integer(a.pin, `${path}.pin`, 0, 19)
      const max = a.event === 'pin' ? 1 : a.event === 'mode' ? 2 : a.event === 'pwm' ? 255 : 1_000_000
      if (a.kind === 'range') {
        const min = integer(a.min, `${path}.min`, 0, max)
        integer(a.max, `${path}.max`, min, max)
      } else integer(a.value, `${path}.value`, 0, max)
    }
  }
  return structuredClone(s) as unknown as FirmwareScenario
}

export async function loadScenario(path: string): Promise<FirmwareScenario> {
  const content = await readFile(path, 'utf8')
  if (Buffer.byteLength(content) > 2_000_000) throw new Error(`${path}: scenario exceeds 2 MB`)
  try {
    return validateScenario(JSON.parse(content))
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function assertionWindow(a: FirmwareAssertion): { fromMs: number; toMs: number } {
  return a.kind === 'state' ? { fromMs: a.atMs, toMs: a.atMs } : a
}
