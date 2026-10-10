export interface OptimizationOption {
  label: string
  flag: string
  hint: string
}

export const OPT_PRESETS: readonly OptimizationOption[] = [
  { label: 'Debug', flag: '-O0', hint: 'No optimization (-O0)' },
  { label: 'Balanced', flag: '-O2', hint: 'Moderate optimization (-O2)' },
  { label: 'Release', flag: '-O3', hint: 'Aggressive optimization (-O3); speed gains depend on the program' },
  { label: 'Size', flag: '-Os', hint: 'Optimize for smaller binaries (-Os)' }
]

export const OPT_ADVANCED: readonly OptimizationOption[] = [
  { label: 'Basic (alias)', flag: '-O', hint: 'Basic optimization (-O is an alias for -O1)' },
  { label: 'Level 1', flag: '-O1', hint: 'Basic optimization (-O1)' },
  { label: 'Debug-friendly', flag: '-Og', hint: 'Debug-friendly optimization for Run (-Og); host Debug still uses -O0' },
  { label: 'Fast (relaxed rules)', flag: '-Ofast', hint: 'May change floating-point results and standards compliance; verify behavior before using -Ofast' }
]

export function optimizationSummary(flag: string): string {
  return OPT_PRESETS.find((option) => option.flag === flag)?.label ?? flag
}
