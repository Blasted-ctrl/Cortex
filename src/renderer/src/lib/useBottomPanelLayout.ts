import { useLayoutEffect, useRef, useState } from 'react'

const EDITOR_MIN_HEIGHT = 120
const PANEL_CHROME_HEIGHT = 34
// The editor/panel stack has two gap-2 gutters and a one-pixel splitter.
const STACK_SPACING = 17

function fitPanel(preference: number, available: number): number {
  const usable = Math.max(0, available - STACK_SPACING)
  const editor = Math.min(EDITOR_MIN_HEIGHT, Math.max(0, usable - PANEL_CHROME_HEIGHT))
  return Math.max(0, Math.min(preference, usable - editor))
}

export function useBottomPanelLayout(
  preference: number,
  resize: (height: number) => void,
  project: string | null,
  visible: boolean
) {
  const columnRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(0)
  const height = fitPanel(preference, available)

  useLayoutEffect(() => {
    const column = columnRef.current
    if (!column || !visible) { setAvailable(0); return }
    const measure = (): void => { setAvailable(column.getBoundingClientRect().height) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(column)
    return () => observer.disconnect()
  }, [project, visible])

  const onDelta = (delta: number): void => {
    // A stored preference can exceed the visible cap. Use the actual panel so
    // the first small drag changes its height rather than consuming a dead zone.
    const rendered = panelRef.current?.getBoundingClientRect().height ?? height
    resize(rendered - delta)
  }
  return { columnRef, panelRef, height, onDelta }
}
