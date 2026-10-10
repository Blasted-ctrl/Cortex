# Architecture

Cortex is an Electron desktop app with a strict three-process separation, mirroring the security
model of VS Code / Cursor.

```
┌──────────────────────────────────────────────────────────┐
│                     Renderer (React + TS)                  │
│                                                            │
│  ActivityBar  Explorer  Editor(Monaco)  BottomPanel  AI    │
│  Toolchains   Devices   SerialMonitor   Plotter   Settings │
│                                                            │
│   state: Zustand store  ──────────────  window.api (IPC)   │
└───────────────────────────────┬────────────────────────────┘
                                │ contextBridge (preload)
┌───────────────────────────────┴────────────────────────────┐
│                     Main process (Node)                     │
│                                                            │
│  fsService     toolchainService   runnerService            │
│  serialService aiService          settingsService          │
│                                                            │
│  spawns: g++ / clang++ / python / node ...  (child_process)  │
│  opens:  serial ports (serialport)                         │
│  calls:  Anthropic / OpenAI / local model (fetch)          │
└─────────────────────────────────────────────────────────────┘
```

## Processes

### Main process - `src/main/`
The privileged Node process. It owns the filesystem, spawns compilers/interpreters, talks to serial
ports, calls AI providers, and persists settings. It never trusts the renderer beyond the typed IPC
surface.

- `index.ts` - window creation, production CSP header, and **all `ipcMain.handle` registrations**.
- `services/fsService.ts` - read/write/create/rename/delete + `chokidar` file watching.
- `services/toolchainService.ts` - probes the system `PATH` for compilers/tools (`--version`), caches results.
- `services/runnerService.ts` - compiles C/C++ (selectable `-std=`) and runs C/C++/Python/JS,
  streaming stdout/stderr and exit codes back to the renderer. Tracks running processes by id so
  they can be stopped and fed stdin.
- `services/serialService.ts` - lazy-loads the native `serialport` module; lists/opens/writes ports
  and streams incoming data.
- `services/aiService.ts` - streams completions via Anthropic Messages API or any OpenAI-compatible
  endpoint (OpenAI, Ollama, LM Studio...). Falls back to an offline stub when unconfigured.
- `services/settingsService.ts` - JSON settings persisted in `app.getPath('userData')`.

### Preload - `src/preload/`
The only bridge. `index.ts` exposes a **typed, minimal `window.api`** via `contextBridge`. No Node
globals leak into the renderer (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`
so the preload may `import` from Node while the renderer stays isolated).

### Renderer - `src/renderer/`
React + TypeScript UI, bundled by Vite.

- `src/App.tsx` - layout + subscribes to all streamed IPC events + global keybindings.
- `src/store/useStore.ts` - a single Zustand store holding workspace, tabs, run state, serial state,
  AI chat, and settings, plus every action.
- `src/components/*` - the panels (see [`FEATURES.md`](FEATURES.md)).
- `src/components/CodeEditor.tsx` - Monaco, bundled **locally** (workers via Vite `?worker`) so it
  works under a strict CSP with no CDN.

### Shared - `src/shared/`
Code imported by both sides:
- `ipc.ts` - the channel-name constants and all payload/DTO types (the IPC contract).
- `languages.ts` - language definitions, extension→language mapping, colors.

## IPC contract

Every channel name lives in `src/shared/ipc.ts`. Two directions:

- **Renderer → Main:** `ipcRenderer.invoke(channel, ...)` ⇄ `ipcMain.handle`. Request/response
  (dialogs, fs ops, run start/stop, serial open, settings).
- **Main → Renderer:** `webContents.send(channel, payload)` → `ipcRenderer.on`. Streams
  (`run:output`, `run:exit`, `serial:data`, `serial:status`, `ai:stream`, `fs:event`).

Adding a feature that crosses the boundary means: add the channel + types to `shared/ipc.ts`, handle
it in `main/index.ts`, expose it in `preload/index.ts`, and consume it via `window.api` in the store.

## Build & module format

- **electron-vite** builds three targets (main, preload, renderer) from one config
  (`electron.vite.config.mts`). The tooling config is ESM; this does not change
  the application's CommonJS package/output format. Build tooling requires Node
  `^20.19.0 || >=22.12.0`; CI is pinned to Node 22.20.0.
- Main and preload are emitted as **CommonJS** on purpose - Electron's ESM entry loader is fragile
  with native/CJS dependencies (e.g. `serialport`), so CJS is the reliable choice. The renderer is
  ESM (bundled by Vite).
- `electron-builder` (`electron-builder.yml`) packages installers (NSIS on Windows, DMG on macOS,
  AppImage/deb on Linux).

> Environment note: if `ELECTRON_RUN_AS_NODE=1` is set in your shell, Electron launches as plain
> Node and `require('electron')` returns a path string (`app` is undefined). Unset it before
> `npm run dev`.
