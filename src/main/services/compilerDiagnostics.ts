import { isAbsolute, resolve } from 'path'
import type { Diagnostic, DiagnosticCapture } from '../../shared/ipc'
import { parseDiagnostics, parseRustJsonDiagnostics, parseCargoDiagnostics } from '../../shared/diagnostics'

const MAX_DIAGNOSTICS = 500

// Selected from repeated owned-child workloads and genuine compiler controls.
// The array budget includes normalized paths and JSON overhead, not the IPC envelope.
export const COMPILER_DIAGNOSTIC_LIMITS = {
  maxRecordBytes: 1024 * 1024,
  maxDiagnosticsBytes: 1024 * 1024
} as const

function checkLimit(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error('Invalid compiler diagnostic byte limit')
}

function saturatingAdd(value: number, increment: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + increment)
}

export function createCompilerRecordStream(options: {
  maxRecordBytes: number
  onRecord: (record: string, terminated: boolean) => boolean | void
  onOmitted: (bytes: number) => void
}) {
  checkLimit(options.maxRecordBytes, 1)
  let partial = ''
  let partialBytes = 0
  let discarding = false
  let lastHighSurrogate = false
  let passthrough = false
  let finished = false

  const clearPartial = (): void => {
    partial = ''
    partialBytes = 0
    lastHighSurrogate = false
  }

  const append = (segment: string): void => {
    if (!segment) return
    let bytes = Buffer.byteLength(segment, 'utf8')
    // A decoded string can be split between UTF-16 halves by a caller. The
    // joined pair costs four UTF-8 bytes, not two replacement characters.
    const first = segment.charCodeAt(0)
    if (lastHighSurrogate && first >= 0xdc00 && first <= 0xdfff) bytes -= 2
    const last = segment.charCodeAt(segment.length - 1)
    lastHighSurrogate = last >= 0xd800 && last <= 0xdbff
    if (discarding) {
      options.onOmitted(bytes)
    } else if (partialBytes + bytes > options.maxRecordBytes) {
      options.onOmitted(partialBytes + bytes)
      partial = ''
      partialBytes = 0
      discarding = true
    } else {
      partial += segment
      partialBytes += bytes
    }
  }

  return {
    get partial(): string { return partial },
    get discarding(): boolean { return discarding },
    write(text: string): string {
      if (finished || passthrough) return text
      let offset = 0
      for (;;) {
        const newline = text.indexOf('\n', offset)
        if (newline < 0) {
          append(text.slice(offset))
          return ''
        }
        append(text.slice(offset, newline))
        const record = partial
        const omitted = discarding
        clearPartial()
        discarding = false
        if (!omitted && options.onRecord(record, true) === false) {
          passthrough = true
          return text.slice(newline + 1)
        }
        offset = newline + 1
      }
    },
    takePartial(): string {
      if (discarding) return ''
      const record = partial
      clearPartial()
      return record
    },
    discardPartial(): void {
      if (finished || passthrough || discarding) return
      options.onOmitted(partialBytes)
      partial = ''
      partialBytes = 0
      discarding = true
    },
    finish(): void {
      if (finished) return
      finished = true
      const record = partial
      const omitted = discarding
      clearPartial()
      discarding = false
      if (!omitted && record) options.onRecord(record, false)
    }
  }
}

export interface CompilerDiagnosticsResult {
  diagnostics: Diagnostic[]
  capture?: DiagnosticCapture
}

export function createCompilerDiagnostics(options: {
  cwd: string
  format: 'text' | 'rust' | 'cargo'
  maxRecordBytes: number
  maxDiagnosticsBytes: number
  onRecord?: (record: string) => void
  onOmitted?: (bytes: number) => void
}) {
  checkLimit(options.maxRecordBytes, 1)
  checkLimit(options.maxDiagnosticsBytes, 2)
  let diagnostics: Diagnostic[] = []
  let retainedBytes = 2
  let omittedDiagnostics = 0
  let unparsedBytes = 0
  let selectedFormat = 0
  let previous: string | null = null
  let finished = false

  const gap = (bytes: number): void => {
    if (finished) return
    checkLimit(bytes, 0)
    previous = null
    unparsedBytes = saturatingAdd(unparsedBytes, bytes)
    options.onOmitted?.(bytes)
  }

  const retain = (parsed: Diagnostic[], format: number): void => {
    const valid = parsed.filter(d => typeof d.file === 'string' && d.file.length > 0 &&
      Number.isSafeInteger(d.line) && d.line > 0 && Number.isSafeInteger(d.column) && d.column > 0 &&
      typeof d.message === 'string' && (d.code === undefined || typeof d.code === 'string'))
    if (!valid.length || format < selectedFormat) return
    if (format > selectedFormat) {
      selectedFormat = format
      diagnostics = []
      retainedBytes = 2
      omittedDiagnostics = 0
    }
    for (const item of valid) {
      const diagnostic = { ...item, file: isAbsolute(item.file) ? item.file : resolve(options.cwd, item.file) }
      const bytes = Buffer.byteLength(JSON.stringify(diagnostic), 'utf8') + (diagnostics.length ? 1 : 0)
      if (diagnostics.length >= MAX_DIAGNOSTICS || retainedBytes + bytes > options.maxDiagnosticsBytes) {
        omittedDiagnostics = saturatingAdd(omittedDiagnostics, 1)
      } else {
        diagnostics.push(diagnostic)
        retainedBytes += bytes
      }
    }
  }

  const record = (raw: string): void => {
    if (finished) return
    const bytes = Buffer.byteLength(raw, 'utf8')
    if (bytes > options.maxRecordBytes) {
      gap(bytes)
      return
    }
    options.onRecord?.(raw)
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (options.format === 'cargo') {
      retain(parseCargoDiagnostics(line), 3)
      return
    }
    if (options.format === 'rust') {
      const json = parseRustJsonDiagnostics(line)
      if (json.length) {
        retain(json, 3)
        previous = null
        return
      }
    }
    const gcc = parseDiagnostics(line)
    if (gcc.length) {
      retain(gcc, 2)
      previous = null
      return
    }
    if (previous !== null) retain(parseDiagnostics(previous + '\n' + line), 1)
    previous = line
  }

  const stream = createCompilerRecordStream({ maxRecordBytes: options.maxRecordBytes, onRecord: record, onOmitted: gap })
  const snapshot = (): CompilerDiagnosticsResult => {
    const result: CompilerDiagnosticsResult = { diagnostics: diagnostics.map(diagnostic => ({ ...diagnostic })) }
    if (omittedDiagnostics || unparsedBytes) result.capture = { omittedDiagnostics, unparsedBytes }
    return result
  }

  return {
    write(text: string): void { if (!finished) stream.write(text) },
    record,
    gap,
    snapshot,
    finish(): CompilerDiagnosticsResult {
      if (!finished) {
        stream.finish()
        previous = null
        finished = true
      }
      return snapshot()
    }
  }
}
