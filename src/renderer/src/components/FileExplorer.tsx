import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, ChevronDown, Folder, FolderOpen, RefreshCw, FilePlus, FolderPlus } from 'lucide-react'
import { useStore } from '../store/useStore'
import PanelHeader from './PanelHeader'
import EmptyState from './EmptyState'
import type { FileNode } from '@shared/ipc'
import { visibleTreeEntries, type VisibleTreeEntry } from '@shared/treeNavigation'
import { normPath } from '@shared/pathIdentity'
import FileIcon from './FileIcon'

const parentDir = (p: string): string => p.replace(/[\\/][^\\/]+$/, '')

function TreeIcon({ node }: { node: FileNode }): JSX.Element {
  // Folders already show a chevron for expand state; a second arrow here read as
  // a duplicate. Use a folder glyph instead, and the real per-language mark for files.
  if (node.isDir) return <Folder size={14} className="text-ide-amber" />
  return <FileIcon path={node.path} size={14} />
}

interface DialogState {
  mode: 'rename' | 'newFile' | 'newFolder'
  dir: string
  path?: string
  value: string
}

/**
 * The VS Code-style inline row: an editable name field in place of a tree row,
 * instead of a modal floating over the tree. Enter and blur both commit (blur
 * commits rather than discards, matching VS Code - clicking away after typing
 * a real name should not silently throw it out); Escape cancels. `settledRef`
 * stops both firing for the same interaction: Enter moves focus, which then
 * fires blur too, and without the guard that is two commits for one keypress.
 */
function InlineEditRow({
  depth,
  value,
  isDir,
  label,
  onChange,
  onCommit,
  onCancel
}: {
  depth: number
  value: string
  isDir: boolean
  label: string
  onChange: (v: string) => void
  onCommit: () => Promise<void>
  onCancel: () => void
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const settledRef = useRef(false)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commitOnce = (): void => {
    if (settledRef.current) return
    settledRef.current = true
    void onCommit().finally(() => { settledRef.current = false })
  }
  const cancelOnce = (): void => {
    if (settledRef.current) return
    settledRef.current = true
    onCancel()
  }

  return (
    <div className="row h-[24px] w-full gap-1 pr-2 text-[13px]" style={{ paddingLeft: depth * 12 + 6 }}>
      <span className="w-[14px]" />
      <span className="flex w-[14px] shrink-0 items-center justify-center">
        {/* The icon follows the extension live: naming it main.py mid-type
            shows the Python mark before you've even hit Enter. */}
        {isDir ? <Folder size={14} className="text-ide-amber" /> : <FileIcon path={value || 'untitled.txt'} size={14} />}
      </span>
      <input
        ref={inputRef}
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={commitOnce}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Otherwise Ctrl+S / F5 and the tree's own shortcuts see this keystroke too.
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            commitOnce()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancelOnce()
          }
        }}
        className="mono h-[20px] min-w-0 flex-1 rounded-sm border border-ide-accent bg-ide-bg px-1 text-[13px] text-ide-text outline-none"
      />
    </div>
  )
}

type OnContext = (x: number, y: number, node: FileNode) => void

interface EditProps {
  dialog: DialogState | null
  onChangeValue: (v: string) => void
  onCommit: (target: DialogState) => Promise<void>
  onCancel: (target: DialogState) => void
}

interface NavigationProps {
  focusedPath: string | null
  entries: Map<string, VisibleTreeEntry>
  bind: (path: string, element: HTMLDivElement | null) => void
  focus: (path: string) => void
  remember: (path: string) => void
  activate: (node: FileNode) => void
  keyDown: (event: React.KeyboardEvent<HTMLDivElement>, node: FileNode) => void
}

function TreeRow({
  node,
  depth,
  onContext,
  edit,
  navigation
}: {
  node: FileNode
  depth: number
  onContext: OnContext
  edit: EditProps
  navigation: NavigationProps
}): JSX.Element {
  const activePath = useStore(s => s.activePath)
  const entry = navigation.entries.get(normPath(node.path))
  const isOpen = entry?.expanded ?? false
  const isActive = activePath !== null && normPath(activePath) === normPath(node.path)
  const children = entry?.children
  const { dialog, onChangeValue, onCommit, onCancel } = edit

  const renaming = !!dialog && dialog.mode === 'rename' && dialog.path === node.path
  const creatingHere = !!dialog && dialog.mode !== 'rename' && dialog.dir === node.path && node.isDir && isOpen

  return (
    <div
      ref={(element) => navigation.bind(node.path, element)}
      role="treeitem"
      tabIndex={navigation.focusedPath === node.path && !renaming ? 0 : -1}
      aria-label={node.name}
      aria-level={entry?.level ?? depth + 1}
      aria-posinset={entry?.position}
      aria-setsize={entry?.siblings}
      aria-expanded={node.isDir ? isOpen : undefined}
      aria-selected={node.isDir ? undefined : isActive}
      title={node.path}
      className="outline-none [&:focus-visible>div:first-child]:outline [&:focus-visible>div:first-child]:outline-1 [&:focus-visible>div:first-child]:-outline-offset-1 [&:focus-visible>div:first-child]:outline-ide-accent"
      onFocus={(event) => {
        if (event.target === event.currentTarget) navigation.remember(node.path)
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget) navigation.keyDown(event, node)
      }}
    >
      {renaming && dialog ? (
        <InlineEditRow
          depth={depth}
          value={dialog.value}
          isDir={node.isDir}
          label={`Rename ${node.isDir ? 'folder' : 'file'} ${node.name}`}
          onChange={onChangeValue}
          onCommit={() => onCommit(dialog)}
          onCancel={() => onCancel(dialog)}
        />
      ) : (
        <div
          onClick={() => {
            navigation.focus(node.path)
            navigation.activate(node)
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onContext(e.clientX, e.clientY, node)
          }}
          className={`row h-[24px] w-full cursor-pointer select-none gap-1 pr-2 text-left text-[13px] hover:bg-ide-hover ${
            isActive ? 'bg-ide-active' : ''
          }`}
          style={{ paddingLeft: depth * 12 + 6 }}
        >
          {node.isDir ? (
            isOpen ? (
              <ChevronDown size={14} className="text-ide-muted" />
            ) : (
              <ChevronRight size={14} className="text-ide-muted" />
            )
          ) : (
            <span className="w-[14px]" />
          )}
          <span className="flex w-[14px] shrink-0 items-center justify-center">
            <TreeIcon node={node} />
          </span>
          <span className="truncate">{node.name}</span>
        </div>
      )}
      {node.isDir && isOpen && (
        <div role="group">
          {creatingHere && dialog && (
            <InlineEditRow
              depth={depth + 1}
              value={dialog.value}
              isDir={dialog.mode === 'newFolder'}
              label={`New ${dialog.mode === 'newFolder' ? 'folder' : 'file'} name`}
              onChange={onChangeValue}
              onCommit={() => onCommit(dialog)}
              onCancel={() => onCancel(dialog)}
            />
          )}
          {children?.map((child) => (
            <TreeRow key={child.path} node={child} depth={depth + 1} onContext={onContext} edit={edit} navigation={navigation} />
          ))}
        </div>
      )}
    </div>
  )
}

export default function FileExplorer(): JSX.Element {
  const {
    tree,
    workspaceName,
    workspaceRoot,
    refreshTree,
    openWorkspace,
    renameEntry,
    deleteEntry,
    createNewFile,
    createNewFolder,
    expanded,
    childrenCache,
    activePath,
    openFile,
    toggleDir,
    confirm,
    notify
  } = useStore()
  const [busy, setBusy] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; node: FileNode } | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const menuRef = useRef<HTMLDivElement>(null)
  const entries = useMemo(() => visibleTreeEntries(tree, expanded, childrenCache), [tree, expanded, childrenCache])
  const entryMap = useMemo(() => new Map(entries.map((entry) => [normPath(entry.node.path), entry])), [entries])
  const entryPath = (focusedPath ? entryMap.get(normPath(focusedPath))?.node.path : undefined)
    ?? (activePath ? entryMap.get(normPath(activePath))?.node.path : undefined) ?? entries[0]?.node.path ?? null

  useEffect(() => { setFocusedPath(null); setMenu(null); setDialog(null) }, [workspaceRoot])
  useEffect(() => { if (menu) menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [menu])

  const focusRow = (path: string): void => {
    setFocusedPath(path)
    const element = rowRefs.current.get(path)
    element?.focus()
  }
  const activate = (node: FileNode): void => {
    void (node.isDir ? toggleDir(node) : openFile(node.path)).catch((error) =>
      notify('error', node.isDir ? 'Could not open folder' : 'Could not open file', String(error)))
  }
  const keyDown = (event: React.KeyboardEvent<HTMLDivElement>, node: FileNode): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    const index = entries.findIndex((entry) => entry.node.path === node.path)
    const current = entries[index]
    if (!current) return
    let next: string | undefined
    switch (event.key) {
      case 'ArrowDown': next = entries[Math.min(index + 1, entries.length - 1)]?.node.path; break
      case 'ArrowUp': next = entries[Math.max(0, index - 1)]?.node.path; break
      case 'Home': next = entries[0]?.node.path; break
      case 'End': next = entries.at(-1)?.node.path; break
      case 'ArrowRight':
        if (node.isDir) {
          if (!current.expanded) activate(node)
          else if (entries[index + 1]?.parentPath === node.path) next = entries[index + 1].node.path
        }
        break
      case 'ArrowLeft':
        if (current.expanded) activate(node)
        else next = current.parentPath ?? undefined
        break
      case 'Enter':
      case ' ': activate(node); break
      case 'ContextMenu':
      case 'F10': {
        if (event.key === 'F10' && !event.shiftKey) return
        const rect = event.currentTarget.getBoundingClientRect()
        setMenu({ x: rect.left, y: rect.top + 24, node })
        break
      }
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    focusRow(next ?? node.path)
  }
  const navigation: NavigationProps = {
    focusedPath: entryPath, entries: entryMap, focus: focusRow, remember: setFocusedPath, activate, keyDown,
    bind: (path, element) => { if (element) rowRefs.current.set(path, element); else rowRefs.current.delete(path) }
  }

  useEffect(() => {
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [])

  const handleOpen = async (): Promise<void> => {
    try {
      const dir = await window.api.openFolder()
      if (dir) await openWorkspace(dir)
    } catch (error) {
      notify('error', 'Could not open project', String(error))
    }
  }

  const dirOf = (node: FileNode | null): string =>
    node ? (node.isDir ? node.path : parentDir(node.path)) : workspaceRoot || ''

  const startCreate = (mode: 'newFile' | 'newFolder', node: FileNode | null): void => {
    const dir = dirOf(node)
    // The target folder has to be expanded or the inline row has nowhere to
    // render. A no-op when it's already open (or is the root, which is
    // always "open").
    if (dir !== workspaceRoot && ![...expanded].some(path => normPath(path) === normPath(dir))) void toggleDir({ path: dir, name: '', isDir: true })
    setDialog({ mode, dir, value: '' })
  }

  const startRename = (node: FileNode): void =>
    setDialog({ mode: 'rename', dir: parentDir(node.path), path: node.path, value: node.name })

  // Both take the specific dialog they were bound to (the value at the time the
  // input was rendered), and only clear state if it's STILL the current one.
  // Enter commits, and the blur that follows (focus leaving the about-to-unmount
  // input) can fire a second time - by then the user may have already opened a
  // new dialog, and an unconditional setDialog(null) would wipe that out.
  const commitDialog = async (target: DialogState): Promise<void> => {
    const name = target.value.trim()
    try {
      if (name) {
        if (target.mode === 'newFile') await createNewFile(target.dir, name)
        else if (target.mode === 'newFolder') await createNewFolder(target.dir, name)
        else if (target.mode === 'rename' && target.path) await renameEntry(target.path, name)
      }
      setDialog((cur) => (cur === target ? null : cur))
    } catch (error) {
      notify('error', `Could not ${target.mode === 'rename' ? 'rename' : 'create'} ${name}`, String(error))
    }
  }
  const cancelDialog = (target: DialogState): void => setDialog((cur) => (cur === target ? null : cur))

  const edit: EditProps = {
    dialog,
    onChangeValue: (v) => setDialog((cur) => (cur ? { ...cur, value: v } : cur)),
    onCommit: commitDialog,
    onCancel: cancelDialog
  }

  // Grouped like a native editor's context menu: creation, then clipboard, then
  // the renaming/destructive actions last, with a divider between each group
  // rather than one flat list.
  interface MenuAction {
    label: string
    run: () => void
    danger?: boolean
  }
  const menuGroups: MenuAction[][] = menu
    ? [
        [
          { label: 'New File', run: () => startCreate('newFile', menu.node) },
          { label: 'New Folder', run: () => startCreate('newFolder', menu.node) }
        ],
        [{ label: 'Copy Path', run: () => void navigator.clipboard?.writeText(menu.node.path) }],
        [
          { label: 'Rename', run: () => startRename(menu.node) },
          {
            label: 'Delete',
            danger: true,
            run: () => {
              const node = menu.node
              void confirm({
                title: `Delete ${node.isDir ? 'folder' : 'file'}?`,
                message: `"${node.name}" will be permanently deleted. This cannot be undone.`,
                confirmLabel: 'Delete',
                danger: true
              }).then((ok) => {
                if (ok) void deleteEntry(node.path).catch((error) => notify('error', 'Could not delete entry', String(error)))
              })
            }
          }
        ]
      ]
    : []

  const creatingAtRoot = dialog && dialog.mode !== 'rename' && dialog.dir === workspaceRoot

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        actions={
          <>
            <button
              className="rounded p-1 hover:bg-ide-hover hover:text-ide-text"
              onClick={() => workspaceRoot && startCreate('newFile', null)}
              title="New file"
              aria-label="New file"
            >
              <FilePlus size={14} />
            </button>
            <button
              className="rounded p-1 hover:bg-ide-hover hover:text-ide-text"
              onClick={() => workspaceRoot && startCreate('newFolder', null)}
              title="New folder"
              aria-label="New folder"
            >
              <FolderPlus size={14} />
            </button>
            <button
              className="rounded p-1 hover:bg-ide-hover hover:text-ide-text"
              onClick={async () => {
                setBusy(true)
                const start = Date.now()
                await refreshTree()
                // A local readDir is often faster than a frame, so the spin could
                // start and finish between two paints - the click looked like it
                // did nothing. Floor the busy state so it's actually visible.
                const rest = 400 - (Date.now() - start)
                if (rest > 0) await new Promise((r) => setTimeout(r, rest))
                setBusy(false)
              }}
              title="Refresh"
              aria-label="Refresh project files"
            >
              <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
            </button>
          </>
        }
      >
        {workspaceName || 'Explorer'}
      </PanelHeader>
      <div className="min-h-0 flex-1 overflow-auto pb-2">
        {tree.length === 0 ? (
          <EmptyState
            icon={<FolderOpen size={22} />}
            action={
              <button className="btn border border-ide-border text-[12px]" onClick={handleOpen}>
                <FolderOpen size={14} /> Open folder
              </button>
            }
          >
            No folder is open.
          </EmptyState>
        ) : (
          <div role="tree" aria-label="Project files">
            {creatingAtRoot && dialog && (
              <InlineEditRow
                depth={0}
                value={dialog.value}
                isDir={dialog.mode === 'newFolder'}
                label={`New ${dialog.mode === 'newFolder' ? 'folder' : 'file'} name`}
                onChange={edit.onChangeValue}
                onCommit={() => edit.onCommit(dialog)}
                onCancel={() => edit.onCancel(dialog)}
              />
            )}
            {tree.map((node) => (
              <TreeRow key={node.path} node={node} depth={0} onContext={(x, y, n) => setMenu({ x, y, node: n })} edit={edit} navigation={navigation} />
            ))}
          </div>
        )}
      </div>

      {/* context menu */}
      {menu && (
        <div
          ref={menuRef}
          role="group"
          aria-label="File actions"
          className="fixed z-50 min-w-[220px] overflow-hidden rounded-md border border-ide-border bg-ide-bar py-1.5 text-[13px] shadow-2xl"
          style={{ left: menu.x, top: menu.y }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            setMenu(null)
            focusRow(menu.node.path)
          }}
        >
          {menuGroups.map((group, gi) => (
            <div key={gi} className={gi > 0 ? 'mt-1.5 border-t border-ide-border pt-1.5' : ''}>
              {group.map((a) => (
                <button
                  key={a.label}
                  className={`block w-full px-4 py-1.5 text-left hover:bg-ide-hover ${a.danger ? 'text-ide-red' : ''}`}
                  onClick={() => {
                    focusRow(menu.node.path)
                    a.run()
                    setMenu(null)
                  }}
                >
                  {a.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
