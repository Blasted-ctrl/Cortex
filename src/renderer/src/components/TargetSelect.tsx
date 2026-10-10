import { useEffect, useId, useState } from 'react'
import { ChevronDown, Check, SlidersHorizontal } from 'lucide-react'
import { useStore } from '../store/useStore'
import { cDriver, cppDriver } from '@shared/languages'
import { isHostCpp, OPT_LEVELS } from '@shared/security'
import { OPT_PRESETS, OPT_ADVANCED, optimizationSummary } from '@shared/optimizationOptions'
import type { CppStandard, CStandard } from '@shared/ipc'

const CPP_STANDARDS: CppStandard[] = ['c++11', 'c++14', 'c++17', 'c++20', 'c++23', 'c++2c']
const C_STANDARDS: CStandard[] = ['c99', 'c11', 'c17', 'c23']
const RUST_EDITIONS = ['2015', '2018', '2021', '2024']

/** GCC / Clang from the actual driver binary; the binary itself is shown as a
 *  subtitle so the product label never hides which compiler runs. */
function compilerLabel(bin: string): string {
  return /clang/i.test(bin) ? 'Clang' : 'GCC'
}

/** A section heading inside the popover. */
function Group({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="px-1 py-1">
      <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-ide-faint">{label}</div>
      {children}
    </div>
  )
}

/** One selectable row (radio-style) in the popover. */
function Row({
  selected,
  onClick,
  title,
  children
}: {
  selected: boolean
  onClick: () => void
  title?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      role="menuitemradio"
      aria-checked={selected}
      className="row w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[12px] text-ide-text hover:bg-ide-hover"
      onClick={onClick}
      title={title}
    >
      {children}
      {selected && <Check size={13} className="shrink-0 text-ide-accent" />}
    </button>
  )
}

/**
 * The build target/environment control for host C/C++ and Rust files. Replaces
 * the raw compiler / standard / optimization / edition selects with one button
 * that summarizes the target (e.g. "GCC / c++23 / Debug") and opens a themed
 * popover to change each. All values are per-project (ProjectConfig) and write
 * through the same store actions the old selects used.
 */
export default function TargetSelect({ kind }: { kind: 'c' | 'cpp' | 'rust' }): JSX.Element {
  const compiler = useStore((s) => s.compiler)
  const setCompiler = useStore((s) => s.setCompiler)
  const std = useStore((s) => s.std)
  const setStd = useStore((s) => s.setStd)
  const cStd = useStore((s) => s.cStd)
  const setCStd = useStore((s) => s.setCStd)
  const optimization = useStore((s) => s.optimization)
  const setOptimization = useStore((s) => s.setOptimization)
  const rustEdition = useStore((s) => s.rustEdition)
  const setRustEdition = useStore((s) => s.setRustEdition)
  const toolchains = useStore((s) => s.toolchains)

  const [open, setOpen] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const advancedId = useId()
  useEffect(() => {
    if (open && OPT_ADVANCED.some((option) => option.flag === optimization)) setAdvanced(true)
  }, [open, optimization])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const isC = kind === 'c'
  const isRust = kind === 'rust'
  // The stored compiler is always the C++ driver; for a .c file the C
  // counterpart runs, so display and write that. Same mapping the old select
  // used, so a persisted value keeps matching an option.
  const shownCompiler = isC ? cDriver(compiler) : compiler
  const cppCompilers = Array.from(
    new Set(toolchains.filter((t) => t.available && isHostCpp(t.command)).map((t) => t.command))
  )

  const summary = isRust
    ? `Rust ${rustEdition} / ${optimization === '-O0' ? 'Debug' : 'Release'}`
    : `${compilerLabel(shownCompiler)} / ${isC ? cStd : std} / ${optimizationSummary(optimization)}`

  const title = isRust
    ? 'Rust build target: edition and profile'
    : `Build target: ${shownCompiler}, ${isC ? cStd : std}, optimization ${optimization}`

  const optAllowed = OPT_LEVELS.includes(optimization)

  return (
    <div className="no-drag relative shrink-0">
      <button
        className="row h-7 max-w-[260px] items-center gap-1.5 rounded border border-ide-border bg-ide-bar px-2 text-[11px] text-ide-text transition-colors hover:border-ide-faint"
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <SlidersHorizontal size={13} className="shrink-0 text-ide-accent" />
        <span className="truncate">{summary}</span>
        <ChevronDown size={12} className="shrink-0 text-ide-faint" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className="absolute left-0 z-50 mt-1 max-h-[70vh] w-64 overflow-auto rounded-md border border-ide-border bg-ide-panel py-1 shadow-xl"
          >
            {isRust ? (
              <>
                <Group label="Edition">
                  {RUST_EDITIONS.map((e) => (
                    <Row key={e} selected={rustEdition === e} onClick={() => setRustEdition(e)}>
                      <span>edition {e}</span>
                    </Row>
                  ))}
                </Group>
                <div className="my-1 border-t border-ide-border" />
                <Group label="Profile">
                  <Row
                    selected={optimization === '-O0'}
                    onClick={() => setOptimization('-O0')}
                    title="Debug build (-O0)"
                  >
                    <span>Debug</span>
                    <span className="mono text-[10px] text-ide-faint">-O0</span>
                  </Row>
                  <Row
                    selected={optimization !== '-O0'}
                    onClick={() => setOptimization('-O2')}
                    title="Release build (-O2)"
                  >
                    <span>Release</span>
                    <span className="mono text-[10px] text-ide-faint">-O2</span>
                  </Row>
                </Group>
              </>
            ) : (
              <>
                <Group label="Compiler">
                  {cppCompilers.length === 0 && (
                    <Row selected onClick={() => setOpen(false)} title={shownCompiler}>
                      <span className="row min-w-0 gap-1.5">
                        <span>{compilerLabel(shownCompiler)}</span>
                        <span className="mono truncate text-[10px] text-ide-faint">{shownCompiler}</span>
                      </span>
                    </Row>
                  )}
                  {cppCompilers.map((c) => {
                    const shown = isC ? cDriver(c) : c
                    return (
                      <Row
                        key={c}
                        selected={shown === shownCompiler}
                        onClick={() => setCompiler(isC ? cppDriver(shown) : shown)}
                        title={shown}
                      >
                        <span className="row min-w-0 gap-1.5">
                          <span>{compilerLabel(shown)}</span>
                          <span className="mono truncate text-[10px] text-ide-faint">{shown}</span>
                        </span>
                      </Row>
                    )
                  })}
                </Group>
                <div className="my-1 border-t border-ide-border" />
                <Group label="Language standard">
                  {(isC ? C_STANDARDS : CPP_STANDARDS).map((s) => (
                    <Row
                      key={s}
                      selected={(isC ? cStd : std) === s}
                      onClick={() => (isC ? setCStd(s as CStandard) : setStd(s as CppStandard))}
                    >
                      <span className="mono">{s}</span>
                    </Row>
                  ))}
                </Group>
                <div className="my-1 border-t border-ide-border" />
                <Group label="Optimization">
                  {OPT_PRESETS.map((p) => (
                    <Row
                      key={p.flag}
                      selected={optimization === p.flag}
                      onClick={() => setOptimization(p.flag)}
                      title={p.hint}
                    >
                      <span>{p.label}</span>
                      <span className="mono text-[10px] text-ide-faint">{p.flag}</span>
                    </Row>
                  ))}
                  <button
                    role="menuitem"
                    className="row w-full items-center justify-between rounded px-2 py-1 text-left text-[12px] text-ide-muted hover:bg-ide-hover hover:text-ide-text"
                    aria-expanded={advanced}
                    aria-controls={advancedId}
                    onClick={() => setAdvanced((value) => !value)}
                  >
                    Advanced optimization
                    <ChevronDown size={12} className={advanced ? 'rotate-180' : ''} />
                  </button>
                  {advanced && (
                    <div id={advancedId}>
                      {OPT_ADVANCED.map((option) => (
                        <Row key={option.flag} selected={optimization === option.flag} onClick={() => setOptimization(option.flag)} title={option.hint}>
                          <span>{option.label}</span>
                          <span className="mono text-[10px] text-ide-faint">{option.flag}</span>
                        </Row>
                      ))}
                      <p className="px-2 py-1 text-[10px] text-ide-muted">Run uses the selected level. Host Debug uses -O0.</p>
                      <p className="px-2 py-1 text-[10px] text-ide-amber">-Ofast may change floating-point results and standards compliance. Verify behavior before using it.</p>
                    </div>
                  )}
                  {!optAllowed && <p className="px-2 py-1 text-[10px] text-ide-amber">Stored level {optimization} is not allowed. Run falls back to -O0; choose a supported option.</p>}
                </Group>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
