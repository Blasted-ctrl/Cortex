import { useEffect, useState } from 'react'
import { useStore, LAST_WORKSPACE_KEY } from './store/useStore'
import CommandPalette, { type PaletteMode } from './components/CommandPalette'
import ConfirmDialog from './components/ConfirmDialog'
import Toasts from './components/Toasts'
import Splitter from './components/Splitter'
import TitleBar from './components/TitleBar'
import Toolbar from './components/Toolbar'
import ActivityBar from './components/ActivityBar'
import SideBar from './components/SideBar'
import EditorArea from './components/EditorArea'
import BottomPanel from './components/BottomPanel'
import StatusBar from './components/StatusBar'
import AiPanel from './components/AiPanel'
import DatasheetsDock from './components/DatasheetsDock'
import RightRail from './components/RightRail'
import SimulatorView from './components/SimulatorView'
import SettingsView from './components/SettingsView'
import Welcome from './components/Welcome'
import Splash from './components/Splash'

/** Run an action on the focused Monaco editor (used by the Ctrl+T format
 *  accelerator). No-op when no editor is mounted. */
function runEditorAction(actionId: string): void {
  const ed = (window as unknown as { __cortexEditor?: { focus(): void; getAction(id: string): { run: () => void } | null } })
    .__cortexEditor
  if (!ed) return
  ed.focus()
  ed.getAction(actionId)?.run()
}

export default function App(): JSX.Element {
  const {
    workspaceRoot,
    mainView,
    sidebarVisible,
    bottomVisible,
    rightView,
    appendOutput,
    handleRunExit,
    handleDiagnostics,
    handleSimEvent,
    handleSimExit,
    appendSerial,
    appendAiDelta,
    finishAi,
    loadSettings,
    detectToolchains,
    refreshBoardStatus,
    refreshTree,
    saveActive,
    saveAll,
    runActive,
    toggleSidebar,
    toggleBottom,
    sidebarWidth,
    aiWidth,
    bottomHeight,
    setSidebarWidth,
    setAiWidth,
    setBottomHeight,
    openWorkspace,
    removeRecent,
    setSidebar,
    setMainView,
    setBottom,
    setSerialPlot
  } = useStore()

  // The active theme drives the <html data-theme> stamp that flips every ide-*
  // token (index.css) and the Monaco editor theme. Selected narrowly so only a
  // theme change re-runs the effect, not every settings write.
  const theme = useStore((s) => s.settings?.theme ?? 'dark')

  const [palette, setPalette] = useState<PaletteMode | null>(null)
  // booting drives the splash's fade; splashMounted keeps it in the tree until
  // the fade finishes (an invisible full-screen overlay still eats clicks).
  const [booting, setBooting] = useState(true)
  const [splashMounted, setSplashMounted] = useState(true)

  // Subscribe to streamed events from the main process.
  useEffect(() => {
    const unsubs = [
      window.api.onRunOutput(appendOutput),
      window.api.onRunExit(handleRunExit),
      window.api.onRunDiagnostics(handleDiagnostics),
      window.api.onSimEvent(handleSimEvent),
      window.api.onSimExit(handleSimExit),
      window.api.onDebugState((s) => useStore.getState().setDebug(s)),
      window.api.onDebugOutput((o) => useStore.getState().appendDebugOutput(o)),
      window.api.onSerialData((d) => {
        if (d.path === useStore.getState().serialPath) appendSerial(d.data)
      }),
      // Keep s.message: "Access is denied" / "port not found" is the whole
      // explanation, and discarding it left the user with a toggle that did nothing.
      window.api.onSerialStatus((s) => {
        if (s.path !== useStore.getState().serialPath) return
        useStore.setState({
          serialOpen: s.open,
          serialError: s.open ? null : (s.message ?? null)
        })
      }),
      window.api.onAiStream((s) => {
        if (s.delta) appendAiDelta(s.delta)
        if (s.done) finishAi(s.error)
      }),
      window.api.onAgentEvent((e) => useStore.getState().handleAgentEvent(e)),
      window.api.onFsEvent(() => {
        void refreshTree()
      })
    ]
    return () => unsubs.forEach((u) => u())
  }, [
    appendOutput,
    handleRunExit,
    handleDiagnostics,
    handleSimEvent,
    handleSimExit,
    appendSerial,
    appendAiDelta,
    finishAi,
    refreshTree
  ])

  // Initial load.
  useEffect(() => {
    // Toolchain and board detection are slow (cold process spawns, up to the
    // probe timeout) and the status bar already narrates them, so they must not
    // hold the splash. They keep running behind it.
    void detectToolchains()
    void refreshBoardStatus()

    // Settings (theme, compiler) and the last workspace DO gate a clean first
    // paint, so the splash waits for them. The minimum duration is so the
    // breathing is seen rather than flashing past on a fast machine.
    const minSplash = new Promise((r) => setTimeout(r, 1200))
    const boot = (async () => {
      await loadSettings()
      // Reopen the last workspace: an IDE that forgets your project every launch
      // makes you re-pick it forever. If it has since moved, forget it quietly.
      const last = localStorage.getItem(LAST_WORKSPACE_KEY)
      if (last) {
        try {
          await openWorkspace(last)
        } catch {
          localStorage.removeItem(LAST_WORKSPACE_KEY)
          removeRecent(last)
        }
      }
    })()
    void Promise.all([minSplash, boot]).then(() => setBooting(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Apply the theme to the document root. Dark is the default, so only Light
  // needs the stamp; clearing it (rather than writing data-theme="dark") keeps
  // the bare :root as the single source of the dark palette.
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'light') root.setAttribute('data-theme', 'light')
    else root.removeAttribute('data-theme')
  }, [theme])

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setPalette('commands')
      } else if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setPalette('files')
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveActive().catch(() => {})
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleSidebar()
      } else if (mod && e.key === '`') {
        // VS Code parity: toggle the integrated terminal. Hide it when it is the
        // visible terminal in the editor; otherwise open it (openTerminal leaves
        // the simulator and no-ops with no workspace, so this never dead-ends).
        e.preventDefault()
        const st = useStore.getState()
        if (st.bottomVisible && st.bottomView === 'terminal' && st.mainView === 'editor') toggleBottom()
        else st.openTerminal()
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
        // Serial Monitor (the accelerator the Tools menu advertises).
        e.preventDefault()
        setSerialPlot(false)
        setBottom('serial')
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'i') {
        // Manage Libraries (advertised in the Tools menu).
        e.preventDefault()
        setSidebar('libraries')
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 'o') {
        // Open Folder (advertised in the File menu).
        e.preventDefault()
        void window.api.openFolder().then((d) => {
          if (d) return openWorkspace(d)
          return undefined
        }).catch((error) => useStore.getState().notify('error', 'Could not open project', String(error)))
      } else if (mod && e.key === ',') {
        // Settings (advertised in the File menu): a full editor-area surface.
        e.preventDefault()
        setMainView('settings')
      } else if (mod && !e.shiftKey && e.key.toLowerCase() === 't') {
        // Auto Format (advertised in the Sketch menu); real now that a
        // formatting provider is registered for C/C++/Rust. Only when the editor
        // is the visible surface: it is kept mounted behind the Simulator /
        // Settings, so an unguarded format would silently reformat and dirty the
        // hidden document.
        if (useStore.getState().mainView !== 'editor') return
        e.preventDefault()
        runEditorAction('editor.action.formatDocument')
      } else if (e.key === 'F5') {
        e.preventDefault()
        void runActive()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveActive, toggleSidebar, toggleBottom, runActive, setSidebar, setMainView, setBottom, setSerialPlot, openWorkspace])

  // Closing the window used to just discard unsaved tabs. Main intercepts the
  // close once and waits here instead of dropping the window immediately, so
  // there's time to flush every dirty tab to disk before it actually goes.
  useEffect(() => {
    let closing = false
    return window.api.onCloseRequested(() => {
      if (closing) return
      closing = true
      void (async () => {
        try {
          await saveAll()
          const store = useStore.getState()
          if (store.simDiagramDirty) await store.saveDiagram()
          const current = useStore.getState()
          if (current.simDiagramDirty || current.tabs.some((tab) => !tab.readOnlyReason && tab.content !== tab.savedContent)) {
            throw new Error('New changes were made while saving. Save and try closing again.')
          }
          await window.api.readyToClose()
        } catch (error) {
          useStore.getState().notify('error', 'Cortex stayed open to protect your changes', `${error instanceof Error ? error.message : String(error)} Retry saving, then close again.`)
        } finally {
          closing = false
        }
      })()
    })
  }, [saveAll])

  // The menu bar lives in the title bar and cannot reach this component's
  // palette state directly, so its Command Palette / Quick Open items post an
  // event here.
  useEffect(() => {
    const onPalette = (e: Event): void => {
      const mode = (e as CustomEvent<PaletteMode>).detail
      if (mode === 'commands' || mode === 'files') setPalette(mode)
    }
    window.addEventListener('cortex:palette', onPalette)
    return () => window.removeEventListener('cortex:palette', onPalette)
  }, [])

  return (
    <div className="flex h-full flex-col bg-ide-bg text-ide-text">
      {splashMounted && <Splash leaving={!booting} onExited={() => setSplashMounted(false)} />}
      {palette && <CommandPalette mode={palette} onClose={() => setPalette(null)} />}
      <ConfirmDialog />
      <Toasts />
      <TitleBar />
      {/* The run/build toolbar belongs to the editor working on a project.
          Hidden on the Welcome screen (nothing to run) and in the Simulator
          (which carries its own Run/Stop), so it never shows a dead or
          duplicate control. */}
      {workspaceRoot && mainView === 'editor' && <Toolbar />}
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        {/* Framed "island" workspace: the tool panels float as rounded cards on
            the ide-bg field, separated by a consistent gutter. The splitters
            live in those gutters, so a resize handle reads as the seam between
            two islands rather than a third panel. */}
        <div className="flex min-h-0 min-w-0 flex-1 gap-2 p-2">
          <SideBar />
          {sidebarVisible && <Splitter dir="x" title="Resize sidebar" onDelta={(d) => setSidebarWidth(sidebarWidth + d)} />}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* The editor stays MOUNTED across view switches (hidden, not
                unmounted) so Monaco keeps each file's undo history, scroll and
                cursor when you dip into the Simulator or Settings and come back
                - remounting it discarded all three. A ResizeObserver in
                CodeEditor relayouts the editor when it is shown again. The
                Tailwind `hidden` utility (display:none) is used deliberately
                instead of the bare [hidden] attribute, which a `flex` class
                would override. */}
            {workspaceRoot && (
              <div
                className={mainView === 'editor' ? 'flex min-h-0 min-w-0 flex-1 flex-col gap-2' : 'hidden'}
              >
                <EditorArea />
                {bottomVisible && (
                  <>
                    <Splitter dir="y" title="Resize panel" onDelta={(d) => setBottomHeight(bottomHeight - d)} />
                    <BottomPanel />
                  </>
                )}
              </div>
            )}
            {mainView === 'simulator' && <SimulatorView />}
            {mainView === 'settings' && <SettingsView />}
            {mainView === 'editor' && !workspaceRoot && <Welcome />}
          </div>
          {/* Right dock: the Agent or the Datasheets, whichever the right rail
              selected. One splitter/width serves both. */}
          {rightView && (
            <>
              <Splitter dir="x" title="Resize panel" onDelta={(d) => setAiWidth(aiWidth - d)} />
              {rightView === 'agent' ? <AiPanel /> : <DatasheetsDock />}
            </>
          )}
        </div>
        {/* The right-edge tool rail, flush to the window like the ActivityBar. */}
        <RightRail />
      </div>
      <StatusBar />
    </div>
  )
}
