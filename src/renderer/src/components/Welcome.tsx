import { useEffect, useState } from 'react'
import { FolderOpen, Cpu, FilePlus2, Clock, X, GitBranch, Github, ArrowRight, Loader2 } from 'lucide-react'
import type { GitHubRepo } from '@shared/ipc'
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
  const [cloneOpen, setCloneOpen] = useState(false)
  const [cloneUrl, setCloneUrl] = useState('')
  const [accounts, setAccounts] = useState<string[]>([])
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [repoFilter, setRepoFilter] = useState('')
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [repoError, setRepoError] = useState('')

  useEffect(() => { void window.api.githubAccounts().then(setAccounts).catch(() => {}) }, [])

  const signIn = async (): Promise<void> => {
    setBusy(true)
    setRepoError('')
    try { setAccounts(await window.api.githubSignIn()) }
    catch (error) { setRepoError(String(error)) }
    finally { setBusy(false) }
  }

  const loadRepos = async (nextPage: number): Promise<void> => {
    setBusy(true)
    setRepoError('')
    try {
      const list = await window.api.githubRepositories(nextPage)
      setRepos(current => nextPage === 1 ? list : [...current, ...list])
      setPage(nextPage)
    } catch (error) { setRepoError(String(error)) }
    finally { setBusy(false) }
  }

  const cloneRepo = async (url: string): Promise<void> => {
    if (busy) return
    setRepoError('')
    try {
      const destination = await window.api.openFolder()
      if (!destination) return
      setBusy(true)
      const path = await window.api.githubClone(url.trim(), destination)
      await openWorkspace(path)
    } catch (error) { setRepoError(String(error)) }
    finally { setBusy(false) }
  }

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
    <div className="min-w-0 flex-1 overflow-auto rounded-lg border border-ide-border bg-ide-bg px-6 py-10 sm:px-12">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-12 flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-cortex-gradient"><Cpu size={23} className="text-white" /></div>
          <div><h1 className="text-2xl font-semibold tracking-tight text-ide-text">Cortex</h1><p className="text-xs text-ide-muted">Embedded development starts here</p></div>
        </div>
        <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)] lg:gap-20">
          <div className="min-w-0">
            <h2 className="mb-4 text-lg font-semibold">Start</h2>
            <div className="space-y-1">
              <button className="flex w-full items-center gap-3 rounded px-2 py-2 text-left text-sm text-ide-accent hover:bg-ide-hover focus-visible:ring-2 focus-visible:ring-ide-accent" onClick={() => void handleNewSketch().catch((error) => notify('error', 'Could not create sketch', String(error)))}><FilePlus2 size={18} /> New sketch</button>
              <button className="flex w-full items-center gap-3 rounded px-2 py-2 text-left text-sm text-ide-accent hover:bg-ide-hover focus-visible:ring-2 focus-visible:ring-ide-accent" onClick={() => void handleOpen()}><FolderOpen size={18} /> Open folder</button>
              <button className="flex w-full items-center gap-3 rounded px-2 py-2 text-left text-sm text-ide-accent hover:bg-ide-hover focus-visible:ring-2 focus-visible:ring-ide-accent" onClick={() => setCloneOpen(value => !value)} aria-expanded={cloneOpen}><GitBranch size={18} /> Clone Git repository</button>
            </div>
            {cloneOpen && (
              <form className="ml-8 mt-3 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void cloneRepo(cloneUrl) }}>
                <label className="sr-only" htmlFor="clone-url">GitHub repository URL</label>
                <input id="clone-url" autoFocus value={cloneUrl} onChange={event => setCloneUrl(event.target.value)} placeholder="https://github.com/owner/repository" className="min-w-48 flex-1 rounded border border-ide-border bg-ide-panel px-3 py-2 text-sm text-ide-text outline-none focus:border-ide-accent" />
                <button className="btn btn-accent px-3" disabled={busy || !cloneUrl.trim()}>{busy ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />} Clone</button>
                <p className="w-full text-xs text-ide-muted">Choose a parent folder. Cortex creates a new folder for the repository.</p>
              </form>
            )}
            <h2 className="mb-3 mt-10 flex items-center gap-2 text-lg font-semibold"><Clock size={17} /> Recent</h2>
            {recents.length === 0 ? <p className="text-sm text-ide-muted">Projects you open will appear here.</p> : <div className="space-y-0.5">
            {recents.map((r) => (
              <div
                key={r.path}
                className="group row justify-between gap-3 rounded px-2 py-2 hover:bg-ide-hover"
              >
                <button
                  type="button"
                  className="row min-w-0 flex-1 gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ide-accent"
                  aria-label={`Open ${r.name}: ${r.path}`}
                  title={r.path}
                  onClick={() => void openRecent(r.path)}
                >
                  <FolderOpen size={15} className="shrink-0 text-ide-accent" />
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-ide-accent">{r.name}</span>
                    <span className="mono block truncate text-xs text-ide-muted">{r.path}</span>
                  </span>
                </button>
                <span className="row shrink-0 gap-2">
                  <span className="text-xs text-ide-faint">{relTime(r.ts)}</span>
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
            </div>}
          </div>
          <div className="min-w-0">
            <h2 className="mb-4 flex items-center gap-2 text-lg font-semibold"><Github size={20} /> GitHub</h2>
            {accounts.length ? <p className="mb-4 text-sm text-ide-muted">Connected as <span className="font-medium text-ide-text">{accounts.join(', ')}</span></p> : <p className="mb-4 text-sm text-ide-muted">Sign in to browse your repositories and organizations.</p>}
            <div className="mb-4 flex flex-wrap gap-2">
              <button className="btn border border-ide-border px-3 py-2 text-sm hover:bg-ide-hover" disabled={busy} onClick={() => void signIn()}>{accounts.length ? 'Add account' : 'Sign in with GitHub'}</button>
              {accounts.length > 0 && <button className="btn border border-ide-border px-3 py-2 text-sm hover:bg-ide-hover" disabled={busy} onClick={() => void loadRepos(1)}>Browse repositories</button>}
            </div>
            {repoError && <p className="mb-3 rounded border border-ide-red/40 px-3 py-2 text-sm text-ide-red" role="alert">{repoError}</p>}
            {page > 0 && repos.length === 0 && <p className="text-sm text-ide-muted">No repositories found for this account. You can still clone any public GitHub URL.</p>}
            {repos.length > 0 && <>
              <label className="sr-only" htmlFor="repo-filter">Filter GitHub repositories</label>
              <input id="repo-filter" value={repoFilter} onChange={event => setRepoFilter(event.target.value)} placeholder="Filter repositories" className="mb-2 w-full rounded border border-ide-border bg-ide-panel px-3 py-2 text-sm outline-none focus:border-ide-accent" />
              <div className="max-h-96 overflow-auto rounded border border-ide-border">
                {repos.filter(repo => repo.fullName.toLowerCase().includes(repoFilter.toLowerCase())).map(repo => <button key={repo.fullName} className="flex w-full items-center justify-between gap-3 border-b border-ide-border px-3 py-2 text-left last:border-0 hover:bg-ide-hover focus-visible:ring-2 focus-visible:ring-ide-accent" disabled={busy} onClick={() => void cloneRepo(repo.cloneUrl)}><span className="min-w-0"><span className="block truncate text-sm text-ide-accent">{repo.fullName}</span>{repo.description && <span className="block truncate text-xs text-ide-muted">{repo.description}</span>}</span><span className="shrink-0 text-xs text-ide-faint">{repo.private ? 'Private' : 'Public'}</span></button>)}
              </div>
              {repos.length >= page * 100 && <button className="mt-2 text-sm text-ide-accent hover:underline" disabled={busy} onClick={() => void loadRepos(page + 1)}>Load more</button>}
            </>}
          </div>
        </div>
      </div>
    </div>
  )
}
