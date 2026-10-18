/**
 * Plain-English guidance for editor and compiler diagnostics. Pure and
 * dependency-free so the rules are unit-tested. The renderer appends guidance
 * to clangd markers and shows it beside compiler problems.
 *
 * Add a rule by returning a string from `diagnosticHint` for a message shape.
 * A rule must only claim what its context establishes: a failed compiler run
 * must not be described as an editor-only configuration issue.
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
  /** This diagnostic came from a compiler run rather than the language server. */
  build?: boolean
  /** This source includes the Arduino framework or is an Arduino sketch. */
  embedded?: boolean
}

const STREAM_NAMES = 'cout|cerr|clog|cin|endl'
const UNDECLARED_STREAM = new RegExp(`^Use of undeclared identifier '(${STREAM_NAMES})'`)
const NO_STD_STREAM = new RegExp(`^No member named '(${STREAM_NAMES})' in namespace 'std'`)
// clangd prints the left operand as 'ostream' (aka 'basic_ostream<char>'), sometimes with std::.
const BAD_STREAM_OPERAND = /^Invalid operands to binary expression \('(?:std::)?w?ostream'(?: \(aka '[^']*'\))? and '([^']+)'\)/

/** Hints for the most common stream (cout, cerr) errors. */
function streamHint(message: string): string | null {
  const bare = UNDECLARED_STREAM.exec(message)?.[1]
  if (bare) {
    return `Fix: ${bare} is declared in <iostream> and lives in namespace std. Add #include <iostream> and write std::${bare} (or put "using namespace std;" after the includes).`
  }
  const std = NO_STD_STREAM.exec(message)?.[1]
  if (std) return `Fix: std::${std} is declared in <iostream>. Add #include <iostream> at the top of the file.`
  const printed = BAD_STREAM_OPERAND.exec(message)?.[1]
  if (printed) {
    return `Fix: cout and cerr can only print types that define operator<<. Numbers, characters, C strings and std::string work; '${printed}' does not. For an enum class print static_cast<int>(value); for your own struct or class define "std::ostream& operator<<(std::ostream& os, const T& v)"; for an Arduino String use .c_str().`
  }
  return null
}

/** A fix suggestion for a clangd message, or null when no rule applies. */
export function diagnosticHint(message: string, ctx: HintContext = {}): string | null {
  const native = libForDiagnostic(message)
  if (native) {
    if (ctx.embedded && native.lib.id === 'opencv' && native.target === 'cpp') {
      return 'Fix: keep PC camera and window code in a separate desktop program. VideoCapture, imshow and waitKey use desktop camera/display services and cannot run as written in ESP32 Arduino firmware. Installing a PC OpenCV library does not add those services to the board.'
    }
    return `Fix: ${native.lib.name} is not installed for ${native.target === 'cpp' ? 'C/C++' : 'Python'}. Press Ctrl+. and choose "Install ${native.lib.name}", or open Settings > Libraries. Cortex then sets up the include and link paths for you.`
  }
  const stream = streamHint(message)
  if (stream) return stream
  const missing = NOT_FOUND.exec(message)?.[1] ?? /^([^:\r\n]+): No such file or directory/.exec(message)?.[1]
  if (!missing) return null

  if (ctx.platformio && missing === 'ESP32Servo.h') {
    return 'Fix: declare madhephaestus/ESP32Servo under lib_deps in platformio.ini (not libs_deps), select a library version compatible with your Arduino-ESP32 core, and build again. PlatformIO installs declared dependencies during the build.'
  }

  const pool = [...(ctx.candidates ?? []), ...COMMON_HEADERS]
  const near = closestHeader(missing, pool)
  if (near && near !== missing) {
    return near.toLowerCase() === missing.toLowerCase()
      ? `Fix: header names are case-sensitive on Linux/macOS builds. Write <${near}>.`
      : `Fix: did you mean <${near}>? "${missing}" does not exist, so this is most likely a typo.`
  }

  const boardCore = ['arduino.h', 'wire.h', 'spi.h', 'wifi.h', 'eeprom.h'].includes(missing.toLowerCase())
  if (boardCore) {
    if (ctx.platformio && ctx.build) {
      return `Fix: use this project's PlatformIO Build so the board core and framework provide ${missing}. If that build still cannot find it, check framework=arduino and the selected board in platformio.ini.`
    }
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
