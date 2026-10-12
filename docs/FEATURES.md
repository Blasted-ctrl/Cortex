# Features - current & planned

Legend: ✅ implemented (v0.1) · 🟡 partial · ⬜ planned

## Editor & workspace

Saved project layouts reopen disk-backed tabs, split-pane selections and expanded
folders safely; tree/tab controls support roving keyboard focus and ARIA
relationships. See [Projects](PROJECTS.md) for controls, budgets and recovery limits.

More tools provides a keyboard menu for Boards Manager, Library Manager and
Debug. Arrows wrap focus, Home/End jump to the first/last item, and B/L/D move
focus by initial. Enter/Space use native button activation; Escape returns to the
trigger, while Tab/Shift+Tab continue the normal tab order.

Tab to a panel divider. Unmodified arrows on its axis request ten CSS pixels of
divider movement, subject to the currently reachable range. Home/End selects the
controlled pane's minimum/maximum. Sidebar, Agent/Datasheets, bottom-panel and
split-editor dividers have named controls and visible keyboard focus.
Tab/Shift+Tab leaves normally; use the existing controls to hide panels, not Enter.
Pointer resizing remains available.

Divider values describe displayed sizes, which can be smaller than saved dock
preferences in a fitted window. An unadjustable divider remains focusable and
announces its disabled range. The editor split percentage is local, not saved.
See [verified scope and limits](RELEASE-VALIDATION.md#keyboard-panel-resizing-checkpoint).

- ✅ Open folder as workspace; lazy file tree
- ✅ Live filesystem watching (external changes refresh the tree)
- ✅ Monaco editor: tabs, dirty indicators, close guard, syntax highlighting, minimap, bracket colorization
- ✅ Custom "Cortex Dark" JetBrains-style theme (navy/amber/moss)
- ✅ Language detection by extension (C, C++, Python, Rust, Zig, Lua, JS, TS) plus the
  ancillary files an embedded repo carries (Markdown, YAML, JSON, INI, XML, Shell)
- ✅ **Binary/invalid-UTF-8/oversized files are refused** as writable text: validate
  the admitted buffer, with an 8 MB editing limit and a read-only placeholder.
  UTF-8 BOMs and editor line endings survive saves. See [Projects](PROJECTS.md).
- ✅ Save (Ctrl+S), Save all
- ✅ **Automatic C++ includes:** typing, pasting or completing known `std::` symbols
  adds their missing headers beside the existing includes, with caret/viewport
  preservation and Undo/Redo. clangd's completion header edits are applied too.
  See [supported symbols and limitations](CPP-AUTO-INCLUDES.md).
- ✅ **Command palette** (Ctrl+Shift+P) and **quick-open** file search (Ctrl+P), fuzzy-matched
- ✅ **File-tree context menu**: New File, New Folder, Rename, Delete, Copy Path (with input dialog)
- ✅ **Workspace search**: filename + in-file content, case/word/regex toggles, results grouped
  by file, click-to-open at the match
- ✅ **LSP integration** (clangd, plus Pyright / rust-analyzer when installed): completion,
  hover docs, go-to-definition, signature help, live diagnostics. clangd is auto-configured
  from your own compiler so the stdlib resolves - see `docs/LSP.md`
- ✅ Split editor groups with independent active tabs and draggable tab moves
- ⬜ Multi-root workspaces
- ⬜ Search *and replace*; go-to-symbol across the workspace

## Build & run

The integrated local terminal preserves its shell across panel/tab changes,
supports restart after natural exit and retires old sessions on project/reload
teardown without corrupting replacements. A failed save that cancels quit keeps
the shell usable. See [terminal controls and limits](PROJECTS.md#integrated-terminal).

- ✅ **Toolchain auto-detection** (GCC, Clang, ARM/AVR-GCC, Python, Node, CMake, Ninja, GDB, PlatformIO, Arduino-CLI, OpenOCD)
- ✅ **Compile & run C/C++** with a **selectable compiler, standard (C++11 → C++23/2c), and optimization level**
- ✅ Run Python and JavaScript
- ✅ Streamed build + program output with stdout/stderr coloring and exit codes
- ✅ Stop a running program
- ✅ **stdin to running programs** (input box in the Output console)
- ✅ **Bounded build/run console delivery:** acknowledged packets, fixed pending
  display budgets, explicit per-stream omissions and ordered compile/run exits.
  Busy or duplicate admission reports an error instead of silently starting.
  See [transport limits and measurements](ARCHITECTURE.md#bounded-buildrun-console-delivery);
  compiler diagnostic buffers are a separate path, not a total-memory guarantee.
- ✅ **Per-project run configuration** persisted to `.cortex/config.json` (compiler/std/opt/board)
- ✅ **Compiler diagnostics** parsed into a **Problems panel** (click to jump) + **inline Monaco squiggles**
- ✅ **Bounded compiler capture:** whole-record and normalized-array byte budgets,
  up to 500 retained problems, and a conditional persistent incompleteness notice.
  Later errors survive oversized input; warnings and actual failure codes remain.
  See [diagnostic limits](LANGUAGES.md#compiler-diagnostics).
- ⬜ CMake / PlatformIO project builds (multi-file)

## Boards & embedded (ESP32 / RP2040 / Arduino)
- ✅ **Managed board tools**: release installers bundle Arduino CLI; development
  launches download the pinned CLI automatically when needed. Package indexes are
  initialized in-app with progress, recoverable errors and retry; no manual CLI
  installation or PATH configuration is required. See [board setup](BOARD-TOOLS.md).
- ✅ **arduino-cli integration**: reuse an existing CLI when appropriate, list connected boards, list installable targets
- ✅ **Verify (compile)** and **Upload** a `.ino` sketch to a real board, with board (FQBN) selector
- ✅ Arduino APIs (`pinMode`, `digitalWrite`, `Serial`, ...) are valid - compiled against the Arduino core
- ✅ Common board presets (Uno, Nano, Mega, ESP32, ESP8266, Pico) even before cores are installed
- ✅ Simulator remains usable while board tools are being prepared or setup needs retry
- ✅ **Boards Manager**: search the core index, install / update / remove a platform, pin a
  version, with progress streamed to Output
- ✅ **Library Manager**: search, install and remove Arduino libraries, with version pinning
- ✅ Arduino-style **combined board + port selector** in the toolbar, listing boards detected
  on connected ports, plus a "select other board and port" picker.
  See `docs/BOARDS-AND-LIBRARIES.md`
- ⬜ PlatformIO projects, on-device debug

## Simulator (Wokwi / Tinkercad-style) - no hardware needed
- ✅ **Native simulation**: your real `setup()`/`loop()` compiled with g++ against a mock Arduino
  runtime, so `digitalWrite`/`digitalRead`/`analogWrite`/`millis`/`Serial`/`tone`/`map` all run
- ✅ **2D SVG canvas** editor (the research-backed Wokwi/Tinkercad approach) with a virtual Arduino
  Uno, a grid workspace, and live pin states
- ✅ **Parts palette:** LED, RGB LED, grounded button, buzzer, potentiometer,
  legacy PWM servo indicator, photoresistor, temperature input, 7-segment,
  driver-controlled motor/STEP-DIR stepper/ideal actuator and theoretical supply.
  Resistors are retained only in legacy layouts; current is not solved.
- ✅ **Multi-pin components** with per-pin connectors and wiring (RGB LED mixes its R/G/B channels
  live; the 7-segment lights individual segments); model generalizes to OLED/NeoPixel next
- ✅ Demo sketches in `examples/sim/` (RGB fade, 7-segment 0-9 counter)
- ✅ **Terminal graph wiring:** part-to-part and board links, explicit power/GND,
  male-to-male/female-to-female/alligator metadata, removal and keyboard controls.
- ✅ **Live + interactive**: LEDs glow (PWM brightness), buttons drive inputs (correct INPUT_PULLUP),
  potentiometer/photoresistor/temp sliders feed `analogRead`, buzzer/servo animate; per-part
  rotate/detach/delete
- ✅ **Circuit v3 save/load** to `.cortex/diagram.json`, backward migration,
  strict malformed-input rejection, ordered/conflict-checked saves and saved board/settings.
- ✅ **3D inspection:** top/underside/reset/full orbit, pin labels and functions,
  Uno/ESP32/Pi/Teensy 4.1 inspection models; only Uno host firmware execution.
- ✅ **Circuit findings:** known voltage/ground/supply/output/pin hazards with
  explicit model limits; not an electrical safety certificate.
- ✅ **Limited Wokwi JSON exchange** and Wokwi/Tinkercad browser actions; no
  embedded provider engines or automatic code upload. See [workbench](SIMULATION-WORKBENCH.md).
- ✅ Live **serial output** panel; Run / Stop
- ⬜ Cycle-accurate MCU engines, more peripherals (OLED, NeoPixel, bus-connected
  sensors), real servo pulses, electrical/current solver and ROS2. See [`SIMULATOR.md`](SIMULATOR.md).

## Automated firmware testing and CI benchmarks

CLI and desktop workflow; see the complete [quickstart and reference](FIRMWARE-TESTING.md).

- **Headless real-sketch execution:** shares host build preparation with the
  desktop simulator; compiles the supported Uno `setup()`/`loop()` with the
  Arduino shim without opening Electron.
- **CLI suite runner:** `npm run firmware:test` loads one scenario or a directory;
  compiler, source override, report directory and repeat count are selectable.
  Exit 0 means pass, 1 means failed behavior assertions, 2 means runner error.
- **Versioned scenarios:** strict version 1 JSON describes firmware target,
  initial state, timestamped ADC-scale inputs, seed, execution limits and
  assertions; an accompanying JSON Schema supports editors and tooling.
- **Repeatable simulation:** virtual timing APIs, stable equal-time input order,
  seeded randomness and a fresh process/state per run; repeat mode compares
  trace fingerprints. Desktop interactive simulation retains elapsed host time.
- **Behavior checks:** deadline events, sampled output state, continuous actuator
  ranges and ordered Serial state transitions, with named assertion evidence.
- **Supported example:** Uno A0 sensor, D2 freshness toggle, D9 PWM actuator and
  D13 fault indicator; documented normal, stopped-sensor and invalid-input cases.
- **Bounded execution:** independent build and firmware host timeouts plus
  output/event limits protect local and CI execution, including a sketch that
  never advances virtual time.
- **Harness verification:** repeat mode checks the passing controller's identical
  traces; the self-test verifies a genuine missing-timeout assertion failure and
  an infinite-loop watchdog fixture.
- **Actionable reports:** Markdown summary and versioned JSON with verdicts,
  failure times, inputs/outputs, assertion evidence, logs, compiler arguments,
  source/shim/generated-driver hashes, environment and revision.
- **Saved-report replay:** reruns embedded configuration even if scenario JSON
  changed; uses the preserved source path or an explicit corrected-source
  override. The original source/toolchain must remain available.
- **GitHub Actions:** pull-request/main workflow with pinned tooling and locked
  dependencies; behavior failures fail CI; reports upload even after failure and
  readable test/benchmark summaries appear on the run.
- **Repeatable benchmarks:** fixed 60,000ms virtual workload, repeated host
  execution measurements, throughput, environment/revision metadata, explicit
  saved baseline and advisory comparison; virtual-time duration is distinct
  from host performance.
- **Desktop tests:** toolbar/menu/palette Run Tests, saved-file preparation,
  scenario statuses, assertion timestamps/evidence, input/output/log previews,
  full saved JSON/Markdown reports and report-embedded replay. Workspace-confined
  native runs have cancellation, batch/output budgets and unique report folders.
- **Demonstration:** an actual [playback-validated desktop recording](demos/README.md)
  shows passing firmware, the broken timeout report and a verified fix.
- **Follow-up:** two fresh-install teammate trials and one outside-team trial.
  These are tracked tasks, not completed user validation.

Native host tests do not emulate MCU instructions, electrical circuits, real
hardware timing or arbitrary sensor libraries. Coverage is the supported Uno
workflow and its assertions; see the quickstart's limitations before adapting
another firmware example.

## Serial & devices
- ✅ Serial port discovery with manufacturer/VID:PID
- ✅ Connect/disconnect, baud selection, send line
- ✅ Serial monitor: timestamps, autoscroll toggle
- ✅ **Live plotter** - auto-detects `key: value` pairs and CSV numeric streams and graphs them
- ⬜ Hex/ASCII/CSV view modes, regex filter, colorize rules, export to file
- ⬜ Multiple simultaneous ports
- ⬜ Logic-analyzer / I²C / SPI decoding (via plugins)

## AI assistant
- ✅ Right-side chat panel, streamed responses
- ✅ Embedded-tuned system prompt (ISRs, DMA, RTOS, registers, `volatile`, watchdog)
- ✅ Sends the active file as context
- ✅ Quick actions: Analyze firmware · Optimize power · Explain file
- ✅ Provider-agnostic: Anthropic, OpenAI, or local OpenAI-compatible (Ollama/LM Studio)
- ✅ Workspace read/search tools and per-file edit proposals with explicit
  review/approval: [AI assistant](AI-ASSISTANT.md). Approval race hardening is
  tracked in [Task audit](TASK-AUDIT.md).
- ✅ Imported-document search and cited context for chat/agent tools:
  [Datasheets](DATASHEETS.md).
- ⬜ Repository-wide autonomous editing and schematic image analysis
- ⬜ MCP tool integrations (flash, read registers, run tests)

## Hardware inspectors (planned)
- ⬜ GPIO inspector (live pin states)
- ⬜ Memory viewer (Heap/Stack/Flash/EEPROM bars)
- ⬜ Register viewer (edit peripheral registers live)
- ⬜ RTOS viewer (FreeRTOS task table)

## Debugging
- ✅ **Host C/C++ source debugger** driven by **gdb** (MI2): gutter breakpoints, continue,
  pause, step over/into/out, stop
- ✅ **Live variables** for the selected frame, **call stack** (click a frame to inspect it),
  **watch** expressions, and a raw **gdb console**
- ✅ Current-line highlight + reveal on every stop; breakpoints editable mid-session
- ✅ Confined like the filesystem: allowlisted bare compiler, workspace-only paths, and a
  Stop that actually cancels an in-flight debug build. See `docs/DEBUGGING.md`
- ⬜ Multi-file / CMake debug targets (tracks the general multi-file build work)
- ⬜ Registers, memory and disassembly views
- ⬜ On-chip debug via OpenOCD / J-Link / ST-Link (needs a hardware probe)

## Platform & packaging
- ✅ Cross-platform Electron shell
- ✅ Persistent settings (compiler defaults, Python path, AI provider) in user data dir
- ✅ **Security**: contextIsolation, production CSP, single-instance lock, AI key encrypted with OS
  keychain (safeStorage) and never sent to the renderer, spawn allowlist (only known compilers/
  interpreters), destructive filesystem ops confined to the open workspace
- ✅ Unit tests (Vitest) + CI (GitHub Actions: typecheck, test, build on Ubuntu and Windows)
- ✅ electron-builder config for Windows (NSIS), macOS (DMG), Linux (AppImage/deb)
- ⬜ Auto-update
- ✅ Board/core and library managers; see supported setup and hardware limits in
  [Board tools](BOARD-TOOLS.md). Each vendor still needs a compatible installed core.
- ⬜ Plugin/extension system

## Keyboard shortcuts (current)
| Shortcut | Action |
|---|---|
| Ctrl/Cmd + Shift + P | Command palette |
| Ctrl/Cmd + P | Quick-open file |
| Ctrl/Cmd + S | Save active file |
| Ctrl/Cmd + B | Toggle sidebar |
| Ctrl/Cmd + ` | Toggle bottom panel |
| F5 | Run active file |
## Customer-release hardening

- Real local folders and file writes, recent projects, guarded save/switch/close,
  atomic replacement and explicit external-change recovery: [Projects](PROJECTS.md).
- Ordered atomic project-settings saves, cancelled build/launch preparation,
  native serial ownership/timeouts and a scoped Monaco highlight-cancellation fix.
- Metadata watcher and ordered Explorer refreshes handle rapid external rename/delete
  and missing-root errors while preserving open edits; Windows firmware shutdown
  preserves output and failure codes under repeated native launches.
- Repository initialization, branch creation, literal staging/rename unstaging,
  scoped commit/push, confirmed fetch and fast-forward pull: [Git](GIT.md).
- Saved terminal graphs, jumper connector types, supplies, driver-controlled motors,
  STEP/DIR steppers, bounded actuators, circuit findings and board underside/pin
  inspection: [Simulation workbench](SIMULATION-WORKBENCH.md).
- Validated Wokwi Uno circuit exchange and browser actions for Wokwi/Tinkercad;
  no embedded proprietary engine or automatic code upload.
- CI publication follows three-platform verification and dependency auditing.
  Default local packaging never publishes; the guarded manual release command
  runs quality/audit checks and permits only the pinned GitHub draft destination.
  See [publication instructions and limits](PRODUCTION-READINESS.md#packaging-and-manual-publication)
  and [constraints](../CONSTRAINTS.md). The current audit still blocks release.
