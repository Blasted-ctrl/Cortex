# Technology Stack & Decisions

## Current stack

| Layer | Choice | Why |
|---|---|---|
| Desktop shell | **Electron 33.4.11** | Existing CommonJS desktop/native-module integration; the runtime upgrade and dependency audit remain release blockers. |
| Build tooling | **electron-vite 4.0.1** + **Vite 5.4.21** | One ESM tooling config builds main/preload/renderer; fast HMR; first-class TS. |
| UI | **React 18 + TypeScript** | Component model the whole team knows; strict typing across the IPC boundary. |
| Styling | **Tailwind CSS 3** | Semantic CSS-variable tokens for Cortex Dark and Light; see [THEME.md](THEME.md). |
| Editor | **Monaco** (`@monaco-editor/react`) | Literally VS Code's editor - syntax highlighting, minimap, IntelliSense, folding, multi-cursor for free. Bundled locally (no CDN) for CSP. |
| State | **Zustand** | One small store, no boilerplate, easy to subscribe to streamed IPC. |
| Icons | **lucide-react** | Clean, consistent line icons. |
| Serial | **serialport** (native) | Cross-platform serial I/O; lazy-loaded so a failed native build never blocks startup. |
| File watching | **chokidar** | Robust cross-platform FS events. |
| AI | **fetch** → Anthropic / Gemini / OpenAI-compatible | Streaming completions; provider-agnostic, including local compatible endpoints. |
| Packaging | **electron-builder** | NSIS (Windows), DMG (macOS), AppImage/deb (Linux). |

The tooling config is `electron.vite.config.mts`; the application remains
CommonJS. Electron-vite's Node engine is `^20.19.0 || >=22.12.0`; CI pins
22.20.0 and local validation also uses Node 24. These are source/build host
versions, not Electron's embedded Node version. See
[DEPENDENCY-REMEDIATION.md](DEPENDENCY-REMEDIATION.md) for installed changes,
the PDF compatibility hold and separately proposed security majors. Packaging
targets above are configuration, not proof of clean-machine installer validation.

## The Electron vs. Tauri decision

The original design leaned toward **Tauri** (Rust backend, tiny binary, low RAM). That is a strong
long-term choice. For v0.1 we chose **Electron** deliberately:

**Original Electron rationale**
- **It built on the original development machine.** Rust/Cargo was absent at that decision point; this is historical rationale, not current toolchain detection.
- **Cursor is Electron.** The user's north star ("like Cursor, a wrapper around VS Code") maps
  directly onto Electron + Monaco.
- **Existing native-module integration.** Electron supports the selected `serialport` and
  terminal modules; ABI-compatible installation and packaged behavior still require
  validation. A Rust equivalent would be reimplemented backend-side.
- **The value is in the features, not the shell.** Multi-language builds, C++23, serial plotting,
  and embedded AI are identical regardless of shell.

**Why Tauri later** - tracked in [`ROADMAP.md`](ROADMAP.md) as a future migration:
- Much smaller installer and lower memory footprint.
- Rust backend is attractive to the embedded audience and has excellent serial/USB/process crates.
- The clean IPC contract in `src/shared/ipc.ts` is designed so the **backend can be swapped** - 
  a Tauri (Rust) backend can implement the same channels the Electron main process does today.

## Host toolchains and managed board tools

Native host builds, simulation and debugging invoke separately installed
toolchains. Historical development-machine examples include:

- **g++ 14.2** and **clang++ 22** for host C/C++ builds; selecting C++23 does not
  imply that every C++23 feature is implemented by every compiler version.
- **Python 3.14**, **Node 24**, **CMake 4.1**.

Also probed for: `gcc`, `clang`, `arm-none-eabi-g++`, `avr-g++`, `rustc`, `cargo`, `ninja`,
`arduino-cli`, `pio` (PlatformIO), `openocd`, `gdb`.

Real-board tools are different: release packaging includes the pinned Arduino
CLI, and source checkouts can prepare its verified managed download. Board cores
and libraries are installed through Cortex; the CLI is not every core/compiler
bundled in advance. See [BOARD-TOOLS.md](BOARD-TOOLS.md). Detecting CMake,
PlatformIO or OpenOCD does not mean their project-build/debug integration is
implemented.

## Languages (`src/shared/languages.ts`)

| Language | Runnable now | Category |
|---|---|---|
| C++ | ✅ (g++/clang++, C++11 to C++23) | embedded |
| C | ✅ | embedded |
| Python | ✅ | scripting |
| JavaScript | ✅ (node) | web |
| TypeScript | editing only | web |
| Rust | runnable (Cargo projects; rustc for loose `.rs` files) | systems |
| Zig | editing only | systems |
| Lua | editing only | scripting |

## Why local Monaco (CSP note)

`@monaco-editor/react` defaults to loading Monaco from a CDN. Under our production Content-Security-
Policy (`connect-src 'self'`), that would be blocked. `CodeEditor.tsx` therefore imports
`monaco-editor` directly and wires its web workers through Vite's `?worker` imports, so everything is
bundled and same-origin. `worker-src 'self' blob:` is allowed in the CSP for the workers.
