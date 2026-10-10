/** Only layout metadata is saved. Source bytes always come from disk on reopen. */
export const SESSION_STORAGE_KEY = 'cortex.workspaceSessions.v1'
const MAX_METADATA_CHARS = 512 * 1024
export interface WorkspaceSession {
  version: 1
  root: string
  tabs: { path: string; group: number }[]
  activeGroup: number
  groupActive: Record<number, string | null>
  expanded: string[]
}
interface SessionState {
  workspaceRoot: string | null
  tabs: { path: string; group: number }[]
  activeGroup: number
  groupActive: Record<number, string | null>
  expanded: Set<string>
}
const windowsRoot = (root: string): boolean => /^[a-z]:[\\/]/i.test(root) || /^(\\\\|\/\/)/.test(root)
const normalized = (path: string, windows: boolean): string => (windows ? path.replace(/\\/g, '/') : path).replace(/\/+$/, '') || '/'
const key = (path: string, windows: boolean): string => windows ? path.toLowerCase() : path
function validRoot(root: unknown): root is string {
  return typeof root === 'string' && root.length > 0 && root.length <= 4096 && !/[\x00-\x1f\x7f]/.test(root) &&
    (/^[a-z]:[\\/]/i.test(root) || root.startsWith('/') || root.startsWith('\\\\'))
}
function validRelative(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !/[\\:\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every(segment => !!segment && segment !== '.' && segment !== '..')
}
export function sessionPath(root: string, relative: string): string | null {
  return validRoot(root) && validRelative(relative) ? `${normalized(root, windowsRoot(root)).replace(/\/$/, '')}/${relative}` : null
}
export function sessionRelativePath(root: string, path: string): string | null {
  if (!validRoot(root) || typeof path !== 'string') return null
  const windows = windowsRoot(root)
  const base = normalized(root, windows).replace(/\/$/, '') + '/'
  const target = normalized(path, windows)
  if (!key(target, windows).startsWith(key(base, windows))) return null
  const relative = target.slice(base.length)
  return validRelative(relative) ? relative : null
}
export function captureSession(state: SessionState): WorkspaceSession | null {
  const root = state.workspaceRoot
  if (!validRoot(root)) return null
  const windows = windowsRoot(root)
  // Reserve the root, selections and JSON framing; account each path once.
  let chars = JSON.stringify(root).length + 17 * 1024
  const seen = new Set<string>()
  const tabs: WorkspaceSession['tabs'] = []
  for (const tab of state.tabs) {
    const path = sessionRelativePath(root, tab.path)
    if (!path || seen.has(key(path, windows)) || (tab.group !== 0 && tab.group !== 1)) continue
    seen.add(key(path, windows))
    const size = JSON.stringify({ path, group: tab.group }).length + 1
    if (chars + size > 128 * 1024) break
    chars += size
    tabs.push({ path, group: tab.group })
    if (tabs.length === 50) break
  }
  const expanded: string[] = []
  const dirs = new Set<string>()
  for (const directory of state.expanded) {
    const path = sessionRelativePath(root, directory)
    if (!path || dirs.has(key(path, windows))) continue
    dirs.add(key(path, windows))
    const size = JSON.stringify(path).length + 1
    if (chars + size > 128 * 1024) break
    chars += size
    expanded.push(path)
    if (expanded.length === 100) break
  }
  const active = (group: number): string | null => {
    const path = sessionRelativePath(root, state.groupActive[group] ?? '')
    return tabs.find(tab => tab.group === group && path && key(tab.path, windows) === key(path, windows))?.path ?? null
  }
  const session: WorkspaceSession = { version: 1, root, tabs, expanded, activeGroup: state.activeGroup === 1 ? 1 : 0, groupActive: { 0: active(0), 1: active(1) } }
  return session
}
export function decodeSessions(raw: string | null): WorkspaceSession[] {
  if (!raw || raw.length > MAX_METADATA_CHARS) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    const result: WorkspaceSession[] = []
    for (const item of value.slice(0, 20)) {
      if (!item || typeof item !== 'object' || item.version !== 1 || !validRoot(item.root) || !Array.isArray(item.tabs) ||
        !Array.isArray(item.expanded) || (item.activeGroup !== 0 && item.activeGroup !== 1) || !item.groupActive || typeof item.groupActive !== 'object') continue
      const session = captureSession({
        workspaceRoot: item.root,
        tabs: item.tabs.slice(0, 50).flatMap((tab: unknown) => {
          if (!tab || typeof tab !== 'object' || !('path' in tab) || !('group' in tab) || !validRelative(tab.path) || (tab.group !== 0 && tab.group !== 1)) return []
          const path = sessionPath(item.root, tab.path)
          return path ? [{ path, group: tab.group }] : []
        }),
        expanded: new Set(item.expanded.slice(0, 100).flatMap((path: unknown) => validRelative(path) ? [sessionPath(item.root, path)!] : [])),
        activeGroup: item.activeGroup,
        groupActive: { 0: sessionPath(item.root, item.groupActive[0]) ?? null, 1: sessionPath(item.root, item.groupActive[1]) ?? null }
      })
      if (session && !result.some(previous => key(normalized(previous.root, windowsRoot(previous.root)), windowsRoot(previous.root)) === key(normalized(session.root, windowsRoot(session.root)), windowsRoot(session.root)))) result.push(session)
    }
    return result
  } catch { return [] }
}
export function updateSessions(sessions: WorkspaceSession[], session: WorkspaceSession): WorkspaceSession[] {
  const identity = key(normalized(session.root, windowsRoot(session.root)), windowsRoot(session.root))
  const updated = [session, ...sessions.filter(previous => key(normalized(previous.root, windowsRoot(previous.root)), windowsRoot(previous.root)) !== identity)].slice(0, 20)
  while (updated.length > 1 && JSON.stringify(updated).length > MAX_METADATA_CHARS) updated.pop()
  return updated
}
