import { useEffect, useState, lazy, Suspense } from 'react'
import { Terminal, Radio, AlertTriangle, ScrollText, X, Trash2, FlaskConical } from 'lucide-react'
import { useStore, type BottomView } from '../store/useStore'
import OutputConsole from './OutputConsole'
import SerialMonitor from './SerialMonitor'
import ProblemsPanel from './ProblemsPanel'

// xterm.js is only needed once the user opens the terminal, so keep it (and the
// controller) out of the startup bundle. window.__cortexTerminal is set when
// this chunk loads; the clear button uses it rather than a static import.
const TerminalPanel = lazy(() => import('./TerminalPanel'))
const FirmwareTestsPanel = lazy(() => import('./FirmwareTestsPanel'))

const TABS: { view: BottomView; icon: typeof Terminal; label: string }[] = [
  // The real interactive shell wears the ">_" glyph; the build/run log (Output)
  // takes a neutral document icon now that a genuine terminal exists.
  { view: 'output', icon: ScrollText, label: 'Output' },
  { view: 'terminal', icon: Terminal, label: 'Terminal' },
  { view: 'serial', icon: Radio, label: 'Serial Monitor' },
  { view: 'problems', icon: AlertTriangle, label: 'Problems' },
  { view: 'tests', icon: FlaskConical, label: 'Firmware Tests' }
]

export default function BottomPanel(): JSX.Element {
  const { bottomView, setBottom, toggleBottom, clearOutput, clearSerial, diagnostics, bottomHeight, workspaceRoot } = useStore()
  const problemCount = diagnostics.length
  // Mount the terminal lazily on first open, then keep it mounted (hidden when
  // another tab is active) so a running shell and its scrollback are not torn
  // down every time the user peeks at Output or Problems.
  const [termOpened, setTermOpened] = useState(bottomView === 'terminal')
  const [testsOpened, setTestsOpened] = useState(bottomView === 'tests')
  useEffect(() => {
    if (bottomView === 'terminal') setTermOpened(true)
    if (bottomView === 'tests') setTestsOpened(true)
  }, [bottomView])

  const clear = (): void => {
    if (bottomView === 'terminal') window.__cortexTerminal?.clear()
    else if (bottomView === 'serial') clearSerial()
    else clearOutput()
  }

  return (
    <div
      className="flex shrink-0 flex-col overflow-hidden rounded-lg border border-ide-border bg-ide-panel"
      style={{ height: bottomHeight }}
    >
      {/* A narrow panel must never make a tab unreachable. Without nowrap the
          "Serial Monitor" label wrapped to two lines and broke the bar height,
          and Problems was clipped away entirely at 1000px wide. */}
      <div className="cq row h-8 shrink-0 justify-between gap-1 border-b border-ide-border px-1">
        <div className="row h-full min-w-0 overflow-x-auto scrollbar-none">
          {TABS.map(({ view, icon: Icon, label }) => (
            <button
              key={view}
              onClick={() => setBottom(view)}
              title={label}
              className={`row h-full shrink-0 gap-1.5 whitespace-nowrap border-b-2 px-3 text-[12px] ${
                bottomView === view
                  ? 'border-ide-accent text-ide-text'
                  : 'border-transparent text-ide-muted hover:text-ide-text'
              }`}
            >
              <Icon size={14} className="shrink-0" />
              <span className="cq-label">{label}</span>
              {view === 'problems' && problemCount > 0 && (
                <span className="ml-0.5 rounded-full bg-ide-danger px-1.5 text-[10px] text-white">
                  {problemCount}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="row shrink-0 gap-0.5 pr-1 text-ide-muted">
          <button
            className="rounded p-1 hover:bg-ide-hover hover:text-ide-text disabled:opacity-30 disabled:hover:bg-transparent"
            title="Clear"
            onClick={clear}
            disabled={bottomView === 'problems' || bottomView === 'tests'}
          >
            <Trash2 size={14} />
          </button>
          <button className="rounded p-1 hover:bg-ide-hover hover:text-ide-text" title="Close" onClick={toggleBottom}>
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {bottomView === 'output' && <OutputConsole />}
        {bottomView === 'serial' && <SerialMonitor />}
        {bottomView === 'problems' && <ProblemsPanel />}
        {testsOpened && <div className={bottomView === 'tests' ? 'h-full' : 'hidden'} key={workspaceRoot}>
          <Suspense fallback={<div className="p-3">Loading firmware tests...</div>}><FirmwareTestsPanel /></Suspense>
        </div>}
        {/* Kept mounted once opened; hidden (not unmounted) when inactive. */}
        {termOpened && (
          <div className={bottomView === 'terminal' ? 'h-full' : 'hidden'}>
            <Suspense
              fallback={
                <div className="grid h-full place-items-center text-[12px] text-ide-faint">Loading terminal...</div>
              }
            >
              <TerminalPanel active={bottomView === 'terminal'} />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  )
}
