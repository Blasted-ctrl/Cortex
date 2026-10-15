/**
 * Plain-English "what's going on and what to do" lines appended to editor
 * diagnostics. Pure and dependency-free so the rules are unit-tested; the
 * renderer appends the result to the clangd message before it becomes a marker.
 *
 * Add a rule by returning a string from `diagnosticHint` for a message shape.
 * A rule must only claim what Cortex can back up: these are hints about the
 * editor's analysis, not a statement that the build itself fails.
 */

import { libForDiagnostic } from './nativeLibs'

/** Headers people commonly mistype or expect; matched case-insensitively. */
export const COMMON_HEADERS: readonly string[] = [
  'Arduino.h',
  'Wire.h',
  'SPI.h',
  'Servo.h',
  'ESP32Servo.h',
  'WiFi.h',
  'SoftwareSerial.h',
  'EEPROM.h',
  'SD.h',
  'LiquidCrystal.h',
  'Stepper.h',
  'Adafruit_Sensor.h',
  'freertos/FreeRTOS.h',
  'freertos/task.h'
]

const NOT_FOUND = /^'([^']+)' file not found/

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return dp[a.length][b.length]
}

/** The known header closest to `name` (within 2 edits), or null. */
export function closestHeader(name: string, candidates: readonly string[] = COMMON_HEADERS): string | null {
  const lower = name.toLowerCase()
  let best: { header: string; d: number } | null = null
  for (const header of candidates) {
    const d = editDistance(lower, header.toLowerCase())
    if (d <= 2 && (!best || d < best.d)) best = { header, d }
  }
  return best ? best.header : null
}

export interface HintContext {
  /** Extra header names to suggest from (e.g. the project's own headers). */
  candidates?: readonly string[]
  /** A platformio.ini sits at the project root. */
  platformio?: boolean
  /** PlatformIO has already generated a compile_commands.json at the project root. */
  compilationDatabase?: boolean
}

/** A fix suggestion for a clangd message, or null when no rule applies. */
export function diagnosticHint(message: string, ctx: HintContext = {}): string | null {
  const native = libForDiagnostic(message)
  if (native) {
    return `Fix: ${native.lib.name} is not installed for ${native.target === 'cpp' ? 'C/C++' : 'Python'}. Press Ctrl+. and choose "Install ${native.lib.name}", or open Settings > Libraries. Cortex then sets up the include and link paths for you.`
  }
  const missing = NOT_FOUND.exec(message)?.[1]
  if (!missing) return null

  const pool = [...(ctx.candidates ?? []), ...COMMON_HEADERS]
  const near = closestHeader(missing, pool)
  if (near && near !== missing) {
    return near.toLowerCase() === missing.toLowerCase()
      ? `Fix: header names are case-sensitive on Linux/macOS builds. Write <${near}>.`
      : `Fix: did you mean <${near}>? "${missing}" does not exist, so this is most likely a typo.`
  }

  const boardCore = ['arduino.h', 'wire.h', 'spi.h', 'wifi.h', 'eeprom.h'].includes(missing.toLowerCase())
  if (boardCore) {
    return ctx.platformio
      ? ctx.compilationDatabase
        ? `Fix: the compile database already exists. Save this file, then check that its compile command uses the selected board's core headers. Cortex reloads clangd when the database changes.`
        : `Fix: ${missing} ships with the board core, which the editor cannot see yet. Run \`pio run -t compiledb\` once so IntelliSense gets the real include paths. This only affects editor squiggles if the project already builds.`
      : `Fix: ${missing} ships with the board core. Install the matching core in Boards Manager (or build once) so IntelliSense can find it.`
  }

  return `Fix: check the spelling, install the library that provides ${missing}, or put the file in this project's include/ or lib/ folder.`
}

/** Message with its hint appended on a new paragraph, or unchanged. */
export function withDiagnosticHint(message: string, ctx?: HintContext): string {
  const hint = diagnosticHint(message, ctx)
  return hint ? `${message}\n\n${hint}` : message
}
