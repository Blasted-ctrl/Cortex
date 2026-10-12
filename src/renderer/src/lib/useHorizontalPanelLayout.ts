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
function fitWidths(sidebar: number, right: number, budget: number): { sidebarWidth: number; rightWidth: number } {
  if (right === 0) return { sidebarWidth: Math.min(sidebar, budget), rightWidth: 0 }
  if (sidebar === 0) return { sidebarWidth: 0, rightWidth: Math.min(right, budget) }
  const scale = sidebar + right > 0 ? Math.min(1, budget / (sidebar + right)) : 0
  return { sidebarWidth: sidebar * scale, rightWidth: right * scale }
}
type Side = 'sidebar' | 'right'
type Preferences = { sidebar?: number; right?: number }
type Endpoint = { value: number; preferences: Preferences | null }

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
  const { sidebarWidth, rightWidth } = fitWidths(sidebar, right, budget)

  useLayoutEffect(() => {
    const workbench = workbenchRef.current
    if (!workbench) return
    const measure = (): void => { setAvailable(workbench.getBoundingClientRect().width) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(workbench)
    return () => observer.disconnect()
  }, [])

  const preferencesForDelta = (side: Side, delta: number, renderedSidebar: number, renderedRight: number): Preferences | null => {
    if (!sidebarVisible) return { right: renderedRight - delta }
    if (!rightVisible) return { sidebar: renderedSidebar + delta }

    const total = Math.min(budget, renderedSidebar + renderedRight)
    if (total <= 0) return null
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
    return { sidebar: desiredSidebar * savedScale, right: desiredRight * savedScale }
  }
  const commitPreferences = (preferences: Preferences): void => {
    if (preferences.sidebar !== undefined) resizeSidebar(preferences.sidebar)
    if (preferences.right !== undefined) resizeRight(preferences.right)
  }
  const onDelta = (side: Side, delta: number): void => {
    const renderedSidebar = sidebarRef.current?.getBoundingClientRect().width ?? sidebarWidth
    const renderedRight = rightRef.current?.getBoundingClientRect().width ?? rightWidth
    const preferences = preferencesForDelta(side, delta, renderedSidebar, renderedRight)
    if (preferences) commitPreferences(preferences)
  }
  const rangeFor = (side: Side): { min: Endpoint; max: Endpoint } => {
    const current = { value: side === 'sidebar' ? sidebarWidth : rightWidth, preferences: null }
    const endpoints: Endpoint[] = [current]
    if (side === 'sidebar' ? sidebarVisible : rightVisible) {
      for (const delta of [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]) {
        const preferences = preferencesForDelta(side, delta, sidebarWidth, rightWidth)
        if (!preferences) continue
        const nextSidebar = preferences.sidebar === undefined ? sidebar
          : clamp(Math.round(preferences.sidebar), LAYOUT_LIMITS.sidebar.min, LAYOUT_LIMITS.sidebar.max)
        const nextRight = preferences.right === undefined ? right
          : clamp(Math.round(preferences.right), LAYOUT_LIMITS.ai.min, LAYOUT_LIMITS.ai.max)
        const widths = fitWidths(
          sidebarVisible ? normalizeWidth(nextSidebar, LAYOUT_LIMITS.sidebar, 256) : 0,
          rightVisible ? normalizeWidth(nextRight, LAYOUT_LIMITS.ai, 320) : 0,
          budget)
        endpoints.push({ value: side === 'sidebar' ? widths.sidebarWidth : widths.rightWidth, preferences })
      }
    }
    endpoints.sort((a, b) => a.value - b.value)
    return { min: endpoints[0], max: endpoints[endpoints.length - 1] }
  }
  const sidebarRange = rangeFor('sidebar')
  const rightRange = rangeFor('right')
  const onBoundary = (side: Side, edge: 'min' | 'max'): void => {
    const range = side === 'sidebar' ? sidebarRange : rightRange
    const current = side === 'sidebar' ? sidebarWidth : rightWidth
    const endpoint = range[edge]
    if (range.min.value === range.max.value || endpoint.value === current || !endpoint.preferences) return
    commitPreferences(endpoint.preferences)
  }
  return {
    workbenchRef, sidebarRef, rightRef, sidebarWidth, rightWidth,
    sidebarMin: sidebarRange.min.value, sidebarMax: sidebarRange.max.value,
    rightMin: rightRange.min.value, rightMax: rightRange.max.value,
    onSidebarDelta: (delta: number) => onDelta('sidebar', delta),
    onRightDelta: (delta: number) => onDelta('right', delta),
    onSidebarBoundary: (edge: 'min' | 'max') => onBoundary('sidebar', edge),
    onRightBoundary: (edge: 'min' | 'max') => onBoundary('right', edge) }
}
