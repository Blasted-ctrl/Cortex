import { useEffect, useId, useRef, useState } from 'react'
import { X, FileCode2, FileWarning } from 'lucide-react'
import { useStore } from '../store/useStore'
import CodeEditor from './CodeEditor'
import EmptyState from './EmptyState'
import FileIcon from './FileIcon'
import Splitter from './Splitter'

// The tab being dragged, for the brief span of a drag. dataTransfer carries the
// same path and is the source of truth on drop; this is only so a pane can show
// its drop overlay during dragover (where dataTransfer.getData is unreadable).
let dragPath: string | null = null

const MIN_RATIO = 0.2
const MAX_RATIO = 0.8

export default function EditorArea(): JSX.Element {
  const tabs = useStore((s) => s.tabs)
  const activeGroup = useStore((s) => s.activeGroup)
  const groupActive = useStore((s) => s.groupActive)
  const setActiveInGroup = useStore((s) => s.setActiveInGroup)
  const focusGroup = useStore((s) => s.focusGroup)
  const closeTab = useStore((s) => s.closeTab)
  const moveTabToGroup = useStore((s) => s.moveTabToGroup)
  const reorderTab = useStore((s) => s.reorderTab)
  const workspaceRoot = useStore((s) => s.workspaceRoot)
  const notify = useStore((s) => s.notify)

  const split = tabs.some((t) => t.group === 1)
  const [dragActive, setDragActive] = useState(false)
  const [dropZone, setDropZone] = useState<{ group: number; half: 'left' | 'right' } | null>(null)
  const [ratio, setRatio] = useState(0.5)
  const [containerWidth, setContainerWidth] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const closing = useRef(new Set<string>())
  const mounted = useRef(true)
  const [focusedTabs, setFocusedTabs] = useState<Record<number, string | null>>({})
  const [focusRequest, setFocusRequest] = useState<{ root: string | null; path: string | null } | null>(null)
  const id = useId()
  const leftPaneId = `${id}-left-pane`
  const pathToken = (path: string): string => Array.from(path, (character) => character.codePointAt(0)!.toString(16)).join('-')
  const tabId = (path: string): string => `${id}-tab-${pathToken(path)}`
  const panelId = (path: string): string => `${id}-panel-${pathToken(path)}`

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => {
    const container = containerRef.current
    if (!split || !container) return
    const measure = (): void => { setContainerWidth(container.clientWidth) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => { observer.disconnect() }
  }, [split])
  useEffect(() => { setFocusedTabs({}); setFocusRequest(null) }, [workspaceRoot])
  useEffect(() => {
    if (!focusRequest || focusRequest.root !== workspaceRoot) return
    if (focusRequest.path) tabRefs.current.get(focusRequest.path)?.focus()
    else containerRef.current?.focus()
  }, [focusRequest, workspaceRoot])

  const focusTab = (group: number, path: string): void => {
    setFocusedTabs((current) => ({ ...current, [group]: path }))
    tabRefs.current.get(path)?.focus()
  }
  const close = async (path: string): Promise<void> => {
    if (closing.current.has(path)) return
    closing.current.add(path)
    try {
      await closeTab(path)
      if (!mounted.current || useStore.getState().workspaceRoot !== workspaceRoot) return
      const current = useStore.getState()
      const remaining = current.tabs.find((tab) => tab.path === path)
      const nextPath = remaining?.path ?? current.activePath
      const nextGroup = remaining?.group ?? current.activeGroup
      setFocusedTabs((previous) => ({ ...previous, [nextGroup]: nextPath }))
      setFocusRequest({ root: workspaceRoot, path: nextPath })
    } catch (error) {
      if (mounted.current && useStore.getState().workspaceRoot === workspaceRoot) notify('error', 'Could not close file', String(error))
    } finally {
      closing.current.delete(path)
    }
  }
  const tabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, group: number, path: string): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const siblings = tabs.filter((tab) => tab.group === group)
    const index = siblings.findIndex((tab) => tab.path === path)
    let next: string | undefined
    switch (event.key) {
      case 'ArrowLeft': next = siblings[(index + siblings.length - 1) % siblings.length]?.path; break
      case 'ArrowRight': next = siblings[(index + 1) % siblings.length]?.path; break
      case 'Home': next = siblings[0]?.path; break
      case 'End': next = siblings.at(-1)?.path; break
      case 'Enter':
      case ' ': setActiveInGroup(group, path); break
      case 'Delete': if (!event.repeat) void close(path); break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    if (next) focusTab(group, next)
  }

  const endDrag = (): void => {
    dragPath = null
    setDragActive(false)
    setDropZone(null)
  }

  // Splitting needs at least two tabs in the source pane: moving the only tab
  // to a new group just collapses straight back, so a single tab offers no split.
  const canSplit = !split && tabs.filter((t) => t.group === 0).length > 1

  const onPaneDrop = (group: number, half: 'left' | 'right'): void => {
    const path = dragPath
    endDrag()
    if (!path) return
    // Before a split exists, the drop half picks the destination: the right half
    // splits to a new right pane (only when there is a tab to spare), left half
    // stays. Once split, dropping onto a pane moves the tab into that pane's group.
    const target = split ? group : half === 'right' && canSplit ? 1 : 0
    moveTabToGroup(path, target)
  }

  const onTabStripDrop = (group: number, index: number, after: boolean): void => {
    const path = dragPath
    endDrag()
    if (!path) return
    const dragged = tabs.find((t) => t.path === path)
    if (!dragged) return
    if (dragged.group !== group) {
      moveTabToGroup(path, group) // cross-group: lands in the other pane (reorder there is a later refinement)
      return
    }
    // Insert before or after the dropped-on tab based on the pointer. Removing
    // the dragged tab first shifts every position after it, so drop one earlier
    // when the tab was to the left of the target.
    const siblings = tabs.filter((t) => t.group === group)
    const fromIdx = siblings.findIndex((t) => t.path === path)
    let target = index + (after ? 1 : 0)
    if (fromIdx > -1 && fromIdx < target) target -= 1
    reorderTab(path, target)
  }

  const onSplitterDelta = (delta: number): void => {
    const w = containerRef.current?.clientWidth ?? 0
    if (!w) return
    setRatio((r) => Math.max(MIN_RATIO, Math.min(MAX_RATIO, r + delta / w)))
  }
  const onSplitterBoundary = (boundary: 'min' | 'max'): void => {
    if (!(containerRef.current?.clientWidth ?? 0)) return
    setRatio(boundary === 'min' ? MIN_RATIO : MAX_RATIO)
  }

  const pane = (group: number): JSX.Element => {
    const groupTabs = tabs.filter((t) => t.group === group)
    const paneActivePath = groupActive[group] ?? null
    const paneActiveTab = groupTabs.find((t) => t.path === paneActivePath)
    const focused = activeGroup === group
    const entryPath = groupTabs.some((tab) => tab.path === focusedTabs[group]) ? focusedTabs[group]
      : paneActivePath ?? groupTabs[0]?.path

    return (
      <div
        id={group === 0 ? leftPaneId : undefined}
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-ide-bg"
        style={split && group === 0 ? { flex: `0 0 ${ratio * 100}%` } : undefined}
        onMouseDownCapture={() => {
          if (!focused) focusGroup(group)
        }}
        onFocusCapture={() => {
          if (!focused) focusGroup(group)
        }}
      >
        {/* Tab strip */}
        <div role="tablist" aria-label={split ? `${group === 0 ? 'Left' : 'Right'} editor tabs` : 'Editor tabs'} className="row h-9 shrink-0 overflow-x-auto border-b border-ide-border bg-ide-panel">
          {groupTabs.map((tab, index) => {
            const active = tab.path === paneActivePath
            const dirty = tab.content !== tab.savedContent
            return (
              <div
                key={tab.path}
                role="presentation"
                draggable
                onDragStart={(e) => {
                  dragPath = tab.path
                  setDragActive(true)
                  e.dataTransfer.effectAllowed = 'move'
                  // A custom mime, NOT text/plain: Monaco's drop-into-editor
                  // reacts to text/plain and would paste the file path into the
                  // document when a tab is dropped onto an editor pane.
                  e.dataTransfer.setData('application/x-cortex-tab', tab.path)
                }}
                onDragEnd={endDrag}
                onDragOver={(e) => {
                  if (dragPath) e.preventDefault()
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  const rect = e.currentTarget.getBoundingClientRect()
                  const after = e.clientX - rect.left > rect.width / 2
                  onTabStripDrop(group, index, after)
                }}
                className={`row group relative h-full min-w-0 max-w-[200px] shrink-0 cursor-grab border-r border-ide-border pr-2 text-[12px] transition-colors ${
                  active ? 'bg-ide-bg text-ide-text' : 'text-ide-muted hover:bg-ide-hover'
                }`}
              >
                {/* Selected-tab indicator: the accent bar on the focused pane, a
                    muted bar on the unfocused one, so it is clear which pane has focus. */}
                {active && (
                  <span className={`absolute inset-x-0 top-0 h-0.5 ${focused ? 'bg-ide-accent' : 'bg-ide-faint'}`} />
                )}
                <button
                  ref={(element) => { if (element) tabRefs.current.set(tab.path, element); else tabRefs.current.delete(tab.path) }}
                  type="button"
                  role="tab"
                  id={tabId(tab.path)}
                  aria-controls={panelId(tab.path)}
                  aria-selected={active}
                  aria-label={`${tab.name}${dirty ? ', unsaved changes' : ''}`}
                  aria-describedby={`${id}-tab-help`}
                  tabIndex={entryPath === tab.path ? 0 : -1}
                  onClick={() => setActiveInGroup(group, tab.path)}
                  onFocus={() => setFocusedTabs((current) => ({ ...current, [group]: tab.path }))}
                  onKeyDown={(event) => tabKeyDown(event, group, tab.path)}
                  title={tab.path}
                  className="row h-full min-w-0 flex-1 cursor-pointer gap-1.5 pl-3 pr-1 text-left"
                >
                  <span className="flex shrink-0 items-center">
                    <FileIcon path={tab.path} size={13} />
                  </span>
                  <span className="truncate">{tab.name}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Close ${tab.name}`}
                  tabIndex={-1}
                  onClick={() => void close(tab.path)}
                  title={dirty ? 'Unsaved changes. Click to close' : 'Close'}
                  className="shrink-0 rounded p-0.5 text-ide-faint hover:bg-ide-hover hover:text-ide-text"
                >
                  {/* No unsaved dot next to the tab (removed by the user's
                      request); dirtiness is conveyed by the title only. */}
                  <X size={14} className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" />
                </button>
              </div>
            )
          })}
          {/* Dropping onto the empty strip area appends to this group. */}
          <div
            className="min-w-8 flex-1"
            onDragOver={(e) => {
              if (dragPath) e.preventDefault()
            }}
            onDrop={(e) => {
              e.preventDefault()
              // The empty strip area means "move to the end of this group".
              onTabStripDrop(group, Math.max(0, groupTabs.length - 1), true)
            }}
          />
        </div>
        {groupTabs.filter((tab) => tab.path !== paneActivePath).map((tab) => (
          <div key={tab.path} hidden role="tabpanel" id={panelId(tab.path)} aria-labelledby={tabId(tab.path)} />
        ))}

        {/* Editor surface, with a split/move drop overlay while dragging a tab. */}
        <div
          role="tabpanel"
          id={paneActivePath ? panelId(paneActivePath) : undefined}
          aria-labelledby={paneActivePath ? tabId(paneActivePath) : undefined}
          tabIndex={paneActiveTab?.readOnlyReason ? 0 : undefined}
          className="relative min-h-0 flex-1"
          onDragOver={(e) => {
            if (!dragPath) return
            e.preventDefault()
            const rect = e.currentTarget.getBoundingClientRect()
            const half: 'left' | 'right' = e.clientX - rect.left > rect.width / 2 ? 'right' : 'left'
            setDropZone((z) => (z && z.group === group && z.half === half ? z : { group, half }))
          }}
          onDragLeave={(e) => {
            // Only clear when the pointer actually left this element, not a child.
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setDropZone((z) => (z?.group === group ? null : z))
            }
          }}
          onDrop={(e) => {
            e.preventDefault()
            const rect = e.currentTarget.getBoundingClientRect()
            const half: 'left' | 'right' = e.clientX - rect.left > rect.width / 2 ? 'right' : 'left'
            onPaneDrop(group, half)
          }}
        >
          {paneActiveTab?.readOnlyReason ? (
            <EmptyState icon={<FileWarning size={24} />}>
              {paneActiveTab.readOnlyReason}
              <div className="mt-1 text-[11px] text-ide-faint">{paneActiveTab.name}</div>
            </EmptyState>
          ) : paneActivePath ? (
            <CodeEditor path={paneActivePath} />
          ) : (
            <EmptyState icon={<FileCode2 size={24} />}>
              Select a file in the Explorer to start editing, or press Ctrl+P to search by name.
            </EmptyState>
          )}

          {dragActive && dropZone?.group === group && (split || canSplit) && (
            // Accent-tinted drop target. When already split, the whole pane
            // highlights (drop here to move the tab into this pane). On the
            // single pane, only the half the tab will land in highlights, so
            // the right half reads as "split to the right" (shown only when
            // there is more than one tab, so the affordance is never a no-op).
            <div className="pointer-events-none absolute inset-0 z-20">
              {split ? (
                <div className="absolute inset-0 bg-ide-accent/15 outline outline-1 -outline-offset-1 outline-ide-accent transition-all duration-150" />
              ) : (
                <div
                  className="absolute inset-y-0 bg-ide-accent/15 outline outline-1 -outline-offset-1 outline-ide-accent transition-all duration-150"
                  style={dropZone.half === 'right' ? { left: '50%', right: 0 } : { left: 0, right: '50%' }}
                />
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (tabs.length === 0) {
    return (
      <div ref={containerRef} role="region" tabIndex={-1} aria-label="Editor" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-ide-border bg-ide-bg">
        <div className="h-9 shrink-0 border-b border-ide-border bg-ide-panel" />
        <div className="min-h-0 flex-1">
          <EmptyState icon={<FileCode2 size={24} />}>
            Select a file in the Explorer to start editing, or press Ctrl+P to search by name.
          </EmptyState>
        </div>
      </div>
    )
  }

  return (
    // Plain flex (align-items: stretch), not the `row` utility, so the panes
    // fill the full height instead of centering.
    <div
      ref={containerRef}
      role="region"
      tabIndex={-1}
      aria-label="Editor"
      className="flex min-h-0 flex-1 overflow-hidden rounded-lg border border-ide-border"
    >
      <span id={`${id}-tab-help`} className="sr-only">Use Left and Right arrows to focus tabs, Enter or Space to select, and Delete to close.</span>
      {pane(0)}
      {split && (
        <Splitter
          dir="x"
          label="Left editor pane"
          controls={leftPaneId}
          value={ratio * 100}
          min={containerWidth > 0 ? MIN_RATIO * 100 : ratio * 100}
          max={containerWidth > 0 ? MAX_RATIO * 100 : ratio * 100}
          unit="percent"
          onDelta={onSplitterDelta}
          onBoundary={onSplitterBoundary}
          title="Resize editor split"
        />
      )}
      {split && pane(1)}
    </div>
  )
}
