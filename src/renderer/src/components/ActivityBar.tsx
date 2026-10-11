import {
  Files,
  Search,
  Network,
  PackageCheck,
  Radio,
  GitBranch,
  Settings,
  CircuitBoard,
  Terminal,
  AlertTriangle
} from 'lucide-react'
import { useStore, type SidebarView } from '../store/useStore'
import MoreTools from './MoreTools'

type Item = { view: SidebarView; icon: typeof Files; label: string }

// Primary tools stay pinned in the rail: finding code, the hardware graph, the
// environment, the docs, and the wire - the surfaces used across a whole
// session. The occasional package-manager installers and the contextual
// debugger move into "More tools" so the rail is a short, scannable column
// rather than a wall of a dozen icons.
const PRIMARY: Item[] = [
  { view: 'explorer', icon: Files, label: 'Explorer' },
  { view: 'search', icon: Search, label: 'Search' },
  { view: 'hardware', icon: Network, label: 'Hardware' },
  { view: 'environment', icon: PackageCheck, label: 'Environment' },
  { view: 'serial', icon: Radio, label: 'Serial & Devices' },
  { view: 'vcs', icon: GitBranch, label: 'Source Control' }
]

export default function ActivityBar(): JSX.Element {
  const sidebarView = useStore((s) => s.sidebarView)
  const sidebarVisible = useStore((s) => s.sidebarVisible)
  const mainView = useStore((s) => s.mainView)
  const bottomView = useStore((s) => s.bottomView)
  const bottomVisible = useStore((s) => s.bottomVisible)
  const workspaceRoot = useStore((s) => s.workspaceRoot)
  const setSidebar = useStore((s) => s.setSidebar)
  const setMainView = useStore((s) => s.setMainView)
  const setBottom = useStore((s) => s.setBottom)
  const openTerminal = useStore((s) => s.openTerminal)
  const toggleBottom = useStore((s) => s.toggleBottom)

  // Terminal only lives in the editor view; clicking it there toggles it.
  const terminalActive = bottomVisible && bottomView === 'terminal' && mainView === 'editor'
  // Mirror terminalActive's editor guard: the bottom dock is not rendered in the
  // simulator, so without it Problems would stay lit while hidden and need two
  // clicks (the first would toggleBottom() a dock that is not on screen).
  const problemsActive = bottomVisible && bottomView === 'problems' && mainView === 'editor'
  // Toggle Problems in the bottom dock. setBottom routes back to the editor view
  // (the dock only renders there), so no separate mainView handling is needed.
  const showProblems = (): void => {
    if (problemsActive) toggleBottom()
    else setBottom('problems')
  }

  const railButton = (active: boolean, label: string, Icon: typeof Files, onClick: () => void): JSX.Element => (
    <button
      key={label}
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`relative flex h-11 w-full items-center justify-center transition-colors ${
        active ? 'text-ide-text' : 'text-ide-faint hover:text-ide-text'
      }`}
    >
      {active && <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded bg-cortex-gradient-v" />}
      <Icon size={22} strokeWidth={1.6} />
    </button>
  )

  const divider = <div className="my-1.5 h-px w-6 shrink-0 bg-ide-border" />

  return (
    <div className="flex w-12 shrink-0 flex-col items-center border-r border-ide-border bg-ide-bar py-2">
      {PRIMARY.map(({ view, icon, label }) =>
        // No mainView gate: the sidebar renders beside the simulator too, so a
        // highlight tied to the editor would contradict the screen.
        railButton(sidebarVisible && sidebarView === view, label, icon, () => setSidebar(view))
      )}

      <MoreTools />

      {divider}

      {/* The Simulator swaps the whole main view. The Agent and Datasheets are
          right-side tools now and live on the right-edge rail. */}
      {railButton(mainView === 'simulator', 'Simulator', CircuitBoard, () =>
        setMainView(mainView === 'simulator' ? 'editor' : 'simulator')
      )}

      <div className="flex-1" />

      {/* Bottom dock quick access: the tools you drop to while working. Shown
          only with a project open, since the dock renders only in the editor
          view of a workspace. (Source Control is a sidebar view in PRIMARY
          above, next to the Explorer, the way VS Code places it.) */}
      {workspaceRoot && (
        <>
          {railButton(terminalActive, 'Terminal', Terminal, () => (terminalActive ? toggleBottom() : openTerminal()))}
          {railButton(problemsActive, 'Problems', AlertTriangle, showProblems)}
          {divider}
        </>
      )}

      {railButton(mainView === 'settings', 'Settings', Settings, () =>
        setMainView(mainView === 'settings' ? 'editor' : 'settings')
      )}
    </div>
  )
}
