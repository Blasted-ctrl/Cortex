import { useEffect, useRef, useState } from 'react'
import { Cpu } from 'lucide-react'
import { useStore, isSketch } from '../store/useStore'
import { isHeaderPath } from '@shared/languages'

/**
 * The Arduino-IDE-style menu bar (File / Edit / Sketch / Tools / Help). Every
 * item is wired to a real action; there are no placeholders, because a menu
 * full of dead entries is the loudest "unfinished" tell there is.
 *
 * Store actions cover most of it. The Edit and Format items drive the focused
 * Monaco editor through the instance CodeEditor exposes on window (Monaco's
 * commands are not reachable via document.execCommand). The command palette
 * lives in App state, so those items dispatch a window event App listens for.
 */

/** Minimal shape of the Monaco editor CodeEditor exposes; avoids importing the type. */
interface EditorLike {
  focus(): void
  trigger(source: string, handlerId: string, payload: unknown): void
  getAction(id: string): { run: () => void } | null
}
const editor = (): EditorLike | undefined =>
  (window as unknown as { __cortexEditor?: EditorLike }).__cortexEditor

function withEditor(fn: (e: EditorLike) => void): void {
  const e = editor()
  if (!e) return
  e.focus()
  fn(e)
}
const runAction = (id: string): void => withEditor((e) => e.getAction(id)?.run())
const command = (id: string): void => withEditor((e) => e.trigger('menu', id, null))

const palette = (mode: 'commands' | 'files'): void => {
  window.dispatchEvent(new CustomEvent('cortex:palette', { detail: mode }))
}

const BLINK = `// blink.ino - your first Cortex sketch.
// Press the Simulator icon in the left bar, then press Run. No hardware needed.

const int LED = 13;

void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(115200);
}

void loop() {
  digitalWrite(LED, HIGH);
  delay(500);
  digitalWrite(LED, LOW);
  delay(500);
}
`

interface Item {
  label?: string
  hint?: string
  title?: string
  onClick?: () => void
  disabled?: boolean
  sep?: boolean
}
interface Menu {
  label: string
  items: Item[]
}

export default function MenuBar(): JSX.Element {
  const s = useStore()
  const [open, setOpen] = useState<string | null>(null)
  const [about, setAbout] = useState<{ version: string; electron: string; node: string } | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  // Click anywhere outside the bar closes the open menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const openSerial = (plot: boolean): void => {
    s.setSerialPlot(plot)
    // setBottom already reveals the panel. A trailing toggleBottom() here read
    // the stale (pre-set) bottomVisible and flipped the just-opened panel back
    // shut, so the button did nothing exactly when the panel was closed.
    s.setBottom('serial')
  }

  const newSketch = async (): Promise<void> => {
    const dir = await window.api.openFolder()
    if (!dir) return
    await s.openWorkspace(dir)
    const sep = dir.includes('\\') ? '\\' : '/'
    const sketchDir = `${dir}${sep}blink`
    const path = `${sketchDir}${sep}blink.ino`
    await window.api.createDir(sketchDir)
    let created = false
    try {
      await window.api.createFile(path)
      created = true
    } catch (error) {
      if (!(await window.api.exists(path))) throw error
    }
    if (created) await window.api.writeFile(path, BLINK)
    await s.refreshTree()
    await s.openFile(path)
    s.setMainView('simulator')
    await s.startSim()
  }

  const openFolder = async (): Promise<void> => {
    try {
      const dir = await window.api.openFolder()
      if (dir) await s.openWorkspace(dir)
    } catch (error) {
      s.notify('error', 'Could not open project', String(error))
    }
  }

  const showAbout = async (): Promise<void> => {
    const info = await window.api.appInfo()
    setAbout({ version: info.version, electron: info.electron, node: info.node })
  }

  const boardReady = !!s.boardStatus?.available && !s.boardStatus.setupRequired && !!s.selectedFqbn
  const hasFile = !!s.activePath
  const sketch = isSketch(s.activePath)
  const activeTab = s.tabs.find((t) => t.path === s.activePath)
  const canRun = !!activeTab?.language.runnable && !isHeaderPath(s.activePath ?? '')
  const busy = s.running || s.simRunning

  const menus: Menu[] = [
    {
      label: 'File',
      items: [
        { label: 'New Sketch', hint: 'blink', onClick: () => void newSketch().catch((error) => s.notify('error', 'Could not create sketch', String(error))) },
        { label: 'Open Folder...', hint: 'Ctrl+O', onClick: () => void openFolder() },
        { label: 'Close Folder', disabled: !s.workspaceRoot, onClick: () => void s.closeWorkspace().catch((error) => s.notify('error', 'Project stayed open', String(error))) },
        { sep: true },
        { label: 'Save', hint: 'Ctrl+S', disabled: !hasFile, onClick: () => void s.saveActive().catch(() => {}) },
        { label: 'Save All', disabled: s.tabs.length === 0, onClick: () => void s.saveAll().catch(() => {}) },
        { label: 'Reload from disk', disabled: !hasFile, onClick: () => void s.reloadActiveFromDisk().catch((error) => s.notify('error', 'Could not reload file', String(error))) },
        ...(s.recents.length ? [
          { sep: true },
          ...s.recents.map((recent) => ({
            label: `Open Recent: ${recent.name}`,
            title: recent.path,
            onClick: () => void s.openWorkspace(recent.path).catch((error) => s.notify('error', 'Could not open recent project', `${recent.path}: ${String(error)}`))
          }))
        ] : []),
        { sep: true },
        { label: 'Settings', hint: 'Ctrl+,', onClick: () => s.setMainView('settings') },
        { sep: true },
        { label: 'Quit', onClick: () => window.close() }
      ]
    },
    {
      label: 'Edit',
      items: [
        { label: 'Undo', hint: 'Ctrl+Z', disabled: !hasFile, onClick: () => command('undo') },
        { label: 'Redo', hint: 'Ctrl+Y', disabled: !hasFile, onClick: () => command('redo') },
        { sep: true },
        { label: 'Cut', hint: 'Ctrl+X', disabled: !hasFile, onClick: () => runAction('editor.action.clipboardCutAction') },
        { label: 'Copy', hint: 'Ctrl+C', disabled: !hasFile, onClick: () => runAction('editor.action.clipboardCopyAction') },
        { label: 'Paste', hint: 'Ctrl+V', disabled: !hasFile, onClick: () => runAction('editor.action.clipboardPasteAction') },
        { sep: true },
        { label: 'Find', hint: 'Ctrl+F', disabled: !hasFile, onClick: () => runAction('actions.find') },
        { label: 'Select All', hint: 'Ctrl+A', disabled: !hasFile, onClick: () => runAction('editor.action.selectAll') }
      ]
    },
    {
      label: 'Sketch',
      items: [
        { label: busy ? 'Stop' : 'Run', hint: 'F5', disabled: !hasFile || !canRun, onClick: () => (busy ? void (s.running ? s.stopRun() : s.stopSim()) : void s.runActive()) },
        {
          // Simulate/Verify/Upload are sketch actions. Enabled for every file
          // type, they handed a .py path to the simulator and to arduino-cli.
          label: 'Simulate',
          disabled: !sketch,
          onClick: () => {
            s.setMainView('simulator')
            void s.startSim()
          }
        },
        { sep: true },
        { label: 'Verify for Board', disabled: !boardReady || !sketch, onClick: () => void s.verifyBoard() },
        { label: 'Upload to Board', disabled: !boardReady || !sketch, onClick: () => void s.uploadBoard() },
        { sep: true },
        { label: 'Auto Format', hint: 'Ctrl+T', disabled: !hasFile, onClick: () => runAction('editor.action.formatDocument') }
      ]
    },
    {
      label: 'Tools',
      items: [
        { label: 'Terminal', hint: 'Ctrl+`', disabled: !s.workspaceRoot, onClick: () => s.openTerminal() },
        { sep: true },
        { label: 'Serial Monitor', hint: 'Ctrl+Shift+M', onClick: () => openSerial(false) },
        { label: 'Serial Plotter', onClick: () => openSerial(true) },
        { sep: true },
        { label: 'Boards Manager', onClick: () => s.setSidebar('boards') },
        { label: 'Manage Libraries', hint: 'Ctrl+Shift+I', onClick: () => s.setSidebar('libraries') },
        { label: 'Devices & Boards', onClick: () => s.setSidebar('serial') },
        { sep: true },
        { label: 'Toolchains & Build', onClick: () => s.setMainView('settings') }
      ]
    },
    {
      label: 'Help',
      items: [
        { label: 'Command Palette', hint: 'Ctrl+Shift+P', onClick: () => palette('commands') },
        { label: 'Quick Open File', hint: 'Ctrl+P', onClick: () => palette('files') },
        { sep: true },
        { label: 'About Cortex', onClick: () => void showAbout() }
      ]
    }
  ]

  return (
    <>
      <div ref={barRef} className="no-drag row shrink-0 text-[12px]">
        {menus.map((menu) => (
          <div key={menu.label} className="relative">
            <button
              className={`rounded px-2 py-0.5 ${
                open === menu.label ? 'bg-ide-hover text-ide-text' : 'text-ide-muted hover:bg-ide-hover hover:text-ide-text'
              }`}
              onClick={() => setOpen(open === menu.label ? null : menu.label)}
              onMouseEnter={() => open && setOpen(menu.label)}
            >
              {menu.label}
            </button>
            {open === menu.label && (
              <div className="absolute left-0 top-full z-50 mt-0.5 min-w-[210px] overflow-hidden rounded-md border border-ide-border bg-ide-bar py-1 shadow-2xl">
                {menu.items.map((it, i) =>
                  it.sep ? (
                    <div key={i} className="my-1 border-t border-ide-border" />
                  ) : (
                    <button
                      key={i}
                      title={it.title}
                      disabled={it.disabled}
                      onClick={() => {
                        setOpen(null)
                        it.onClick?.()
                      }}
                      className="row w-full justify-between gap-8 px-3 py-1 text-left text-ide-text hover:bg-ide-hover disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      <span className="min-w-0 truncate">{it.label}</span>
                      {it.hint && <span className="text-[10px] text-ide-faint">{it.hint}</span>}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {about && (
        <div
          className="fixed inset-0 z-[90] grid place-items-center bg-black/50"
          onClick={() => setAbout(null)}
        >
          <div
            className="w-80 rounded-xl border border-ide-border bg-ide-panel p-6 text-center shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-cortex-gradient shadow-lg shadow-ide-navy/30">
              <Cpu size={30} className="text-white" strokeWidth={1.6} />
            </div>
            <div className="text-lg font-semibold text-ide-text">Cortex</div>
            <div className="mt-0.5 text-[11px] text-ide-muted">An AI-native IDE for embedded development</div>
            <div className="mono mt-4 space-y-0.5 text-[11px] text-ide-faint">
              <div>version {about.version}</div>
              <div>Electron {about.electron} · Node {about.node}</div>
            </div>
            <button className="btn btn-accent mt-5 w-full justify-center" onClick={() => setAbout(null)}>
              Close
            </button>
          </div>
        </div>
      )}
    </>
  )
}
