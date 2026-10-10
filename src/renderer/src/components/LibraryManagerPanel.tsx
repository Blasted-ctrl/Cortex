import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, Library, Download, Trash2, ArrowUpCircle, RefreshCw } from 'lucide-react'
import PanelHeader from './PanelHeader'
import BoardToolsSetup from './BoardToolsSetup'
import { useStore } from '../store/useStore'
import type { LibPackage } from '@shared/ipc'

/**
 * Library Manager: search, install and remove libraries through arduino-cli,
 * the way Arduino IDE's Library Manager does. Install/remove stream to the
 * Output panel and the list refreshes when the operation finishes.
 */
export default function LibraryManagerPanel(): JSX.Element {
  const boardStatus = useStore((s) => s.boardStatus)
  const running = useStore((s) => s.running)
  const installLib = useStore((s) => s.installLib)
  const uninstallLib = useStore((s) => s.uninstallLib)

  const [query, setQuery] = useState('')
  const [found, setFound] = useState<LibPackage[]>([])
  const [installed, setInstalled] = useState<LibPackage[]>([])
  const [loading, setLoading] = useState(false)
  const [pick, setPick] = useState<Record<string, string>>({})

  const available = !!boardStatus?.available && !boardStatus.setupRequired

  // Installed libraries load once (and after an install/remove finishes).
  const wasRunning = useRef(false)
  useEffect(() => {
    if (available && (installed.length === 0 || (wasRunning.current && !running))) {
      window.api
        .libInstalled()
        .then(setInstalled)
        .catch(() => {})
    }
    wasRunning.current = running
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, running])

  // Debounced search; libraries number in the thousands, so require a query.
  useEffect(() => {
    if (!available || !query.trim()) {
      setFound([])
      setLoading(false) // clearing the box must not leave a stuck "Searching..."
      return
    }
    setLoading(true)
    let cancelled = false // a superseded search must not clobber newer results
    const t = setTimeout(() => {
      window.api
        .libSearch(query)
        .catch(() => [] as LibPackage[])
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

  const libs = useMemo(() => {
    const byName = new Map<string, LibPackage>()
    for (const inst of installed) byName.set(inst.name, { ...inst })
    for (const lib of found) {
      const existing = byName.get(lib.name)
      if (existing) {
        existing.latestVersion = lib.latestVersion
        existing.versions = lib.versions
        existing.sentence = existing.sentence || lib.sentence
        existing.author = existing.author || lib.author
      } else {
        byName.set(lib.name, lib)
      }
    }
    return [...byName.values()].sort((a, b) => {
      const ai = a.installedVersion ? 0 : 1
      const bi = b.installedVersion ? 0 : 1
      return ai - bi || a.name.localeCompare(b.name)
    })
  }, [found, installed])

  if (!available) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelHeader icon={<Library size={13} />}>Library Manager</PanelHeader>
        <BoardToolsSetup />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader icon={<Library size={13} />}>Library Manager</PanelHeader>
      <div className="p-2">
        <div className="row gap-1.5 rounded border border-ide-border bg-ide-bg px-2">
          <Search size={13} className="shrink-0 text-ide-faint" />
          <input
            className="h-7 w-full bg-transparent text-[12px] text-ide-text outline-none placeholder:text-ide-faint"
            placeholder="Search libraries (Servo, ArduinoJson)..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {loading && libs.length === 0 ? (
          // arduino-cli has no daemon here, so a search really does take ~10s.
          <div className="row gap-2 p-2 text-[12px] text-ide-faint">
            <RefreshCw size={12} className="shrink-0 animate-spin" />
            Asking arduino-cli. The first search can take about 10 seconds.
          </div>
        ) : libs.length === 0 ? (
          <div className="p-2 text-[12px] text-ide-faint">
            {query ? 'No libraries found.' : 'Type to search, or see your installed libraries here.'}
          </div>
        ) : (
          libs.map((l) => {
            const canUpdate = l.installedVersion && l.latestVersion && l.installedVersion !== l.latestVersion
            const chosen = pick[l.name] ?? l.latestVersion ?? l.versions[0] ?? ''
            return (
              <div key={l.name} className="mb-2 rounded border border-ide-border bg-ide-bg/40 p-2">
                <div className="row min-w-0 items-center gap-1.5">
                  <span className="truncate text-[12px] font-semibold text-ide-text">{l.name}</span>
                  {l.installedVersion && (
                    <span className="shrink-0 rounded bg-ide-moss/20 px-1 text-[9px] font-semibold text-ide-on-moss">
                      {l.installedVersion}
                    </span>
                  )}
                </div>
                {l.author && <div className="truncate text-[10px] text-ide-faint">by {l.author}</div>}
                {l.sentence && <div className="mt-1 line-clamp-2 text-[10px] leading-snug text-ide-muted">{l.sentence}</div>}
                <div className="mt-2 row items-center justify-end gap-1.5">
                  {!l.installedVersion && l.versions.length > 1 && (
                    <select
                      className="h-6 rounded border border-ide-border bg-ide-bar px-1 text-[10px] text-ide-text outline-none"
                      value={chosen}
                      onChange={(e) => setPick((p) => ({ ...p, [l.name]: e.target.value }))}
                    >
                      {l.versions.map((v) => (
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
                      onClick={() => void installLib(l.name, l.latestVersion)}
                    >
                      <ArrowUpCircle size={13} /> Update
                    </button>
                  )}
                  {l.installedVersion ? (
                    <button
                      className="btn text-[11px] disabled:opacity-40"
                      disabled={running}
                      onClick={() => void uninstallLib(l.name)}
                    >
                      <Trash2 size={13} /> Remove
                    </button>
                  ) : (
                    <button
                      className="btn btn-accent text-[11px] disabled:opacity-40"
                      disabled={running}
                      onClick={() => void installLib(l.name, chosen)}
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
