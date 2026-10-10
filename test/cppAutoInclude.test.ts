import { describe, expect, it } from 'vitest'
import { cppHeadersForChanges, planCppAutoIncludes } from '../src/shared/cppAutoInclude'

function headersAt(source: string, token: string): string[] {
  const start = source.lastIndexOf(token)
  expect(start).toBeGreaterThanOrEqual(0)
  return cppHeadersForChanges(source, [{ start, end: start + token.length }])
}

function withIncludes(source: string, headers: readonly string[]): string {
  const plan = planCppAutoIncludes(source, headers)
  expect(plan).not.toBeNull()
  return source.slice(0, plan!.offset) + plan!.text + source.slice(plan!.offset)
}

describe('cppHeadersForChanges', () => {
  it.each([
    ['std::mutex lock;', 'mutex'],
    ['std::this_thread::sleep_for(delay);', 'thread'],
    ['std::thread worker(task);', 'thread'],
    ['std::chrono::milliseconds delay(10);', 'chrono'],
    ['std::vector<int> values;', 'vector'],
    ['std::unique_ptr<int> value;', 'memory'],
    ['auto value = std::make_unique<int>(1);', 'memory'],
    ['std::cout << "ready";', 'iostream']
  ])('recognizes %s as <%s>', (source, header) => {
    expect(cppHeadersForChanges(source, [{ start: 0, end: source.length }])).toEqual([header])
  })

  it('recognizes the completed token when only its final character changed', () => {
    const source = 'void run() { std::mutex'
    expect(cppHeadersForChanges(source, [{ start: source.length - 1, end: source.length }])).toEqual(['mutex'])
  })

  it('only considers symbols touched by the current edit', () => {
    const source = 'std::mutex oldLock;\nstd::vector<int> values;'
    expect(headersAt(source, 'vector')).toEqual(['vector'])
    expect(headersAt(source, 'values')).toEqual([])
  })

  it('collects every required header in a pasted block without duplicates', () => {
    const source = 'std::mutex first;\nstd::mutex second;\nstd::this_thread::sleep_for(std::chrono::milliseconds(10));'
    const headers = cppHeadersForChanges(source, [{ start: 0, end: source.length }])
    expect(new Set(headers)).toEqual(new Set(['mutex', 'thread', 'chrono']))
    expect(headers).toHaveLength(3)
  })

  it.each([
    'std::mutex_custom value;',
    'std::unknown_type value;',
    'mystd::mutex value;',
    'mutex value;'
  ])('does not guess a header for %s', (source) => {
    expect(cppHeadersForChanges(source, [{ start: 0, end: source.length }])).toEqual([])
  })

  it.each([
    '// std::mutex value;',
    '/* std::mutex value; */',
    '/* std::mutex value;',
    'const char* message = "std::mutex";',
    'const char* message = "escaped \\" std::mutex";',
    "const auto value = 'std::mutex';",
    'const char* message = R"(std::mutex)";',
    'const char* message = u8R"tag(std::mutex)tag";',
    'const char* message = "std::mutex',
    'const char* message = R"tag(std::mutex'
  ])('ignores a symbol inside comments or literals: %s', (source) => {
    expect(cppHeadersForChanges(source, [{ start: 0, end: source.length }])).toEqual([])
  })

  it('still detects real code after a string containing comment delimiters', () => {
    const source = 'const char* url = "https://example.test/*sample*/";\nstd::mutex lock;'
    expect(headersAt(source, 'mutex')).toEqual(['mutex'])
  })
})

describe('planCppAutoIncludes', () => {
  it('appends a missing header beside the existing top includes', () => {
    const source = '#include <iostream>\n\nint main() { std::mutex lock; }\n'
    expect(withIncludes(source, ['mutex'])).toBe('#include <iostream>\n#include <mutex>\n\nint main() { std::mutex lock; }\n')
  })

  it('places new includes before code when the file has no includes', () => {
    const source = 'int main() { std::mutex lock; }\n'
    expect(withIncludes(source, ['mutex'])).toBe('#include <mutex>\n\nint main() { std::mutex lock; }\n')
  })

  it('does not duplicate a header that is already included', () => {
    const source = '#include <mutex>\nstd::mutex lock;'
    expect(planCppAutoIncludes(source, ['mutex'])).toBeNull()
  })

  it('recognizes whitespace and quoted include spelling', () => {
    const source = '#  include "mutex"\nstd::mutex lock;'
    expect(planCppAutoIncludes(source, ['mutex'])).toBeNull()
  })

  it('deduplicates requested headers and retains only currently used known headers', () => {
    const source = 'std::mutex lock;\nstd::vector<int> values;'
    const plan = planCppAutoIncludes(source, ['mutex', 'mutex', 'vector', 'thread', 'made-up'])
    expect(plan?.headers).toEqual(['mutex', 'vector'])
    expect(withIncludes(source, ['mutex', 'mutex', 'vector', 'thread', 'made-up'])).toBe(
      '#include <mutex>\n#include <vector>\n\nstd::mutex lock;\nstd::vector<int> values;'
    )
  })

  it('rechecks the code before applying a deferred request', () => {
    expect(planCppAutoIncludes('int main() {}', ['mutex'])).toBeNull()
    expect(planCppAutoIncludes('// std::mutex lock;', ['mutex'])).toBeNull()
    expect(planCppAutoIncludes('std::mutex_custom lock;', ['mutex'])).toBeNull()
  })

  it('does not treat a block-commented include as an existing header', () => {
    const source = '/*\n#include <mutex>\n*/\nstd::mutex lock;'
    const result = withIncludes(source, ['mutex'])
    expect(result).toContain('*/\n#include <mutex>\n')
  })

  it('does not treat raw-string include text as an existing header', () => {
    const source = 'const char* text = R"(\n#include <mutex>\n)";\nstd::mutex lock;'
    expect(withIncludes(source, ['mutex'])).toBe('#include <mutex>\n\n' + source)
  })

  it('does not rely on an include hidden in a conditional', () => {
    const source = '#if WITH_MUTEX\n#include <mutex>\n#endif\nstd::mutex lock;'
    expect(withIncludes(source, ['mutex'])).toBe('#include <mutex>\n\n' + source)
  })

  it('preserves a leading license comment', () => {
    const source = '/* Copyright Example */\n\nstd::mutex lock;'
    const result = withIncludes(source, ['mutex'])
    expect(result.startsWith('/* Copyright Example */\n')).toBe(true)
    expect(result.indexOf('#include <mutex>')).toBeGreaterThan(result.indexOf('*/'))
    expect(result.indexOf('#include <mutex>')).toBeLessThan(result.indexOf('std::mutex'))
  })

  it('keeps a pragma-once directive ahead of generated includes', () => {
    const source = '#pragma once\n\nstd::mutex lock;'
    const result = withIncludes(source, ['mutex'])
    expect(result.startsWith('#pragma once\n')).toBe(true)
    expect(result.indexOf('#include <mutex>')).toBeGreaterThan(result.indexOf('#pragma once'))
  })

  it('places includes inside an ordinary header guard', () => {
    const source = '#ifndef EXAMPLE_H\n#define EXAMPLE_H\n\nstd::mutex lock;\n#endif\n'
    const result = withIncludes(source, ['mutex'])
    expect(result.indexOf('#include <mutex>')).toBeGreaterThan(result.indexOf('#define EXAMPLE_H'))
    expect(result.indexOf('#include <mutex>')).toBeLessThan(result.indexOf('std::mutex'))
  })

  it('recognizes an existing include inside the file header guard', () => {
    const source = '#ifndef EXAMPLE_H\n#define EXAMPLE_H\n#include <mutex>\nstd::mutex lock;\n#endif\n'
    expect(planCppAutoIncludes(source, ['mutex'])).toBeNull()
  })

  it('preserves a byte-order mark as the first character', () => {
    const source = '\uFEFFstd::mutex lock;'
    const result = withIncludes(source, ['mutex'])
    expect(result).toBe('\uFEFF#include <mutex>\n\nstd::mutex lock;')
  })

  it('uses the existing CRLF line ending for inserted headers', () => {
    const source = '#include <iostream>\r\n\r\nstd::mutex lock;\r\n'
    expect(withIncludes(source, ['mutex'])).toBe('#include <iostream>\r\n#include <mutex>\r\n\r\nstd::mutex lock;\r\n')
  })

  it('makes no edit for an empty request or empty source', () => {
    expect(planCppAutoIncludes('std::mutex lock;', [])).toBeNull()
    expect(planCppAutoIncludes('', ['mutex'])).toBeNull()
  })
})
