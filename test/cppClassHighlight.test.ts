import { describe, expect, it } from 'vitest'
import type { editor } from 'monaco-editor'
import { attachCppClassHighlight, curatedClassRanges } from '../src/renderer/src/monaco/cppClassHighlight'

describe('curated C++ class highlighting', () => {
  it('colors Servo in code only when its actual header is included', () => {
    const source = '#include <ESP32Servo.h>\nServo my_s;\nmy_s.write(90);\n'
    const start = source.indexOf('\nServo') + 1
    expect(curatedClassRanges(source)).toEqual([{ start, end: start + 5 }])
    expect(curatedClassRanges('Servo my_s;')).toEqual([])
  })

  it('ignores comments, strings, fake includes, and foreign qualified names', () => {
    const source = '#include <ESP32Servo.h>\n// Servo\nconst char* s = "Servo";\nother::Servo x;\nobj.Servo();\nServo actual;'
    const start = source.lastIndexOf('Servo')
    expect(curatedClassRanges(source)).toEqual([{ start, end: start + 5 }])
    expect(curatedClassRanges('// #include <ESP32Servo.h>\nServo x;')).toEqual([])
    expect(curatedClassRanges('const char* s = "#include <ESP32Servo.h>";\nServo x;')).toEqual([])
  })

  it('colors _t library types and types the file declares', () => {
    const source = [
      '#include "esp_camera.h"',
      'camera_config_t cam = {};',
      'enum class State { Effective };',
      'struct Object { State status; };',
      'typedef struct { int x; } Point;',
      'typedef unsigned long Ticks;',
      'using Callback = void (*)(int);',
      'esp_err_t err = esp_camera_init(&cam);',
      'Point p; Ticks t; Callback cb;',
      'obj.size_t = 1; // State in a comment',
      'const char* s = "Object";'
    ].join('\n')
    const colored = curatedClassRanges(source).map(({ start, end }) => source.slice(start, end))
    expect(colored).toEqual([
      'camera_config_t', 'State', 'Object', 'State', 'Point', 'Ticks', 'Callback',
      'esp_err_t', 'Point', 'Ticks', 'Callback'
    ])
  })

  it('refreshes decorations as the code changes and clears them on dispose', () => {
    let source = '#include <ESP32Servo.h>\nServo my_s;'
    let onChange = (): void => {}
    const applied: Array<Array<editor.IModelDeltaDecoration>> = []
    const model = {
      getValue: () => source,
      getLanguageId: () => 'cpp',
      isDisposed: () => false,
      getPositionAt: (offset: number) => {
        const before = source.slice(0, offset)
        const lastNewline = before.lastIndexOf('\n')
        return { lineNumber: before.split('\n').length, column: offset - lastNewline }
      }
    }
    const instance = {
      getModel: () => model,
      createDecorationsCollection: () => ({ set: (items: editor.IModelDeltaDecoration[]) => applied.push(items) }),
      onDidChangeModelContent: (listener: () => void) => { onChange = listener; return { dispose: () => {} } },
      onDidChangeModel: () => ({ dispose: () => {} })
    } as unknown as editor.IStandaloneCodeEditor
    const attached = attachCppClassHighlight(instance)
    expect(applied.at(-1)).toMatchObject([{ options: { inlineClassName: 'cortex-cpp-class-token' } }])
    source = 'Servo my_s;'
    onChange()
    expect(applied.at(-1)).toEqual([])
    attached.dispose()
    expect(applied.at(-1)).toEqual([])
  })
})
