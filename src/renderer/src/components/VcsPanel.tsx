import { useCallback, useEffect, useRef, useState } from 'react'
import { GitBranch, RefreshCw, ArrowUp, ArrowDown, Plus, Minus, Check, ChevronDown, Download, Save } from 'lucide-react'
import PanelHeader from './PanelHeader'
import DiffView from './DiffView'
import { captureWorkspaceOwnership, useStore } from '../store/useStore'
import type { GitStatus, GitFileStatus, GitFileDiff, GitDiffKind, GitOpResult, GitBranches } from '@shared/ipc'

const baseName = (p: string): string => p.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || p
const dirOf = (p: string): string => {
  const s = p.replace(/\\/g, '/').replace(/\/$/, '')
  const i = s.lastIndexOf('/')
  return i < 0 ? '' : s.slice(0, i)
}
const isConflict = (f: GitFileStatus): boolean => ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(f.index + f.worktree)
const rowPaths = (f: GitFileStatus, kind: GitDiffKind): string[] => kind === 'staged' && f.index === 'R' && f.orig ? [f.path, f.orig] : [f.path]

interface Section {
  kind: GitDiffKind
  label: string
  has: (f: GitFileStatus) => boolean
  letterFrom: (f: GitFileStatus) => string
}
// A file can belong to more than one section: staged AND further modified in
// the worktree (porcelain "MM") shows under both, each with its own diff - which
// is the honest picture. Untracked entries are excluded from Changes so they do
// not appear twice.
const SECTIONS: Section[] = [
  { kind: 'staged', label: 'Staged Changes', has: (f) => f.index !== ' ' && f.index !== '?' && !isConflict(f), letterFrom: (f) => f.index },
  { kind: 'unstaged', label: 'Conflicts', has: isConflict, letterFrom: () => 'U' },
  { kind: 'unstaged', label: 'Changes', has: (f) => f.worktree !== ' ' && f.worktree !== '?' && !isConflict(f), letterFrom: (f) => f.worktree },
  { kind: 'untracked', label: 'Untracked', has: (f) => f.index === '?', letterFrom: () => '?' }
]
const isStaged = SECTIONS[0].has

// A one-letter tag with an AA-safe hue (the on-* tokens) for a status row.
function tagOf(letter: string): { text: string; cls: string; title: string } {
  switch (letter) {
    case '?':
      return { text: 'U', cls: 'text-ide-on-moss', title: 'Untracked' }
    case 'A':
      return { text: 'A', cls: 'text-ide-on-moss', title: 'Added' }
    case 'D':
      return { text: 'D', cls: 'text-ide-on-red', title: 'Deleted' }
    case 'R':
      return { text: 'R', cls: 'text-ide-on-amber', title: 'Renamed' }
    case 'C':
      return { text: 'C', cls: 'text-ide-on-amber', title: 'Copied' }
    case 'M':
      return { text: 'M', cls: 'text-ide-on-amber', title: 'Modified' }
    case 'U':
      return { text: '!', cls: 'text-ide-on-red', title: 'Merge conflict' }
    default:
      return { text: letter.trim() || '?', cls: 'text-ide-muted', title: 'Changed' }
  }
}

interface OpenDesc {
  key: string
  path: string
  kind: GitDiffKind
  orig?: string
}

export default function VcsPanel(): JSX.Element {
  const workspaceRoot = useStore((s) => s.workspaceRoot)
  const notify = useStore((s) => s.notify)
  const confirm = useStore((s) => s.confirm)
  const tabs = useStore((s) => s.tabs)
  const reloadOpenTabsFromDisk = useStore((s) => s.reloadOpenTabsFromDisk)
  const refreshTree = useStore((s) => s.refreshTree)
  const saveAll = useStore((s) => s.saveAll)
  const [branchMenu, setBranchMenu] = useState(false)
  const [branchList, setBranchList] = useState<GitBranches | null>(null)
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [commitError, setCommitError] = useState<string | null>(null)
  const [open, setOpen] = useState<OpenDesc | null>(null)
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [newBranch, setNewBranch] = useState('')
  const statusGen = useRef(0)
  const diffGen = useRef(0)
  const branchGen = useRef(0)
  const openRef = useRef<OpenDesc | null>(null) // latest selection, for the refresh closure
  const busyRef = useRef(false)
  const branchButton = useRef<HTMLButtonElement>(null)

  const loadDiff = useCallback(async (d: OpenDesc, owns = captureWorkspaceOwnership(workspaceRoot)): Promise<void> => {
    if (!owns()) return
    const my = ++diffGen.current
    setDiffError(null)
    try {
      const res = await window.api.gitDiff(d.path, d.kind, d.orig)
      if (my === diffGen.current && owns()) {
        setDiff(res)
        if (!res) setDiffError('Could not load this diff. Files over 4 MB and paths outside this project are not shown. Refresh or open the repository root.')
      }
    } catch {
      if (my === diffGen.current && owns()) setDiffError('Could not load this diff. Refresh and try again.')
    }
  }, [workspaceRoot])

  const refresh = useCallback(async (owns = captureWorkspaceOwnership(workspaceRoot)): Promise<void> => {
    if (!owns()) return
    const my = ++statusGen.current
    setLoading(true)
    let s: GitStatus
    try {
      s = await window.api.gitStatus()
    } catch {
      s = { isRepo: false, files: [], ahead: 0, behind: 0, error: 'Could not read source control status. Refresh and try again.' }
    }
    if (my !== statusGen.current || !owns()) return
    setStatus(s)
    setLoading(false)
    window.dispatchEvent(new Event('cortex:git-changed'))
    // Reconcile the open diff: drop it if its file left that section, otherwise
    // re-fetch so an edit to the open file is reflected rather than going stale.
    const cur = openRef.current
    if (cur) {
      const still = s.files.some((f) => f.path === cur.path && SECTIONS.some((sec) => sec.kind === cur.kind && sec.has(f)))
      if (!still) {
        openRef.current = null
        setOpen(null)
        setDiff(null)
      } else {
        void loadDiff(cur, owns)
      }
    }
  }, [loadDiff, workspaceRoot])

  useEffect(() => {
    ++diffGen.current
    openRef.current = null
    setOpen(null)
    setDiff(null)
    setDiffError(null)
    setStatus(null)
    setBranchMenu(false)
    setBranchList(null)
    ++branchGen.current
    setMsg('')
    setCommitError(null)
    void refresh()
    return () => {
      ++statusGen.current
      ++diffGen.current
      ++branchGen.current
    }
  }, [refresh, workspaceRoot])

  // Reflect edits/saves while the panel is open, debounced so a burst is one refresh.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const unsub = window.api.onFsEvent(() => {
      if (t) clearTimeout(t)
      t = setTimeout(() => void refresh(), 400)
    })
    return () => {
      if (t) clearTimeout(t)
      unsub()
    }
  }, [refresh])

  const select = (d: OpenDesc): void => {
    const owns = captureWorkspaceOwnership(workspaceRoot)
    if (!owns()) return
    if (openRef.current?.key === d.key) {
      ++diffGen.current
      openRef.current = null
      setOpen(null)
      setDiff(null)
      setDiffError(null)
      return
    }
    openRef.current = d
    setOpen(d)
    setDiff(null)
    void loadDiff(d, owns)
  }

  const doOp = async (owns: () => boolean, op: () => Promise<GitOpResult>, reconcile?: () => Promise<void>): Promise<GitOpResult | null> => {
    if (!owns()) return null
    if (busyRef.current) return { ok: false, error: 'A git operation is already running.' }
    busyRef.current = true
    setBusy(true)
    try {
      let result: GitOpResult
      try { result = await op() } catch { result = { ok: false, error: 'git operation failed.' } }
      if (!owns()) return null
      try {
        if (result.ok && reconcile) await reconcile()
        if (!owns()) return null
        await refresh(owns)
      } catch {
        result = { ok: false, error: 'Git finished, but project files could not be refreshed. Refresh and try again.' }
      }
      return owns() ? result : null
    } finally {
      setBusy(false)
      busyRef.current = false
    }
  }

  const reconcile = async (owns: () => boolean): Promise<void> => {
    if (!owns()) return
    await reloadOpenTabsFromDisk()
    if (!owns()) return
    await refreshTree()
  }

  const doSaveAll = async (): Promise<void> => {
    const owns = captureWorkspaceOwnership(workspaceRoot)
    if (!owns() || busyRef.current) return
    try {
      await saveAll()
      if (owns()) await refresh(owns)
    } catch {
      if (owns()) notify('error', 'Could not save all files')
    }
  }

  const files = status?.files ?? []
  const stagedCount = files.filter(isStaged).length
  const unsaved = tabs.some((t) => t.content !== t.savedContent)
  const conflicts = files.some(isConflict)
  const canCommit = stagedCount > 0 && msg.trim().length > 0 && !busy && !unsaved && !conflicts

  const doCommit = async (): Promise<void> => {
    const owns = captureWorkspaceOwnership(workspaceRoot)
    if (!owns()) return
    if (!canCommit || useStore.getState().tabs.some((t) => t.content !== t.savedContent)) return
    setCommitError(null)
    const r = await doOp(owns, () => window.api.gitCommit(msg))
    if (!r || !owns()) return
    if (r.ok) {
      notify('success', 'Committed', `${stagedCount} file${stagedCount === 1 ? '' : 's'}`)
      setMsg('')
    } else {
      setCommitError(r.error ?? 'Commit failed.')
    }
  }

  // Push is outward-facing (it publishes to a remote), so it always confirms
  // first and is never automatic. The Push affordance only appears when there
  // are commits ahead of a known upstream, so this guard is belt-and-braces.
  const doPush = async (): Promise<void> => {
    const owns = captureWorkspaceOwnership(workspaceRoot)
    if (!owns()) return
    const s = status
    if (busy || !s?.upstream || s.ahead < 1) return
    const ok = await confirm({
      title: 'Push commits',
      message: `Push ${s.ahead} commit${s.ahead === 1 ? '' : 's'} to ${s.upstream}?`,
      confirmLabel: 'Push'
    })
    if (!ok || !owns()) return
    const r = await doOp(owns, () => window.api.gitPush())
    if (!r || !owns()) return
    if (r.ok) notify('success', 'Pushed', `to ${s.upstream}`)
    else notify('error', 'Push failed', r.error)
  }

  const openBranchMenu = async (): Promise<void> => {
    const owns = captureWorkspaceOwnership(workspaceRoot)
    if (!owns()) return
    const my = ++branchGen.current
    setBranchList(null)
    setBranchMenu(true)
    try {
      const list = await window.api.gitBranches()
      if (my === branchGen.current && owns()) setBranchList(list)
    } catch {
      if (my === branchGen.current && owns()) {
        setBranchMenu(false)
        notify('error', 'Could not read branches', 'Refresh and try again.')
      }
    }
  }

  const doSwitch = async (name: string): Promise<void> => {
    const owns = captureWorkspaceOwnership(workspaceRoot)
    if (!owns()) return
    setBranchMenu(false)
    if (busy || name === branchList?.current) return
    // git only sees the DISK; an unsaved editor buffer would be silently
    // clobbered by the checkout, so refuse until the user saves or discards.
    if (useStore.getState().tabs.some((t) => t.content !== t.savedContent)) {
      notify('info', 'Cannot switch branch', 'Save or discard your open changes first.')
      return
    }
    const r = await doOp(owns, () => window.api.gitSwitch(name), () => reconcile(owns))
    if (!r || !owns()) return
    if (r.ok) {
      notify('success', 'Switched branch', name)
    } else {
      notify('error', 'Could not switch branch', r.error)
    }
  }

  const doInit = async (): Promise<void> => {
    const owns = captureWorkspaceOwnership(workspaceRoot)
    if (!owns() || busyRef.current) return
    const ok = await confirm({
      title: 'Initialize repository',
      message: 'Track this project folder with Git? Files stay on your laptop. Nothing is uploaded.',
      confirmLabel: 'Initialize'
    })
    if (!ok || !owns()) return
    const r = await doOp(owns, () => window.api.gitInit())
    if (!r || !owns()) return
    if (!r.ok) notify('error', 'Could not initialize repository', r.error)
    else notify('success', 'Repository initialized')
  }

  const doCreateBranch = async (): Promise<void> => {
    const owns = captureWorkspaceOwnership(workspaceRoot)
    if (!owns() || !newBranch.trim() || busyRef.current) return
    if (useStore.getState().tabs.some((t) => t.content !== t.savedContent)) {
      notify('info', 'Cannot create branch', 'Save or discard your open changes first.')
      return
    }
    const r = await doOp(owns, () => window.api.gitCreateBranch(newBranch.trim()), () => reconcile(owns))
    if (!r || !owns()) return
    if (!r.ok) notify('error', 'Could not create branch', r.error)
    else {
      setBranchMenu(false)
      setNewBranch('')
      notify('success', 'Branch created')
    }
  }

  const doSync = async (pull: boolean): Promise<void> => {
    const owns = captureWorkspaceOwnership(workspaceRoot)
    if (!owns() || busyRef.current) return
    if (pull && useStore.getState().tabs.some((t) => t.content !== t.savedContent)) {
      notify('info', 'Cannot pull changes', 'Save or discard your open changes first.')
      return
    }
    const ok = await confirm({
      title: pull ? 'Pull changes' : 'Fetch remote changes',
      message: pull
        ? 'Download and fast-forward this branch from its upstream? Your working tree must be clean. Cortex will not merge or rebase divergent branches.'
        : 'Contact the configured remotes to check for changes? Your working files will not change.',
      confirmLabel: pull ? 'Pull' : 'Fetch'
    })
    if (!ok || !owns()) return
    if (pull && useStore.getState().tabs.some((t) => t.content !== t.savedContent)) {
      notify('info', 'Cannot pull changes', 'Save or discard your open changes first.')
      return
    }
    const r = await doOp(owns, () => pull ? window.api.gitPull() : window.api.gitFetch(), pull ? () => reconcile(owns) : undefined)
    if (!r || !owns()) return
    if (!r.ok) notify('error', pull ? 'Pull failed' : 'Fetch failed', r.error)
    else {
      notify('success', pull ? 'Branch updated' : 'Remote changes fetched')
    }
  }

  const header = (
    <PanelHeader
      icon={<GitBranch size={13} />}
      actions={
        <>
          {status?.isRepo && (
            <button
              title="Fetch remote changes"
              aria-label="Fetch remote changes"
              disabled={busy}
              onClick={() => void doSync(false)}
              className="grid h-6 w-6 place-items-center rounded text-ide-muted enabled:hover:bg-ide-hover disabled:opacity-40"
            >
              <Download size={13} />
            </button>
          )}
          <button
            title="Refresh"
            aria-label="Refresh source control"
            onClick={() => void refresh()}
            className="grid h-6 w-6 place-items-center rounded text-ide-muted hover:bg-ide-hover hover:text-ide-text"
          >
            <RefreshCw size={13} className={loading ? 'motion-safe:animate-spin' : ''} />
          </button>
        </>
      }
    >
      Source Control
    </PanelHeader>
  )

  const centered = (children: React.ReactNode): JSX.Element => (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">{children}</div>
    </div>
  )

  if (!workspaceRoot) return centered(<div className="text-[12px] text-ide-muted">Open a folder to track its changes.</div>)

  if (status?.error) {
    return centered(
      <>
        <GitBranch size={22} className="text-ide-faint" />
        <div className="text-[12px] text-ide-muted">{status.error}</div>
      </>
    )
  }

  if (status && !status.isRepo) {
    return centered(
      <>
        <GitBranch size={22} className="text-ide-faint" />
        <div className="text-[12px] text-ide-muted">This folder is not a git repository.</div>
        <button className="btn btn-accent mt-2" disabled={busy} onClick={() => void doInit()}>Initialize repository</button>
        <div className="text-[11px] text-ide-faint">Track files locally. Publishing always needs your confirmation.</div>
      </>
    )
  }

  const actionBtn = (kind: GitDiffKind, paths: string[], label: string): JSX.Element => (
    <button
      className="grid h-4 w-4 shrink-0 place-items-center rounded text-ide-faint opacity-0 hover:bg-ide-hover hover:text-ide-text group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ide-accent disabled:cursor-not-allowed"
      title={label}
      aria-label={label}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation()
        const owns = captureWorkspaceOwnership(workspaceRoot)
        if (!owns()) return
        if (kind !== 'staged' && useStore.getState().tabs.some((t) => t.content !== t.savedContent)) {
          notify('info', 'Save files before staging', 'Source Control reads files on disk. Use Save all files above, then stage your changes.')
          return
        }
        void doOp(owns, () => (kind === 'staged' ? window.api.gitUnstage(paths) : window.api.gitStage(paths))).then((r) => {
          if (r && !r.ok && owns()) notify('error', kind === 'staged' ? 'Could not unstage changes' : 'Could not stage changes', r.error)
        })
      }}
    >
      {kind === 'staged' ? <Minus size={12} /> : <Plus size={12} />}
    </button>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      {unsaved && (
        <div className="border-b border-ide-border/60 px-3 py-2 text-[11px] text-ide-muted">
          <div>Save your editor changes before staging or committing. Diffs show the files on disk.</div>
          <button className="btn mt-1 h-6" disabled={busy} onClick={() => void doSaveAll()}>
            <Save size={12} /> Save all files
          </button>
        </div>
      )}
      {conflicts && (
        <div role="alert" className="border-b border-ide-border/60 px-3 py-2 text-[11px] text-ide-on-red">
          Resolve conflict markers in your files, save, then stage the resolved files before committing.
        </div>
      )}
      {status?.branch && (
        <div className="relative row items-center gap-1.5 border-b border-ide-border/60 px-3 py-1 text-[11px]">
          <button
            ref={branchButton}
            className="row -mx-1 min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-ide-text enabled:hover:bg-ide-hover disabled:cursor-not-allowed"
            onClick={() => void openBranchMenu()}
            disabled={busy}
            title="Switch branch"
            aria-expanded={branchMenu}
            aria-controls="source-control-branches"
          >
            <GitBranch size={12} className="shrink-0 text-ide-faint" />
            <span className="truncate">{status.branch}</span>
            <ChevronDown size={11} className="shrink-0 text-ide-faint" />
          </button>
          {branchMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setBranchMenu(false)} />
              <div
                id="source-control-branches"
                role="dialog"
                aria-label="Branch selector"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    setBranchMenu(false)
                    branchButton.current?.focus()
                  }
                }}
                className="absolute left-2 top-7 z-50 max-h-64 w-56 overflow-auto rounded-md border border-ide-border bg-ide-panel py-1 shadow-xl"
              >
                <div className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-ide-faint">
                  Switch branch
                </div>
                <form
                  className="row gap-1 border-b border-ide-border px-2 pb-2"
                  onSubmit={(e) => { e.preventDefault(); void doCreateBranch() }}
                >
                  <input
                    aria-label="New branch name"
                    autoFocus
                    placeholder="New branch name"
                    className="min-w-0 flex-1 rounded border border-ide-border bg-ide-bg px-1.5 py-1 text-[11px] text-ide-text"
                    value={newBranch}
                    disabled={busy}
                    onChange={(e) => setNewBranch(e.target.value)}
                  />
                  <button className="btn px-1.5" disabled={busy || !newBranch.trim()} title="Create and switch to branch" aria-label="Create and switch to branch">
                    <Plus size={12} />
                  </button>
                </form>
                {branchList === null ? (
                  <div className="px-3 py-1 text-[11px] text-ide-faint">Loading...</div>
                ) : branchList.branches.length === 0 ? (
                  <div className="px-3 py-1 text-[11px] text-ide-faint">No local branches.</div>
                ) : (
                  branchList.branches.map((b) => {
                    const isCurrent = b === branchList.current
                    return (
                      <button
                        key={b}
                        disabled={busy || isCurrent}
                        className="row w-full items-center gap-2 px-3 py-1 text-left text-[12px] enabled:hover:bg-ide-hover disabled:cursor-default"
                        onClick={() => void doSwitch(b)}
                        title={isCurrent ? 'Current branch' : `Switch to ${b}`}
                      >
                        <span className="w-3 shrink-0">{isCurrent && <Check size={12} className="text-ide-accent" />}</span>
                        <span className={`truncate ${isCurrent ? 'text-ide-text' : 'text-ide-muted'}`}>{b}</span>
                      </button>
                    )
                  })
                )}
              </div>
            </>
          )}
          {status.behind > 0 && (
            <button className="row items-center gap-1 rounded px-1 text-ide-muted enabled:hover:bg-ide-hover disabled:opacity-40" disabled={busy || unsaved} onClick={() => void doSync(true)} title={`Pull ${status.behind} commit${status.behind === 1 ? '' : 's'} from ${status.upstream ?? 'upstream'} (fast-forward only)`}>
              <ArrowDown size={11} />
              Pull {status.behind}
            </button>
          )}
          {status.ahead > 0 &&
            (status.upstream ? (
              <button
                className="row ml-auto items-center gap-1 rounded px-1.5 py-0.5 text-ide-muted enabled:hover:bg-ide-hover enabled:hover:text-ide-text disabled:cursor-not-allowed disabled:opacity-40"
                disabled={busy}
                onClick={() => void doPush()}
                title={`Push ${status.ahead} commit${status.ahead === 1 ? '' : 's'} to ${status.upstream}`}
              >
                <ArrowUp size={12} /> Push {status.ahead}
              </button>
            ) : (
              <span className="row ml-auto items-center text-ide-faint" title={`${status.ahead} unpushed (no upstream set)`}>
                <ArrowUp size={11} />
                {status.ahead}
              </span>
            ))}
        </div>
      )}

      {files.length > 0 && (
        <div className="border-b border-ide-border/60 px-2 py-1.5">
          <input
            className="h-7 w-full rounded border border-ide-border bg-ide-bg px-2 text-[12px] text-ide-text outline-none placeholder:text-ide-faint focus:border-ide-accent disabled:opacity-50"
            placeholder={stagedCount > 0 ? 'Commit message' : 'Stage changes, then commit'}
            aria-label="Commit message"
            value={msg}
            disabled={busy}
            onChange={(e) => setMsg(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void doCommit()
            }}
          />
          <button
            className="btn btn-accent mt-1 h-7 w-full justify-center text-[12px] disabled:cursor-not-allowed disabled:opacity-40"
            disabled={!canCommit}
            onClick={() => void doCommit()}
            title={
              unsaved ? 'Save files first' : conflicts ? 'Resolve conflicts first' : stagedCount === 0 ? 'Stage changes first' : !msg.trim() ? 'Enter a commit message' : 'Commit staged changes'
            }
          >
            <Check size={13} /> Commit{stagedCount > 0 ? ` (${stagedCount})` : ''}
          </button>
          {commitError && <div className="mono mt-1 text-[11px] text-ide-on-red">{commitError}</div>}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {files.length === 0 ? (
          <div className="px-3 py-3 text-center text-[11px] text-ide-faint">
            {loading ? 'Reading status...' : 'No changes. The working tree is clean.'}
          </div>
        ) : (
          SECTIONS.map((sec) => {
            const group = files.filter(sec.has)
            if (group.length === 0) return null
            return (
              <div key={sec.label} className="border-b border-ide-border/40 pb-1 last:border-b-0">
                <div className="group row h-6 items-center gap-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-ide-muted">
                  {sec.label}
                  <span className="text-ide-faint">({group.length})</span>
                  <span className="ml-auto">
                    {actionBtn(sec.kind, group.flatMap((f) => rowPaths(f, sec.kind)), sec.kind === 'staged' ? 'Unstage all' : 'Stage all')}
                  </span>
                </div>
                {group.map((f) => {
                  const key = `${sec.kind}:${f.path}`
                  const t = tagOf(sec.letterFrom(f))
                  const isOpen = open?.key === key
                  const dir = dirOf(f.path)
                  return (
                    <div key={key} className="group">
                      <div className={`row items-baseline gap-2 pl-3 pr-2 text-[11px] hover:bg-ide-hover ${isOpen ? 'bg-ide-accent/10' : ''}`}>
                        <button
                          className="row min-w-0 flex-1 items-baseline gap-2 py-0.5 text-left"
                          onClick={() => select({ key, path: f.path, kind: sec.kind, orig: f.orig })}
                          title={`${t.title}: ${f.path}${f.orig ? ` (from ${f.orig})` : ''}`}
                        >
                          <span className={`mono w-3 shrink-0 text-center font-semibold ${t.cls}`}>{t.text}</span>
                          <span className="truncate text-ide-text">{baseName(f.path)}</span>
                          {dir && <span className="ml-auto truncate pl-2 text-[10px] text-ide-faint">{dir}</span>}
                        </button>
                        {actionBtn(sec.kind, rowPaths(f, sec.kind), sec.kind === 'staged' ? 'Unstage' : 'Stage')}
                      </div>
                      {isOpen && (
                        <div className="border-y border-ide-border/60 bg-ide-bg/40">
                          {diffError ? (
                            <div role="alert" className="px-3 py-1.5 text-[11px] text-ide-on-red">{diffError}</div>
                          ) : !diff ? (
                            <div className="px-3 py-1.5 text-[11px] text-ide-faint">Loading diff...</div>
                          ) : diff.directory ? (
                            <div className="px-3 py-1.5 text-[11px] text-ide-faint">A directory - open a file to see its diff.</div>
                          ) : diff.binary ? (
                            <div className="px-3 py-1.5 text-[11px] text-ide-faint">Binary file - no text diff.</div>
                          ) : (
                            <DiffView oldContent={diff.oldContent} newContent={diff.newContent} />
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
