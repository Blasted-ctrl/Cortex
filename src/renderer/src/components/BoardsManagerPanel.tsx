import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Cpu, RefreshCw, AlertTriangle, Download, Trash2, ArrowUpCircle } from 'lucide-react'
import PanelHeader from './PanelHeader'
import BoardToolsSetup from './BoardToolsSetup'
import { useStore } from '../store/useStore'
import type { CorePlatform } from '@shared/ipc'

/**
 * Boards Manager: search, install, update and remove board cores through
 * arduino-cli, the way Arduino IDE's Boards Manager does. Search/list read
 * arduino-cli directly; install/remove stream to the Output panel and the list
 * refreshes when the operation finishes.
 */
export default function BoardsManagerPanel(): JSX.Element {
  const boardStatus = useStore((s) => s.boardStatus)
  const running = useStore((s) => s.running)
  const installCore = useStore((s) => s.installCore)
  const uninstallCore = useStore((s) => s.uninstallCore)
  const updateCoreIndex = useStore((s) => s.updateCoreIndex)

  const [query, setQuery] = useState('')
  const [found, setFound] = useState<CorePlatform[]>([])
  const [installed, setInstalled] = useState<CorePlatform[]>([])
  const [loading, setLoading] = useState(false)
  // Chosen (not-yet-installed) version per core id; defaults to latest.
  const [pick, setPick] = useState<Record<string, string>>({})

  const available = !!boardStatus?.available && !boardStatus.setupRequired

  // Installed cores load once (and after an install/remove finishes). Kept apart
  // from search so typing costs a single arduino-cli call, not two.
  const wasRunning = useRef(false)
  useEffect(() => {
    if (available && (installed.length === 0 || (wasRunning.current && !running))) {
      window.api
        .coreInstalled()
        .then(setInstalled)
        .catch(() => {})
    }
    wasRunning.current = running
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, running])

  // Debounced search (only when there is a query; an empty `core search` returns
  // the whole index and is slow).
  useEffect(() => {
    if (!available || !query.trim()) {
      setFound([])
      setLoading(false) // clearing the box must not leave a stuck "Loading..."
      return
    }
    setLoading(true)
    let cancelled = false // a superseded search must not clobber newer results
    const t = setTimeout(() => {
      window.api
        .coreSearch(query)
        .catch(() => [] as CorePlatform[])
        .then((r) => {
          if (!cancelled) setFound(r)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, available])

  // Merge installed status into search results, plus installed cores the current
  // filter surfaces, sorted installed-first.
  const cores = useMemo(() => {
    const q = query.trim().toLowerCase()
    const byId = new Map(found.map((c) => [c.id, { ...c }]))
    for (const inst of installed) {
      const existing = byId.get(inst.id)
      if (existing) existing.installedVersion = inst.installedVersion
      else if (!q || inst.name.toLowerCase().includes(q)) byId.set(inst.id, inst)
    }
    return [...byId.values()].sort((a, b) => {
      const ai = a.installedVersion ? 0 : 1
      const bi = b.installedVersion ? 0 : 1
      return ai - bi || a.name.localeCompare(b.name)
    })
  }, [found, installed, query])

  if (!available) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelHeader icon={<Cpu size={13} />}>Boards Manager</PanelHeader>
        <BoardToolsSetup />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        icon={<Cpu size={13} />}
        actions={
          <button
            className="rounded p-1 hover:bg-ide-hover hover:text-ide-text disabled:opacity-40"
            title="Refresh board index"
            aria-label="Refresh board index"
            disabled={running}
            onClick={() => void updateCoreIndex()}
          >
            <RefreshCw size={13} className={running ? 'animate-spin' : ''} />
          </button>
        }
      >
        Boards Manager
      </PanelHeader>
      {boardStatus?.hint && (
        <div className="mx-2 mt-2 rounded border border-ide-border bg-ide-bg/60 px-2 py-1.5 text-[11px] text-ide-muted" role="status">
          <div className="row items-start gap-1.5">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-ide-amber" />
            <span>{boardStatus.hint} Use Refresh board index to retry.</span>
          </div>
        </div>
      )}
      <div className="p-2">
        <div className="row gap-1.5 rounded border border-ide-border bg-ide-bg px-2">
          <Search size={13} className="shrink-0 text-ide-faint" />
          <input
            className="h-7 w-full bg-transparent text-[12px] text-ide-text outline-none placeholder:text-ide-faint"
            placeholder="Filter boards (ESP32, RP2040, AVR)..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {loading && cores.length === 0 ? (
          // arduino-cli has no daemon here, so a search really does take ~10s.
          // Say so, rather than showing a bare spinner that reads as hung.
          <div className="row gap-2 p-2 text-[12px] text-ide-faint">
            <RefreshCw size={12} className="shrink-0 animate-spin" />
            Asking arduino-cli. The first search can take about 10 seconds.
          </div>
        ) : cores.length === 0 ? (
          <div className="p-2 text-[12px] text-ide-faint">
            {query ? 'No cores found.' : 'Search for a board core (ESP32, RP2040, AVR) to install.'}
          </div>
        ) : (
          cores.map((c) => {
            const canUpdate = c.installedVersion && c.latestVersion && c.installedVersion !== c.latestVersion
            const chosen = pick[c.id] ?? c.latestVersion ?? c.versions[0] ?? ''
            return (
              <div key={c.id} className="mb-2 rounded border border-ide-border bg-ide-bg/40 p-2">
                <div className="row items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="row min-w-0 items-center gap-1.5">
                      <span className="truncate text-[12px] font-semibold text-ide-text">{c.name}</span>
                      {c.installedVersion && (
                        <span className="shrink-0 rounded bg-ide-moss/20 px-1 text-[9px] font-semibold text-ide-on-moss">
                          {c.installedVersion}
                        </span>
                      )}
                      {c.deprecated && <span className="shrink-0 text-[9px] text-ide-faint">deprecated</span>}
                    </div>
                    <div className="truncate text-[10px] text-ide-faint">{c.maintainer || c.id}</div>
                  </div>
                </div>
                {c.boards.length > 0 && (
                  <div className="mt-1 line-clamp-2 text-[10px] leading-snug text-ide-muted">
                    {c.boards.slice(0, 6).join(', ')}
                    {c.boards.length > 6 && `, +${c.boards.length - 6} more`}
                  </div>
                )}
                <div className="mt-2 row items-center justify-end gap-1.5">
                  {!c.installedVersion && c.versions.length > 1 && (
                    <select
                      className="h-6 rounded border border-ide-border bg-ide-bar px-1 text-[10px] text-ide-text outline-none"
                      value={chosen}
                      onChange={(e) => setPick((p) => ({ ...p, [c.id]: e.target.value }))}
                    >
                      {c.versions.map((v) => (
                        <option key={v} value={v}>
                          {v}
                        </option>
                      ))}
                    </select>
                  )}
                  {canUpdate && (
                    <button
                      className="btn text-[11px] disabled:opacity-40"
                      disabled={running}
                      onClick={() => void installCore(c.id, c.latestVersion)}
                    >
                      <ArrowUpCircle size={13} /> Update
                    </button>
                  )}
                  {c.installedVersion ? (
                    <button
                      className="btn text-[11px] disabled:opacity-40"
                      disabled={running}
                      onClick={() => void uninstallCore(c.id)}
                    >
                      <Trash2 size={13} /> Remove
                    </button>
                  ) : (
                    <button
                      className="btn btn-accent text-[11px] disabled:opacity-40"
                      disabled={running}
                      onClick={() => void installCore(c.id, chosen)}
                    >
                      <Download size={13} /> Install
                    </button>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
