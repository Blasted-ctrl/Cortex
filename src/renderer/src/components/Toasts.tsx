import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, AlertCircle, Info, X } from 'lucide-react'
import { useStore, type AppNotification } from '../store/useStore'

const DISMISS_MS = 6000
const MAX_TOASTS = 4

const ICON = {
  success: <CheckCircle2 size={15} className="shrink-0 text-ide-green" />,
  error: <AlertCircle size={15} className="shrink-0 text-ide-red" />,
  info: <Info size={15} className="shrink-0 text-ide-accent" />
}

/**
 * Toast host: recent notifications shown as dismissable cards at the bottom
 * right, above the status bar. Success/info auto-dismiss after a few seconds;
 * errors stay until dismissed so a failure is not missed. Driven by the
 * notifications log (the full history lives behind the status-bar bell), so a
 * result that arrives while you are elsewhere no longer needs the Output panel
 * open to be seen. aria-live announces them to screen readers.
 */
const RIGHT_RAIL_W = 48

export default function Toasts({ rightWidth }: { rightWidth: number }): JSX.Element {
  const notifications = useStore((s) => s.notifications)
  // Clear the rail and open dock when space allows; keep cards inside narrow viewports.
  const rightView = useStore((s) => s.rightView)
  const rightOffset = RIGHT_RAIL_W + 16 + (rightView ? rightWidth + 8 : 0)
  const [visible, setVisible] = useState<AppNotification[]>([])
  const seen = useRef<Set<string>>(new Set())
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const dismiss = (id: string): void => {
    const t = timers.current[id]
    if (t) {
      clearTimeout(t)
      delete timers.current[id]
    }
    setVisible((cur) => cur.filter((n) => n.id !== id))
  }

  useEffect(() => {
    // Enqueue notifications not yet shown. The log is newest-first; reverse the
    // fresh batch so they enter oldest-first and the newest ends up on top.
    const fresh = notifications.filter((n) => !seen.current.has(n.id))
    // Bound the seen set to the current (capped) log so it cannot grow forever.
    seen.current = new Set(notifications.map((n) => n.id))
    if (fresh.length === 0) return
    setVisible((cur) => [...[...fresh].reverse(), ...cur].slice(0, MAX_TOASTS))
    fresh.forEach((n) => {
      if (n.kind !== 'error') timers.current[n.id] = setTimeout(() => dismiss(n.id), DISMISS_MS)
    })
  }, [notifications])

  // Clear any pending timers on unmount.
  useEffect(() => () => Object.values(timers.current).forEach((t) => clearTimeout(t)), [])

  // Always render the (empty when idle) live region so a screen reader has it
  // established before the first toast arrives.
  return (
    <div
      className="pointer-events-none fixed bottom-8 z-[80] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      style={{ right: `min(${rightOffset}px, max(16px, calc(100vw - 20rem - 16px)))` }}
      aria-live="polite"
    >
      {visible.map((n) => (
        <div
          key={n.id}
          className="pointer-events-auto row items-start gap-2.5 rounded-lg border border-ide-border bg-ide-panel px-3 py-2.5 shadow-xl"
          role="status"
        >
          <div className="mt-0.5">{ICON[n.kind]}</div>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-medium text-ide-text">{n.title}</div>
            {n.detail && <div className="mt-0.5 truncate text-[11px] text-ide-muted" title={n.detail}>{n.detail}</div>}
          </div>
          <button
            className="shrink-0 rounded p-0.5 text-ide-faint hover:bg-ide-hover hover:text-ide-text"
            onClick={() => dismiss(n.id)}
            title="Dismiss"
            aria-label="Dismiss notification"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
