import type { Diagnostic, DiagnosticSeverity } from './ipc'

/**
 * Parse GCC/Clang diagnostic output (stderr) into structured diagnostics.
 *
 * Handles the common forms emitted by g++, gcc, clang, clang++:
 *   path/file.cpp:10:52: error: 'x' is not a member of 'std'
 *   path/file.cpp:12: warning: unused variable 'y' [-Wunused-variable]
 *   C:\path\file.cpp:3:5: fatal error: foo.h: No such file or directory
 *
 * `file` is returned exactly as the compiler reported it (may be relative);
 * the caller resolves it to an absolute path against the build cwd. The parser
 * itself stays pure (no Node deps) so it can be unit-tested and reused.
 *
 * The leading `(.+?)` is lazy so it correctly consumes Windows drive letters
 * (the `C:` in `C:\...`) without mistaking the drive colon for the line
 * separator.
 */
const LINE_RE =
  /^(.+?):(\d+)(?::(\d+))?:\s+(fatal error|error|warning|note|info):\s+(.*)$/

const CODE_RE = /\s*\[(-[A-Za-z0-9=+_-]+)\]\s*$/

function normalizeSeverity(raw: string): DiagnosticSeverity {
  if (raw === 'fatal error' || raw === 'error') return 'error'
  if (raw === 'warning') return 'warning'
  if (raw === 'note') return 'note'
  return 'info'
}

/**
 * rustc with `--error-format=json` emits one JSON object per line, each with
 * exact spans. This is the precise path (no regex, real column ranges); the
 * textual parser below stays as the fallback for any other rustc invocation.
 *
 * Shape (trimmed): { "message": "...", "level": "error", "code": {"code":"E0425"},
 *   "spans": [{"file_name":"src/main.rs","line_start":2,"column_start":5,
 *              "is_primary":true}] }
 */
interface RustJsonSpan {
  file_name?: string
  line_start?: number
  column_start?: number
  is_primary?: boolean
}
interface RustJsonMessage {
  message?: string
  level?: string
  code?: { code?: string } | null
  spans?: RustJsonSpan[]
  /** rustc's own human-readable rendering of this diagnostic. */
  rendered?: string
}

/**
 * Turn one line of rustc JSON into the text a human should see. Returns the
 * line unchanged if it is not a diagnostic record, so nothing is swallowed:
 * with --error-format=json the Output panel would otherwise show raw JSON.
 */
export function renderRustJsonLine(line: string): string {
  const t = line.trim()
  if (!t.startsWith('{')) return line ? line + '\n' : ''
  try {
    const msg = JSON.parse(t) as RustJsonMessage
    if (typeof msg.rendered === 'string') return msg.rendered
    // Artifact/other records carry no rendering and are not for the user.
    if (msg.message === undefined) return ''
    return msg.message + '\n'
  } catch {
    return line + '\n'
  }
}

export function parseRustJsonDiagnostics(stdout: string, max = 500): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    let msg: RustJsonMessage
    try {
      msg = JSON.parse(line) as RustJsonMessage
    } catch {
      continue // not a diagnostic record (rustc also emits artifact lines)
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue
    const level = msg.level
    if (level !== 'error' && level !== 'warning') continue
    if (msg.message != null && typeof msg.message !== 'string') continue
    if (msg.code != null && (
      typeof msg.code !== 'object' || Array.isArray(msg.code) ||
      (msg.code.code !== undefined && typeof msg.code.code !== 'string')
    )) continue
    if (!Array.isArray(msg.spans)) continue
    // The primary span is the one to point at; secondary spans are context.
    const span = msg.spans.find((s) => s && typeof s === 'object' && s.is_primary === true) ?? msg.spans[0]
    if (!span || typeof span !== 'object' || Array.isArray(span) ||
      typeof span.file_name !== 'string' || !span.file_name ||
      (span.is_primary !== undefined && typeof span.is_primary !== 'boolean') ||
      typeof span.line_start !== 'number' || !Number.isSafeInteger(span.line_start) || span.line_start < 1 ||
      (span.column_start != null && (!Number.isSafeInteger(span.column_start) || span.column_start < 1))
    ) continue
    out.push({
      file: span.file_name,
      line: span.line_start,
      column: span.column_start ?? 1,
      severity: level,
      message: msg.message ?? '',
      code: msg.code?.code
    })
    if (out.length >= max) break
  }
  return out
}

/**
 * `cargo --message-format=json-render-diagnostics` writes machine records to
 * STDOUT, interleaved with the program's own output. Those records are for us,
 * not the user: showing them turns "run my program" into a wall of JSON.
 *
 * True when a line is one of cargo's records (they always carry `reason`).
 */
const CARGO_REASONS = new Set([
  'compiler-artifact',
  'compiler-message',
  'build-script-executed',
  'build-finished'
])

export function isCargoJsonLine(line: string): boolean {
  const t = line.trim()
  if (!t.startsWith('{') || !t.includes('"reason"')) return false
  try {
    // Match only cargo's OWN reason values. Accepting any string `reason` would
    // swallow a program whose stdout happens to be JSON with that field.
    const reason = (JSON.parse(t) as { reason?: unknown }).reason
    return typeof reason === 'string' && CARGO_REASONS.has(reason)
  } catch {
    return false
  }
}

export function getCargoBuildOutcome(line: string): boolean | null {
  const t = line.trim()
  if (!t.startsWith('{')) return null
  try {
    const rec = JSON.parse(t) as { reason?: unknown; success?: unknown }
    if (rec.reason !== 'build-finished' || typeof rec.success !== 'boolean') return null
    return rec.success
  } catch {
    return null
  }
}

/**
 * True for cargo's terminal `{"reason":"build-finished","success":true}` record.
 * cargo builds and runs in ONE process, so this is the only in-band signal that
 * compiling is over and whatever comes next is the program itself.
 */
export function isBuildFinished(line: string): boolean {
  return getCargoBuildOutcome(line) === true
}

/**
 * The human text inside a cargo `compiler-message` record, or null for any
 * other record. With `--message-format=json` cargo does NOT print diagnostics
 * itself, so this is what the user is shown.
 */
export function cargoRenderedMessage(line: string): string | null {
  const t = line.trim()
  if (!t.startsWith('{')) return null
  try {
    const rec = JSON.parse(t) as { reason?: string; message?: { rendered?: string } }
    if (rec.reason !== 'compiler-message') return null
    return typeof rec.message?.rendered === 'string' ? rec.message.rendered : null
  } catch {
    return null
  }
}

/**
 * Diagnostics out of cargo's stdout stream: each `compiler-message` record
 * wraps a rustc diagnostic, so the spans are exact.
 */
export function parseCargoDiagnostics(stdout: string, max = 500): Diagnostic[] {
  const out: Diagnostic[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const t = raw.trim()
    if (!t.startsWith('{') || !t.includes('"compiler-message"')) continue
    try {
      const rec = JSON.parse(t) as { reason?: string; message?: unknown }
      if (rec.reason !== 'compiler-message' || !rec.message) continue
      out.push(...parseRustJsonDiagnostics(JSON.stringify(rec.message), max - out.length))
    } catch {
      continue
    }
    if (out.length >= max) break
  }
  return out
}

/**
 * rustc splits one diagnostic across two lines, which LINE_RE cannot match:
 *   error[E0425]: cannot find value `x` in this scope
 *    --> src/main.rs:2:5
 * The header carries severity + optional code + message; the arrow line carries
 * the location.
 */
const RUST_HEAD_RE = /^(error|warning)(?:\[([A-Za-z0-9]+)\])?:\s+(.*)$/
const RUST_LOC_RE = /^\s*-->\s+(.+?):(\d+):(\d+)\s*$/

function parseRustDiagnostics(lines: string[], max: number): Diagnostic[] {
  const out: Diagnostic[] = []
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const head = RUST_HEAD_RE.exec(lines[i])
    if (!head) continue
    // The location is on the next non-empty line; anything else is not a
    // locatable diagnostic (e.g. the trailing "error: could not compile").
    const loc = RUST_LOC_RE.exec(lines[i + 1] ?? '')
    if (!loc) continue
    out.push({
      file: loc[1],
      line: Math.max(1, parseInt(loc[2], 10) || 1),
      column: Math.max(1, parseInt(loc[3], 10) || 1),
      severity: head[1] === 'error' ? 'error' : 'warning',
      message: head[3],
      code: head[2]
    })
    i++ // consume the location line
  }
  return out
}

export function parseDiagnostics(stderr: string, max = 500): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  if (!stderr) return diagnostics

  const lines = stderr.split(/\r?\n/)
  for (const rawLine of lines) {
    const m = LINE_RE.exec(rawLine)
    if (!m) continue

    const [, file, lineStr, colStr, sevRaw, rest] = m

    // A trailing "[-Wflag]" identifies the warning; pull it out as `code`.
    let message = rest
    let code: string | undefined
    const codeMatch = CODE_RE.exec(message)
    if (codeMatch) {
      code = codeMatch[1]
      message = message.slice(0, codeMatch.index).trimEnd()
    }

    diagnostics.push({
      file,
      line: Math.max(1, parseInt(lineStr, 10) || 1),
      column: colStr ? Math.max(1, parseInt(colStr, 10) || 1) : 1,
      severity: normalizeSeverity(sevRaw),
      message,
      code
    })

    if (diagnostics.length >= max) break
  }

  // gcc/clang and rustc never both appear in one stderr, so only pay for the
  // second pass when the first found nothing.
  if (diagnostics.length === 0) return parseRustDiagnostics(lines, max)
  return diagnostics
}

/** Count errors/warnings for badges. */
export function summarize(diagnostics: Diagnostic[]): { errors: number; warnings: number } {
  let errors = 0
  let warnings = 0
  for (const d of diagnostics) {
    if (d.severity === 'error') errors++
    else if (d.severity === 'warning') warnings++
  }
  return { errors, warnings }
}
