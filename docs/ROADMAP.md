# Roadmap

Phased plan from the current foundation (v0.1) toward the full "Cursor for Embedded Systems" vision.

The v0.x phase labels describe historical development milestones, not published
installer releases. Current evidence and the finite local queue are tracked in
[RELEASE-VALIDATION.md](RELEASE-VALIDATION.md) and [TASK-AUDIT.md](TASK-AUDIT.md).
Later phases include both implemented slices and future scope, as noted below.

## ✅ Phase 0 - Foundation (v0.1, done)
The runnable core:
- Electron + React + TS + Vite + Tailwind + Monaco shell
- Workspace explorer, tabbed editor, bottom panel, status bar, AI panel
- Toolchain detection
- Compile & run C/C++ (C++11 to C++23), Python, JS with streamed output
- Serial monitor + live plotter
- AI panel (provider-agnostic) with embedded-tuned prompt
- Settings persistence, production CSP, packaging config

## ✅ Phase 1 - Build UX, boards & simulator (v0.2, done)
- Per-project **run configuration** (compiler, std, optimization, board) saved to `.cortex/config.json`
- **Compiler diagnostics** → Problems panel (click-to-jump) + inline Monaco markers
- **stdin** to running programs; optimization-level selector
- **Board support** via arduino-cli: detect, list connected/installable, Verify + Upload `.ino`
  sketches to ESP32 / RP2040 / Arduino (real Arduino APIs like `digitalWrite` work)
- **Simulator MVP** (Wokwi/Tinkercad-style, native engine): virtual Uno, interactive LED/button/
  buzzer, live serial - runs the user's real sketch with no hardware. See [`SIMULATOR.md`](SIMULATOR.md).

## ✅ Phase 1.x - Polish, security, richer sim (v0.3, done)
- New **Cortex Dark theme** (navy/amber/moss signature gradient); see [`THEME.md`](THEME.md)
- **Rust** run (Cargo projects or rustc for loose files); AI is provider-agnostic: Anthropic, OpenAI, **Gemini**, local, custom
- **Command palette** (Ctrl+Shift+P) + **quick-open** (Ctrl+P); **file-tree context menu**
  (new/rename/delete/copy path)
- **Security**: AI key encrypted at rest (safeStorage) and never sent to the renderer; single-instance
  lock + global error handlers; spawn **command allowlist**; destructive FS ops **confined to the
  workspace**
- **2D SVG simulator canvas**: drag parts, per-pin click-to-wire, **multi-pin components** (RGB LED
  with live color mixing, **7-segment** display), analog sensors (pot / photoresistor / temperature),
  buzzer, servo; **diagram save/load** to `.cortex/diagram.json`; demo sketches in `examples/sim/`
- **Testing + CI**: initial unit suite and GitHub Actions (typecheck + test + build on Ubuntu + Windows); current counts and remote-run limits are in release validation

## Phase 1.4 - Automated firmware testing and CI benchmarks

The first release covers the headless workflow and quickstart:

- Shared native sketch build path without a desktop window; supported Uno
  sensor-controller example and explicit simulation limitations.
- Version 1 JSON scenarios, virtual time, seeded randomness, stable input order,
  fresh state, behavior/deadline assertions and bounded execution.
- Normal, stopped-sensor and invalid-input scenarios; broken timeout and hanging
  fixtures; deterministic repeat checks.
- Readable/JSON reports with evidence and build/environment fingerprints;
  saved-configuration replay for investigating a failure and verifying a fix.
- Pull-request/main GitHub Actions reporting, fixed repeated benchmark workload,
  explicitly saved baseline and advisory environment-aware comparisons.
- Complete [quickstart](FIRMWARE-TESTING.md), example contract and feature docs.

Next: desktop Run Tests and results/details/replay using the same runner; record
a demonstration; have two teammates test fresh installations and one outside
team try the workflow. User validation drives future board/peripheral coverage.
See [tasks/todo.md](../tasks/todo.md) for acceptance checks and outstanding work.

## 🔜 Phase 1.5 - Real project builds & distribution
- **Code signing** + notarization; **auto-update** (electron-updater)
- **Multi-file** C/C++ builds via CMake + Ninja
- **PlatformIO** project support
- Board/core **manager**: implemented through managed Arduino CLI; physical board/vendor coverage still needs release validation
- Include paths / defines in run configuration: implemented as validated `extraArgs`; see [PROJECT-CONFIG.md](PROJECT-CONFIG.md)
- More sim parts (OLED SSD1306, NeoPixel, HC-SR04, LCD1602); cycle-accurate engine (avr8js / rp2040js)

## 🔜 Phase 2 - Language intelligence
- **Implemented LSP bridge**: clangd (C/C++), Pyright (Python), rust-analyzer (Rust), with installed servers; see [LSP.md](LSP.md)
- Completion, hover, definition, references, rename, diagnostics and server-backed formatting providers are implemented; server/project support determines results
- Standalone formatter-tool integration (clang-format, black, rustfmt) remains future work
- Workspace text search is implemented; replacement and workspace symbol search remain future work

## 🔜 Phase 3 - Debugging
- **Implemented host gdb/MI2**: breakpoints, stepping, variables, watch and call stack; see [DEBUGGING.md](DEBUGGING.md)
- LLDB/DAP support and thread selection remain future work; the current debugger is not a DAP or on-chip implementation
- Registers, memory, disassembly views
- On-chip debug via OpenOCD / J-Link / ST-Link

## 🔜 Phase 4 - Hardware awareness
- GPIO inspector, memory viewer, register viewer, RTOS (FreeRTOS) viewer
- Richer serial: hex/CSV modes, regex filters, multi-port, export
- Logic-analyzer / I²C / SPI decoding via plugins

## 🔜 Phase 5 - AI-native workflow
- Agentic multi-file edits (apply diffs), repo-wide context
- Datasheet ingestion + Q&A; schematic image analysis
- MCP tool integrations (flash the board, read registers, run the Python test suite)
- Power/timing analysis agents with concrete estimates

## 🔜 Phase 6 - Ecosystem
- Expand and validate the implemented Arduino board manager across ESP32/STM32/RP2040/AVR/nRF52/Teensy/MSP430/PIC; the full vendor matrix is not verified support
- Plugin/extension system (VSCode-style): Zephyr, ESP-IDF, STM32Cube, ROS2, LVGL, OpenCV
- Auto-update, telemetry opt-in, crash reporting

## 🧭 Phase 7 (optional) - Tauri backend migration
The IPC contract in `src/shared/ipc.ts` is intentionally backend-agnostic. A Rust/Tauri backend can
implement the same channels for a much smaller, lower-RAM binary - attractive to the embedded
audience. See [`TECH-STACK.md`](TECH-STACK.md) for the Electron-vs-Tauri rationale.

**Migration approach:** keep the renderer unchanged; reimplement each `window.api.*` call as a Tauri
command (fs, toolchain detect, run/compile, serial, AI). Ship Electron and Tauri side-by-side until
the Tauri backend reaches parity.
