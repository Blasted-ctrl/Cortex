import { describe, it, expect } from 'vitest'
import {
  indexLibraries,
  includedHeaders,
  inferKnownType,
  librarySuggestions,
  libSuggestionDoc,
  stripCommentsAndStrings,
  type LibraryDict
} from '../src/shared/libraryComplete'
import cppLibraries from '../src/shared/stdlib/cpp-libraries.json'

const DICT = cppLibraries as LibraryDict
const idx = indexLibraries(DICT)

describe('indexLibraries', () => {
  it('maps each class name to its header and definition', () => {
    const servo = idx.get('Servo')
    expect(servo?.header).toBe('esp32servo.h')
    expect(servo?.def.members.writeMicroseconds).toBeDefined()
  })
})

describe('includedHeaders', () => {
  it('collects lowercased basenames from angle and quote includes', () => {
    const h = includedHeaders('#include <ESP32Servo.h>\n#include "sub/dir/Foo.h"\nint x;')
    expect(h.has('esp32servo.h')).toBe(true)
    expect(h.has('foo.h')).toBe(true)
  })
  it('accepts whitespace between # and include', () => {
    expect(includedHeaders('#  include <Wire.h>').has('wire.h')).toBe(true)
  })
  it('ignores commented-out includes', () => {
    expect(includedHeaders('// #include <Servo.h>').size).toBe(0)
  })
})

describe('inferKnownType', () => {
  const known = new Set(['Servo'])
  it('infers a plain declaration', () => {
    expect(inferKnownType('Servo myservo;', 'myservo', known)).toBe('Servo')
  })
  it('infers a constructor-call declaration', () => {
    expect(inferKnownType('Servo s(18);', 's', known)).toBe('Servo')
  })
  it('infers a reference or pointer with the sigil glued to the type', () => {
    expect(inferKnownType('Servo& r = getServo();', 'r', known)).toBe('Servo')
    expect(inferKnownType('Servo* p = &s;', 'p', known)).toBe('Servo')
  })
  it('infers a reference or pointer with the sigil glued to the variable (LLVM/C style)', () => {
    expect(inferKnownType('Servo *sp;', 'sp', known)).toBe('Servo')
    expect(inferKnownType('Servo &r = getServo();', 'r', known)).toBe('Servo')
    expect(inferKnownType('Servo * spaced;', 'spaced', known)).toBe('Servo')
  })
  it('infers a function parameter', () => {
    expect(inferKnownType('void move(Servo s) { s.write(0); }', 's', known)).toBe('Servo')
  })
  it('does not mis-split a glued identifier that only looks like Type+var', () => {
    // "Servosp" is one identifier, not "Servo sp"; a separator is required.
    expect(inferKnownType('int Servosp = 0;', 'sp', known)).toBeNull()
  })
  it('returns null for an unknown class', () => {
    expect(inferKnownType('Widget w;', 'w', known)).toBeNull()
  })
  it('returns null when there is no declaration (a bare use)', () => {
    expect(inferKnownType('myservo.write(90);', 'myservo', known)).toBeNull()
  })
})

describe('stripCommentsAndStrings', () => {
  it('removes block comments, line comments, and string bodies', () => {
    const src = '#include <A.h>\n/* #include <B.h> */\nchar* s = "Servo x;"; // #include <C.h>'
    const clean = stripCommentsAndStrings(src)
    expect(includedHeaders(clean).has('a.h')).toBe(true)
    expect(includedHeaders(clean).has('b.h')).toBe(false)
    expect(includedHeaders(clean).has('c.h')).toBe(false)
    // The declaration inside the string literal is gone.
    expect(inferKnownType(clean, 'x', new Set(['Servo']))).toBeNull()
  })
})

describe('librarySuggestions', () => {
  const withServo = '#include <ESP32Servo.h>\nServo myservo;\nvoid loop(){ myservo. }'

  it('offers the class members after a known-typed receiver dot', () => {
    const s = librarySuggestions(idx, withServo, '  myservo.')
    const names = s.map((x) => x.name)
    expect(s.every((x) => x.kind === 'member')).toBe(true)
    expect(names).toContain('write')
    expect(names).toContain('writeMicroseconds')
    expect(names).toContain('attach')
  })

  it('works through a pointer arrow', () => {
    const src = '#include <ESP32Servo.h>\nServo* sp;\nvoid f(){ sp-> }'
    expect(librarySuggestions(idx, src, '  sp->').map((x) => x.name)).toContain('write')
  })

  it('offers nothing after a dot when the header is not included', () => {
    const src = 'Servo myservo;\nvoid loop(){ myservo. }' // no include
    expect(librarySuggestions(idx, src, '  myservo.')).toEqual([])
  })

  it('offers nothing after a dot on an unknown-typed variable', () => {
    expect(librarySuggestions(idx, withServo, '  somethingElse.')).toEqual([])
  })

  it('suggests the class by name when its header is included and not after a dot', () => {
    const s = librarySuggestions(idx, '#include <ESP32Servo.h>\nServo ', 'Serv')
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ kind: 'class', name: 'Servo' })
  })

  it('does not suggest the class when its header is not included', () => {
    expect(librarySuggestions(idx, 'int main(){}', 'Serv')).toEqual([])
  })

  it('does not claim qualified classes or chained receivers as global Servo symbols', () => {
    expect(librarySuggestions(idx, withServo, 'other::Serv')).toEqual([])
    expect(librarySuggestions(idx, withServo, 'device.myservo.')).toEqual([])
  })
})

describe('libSuggestionDoc', () => {
  it('renders description, example, and a documentation link', () => {
    const s = librarySuggestions(idx, '#include <ESP32Servo.h>\nServo m;\nm.', '  m.').find((x) => x.name === 'attach')!
    const md = libSuggestionDoc(s)
    expect(md).toContain('Attaches the servo')
    expect(md).toContain('[Documentation]')
  })
})

describe('dictionary integrity', () => {
  it('uses lowercased .h or .hpp header keys and every class has members', () => {
    for (const [header, file] of Object.entries(DICT)) {
      expect(header).toBe(header.toLowerCase())
      expect(/\.h(pp)?$/.test(header)).toBe(true)
      for (const def of Object.values(file.classes)) {
        expect(def.description.length).toBeGreaterThan(0)
        expect(def.docUrl).toMatch(/^https:\/\//)
        expect(def.example).toContain('#include <')
        expect(Object.keys(def.members).length).toBeGreaterThan(0)
        for (const m of Object.values(def.members)) {
          expect(m.signature?.length).toBeGreaterThan(0)
          expect(m.description.length).toBeGreaterThan(0)
        }
      }
    }
  })
})
