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
- `services/terminalService.ts` - lazy-loads the optional native PTY backend;
  starts a local shell in the trusted workspace/home directory and routes input,
  resizing, output and natural exit for its owned session.
- `services/aiService.ts` - streams completions via Anthropic Messages API or any OpenAI-compatible
  endpoint (OpenAI, Ollama, LM Studio...). Falls back to an offline stub when unconfigured.
- `services/settingsService.ts` - JSON settings persisted in `app.getPath('userData')`.
  Captured patches serialize behind a shared initialization, reread the disk
  baseline and stage/sync/rename before publishing cache state. Unknown stored
  fields survive; public responses expose only supported fields with credentials
  redacted. Failed saves keep committed cache/disk state, without promising an
  OS-level compare-and-swap or power-loss durability.

### Preload - `src/preload/`
The only bridge. The bundled CommonJS `index.ts` exposes a **typed, minimal
`window.api`** via `contextBridge`, with `contextIsolation: true`,
`nodeIntegration: false` and `sandbox: true`. Its runtime uses Electron's
[sandbox-supported bridge APIs](https://github.com/electron/electron/blob/v33.4.11/docs/tutorial/sandbox.md),
not general Node modules. Window navigation and incoming IPC require the selected
renderer document; IPC also requires this window's main-frame identity.
Focused security checks and actual production startup pass. A fresh source
installation reports the Windows renderer as sandboxed at untrusted integrity,
with the genuine preload/terminal bridge working. Development/HMR and final
snapshot verification remain separate checks in [release validation](RELEASE-VALIDATION.md).

### Renderer - `src/renderer/`
React + TypeScript UI, bundled by Vite.

- `src/App.tsx` - layout + subscribes to all streamed IPC events + global keybindings.
- `src/store/useStore.ts` - a single Zustand store holding workspace, tabs, run state, serial state,
  AI chat, and settings, plus every action.
- `src/components/*` - the panels (see [`FEATURES.md`](FEATURES.md)).
- `src/components/CodeEditor.tsx` - Monaco, bundled **locally** (workers via Vite `?worker`) so it
  works under a strict CSP with no CDN.

`MoreTools.tsx` owns menu visibility and focus locally. Its native buttons use
the existing sidebar action, so Enter/Space activates once. Dismissal focuses the
still-connected trigger before removing the menu, allowing Tab/Shift+Tab to
continue natively. Escape is handled only by the open menu, not a global listener;
outside clicks close it without forcing trigger focus. Primary rails and the
sidebar store contract are unchanged.

`Splitter.tsx` owns local keyboard input and separator semantics. Existing layout
hooks and `EditorArea.tsx` own signed movement, reachable endpoints and sizing.
Right/bottom pane sizes decrease when their divider moves right/down. Controlled
wrapper IDs and values describe the displayed layout, not only persisted limits.
Automatic fitting does not save preferences; deliberate dock changes use the
existing setters, while the editor ratio stays local.

Equal-range keys do not write sizes. The editor observes its actual container,
disables keyboard adjustment at zero width and recovers when measurable. Dock
wrappers remove outer borders below two owned CSS pixels to avoid a border-imposed
minimum; ordinary frame styling returns at two. This is not a promise of exact
rectangle equality at every zoom/DPI. Pointer capture/cancellation are unchanged.

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

### Terminal session ownership

Native data/exit callbacks check the exact PTY object still owns the session ID,
so a retired callback cannot mutate a same-ID replacement. `killAll` increments
a teardown generation and clears the session map before native kills; pending
creates reject after loading if their generation changed or the window died.
This also prevents reentrant kill callbacks from killing an owned session twice.
Active final output and natural exit retain their existing order. Explicit
disposal intentionally does not forward a stale exit acknowledgement.

Renderer reload and `window-all-closed` retain their cleanup hooks. Application
terminal cleanup runs at `will-quit`, not `before-quit`, because a failed save can
cancel the window close after `before-quit`. This follows Electron's
[quit lifecycle](https://www.electronjs.org/docs/latest/api/app#event-will-quit)
and keeps the same shell usable when Cortex stays open. It is not an OS-shutdown
or arbitrary descendant-process guarantee. Fake-native lifecycle regressions
use a closed loader for the actual service source; owned real-native controls
are recorded separately in [release validation](RELEASE-VALIDATION.md).

### Bounded build/run console delivery

`runOutputDelivery.ts` puts build, board and package console output behind one
window-wide delivery credit. At most one output or exit packet is in flight;
each serialized payload is at most 32 KiB. The preload returns credit through
the guarded `run:outputAck` channel only after the synchronous output/exit
callback completes, including when that callback throws. Wrong-window, old,
missing and repeated tokens do not release credit.

Pending display text is limited to 256 KiB and 64 normal entries. Adjacent
chunks coalesce only when run id and stream match. Two phase-specific omission
markers and two compile/run exit fences are reserved for each of at most 32
outstanding run deliveries: at most 128 queued output entries and 64 exit
entries globally per window. Run ids are limited to 256 UTF-8 bytes. Excess
display text is omitted, with an explicit marker accounting for bytes by run
and original stream; retained output order and compile/run fences are preserved.
This is bounded console delivery, not a lossless transcript.

A stalled or absent receiver cannot make the transport queue grow without
limit. A 33rd outstanding delivery is rejected before a child starts, with an
actionable wait/reload error. A still-active or cancelling duplicate id is also
rejected explicitly. Exit delivery waits for preceding output acknowledgements;
a stalled renderer may therefore not show completion until it resumes. Renderer
reload/crash and window close dispose delivery state and cancel only that
window's runner reservations/children. Late child cleanup checks child identity
so it cannot erase a newer same-id run in another window.

Compiler diagnostic parsing remains independent of console omissions. Raw
compiler capture and diagnostic IPC have their own bounds below; neither console
delivery nor diagnostic retention bounds total main-process memory. Headless
firmware reports and their complete traces are unchanged.

#### Measurement ledger (2026-10-10)

An owned Windows/Node 22.20.0 harness compared checkpoint `f89dce0` with this
transport using three repetitions of fixed 4/16 MiB workloads. Renderer
consumption was delayed until producer completion plus 250 ms. These are
application-delivered serialized bytes/message counts, not Chromium allocator
measurements or a host-speed benchmark.

| Fixed workload | Before | After | Decision |
|---|---|---|---|
| 16 MiB in 256-byte alternating-stream chunks, stalled receiver | 65,536 output messages; 22,609,920 queued JSON-wrapper bytes | One unacknowledged output message; 66 total after draining, with explicit omission counts | Keep: fixed byte and entry bounds replace linear queued growth |
| Real owned child emitting 16 MiB plus 500 compiler-shaped warnings | 312-339 output messages; approximately 16.9 MB total queued serialized data | One unacknowledged console packet; 18 output messages after draining; retained stdout 256 KiB plus explicit omissions | Keep: all 500 structured diagnostics and failure exit still arrive |

The real-child post-change output/exit payload queue peaks at 32 KiB (32,803
bytes including the harness's JSON channel wrapper); its separate diagnostic
message is not included in that console bound. Focused regressions cover byte
and entry accounting, Unicode/control-character packet limits, both phase
fences, stale credits, admission recovery, callback exceptions and reload/late
child cleanup. Final combined build/native verification is recorded separately
in [release validation](RELEASE-VALIDATION.md).

A later genuine production Electron control runs a 16 MiB stdout child while
the renderer stalls for 2000 ms. It exits 0, retains 295018 UTF-16 code units,
shows explicit stdout/stderr omissions and leaves the preload bridge responsive.
Another real compile/run safely reuses `run-1` after renderer reload. These are
native behavior controls, not allocator/RSS measurements or a speed comparison;
they do not extend the console bound to structured compiler diagnostics.

### Bounded compiler diagnostic capture

`compilerDiagnostics.ts` owns one collector per compiler child for native Run,
standalone rustc, Cargo, board Verify/Upload and Debug compilation. Its production
limits are 1,048,576 UTF-8 bytes per physical record, 1,048,576 bytes for the
serialized normalized diagnostic JSON array, and 500 retained diagnostics.
The array budget includes resolved paths and JSON separators, not the IPC envelope.
Records or diagnostics are omitted whole; no shortened message or invented path.
The compiler keeps draining and its exit status is unchanged. UTF-8 decoding,
CRLF, final residue and parser precedence are preserved. Discarded records break
textual Rust header/location adjacency; recognized higher-priority formats replace
fallback retention even when their diagnostics cannot fit.

The existing `run:diagnostics` envelope optionally carries `capture` with
`omittedDiagnostics` (recognized problems) and `unparsedBytes` (discarded input
whose problem count is unknown). The store accepts/resets this alongside the
diagnostics under its existing ID/workspace guards. Problems shows a conditional,
accessible incompleteness notice, including with an empty retained array; Stop
and Console clearing preserve it. Complete later results remove it.

Cargo ends machine classification on either valid `build-finished` outcome.
Only `success:true` permits compile-success/run transition: ordinary output can
come from procedural macros during compilation. Prompt prefixes remain visible;
a timed-out potential record forwards its suffix without parsing fragments or
certifying success. Post-terminal compiler-shaped program JSON stays raw output.
Queued snapshots and close callbacks check exact child ownership.

These are capture bounds, not a transient/peak/whole-process memory guarantee,
lossless output transport, or a Debug MI/output IPC bound. Simulation retains its
separate bounded compile-failure policy and string-taking diagnostic interface.
Measured controls and verification boundaries are in [release validation](RELEASE-VALIDATION.md).

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

## Continuous integration

The [ordinary CI workflow](../.github/workflows/ci.yml) runs on pull requests and
pushes to `main`/`master`, using `ubuntu-24.04` and `windows-2022` rather than
floating runner labels. Checkout and Node setup use verified full commit SHAs;
checkout does not persist credentials, token permissions are `contents: read`,
and each job has a 20-minute host timeout. Node remains pinned to 22.20.0.

CI installs Linux `g++-14` or locates the Windows runner's MinGW compiler, then
requires a successful `g++ --version` before compiler-gated tests. A missing
compiler fails the job instead of quietly skipping real firmware cases. Compiler
patch versions remain runner/package-provided and are recorded in the log;
this is not the fully pinned benchmark toolchain. The [firmware workflow](../.github/workflows/firmware-tests.yml)
separately pins the GCC 14.2.0 container by digest and explicitly probes its compiler.

Ordinary CI retains locked `npm ci`, both typechecks, regression tests and the
desktop/tools build, followed by `npm audit --audit-level=high`. Audit failures
are not ignored or allowlisted. The known high/critical findings therefore keep
CI and customer release readiness red until separately approved remediation
clears them; see [Dependency release gate](DEPENDENCY-REMEDIATION.md).
Local YAML regression checks validate this configuration, not a remote Actions
run, branch protection or clean-machine installer validation.
