import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { join, delimiter } from 'path'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc'
import {
  LSP_SERVERS,
  MessageBuffer,
  encodeMessage,
  pathToUri,
  type LspLang,
  type LspCall,
  type LspAvailability
} from '../../shared/lsp'
import { isAllowedCommand } from '../../shared/security'
import { ensureClangdConfig } from './clangdConfig'
import { safeCommand, needsShell } from './commandResolver'

/**
 * Bridges the renderer's Monaco editor to real language servers (clangd,
 * pyright, rust-analyzer) over stdio. One server per (language, workspace);
 * requests are correlated by JSON-RPC id, diagnostics are pushed to the window.
 *
 * A missing server is a normal state, not an error: availableServers() reports
 * what is installed and requests to an absent server resolve to null, so the
 * editor simply has no completions rather than throwing.
 */

// A single request that hangs (a wedged server that never replies but stays
// alive, so onExit never fires) would otherwise leak a pending entry and its
// closure forever, and the renderer's provider promise would never settle.
const REQUEST_TIMEOUT_MS = 20000

// Restart budget for a server that initialises and then dies. More than this
// many crashes inside the window means the cause is the workspace or the file,
// not bad luck, and respawning again just burns cores.
const MAX_CRASHES = 3
const CRASH_WINDOW_MS = 60000

// Per-language settings, pushed to the server as workspace/didChangeConfiguration
// and served back whenever it pulls via workspace/configuration (we answered
// every pull with `{}` before, which is why pyright ran on bare defaults:
// reportUnusedVariable/reportUnusedClass/reportUnusedFunction all off in its
// default "basic" severity table). Verified against the real pyright source
// (node_modules/pyright/dist), not assumed: reportUnusedVariable and its
// siblings are genuine pyright diagnostic rules. `completeFunctionParens` is
// NOT - that one only exists in Pylance (Microsoft's closed-source VS Code
// extension built on pyright), confirmed absent from pyright's own bundle, so
// it's deliberately not here; parens-on-completion is handled client-side in
// lspClient.ts's completion mapping instead, which works for every server.
const LANG_SETTINGS: Partial<Record<LspLang, Record<string, unknown>>> = {
  python: {
    python: {
      analysis: {
        diagnosticSeverityOverrides: {
          reportUnusedVariable: 'warning',
          reportUnusedClass: 'warning',
          reportUnusedFunction: 'warning',
          reportUnusedImport: 'warning',
          reportUnusedExpression: 'warning'
        }
      }
    }
  }
}

/** Walk a dot-separated `workspace/configuration` section against the settings
 * tree above. An unknown section (or no settings for this language) resolves
 * to `{}`, matching what a real settings store returns for an unset key. */
function resolveConfigSection(tree: Record<string, unknown> | undefined, section: string | undefined): unknown {
  if (!tree) return {}
  if (!section) return tree
  let cur: unknown = tree
  for (const part of section.split('.')) {
    if (typeof cur !== 'object' || cur === null) return {}
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur ?? {}
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: unknown) => void
  timer?: ReturnType<typeof setTimeout>
}

interface LspMessage {
  id?: number
  method?: string
  params?: { uri?: string; diagnostics?: unknown[]; items?: unknown[]; value?: unknown; token?: string | number }
  result?: unknown
  error?: unknown
}

class LspServer {
  private proc: ChildProcess | null = null
  private readonly buffer = new MessageBuffer()
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private initialized = false
  // rust-analyzer runs SEVERAL work-done tokens concurrently (Fetching,
  // Roots Scanned, Building CrateGraph, Indexing, cachePriming, flycheck) and
  // their begin/end pairs interleave rather than nest, so a single boolean let
  // the first `end` declare the server ready while it was still loading.
  private readonly busyTokens = new Set<string | number>()
  private initPromise: Promise<void> | null = null
  // Bumped by reset()/dispose(). spawnAndInit awaits ensureClangdConfig (which
  // probes the compiler and can take seconds) before it spawns anything, so a
  // teardown during that window used to be invisible to it: it resumed, spawned
  // clangd, and stored it on an object nobody holds a reference to any more.
  // That clangd outlived the workspace switch, and app quit.
  private generation = 0
  // Repeated crash protection: a server that keeps dying on the same document
  // must not be respawned forever. Timestamps of recent ready-then-died exits.
  private crashes: number[] = []
  private givenUp = false

  constructor(
    private readonly lang: LspLang,
    private readonly root: string,
    private readonly win: BrowserWindow
  ) {}

  private send(msg: unknown): void {
    const p = this.proc
    if (p?.stdin?.writable) p.stdin.write(Buffer.from(encodeMessage(msg)))
  }

  /** Spawn the server and run the initialize handshake exactly once. */
  private start(): Promise<void> {
    // Exhausted its restart budget: refuse rather than spawn another one that
    // will die the same way.
    if (this.givenUp) return Promise.reject(new Error(`${this.lang} language server kept crashing; not restarting it`))
    if (this.initPromise) return this.initPromise
    const p = this.spawnAndInit()
    this.initPromise = p
    // A failed handshake (spawn error, a broken .cmd shim, a JSON-RPC init
    // error, an init timeout) must not poison the server for the whole session:
    // reset so the next request re-attempts instead of reusing a rejected
    // promise. The `.catch` here also swallows the unhandled rejection.
    p.catch(() => this.reset())
    return p
  }

  private async spawnAndInit(): Promise<void> {
    // clangd reads `.clangd` on startup, so the toolchain bridge must be written
    // before the process spawns. Best-effort: a failure here just means clangd
    // runs with its defaults.
    const gen = this.generation
    if (this.lang === 'cpp') await ensureClangdConfig(this.root).catch(() => {})
    if (gen !== this.generation) throw new Error('language server disposed')
    return new Promise<void>((resolve, reject) => {
      const { cmd, args } = LSP_SERVERS[this.lang]
      if (!isAllowedCommand(cmd)) return reject(new Error(`${cmd} is not allowlisted`))
      let proc: ChildProcess
      try {
        // cwd IS the workspace root here, and libuv searches it before PATH on
        // Windows: a repo containing clangd.exe would run on folder open, with
        // no user action at all. Resolve from PATH first.
        const bin = safeCommand(cmd, this.root)
        if (!bin) return reject(new Error(`${cmd} resolved inside the workspace`))
        // pyright's Windows install is a .cmd shim; CreateProcess cannot launch
        // that directly. See needsShell's doc comment.
        proc = spawn(bin, args, { cwd: this.root, windowsHide: true, shell: needsShell(bin) })
      } catch (e) {
        return reject(e)
      }
      if (gen !== this.generation) {
        try {
          proc.kill()
        } catch {
          /* already gone */
        }
        return reject(new Error('language server disposed'))
      }
      this.proc = proc
      proc.on('error', reject) // ENOENT etc.
      proc.stdin?.on('error', () => {})
      proc.stdout?.on('data', (chunk: Buffer) => this.onData(proc, chunk))
      proc.stderr?.on('data', () => {}) // servers log to stderr; not our concern
      proc.on('exit', () => this.onExit())

      const id = this.nextId++
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error('language server initialize timed out'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: () => {
          this.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          const settings = LANG_SETTINGS[this.lang]
          // Push proactively too, not just answer pulls: a server that only
          // asks for config lazily (on first relevant request) would otherwise
          // analyse the first file or two on bare defaults.
          if (settings) this.send({ jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: { settings } })
          this.initialized = true
          resolve()
        },
        reject,
        timer
      })
      this.send({ jsonrpc: '2.0', id, method: 'initialize', params: this.initParams() })
    })
  }

  private initParams(): unknown {
    return {
      processId: process.pid,
      rootUri: pathToUri(this.root),
      capabilities: {
        textDocument: {
          synchronization: { didSave: true, dynamicRegistration: false },
          completion: {
            completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] }
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: { dynamicRegistration: false },
          signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'] } },
          publishDiagnostics: { relatedInformation: true }
        },
        workspace: { configuration: true },
        // Without this a server never sends $/progress, so there is no way to
        // know it is still warming up. rust-analyzer in particular answers
        // requests with empty results for as long as it is loading the Cargo
        // workspace, which reads to the user as "IntelliSense is broken".
        window: { workDoneProgress: true }
      }
    }
  }

  private onData(proc: ChildProcess, chunk: Buffer): void {
    // Bytes Node had already buffered keep arriving after teardown. Without this
    // guard a late $/progress 'begin' re-armed busyTokens AFTER clearBusy had
    // pushed busy:false, stranding the status bar on "indexing..." forever.
    if (this.proc !== proc) return
    this.buffer.append(new Uint8Array(chunk))
    let msg: unknown
    while ((msg = this.buffer.next()) !== null) this.handle(msg as LspMessage)
  }

  private handle(msg: LspMessage): void {
    // A response to one of our requests.
    if (msg.id !== undefined && !msg.method && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (p.timer) clearTimeout(p.timer)
      if (msg.error !== undefined) p.reject(msg.error)
      else p.resolve(msg.result)
      return
    }
    // Diagnostics push.
    if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
      if (!this.win.isDestroyed()) {
        this.win.webContents.send(IPC.LSP_DIAGNOSTICS, {
          uri: msg.params.uri,
          diagnostics: msg.params.diagnostics ?? []
        })
      }
      return
    }
    // Progress. rust-analyzer reports its Cargo load / indexing this way, and
    // until it ends the server answers requests with empty results. Surface it
    // so the UI can say "indexing" rather than implying IntelliSense is ready.
    if (msg.method === '$/progress' && msg.params) {
      const value = (msg.params as { value?: { kind?: string; title?: string } }).value
      const token = msg.params.token ?? '__default'
      if (value?.kind === 'begin') this.busyTokens.add(token)
      else if (value?.kind === 'end') this.busyTokens.delete(token)
      else return // 'report' is progress within a job, not a state change
      this.pushBusy(value.title)
      return
    }
    // A server -> client REQUEST (has id AND method). Answer minimally so the
    // server does not stall waiting: real per-language settings for a
    // workspace/configuration pull (see LANG_SETTINGS), no dynamic registration.
    if (msg.id !== undefined && msg.method) {
      const settings = LANG_SETTINGS[this.lang]
      const result =
        msg.method === 'workspace/configuration'
          ? ((msg.params?.items ?? []) as Array<{ section?: string }>).map((it) =>
              resolveConfigSection(settings, it.section)
            )
          : null
      this.send({ jsonrpc: '2.0', id: msg.id, result })
    }
    // Other notifications (window/logMessage, $/progress) are ignored.
  }

  request(method: string, params: unknown): Promise<unknown> {
    const run = (): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = this.nextId++
        const timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error('language server request timed out'))
        }, REQUEST_TIMEOUT_MS)
        this.pending.set(id, { resolve, reject, timer })
        this.send({ jsonrpc: '2.0', id, method, params })
      })
    return this.initialized ? run() : this.start().then(run)
  }

  private lastToolchainCheck = 0

  /**
   * clangd reads `.clangd` only at startup, so a compiler installed (or removed)
   * while Cortex is open leaves it analysing against the old headers. On a file
   * open, re-derive the config (throttled; it is cheap once the probe is cached)
   * and, only when it actually changed, restart the server and have the renderer
   * replay its open documents into the new one.
   */
  private refreshToolchain(): void {
    if (this.lang !== 'cpp' || !this.initialized) return
    const now = performance.now()
    if (now - this.lastToolchainCheck < 15_000) return
    this.lastToolchainCheck = now
    const gen = this.generation
    void ensureClangdConfig(this.root)
      .then((changed) => {
        if (!changed || gen !== this.generation || this.win.isDestroyed()) return
        this.reset()
        this.win.webContents.send(IPC.LSP_SERVER_EXIT, { lang: this.lang, root: this.root })
      })
      .catch(() => {})
  }

  notify(method: string, params: unknown): void {
    if (method === 'textDocument/didOpen') this.refreshToolchain()
    const doIt = (): void => this.send({ jsonrpc: '2.0', method, params })
    if (this.initialized) doIt()
    else void this.start().then(doIt).catch(() => {})
  }

  /** Tear the server down to a clean, restartable state. Idempotent: kills the
   * process (listeners removed so a kill cannot re-enter here), fails every
   * in-flight request, and clears the partial-frame buffer so a respawn does
   * not splice new output onto a dead process's leftover bytes. */
  /** Tell the renderer whether this server is still loading. Busy is true while
   * ANY work-done token is open. */
  private pushBusy(title?: string): void {
    if (this.win.isDestroyed()) return
    this.win.webContents.send(IPC.LSP_BUSY, {
      lang: this.lang,
      busy: this.busyTokens.size > 0,
      title
    })
  }

  /** Drop all progress state and tell the renderer we are no longer indexing.
   * Without this a server that dies between `begin` and `end` leaves the status
   * bar pulsing "indexing..." for the rest of the session. */
  private clearBusy(): void {
    if (this.busyTokens.size === 0) return
    this.busyTokens.clear()
    this.pushBusy()
  }

  private reset(): void {
    this.generation++
    this.clearBusy()
    const p = this.proc
    this.proc = null
    if (p) {
      // removeAllListeners on the ChildProcess does NOT touch its streams, and
      // a live stdout listener keeps `this` (and the window) reachable.
      p.stdout?.removeAllListeners('data')
      p.stderr?.removeAllListeners('data')
      p.removeAllListeners()
      p.stdin?.on('error', () => {})
      try {
        p.kill()
      } catch {
        /* already gone */
      }
    }
    this.pending.forEach((x) => {
      if (x.timer) clearTimeout(x.timer)
      x.reject(new Error('language server unavailable'))
    })
    this.pending.clear()
    this.initialized = false
    this.initPromise = null
    this.buffer.reset()
  }

  private onExit(): void {
    const wasReady = this.initialized
    this.reset()
    if (!wasReady || this.win.isDestroyed()) return
    // A server that had initialised and then died leaves the renderer's
    // documents open against a process that no longer exists. Tell the renderer
    // so it replays didOpen on the respawn; without this, completion/hover/
    // diagnostics go silently dead for every open file until each tab is
    // reopened.
    //
    // But that replay is also what respawns the server, so a file that makes
    // clangd fault while building its preamble closed a loop with nothing to
    // damp it: crash, replay, initialize, crash. The original `wasReady` gate
    // was reasoned backwards (it assumed a fresh server gets no replay, when the
    // replay is exactly what creates it) and spun clangd processes at full core
    // until the tab was closed. So the replay gets a budget.
    this.crashes = this.crashes.filter((t) => performance.now() - t < CRASH_WINDOW_MS)
    this.crashes.push(performance.now())
    if (this.crashes.length > MAX_CRASHES) {
      // Stop asking. Reporting the server as unavailable is the honest state and
      // the status bar already renders it ("clangd off") rather than showing a
      // green badge over an IntelliSense that will never answer.
      this.givenUp = true
      this.win.webContents.send(IPC.LSP_SERVER_EXIT, { lang: this.lang, root: this.root, givenUp: true })
      return
    }
    this.win.webContents.send(IPC.LSP_SERVER_EXIT, { lang: this.lang, root: this.root })
  }

  /** Forget the crash history so this server may be started again. */
  allowRestart(): void {
    this.crashes = []
    this.givenUp = false
  }

  dispose(): void {
    this.generation++
    this.clearBusy()
    const p = this.proc
    if (p) {
      // Remove listeners first so this intentional shutdown does not fire onExit
      // (which would push a spurious LSP_SERVER_EXIT and trigger a replay).
      // The streams need detaching separately: removeAllListeners on the
      // ChildProcess leaves stdout's 'data' handler attached, and buffered bytes
      // arriving after this could re-arm busyTokens behind clearBusy's back.
      p.stdout?.removeAllListeners('data')
      p.stderr?.removeAllListeners('data')
      p.removeAllListeners()
      p.stdin?.on('error', () => {})
      try {
        this.send({ jsonrpc: '2.0', method: 'shutdown', params: null })
        this.send({ jsonrpc: '2.0', method: 'exit', params: null })
      } catch {
        /* already gone */
      }
    }
    this.proc = null
    this.pending.forEach((x) => {
      if (x.timer) clearTimeout(x.timer)
      x.reject(new Error('language server disposed'))
    })
    this.pending.clear()
    this.initialized = false
    this.initPromise = null
    this.buffer.reset()
    if (p) {
      try {
        p.kill()
      } catch {
        /* already gone */
      }
    }
  }
}

const servers = new Map<string, LspServer>()

function get(call: LspCall, win: BrowserWindow): LspServer {
  const key = `${call.lang}:${call.root}`
  let s = servers.get(key)
  if (!s) {
    s = new LspServer(call.lang, call.root, win)
    servers.set(key, s)
  }
  return s
}

// ---- availability (checked once, cheaply, without running the server) ------

const availCache = new Map<LspLang, boolean>()

function commandExists(cmd: string): boolean {
  const dirs = (process.env.PATH || '').split(delimiter)
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  return dirs.some((dir) => {
    if (!dir) return false
    return exts.some((ext) => {
      try {
        return existsSync(join(dir, cmd + ext))
      } catch {
        return false
      }
    })
  })
}

function has(lang: LspLang): boolean {
  const cached = availCache.get(lang)
  if (cached !== undefined) return cached
  const { cmd } = LSP_SERVERS[lang]
  const ok = isAllowedCommand(cmd) && commandExists(cmd)
  availCache.set(lang, ok)
  return ok
}

// ---- public API used by the IPC layer --------------------------------------

/**
 * @param refresh re-probe the PATH instead of trusting the cache. Without this
 * a server installed while Cortex is open stays invisible until a full restart,
 * because availability was resolved once at startup.
 */
export function availableServers(refresh = false): LspAvailability {
  if (refresh) {
    availCache.clear()
    // A refresh is user-initiated (the rescan in Settings, or reopening a
    // workspace), and it is the one signal that something may have changed. A
    // server that exhausted its restart budget would otherwise stay off for the
    // rest of the session even after the user fixed the file that crashed it.
    servers.forEach((s) => s.allowRestart())
  }
  return { cpp: has('cpp'), python: has('python'), rust: has('rust') }
}

/** Requests never throw across IPC: an absent/erroring server yields null. */
export async function request(win: BrowserWindow, call: LspCall): Promise<unknown> {
  if (!has(call.lang)) return null
  try {
    return await get(call, win).request(call.method, call.params)
  } catch {
    return null
  }
}

export function notify(win: BrowserWindow, call: LspCall): void {
  if (!has(call.lang)) return
  get(call, win).notify(call.method, call.params)
}

export function killAll(): void {
  servers.forEach((s) => s.dispose())
  servers.clear()
}

/**
 * Dispose every server whose workspace root is not `keepRoot`. Called when the
 * user switches folders so the previous project's servers (each holding a
 * background index in memory) do not leak for the rest of the session.
 */
export function disposeExcept(keepRoot: string): void {
  for (const [key, s] of servers) {
    // key is `${lang}:${root}`; lang has no colon, so everything after the first
    // colon is the root (which itself may contain a Windows drive colon).
    const root = key.slice(key.indexOf(':') + 1)
    if (root === keepRoot) continue
    s.dispose()
    servers.delete(key)
  }
}
