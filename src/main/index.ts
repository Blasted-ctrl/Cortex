import { app, shell, BrowserWindow, ipcMain, dialog, session } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { IPC } from '../shared/ipc'
import { guardRendererEvent, guardRendererInvoke, installWindowNavigationGuards, isTrustedRendererSender, resolveRendererDocumentUrl } from './windowSecurity'
import type {
  RunRequest,
  SerialOpenOptions,
  AppInfo,
  ProjectConfig,
  BoardCompileRequest,
  BoardUploadRequest,
  PackageInstallRequest,
  SearchQuery,
  DebugStartRequest,
  SimStartRequest,
  GitDiffKind
} from '../shared/ipc'
import * as fsService from './services/fsService'
import * as search from './services/searchService'
import * as toolchain from './services/toolchainService'
import * as runner from './services/runnerService'
import * as serial from './services/serialService'
import * as settings from './services/settingsService'
import * as ai from './services/aiService'
import type { AiRequest } from './services/aiService'
import * as projectConfig from './services/projectConfigService'
import * as projectModel from './services/projectModelService'
import * as environment from './services/environmentService'
import * as lockfile from './services/lockfileService'
import * as datasheet from './services/datasheetService'
import * as embedded from './services/embeddedService'
import * as arduinoCli from './services/arduinoCliService'
import * as pkg from './services/packageService'
import * as debug from './services/debugService'
import * as git from './services/gitService'
import * as github from './services/githubService'
import * as sim from './services/simService'
import * as firmwareTests from './services/firmwareTests'
import type { FirmwareTestSelection } from '../shared/firmwareTest'
import * as lsp from './services/lspService'
import * as nativeLibs from './services/nativeLibService'
import type { NativeLibInstallRequest, NativeLibQuery } from '../shared/nativeLibs'
import * as terminal from './services/terminalService'
import * as agent from './services/agentService'
import type { LspCall } from '../shared/lsp'
import type { TerminalCreateRequest, AgentRunRequest } from '../shared/ipc'

let mainWindow: BrowserWindow | null = null
let rendererDocumentUrl: string | null = null

// A second instance would clobber settings.json, the file watcher, and the
// serial port. Keep a single instance and focus the existing window instead.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// Never let a stray async error take down the whole main process for 100k users.
process.on('uncaughtException', (err) => {
  console.error('[cortex] uncaughtException:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[cortex] unhandledRejection:', reason)
})

function createWindow(): void {
  rendererDocumentUrl = resolveRendererDocumentUrl(app.isPackaged, process.env['ELECTRON_RENDERER_URL'], join(__dirname, '../renderer/index.html'))
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1f22',
    title: 'Cortex',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  const window = mainWindow
  const documentUrl = rendererDocumentUrl
  // The acknowledgement must belong to this window; an unauthorized invoke
  // cannot consume the handler or enable closing with unsaved tabs.
  let readyToClose = false
  window.on('close', (e) => {
    if (readyToClose) return
    e.preventDefault()
    window.webContents.send(IPC.APP_CLOSE_REQUESTED)
  })
  ipcMain.removeHandler(IPC.APP_READY_TO_CLOSE)
  ipcMain.handle(IPC.APP_READY_TO_CLOSE, guardRendererInvoke(() => mainWindow === window ? window : null, () => documentUrl, () => {
    readyToClose = true
    window.close()
  }))
  window.on('closed', () => {
    runner.disposeWindowRuns(window)
    if (mainWindow !== window) return
    ipcMain.removeHandler(IPC.APP_READY_TO_CLOSE)
    mainWindow = null
    rendererDocumentUrl = null
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    // Dev-only: drive the UI and write screenshots, for the design audit loop.
    if (!app.isPackaged && process.env['CORTEX_CAPTURE_DIR'] && mainWindow) {
      void runCaptureSequence(mainWindow, process.env['CORTEX_CAPTURE_DIR'])
    }
  })

  installWindowNavigationGuards(mainWindow.webContents, rendererDocumentUrl, (url) => shell.openExternal(url))

  // A renderer reload or crash-restart wipes the terminal controller but leaves
  // its pty sessions alive in this process (a reload never runs killAll), so
  // they would accumulate until they hit the per-session cap. Reap them when the
  // renderer starts a fresh top-level load. On the very first load there are no
  // sessions, so this is a no-op there; a dev HMR patch does not reload, so a
  // live shell survives HMR as before.
  mainWindow.webContents.on('did-start-loading', () => { terminal.killAll(); runner.disposeWindowRuns(window) })
  mainWindow.webContents.on('render-process-gone', () => runner.disposeWindowRuns(window))

  void mainWindow.loadURL(rendererDocumentUrl)
}

function requireWindow(): BrowserWindow {
  if (!mainWindow) throw new Error('No active window')
  return mainWindow
}

/**
 * Dev-only screenshot driver. Set CORTEX_CAPTURE_DIR (plus optional
 * CORTEX_CAPTURE_WS / CORTEX_CAPTURE_FILE) to render each major view and write
 * PNGs, then quit. Used by the design-audit loop.
 */
async function runCaptureSequence(win: BrowserWindow, dir: string): Promise<void> {
  const { writeFile, mkdir } = await import('fs/promises')
  await mkdir(dir, { recursive: true })
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const js = (code: string): Promise<unknown> => win.webContents.executeJavaScript(code)
  const snap = async (name: string): Promise<void> => {
    const img = await win.webContents.capturePage()
    await writeFile(join(dir, `${name}.png`), img.toPNG())
  }
  try {
    // The splash breathes for ~1.2s then fades. Wait for the logo to actually
    // be in the DOM (the renderer bundle is heavy, so a fixed delay races first
    // paint) then snap before it goes.
    await js(`new Promise((resolve) => {
      const start = Date.now()
      const tick = () => {
        if (document.querySelector('.cortex-breathe') || Date.now() - start > 5000) {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))
        } else {
          requestAnimationFrame(tick)
        }
      }
      tick()
    })`)
    await wait(200)
    await snap('00-splash')
    await wait(2500)
    await snap('01-welcome')
    const ws = process.env['CORTEX_CAPTURE_WS']
    if (ws) {
      await js(`window.__cortexStore.getState().openWorkspace(${JSON.stringify(ws)})`)
      await wait(1500)
      await snap('02-editor-empty')
      const file = process.env['CORTEX_CAPTURE_FILE']
      if (file) {
        await js(`window.__cortexStore.getState().openFile(${JSON.stringify(file)})`)
        await wait(2000)
        await snap('03-editor')
        // Language-gating probe: assert the chrome matches what Cortex can
        // actually do with this file, rather than eyeballing a screenshot.
        if (process.env['CORTEX_CAPTURE_LANGPROBE']) {
          const gate = await js(`(() => {
            const btn = (label) => [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith(label))
            const run = btn('Run')
            const dbg = btn('Debug')
            const s = window.__cortexStore.getState()
            const tab = s.tabs.find((t) => t.path === s.activePath)
            return {
              file: (s.activePath || '').split(/[\\\\/]/).pop(),
              language: tab && tab.language.label,
              monaco: tab && tab.language.monaco,
              runnable: tab && tab.language.runnable,
              debuggable: tab && tab.language.debuggable,
              runDisabled: run ? run.disabled : null,
              runTitle: run ? run.title : null,
              debugDisabled: dbg ? dbg.disabled : null,
              lspServers: s.lspServers
            }
          })()`)
          await writeFile(join(dir, 'lang-gate.json'), JSON.stringify(gate, null, 2))
          // Actually Run the file and capture what the user would see: the
          // Output text and the parsed diagnostics that drive Problems + the
          // editor gutter.
          if (process.env['CORTEX_CAPTURE_RUN']) {
            await js(`window.__cortexStore.getState().runActive()`)
            await wait(Number(process.env['CORTEX_RUN_WAIT'] ?? 15000))
            const run = await js(`(() => {
              const s = window.__cortexStore.getState()
              return {
                exitCode: s.lastExitCode,
                // Whether the compile -> run transition actually happened: the
                // stdin box and the status bar are both gated on it.
                runPhase: s.runPhase,
                running: s.running,
                diagnostics: s.diagnostics,
                output: s.output.map((o) => o.stream + ': ' + o.text).join('')
              }
            })()`)
            await writeFile(join(dir, 'run-result.json'), JSON.stringify(run, null, 2))
            await snap('run-result')
          }
          // Prove the LSP providers are actually registered for THIS file's
          // Monaco id (Monaco keeps `c` and `cpp` separate, so registering only
          // 'cpp' left .c files with a badge but no completion).
          const trigger = process.env['CORTEX_LSP_TRIGGER']
          if (trigger) {
            const [lineStr, colStr, text] = trigger.split('|')
            await js(`(() => {
              const ed = window.__cortexEditor
              if (!ed) return
              ed.setPosition({ lineNumber: ${Number(lineStr)}, column: 1000 })
              ed.trigger('kb', 'type', { text: ${JSON.stringify('\n' + (text ?? ''))} })
            })()`)
            await wait(Number(process.env['CORTEX_LSP_WAIT'] ?? 2500))
            const comp = await js(`(async () => {
              const s = window.__cortexStore.getState()
              const uri = 'file:///' + s.activePath.replace(/\\\\/g, '/')
              const res = await window.api.lspRequest({
                lang: ${JSON.stringify(process.env['CORTEX_LSP_LANG'] ?? 'cpp')}, root: s.workspaceRoot,
                method: 'textDocument/completion',
                params: { textDocument: { uri }, position: { line: ${Number(lineStr)}, character: ${Number(colStr)} } }
              })
              const items = Array.isArray(res) ? res : (res && res.items) || []
              return items.slice(0, 25).map((i) => i.label)
            })()`)
            await writeFile(join(dir, 'lsp-c-completion.json'), JSON.stringify(comp, null, 2))
            // Which documents the client actually registered, and what the raw
            // request returns. Built here (not in injected JS) to keep escaping
            // simple.
            const probeUri = 'file:///' + file.replace(/\\/g, '/')
            const state = await js(
              `window.__cortexLsp ? { available: window.__cortexLsp.available(), openDocs: window.__cortexLsp.openDocs() } : null`
            )
            const rawReq = await js(
              `window.api.lspRequest(${JSON.stringify({
                lang: process.env['CORTEX_LSP_LANG'] ?? 'cpp',
                root: ws,
                method: 'textDocument/hover',
                params: { textDocument: { uri: probeUri }, position: { line: 4, character: 20 } }
              })}).catch((e) => ({ error: String(e) }))`
            )
            await writeFile(
              join(dir, 'lsp-diag.json'),
              JSON.stringify({ probeUri, state, hover: rawReq }, null, 2)
            )
          }
        }
        // Snap each sidebar panel (skeleton verification). Gated so the normal
        // capture is unaffected.
        if (process.env['CORTEX_CAPTURE_PANELS']) {
          for (const v of ['search', 'boards', 'libraries', 'debug', 'settings']) {
            await js(`window.__cortexStore.getState().setSidebar(${JSON.stringify(v)})`)
            await wait(500)
            await snap(`panel-${v}`)
          }
          // Search with a real query (functional verification).
          await js(`window.__cortexStore.getState().setSidebar('search')`)
          await wait(300)
          await js(`(() => {
            const inp = document.querySelector('input[placeholder="Search files and text..."]')
            if (!inp) return
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
            setter.call(inp, 'MovingAverage')
            inp.dispatchEvent(new Event('input', { bubbles: true }))
          })()`)
          await wait(1000) // debounce + search
          await snap('panel-search-results')
          // Boards Manager: type a filter, then wait for arduino-cli (no daemon;
          // ~10s per call in this environment).
          await js(`window.__cortexStore.getState().setSidebar('boards')`)
          await js(`(() => {
            const inp = document.querySelector('input[placeholder="Filter boards (ESP32, RP2040, AVR)..."]')
            if (!inp) return
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
            setter.call(inp, 'esp32')
            inp.dispatchEvent(new Event('input', { bubbles: true }))
          })()`)
          await wait(22000)
          await snap('panel-boards-live')
          // Deterministic proof of the renderer -> main -> arduino-cli -> parse
          // path, independent of any React timing.
          const coreProbe = await js(`(async () => {
            const t0 = Date.now()
            const r = await window.api.coreSearch('esp32').catch((e) => ({ error: String(e) }))
            return { ms: Date.now() - t0, isArray: Array.isArray(r), count: Array.isArray(r) ? r.length : null,
                     first: Array.isArray(r) && r[0] ? { id: r[0].id, name: r[0].name, latest: r[0].latestVersion, versions: (r[0].versions||[]).length } : r }
          })()`)
          await writeFile(join(dir, 'core-search-probe.json'), JSON.stringify(coreProbe, null, 2))
          // Library Manager with a query.
          await js(`window.__cortexStore.getState().setSidebar('libraries')`)
          await wait(400)
          await js(`(() => {
            const inp = document.querySelector('input[placeholder="Search libraries (Servo, ArduinoJson)..."]')
            if (!inp) return
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
            setter.call(inp, 'servo')
            inp.dispatchEvent(new Event('input', { bubbles: true }))
          })()`)
          await wait(22000)
          await snap('panel-libraries-live')
          await js(`window.__cortexStore.getState().setSidebar('explorer')`)
          await wait(300)
        }
        // Debugger (gdb): set a breakpoint, start, and verify it stops there
        // with a live call stack + variables + current-line highlight.
        if (process.env['CORTEX_CAPTURE_DEBUG'] && /\.(cpp|cc|cxx|c)$/i.test(file)) {
          await js(`window.__cortexStore.getState().toggleBreakpoint(${JSON.stringify(file)}, 30)`)
          await wait(400)
          await snap('debug-breakpoint')
          await js(`window.__cortexStore.getState().startDebug()`)
          await wait(7000) // compile + gdb launch + run to breakpoint
          await snap('debug-stopped')
          const dbg = await js(`(() => {
            const d = window.__cortexStore.getState().debug
            return {
              status: d.status,
              // Without this a failed build and a clean run-to-completion both
              // read as a bare status:'exited'.
              error: d.error,
              reason: d.reason,
              currentLine: d.currentLine,
              frames: d.stack.map((f) => f.func + '@' + f.line),
              variables: d.variables.map((v) => v.name + '=' + v.value)
            }
          })()`)
          // The gdb/compile transcript, not just the resulting state: when a
          // session ends without stopping there is nothing in the state to say
          // whether the build failed, gdb was missing, or the breakpoint simply
          // never bound.
          const dbgOut = await js(
            `window.__cortexStore.getState().output.map((o) => o.stream + ': ' + o.text).join('')`
          )
          await writeFile(join(dir, 'debug-output.txt'), String(dbgOut))
          await writeFile(join(dir, 'debug-state.json'), JSON.stringify(dbg, null, 2))
          await js(`window.__cortexStore.getState().debugStepOver()`)
          await wait(1800)
          await snap('debug-stepped')
          await js(`window.__cortexStore.getState().stopDebug()`)
          await wait(400)
        }
        // Board + Port selector (sketch only): open the dropdown, then the dialog.
        if (process.env['CORTEX_CAPTURE_BOARDPORT'] && /\.ino$/i.test(file)) {
          await js(
            `[...document.querySelectorAll('button')].find((b) => b.title === 'Select board and port')?.click()`
          )
          await wait(500)
          await snap('boardport-dropdown')
          await js(
            `[...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('Select other board and port'))?.click()`
          )
          await wait(700)
          await snap('boardport-dialog')
          await js(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
          await wait(200)
        }
        // LSP completion, C/C++ only. Type a member access, let didChange flush
        // to clangd, then verify two ways: (1) a deterministic completion request
        // over the exact IPC path the Monaco provider uses, whose labels are
        // written to disk, and (2) the visible suggest widget for a screenshot.
        if (/\.(cpp|cc|cxx|c|h|hpp)$/i.test(file)) {
          await wait(2800) // clangd initialize + index
          await js(`(() => {
            const ed = window.__cortexEditor
            if (!ed) return
            ed.setPosition({ lineNumber: 25, column: 100 })
            ed.trigger('kb', 'type', { text: '\\n    tempFilter.' })
          })()`)
          await wait(1800) // didChange debounce (300ms) + clangd reparse
          const uri = 'file:///' + file.replace(/\\/g, '/')
          const labels = await js(`(async () => {
            const root = window.__cortexStore.getState().workspaceRoot
            const res = await window.api.lspRequest({
              lang: 'cpp', root,
              method: 'textDocument/completion',
              params: { textDocument: { uri: ${JSON.stringify(uri)} }, position: { line: 25, character: 15 } }
            })
            const items = Array.isArray(res) ? res : (res && res.items) || []
            return items.map((i) => i.label)
          })()`)
          await writeFile(join(dir, 'lsp-completion.json'), JSON.stringify(labels, null, 2))
          // Hover over MovingAverage (line 25) for a second, stable visual proof.
          const hover = await js(`(async () => {
            const root = window.__cortexStore.getState().workspaceRoot
            const res = await window.api.lspRequest({
              lang: 'cpp', root,
              method: 'textDocument/hover',
              params: { textDocument: { uri: ${JSON.stringify(uri)} }, position: { line: 24, character: 6 } }
            })
            const c = res && res.contents
            return typeof c === 'string' ? c : (c && c.value) || (Array.isArray(c) ? JSON.stringify(c) : null)
          })()`)
          await writeFile(join(dir, 'lsp-hover.json'), JSON.stringify(hover, null, 2))
          // Proof the Monaco providers are live: which servers are available and
          // whether this document is registered (the completion/hover providers
          // key off exactly this registration).
          const lspState = await js(`window.__cortexLsp ? { available: window.__cortexLsp.available(), openDocs: window.__cortexLsp.openDocs() } : null`)
          await writeFile(join(dir, 'lsp-state.json'), JSON.stringify(lspState, null, 2))
          try {
            win.focus()
            win.webContents.focus()
          } catch {
            /* offscreen focus is best-effort */
          }
          // Visible suggest widget: focus the editor first (store manipulation
          // above can steal focus, and Monaco anchors the widget to the focused
          // editor), then snap while it is still open.
          await js(`(() => {
            const ed = window.__cortexEditor
            if (!ed) return
            ed.focus()
            ed.setPosition({ lineNumber: 26, column: 16 })
            ed.trigger('kb', 'editor.action.triggerSuggest', {})
          })()`)
          await wait(1200) // completion round-trip + widget render
          // Read the suggest-widget DOM directly: this proves the Monaco provider
          // (not just direct IPC) rendered clangd's items on screen, independent
          // of whether the offscreen capture composites the overlay layer.
          const widget = await js(`(() => {
            const w = document.querySelector('.monaco-editor .suggest-widget')
            const visible = !!(w && w.classList.contains('visible'))
            const rows = w ? [...w.querySelectorAll('.monaco-list-row')].map((r) => r.textContent.trim()).slice(0, 10) : []
            return { visible, rows }
          })()`)
          await writeFile(join(dir, 'lsp-widget.json'), JSON.stringify(widget, null, 2))
          await snap('03f-lsp-completion')
        }
        // Open a menu so the bar and a dropdown are both captured.
        await js(`(() => {
          const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Sketch')
          if (b) b.click()
        })()`)
        await wait(400)
        await snap('03b-menu')
        await js(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
        await wait(200)
        // Prove a menu item actually acts, from a CLOSED panel (the earlier bug
        // was a stale-read toggle that re-closed it): Tools > Serial Plotter must
        // open the bottom serial panel in plot mode.
        await js(`window.__cortexStore.setState({ bottomVisible: false })`)
        await wait(150)
        await js(`(() => {
          const t = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Tools')
          if (t) t.click()
        })()`)
        await wait(250)
        await js(`(() => {
          const p = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Serial Plotter')
          if (p) p.click()
        })()`)
        await wait(500)
        await snap('03c-plotter')
        // Force board-ready state so the circular Verify/Upload toolbar shows
        // (arduino-cli is not installed on the capture machine).
        await js(`window.__cortexStore.setState({ boardStatus: { available: true, version: '1.0.0' }, selectedFqbn: 'arduino:avr:uno' })`)
        await wait(500)
        await snap('03d-toolbar-board')
        await js(`window.__cortexStore.setState({ boardStatus: null, selectedFqbn: '' })`)
        await wait(200)
        // Help > About: verifies the appInfo fetch and the modal end to end.
        await js(`(() => {
          const h = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Help')
          if (h) h.click()
        })()`)
        await wait(250)
        await js(`(() => {
          const a = [...document.querySelectorAll('button')].find((x) => x.textContent === 'About Cortex')
          if (a) a.click()
        })()`)
        await wait(700)
        await snap('03e-about')
        await js(`(() => {
          const c = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Close')
          if (c) c.click()
        })()`)
        await wait(200)
      }
      await js(`window.__cortexStore.getState().setMainView('simulator')`)
      await wait(1500)
      await snap('04-simulator')
      // 3D board view. The toggle is local component state, so drive it through
      // the DOM the way a user would, then let WebGL paint a couple of frames.
      await js(`(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.title === '3D board view')
        if (btn) btn.click()
      })()`)
      await wait(2500)
      await snap('04b-sim-3d')
      // Each 3D board model.
      await js(`window.__cortexStore.getState().setSim3dBoard('esp32')`)
      await wait(1800)
      await snap('04c-sim-3d-esp32')
      await js(`window.__cortexStore.getState().setSim3dBoard('pi')`)
      await wait(1800)
      await snap('04d-sim-3d-pi')
      await js(`window.__cortexStore.getState().setSim3dBoard('uno')`)
      // A multi-pin part (RGB) to show its per-pin 3D connectors.
      await js(`window.__cortexStore.getState().addPart('rgb')`)
      await wait(1500)
      // Re-assert the view: the board-switch Canvas remount plus a rapid addPart
      // can race the snapshot into a stale frame in the harness.
      await js(`window.__cortexStore.getState().setMainView('simulator')`)
      await wait(300)
      await snap('04e-sim-3d-multipin')
      await js(`(() => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.title === '2D schematic view')
        if (btn) btn.click()
      })()`)
      await wait(400)
      // Prove the panels are resizable (splitters drive these same setters).
      await js(`window.__cortexStore.getState().setMainView('editor')`)
      await js(`window.__cortexStore.getState().setSidebarWidth(420)`)
      await js(`window.__cortexStore.getState().setAiWidth(280)`)
      await js(`window.__cortexStore.getState().setBottomHeight(140)`)
      await wait(1200)
      await snap('05-panels-resized')

      // Small-window passes. Overflow, clipping, and collisions only appear
      // when the layout is starved, and every panel open at 1000x680 is the
      // worst realistic case: a laptop user with the AI panel docked.
      win.setSize(1000, 680)
      await wait(1200)
      await snap('06-small-editor')
      await js(`window.__cortexStore.getState().setMainView('simulator')`)
      await wait(1200)
      await snap('07-small-simulator')
      await js(`window.__cortexStore.getState().setBottom('problems')`)
      await wait(800)
      await snap('08-small-problems')
    }
  } catch (err) {
    console.error('[cortex] capture failed:', err)
  }
  app.quit()
}

function registerIpc(): void {
  const handle: typeof ipcMain.handle = (channel, listener) => {
    ipcMain.handle(channel, guardRendererInvoke(() => mainWindow, () => rendererDocumentUrl, listener))
  }
  const on: typeof ipcMain.on = (channel, listener) =>
    ipcMain.on(channel, guardRendererEvent(() => mainWindow, () => rendererDocumentUrl, listener))

  // ---- dialogs ----
  handle(IPC.DIALOG_OPEN_FOLDER, async () => {
    const res = await dialog.showOpenDialog(requireWindow(), { properties: ['openDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })
  handle(IPC.DIALOG_OPEN_FILE, async () => {
    const res = await dialog.showOpenDialog(requireWindow(), { properties: ['openFile'] })
    return res.canceled ? null : res.filePaths[0]
  })

  // ---- filesystem ----
  handle(IPC.FS_READ_DIR, (_e, p: string) => fsService.readDir(p))
  handle(IPC.FS_LIST_ALL, (_e, p: string) => fsService.listAllFiles(p))
  handle(IPC.FS_SEARCH, (_e, q: SearchQuery) => search.searchInFiles(q))
  handle(IPC.FS_READ_FILE, (_e, p: string) => fsService.readFile(p))
  handle(IPC.FS_READ_WORKSPACE_FILE, (_e, root: string, p: string) => fsService.readWorkspaceFile(root, p))
  handle(IPC.FS_READ_WORKSPACE_DIR, (_e, root: string, p: string) => fsService.readWorkspaceDir(root, p))
  handle(IPC.FS_EXISTS, (_e, p: string) => fsService.exists(p))
  handle(IPC.FS_WRITE_FILE, (_e, p: string, c: string, expectedContent?: string | null) => fsService.writeFile(p, c, expectedContent))
  handle(IPC.FS_CREATE_FILE, (_e, p: string) => fsService.createFile(p))
  handle(IPC.FS_CREATE_DIR, (_e, p: string) => fsService.createDir(p))
  handle(IPC.FS_RENAME, (_e, a: string, b: string) => fsService.rename(a, b))
  handle(IPC.FS_DELETE, (_e, p: string) => fsService.remove(p))
  handle(IPC.FS_WATCH_START, (_e, p: string) => fsService.startWatch(p, requireWindow(), lsp.reloadCompilationDatabase))
  handle(IPC.FS_WATCH_STOP, () => fsService.stopWatch())

  // ---- toolchains ----
  handle(IPC.TOOLCHAIN_DETECT, (_e, force?: boolean) => toolchain.detectToolchains(force))

  // ---- run / build ----
  handle(IPC.RUN_START, (_e, req: RunRequest) => runner.startRun(requireWindow(), req))
  handle(IPC.RUN_STOP, (_e, id: string) => runner.stopRun(id))
  handle(IPC.RUN_INPUT, (_e, id: string, data: string) => runner.sendInput(id, data))
  on(IPC.RUN_OUTPUT_ACK, (_e, token: unknown) => runner.acknowledgeOutput(requireWindow(), token))

  // ---- integrated terminal (pty) ----
  // A user-driven terminal is user-authorized: it spawns the user's own shell
  // at the user's own privileges, with the open workspace as cwd (chosen here,
  // not supplied by the renderer). Input is the user typing; no string is ever
  // interpolated into a shell command by Cortex.
  handle(IPC.TERMINAL_CREATE, (_e, req: TerminalCreateRequest) =>
    terminal.create(requireWindow(), req)
  )
  on(IPC.TERMINAL_INPUT, (_e, id: string, data: string) => terminal.write(id, data))
  on(IPC.TERMINAL_RESIZE, (_e, id: string, cols: number, rows: number) =>
    terminal.resize(id, cols, rows)
  )
  on(IPC.TERMINAL_KILL, (_e, id: string) => terminal.kill(id))

  // ---- serial ----
  handle(IPC.SERIAL_LIST, () => serial.listPorts())
  handle(IPC.SERIAL_OPEN, (_e, opts: SerialOpenOptions) => serial.openPort(requireWindow(), opts))
  handle(IPC.SERIAL_CLOSE, () => serial.closePort())
  handle(IPC.SERIAL_WRITE, (_e, data: string) => serial.writePort(data))

  // ---- language servers (LSP) ----
  // `root` comes from the renderer and drives privileged sinks (spawn cwd, the
  // .clangd write, the .cortex/config.json read), so confine it to the open
  // workspace exactly as file writes are, before dispatching.
  handle(IPC.LSP_SERVERS, (_e, refresh?: boolean) => lsp.availableServers(refresh))
  handle(IPC.LSP_REQUEST, (_e, call: LspCall) =>
    fsService.withinWorkspace(call.root) ? lsp.request(requireWindow(), call) : Promise.resolve(null)
  )
  handle(IPC.LSP_NOTIFY, (_e, call: LspCall) => {
    if (fsService.withinWorkspace(call.root)) lsp.notify(requireWindow(), call)
  })
  // Tearing down other roots' servers is not a privileged sink (no spawn/write),
  // so it is not gated; it only frees processes for an abandoned workspace.
  handle(IPC.LSP_DISPOSE_ROOT, (_e, keepRoot: string) => lsp.disposeExcept(keepRoot))

  // ---- ai ----
  handle(IPC.AI_COMPLETE, (_e, req: AiRequest) => ai.complete(requireWindow(), req))

  // ---- ai engineering agent (tool loop) ----
  // Read-only tools run behind the workspace boundary; file edits are staged as
  // reviewable diffs and applied only by the renderer after human approval.
  handle(IPC.AGENT_RUN, (_e, req: AgentRunRequest) => agent.run(requireWindow(), req))
  on(IPC.AGENT_CANCEL, (_e, id: string) => agent.cancel(id))

  // ---- project config ----
  handle(IPC.PROJECT_CONFIG_GET, (_e, root: string) =>
    fsService.isWorkspaceRoot(root) ? projectConfig.getProjectConfig(root) : Promise.reject(new Error('Project settings path rejected.'))
  )
  handle(IPC.PROJECT_CONFIG_SET, (_e, root: string, patch: ProjectConfig) =>
    fsService.isWorkspaceRoot(root) ? projectConfig.setProjectConfig(root, patch) : Promise.reject(new Error('Project settings path rejected.'))
  )

  // ---- project model (derived: languages, board/platform, GPIO usage) ----
  handle(IPC.PROJECT_MODEL_BUILD, (_e, root: string) =>
    fsService.withinWorkspace(root) ? projectModel.buildProjectModel(root) : Promise.resolve(null)
  )

  // ---- environment / dependency intelligence ----
  // root drives buildProjectModel (a workspace read), so confine it as the
  // project-model build is. fqbn is a board identifier, not a path.
  handle(IPC.ENV_INSPECT, (_e, root: string, fqbn: string | null, refresh?: boolean, buildMissingHeaders?: string[]) =>
    fsService.withinWorkspace(root)
      ? environment.inspect(root, fqbn, !!refresh, Array.isArray(buildMissingHeaders) ? buildMissingHeaders : [])
      : Promise.resolve(null)
  )
  // Writing the lock touches <workspace>/.cortex, so confine root like the config
  // writer. The lock records only observed data (no command is spawned from it).
  handle(IPC.ENV_LOCK_WRITE, (_e, root: string, fqbn: string | null) =>
    fsService.withinWorkspace(root) ? lockfile.write(root, fqbn, new Date().toISOString()) : Promise.resolve(null)
  )
  handle(IPC.ENV_LOCK_CHECK, (_e, root: string, fqbn: string | null) =>
    fsService.withinWorkspace(root) ? lockfile.check(root, fqbn) : Promise.resolve(null)
  )

  // ---- datasheet / document intelligence ----
  // Import runs the native open dialog HERE (main), so the corpus source path is
  // always user-chosen and never renderer-supplied; the service copies it into
  // the workspace and every later read is workspace-confined. root gates the
  // corpus location like the other project-data handlers.
  handle(IPC.DATASHEET_IMPORT, async (_e, root: string) => {
    if (!fsService.withinWorkspace(root)) return { ok: false, error: 'Workspace path rejected.' }
    const res = await dialog.showOpenDialog(requireWindow(), {
      title: 'Import datasheet or document',
      properties: ['openFile'],
      filters: [
        { name: 'Documents', extensions: ['pdf', 'md', 'markdown', 'mdx', 'txt', 'text', 'csv', 'log'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePaths[0]) return { ok: false, error: 'Import canceled.' }
    return datasheet.importFile(root, res.filePaths[0])
  })
  handle(IPC.DATASHEET_LIST, (_e, root: string) =>
    fsService.withinWorkspace(root) ? datasheet.list(root) : Promise.resolve([])
  )
  handle(IPC.DATASHEET_QUERY, (_e, root: string, query: string) =>
    fsService.withinWorkspace(root) ? datasheet.search(root, String(query ?? ''), 8) : Promise.resolve([])
  )

  // ---- embedded boards ----
  const boardStatus = async () => ({
    ...await embedded.status(),
    ...(arduinoCli.arduinoCliSetupHint() ? { hint: arduinoCli.arduinoCliSetupHint() } : {}),
    setupRequired: await arduinoCli.arduinoCliNeedsSetup()
  })
  handle(IPC.BOARD_STATUS, boardStatus)
  handle(IPC.BOARD_SETUP, async () => {
    await arduinoCli.setupArduinoCli((message) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.BOARD_SETUP_PROGRESS, message)
    })
    environment.invalidate()
    await toolchain.detectToolchains(true)
    return boardStatus()
  })
  handle(IPC.BOARD_LIST_CONNECTED, () => embedded.listConnected())
  handle(IPC.BOARD_LIST_ALL, () => embedded.listAll())
  handle(IPC.BOARD_COMPILE, (_e, req: BoardCompileRequest) => embedded.compile(requireWindow(), req))
  handle(IPC.BOARD_UPLOAD, (_e, req: BoardUploadRequest) => embedded.upload(requireWindow(), req))

  // ---- Boards Manager (cores) + Library Manager ----
  handle(IPC.CORE_SEARCH, (_e, q: string) => pkg.coreSearch(q))
  handle(IPC.CORE_INSTALLED, () => pkg.coreInstalled())
  handle(IPC.CORE_INSTALL, (_e, req: PackageInstallRequest) => pkg.coreInstall(requireWindow(), req))
  handle(IPC.CORE_UNINSTALL, (_e, id: string, coreId: string) => pkg.coreUninstall(requireWindow(), id, coreId))
  handle(IPC.CORE_UPDATE_INDEX, (_e, id: string) => pkg.coreUpdateIndex(requireWindow(), id))
  handle(IPC.LIB_SEARCH, (_e, q: string) => pkg.libSearch(q))
  handle(IPC.LIB_INSTALLED, () => pkg.libInstalled())
  handle(IPC.LIB_INSTALL, (_e, req: PackageInstallRequest) => pkg.libInstall(requireWindow(), req))
  handle(IPC.LIB_UNINSTALL, (_e, id: string, name: string) => pkg.libUninstall(requireWindow(), id, name))
  handle(IPC.NATIVE_LIB_STATUS, (_e, q: NativeLibQuery) => nativeLibs.nativeLibOverview(q ?? {}))
  handle(IPC.NATIVE_LIB_INSTALL, async (_e, req: NativeLibInstallRequest) => {
    const code = await nativeLibs.installNativeLib(requireWindow(), req)
    // A new library changes what the editor can resolve, so refresh clangd's config.
    const root = fsService.getWorkspaceRoot()
    if (code === 0 && root) lsp.refreshCppToolchain(root)
    return code
  })

  // ---- simulator ----
  handle(IPC.SIM_START, (_e, req: SimStartRequest) => sim.start(requireWindow(), req))
  handle(IPC.SIM_STOP, (_e, id: string) => sim.stop(id))
  handle(IPC.SIM_INPUT, (_e, id: string, pin: number, value: number) => sim.input(id, pin, value))

  handle(IPC.FIRMWARE_TEST_CHOOSE, async (event, kind: FirmwareTestSelection) => {
    if (!isTrustedRendererSender(event, mainWindow, rendererDocumentUrl)) throw new Error('Untrusted firmware test sender')
    if (!['scenario', 'scenarios', 'report', 'firmware'].includes(kind)) throw new Error('Invalid firmware test selection')
    const root = fsService.getWorkspaceRoot()
    if (!root) throw new Error('Open a project before selecting firmware tests')
    const selection = await dialog.showOpenDialog(requireWindow(), {
      title: kind === 'scenarios' ? 'Select scenario folder' : kind === 'report' ? 'Replay a saved firmware report' : kind === 'firmware' ? 'Select firmware override' : 'Select scenario',
      defaultPath: root,
      properties: [kind === 'scenarios' ? 'openDirectory' : 'openFile'],
      ...(kind === 'scenarios' ? {} : { filters: [{ name: kind === 'firmware' ? 'Arduino sketch' : 'JSON', extensions: [kind === 'firmware' ? 'ino' : 'json'] }] })
    })
    if (selection.canceled || !selection.filePaths[0]) return null
    if (!fsService.isWorkspaceRoot(root)) throw new Error('The project changed while choosing tests')
    return firmwareTests.validateSelection(kind, selection.filePaths[0])
  })
  handle(IPC.FIRMWARE_TEST_RUN, (event, request: unknown) => {
    if (!isTrustedRendererSender(event, mainWindow, rendererDocumentUrl)) throw new Error('Untrusted firmware test sender')
    return firmwareTests.run(request)
  })
  handle(IPC.FIRMWARE_TEST_STOP, (event, id: string) => {
    if (!isTrustedRendererSender(event, mainWindow, rendererDocumentUrl)) throw new Error('Untrusted firmware test sender')
    return firmwareTests.stop(id)
  })

  // ---- debugger (gdb) ----
  handle(IPC.DEBUG_START, (_e, req: DebugStartRequest) => debug.start(requireWindow(), req))
  handle(IPC.DEBUG_STOP, () => debug.stop())
  handle(IPC.DEBUG_CONTINUE, () => debug.cont())
  handle(IPC.DEBUG_STEP_OVER, () => debug.stepOver())
  handle(IPC.DEBUG_STEP_INTO, () => debug.stepInto())
  handle(IPC.DEBUG_STEP_OUT, () => debug.stepOut())
  handle(IPC.DEBUG_PAUSE, () => debug.pause())
  handle(IPC.DEBUG_SELECT_FRAME, (_e, level: number) => debug.selectFrame(level))
  handle(IPC.DEBUG_SET_BREAKPOINTS, (_e, file: string, lines: number[]) => debug.setBreakpoints(file, lines))
  handle(IPC.DEBUG_EVALUATE, (_e, expr: string) => debug.evaluate(expr))

  // ---- version control (git), read-only ----
  handle(IPC.GIT_STATUS, () => git.status())
  handle(IPC.GIT_DIFF, (_e, path: string, kind: GitDiffKind, orig?: string) => git.fileDiff(path, kind, orig))
  handle(IPC.GIT_STAGE, (_e, paths: string[]) => git.stage(paths))
  handle(IPC.GIT_UNSTAGE, (_e, paths: string[]) => git.unstage(paths))
  handle(IPC.GIT_COMMIT, (_e, message: string) => git.commit(message))
  handle(IPC.GIT_PUSH, () => git.push())
  handle(IPC.GIT_BRANCHES, () => git.branches())
  handle(IPC.GIT_SWITCH, (_e, name: string) => git.switchBranch(name))
  handle(IPC.GIT_INIT, () => git.init())
  handle(IPC.GIT_CREATE_BRANCH, (_e, name: string) => git.createBranch(name))
  handle(IPC.GIT_FETCH, () => git.fetch())
  handle(IPC.GIT_PULL, () => git.pull())
  handle(IPC.GITHUB_ACCOUNTS, () => github.accounts())
  handle(IPC.GITHUB_SIGN_IN, () => github.signIn())
  handle(IPC.GITHUB_REPOSITORIES, (_e, page: number) => github.repositories(page))
  handle(IPC.GITHUB_CLONE, (_e, url: string, parent: string) => github.clone(url, parent))

  // ---- settings / app ----
  // Return redacted settings only: the raw API key never crosses to the renderer.
  handle(IPC.SETTINGS_GET, () => settings.getPublicSettings())
  handle(IPC.SETTINGS_SET, (_e, patch) => settings.setSettings(patch))
  handle(IPC.APP_INFO, (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    home: homedir(),
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome
  }))
}

app.whenReady().then(() => {
  // Apply a strict Content-Security-Policy in production. In dev we leave it to
  // Electron so Vite HMR (websocket) and the React Fast Refresh preamble work.
  if (app.isPackaged || !process.env['ELECTRON_RENDERER_URL']) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; worker-src 'self' blob:; " +
              "style-src 'self' 'unsafe-inline'; font-src 'self' data:; " +
              "img-src 'self' data:; connect-src 'self'"
          ]
        }
      })
    })
  }

  // A completed core/lib install/uninstall/update-index changes the installed
  // set, so drop the environment cache; the next inspect re-reads it.
  pkg.setOnPackagesChanged(() => environment.invalidate())

  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  runner.killAll()
  firmwareTests.killAll()
  sim.killAll()
  debug.stop()
  lsp.killAll()
  terminal.killAll()
  fsService.stopWatch()
  void serial.closePort()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  runner.killAll()
  firmwareTests.killAll()
  sim.killAll()
  debug.stop()
  lsp.killAll()
})

// A failed close-time save can cancel quit; keep its terminal session usable.
app.on('will-quit', () => { terminal.killAll() })
