# Backlog (production readiness for 100k+ users)

Source: multi-agent completeness audit against a "$50M startup, 100k users" bar. Ordered by
priority (1 = do next). Status updated as items ship.

## Genuinely done-done
- Editor shell: Monaco + cortex-dark theme, tabs with dirty tracking, minimap, per-extension
  language detection, Ctrl+S / F5.
- Workspace: open folder, lazy tree, filesystem watching.
- Native run for C/C++ (compiler/std/optimization), Python, JavaScript, and Rust, with compiler
  diagnostics parsed into inline Monaco markers + a Problems panel.
- arduino-cli boards: availability check, list connected/installable, Verify + Upload with FQBN
  selector persisted to `.cortex/config.json`, graceful degradation.
- Simulator MVP: real `setup()`/`loop()` compiled against a host Arduino shim, streaming live
  LEDs/PWM/buttons/buzzer + serial. Verified end-to-end.
- Serial monitor with discovery, baud, send, timestamps, and a live auto-plotter.
- AI: provider-agnostic SSE streaming across Anthropic, Gemini, OpenAI, and any OpenAI-compatible or
  local endpoint, with active-file context.
- Security baseline: contextIsolation on, nodeIntegration off, network in main, production CSP.
- TypeScript strict across the codebase; `npm run typecheck` passes.

## Prioritized backlog

| # | Item | Category | Impact | Effort | Status |
|---|---|---|---|---|---|
| 1 | Code signing + macOS notarization + app icon | production | critical | L | todo |
| 2 | Auto-update (electron-updater) + upgrade off Electron 33 | production | critical | L | todo |
| 3 | AI key in Electron safeStorage; stop returning key to renderer | production | critical | M | **done** |
| 4 | Confine spawn (compiler/arg allowlist) + FS IPC to workspace | production | critical | M | **done** |
| 5 | Guard dirty-tab close (no silent data loss) | ux | critical | S | **done** |
| 5a | Resizable panels (sidebar / AI / bottom splitters, persisted) | ux | critical | L | **done** |
| 5b | API key field persisted only the last character typed and reported "saved" | functional | critical | S | **done** |
| 5c | F5 / palette handed `.ino` sketches to host g++ | functional | critical | S | **done** |
| 5d | Simulator compiled any file ("multiple definition of main" on the default file) | functional | critical | S | **done** |
| 5e | Native unstyled selects beside Run; dirty-tab dot hidden until hover; `ide.faint` failed AA | visual | critical | S | **done** |
| 6 | Run-output backpressure: ring buffer + batch send + virtualize | production | critical | M | partial (ring cap done) |
| 7 | Crash reporting + opt-in telemetry | production | high | M | todo |
| 8 | Main resilience: global error handlers, single-instance, per-handler try/catch | production | high | M | partial (handlers + lock done) |
| 9 | Flip Rust to runnable (backend already works) | language | high | S | **done** |
| 10 | sandbox:true renderer + will-navigate allowlist | production | high | S | todo |
| 11 | CI (GitHub Actions) + Vitest; first unit tests | testing | high | M | **done** (33 tests) |
| 12 | Command palette (Ctrl+Shift+P) + quick-open (Ctrl+P) | ux | high | L | **done** |
| 13 | File-tree context menu wired to existing rename/delete IPC | ux | high | M | **done** |
| 14 | LSP integration (clangd / pyright / rust-analyzer) | language | high | XL | todo |
| 15 | Agentic AI (tool calling, apply diffs, multi-file context) | ai | high | XL | todo |
| 16 | Extract plotter parser to shared; fix chunk-boundary split bug + test | testing | medium | M | **done** |
| 17 | Extract sim protocol parser to shared; fix malformed-line drops + tests | testing | medium | M | **done** |

## Next big build (from research): 2D-first SVG simulator
The research pass recommends a **2D SVG** simulator editor (Wokwi and Tinkercad are both 2D; 3D
fights the wiring loop), with a renderer-agnostic netlist (union-find) so an **optional** 3D showcase
view (three.js / react-three-fiber) can be added later for the hero and camera/servo demos. Target
components: LED, resistor, pushbutton, potentiometer, servo, buzzer, 7-segment, LCD1602, SSD1306
OLED, NeoPixel, HC-SR04, DHT22, plus Uno/Nano/Mega/ESP32/Pico boards. Cycle-accurate engine via
avr8js (AVR) and rp2040js (Pico) once a compile-to-hex path exists. See [`SIMULATOR.md`](SIMULATOR.md).

## Automated firmware testing follow-up

The first release delivers headless Uno example execution, version 1 scenarios,
deterministic virtual inputs/time, behavior assertions, hang protection, reports,
replay, failure-detection fixtures, CI and advisory benchmarks. Setup and failure
reproduction are documented in [FIRMWARE-TESTING.md](FIRMWARE-TESTING.md).
The detailed acceptance/verification checklist is in
[tasks/todo.md](../tasks/todo.md).

| Order | Remaining task | Completion evidence |
|---|---|---|
| 1 | Desktop Run Tests calls the same runner | Passing and failing scenarios launched from the app |
| 2 | Desktop results/details and saved-scenario rerun | Failure inputs, outputs/logs and preserved configuration can be inspected and rerun |
| 3 | Record a short demonstration | Correct sketch passes, broken sketch fails, report locates the problem, corrected sketch passes |
| 4 | Two teammate trials from fresh installs | Record setup/report confusion and verify resulting fixes |
| 5 | One outside-team trial | Record usefulness for their firmware and missing capabilities |
| 6 | Establish representative CI baselines | Repeated runs on compatible tooling/hosts quantify normal variation |
| 7 | Expand boards/peripherals from trial evidence | New capability has a documented runnable example and scenarios |

Automated local verification is not evidence that a demonstration was recorded
or that teammates/an outside team tried the workflow.
