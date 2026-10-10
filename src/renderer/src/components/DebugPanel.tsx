import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bug,
  Play,
  StepForward,
  ArrowDownToLine,
  ArrowUpFromLine,
  Square,
  Pause,
  ChevronRight,
  ChevronDown,
  X,
  Circle
} from 'lucide-react'
import PanelHeader from './PanelHeader'
import { useStore, isSketch } from '../store/useStore'
import { isHeaderPath } from '@shared/languages'
import { parseGdbValue, type GdbNode } from '@shared/gdbValue'
import { stepHistory } from '@shared/replHistory'

// A single array/struct can list thousands of elements; render a bounded window
// so expanding one never freezes the panel.
const MAX_CHILDREN = 200

// Keep the console log bounded so a long session cannot grow it without limit.
const CONSOLE_MAX = 200

/**
 * One row of a debug value, expandable when gdb printed an aggregate (a struct
 * or array). Every line of text is exactly what gdb returned - expansion only
 * re-lays-out that string as a tree, it never asks for or invents more data.
 * `action` (a remove button, say) renders at the end of the root row only.
 */
function VarNode({
  node,
  depth,
  action
}: {
  node: GdbNode
  depth: number
  action?: JSX.Element
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const kids = node.children
  const expandable = !!kids && kids.length > 0
  const pad = 12 + depth * 14
  return (
    <>
      <div
        className="group row items-baseline gap-1 py-0.5 text-[11px]"
        style={{ paddingLeft: pad, paddingRight: 12 }}
      >
        {expandable ? (
          <button
            className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded text-ide-faint hover:text-ide-text"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            title={open ? 'Collapse' : 'Expand'}
          >
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        ) : (
          <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
        )}
        {node.name && <span className="mono shrink-0 text-ide-cyan">{node.name}</span>}
        <span className="mono truncate text-ide-text" title={node.value}>
          {node.value}
        </span>
        {action}
      </div>
      {open &&
        kids &&
        kids
          .slice(0, MAX_CHILDREN)
          .map((c, i) => <VarNode key={(c.name ?? '') + i} node={c} depth={depth + 1} />)}
      {open && kids && kids.length > MAX_CHILDREN && (
        <div className="text-[10px] text-ide-faint" style={{ paddingLeft: pad + 14 }}>
          {kids.length - MAX_CHILDREN} more not shown
        </div>
      )}
    </>
  )
}

function Section({
  title,
  count,
  children
}: {
  title: string
  count?: number
  children: React.ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <div className="border-b border-ide-border/60">
      <button
        className="row h-7 w-full items-center gap-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-ide-muted hover:text-ide-text"
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {title}
        {count !== undefined && count > 0 && <span className="text-ide-faint">({count})</span>}
      </button>
      {open && <div className="pb-1">{children}</div>}
    </div>
  )
}

const baseName = (p?: string): string => (p ? p.replace(/\\/g, '/').split('/').pop() || p : '')

export default function DebugPanel(): JSX.Element {
  const debug = useStore((s) => s.debug)
  const breakpoints = useStore((s) => s.breakpoints)
  const startDebug = useStore((s) => s.startDebug)
  const stopDebug = useStore((s) => s.stopDebug)
  const debugContinue = useStore((s) => s.debugContinue)
  const debugStepOver = useStore((s) => s.debugStepOver)
  const debugStepInto = useStore((s) => s.debugStepInto)
  const debugStepOut = useStore((s) => s.debugStepOut)
  const debugPause = useStore((s) => s.debugPause)
  const selectDebugFrame = useStore((s) => s.selectDebugFrame)
  const revealLocation = useStore((s) => s.revealLocation)
  const toggleBreakpoint = useStore((s) => s.toggleBreakpoint)
  // Without these the panel structurally cannot gate its own button, so it
  // offered "Start Debugging" for Python, Rust, sketches and headers alike.
  const activePath = useStore((s) => s.activePath)
  const tabs = useStore((s) => s.tabs)
  const activeTab = tabs.find((t) => t.path === activePath)
  const canDebug = !!activeTab?.language.debuggable && !isHeaderPath(activePath ?? '') && !isSketch(activePath)
  const cannotReason = !activeTab
    ? 'Open a C or C++ file to debug.'
    : isSketch(activePath)
      ? 'Arduino sketches cannot be debugged with host gdb. Use Simulate instead.'
      : isHeaderPath(activePath ?? '')
        ? 'A header is not a program. Open the .cpp/.c that includes it.'
        : `Cortex debugs C and C++ with gdb. ${activeTab.language.label} is not supported yet.`

  const stopped = debug.status === 'stopped'
  const running = debug.status === 'running'
  const active = stopped || running || debug.status === 'starting'

  // Watch expressions, evaluated each time execution stops. Each carries a
  // stable id so its expand/collapse state (held in the child VarNode) follows
  // the right row when an earlier watch is removed - an index key would leak a
  // removed row's open-state onto its neighbour.
  const [watch, setWatch] = useState<{ id: number; expr: string; value: string }[]>([])
  const watchId = useRef(0)
  const [newExpr, setNewExpr] = useState('')
  useEffect(() => {
    if (!stopped || watch.length === 0) return
    let cancelled = false
    void Promise.all(watch.map((w) => window.api.debugEvaluate(w.expr).then((value) => ({ ...w, value })))).then(
      (rows) => {
        if (!cancelled) setWatch(rows)
      }
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debug])

  const addWatch = async (): Promise<void> => {
    const expr = newExpr.trim()
    if (!expr) return
    setNewExpr('')
    const id = watchId.current++
    setWatch((w) => [...w, { id, expr, value: '' }])
    if (!stopped) return
    const value = await window.api.debugEvaluate(expr)
    if (useStore.getState().debug !== debug) return
    setWatch((w) => w.map((row) => row.id === id ? { ...row, value } : row))
  }

  // Debug console: a one-shot REPL over the SAME gdb evaluate the Watch panel
  // uses. Unlike a watch it does not persist across stops or auto-re-evaluate -
  // it is a log of "what was `x` at that moment". Only real evaluate results are
  // shown; nothing is fabricated, and the input is inert unless execution is
  // paused (gdb cannot evaluate a running inferior). The result renders as a
  // VarNode so a struct/array answer is as inspectable as a variable.
  const [conLog, setConLog] = useState<{ id: number; expr: string; value: string; pending: boolean }[]>([])
  const conId = useRef(0)
  const [conInput, setConInput] = useState('')
  const conHist = useRef<string[]>([])
  const conHistIdx = useRef(-1) // -1 while editing a fresh line

  // A new gdb session starts fresh: drop the previous session's console log and
  // history so a dead process's frozen results never masquerade as the current
  // stop (unlike Watch, the console does not re-evaluate). conId stays monotonic
  // so React keys never collide across the reset.
  useEffect(() => {
    if (debug.status === 'starting') {
      setWatch((rows) => rows.map((row) => ({ ...row, value: '' })))
      setConLog([])
      setConInput('')
      conHist.current = []
      conHistIdx.current = -1
    }
  }, [debug.status])

  const runConsole = async (): Promise<void> => {
    const expr = conInput.trim()
    if (!expr || !stopped) return
    setConInput('')
    conHist.current = [...conHist.current, expr]
    conHistIdx.current = -1
    const id = conId.current++
    // Echo the entry immediately as pending, then fill in gdb's real answer.
    // `pending` is tracked separately from the value so a genuinely empty result
    // is not mistaken for "still evaluating".
    setConLog((l) => [...l, { id, expr, value: '', pending: true }].slice(-CONSOLE_MAX))
    const value = await window.api.debugEvaluate(expr)
    setConLog((l) => l.map((e) => (e.id === id ? { ...e, value, pending: false } : e)))
  }

  const onConsoleKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      void runConsole()
      return
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    const r = stepHistory(conHist.current, conHistIdx.current, e.key === 'ArrowUp' ? 'up' : 'down')
    conHistIdx.current = r.index
    // input === null means there was nothing to navigate; leave the caret/field
    // alone (and let the arrow key do its default thing).
    if (r.input !== null) {
      e.preventDefault()
      setConInput(r.input)
    }
  }

  // Parse gdb value strings into trees ONCE per data change, not on every
  // render: typing in an input re-renders this panel on each keystroke, and
  // parseGdbValue recurses over struct/array strings. Memoizing keeps that work
  // off the keystroke path (CLAUDE.md section 19).
  const varNodes = useMemo(
    () => debug.variables.map((v) => ({ ...parseGdbValue(v.value), name: v.name })),
    [debug.variables]
  )
  const watchNodes = useMemo(
    () => watch.map((w) => ({ id: w.id, node: { ...parseGdbValue(w.value || '...'), name: w.expr } })),
    [watch]
  )
  const conNodes = useMemo(
    () => conLog.map((e) => ({ id: e.id, expr: e.expr, pending: e.pending, node: parseGdbValue(e.value) })),
    [conLog]
  )

  const ctrl = (Icon: typeof Play, label: string, onClick: () => void, enabled: boolean): JSX.Element => (
    <button
      title={label}
      disabled={!enabled}
      onClick={onClick}
      className="grid h-6 w-6 place-items-center rounded text-ide-muted enabled:hover:bg-ide-hover enabled:hover:text-ide-text disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon size={14} />
    </button>
  )

  const bpList = Object.entries(breakpoints).flatMap(([file, lines]) => lines.map((line) => ({ file, line })))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        icon={<Bug size={13} />}
        actions={
          // Only during a session: a row of greyed-out transport buttons when
          // idle is a dead affordance. The idle state's "Start Debugging" below
          // is the real entry point.
          active ? (
            <div className="row gap-0.5">
              {running
                ? ctrl(Pause, 'Pause', debugPause, true)
                : ctrl(Play, 'Continue', debugContinue, stopped)}
              {ctrl(StepForward, 'Step Over', debugStepOver, stopped)}
              {ctrl(ArrowDownToLine, 'Step Into', debugStepInto, stopped)}
              {ctrl(ArrowUpFromLine, 'Step Out', debugStepOut, stopped)}
              {ctrl(Square, 'Stop', stopDebug, active)}
            </div>
          ) : undefined
        }
      >
        Debug
      </PanelHeader>

      {!active ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <Bug size={22} className="text-ide-faint" />
          <div className="text-[12px] text-ide-muted">
            {canDebug
              ? `Debug ${baseName(activePath ?? undefined)} with gdb. Click a line's gutter to set a breakpoint, then start.`
              : cannotReason}
          </div>
          <button
            className="btn btn-accent text-[12px] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => void startDebug()}
            disabled={!canDebug}
            title={canDebug ? 'Start a gdb session for this file' : cannotReason}
          >
            <Play size={13} /> Start Debugging
          </button>
          {debug.error && <div className="text-[11px] text-ide-red">{debug.error}</div>}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          {debug.reason && (
            <div className="px-3 py-1 text-[10px] text-ide-faint">
              {running ? 'Running...' : `Paused: ${debug.reason.replace(/-/g, ' ')}`}
            </div>
          )}

          <Section title="Call Stack" count={debug.stack.length}>
            {debug.stack.length === 0 ? (
              <div className="px-3 py-1 text-[11px] text-ide-faint">{running ? 'Running.' : 'No frames.'}</div>
            ) : (
              debug.stack.map((f) => (
                <button
                  key={f.level}
                  className={`row w-full items-baseline justify-between gap-2 px-3 py-0.5 text-left text-[11px] hover:bg-ide-hover ${
                    f.level === debug.frame ? 'bg-ide-accent/10 text-ide-text' : 'text-ide-muted'
                  }`}
                  onClick={() => selectDebugFrame(f.level)}
                >
                  <span className="mono truncate">{f.func || '??'}</span>
                  <span className="shrink-0 text-[10px] text-ide-faint">
                    {baseName(f.file)}:{f.line}
                  </span>
                </button>
              ))
            )}
          </Section>

          <Section title="Variables" count={debug.variables.length}>
            {varNodes.length === 0 ? (
              <div className="px-3 py-1 text-[11px] text-ide-faint">No variables in scope.</div>
            ) : (
              varNodes.map((node) => <VarNode key={node.name} node={node} depth={0} />)
            )}
          </Section>

          <Section title="Watch" count={watch.length}>
            <div className="px-3 py-1">
              <input
                className="h-6 w-full rounded border border-ide-border bg-ide-bg px-2 text-[11px] text-ide-text outline-none placeholder:text-ide-faint"
                placeholder="Add expression..."
                value={newExpr}
                onChange={(e) => setNewExpr(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void addWatch()}
              />
            </div>
            {watchNodes.map((w) => (
              <VarNode
                key={w.id}
                node={w.node}
                depth={0}
                action={
                  <button
                    className="ml-auto shrink-0 text-ide-faint opacity-0 hover:text-ide-text group-hover:opacity-100"
                    onClick={() => setWatch((ws) => ws.filter((x) => x.id !== w.id))}
                    title="Remove watch"
                    aria-label="Remove watch"
                  >
                    <X size={11} />
                  </button>
                }
              />
            ))}
          </Section>

          <Section title="Breakpoints" count={bpList.length}>
            {bpList.length === 0 ? (
              <div className="px-3 py-1 text-[11px] text-ide-faint">Click a line&apos;s gutter to set one.</div>
            ) : (
              bpList.map((b) => (
                <div key={`${b.file}:${b.line}`} className="group row items-center gap-1.5 px-3 py-0.5 text-[11px]">
                  <Circle size={9} className="shrink-0 fill-ide-red text-ide-red" />
                  <button
                    className="row min-w-0 items-baseline gap-1.5 text-left hover:text-ide-text"
                    onClick={() => void revealLocation(b.file, b.line, 1)}
                  >
                    <span className="truncate text-ide-muted">{baseName(b.file)}</span>
                    <span className="shrink-0 text-ide-faint">:{b.line}</span>
                  </button>
                  <button
                    className="ml-auto shrink-0 text-ide-faint opacity-0 hover:text-ide-text group-hover:opacity-100"
                    onClick={() => toggleBreakpoint(b.file, b.line)}
                  >
                    <X size={11} />
                  </button>
                </div>
              ))
            )}
          </Section>

          <Section title="Console" count={conLog.length}>
            <div className="row items-center gap-1.5 px-3 py-1">
              <span className="shrink-0 text-[11px] text-ide-faint">{'>'}</span>
              <input
                className="mono h-6 min-w-0 flex-1 rounded border border-ide-border bg-ide-bg px-2 text-[11px] text-ide-text outline-none placeholder:text-ide-faint disabled:cursor-not-allowed disabled:opacity-50"
                placeholder={stopped ? 'Evaluate expression...' : 'Pause execution to evaluate'}
                value={conInput}
                disabled={!stopped}
                onChange={(e) => setConInput(e.target.value)}
                onKeyDown={onConsoleKey}
                title={stopped ? 'Evaluate a gdb expression in the selected frame' : 'Available while paused at a breakpoint'}
              />
              {conLog.length > 0 && (
                <button
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-ide-faint hover:bg-ide-hover hover:text-ide-text"
                  onClick={() => setConLog([])}
                  title="Clear console"
                >
                  Clear
                </button>
              )}
            </div>
            {conLog.length === 0 && (
              <div className="px-3 pb-1 text-[11px] text-ide-faint">
                {stopped
                  ? 'Evaluate an expression in the selected frame. Results reflect the current stop.'
                  : 'Pause at a breakpoint to evaluate expressions.'}
              </div>
            )}
            {conNodes
              .slice()
              .reverse()
              .map((e) => (
                <div key={e.id} className="border-t border-ide-border/40 pb-0.5">
                  <div className="row items-baseline gap-1.5 px-3 pt-1 text-[11px]">
                    <span className="shrink-0 text-ide-faint">{'>'}</span>
                    <span className="mono truncate text-ide-muted" title={e.expr}>
                      {e.expr}
                    </span>
                  </div>
                  {e.pending ? (
                    <div className="mono px-3 py-0.5 text-[11px] text-ide-faint" style={{ paddingLeft: 26 }}>
                      evaluating...
                    </div>
                  ) : (
                    <VarNode node={e.node} depth={1} />
                  )}
                </div>
              ))}
          </Section>
        </div>
      )}
    </div>
  )
}
