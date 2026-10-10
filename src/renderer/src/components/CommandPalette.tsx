import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, CornerDownLeft } from 'lucide-react'
import { useStore } from '../store/useStore'

export type PaletteMode = 'commands' | 'files'

interface Item {
  key: string
  label: string
  hint?: string
  run: () => void
}

/** Drive an action on the focused Monaco editor (format, rename, references,
 *  go-to-definition). No-op when no editor is mounted, e.g. on the Simulator.
 *  Some of these (go-to-definition, references) are Monaco commands rather than
 *  registered EditorActions, so fall back to trigger() when getAction misses. */
function editorAction(actionId: string): void {
  const ed = (
    window as unknown as {
      __cortexEditor?: {
        focus(): void
        getAction(id: string): { run: () => void } | null
        trigger(source: string, id: string, payload: unknown): void
      }
    }
  ).__cortexEditor
  if (!ed) return
  ed.focus()
  const action = ed.getAction(actionId)
  if (action) action.run()
  else ed.trigger('palette', actionId, null)
}

/** Subsequence fuzzy score; null = no match, higher = better. */
function fuzzy(query: string, text: string): number | null {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 0
  let ti = 0
  let score = 0
  let streak = 0
  for (const c of q) {
    const idx = t.indexOf(c, ti)
    if (idx === -1) return null
    if (idx === ti) {
      streak += 1
      score += 2 + streak
    } else {
      streak = 0
    }
    ti = idx + 1
  }
  score += Math.max(0, 24 - (t.length - q.length) / 4)
  return score
}

export default function CommandPalette({ mode, onClose }: { mode: PaletteMode; onClose: () => void }): JSX.Element {
  const s = useStore()
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [sel, setSel] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (mode === 'files' && s.workspaceRoot) void window.api.listAllFiles(s.workspaceRoot).then(setFiles)
  }, [mode, s.workspaceRoot])

  const rel = (f: string): string => (s.workspaceRoot ? f.slice(s.workspaceRoot.length + 1) : f)

  const commands: Item[] = useMemo(
    () => [
      { key: 'run', label: 'Run: Run active file', hint: 'F5', run: () => void s.runActive() },
      { key: 'firmwareTests', label: 'Firmware: Run Tests', run: () => void s.runFirmwareTests() },
      { key: 'firmwareResults', label: 'Firmware: Test Results', run: () => s.setBottom('tests') },
      // Stops whichever is live. A palette Stop that could not stop a
      // simulation was the only Stop a keyboard user could reach.
      {
        key: 'stop',
        label: 'Run: Stop',
        run: () => {
          void s.stopRun()
          void s.stopSim()
          void s.stopFirmwareTests().catch(error => s.notify('error', 'Could not stop tests', String(error)))
        }
      },
      { key: 'sim', label: 'Simulator: Open', run: () => s.setMainView('simulator') },
      { key: 'editor', label: 'View: Editor', run: () => s.setMainView('editor') },
      { key: 'save', label: 'File: Save', hint: 'Ctrl+S', run: () => void s.saveActive().catch(() => {}) },
      { key: 'saveAll', label: 'File: Save All', run: () => void s.saveAll().catch(() => {}) },
      { key: 'reload', label: 'File: Reload from disk', run: () => void s.reloadActiveFromDisk().catch((error) => s.notify('error', 'Could not reload file', String(error))) },
      {
        key: 'open',
        label: 'File: Open Folder...',
        run: () =>
          void window.api.openFolder().then((d) => {
            if (d) return s.openWorkspace(d)
            return undefined
          }).catch((error) => s.notify('error', 'Could not open project', String(error)))
      },
      { key: 'closeFolder', label: 'File: Close Folder', run: () => void s.closeWorkspace().catch((error) => s.notify('error', 'Project stayed open', String(error))) },
      { key: 'explorer', label: 'View: Explorer', run: () => s.setSidebar('explorer') },
      { key: 'search', label: 'View: Search', run: () => s.setSidebar('search') },
      { key: 'boards', label: 'View: Boards Manager', run: () => s.setSidebar('boards') },
      { key: 'libraries', label: 'View: Library Manager', run: () => s.setSidebar('libraries') },
      { key: 'environment', label: 'View: Environment (Dependencies)', run: () => s.setSidebar('environment') },
      { key: 'datasheets', label: 'View: Datasheets (Documents)', run: () => s.setRightView('datasheets') },
      { key: 'debug', label: 'View: Debug', run: () => s.setSidebar('debug') },
      { key: 'devices', label: 'View: Serial & Devices', run: () => s.setSidebar('serial') },
      { key: 'settings', label: 'View: Settings', run: () => s.setMainView('settings') },
      { key: 'ai', label: 'View: Toggle Cortex Agent', run: () => s.toggleAi() },
      { key: 'terminal', label: 'Terminal: Open', hint: 'Ctrl+`', run: () => s.openTerminal() },
      { key: 'panel', label: 'View: Toggle Bottom Panel', run: () => s.toggleBottom() },
      { key: 'sidebar', label: 'View: Toggle Sidebar', hint: 'Ctrl+B', run: () => s.toggleSidebar() },
      { key: 'format', label: 'Editor: Format Document', hint: 'Ctrl+T', run: () => editorAction('editor.action.formatDocument') },
      { key: 'rename', label: 'Editor: Rename Symbol', hint: 'F2', run: () => editorAction('editor.action.rename') },
      { key: 'refs', label: 'Editor: Find All References', hint: 'Shift+F12', run: () => editorAction('editor.action.goToReferences') },
      { key: 'gotodef', label: 'Editor: Go to Definition', hint: 'F12', run: () => editorAction('editor.action.revealDefinition') },
      { key: 'rescan', label: 'Toolchains: Rescan', run: () => void s.detectToolchains(true) }
    ],
    [s]
  )

  const items: Item[] =
    mode === 'commands'
      ? commands
      : files.map((f) => ({ key: f, label: rel(f), run: () => void s.openFile(f) }))

  const filtered = useMemo(() => {
    const scored = items
      .map((it) => ({ it, score: fuzzy(query, it.label) }))
      .filter((x): x is { it: Item; score: number } => x.score !== null)
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 60).map((x) => x.it)
  }, [items, query])

  useEffect(() => setSel(0), [query, mode])
  useEffect(() => {
    const el = listRef.current?.children[sel] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  const runSel = (): void => {
    const it = filtered[sel]
    if (it) {
      it.run()
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center bg-black/50 pt-24" onClick={onClose}>
      <div
        className="w-[560px] max-w-[90vw] overflow-hidden rounded-xl border border-ide-border bg-ide-bar shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row gap-2 border-b border-ide-border px-3 py-2.5">
          <Search size={16} className="text-ide-faint" />
          <input
            autoFocus
            className="flex-1 bg-transparent text-[14px] text-ide-text outline-none"
            placeholder={mode === 'commands' ? 'Type a command...' : 'Search files by name...'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((v) => Math.min(filtered.length - 1, v + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((v) => Math.max(0, v - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                runSel()
              } else if (e.key === 'Escape') {
                onClose()
              }
            }}
          />
          <span className="rounded bg-ide-panel px-1.5 py-0.5 text-[10px] text-ide-faint">
            {mode === 'commands' ? 'commands' : 'files'}
          </span>
        </div>
        <div ref={listRef} className="max-h-80 overflow-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-ide-faint">No matches</div>
          ) : (
            filtered.map((it, i) => (
              <button
                key={it.key}
                onMouseEnter={() => setSel(i)}
                onClick={runSel}
                className={`row w-full justify-between gap-3 px-4 py-1.5 text-left text-[13px] ${
                  i === sel ? 'bg-ide-active text-ide-text' : 'text-ide-muted'
                }`}
              >
                <span className="truncate">{it.label}</span>
                {/* The row background is conditional, so the text on it must be
                    too: ide-faint is 5.31:1 on ide-bg but only 3.21:1 on the
                    selected row, and the first row is selected the moment the
                    palette opens. */}
                {it.hint ? (
                  <span className={`mono shrink-0 text-[10px] ${i === sel ? 'text-ide-muted' : 'text-ide-faint'}`}>
                    {it.hint}
                  </span>
                ) : i === sel ? (
                  <CornerDownLeft size={12} className="shrink-0 text-ide-muted" />
                ) : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
