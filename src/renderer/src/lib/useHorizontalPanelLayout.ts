import { useLayoutEffect, useRef, useState } from 'react'
import { LAYOUT_LIMITS } from '../store/useStore'

const EDITOR_MIN_WIDTH = 320
const WORKBENCH_PADDING = 16
// Each visible dock has two gap-2 gutters and a one-pixel splitter.
const DOCK_SPACING = 17
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
function normalizeWidth(preference: number, limits: { min: number; max: number }, fallback: number): number {
  return clamp(Number.isFinite(preference) ? preference : fallback, limits.min, limits.max)
}

export function useHorizontalPanelLayout(
  sidebarPreference: number,
  rightPreference: number,
  sidebarVisible: boolean,
  rightVisible: boolean,
  resizeSidebar: (width: number) => void,
  resizeRight: (width: number) => void
) {
  const workbenchRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const [available, setAvailable] = useState(0)
  const sidebar = sidebarVisible ? normalizeWidth(sidebarPreference, LAYOUT_LIMITS.sidebar, 256) : 0
  const right = rightVisible ? normalizeWidth(rightPreference, LAYOUT_LIMITS.ai, 320) : 0
  const budget = Math.max(0, available - WORKBENCH_PADDING - DOCK_SPACING * (Number(sidebarVisible) + Number(rightVisible)) - EDITOR_MIN_WIDTH)
  const scale = sidebar + right > 0 ? Math.min(1, budget / (sidebar + right)) : 0
  const sidebarWidth = sidebar * scale
  const rightWidth = right * scale

  useLayoutEffect(() => {
    const workbench = workbenchRef.current
    if (!workbench) return
    const measure = (): void => { setAvailable(workbench.getBoundingClientRect().width) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(workbench)
    return () => observer.disconnect()
  }, [])

  const onDelta = (side: 'sidebar' | 'right', delta: number): void => {
    const renderedSidebar = sidebarRef.current?.getBoundingClientRect().width ?? sidebarWidth
    const renderedRight = rightRef.current?.getBoundingClientRect().width ?? rightWidth
    if (!sidebarVisible) { resizeRight(renderedRight - delta); return }
    if (!rightVisible) { resizeSidebar(renderedSidebar + delta); return }

    const total = Math.min(budget, renderedSidebar + renderedRight)
    if (total <= 0) return
    const fitted = sidebar + right >= budget
    const limits = side === 'sidebar' ? LAYOUT_LIMITS.sidebar : LAYOUT_LIMITS.ai
    const rendered = side === 'sidebar' ? renderedSidebar : renderedRight
    const requestedChange = side === 'sidebar' ? delta : -delta
    const change = fitted ? requestedChange : clamp(requestedChange, limits.min - rendered, limits.max - rendered)
    const desiredTotal = fitted ? total : Math.min(budget, total + change)
    const requestedSidebar = side === 'sidebar' ? renderedSidebar + change : desiredTotal - renderedRight - change
    const minShare = LAYOUT_LIMITS.sidebar.min / (LAYOUT_LIMITS.sidebar.min + LAYOUT_LIMITS.ai.max)
    const maxShare = LAYOUT_LIMITS.sidebar.max / (LAYOUT_LIMITS.sidebar.max + LAYOUT_LIMITS.ai.min)
    const desiredSidebar = clamp(requestedSidebar, desiredTotal * minShare, desiredTotal * maxShare)
    const desiredRight = desiredTotal - desiredSidebar
    // Fitted widths can be below saved minima. Scale the pair together so a
    // deliberate drag preserves its visible ratio within the stored limits.
    const minScale = Math.max(LAYOUT_LIMITS.sidebar.min / desiredSidebar, LAYOUT_LIMITS.ai.min / desiredRight)
    const maxScale = Math.min(LAYOUT_LIMITS.sidebar.max / desiredSidebar, LAYOUT_LIMITS.ai.max / desiredRight)
    const savedScale = clamp(1, minScale, maxScale)
    resizeSidebar(desiredSidebar * savedScale)
    resizeRight(desiredRight * savedScale)
  }
  return {
    workbenchRef, sidebarRef, rightRef, sidebarWidth, rightWidth,
    onSidebarDelta: (delta: number) => onDelta('sidebar', delta),
    onRightDelta: (delta: number) => onDelta('right', delta) }
}
