import type { BrowserWindow } from 'electron'
import { homedir } from 'os'
import type { TerminalCreateRequest, TerminalCreateResult } from '../../shared/ipc'
import { IPC } from '../../shared/ipc'
import { getWorkspaceRoot } from './fsService'
import { pickShell, clampDim, MAX_TERMINALS } from '../../shared/terminalConfig'

// node-pty is a native optional dependency. Load it lazily so a machine without
// the prebuilt binary (or the build tools to make one) still starts the IDE; the
// terminal simply reports itself unavailable. Same pattern as serialService.
type PtyModule = typeof import('@homebridge/node-pty-prebuilt-multiarch')
type IPty = ReturnType<PtyModule['spawn']>
let mod: PtyModule | null | undefined

async function load(): Promise<PtyModule | null> {
  if (mod !== undefined) return mod
  try {
    mod = (await import('@homebridge/node-pty-prebuilt-multiarch')) as PtyModule
  } catch {
    mod = null
  }
  return mod
}

export async function isAvailable(): Promise<boolean> {
  return (await load()) !== null
}

const sessions = new Map<string, IPty>()
let shutdownGeneration = 0

function send(win: BrowserWindow, channel: string, payload: unknown): void {
  if (!win.isDestroyed()) win.webContents.send(channel, payload)
}

/**
 * Spawn a shell for a renderer-minted session id and stream its output back.
 * The cwd is the trusted open-workspace root (or the home dir when nothing is
 * open), never a renderer-supplied path. The shell is spawned as file + argv,
 * so no string from anywhere is interpolated into a command line; the user's
 * keystrokes reach it only through write().
 */
export async function create(win: BrowserWindow, req: TerminalCreateRequest): Promise<TerminalCreateResult> {
  const generation = shutdownGeneration
  const m = await load()
  if (generation !== shutdownGeneration || win.isDestroyed()) {
    return { ok: false, error: 'Terminal creation was cancelled during window teardown.' }
  }
  if (!m) return { ok: false, error: 'The terminal backend (node-pty) is unavailable on this machine.' }
  if (sessions.has(req.id)) return { ok: false, error: 'A terminal with this id already exists.' }
  if (sessions.size >= MAX_TERMINALS) {
    return { ok: false, error: `Too many terminals open (max ${MAX_TERMINALS}). Close one first.` }
  }

  const cwd = getWorkspaceRoot() || homedir()
  const shell = pickShell(process.platform, process.env)
  const cols = clampDim(req.cols, 80)
  const rows = clampDim(req.rows, 24)

  let pty: IPty
  try {
    pty = m.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as { [k: string]: string }
    })
  } catch (e) {
    return { ok: false, error: `Failed to start ${shell.file}: ${e instanceof Error ? e.message : String(e)}` }
  }

  sessions.set(req.id, pty)
  pty.onData((data) => {
    if (sessions.get(req.id) !== pty) return
    send(win, IPC.TERMINAL_DATA, { id: req.id, data })
  })
  pty.onExit(({ exitCode, signal }) => {
    if (sessions.get(req.id) !== pty) return
    sessions.delete(req.id)
    send(win, IPC.TERMINAL_EXIT, { id: req.id, exitCode, signal })
  })
  return { ok: true, id: req.id, shell: shell.file, cwd }
}

export function write(id: string, data: string): void {
  const p = sessions.get(id)
  if (p && typeof data === 'string') p.write(data)
}

export function resize(id: string, cols: number, rows: number): void {
  const p = sessions.get(id)
  if (!p) return
  try {
    p.resize(clampDim(cols, 80), clampDim(rows, 24))
  } catch {
    // The pty can exit between the renderer's resize and this call; a resize on
    // a dead pty throws. Nothing to do.
  }
}

export function kill(id: string): void {
  const p = sessions.get(id)
  if (!p) return
  sessions.delete(id)
  try {
    p.kill()
  } catch {
    // Already gone.
  }
}

/** Retire owned sessions and pending creates on renderer reload, close or quit. */
export function killAll(): void {
  shutdownGeneration++
  const owned = [...sessions.values()]
  sessions.clear()
  for (const p of owned) {
    try {
      p.kill()
    } catch {
      // Already gone.
    }
  }
}

/** Live session count, for tests and diagnostics. */
export function count(): number {
  return sessions.size
}
