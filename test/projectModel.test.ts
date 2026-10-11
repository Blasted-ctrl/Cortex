import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parsePlatformioIni, scanPins, scanBuses, scanIncludes, buildProjectModel } from '../src/main/services/projectModelService'
import type { PinUsage, BusUsage, LibraryUsage } from '../src/shared/ipc'

const electron = vi.hoisted(() => ({ userData: '' }))
vi.mock('electron', () => ({ app: {
  isPackaged: false,
  getPath: (name: string) => {
    if (name !== 'userData' || !electron.userData) throw new Error('Unexpected Electron path')
    return electron.userData
  }
} }))

describe('parsePlatformioIni', () => {
  it('reads board/platform/framework from a single env', () => {
    const boards = parsePlatformioIni(
      ['[env:esp32dev]', 'board = esp32dev', 'platform = espressif32', 'framework = arduino'].join('\n')
    )
    expect(boards).toEqual([{ name: 'esp32dev', platform: 'espressif32', framework: 'arduino', source: 'platformio.ini', env: 'esp32dev' }])
  })

  it('reads multiple [env:] sections independently', () => {
    const boards = parsePlatformioIni(
      [
        '[env:uno]',
        'board = uno',
        'platform = atmelavr',
        '',
        '[env:esp32dev]',
        'board = esp32dev',
        'platform = espressif32'
      ].join('\n')
    )
    expect(boards.map((b) => b.name)).toEqual(['uno', 'esp32dev'])
    expect(boards[1].framework).toBeUndefined()
  })

  it('ignores non-env sections and stray keys outside any [env:] block', () => {
    const boards = parsePlatformioIni(['board = should_not_count', '[platformio]', 'default_envs = uno', '[env:uno]', 'board = uno'].join('\n'))
    expect(boards).toEqual([{ name: 'uno', platform: undefined, framework: undefined, source: 'platformio.ini', env: 'uno' }])
  })

  it('strips ; comments', () => {
    const boards = parsePlatformioIni(['[env:uno] ; the classic', 'board = uno ; Arduino Uno'].join('\n'))
    expect(boards[0].name).toBe('uno')
  })

  it('drops an [env:] with no board key rather than emitting a half-populated entry', () => {
    const boards = parsePlatformioIni(['[env:uno]', 'platform = atmelavr'].join('\n'))
    expect(boards).toEqual([])
  })

  it('returns nothing for an empty or unrelated file', () => {
    expect(parsePlatformioIni('')).toEqual([])
    expect(parsePlatformioIni('# just a comment\nkey=value')).toEqual([])
  })
})

describe('scanPins', () => {
  it('finds pinMode with its mode argument', () => {
    const out: PinUsage[] = []
    scanPins('main.cpp', 'pinMode(13, OUTPUT);', out, 100)
    expect(out).toEqual([{ file: 'main.cpp', line: 1, pin: '13', role: 'pinMode', mode: 'OUTPUT' }])
  })

  it('finds digitalWrite/digitalRead/analogWrite/analogRead without a mode field', () => {
    const out: PinUsage[] = []
    scanPins('m.cpp', 'digitalWrite(LED_BUILTIN, HIGH);\nanalogRead(A0);', out, 100)
    expect(out.map((p) => ({ pin: p.pin, role: p.role, mode: p.mode }))).toEqual([
      { pin: 'LED_BUILTIN', role: 'digitalWrite', mode: undefined },
      { pin: 'A0', role: 'analogRead', mode: undefined }
    ])
  })

  it('records the correct 1-indexed line number for each match', () => {
    const out: PinUsage[] = []
    scanPins('m.cpp', 'int x = 1;\nint y = 2;\npinMode(5, INPUT);', out, 100)
    expect(out[0].line).toBe(3)
  })

  it('stops at the cap mid-scan without throwing', () => {
    const out: PinUsage[] = []
    const lines = Array.from({ length: 10 }, (_, i) => `digitalWrite(${i}, HIGH);`).join('\n')
    scanPins('m.cpp', lines, out, 3)
    expect(out).toHaveLength(3)
  })

  it('does not match a similarly-named identifier that is not actually the call', () => {
    const out: PinUsage[] = []
    scanPins('m.cpp', 'int notPinMode = 5;\nmyDigitalWriteWrapper(1);', out, 100)
    expect(out).toEqual([])
  })
})

describe('scanBuses', () => {
  it('finds Wire begin/beginTransmission/requestFrom with literal addresses', () => {
    const out: BusUsage[] = []
    scanBuses('m.cpp', 'Wire.begin();\nWire.beginTransmission(0x3C);\nWire.requestFrom(0x3C, 6);', out, 100)
    expect(out.map((b) => ({ role: b.role, address: b.address }))).toEqual([
      { role: 'begin', address: undefined },
      { role: 'beginTransmission', address: '0x3C' },
      { role: 'requestFrom', address: '0x3C' }
    ])
  })

  it('does not record a variable or #define as an address', () => {
    const out: BusUsage[] = []
    scanBuses('m.cpp', 'Wire.beginTransmission(MPU_ADDR);', out, 100)
    expect(out).toHaveLength(1)
    expect(out[0].address).toBeUndefined()
  })

  it('does not treat Wire.begin(arg) first arg as an address (ambiguous: AVR slave addr vs ESP32 SDA pin)', () => {
    const out: BusUsage[] = []
    scanBuses('m.cpp', 'Wire.begin(21, 22);', out, 100)
    expect(out[0].address).toBeUndefined()
  })

  it('separates Wire and Wire1 instances', () => {
    const out: BusUsage[] = []
    scanBuses('m.cpp', 'Wire.begin();\nWire1.begin();', out, 100)
    expect(out.map((b) => b.instance)).toEqual(['Wire', 'Wire1'])
  })

  it('finds SPI calls and Serial.begin with its baud rate', () => {
    const out: BusUsage[] = []
    scanBuses('m.cpp', 'SPI.begin();\nSPI.transfer(0xFF);\nSerial2.begin(9600);', out, 100)
    expect(out.map((b) => ({ bus: b.bus, instance: b.instance, baud: b.baud }))).toEqual([
      { bus: 'spi', instance: 'SPI', baud: undefined },
      { bus: 'spi', instance: 'SPI', baud: undefined },
      { bus: 'uart', instance: 'Serial2', baud: 9600 }
    ])
  })

  it('still records a UART whose baud is a macro or variable, just without the number', () => {
    const out: BusUsage[] = []
    scanBuses('m.cpp', 'Serial1.begin(GPS_BAUD);\nSerial.begin(config.baud);', out, 100)
    expect(out.map((b) => ({ instance: b.instance, baud: b.baud }))).toEqual([
      { instance: 'Serial1', baud: undefined },
      { instance: 'Serial', baud: undefined }
    ])
  })

  it('ignores bus calls in // comments and string literals', () => {
    const out: BusUsage[] = []
    scanBuses(
      'm.cpp',
      '// Wire.beginTransmission(0x27);\nSerial.println("try Wire.begin() first");\nWire.begin(); // real',
      out,
      100
    )
    expect(out).toEqual([{ file: 'm.cpp', line: 3, bus: 'i2c', instance: 'Wire', role: 'begin' }])
  })

  it('does not match lookalike identifiers', () => {
    const out: BusUsage[] = []
    scanBuses('m.cpp', 'myWire.begin();\nOneWire.begin();\nSerialLogger.begin(1);', out, 100)
    expect(out).toEqual([])
  })

  it('stops at the cap', () => {
    const out: BusUsage[] = []
    scanBuses('m.cpp', Array.from({ length: 10 }, () => 'SPI.transfer(1);').join('\n'), out, 3)
    expect(out).toHaveLength(3)
  })
})

describe('scanIncludes', () => {
  it('captures both <> and "" include targets with line numbers', () => {
    const out: LibraryUsage[] = []
    scanIncludes('m.cpp', '#include <Wire.h>\n#include "config.h"\nint x;', out, 100)
    expect(out).toEqual([
      { file: 'm.cpp', line: 1, header: 'Wire.h' },
      { file: 'm.cpp', line: 2, header: 'config.h' }
    ])
  })

  it('keeps subdirectory include paths verbatim', () => {
    const out: LibraryUsage[] = []
    scanIncludes('m.cpp', '#include <freertos/task.h>', out, 100)
    expect(out[0].header).toBe('freertos/task.h')
  })

  it('accepts legal whitespace between # and include', () => {
    const out: LibraryUsage[] = []
    scanIncludes('m.cpp', '#  include <Adafruit_MPU6050.h>\n#\tinclude "cfg.h"', out, 100)
    expect(out.map((l) => l.header)).toEqual(['Adafruit_MPU6050.h', 'cfg.h'])
  })

  it('ignores commented-out and malformed includes', () => {
    const out: LibraryUsage[] = []
    scanIncludes('m.cpp', '// #include <Wire.h> is handled elsewhere\n#include Wire.h', out, 100)
    expect(out).toEqual([])
  })
})

describe('buildProjectModel', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cortex-model-'))
    electron.userData = join(root, 'owned-user-data')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('combines language breakdown, board (from platformio.ini), and a pin scan of real source files', async () => {
    writeFileSync(join(root, 'platformio.ini'), ['[env:uno]', 'board = uno', 'platform = atmelavr', 'framework = arduino'].join('\n'), 'utf8')
    mkdirSync(join(root, 'src'))
    writeFileSync(
      join(root, 'src', 'main.cpp'),
      ['void setup() {', '  pinMode(13, OUTPUT);', '  digitalWrite(13, HIGH);', '}', 'void loop() {}'].join('\n'),
      'utf8'
    )
    writeFileSync(join(root, 'src', 'helper.py'), 'print("hi")\n', 'utf8')

    const model = await buildProjectModel(root)

    expect(model.boards).toEqual([{ name: 'uno', platform: 'atmelavr', framework: 'arduino', source: 'platformio.ini', env: 'uno' }])
    expect(model.languages.find((l) => l.id === 'cpp')?.fileCount).toBe(1)
    expect(model.languages.find((l) => l.id === 'python')?.fileCount).toBe(1)
    expect(model.pins.map((p) => p.role).sort()).toEqual(['digitalWrite', 'pinMode'])
    expect(model.pinsTruncated).toBe(false)
    // Real toolchain probing (whatever's actually installed on this machine) -
    // just assert the shape, not specific contents, so this isn't tied to CI's toolset.
    expect(Array.isArray(model.toolchains)).toBe(true)
  })

  it('excludes .pio and build directories from language breakdown and pin scan, so a vendored library is not counted as project code', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'main.cpp'), 'void setup() { pinMode(13, OUTPUT); }\nvoid loop() {}\n', 'utf8')
    mkdirSync(join(root, '.pio', 'libdeps', 'esp32dev', 'ESP32Servo', 'examples', 'AnalogWrite'), { recursive: true })
    writeFileSync(
      join(root, '.pio', 'libdeps', 'esp32dev', 'ESP32Servo', 'examples', 'AnalogWrite', 'AnalogWrite.ino'),
      'void setup() { pinMode(5, OUTPUT); analogWrite(5, 128); }\n',
      'utf8'
    )
    writeFileSync(join(root, '.pio', 'libdeps', 'esp32dev', 'ESP32Servo', 'examples', 'AnalogWrite', 'notes.py'), 'print("vendored")\n', 'utf8')
    mkdirSync(join(root, 'build'), { recursive: true })
    writeFileSync(join(root, 'build', 'generated.cpp'), 'void setup() { digitalWrite(2, HIGH); }\n', 'utf8')

    const model = await buildProjectModel(root)

    expect(model.languages.find((l) => l.id === 'cpp')?.fileCount).toBe(1)
    expect(model.languages.find((l) => l.id === 'python')).toBeUndefined()
    expect(model.pins).toEqual([{ file: join('src', 'main.cpp'), line: 1, pin: '13', role: 'pinMode', mode: 'OUTPUT' }])
  })

  it('reports no boards when there is no platformio.ini, rather than guessing one', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'main.cpp'), '#include <Arduino.h>\nvoid setup() {}\nvoid loop() {}\n', 'utf8')

    const model = await buildProjectModel(root)
    expect(model.boards).toEqual([])
  })

  it('returns an empty, well-formed model for an empty workspace', async () => {
    const model = await buildProjectModel(root)
    expect(model).toEqual({
      languages: [],
      boards: [],
      pins: [],
      pinsTruncated: false,
      buses: [],
      busesTruncated: false,
      libraries: [],
      librariesTruncated: false,
      toolchains: model.toolchains // shape-only, see above
    })
  })

  it('collects bus usage and driver includes from source files', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(
      join(root, 'src', 'main.cpp'),
      [
        '#include <Wire.h>',
        '#include <Adafruit_MPU6050.h>',
        'void setup() {',
        '  Wire.begin();',
        '  Wire.beginTransmission(0x68);',
        '  Serial.begin(115200);',
        '}'
      ].join('\n'),
      'utf8'
    )

    const model = await buildProjectModel(root)
    expect(model.buses.map((b) => ({ bus: b.bus, instance: b.instance, role: b.role }))).toEqual([
      { bus: 'i2c', instance: 'Wire', role: 'begin' },
      { bus: 'i2c', instance: 'Wire', role: 'beginTransmission' },
      { bus: 'uart', instance: 'Serial', role: 'begin' }
    ])
    expect(model.buses[1].address).toBe('0x68')
    expect(model.buses[2].baud).toBe(115200)
    expect(model.libraries.map((l) => l.header)).toEqual(['Wire.h', 'Adafruit_MPU6050.h'])
    expect(model.busesTruncated).toBe(false)
    expect(model.librariesTruncated).toBe(false)
  })
})
