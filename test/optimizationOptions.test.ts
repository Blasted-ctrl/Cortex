import { describe, expect, it } from 'vitest'
import { OPT_LEVELS } from '../src/shared/security'
import { OPT_PRESETS, OPT_ADVANCED, optimizationSummary } from '../src/shared/optimizationOptions'

describe('allowlisted optimization choices', () => {
  it('covers the exact existing compiler allowlist without duplicates', () => {
    const flags = [...OPT_PRESETS, ...OPT_ADVANCED].map((option) => option.flag)
    expect(new Set(flags).size).toBe(flags.length)
    expect([...flags].sort()).toEqual([...OPT_LEVELS].sort())
  })

  it('keeps the four existing product presets separate from technical choices', () => {
    expect(OPT_PRESETS.map(({ label, flag }) => [label, flag])).toEqual([
      ['Debug', '-O0'], ['Balanced', '-O2'], ['Release', '-O3'], ['Size', '-Os']
    ])
    expect(OPT_ADVANCED.map((option) => option.flag)).toEqual(['-O', '-O1', '-Og', '-Ofast'])
  })

  it.each(['-Oz', '-O4', '-fplugin=payload.so', '-O0 -fplugin=payload.so', '@flags.txt', ''])
  ('never offers an unsupported or injected flag: %s', (value) => {
    expect([...OPT_PRESETS, ...OPT_ADVANCED].some((option) => option.flag === value)).toBe(false)
  })

  it.each(OPT_LEVELS)('describes %s without inventing a different selected level', (flag) => {
    const preset = OPT_PRESETS.find((option) => option.flag === flag)
    expect(optimizationSummary(flag)).toBe(preset?.label ?? flag)
  })

  it('does not silently relabel an unsupported stored value as a preset', () => {
    expect(optimizationSummary('-Oz')).toBe('-Oz')
  })

  it('explicitly warns that fast optimization changes program semantics', () => {
    expect(OPT_ADVANCED.find((option) => option.flag === '-Ofast')?.hint).toMatch(/floating-point|standards/i)
    expect(OPT_PRESETS.find((option) => option.flag === '-O3')?.hint).not.toMatch(/maximum speed/i)
  })
})
