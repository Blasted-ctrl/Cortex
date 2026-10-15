import { describe, it, expect } from 'vitest'
import { closestHeader, diagnosticHint, withDiagnosticHint } from '../src/shared/diagnosticHints'

describe('closestHeader', () => {
  it('finds a one-letter typo', () => {
    expect(closestHeader('ArduinoS.h')).toBe('Arduino.h')
  })
  it('is case-insensitive', () => {
    expect(closestHeader('arduino.h')).toBe('Arduino.h')
  })
  it('returns null when nothing is close', () => {
    expect(closestHeader('totally_unrelated.h')).toBeNull()
  })
})

describe('diagnosticHint', () => {
  it('suggests the real header for a typo', () => {
    expect(diagnosticHint("'ArduinoS.h' file not found")).toMatch(/did you mean <Arduino\.h>/)
  })
  it('flags a case mismatch', () => {
    expect(diagnosticHint("'arduino.h' file not found")).toMatch(/case-sensitive/)
  })
  it('points a PlatformIO project at compiledb for a board-core header', () => {
    expect(diagnosticHint("'Wire.h' file not found", { platformio: true })).toMatch(/pio run -t compiledb/)
  })
  it('does not ask for compiledb again when the database already exists', () => {
    const hint = diagnosticHint("'Arduino.h' file not found", { platformio: true, compilationDatabase: true })
    expect(hint).toMatch(/compile database already exists/)
    expect(hint).not.toMatch(/pio run -t compiledb/)
  })
  it('points a non-PlatformIO project at Boards Manager', () => {
    expect(diagnosticHint("'Wire.h' file not found")).toMatch(/Boards Manager/)
  })
  it('gives a generic fix for an unknown header', () => {
    expect(diagnosticHint("'my_driver.h' file not found")).toMatch(/spelling.*include\//)
  })
  it('suggests from caller-supplied project headers', () => {
    expect(diagnosticHint("'motor_ctl.h' file not found", { candidates: ['motor_ctrl.h'] })).toMatch(/<motor_ctrl\.h>/)
  })
  it('ignores unrelated messages', () => {
    expect(diagnosticHint("use of undeclared identifier 'x'")).toBeNull()
    expect(withDiagnosticHint("use of undeclared identifier 'x'")).toBe("use of undeclared identifier 'x'")
  })
  it('appends the hint after the original message', () => {
    expect(withDiagnosticHint("'ArduinoS.h' file not found")).toMatch(/^'ArduinoS\.h' file not found\n\nFix: /)
  })
})
