import { describe, expect, it } from 'vitest'
import { cppHeadersForChanges, planCppAutoIncludes } from '../src/shared/cppAutoInclude'

function withIncludes(source: string, headers = ['mutex']): string {
  const edit = planCppAutoIncludes(source, headers)
  return edit ? source.slice(0, edit.offset) + edit.text + source.slice(edit.offset) : source
}

describe('C++ include placement regressions', () => {
  it.each(['\n', '\r\n'])('keeps backslash-continued line comments inactive with %j endings', (eol) => {
    const source = '// Still a comment \\' + eol + 'std::mutex disabled;' + eol
    expect(cppHeadersForChanges(source, [{ start: 0, end: source.length }])).toEqual([])
    expect(planCppAutoIncludes(source, ['mutex'])).toBeNull()
  })

  it.each(['\n', '\r\n'])('inserts after a continued comment instead of splitting it with %j endings', (eol) => {
    const prefix = '// Still a comment \\' + eol + 'std::mutex disabled;' + eol
    const source = prefix + 'std::mutex active;'
    expect(withIncludes(source)).toBe(prefix + '#include <mutex>' + eol + eol + 'std::mutex active;')
  })

  it('keeps generated headers outside a prefix that sets a default macro', () => {
    const prefix = '#ifndef SOME_OPTION\n#define SOME_OPTION\n#endif\n'
    const source = prefix + '\nstd::mutex lock;'
    expect(withIncludes(source)).toBe(prefix + '#include <mutex>\n\nstd::mutex lock;')
  })

  it('does not classify a full-file conditional with an else branch as a header guard', () => {
    const source = '#ifndef SOME_OPTION\n#define SOME_OPTION\nstd::mutex lock;\n#else\nstd::mutex other;\n#endif\n'
    expect(withIncludes(source)).toBe('#include <mutex>\n\n' + source)
  })

  it('preserves a leading standard-library configuration macro', () => {
    const source = '#define _GLIBCXX_DEBUG\nstd::vector<int> values;'
    expect(withIncludes(source, ['vector'])).toBe('#define _GLIBCXX_DEBUG\n#include <vector>\n\nstd::vector<int> values;')
  })

  it('preserves leading undef directives before the new headers', () => {
    const source = '#undef max\nstd::max(1, 2);'
    expect(withIncludes(source, ['algorithm'])).toBe('#undef max\n#include <algorithm>\n\nstd::max(1, 2);')
  })

  it.each(['\n', '\r\n'])('never splits a continued define with %j endings', (eol) => {
    const prefix = '#define VALUE \\' + eol + '  42' + eol
    const source = prefix + 'std::mutex lock;'
    expect(withIncludes(source)).toBe(prefix + '#include <mutex>' + eol + eol + 'std::mutex lock;')
  })

  it('recognizes a standard include continued onto the next line', () => {
    const source = '#include \\\n  <mutex>\nstd::mutex lock;'
    expect(planCppAutoIncludes(source, ['mutex'])).toBeNull()
  })

  it.each([
    'export module example;\nstd::mutex lock;',
    'module example;\nstd::mutex lock;',
    'module;\n#include <iostream>\nexport module example;\nstd::mutex lock;',
    '/* Module interface */\nexport\nmodule example;\nstd::mutex lock;'
  ])('does not mutate a C++ module unit: %s', (source) => {
    expect(planCppAutoIncludes(source, ['mutex'])).toBeNull()
  })

  it('does not mistake module text inside a string for a module declaration', () => {
    const source = 'const char* description = R"(\nexport module example;\n)";\nstd::mutex lock;'
    expect(withIncludes(source)).toBe('#include <mutex>\n\n' + source)
  })
})
