import { FolderOpen, Cpu, FilePlus2, BookOpen, Clock, X } from 'lucide-react'
import { useStore } from '../store/useStore'

const BLINK_SKETCH = `// blink.ino - your first Cortex sketch.
// Press the Simulator icon in the left bar, then press Run. No hardware needed.

const int LED = 13;

void setup() {
  pinMode(LED, OUTPUT);
  Serial.begin(115200);
  Serial.println("blink starting");
}

void loop() {
  digitalWrite(LED, HIGH);
  delay(500);
  digitalWrite(LED, LOW);
  delay(500);
}
`

/** "3 minutes ago" / "2 days ago" for the recents list. */
function relTime(ts: number): string {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

export default function Welcome(): JSX.Element {
  const { openWorkspace, openFile, setMainView, refreshTree, startSim, recents, removeRecent, notify } = useStore()

  const handleOpen = async (): Promise<void> => {
    try {
      const dir = await window.api.openFolder()
      if (dir) await openWorkspace(dir)
    } catch (error) {
      notify('error', 'Could not open project', String(error))
    }
  }

  // A hobbyist should reach a blinking LED without leaving the app to mkdir a
  // folder and type setup()/loop() from memory.
  const handleNewSketch = async (): Promise<void> => {
    const dir = await window.api.openFolder()
    if (!dir) return
    // Open the workspace FIRST: the main process confines writes to the open
    // workspace, so creating files before this would be refused.
    await openWorkspace(dir)
    const sep = dir.includes('\\') ? '\\' : '/'
    // arduino-cli requires the sketch file to live in a folder with the same
    // name. Writing blink.ino flat here would simulate fine and then fail the
    // moment the user connects a real board.
    const sketchDir = `${dir}${sep}blink`
    const path = `${sketchDir}${sep}blink.ino`
    await window.api.createDir(sketchDir)
    let created = false
    try {
      // createFile uses flag 'wx', so it THROWS when the sketch already exists.
      // That guard is the whole point: writeFile truncates, and createDir never
      // throws, so the old code silently replaced a real sketch with the template.
      await window.api.createFile(path)
      created = true
    } catch (error) {
      if (!(await window.api.exists(path))) throw error
    }
    if (created) await window.api.writeFile(path, BLINK_SKETCH)
    await refreshTree()
    await openFile(path)
    setMainView('simulator')
    await startSim() // land on a blinking LED, not an empty canvas
  }

  const openRecent = async (path: string): Promise<void> => {
    try {
      await openWorkspace(path)
    } catch (error) {
      notify('error', 'Could not open recent project', `${path}: ${String(error)} Choose Open folder to locate it, or remove it from this list.`)
    }
  }

  return (
    // No items-center: centering a taller-than-container child splits the
    // overflow both ways and makes the top unscrollable/unreachable.
    <div className="flex-1 overflow-auto rounded-lg border border-ide-border bg-ide-bg p-8">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-1 flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-cortex-gradient shadow-lg shadow-ide-navy/30">
            <Cpu size={26} className="text-white" />
          </div>
          <h1 className="text-4xl font-bold tracking-tight text-ide-text">Cortex</h1>
        </div>
        <p className="mb-8 text-ide-muted">An AI-native IDE for embedded and low-level development.</p>

        <div className="row mb-3 gap-2">
          <button className="btn btn-accent px-4 py-2 text-sm" onClick={() => void handleNewSketch().catch((error) => notify('error', 'Could not create sketch', String(error)))}>
            <FilePlus2 size={16} /> New sketch
          </button>
          <button className="btn border border-ide-border px-4 py-2 text-sm" onClick={handleOpen}>
            <FolderOpen size={16} /> Open folder
          </button>
        </div>
        <p className="row mb-8 gap-1.5 text-[12px] text-ide-muted">
          <BookOpen size={14} className="text-ide-moss" />
          New sketch drops a ready-to-run blink.ino in a folder you pick and opens the Simulator. No hardware needed.
        </p>

        {/* Recents, not marketing. Card-shaped divs that do nothing were the
            loudest unfinished tell on this screen. */}
        <div className="row mb-2 gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ide-muted">
          <Clock size={12} /> Recent projects
        </div>
        {recents.length === 0 ? (
          <div className="rounded-lg border border-dashed border-ide-border px-4 py-6 text-center text-[12px] text-ide-faint">
            Projects you open will appear here, and Cortex will reopen the last one on launch.
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-ide-border">
            {recents.map((r) => (
              <div
                key={r.path}
                className="group row justify-between gap-3 border-b border-ide-border px-3 py-2 last:border-b-0 hover:bg-ide-hover"
              >
                <button
                  type="button"
                  className="row min-w-0 flex-1 gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ide-accent"
                  aria-label={`Open ${r.name}: ${r.path}`}
                  title={r.path}
                  onClick={() => void openRecent(r.path)}
                >
                  <FolderOpen size={14} className="shrink-0 text-ide-amber" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-ide-text">{r.name}</span>
                    <span className="mono block truncate text-[10px] text-ide-faint">{r.path}</span>
                  </span>
                </button>
                <span className="row shrink-0 gap-2">
                  <span className="text-[10px] text-ide-faint">{relTime(r.ts)}</span>
                  <button
                    type="button"
                    className="rounded p-1 text-ide-faint opacity-0 hover:bg-ide-bar hover:text-ide-text group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ide-accent"
                    title="Remove from list"
                    aria-label={`Remove ${r.name} from recent projects: ${r.path}`}
                    onClick={() => removeRecent(r.path)}
                  >
                    <X size={12} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
