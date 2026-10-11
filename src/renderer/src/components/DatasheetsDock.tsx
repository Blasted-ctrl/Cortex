import type { RefObject } from 'react'
import DatasheetsPanel from './DatasheetsPanel'

/**
 * Datasheets shown in the right dock, framed as an island the same way the AI
 * panel is. DatasheetsPanel is self-contained (its own header + content) and
 * fills the frame; the right-edge rail toggles it, so no separate close button
 * is needed. Reuses the AI panel's width so the right dock keeps one width.
 */
export default function DatasheetsDock({ width, panelRef }: { width: number; panelRef: RefObject<HTMLDivElement> }): JSX.Element {
  return (
    <div
      ref={panelRef}
      className="flex shrink-0 flex-col overflow-hidden rounded-lg border border-ide-border bg-ide-panel"
      style={{ width }}
    >
      <DatasheetsPanel />
    </div>
  )
}
