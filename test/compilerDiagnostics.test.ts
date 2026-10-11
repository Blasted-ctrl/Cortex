import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import {
  createCompilerDiagnostics,
  createCompilerRecordStream,
  COMPILER_DIAGNOSTIC_LIMITS
} from '../src/main/services/compilerDiagnostics'
import type { Diagnostic } from '../src/shared/ipc'

const cwd = resolve('compiler-diagnostic-fixture')
const textOptions = {
  cwd,
  format: 'text' as const,
  maxRecordBytes: 4096,
  maxDiagnosticsBytes: 256 * 1024
}
const gccError = 'src/main.cpp:3:7: error: missing value'
const expectedGcc: Diagnostic = {
  file: resolve(cwd, 'src/main.cpp'),
  line: 3,
  column: 7,
  severity: 'error',
  message: 'missing value'
}
const rustError = '{"message":"missing value","level":"error","code":{"code":"E0425"},"spans":[{"file_name":"src/main.rs","line_start":4,"column_start":9,"is_primary":true}],"rendered":"error[E0425]: missing value\\n --> src/main.rs:4:9\\n"}'
const expectedRust: Diagnostic = {
  file: resolve(cwd, 'src/main.rs'),
  line: 4,
  column: 9,
  severity: 'error',
  message: 'missing value',
  code: 'E0425'
}
const cargoError = '{"reason":"compiler-message","message":{"message":"missing value","level":"error","code":{"code":"E0425"},"spans":[{"file_name":"src/main.rs","line_start":4,"column_start":9,"is_primary":true}],"rendered":"error[E0425]: missing value\\n"}}'

describe('createCompilerDiagnostics', () => {
  it('pins the measured production record and normalized-array budgets', () => {
    expect(COMPILER_DIAGNOSTIC_LIMITS).toEqual({ maxRecordBytes: 1048576, maxDiagnosticsBytes: 1048576 })
  })

  it('accepts the exact production record boundary and skips one byte over it', () => {
    const capture = createCompilerDiagnostics({ cwd, format: 'text', ...COMPILER_DIAGNOSTIC_LIMITS })
    capture.write('x'.repeat(1048576) + '\n' + gccError + '\n')
    expect(capture.snapshot()).toEqual({ diagnostics: [expectedGcc] })
    capture.write('x'.repeat(1048577) + '\n')
    expect(capture.finish()).toEqual({ diagnostics: [expectedGcc], capture: { omittedDiagnostics: 0, unparsedBytes: 1048577 } })
  })

  it('budgets the exact production array after cwd normalization and JSON serialization', () => {
    const empty = { ...expectedGcc, message: '' }
    const message = 'm'.repeat(1048576 - Buffer.byteLength(JSON.stringify([empty])))
    const expected = { ...expectedGcc, message }
    const capture = createCompilerDiagnostics({ cwd, format: 'text', ...COMPILER_DIAGNOSTIC_LIMITS })
    // The serialized diagnostic has greater overhead than the input record.
    expect(Buffer.byteLength(gccError.replace('missing value', message))).toBeLessThan(1048576)
    expect(Buffer.byteLength(JSON.stringify([expected]))).toBe(1048576)
    capture.write(gccError.replace('missing value', message) + '\n' + gccError + '\n')
    expect(capture.finish()).toEqual({ diagnostics: [expected], capture: { omittedDiagnostics: 1, unparsedBytes: 0 } })

    const over = createCompilerDiagnostics({ cwd, format: 'text', ...COMPILER_DIAGNOSTIC_LIMITS })
    over.write(gccError.replace('missing value', message + 'm') + '\n' + gccError + '\n')
    expect(over.finish()).toEqual({ diagnostics: [expectedGcc], capture: { omittedDiagnostics: 1, unparsedBytes: 0 } })
  })

  it('returns an empty complete result before and after an empty build', () => {
    const capture = createCompilerDiagnostics(textOptions)

    expect(capture.snapshot()).toEqual({ diagnostics: [] })
    expect(capture.finish()).toEqual({ diagnostics: [] })
  })

  it('retains exact GCC warnings, fatal errors and resolved locations', () => {
    const capture = createCompilerDiagnostics(textOptions)
    capture.write("src/main.cpp:2:5: warning: unused variable 'y' [-Wunused-variable]\r\n")
    capture.write('src/header.h:6: fatal error: missing.h: No such file or directory\r\n')

    expect(capture.finish()).toEqual({
      diagnostics: [
        {
          file: resolve(cwd, 'src/main.cpp'),
          line: 2,
          column: 5,
          severity: 'warning',
          message: "unused variable 'y'",
          code: '-Wunused-variable'
        },
        {
          file: resolve(cwd, 'src/header.h'),
          line: 6,
          column: 1,
          severity: 'error',
          message: 'missing.h: No such file or directory'
        }
      ]
    })
  })

  it('does not resolve an already absolute compiler path against cwd again', () => {
    const capture = createCompilerDiagnostics(textOptions)
    const file = resolve(cwd, 'absolute.cpp')
    capture.write(`${file}:10:52: error: absolute location\n`)

    expect(capture.finish()).toEqual({
      diagnostics: [{ file, line: 10, column: 52, severity: 'error', message: 'absolute location' }]
    })
  })

  it('resolves relative paths against the supplied build cwd rather than process cwd', () => {
    const buildCwd = process.platform === 'win32' ? 'D:\\cortex-build-fixture' : '/cortex-build-fixture'
    const capture = createCompilerDiagnostics({ ...textOptions, cwd: buildCwd })
    capture.record('src/main.cpp:3:7: error: missing value')

    expect(capture.finish()).toEqual({
      diagnostics: [{ ...expectedGcc, file: resolve(buildCwd, 'src/main.cpp') }]
    })
  })

  it('keeps Rust JSON code, severity and primary span', () => {
    const capture = createCompilerDiagnostics({ ...textOptions, format: 'rust' })
    capture.write('{"message":"unused value","level":"warning","code":{"code":"unused_variables"},"spans":[{"file_name":"src/lib.rs","line_start":2,"column_start":1,"is_primary":false},{"file_name":"src/main.rs","line_start":8,"column_start":13,"is_primary":true}]}\n')

    expect(capture.finish()).toEqual({
      diagnostics: [{
        file: resolve(cwd, 'src/main.rs'),
        line: 8,
        column: 13,
        severity: 'warning',
        message: 'unused value',
        code: 'unused_variables'
      }]
    })
  })

  it('retains the adjacent textual Rust fallback when JSON and GCC are absent', () => {
    const capture = createCompilerDiagnostics({ ...textOptions, format: 'rust' })
    capture.write('error[E0425]: missing value\n --> src/main.rs:4:9\n')

    expect(capture.finish()).toEqual({ diagnostics: [expectedRust] })
  })

  it('does not parse Rust JSON in the native text format', () => {
    const capture = createCompilerDiagnostics(textOptions)
    capture.write(rustError + '\n')
    capture.write(gccError + '\n')

    expect(capture.finish()).toEqual({ diagnostics: [expectedGcc] })
  })

  it('preserves decoded Unicode and CRLF split across writes', () => {
    const capture = createCompilerDiagnostics(textOptions)
    capture.write('src/main.cpp:3:7: error: caf\u00e9 \ud83d')
    capture.write('\ude00\r')
    capture.write('\n')

    expect(capture.finish()).toEqual({
      diagnostics: [{ ...expectedGcc, message: 'caf\u00e9 \ud83d\ude00' }]
    })
  })

  it('does not publish an unfinished record before finish', () => {
    const capture = createCompilerDiagnostics(textOptions)
    capture.write(gccError)

    expect(capture.snapshot()).toEqual({ diagnostics: [] })
    expect(capture.finish()).toEqual({ diagnostics: [expectedGcc] })
  })

  it('finishes a final unterminated Rust record only once', () => {
    const records: string[] = []
    const capture = createCompilerDiagnostics({
      ...textOptions,
      format: 'rust',
      onRecord: (record) => records.push(record)
    })
    capture.write(rustError)

    expect(capture.finish()).toEqual({ diagnostics: [expectedRust] })
    expect(capture.finish()).toEqual({ diagnostics: [expectedRust] })
    expect(records).toEqual([rustError])
  })

  it('admits a record at the exact UTF-8 limit', () => {
    const capture = createCompilerDiagnostics({ ...textOptions, maxRecordBytes: 24 })
    capture.write('a.cpp:1:1: error: \u00e9\ud83d\ude00\n')

    expect(capture.finish()).toEqual({
      diagnostics: [{ file: resolve(cwd, 'a.cpp'), line: 1, column: 1, severity: 'error', message: '\u00e9\ud83d\ude00' }]
    })
  })

  it('omits the whole record one UTF-8 byte over the limit', () => {
    const capture = createCompilerDiagnostics({ ...textOptions, maxRecordBytes: 23 })
    capture.write('a.cpp:1:1: error: \u00e9\ud83d\ude00\n')

    expect(capture.finish()).toEqual({
      diagnostics: [],
      capture: { omittedDiagnostics: 0, unparsedBytes: 24 }
    })
  })

  it('counts CR in the record budget but strips it before parsing', () => {
    const fitting = createCompilerDiagnostics({ ...textOptions, maxRecordBytes: 20 })
    const omitted = createCompilerDiagnostics({ ...textOptions, maxRecordBytes: 19 })
    fitting.write('a.cpp:1:1: error: x\r\n')
    omitted.write('a.cpp:1:1: error: x\r\n')

    expect(fitting.finish()).toEqual({
      diagnostics: [{ file: resolve(cwd, 'a.cpp'), line: 1, column: 1, severity: 'error', message: 'x' }]
    })
    expect(omitted.finish()).toEqual({
      diagnostics: [],
      capture: { omittedDiagnostics: 0, unparsedBytes: 20 }
    })
  })

  it('admits the exact serialized normalized diagnostic-array budget', () => {
    const expected = [expectedGcc]
    const budget = Buffer.byteLength(JSON.stringify(expected), 'utf8')
    const capture = createCompilerDiagnostics({ ...textOptions, maxDiagnosticsBytes: budget })
    capture.write(gccError + '\n')

    expect(capture.finish()).toEqual({ diagnostics: expected })
  })

  it('omits a whole normalized diagnostic one byte above its payload budget', () => {
    const budget = Buffer.byteLength(JSON.stringify([expectedGcc]), 'utf8') - 1
    const capture = createCompilerDiagnostics({ ...textOptions, maxDiagnosticsBytes: budget })
    capture.write(gccError + '\n')

    expect(capture.finish()).toEqual({
      diagnostics: [],
      capture: { omittedDiagnostics: 1, unparsedBytes: 0 }
    })
  })

  it('includes array commas and brackets in the aggregate payload budget', () => {
    const budget = Buffer.byteLength(JSON.stringify([expectedGcc, expectedGcc]), 'utf8') - 1
    const capture = createCompilerDiagnostics({ ...textOptions, maxDiagnosticsBytes: budget })
    capture.write(gccError + '\n' + gccError + '\n')

    expect(capture.finish()).toEqual({
      diagnostics: [expectedGcc],
      capture: { omittedDiagnostics: 1, unparsedBytes: 0 }
    })
  })

  it('retains 500 diagnostics and counts the 501st rather than resetting the cap per record', () => {
    const capture = createCompilerDiagnostics(textOptions)
    capture.write((gccError + '\n').repeat(501))

    expect(capture.finish()).toEqual({
      diagnostics: Array.from({ length: 500 }, () => expectedGcc),
      capture: { omittedDiagnostics: 1, unparsedBytes: 0 }
    })
  })

  it.each(['message', 'path', 'code'] as const)('omits an oversized %s field without truncating it into a diagnostic', (field) => {
    const capture = createCompilerDiagnostics({
      ...textOptions,
      format: 'rust',
      maxDiagnosticsBytes: 256
    })
    const input = {
      message: field === 'message' ? 'm'.repeat(2048) : 'missing value',
      level: 'error',
      code: { code: field === 'code' ? 'E'.repeat(2048) : 'E0425' },
      spans: [{ file_name: field === 'path' ? 'p'.repeat(2048) + '.rs' : 'src/main.rs', line_start: 4, column_start: 9, is_primary: true }]
    }
    capture.record(JSON.stringify(input))

    expect(capture.finish()).toEqual({
      diagnostics: [],
      capture: { omittedDiagnostics: 1, unparsedBytes: 0 }
    })
  })

  it('does not charge a bounded human rendering as retained diagnostic payload', () => {
    const budget = Buffer.byteLength(JSON.stringify([expectedRust]), 'utf8')
    const capture = createCompilerDiagnostics({
      ...textOptions,
      format: 'rust',
      maxRecordBytes: 8192,
      maxDiagnosticsBytes: budget
    })
    const input = '{"message":"missing value","level":"error","code":{"code":"E0425"},"spans":[{"file_name":"src/main.rs","line_start":4,"column_start":9,"is_primary":true}],"rendered":"' + 'r'.repeat(4096) + '"}'
    capture.record(input)

    expect(capture.finish()).toEqual({ diagnostics: [expectedRust] })
  })

  it('discards a complete oversized record and resumes at the next physical line', () => {
    const omitted = gccError + 'x'.repeat(128)
    const records: string[] = []
    const capture = createCompilerDiagnostics({
      ...textOptions,
      maxRecordBytes: 64,
      onRecord: (record) => records.push(record)
    })
    capture.write(omitted + '\n' + gccError + '\n')

    expect(capture.finish()).toEqual({
      diagnostics: [expectedGcc],
      capture: { omittedDiagnostics: 0, unparsedBytes: Buffer.byteLength(omitted, 'utf8') }
    })
    expect(records).toEqual([gccError])
  })

  it('counts already held bytes and all later fragments of an oversized record', () => {
    const omittedBytes: number[] = []
    const capture = createCompilerDiagnostics({
      ...textOptions,
      maxRecordBytes: 64,
      onOmitted: (bytes) => omittedBytes.push(bytes)
    })
    capture.write('x'.repeat(60))
    capture.write('y'.repeat(20))
    capture.write('z'.repeat(30))
    capture.write('\n' + gccError + '\n')

    expect(capture.finish()).toEqual({
      diagnostics: [expectedGcc],
      capture: { omittedDiagnostics: 0, unparsedBytes: 110 }
    })
    expect(omittedBytes.reduce((sum, bytes) => sum + bytes, 0)).toBe(110)
  })

  it('keeps a late located error after a bounded discarded flood', () => {
    const capture = createCompilerDiagnostics({ ...textOptions, maxRecordBytes: 64 })
    capture.write(('x'.repeat(65) + '\n').repeat(1024))
    capture.write(gccError + '\n')

    expect(capture.finish()).toEqual({
      diagnostics: [expectedGcc],
      capture: { omittedDiagnostics: 0, unparsedBytes: 66560 }
    })
  })

  it('counts an oversized final unterminated record without parsing its prefix', () => {
    const capture = createCompilerDiagnostics({ ...textOptions, maxRecordBytes: 32 })
    capture.write(gccError + 'x'.repeat(128))

    expect(capture.finish()).toEqual({
      diagnostics: [],
      capture: { omittedDiagnostics: 0, unparsedBytes: Buffer.byteLength(gccError, 'utf8') + 128 }
    })
  })

  it('does not pair textual Rust locations across an explicit omitted gap', () => {
    const capture = createCompilerDiagnostics({ ...textOptions, format: 'rust' })
    capture.record('error[E0425]: fabricated pair')
    capture.gap(17)
    capture.record(' --> src/main.rs:4:9')
    capture.record('error[E0425]: missing value')
    capture.record(' --> src/main.rs:4:9')

    expect(capture.finish()).toEqual({
      diagnostics: [expectedRust],
      capture: { omittedDiagnostics: 0, unparsedBytes: 17 }
    })
  })

  it('does not pair textual Rust locations across an oversized physical line', () => {
    const capture = createCompilerDiagnostics({ ...textOptions, format: 'rust', maxRecordBytes: 64 })
    capture.write('error[E0425]: fabricated pair\n' + 'x'.repeat(65) + '\n --> src/main.rs:4:9\n')

    expect(capture.finish()).toEqual({
      diagnostics: [],
      capture: { omittedDiagnostics: 0, unparsedBytes: 65 }
    })
  })

  it('does not pair textual Rust locations across an empty physical line', () => {
    const capture = createCompilerDiagnostics({ ...textOptions, format: 'rust' })
    capture.write('error[E0425]: fabricated pair\n\n --> src/main.rs:4:9\n')

    expect(capture.finish()).toEqual({ diagnostics: [] })
  })

  it('reclaims fallback retention and omissions when a GCC diagnostic is recognized', () => {
    const budget = Buffer.byteLength(JSON.stringify([expectedRust]), 'utf8')
    const capture = createCompilerDiagnostics({ ...textOptions, maxDiagnosticsBytes: budget })
    capture.write('error[E0425]: missing value\n --> src/main.rs:4:9\n'.repeat(3))
    expect(capture.snapshot()).toEqual({
      diagnostics: [expectedRust],
      capture: { omittedDiagnostics: 2, unparsedBytes: 0 }
    })
    capture.write(gccError + '\n')

    expect(capture.finish()).toEqual({ diagnostics: [expectedGcc] })
  })

  it('does not revive fallback when the selected GCC diagnostic cannot fit', () => {
    const capture = createCompilerDiagnostics({ ...textOptions, maxDiagnosticsBytes: 256 })
    capture.write('error[E0425]: missing value\n --> src/main.rs:4:9\n')
    capture.write('src/main.cpp:3:7: error: ' + 'x'.repeat(1024) + '\n')
    capture.write('error[E0425]: missing value\n --> src/main.rs:4:9\n')

    expect(capture.finish()).toEqual({
      diagnostics: [],
      capture: { omittedDiagnostics: 1, unparsedBytes: 0 }
    })
  })

  it('selects Rust JSON over retained GCC and textual Rust fallbacks', () => {
    const capture = createCompilerDiagnostics({ ...textOptions, format: 'rust' })
    capture.write('error[E0425]: missing value\n --> src/main.rs:4:9\n')
    capture.write(gccError + '\n')
    expect(capture.snapshot()).toEqual({ diagnostics: [expectedGcc] })
    capture.write(rustError + '\n')
    capture.write(gccError + '\n')

    expect(capture.finish()).toEqual({ diagnostics: [expectedRust] })
  })

  it('reclaims GCC selected-lane omissions when Rust JSON takes precedence', () => {
    const budget = Buffer.byteLength(JSON.stringify([expectedRust]), 'utf8')
    const capture = createCompilerDiagnostics({ ...textOptions, format: 'rust', maxDiagnosticsBytes: budget })
    capture.write((gccError + '\n').repeat(3))
    expect(capture.snapshot().capture).toEqual({ omittedDiagnostics: 2, unparsedBytes: 0 })
    capture.write(rustError + '\n')

    expect(capture.finish()).toEqual({ diagnostics: [expectedRust] })
  })

  it('does not revive GCC fallback after a recognized but unretainable Rust JSON diagnostic', () => {
    const capture = createCompilerDiagnostics({ ...textOptions, format: 'rust', maxDiagnosticsBytes: 256 })
    capture.write(gccError + '\n')
    capture.record('{"message":"' + 'x'.repeat(1024) + '","level":"error","spans":[{"file_name":"src/main.rs","line_start":4,"column_start":9,"is_primary":true}]}')
    capture.write(gccError + '\n')

    expect(capture.finish()).toEqual({
      diagnostics: [],
      capture: { omittedDiagnostics: 1, unparsedBytes: 0 }
    })
  })

  it('preserves globally unknown discarded bytes when primary format replaces fallback', () => {
    const capture = createCompilerDiagnostics({ ...textOptions, format: 'rust' })
    capture.write(gccError + '\n')
    capture.gap(37)
    capture.write(rustError + '\n')

    expect(capture.finish()).toEqual({
      diagnostics: [expectedRust],
      capture: { omittedDiagnostics: 0, unparsedBytes: 37 }
    })
  })

  it('does not select a span-less Rust summary instead of a located fallback', () => {
    const capture = createCompilerDiagnostics({ ...textOptions, format: 'rust' })
    capture.write(gccError + '\n')
    capture.record('{"message":"aborting due to 1 previous error","level":"error","spans":[]}')

    expect(capture.finish()).toEqual({ diagnostics: [expectedGcc] })
  })

  it('parses Cargo compiler-message spans without accepting bare rustc records', () => {
    const capture = createCompilerDiagnostics({ ...textOptions, format: 'cargo' })
    capture.record(rustError)
    capture.record(cargoError)
    capture.record('{"reason":"build-finished","success":false}')

    expect(capture.finish()).toEqual({ diagnostics: [expectedRust] })
  })

  it('enforces the complete-record limit when Cargo calls record directly', () => {
    const capture = createCompilerDiagnostics({ ...textOptions, format: 'cargo', maxRecordBytes: 512 })
    const oversized = '{"reason":"compiler-message","message":{"message":"' + 'x'.repeat(1024) + '","level":"error","spans":[{"file_name":"src/main.rs","line_start":99,"column_start":1}]}}'
    capture.record(oversized)
    capture.record(cargoError)

    expect(capture.finish()).toEqual({
      diagnostics: [expectedRust],
      capture: { omittedDiagnostics: 0, unparsedBytes: Buffer.byteLength(oversized, 'utf8') }
    })
  })
})

describe('createCompilerRecordStream', () => {
  it('frames physical LF records and flushes an unterminated final record', () => {
    const records: Array<[string, boolean]> = []
    const stream = createCompilerRecordStream({
      maxRecordBytes: 32,
      onRecord: (record, terminated) => { records.push([record, terminated]) },
      onOmitted: () => { throw new Error('No record should be omitted') }
    })
    expect(stream.write('first\r\n\nlast')).toBe('')
    expect(records).toEqual([['first\r', true], ['', true]])
    expect(stream.partial).toBe('last')
    stream.finish()

    expect(records).toEqual([['first\r', true], ['', true], ['last', false]])
    expect(stream.partial).toBe('')
    expect(stream.discarding).toBe(false)
  })

  it('takes a prompt partial without later rendering it a second time', () => {
    const records: string[] = []
    const stream = createCompilerRecordStream({
      maxRecordBytes: 32,
      onRecord: (record) => { records.push(record) },
      onOmitted: () => { throw new Error('No record should be omitted') }
    })
    stream.write('Enter name: ')

    expect(stream.takePartial()).toBe('Enter name: ')
    expect(stream.partial).toBe('')
    stream.write('later\n')
    stream.finish()
    expect(records).toEqual(['later'])
  })

  it('counts a split surrogate pair once at the exact UTF-8 boundary', () => {
    const records: string[] = []
    const omissions: number[] = []
    const stream = createCompilerRecordStream({
      maxRecordBytes: 6,
      onRecord: (record) => { records.push(record) },
      onOmitted: (bytes) => { omissions.push(bytes) }
    })
    stream.write('\u00e9\ud83d')
    stream.write('\ude00\n')
    stream.finish()

    expect(records).toEqual(['\u00e9\ud83d\ude00'])
    expect(omissions).toEqual([])
  })

  it('discards a split surrogate pair one UTF-8 byte over the boundary', () => {
    const records: string[] = []
    const omissions: number[] = []
    const stream = createCompilerRecordStream({
      maxRecordBytes: 5,
      onRecord: (record) => { records.push(record) },
      onOmitted: (bytes) => { omissions.push(bytes) }
    })
    stream.write('\u00e9\ud83d')
    stream.write('\ude00\n')
    stream.finish()

    expect(records).toEqual([])
    expect(omissions.reduce((sum, bytes) => sum + bytes, 0)).toBe(6)
  })

  it('accounts for an unmatched high surrogate at final residue', () => {
    const records: string[] = []
    const omissions: number[] = []
    const stream = createCompilerRecordStream({
      maxRecordBytes: 2,
      onRecord: (record) => { records.push(record) },
      onOmitted: (bytes) => { omissions.push(bytes) }
    })
    stream.write('\ud83d')
    stream.finish()

    expect(records).toEqual([])
    expect(omissions.reduce((sum, bytes) => sum + bytes, 0)).toBe(3)
  })

  it.each([{ limit: 4, omitted: 0 }, { limit: 3, omitted: 4 }])('enforces a split supplementary character at a $limit-byte limit', ({ limit, omitted }) => {
    const records: string[] = []
    const omissions: number[] = []
    const stream = createCompilerRecordStream({
      maxRecordBytes: limit,
      onRecord: (record) => { records.push(record) },
      onOmitted: (bytes) => { omissions.push(bytes) }
    })
    stream.write('\ud83d')
    stream.write('\ude00\n')
    stream.finish()

    expect(records).toEqual(omitted ? [] : ['\ud83d\ude00'])
    expect(omissions.reduce((sum, bytes) => sum + bytes, 0)).toBe(omitted)
  })

  it('counts the whole discarded record including held bytes and CR but excluding LF', () => {
    const records: string[] = []
    const omissions: number[] = []
    const stream = createCompilerRecordStream({
      maxRecordBytes: 4,
      onRecord: (record) => { records.push(record) },
      onOmitted: (bytes) => { omissions.push(bytes) }
    })
    stream.write('ab')
    stream.write('cde')
    expect(stream.partial).toBe('')
    expect(stream.discarding).toBe(true)
    stream.write('fg\r\nnext\n')
    stream.finish()

    expect(records).toEqual(['next'])
    expect(omissions.reduce((sum, bytes) => sum + bytes, 0)).toBe(8)
    expect(stream.discarding).toBe(false)
  })

  it('cannot revive discarded input by taking its partial during a prompt timeout', () => {
    const records: string[] = []
    const omissions: number[] = []
    const stream = createCompilerRecordStream({
      maxRecordBytes: 4,
      onRecord: (record) => { records.push(record) },
      onOmitted: (bytes) => { omissions.push(bytes) }
    })
    stream.write('abcde')

    expect(stream.takePartial()).toBe('')
    expect(stream.discarding).toBe(true)
    stream.write('tail\nok\n')
    stream.finish()
    expect(records).toEqual(['ok'])
    expect(omissions.reduce((sum, bytes) => sum + bytes, 0)).toBe(9)
  })

  it('discards a timed-out potential machine partial and its remaining physical suffix', () => {
    const records: string[] = []
    const omissions: number[] = []
    const stream = createCompilerRecordStream({
      maxRecordBytes: 32,
      onRecord: (record) => { records.push(record) },
      onOmitted: (bytes) => { omissions.push(bytes) }
    })
    stream.write('{"reason":')
    stream.discardPartial()

    expect(stream.partial).toBe('')
    expect(stream.discarding).toBe(true)
    stream.write('"compiler-message"}\nlater\n')
    stream.finish()
    expect(records).toEqual(['later'])
    expect(omissions.reduce((sum, bytes) => sum + bytes, 0)).toBe(29)
  })

  it('checks oversized complete records delivered in one chunk', () => {
    const records: string[] = []
    const omissions: number[] = []
    const stream = createCompilerRecordStream({
      maxRecordBytes: 8,
      onRecord: (record) => { records.push(record) },
      onOmitted: (bytes) => { omissions.push(bytes) }
    })
    stream.write('123456789\nvalid\n')
    stream.finish()

    expect(records).toEqual(['valid'])
    expect(omissions.reduce((sum, bytes) => sum + bytes, 0)).toBe(9)
  })

  it.each([true, false])('returns untouched program data after a terminal success:%s record', (success) => {
    const records: string[] = []
    const terminal = `{"reason":"build-finished","success":${success}}`
    const remainder = 'Enter name: \r\n{"reason":"compiler-message","message":"program telemetry"}\n\ud83d\ude00'
    const stream = createCompilerRecordStream({
      maxRecordBytes: 128,
      onRecord: (record) => {
        records.push(record)
        return record !== terminal
      },
      onOmitted: () => { throw new Error('No record should be omitted') }
    })

    expect(stream.write('before\n' + terminal + '\n' + remainder)).toBe(remainder)
    expect(records).toEqual(['before', terminal])
    expect(stream.partial).toBe('')
    expect(stream.write('more program output\r\n')).toBe('more program output\r\n')
    stream.finish()
    expect(records).toEqual(['before', terminal])
  })

  it('does not parse or omit a same-chunk suffix after a CRLF terminal boundary', () => {
    const records: string[] = []
    const stream = createCompilerRecordStream({
      maxRecordBytes: 4,
      onRecord: (record) => {
        records.push(record)
        return false
      },
      onOmitted: () => { throw new Error('Post-terminal program data is not compiler input') }
    })
    const program = 'x'.repeat(1024) + '\r\n'

    expect(stream.write('end\r\n' + program)).toBe(program)
    expect(records).toEqual(['end\r'])
    stream.finish()
  })
})
