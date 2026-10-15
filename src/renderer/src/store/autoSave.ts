/**
 * Auto save: write dirty editor tabs to disk a moment after the last keystroke.
 *
 * Closing the window saves everything, but a killed process (a closed launcher
 * console, a crash, a dev restart) skips that path and used to lose unsaved
 * edits. Saving shortly after typing stops closes that gap. The timing logic is
 * kept free of React and Electron so it can be tested with fake timers.
 */

export const AUTO_SAVE_DELAY_MS = 1500
const KEY = 'cortex.autoSave'

/** On unless the user turned it off. Storage can be unavailable; then it is on. */
export function readAutoSave(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

export function writeAutoSave(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    /* private window or blocked storage: the preference just will not persist */
  }
}

interface TabLike {
  content: string
  savedContent: string
  readOnlyReason?: string | undefined
}

/** True when any editable tab has unsaved changes. */
export function hasUnsavedEdits(tabs: readonly TabLike[]): boolean {
  return tabs.some((t) => !t.readOnlyReason && t.content !== t.savedContent)
}

interface StoreLike {
  subscribe: (listener: (state: { tabs: readonly TabLike[] }, prev: { tabs: readonly TabLike[] }) => void) => () => void
  getState: () => { tabs: readonly TabLike[] }
}

/**
 * Watch the store and call `save` once typing has paused for `delayMs`. Returns
 * the unsubscribe. A failed save is swallowed here: the tab stays dirty, so the
 * explicit save (and the close flow) still report the real error.
 */
export function startAutoSave(
  store: StoreLike,
  save: () => Promise<void>,
  options: { delayMs?: number; enabled?: () => boolean } = {}
): () => void {
  const delay = options.delayMs ?? AUTO_SAVE_DELAY_MS
  const enabled = options.enabled ?? readAutoSave
  let timer: ReturnType<typeof setTimeout> | null = null
  let saving = false
  const fire = (): void => {
    timer = null
    if (saving || !enabled() || !hasUnsavedEdits(store.getState().tabs)) return
    saving = true
    const startedWith = store.getState().tabs
    void save()
      .catch(() => {})
      .finally(() => {
        saving = false
        // Only when the tabs changed during the write (more typing): a save that
        // failed or left the tab dirty must wait for the next edit, not retry in a loop.
        const now = store.getState().tabs
        if (now !== startedWith && enabled() && hasUnsavedEdits(now) && !timer) timer = setTimeout(fire, delay)
      })
  }
  const unsubscribe = store.subscribe((state, prev) => {
    if (state.tabs === prev.tabs) return
    if (timer) clearTimeout(timer)
    timer = hasUnsavedEdits(state.tabs) ? setTimeout(fire, delay) : null
  })
  return () => {
    unsubscribe()
    if (timer) clearTimeout(timer)
  }
}
