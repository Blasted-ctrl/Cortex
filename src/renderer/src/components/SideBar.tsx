import { useEffect, useState, type RefObject } from 'react'
import FileExplorer from './FileExplorer'
import SearchPanel from './SearchPanel'
import BoardsManagerPanel from './BoardsManagerPanel'
import LibraryManagerPanel from './LibraryManagerPanel'
import HardwarePanel from './HardwarePanel'
import EnvironmentPanel from './EnvironmentPanel'
import DebugPanel from './DebugPanel'
import DevicesPanel from './DevicesPanel'
import VcsPanel from './VcsPanel'
import { useStore } from '../store/useStore'

export default function SideBar({ width, panelRef }: { width: number; panelRef: RefObject<HTMLDivElement> }): JSX.Element {
  const view = useStore((s) => s.sidebarView)
  const visible = useStore((s) => s.sidebarVisible)
  const workspaceRoot = useStore((s) => s.workspaceRoot)
  const [debugMounted, setDebugMounted] = useState(view === 'debug')
  useEffect(() => { if (view === 'debug') setDebugMounted(true) }, [view])

  return (
    <div
      ref={panelRef}
      className={`${visible ? 'flex' : 'hidden'} shrink-0 flex-col overflow-hidden rounded-lg border border-ide-border bg-ide-panel`}
      style={{ width }}
    >
      {view === 'explorer' && <FileExplorer />}
      {view === 'search' && <SearchPanel />}
      {view === 'boards' && <BoardsManagerPanel />}
      {view === 'libraries' && <LibraryManagerPanel />}
      {view === 'hardware' && <HardwarePanel />}
      {view === 'environment' && <EnvironmentPanel />}
      {(debugMounted || view === 'debug') && (
        <div className={view === 'debug' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          <DebugPanel key={workspaceRoot ?? ''} />
        </div>
      )}
      {view === 'serial' && <DevicesPanel />}
      {view === 'vcs' && <VcsPanel />}
    </div>
  )
}
