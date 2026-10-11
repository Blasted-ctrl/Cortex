import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Bug, Cpu, Library, MoreHorizontal } from 'lucide-react'
import { useStore, type SidebarView } from '../store/useStore'

const MORE: { view: SidebarView; icon: typeof Cpu; label: string }[] = [
  { view: 'boards', icon: Cpu, label: 'Boards Manager' },
  { view: 'libraries', icon: Library, label: 'Library Manager' },
  { view: 'debug', icon: Bug, label: 'Debug' }
]

export default function MoreTools(): JSX.Element {
  const sidebarView = useStore((s) => s.sidebarView)
  const sidebarVisible = useStore((s) => s.sidebarVisible)
  const setSidebar = useStore((s) => s.setSidebar)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const openingIndex = useRef(0)
  const id = useId()
  const triggerId = `${id}-more-trigger`
  const menuId = `${id}-more-menu`
  const active = open || (sidebarVisible && MORE.some((item) => item.view === sidebarView))

  useEffect(() => { if (open) itemRefs.current[openingIndex.current]?.focus() }, [open])

  const openMenu = (index: number): void => {
    openingIndex.current = index
    if (open) itemRefs.current[index]?.focus()
    else setOpen(true)
  }
  const dismiss = (): void => {
    triggerRef.current?.focus()
    setOpen(false)
  }
  const triggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    event.stopPropagation()
    openMenu(event.key === 'ArrowUp' ? MORE.length - 1 : 0)
  }
  const menuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && event.key !== 'Tab')) return
    const index = itemRefs.current.findIndex((item) => item === event.target)
    if (index < 0) return
    let next: number
    switch (event.key) {
      case 'ArrowDown': next = (index + 1) % MORE.length; break
      case 'ArrowUp': next = (index + MORE.length - 1) % MORE.length; break
      case 'Home': next = 0; break
      case 'End': next = MORE.length - 1; break
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        dismiss()
        return
      case 'Tab':
        // Native Tab must continue from a connected trigger, not a removed item.
        dismiss()
        return
      default:
        if (event.key.length !== 1) return
        next = MORE.findIndex((item) => item.label[0].toLowerCase() === event.key.toLowerCase())
        if (next < 0) return
    }
    event.preventDefault()
    event.stopPropagation()
    itemRefs.current[next]?.focus()
  }

  return (
    <div className="relative w-full">
      <button
        ref={triggerRef}
        type="button"
        id={triggerId}
        title="More tools"
        aria-label="More tools"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-pressed={active}
        onClick={() => open ? dismiss() : openMenu(0)}
        onKeyDown={triggerKeyDown}
        className={`relative z-50 flex h-11 w-full items-center justify-center transition-colors ${
          active ? 'text-ide-text' : 'text-ide-faint hover:text-ide-text'
        }`}
      >
        {active && <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded bg-cortex-gradient-v" />}
        <MoreHorizontal size={22} strokeWidth={1.6} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            id={menuId}
            role="menu"
            aria-labelledby={triggerId}
            onKeyDown={menuKeyDown}
            className="absolute left-full top-0 z-50 ml-1 w-52 rounded-md border border-ide-border bg-ide-panel py-1 shadow-xl"
          >
            <div className="px-3 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-ide-faint">
              More tools
            </div>
            {MORE.map(({ view, icon: Icon, label }, index) => {
              const selected = sidebarVisible && sidebarView === view
              return (
                <button
                  key={view}
                  ref={(element) => { itemRefs.current[index] = element }}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={`row w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12px] hover:bg-ide-hover ${
                    selected ? 'text-ide-text' : 'text-ide-muted'
                  }`}
                  onClick={() => { setSidebar(view); dismiss() }}
                >
                  <Icon size={15} className={selected ? 'text-ide-accent' : ''} />
                  {label}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
