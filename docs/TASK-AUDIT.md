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

Debugger output uses the shared recent-tail text budget, with actual-store and
buffer regressions. Build/run console transport additionally bounds queued work
with acknowledged packets and per-stream omission markers (`e8cd435`); an actual
native 16 MiB producer/2000 ms renderer stall now passes with an omission marker
and a responsive bridge. This is not a total-memory measurement. Structured compiler
diagnostics and complete bounded firmware reports are separate paths. The packaging
config now excludes `.mts`/`.cts` tooling configs; that is a local packaging
guard, not installer validation. Its actual electron-builder matcher regression
is in [releaseGuard.test.ts](../test/releaseGuard.test.ts); the fix is checkpoint
`30f6421`. A normal fresh `npm ci` now passes in an owned copy of `f89dce0`;
its independent full regression passed: 89 suites, 1610 tests and five existing
skips. It uses exact Node 22.20.0/npm 10.9.3 with normal optional dependencies and
install scripts. Genuine Electron/native terminal startup passed in its isolated
profile. Later snapshots have separately recorded verification below; this
historical fresh full-suite result does not cover their source changes.

## Finite local queue

The finite queue below is now being executed. Desktop tests/replay, PDF worker
isolation and debugger state have matching implementation and acceptance evidence;
their firmware/local checklist entries are checked. Keyboard navigation, sessions,
advanced choices and renderer guards are committed and have focused checks;
native keyboard/session/optimization checks now pass. The [recorded demo](demos/README.md) passed
full decoding, actual seek/frame checks and visual pass/failure/fix inspection;
fresh-install full regression passed. Output/panel implementations are committed,
with actual native stalled-output and panel acceptance now passing. The panel fix
is `6b55381`, with six failing-then-passing actual React geometry cases and genuine
short-window resize/zoom/drag/detail-scroll controls. The manual publication
bypass is closed with 84 focused cases and actual installed builder validation,
without a real publication. Debugger Stop/natural program exit and dev/HMR now
pass on their explicitly recorded source boundaries. AI approval has 31
actual-store regressions, independent review and four final-production native
controls. The approved Vite combined/fresh baseline is complete. The subsequent
Vitest combined/native checks and new-lock normal clean-install/focused gate pass.
External release requirements remain unfinished. The newly discovered terminal
ownership races are a separate local slice, not part of that dependency upgrade.
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
| 11 | Close local publication bypass discovered during final inspection | Default local packaging never publishes; manual publication must pass quality/audit checks, refuse public or ambiguous exact-target releases and create drafts only. Exercise fake failure paths, not a real publication |
| 12 | Protect existing reviewed AI-edit approval from data loss | Deferred actual-store regressions preserve new typing and disk changes across approval reads/writes, prevent duplicates/stale project writes, and retain valid reviewed edit behavior. This is a safety fix, not autonomous/repository-wide AI scope |
| 13 | Terminal-service session ownership after the isolated Vitest checkpoint | Retired same-ID callbacks cannot clear a replacement; teardown cancels deferred loads and handles reentrant native kill callbacks. Preserve current natural output/exit and verify owned native termination separately from the unresolved upstream ConPTY warning |

Implementation evidence for these remaining boundaries:

- [Firmware runner](../src/main/firmwareTesting/runner.ts) and
  [CLI](../src/main/firmwareTesting/cli.ts) already provide the reusable workflow;
  the [firmware checklist](../tasks/todo.md) owns desktop completion status.
- [Packaging config](../electron-builder.yml) defines artifact targets/exclusions;
  prior release evidence explicitly distinguishes installed-tree checks from a
  fresh install and real installer validation.
- [Console buffer](../src/shared/consoleBuffer.ts) bounds retained display text;
  [runnerService](../src/main/services/runnerService.ts) routes console output
  through bounded acknowledged delivery. The [measurement ledger](ARCHITECTURE.md#bounded-buildrun-console-delivery)
  records controlled stalled-consumer evidence and the separate diagnostic limits.
- [pdfExtractor](../src/main/services/pdfExtractor.ts) now delegates parsing to a
  terminable worker. The real CPU-loop watchdog, page/text limits, lifecycle and
  native built-worker import pass. [DATASHEETS.md](DATASHEETS.md) distinguishes
  the V8 heap limit from total-memory or security isolation.
- [DebugPanel](../src/renderer/src/components/DebugPanel.tsx) now stays mounted
  across tool switches and follows an explicit session reset policy. Nine real
  React state/race checks pass; actual GDB Watch/Console and sidebar preservation
  also pass. Native Stop exposes a late disposed-process exit overwriting idle;
  lifecycle regressions and the rebuilt real Stop/restart control now pass.
  Independent review adds natural-exit drain coverage; final-build native Stop
  and normal program exit preserve output. Latest combined verification remains
  separate. [DEBUGGING.md](DEBUGGING.md) states the limits.
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
  Debug and scenario build policies; native persisted -O0/-O1 compiler and
  executable sink checks now pass, with the visible -Ofast warning.
- [Window setup](../src/main/index.ts) now uses `sandbox: true`, an exact renderer
  document navigation policy and main-frame/window IPC guards. Security tests and
  actual production sandbox/bridge/native controls and dev/HMR pass; final source
  regression/fresh-install checks remain separate gates. Constructed negative
  handlers are not native exploit tests. No dependency security waiver follows.

## Security majors requiring individual review/approval

The separately approved tooling steps are electron-vite 4.0.1, root Vite
7.3.7 with the React plugin floor at 4.7.0, and Vitest 4.1.11. Electron 33.4.11
and the PDF 4.0.3 compatibility hold remain unchanged. The preceding Vite-only
checkpoint retained Vitest 2.1.9's compatible nested Vite 5.4.21; that is historical,
not the current installed graph.

Historical Vite verification failures remain in the validation ledger: laptop
sleep/watchdog, two desktop-firmware deadlines, and an insufficient within-file
bound were not credited as passes. Serial file/native-case scheduling preserves
isolation, deadlines, assertions, skips and within-case races. The separately
discovered Windows session expansion mismatch and debugger disposed-callback
defect have failing-then-passing regressions and native controls. Follow
[DEPENDENCY-REMEDIATION.md](DEPENDENCY-REMEDIATION.md) for separate major review,
peer/engine compatibility, migration scope and approval before each install.
Do not force test dependencies onto an incompatible Vite or waive findings as
dev-only. A local feature checkpoint is not a release approval.

The user subsequently approved the isolated Vitest 2.1.9 to 4.1.11 migration,
to start after this combined/fresh-install baseline finishes. Its versioned
v3/v4 migration and registry/advisory preflight is documented. After that baseline
finishes, it is installed with only test-stack/live-command changes. The 277 focused
cases, full 99-suite/1797-case regression with the same five skips, types/build,
firmware/benchmark commands and unchanged-runtime native acceptance pass.
Independent graph/native/config guards pass. The separate new-lock normal fresh
gate passes on an owned exact-archive D: fixture: normal scripts/dev/optional
install, all 680 locked versions and the same 277 focused cases. Its first C:
attempt failed for disk exhaustion with retained logs; fresh full regression/
types/build/native ABI are not inferred. The latest inclusive audit exits 1 with
25 findings (one critical, 18 high, six moderate), still blocking release.
Electron/PDF and all existing verification floors stay unchanged.

The final approved-Vite combined baseline now passes on implementation source
`c15627f`: 99 suites/1797 cases plus the same five existing skips, exact Node
22.20.0, both types/build, nine reproducible CLI runs, expected negative self-tests
and a ten-run advisory benchmark. Latest native approval/Stop/program-exit and
the separately bounded dev/HMR checks also pass. The exact-source normal fresh
locked install, types/build and native terminal controls now pass separately;
this is not a fresh second full-suite result. The observed upstream explicit-kill
ConPTY warning remains a bounded investigation task, not a clean-stderr claim.
That baseline satisfied the prerequisite for the subsequent Vitest step above;
remaining majors still require separate review and approval.

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
