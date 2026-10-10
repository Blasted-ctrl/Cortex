import { useState } from 'react'
import { Folder, CircleDot, Radio, AlertCircle, CheckCircle2, Braces, MemoryStick, Bell, Info, Trash2 } from 'lucide-react'
import { useStore } from '../store/useStore'
import { langForFile, LSP_SERVER_LABEL, LSP_INSTALL_HINT, LSP_BUSY_HINT } from '@shared/lsp'
import { lineEnding } from '@shared/textInfo'

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
    workspaceName,
    setSidebar,
    simRunning,
    lspServers,
    lspBusy,
    projectModel,
    cursorPos,
    mainView,
    notifications,
    notifUnread,
    markNotifsRead,
    clearNotifications
  } = useStore()
  const [notifOpen, setNotifOpen] = useState(false)
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

  return (
    <div className="relative row h-6 shrink-0 justify-between border-t border-ide-border bg-ide-bar px-2 text-[11px] text-ide-muted">
      {/* The one expressive moment: a moving gradient line while building/running. */}
      {busy && (
        <div className="absolute inset-x-0 top-0 h-0.5 animate-gradient-slide bg-cortex-gradient bg-[length:200%_100%]" />
      )}
      <div className="row gap-3">
        <span className="row gap-1">
          {/* This labels the open workspace; Git branch details belong to the Git panel. */}
          <Folder size={12} /> {workspaceName || 'no folder'}
        </span>
        {/* The running text is cyan, not the identity navy: navy at 11px on
            ide-bar measures 3.59:1 and fails AA, and this is the one status
            text that exists during every build. Cyan is 7.04:1 and is not
            spoken for here (moss is exit 0, red is failure, amber is unsaved). */}
        {busy ? (
          <span className="row gap-1 text-ide-cyan">
            <CircleDot size={12} className="animate-pulse" />
            {running ? (runPhase === 'compile' ? 'Compiling...' : 'Running...') : 'Simulating...'}
          </span>
        ) : lastExitCode !== null ? (
          <span className={`row gap-1 ${lastExitCode === 0 ? 'text-ide-moss' : 'text-ide-red'}`}>
            {lastExitCode === 0 ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
            exit {lastExitCode}
          </span>
        ) : null}
      </div>
      <div className="row gap-3">
        {/* These read as controls (they are in every JetBrains IDE), so make them controls. */}
        <button
          className="row gap-1 rounded px-1 hover:bg-ide-hover hover:text-ide-text"
          onClick={() => setSidebar('serial')}
          title="Open Serial & Devices"
        >
          <Radio size={12} className={serialOpen ? 'text-ide-moss' : ''} /> {serialOpen ? serialPath : 'serial off'}
        </button>
        {/* Read from platformio.ini, not guessed - see projectModelService.
            Absent for a project that doesn't have one, rather than a wrong board. */}
        {board && (
          <span
            className="row gap-1"
            title={`Board: ${board.name}${board.platform ? `\nPlatform: ${board.platform}` : ''}${board.framework ? `\nFramework: ${board.framework}` : ''}\nFrom platformio.ini [env:${board.env}]`}
          >
            <MemoryStick size={12} /> {board.name}
          </span>
        )}
        {lspLang && (
          <span
            className={`row gap-1 ${lspIndexing ? 'text-ide-cyan' : lspReady ? 'text-ide-moss' : 'text-ide-muted'}`}
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
            <span>{activeTab.language.label}</span>
            {/* Real, from the file's own content - not a hardcoded "UTF-8". */}
            <span title="Line endings">{lineEnding(activeTab.content)}</span>
            {/* Only while the editor is up: the readout is a live editor cursor,
                not a stale value carried into the Simulator. It is retained (not
                cleared) across a tab switch so the segment never blinks out. */}
            {cursorPos && mainView === 'editor' && (
              <span className="mono tabular-nums" title="Line and column">
                Ln {cursorPos.line}, Col {cursorPos.column}
              </span>
            )}
            <span className={activeTab.content !== activeTab.savedContent ? 'text-ide-amber' : ''}>
              {activeTab.content !== activeTab.savedContent ? '● unsaved' : 'saved'}
            </span>
          </>
        )}

        {/* Notifications: the bell + a history popover. Opening marks the log
            seen (clears the unread count). Async results also flash as toasts. */}
        <div className="relative">
          <button
            className={`row gap-1 rounded px-1 hover:bg-ide-hover hover:text-ide-text ${notifUnread > 0 ? 'text-ide-text' : ''}`}
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
