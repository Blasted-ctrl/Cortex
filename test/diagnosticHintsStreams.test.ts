import { describe, it, expect } from 'vitest'
import { diagnosticHint, withDiagnosticHint } from '../src/shared/diagnosticHints'

describe('stream (cout, cerr) hints', () => {
  it('explains an enum class that cannot be printed, naming the type', () => {
    const msg = "Invalid operands to binary expression ('ostream' (aka 'basic_ostream<char>') and 'State')"
    const hint = diagnosticHint(msg)!
    expect(hint).toMatch(/can only print types that define operator<</)
    expect(hint).toContain("'State'")
    expect(hint).toMatch(/static_cast<int>/)
  })
  it('also recognises the std:: spelling and cerr-style wide streams', () => {
    expect(diagnosticHint("Invalid operands to binary expression ('std::ostream' and 'Point')")).toContain("'Point'")
    expect(diagnosticHint("Invalid operands to binary expression ('wostream' and 'Point')")).toContain("'Point'")
  })
  it('tells a missing #include <iostream> from an undeclared cout, cerr or endl', () => {
    expect(diagnosticHint("Use of undeclared identifier 'cout'")).toMatch(/#include <iostream>.*std::cout/)
    expect(diagnosticHint("Use of undeclared identifier 'cerr'")).toMatch(/std::cerr/)
    expect(diagnosticHint("Use of undeclared identifier 'endl'")).toMatch(/std::endl/)
  })
  it("explains \"No member named 'cout' in namespace 'std'\"", () => {
    expect(diagnosticHint("No member named 'cout' in namespace 'std'")).toMatch(/Add #include <iostream>/)
  })
  it('stays quiet for unrelated operands and identifiers', () => {
    expect(diagnosticHint("Invalid operands to binary expression ('int' and 'Foo')")).toBeNull()
    expect(diagnosticHint("Invalid operands to binary expression ('MyStream' and 'int')")).toBeNull()
    expect(diagnosticHint("Use of undeclared identifier 'counter'")).toBeNull()
    expect(diagnosticHint("No member named 'cout' in namespace 'other'")).toBeNull()
  })
  it('appends the hint under the original message', () => {
    expect(withDiagnosticHint("Use of undeclared identifier 'cout'")).toMatch(/^Use of undeclared identifier 'cout'\n\nFix: /)
  })
})
