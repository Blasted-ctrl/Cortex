import { describe, it, expect } from 'vitest'
import {
  includedHeaders,
  indexLibraries,
  indexLibraryFunctions,
  libEntryEnabled,
  librarySuggestions,
  stripCommentsAndStrings,
  type LibraryDict
} from '../src/shared/libraryComplete'
import cppLibraries from '../src/shared/stdlib/cpp-libraries.json'

// A small fixture shaped like the real OpenCV and raylib entries.
const NS_DICT: LibraryDict = {
  'opencv.hpp': {
    headers: ['imgproc.hpp'],
    namespace: 'cv',
    classes: {
      Mat: { description: 'image', members: { clone: { description: 'copy', signature: 'Mat clone() const' }, zeros: { description: 'zeros' } } }
    },
    functions: { imread: { description: 'load', signature: 'Mat imread(const String& f)' } }
  },
  'raylib.h': { classes: {}, functions: { InitWindow: { description: 'window' } } }
}
const nsIdx = indexLibraries(NS_DICT)
const nsFns = indexLibraryFunctions(NS_DICT)
const suggest = (code: string, prefix: string): string[] => {
  const clean = stripCommentsAndStrings(code)
  return librarySuggestions(nsIdx, clean, prefix, includedHeaders(clean), nsFns).map((s) => `${s.kind}:${s.name}`)
}

describe('libEntryEnabled', () => {
  it('is enabled by the main header or any alias, and not by an unrelated one', () => {
    const entry = nsIdx.get('Mat')!
    expect(libEntryEnabled(entry, new Set(['opencv.hpp']))).toBe(true)
    expect(libEntryEnabled(entry, new Set(['imgproc.hpp']))).toBe(true)
    expect(libEntryEnabled(entry, new Set(['wire.h']))).toBe(false)
  })
})

describe('namespace-qualified suggestions', () => {
  const inc = '#include <opencv2/opencv.hpp>\n'
  it('offers the functions and classes of the namespace after "cv::"', () => {
    expect(suggest(inc, 'cv::')).toEqual(['function:imread', 'class:Mat'])
    expect(suggest(inc, '  cv::im')).toContain('function:imread')
  })
  it('is enabled by an alias header alone', () => {
    expect(suggest('#include <opencv2/imgproc.hpp>\n', 'cv::')).toContain('function:imread')
  })
  it('offers nothing without an include', () => {
    expect(suggest('int x;\n', 'cv::')).toEqual([])
  })
  it('gives nothing to a foreign or nested qualifier', () => {
    expect(suggest(inc, 'other::')).toEqual([])
    expect(suggest(inc, 'std::')).toEqual([])
    expect(suggest(inc, 'other::cv::')).toEqual([])
  })
  it('does not treat a member access chain as a namespace', () => {
    expect(suggest(inc, 'obj.cv::')).toEqual([])
  })
  it('carries the namespace on function suggestions and an empty owner for global C functions', () => {
    const clean = inc + '#include <raylib.h>\n'
    const all = librarySuggestions(nsIdx, clean, '  ', includedHeaders(clean), nsFns)
    expect(all.find((s) => s.name === 'InitWindow')).toMatchObject({ kind: 'function', className: '' })
    const cv = librarySuggestions(nsIdx, clean, 'cv::', includedHeaders(clean), nsFns)
    expect(cv.find((s) => s.name === 'imread')).toMatchObject({ kind: 'function', className: 'cv', signature: 'Mat imread(const String& f)' })
  })
})

describe('static class members', () => {
  const inc = '#include <opencv2/opencv.hpp>\n'
  it('offers members after "cv::Mat::"', () => {
    expect(suggest(inc, 'cv::Mat::')).toEqual(['member:clone', 'member:zeros'])
  })
  it('offers members after "Mat::" only when the namespace is in use', () => {
    expect(suggest(inc, 'Mat::')).toEqual([])
    expect(suggest(inc + 'using namespace cv;\n', 'Mat::')).toEqual(['member:clone', 'member:zeros'])
  })
  it("does not give another namespace's Mat the OpenCV members", () => {
    expect(suggest(inc, 'foo::Mat::')).toEqual([])
  })
})

describe('using namespace and global functions', () => {
  const inc = '#include <opencv2/opencv.hpp>\n'
  it('offers unqualified OpenCV names only after "using namespace cv;"', () => {
    expect(suggest(inc, '  ')).toEqual([])
    expect(suggest(inc + 'using namespace cv;\n', '  ')).toEqual(['class:Mat', 'function:imread'])
  })
  it('ignores a commented-out or quoted "using namespace cv;"', () => {
    expect(suggest(inc + '// using namespace cv;\n', '  ')).toEqual([])
    expect(suggest(inc + 'const char* s = "using namespace cv;";\n', '  ')).toEqual([])
  })
  it('offers global C functions as soon as their header is included', () => {
    expect(suggest('#include <raylib.h>\n', '  ')).toEqual(['function:InitWindow'])
    expect(suggest('int x;\n', '  ')).toEqual([])
  })
  it('does not offer them after a member access or a qualifier', () => {
    expect(suggest('#include <raylib.h>\n', 'obj.')).toEqual([])
    expect(suggest('#include <raylib.h>\n', 'foo::')).toEqual([])
  })
})

describe('receiver members of a namespaced class', () => {
  const inc = '#include <opencv2/opencv.hpp>\n'
  it('resolves cv::Mat declarations', () => {
    expect(suggest(inc + 'cv::Mat img;\n', 'img.')).toEqual(['member:clone', 'member:zeros'])
  })
  it('resolves a bare Mat only with "using namespace cv;"', () => {
    expect(suggest(inc + 'Mat img;\n', 'img.')).toEqual([])
    expect(suggest(inc + 'using namespace cv;\nMat img;\n', 'img.')).toEqual(['member:clone', 'member:zeros'])
  })
  it("does not attribute another namespace's Mat to OpenCV", () => {
    expect(suggest(inc + 'other::Mat img;\n', 'img.')).toEqual([])
    expect(suggest(inc + 'using namespace cv;\nother::Mat img;\n', 'img.')).toEqual([])
  })
  it('offers nothing when the header is not included', () => {
    expect(suggest('cv::Mat img;\n', 'img.')).toEqual([])
  })
})

describe('the shipped dictionary', () => {
  const dict = cppLibraries as LibraryDict
  const idx = indexLibraries(dict)
  const fns = indexLibraryFunctions(dict)
  it('documents OpenCV, raylib, SDL2 and GLFW with a signature, description, example and https link per function', () => {
    const owners = new Set(fns.map((f) => f.header))
    for (const h of ['opencv.hpp', 'raylib.h', 'sdl.h', 'glfw3.h']) expect(owners.has(h), h).toBe(true)
    for (const f of fns) {
      expect(f.def.signature, f.name).toBeTruthy()
      expect(f.def.description.length, f.name).toBeGreaterThan(30)
      expect(f.def.example, f.name).toBeTruthy()
      expect(f.def.docUrl, f.name).toMatch(/^https:\/\//)
    }
  })
  it('covers the OpenCV functions people reach for first', () => {
    const names = new Set(fns.filter((f) => f.namespace === 'cv').map((f) => f.name))
    for (const n of ['imread', 'imshow', 'waitKey', 'cvtColor', 'GaussianBlur', 'Canny', 'resize', 'findContours']) expect(names.has(n), n).toBe(true)
  })
  it('documents the camera class and gives every member a description', () => {
    const cap = idx.get('VideoCapture')!
    expect(cap.namespace).toBe('cv')
    expect(Object.keys(cap.def.members)).toEqual(expect.arrayContaining(['isOpened', 'read', 'release']))
    for (const [name, entry] of idx.entries()) {
      for (const [member, def] of Object.entries(entry.def.members)) expect(def.description.length, `${name}.${member}`).toBeGreaterThan(10)
    }
  })
  it('leaves the Servo entry unchanged', () => {
    expect(idx.get('Servo')?.header).toBe('esp32servo.h')
    expect(idx.get('Servo')?.namespace).toBeUndefined()
  })
})
