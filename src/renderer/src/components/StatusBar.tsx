import { useEffect, useState } from 'react'
import { Folder, CircleDot, Radio, AlertCircle, AlertTriangle, CheckCircle2, Braces, MemoryStick, Bell, Info, Trash2, GitBranch, ArrowDown, ArrowUp } from 'lucide-react'
import { useStore } from '../store/useStore'
import { langForFile, LSP_SERVER_LABEL, LSP_INSTALL_HINT, LSP_BUSY_HINT } from '@shared/lsp'
import { lineEnding } from '@shared/textInfo'
import type { GitStatus } from '@shared/ipc'

const NOTIF_ICON = {
  success: <CheckCircle2 size={13} className="shrink-0 text-ide-green" />,
  error: <AlertCircle size={13} className="shrink-0 text-ide-red" />,
  info: <Info size={13} className="shrink-0 text-ide-accent" />
}

export default function StatusBar(): JSX.Element {
  const {
    tabs,
    activePath,
    running,
    runPhase,
    lastExitCode,
    serialOpen,
    serialPath,
    workspaceRoot,
    workspaceName,
    sidebarView,
    sidebarVisible,
    setSidebar,
    setBottom,
    simRunning,
    lspServers,
    lspBusy,
    projectModel,
    cursorPos,
    mainView,
    notifications,
    diagnostics,
    notifUnread,
    markNotifsRead,
    clearNotifications
  } = useStore()
  const [notifOpen, setNotifOpen] = useState(false)
  const [gitSnapshot, setGitSnapshot] = useState<{ root: string; status: GitStatus | null } | null>(null)
  const gitStatus = gitSnapshot?.root === workspaceRoot ? gitSnapshot.status : null
  useEffect(() => {
    if (!workspaceRoot) return
    let active = true
    let generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = (): void => {
      const request = ++generation
      void window.api.gitStatus().then((status) => {
        if (active && request === generation) setGitSnapshot({ root: workspaceRoot, status })
      }).catch(() => {
        if (active && request === generation) setGitSnapshot({ root: workspaceRoot, status: null })
      })
    }
    const schedule = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(refresh, 500)
    }
    refresh()
    const unsubscribe = window.api.onFsEvent(schedule)
    window.addEventListener('focus', refresh)
    window.addEventListener('cortex:git-changed', refresh)
    return () => {
      active = false
      if (timer) clearTimeout(timer)
      unsubscribe()
      window.removeEventListener('focus', refresh)
      window.removeEventListener('cortex:git-changed', refresh)
    }
  }, [workspaceRoot])
  const board = projectModel?.boards[0]
  const activeTab = tabs.find((t) => t.path === activePath)
  // Language-server status for the active file. Null for files no server handles
  // (.ino, .md, ...), so the indicator stays out of the way when irrelevant.
  const lspLang = activePath ? langForFile(activePath) : null
  const lspReady = lspLang ? lspServers[lspLang] : false
  // Installed is not the same as ready: rust-analyzer answers with empty
  // results for as long as it is loading the Cargo workspace.
  const lspIndexing = !!(lspLang && lspReady && lspBusy[lspLang])
  // A simulation is work in progress too. Reading only `running` meant the bar
  // sat idle for the whole of it, which is the app's most-used action.
  const busy = running || simRunning
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length
  const openSourceControl = (): void => {
    if (!sidebarVisible || sidebarView !== 'vcs') setSidebar('vcs')
  }

  return (
    <div className="relative flex h-7 shrink-0 items-center justify-between gap-3 border-t border-ide-border bg-ide-bar px-2 text-[11px] text-ide-muted">
      {/* The one expressive moment: a moving gradient line while building/running. */}
      {busy && (
        <div className="absolute inset-x-0 top-0 h-0.5 animate-gradient-slide bg-cortex-gradient bg-[length:200%_100%]" />
      )}
      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        <span className="row min-w-0 max-w-36 gap-1 truncate px-1" title={workspaceRoot || 'No project open'}>
          <Folder size={13} className="shrink-0" /> <span className="truncate">{workspaceName || 'No project'}</span>
        </span>
        {workspaceRoot && (
          <button className="row min-w-0 max-w-44 shrink-0 gap-1 rounded px-1.5 py-0.5 hover:bg-ide-hover hover:text-ide-text focus-visible:ring-2 focus-visible:ring-ide-accent" onClick={openSourceControl} title={gitStatus?.error || (gitStatus?.isRepo ? `Source Control: ${gitStatus.branch || 'detached HEAD'}${gitStatus.upstream ? ` tracking ${gitStatus.upstream}` : ''}` : 'Open Source Control')} aria-label={`Open Source Control${gitStatus?.branch ? `, branch ${gitStatus.branch}` : ''}`}>
            <GitBranch size={13} className="shrink-0" /> <span className="truncate">{gitStatus?.isRepo ? (gitStatus.branch || 'detached') : 'Source Control'}</span>
            {gitStatus?.isRepo && gitStatus.files.length > 0 && <span className="text-ide-amber" aria-label="Uncommitted changes">*</span>}
          </button>
        )}
        {gitStatus?.isRepo && gitStatus.upstream && (gitStatus.behind > 0 || gitStatus.ahead > 0) && (
          <button className="row shrink-0 gap-1 rounded px-1.5 py-0.5 hover:bg-ide-hover hover:text-ide-text focus-visible:ring-2 focus-visible:ring-ide-accent" onClick={openSourceControl} title={`Tracking ${gitStatus.upstream}: ${gitStatus.behind} behind, ${gitStatus.ahead} ahead. Open Source Control to fetch, pull or push.`} aria-label={`Open Source Control, ${gitStatus.behind} behind and ${gitStatus.ahead} ahead`}>
            <ArrowDown size={12} />{gitStatus.behind} <ArrowUp size={12} />{gitStatus.ahead}
          </button>
        )}
        {workspaceRoot && <button className="row shrink-0 gap-1 rounded px-1.5 py-0.5 hover:bg-ide-hover hover:text-ide-text focus-visible:ring-2 focus-visible:ring-ide-accent" onClick={() => setBottom('problems')} title="Open Problems" aria-label={`Open Problems, ${errors} errors and ${warnings} warnings`}><AlertCircle size={13} className={errors ? 'text-ide-red' : ''} />{errors}<AlertTriangle size={13} className={warnings ? 'text-ide-yellow' : ''} />{warnings}</button>}
        {/* The running text is cyan, not the identity navy: navy at 11px on
            ide-bar measures 3.59:1 and fails AA, and this is the one status
            text that exists during every build. Cyan is 7.04:1 and is not
            spoken for here (moss is exit 0, red is failure, amber is unsaved). */}
        {busy ? (
          <span className="row shrink-0 gap-1 px-1 text-ide-cyan">
            <CircleDot size={12} className="animate-pulse" />
            {running ? (runPhase === 'compile' ? 'Compiling...' : 'Running...') : 'Simulating...'}
          </span>
        ) : lastExitCode !== null ? (
          <span className={`row shrink-0 gap-1 px-1 ${lastExitCode === 0 ? 'text-ide-moss' : 'text-ide-red'}`}>
            {lastExitCode === 0 ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
            exit {lastExitCode}
          </span>
        ) : null}
      </div>
      <div className="row min-w-0 shrink-0 gap-2">
        {/* These read as controls (they are in every JetBrains IDE), so make them controls. */}
        <button
          className="row max-w-40 gap-1 rounded px-1 hover:bg-ide-hover hover:text-ide-text focus-visible:ring-2 focus-visible:ring-ide-accent"
          onClick={() => { if (!sidebarVisible || sidebarView !== 'serial') setSidebar('serial') }}
          title="Open Serial & Devices"
        >
          <Radio size={12} className={serialOpen ? 'shrink-0 text-ide-moss' : 'shrink-0'} /> <span className="truncate">{serialOpen ? serialPath : 'Serial off'}</span>
        </button>
        {/* Read from platformio.ini, not guessed - see projectModelService.
            Absent for a project that doesn't have one, rather than a wrong board. */}
        {board && (
          <span
            className="row hidden max-w-36 gap-1 truncate lg:flex"
            title={`Board: ${board.name}${board.platform ? `\nPlatform: ${board.platform}` : ''}${board.framework ? `\nFramework: ${board.framework}` : ''}\nFrom platformio.ini [env:${board.env}]`}
          >
            <MemoryStick size={12} /> {board.name}
          </span>
        )}
        {lspLang && (
          <span
            className={`row hidden gap-1 xl:flex ${lspIndexing ? 'text-ide-cyan' : lspReady ? 'text-ide-moss' : 'text-ide-muted'}`}
            title={
              lspIndexing
                ? LSP_BUSY_HINT[lspLang]
                : lspReady
                  ? `${LSP_SERVER_LABEL[lspLang]} is providing code intelligence (completion, hover, diagnostics)`
                  : `${LSP_SERVER_LABEL[lspLang]} is not installed, so this file has basic highlighting only.\n${LSP_INSTALL_HINT[lspLang]}\nThen press Rescan in Settings; no restart needed.`
            }
          >
            <Braces size={12} className={lspIndexing ? 'animate-pulse' : ''} /> {LSP_SERVER_LABEL[lspLang]}
            {lspIndexing ? ' indexing...' : lspReady ? '' : ' off'}
          </span>
        )}
        {activeTab && (
          <>
            <span className="hidden lg:inline">{activeTab.language.label}</span>
            {/* Real, from the file's own content - not a hardcoded "UTF-8". */}
            <span className="hidden xl:inline" title="Line endings">{lineEnding(activeTab.content)}</span>
            {/* Only while the editor is up: the readout is a live editor cursor,
                not a stale value carried into the Simulator. It is retained (not
                cleared) across a tab switch so the segment never blinks out. */}
            {cursorPos && mainView === 'editor' && (
              <span className="mono tabular-nums" title="Line and column">
                Ln {cursorPos.line}, Col {cursorPos.column}
              </span>
            )}
            <span className={`hidden lg:inline ${activeTab.content !== activeTab.savedContent ? 'text-ide-amber' : ''}`}>
              {activeTab.content !== activeTab.savedContent ? '● unsaved' : 'saved'}
            </span>
          </>
        )}

        {/* Notifications: the bell + a history popover. Opening marks the log
            seen (clears the unread count). Async results also flash as toasts. */}
        <div className="relative">
          <button
            className={`row gap-1 rounded px-1 hover:bg-ide-hover hover:text-ide-text focus-visible:ring-2 focus-visible:ring-ide-accent ${notifUnread > 0 ? 'text-ide-text' : ''}`}
            onClick={() => {
              setNotifOpen((o) => !o)
              markNotifsRead()
            }}
            title="Notifications"
            aria-label={notifUnread > 0 ? `Notifications (${notifUnread} new)` : 'Notifications'}
          >
            <Bell size={12} />
            {notifUnread > 0 && <span className="mono text-[10px] text-ide-accent">{notifUnread}</span>}
          </button>
          {notifOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setNotifOpen(false)} />
              <div className="absolute bottom-full right-0 z-50 mb-1 max-h-[60vh] w-80 overflow-auto rounded-md border border-ide-border bg-ide-panel shadow-xl">
                <div className="row sticky top-0 items-center justify-between border-b border-ide-border bg-ide-panel px-3 py-1.5">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-ide-faint">Notifications</span>
                  {notifications.length > 0 && (
                    <button
                      className="row gap-1 rounded px-1 py-0.5 text-[10px] text-ide-muted hover:bg-ide-hover hover:text-ide-text"
                      onClick={clearNotifications}
                      title="Clear all"
                    >
                      <Trash2 size={11} /> Clear
                    </button>
                  )}
                </div>
                {notifications.length === 0 ? (
                  <div className="px-3 py-3 text-[11px] text-ide-faint">
                    No notifications yet. Build, upload, and run results appear here.
                  </div>
                ) : (
                  notifications.map((n) => (
                    <div key={n.id} className="row items-start gap-2 px-3 py-1.5 text-[12px]">
                      <div className="mt-0.5">{NOTIF_ICON[n.kind]}</div>
                      <div className="min-w-0 flex-1">
                        <div className="text-ide-text">{n.title}</div>
                        {n.detail && <div className="truncate text-[11px] text-ide-muted" title={n.detail}>{n.detail}</div>}
                      </div>
                      <span className="mono shrink-0 text-[10px] text-ide-faint">
                        {new Date(n.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
