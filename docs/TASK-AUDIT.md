# Task audit

Inventory date: 2026-10-10. This separates executable local tasks from external
release gates, recurring maintenance and future product scope. It does not turn
every historical roadmap sentence into an approved immediate implementation or
mark a customer release ready. Use [tasks/todo.md](../tasks/todo.md) for the
firmware acceptance checklist, [tasks/plan.md](../tasks/plan.md) for the active
slice and [CONSTRAINTS.md](../CONSTRAINTS.md) for the unchanged quality floor.

## Existing baseline and stale completed items

The CLI first release covers the user's sections 1-3 plus the quickstart:
supported Uno example, deterministic scenarios, assertions, reports/replay,
failure fixtures, watchdogs, workflow configuration and advisory benchmarks.
Local verification is in [RELEASE-VALIDATION.md](RELEASE-VALIDATION.md); it does
not prove a remote workflow ran or people completed fresh-install trials.

Already implemented, not new unstarted tasks: real local project saving/opening
and recent projects, Git's documented local operations, managed board tools,
Rust Cargo/rustc execution, LSP providers, Dark/Light themes, split editor groups,
shared 2D/3D circuits and four stylized board inspection models. See
[PROJECTS.md](PROJECTS.md), [GIT.md](GIT.md), [BOARD-TOOLS.md](BOARD-TOOLS.md),
[LSP.md](LSP.md) and [SIMULATION-WORKBENCH.md](SIMULATION-WORKBENCH.md) for their
actual limits. None establishes arbitrary firmware/board or electrical parity.

The current debugger-output slice reuses the shared recent-tail text budget,
with actual-store and buffer regressions. It closes the single-giant-chunk
retention gap, not the backlog's producer/IPC backpressure task. The packaging
config now excludes `.mts`/`.cts` tooling configs; that is a local packaging
guard, not installer validation. Its actual electron-builder matcher regression
is in [releaseGuard.test.ts](../test/releaseGuard.test.ts); the fix is checkpoint
`30f6421`. A normal fresh `npm ci` now passes in an owned copy of `f89dce0`;
its independent full regression and later-snapshot runtime checks are still running.

## Finite local queue

The finite queue below is now being executed. Desktop tests/replay, PDF worker
isolation and debugger state have matching implementation and acceptance evidence;
their firmware/local checklist entries are checked. Keyboard navigation, sessions,
advanced choices and renderer guards are committed and have focused checks, with
final native verification pending. The recorded demo needs playback validation;
fresh-install full regression and output/panel hardening are still in progress.
Do not infer completion from this inventory's status prose alone.

| Priority | Task/current boundary | Completion evidence |
|---|---|---|
| 1 | Desktop Run Tests, results/details and saved report/scenario replay using the existing headless runner; CLI alone does not provide these surfaces | Launch correct/broken fixtures from the app, inspect assertion timestamps/inputs/outputs/logs, rerun preserved configuration, and prove cancellation, failures and project switching cannot corrupt a newer run |
| 2 | Record the requested short demonstration after the desktop flow is usable | An actual recording shows pass, broken change, useful report and verified fix; screenshots and automated tests are not a recorded demo |
| 3 | Clean source installation and packaging verification | In an owned fresh copy/profile, normal `npm ci` and documented checks succeed; inspect actual packaged contents and record packaging failures honestly. The `.mts`/`.cts` exclusion is already present, but actual OS installers remain separate release gates |
| 4 | Output throughput/backpressure beyond the implemented retention budget | Measure a controlled high-output workload, bound queued producer-to-renderer work, preserve stream identity and omission semantics, and keep firmware reports unaffected |
| 5 | Isolate PDF parsing from the main event loop | A worker/utility-process boundary can be independently stopped on timeout; bounded valid/invalid fixtures retain page/text provenance and errors without freezing the app. No OCR is implied |
| 6 | Preserve debugger watch/expression-console state for its intended session lifetime | Switching sidebar tools preserves the current session's UI state; a new/stopped session follows an explicit reset policy, without stale results leaking between sessions |
| 7 | Explorer/editor-tab ARIA and keyboard behavior | Add actual tree/tablist semantics and intentional focus/navigation behavior; test keyboard-only open/select/close and nested navigation. Existing native buttons already provide basic keyboard activation |
| 8 | Restore saved project/editor session state | Saved tabs, active group/file and expanded folders reopen safely; missing/renamed files and failed switches are handled without overwriting dirty work. Recent project folders already exist; this is not unsaved crash recovery |
| 9 | Advanced optimization control | Provide validated project-level advanced choices and honest defaults, round-trip them through persistence and Run/Debug as applicable; retain the safe argument allowlist |
| 10 | Renderer sandbox/navigation hardening as a separately tested security slice | Review preload/module compatibility, then verify sandboxed dev/production startup and an explicit navigation allowlist without breaking valid file/editor/tool workflows; do not merely flip a flag |

Implementation evidence for these remaining boundaries:

- [Firmware runner](../src/main/firmwareTesting/runner.ts) and
  [CLI](../src/main/firmwareTesting/cli.ts) already provide the reusable workflow;
  the [firmware checklist](../tasks/todo.md) owns desktop completion status.
- [Packaging config](../electron-builder.yml) defines artifact targets/exclusions;
  prior release evidence explicitly distinguishes installed-tree checks from a
  fresh install and real installer validation.
- [Console buffer](../src/shared/consoleBuffer.ts) bounds retained display text;
  [runnerService](../src/main/services/runnerService.ts) still streams chunks to
  the renderer. Retention is not an IPC queue/throughput guarantee.
- [pdfExtractor](../src/main/services/pdfExtractor.ts) now delegates parsing to a
  terminable worker. The real CPU-loop watchdog, page/text limits, lifecycle and
  native built-worker import pass. [DATASHEETS.md](DATASHEETS.md) distinguishes
  the V8 heap limit from total-memory or security isolation.
- [DebugPanel](../src/renderer/src/components/DebugPanel.tsx) now stays mounted
  across tool switches and follows an explicit session reset policy. Nine real
  React state/race checks pass; [DEBUGGING.md](DEBUGGING.md) states the limits.
- [FileExplorer](../src/renderer/src/components/FileExplorer.tsx) and
  [EditorArea](../src/renderer/src/components/EditorArea.tsx) now expose tree/tablist
  semantics and roving keyboard focus, with 19 actual React behavior cases.
  Native keyboard checks remain separate from a complete accessibility audit.
- [Store](../src/renderer/src/store/useStore.ts) now persists bounded relative-path
  session metadata and restores current disk-backed tabs/expanded folders through
  physically confined main-process reads. Restore/watch/user-intent and delayed
  discard races have regressions. [PROJECTS.md](PROJECTS.md) documents the limits.
- [TargetSelect](../src/renderer/src/components/TargetSelect.tsx) exposes
  optimization presets and a validated advanced disclosure, without free-form
  shell arguments. [PROJECT-CONFIG.md](PROJECT-CONFIG.md) distinguishes host Run,
  Debug and scenario build policies; native persistence/sink checks remain open.
- [Window setup](../src/main/index.ts) now uses `sandbox: true`, an exact renderer
  document navigation policy and main-frame/window IPC guards. Security tests and
  actual production sandbox/bridge/native controls pass; dev/HMR and final source
  checks remain separate gates. No dependency security waiver follows from this.

## Security majors requiring individual review/approval

The installed tooling step is electron-vite 4.0.1; Vite 5.4.21, Vitest 2.1.9,
Electron 33.4.11 and the PDF 4.0.3 compatibility hold remain. The proposed Vite
7 step is not installed by this inventory. Follow
[DEPENDENCY-REMEDIATION.md](DEPENDENCY-REMEDIATION.md) for separate major review,
peer/engine compatibility, migration scope and approval before each install.
Do not force test dependencies onto an incompatible Vite or waive findings as
dev-only. The last recorded audit remains red: 31 findings, including three
critical and 19 high. A local feature checkpoint is not a release approval.

## External release gates

These require real external state, explicit authority or human participation:

- Observe the remote GitHub Actions run after an authorized push. Establish a
  compatible Linux benchmark baseline from measured CI variability; do not
  replace the incompatible saved baseline merely to produce a green comparison.
- Configure owner signing/notarization credentials and validate actual installed
  Windows/macOS/Linux artifacts on clean machines, including update/uninstall
  behavior and native modules. A source build or preview is not this evidence.
- Validate Verify/Upload on explicitly selected hardware/ports, including vendor
  drivers and serial permissions. Tests must not flash hardware as a shortcut.
- Exercise actual remote Git credentials, conflicts and offline recovery using
  authorized disposable repositories, not customer worktrees. Local bare-remotes
  and local commits do not establish every real credential path.
- Have two teammates and one outside team complete the fresh-install firmware
  workflow, record confusion/usefulness and verify resulting fixes. Automated
  fixtures are not substitutes for those people.
- Decide and evidence the supported OS/compiler/board matrix and the release
  update/crash-recovery/privacy policy before customer rollout. No automatic
  publishing or remote coordination is authorized by this inventory.

See [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md) and the release constraints
for the complete gate; keep these unfinished until their evidence exists.

## Recurring work and future product scope

[STDLIB-DICTIONARY-WORKFLOW.md](STDLIB-DICTIONARY-WORKFLOW.md) describes ongoing
small, source-verified curation batches. It has no finite "all libraries done"
endpoint. Its documented external schedule was not revalidated by this local
audit, and extending it to hardware `DEVICE_MAP` remains a separate scope.

Multi-file CMake/PlatformIO builds, multi-root workspaces, additional MCU engines
and device/bus models, general electrical/mechanical solving, manufacturer CAD,
LLDB/DAP/on-chip debugging, standalone formatter tools, search replacement,
agentic AI/plugins and a Tauri migration remain future bounded proposals. The
limited provider JSON exchange/browser links are not native Wokwi/Tinkercad
engine integration. Auto-update and crash reporting need both implementation
and release/privacy decisions. See [ROADMAP.md](ROADMAP.md) and
[BACKLOG.md](BACKLOG.md); do not silently expand an immediate task to all of them.

Historical `AUDIT*` and `docs/implementation/*` files retain their original
observations, old counts and deferred ideas. They are evidence of those dates,
not live release assertions. Current capability docs were corrected where the
source already implements a feature; unfinished checks are not checked off by
documentation cleanup.
