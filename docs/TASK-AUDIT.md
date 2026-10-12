# Task audit

Inventory date: 2026-10-10. This separates executable local tasks from external
release gates, recurring maintenance and future product scope. It does not turn
every historical roadmap sentence into an approved immediate implementation or
mark a customer release ready. Use [tasks/todo.md](../tasks/todo.md) for the
firmware acceptance checklist, [tasks/plan.md](../tasks/plan.md) for the active
slice and [CONSTRAINTS.md](../CONSTRAINTS.md) for the unchanged quality floor.

## Complete Markdown audit and verified workbench checkpoint

All 50 tracked Markdown files at `da1aee318de35b4ce321074ed18b37d56ec7ac87`
were read in full, including the hidden project guidance, example READMEs and
application prompt. Vendor dependencies, generated output and unrelated untracked
files are not product-task sources. The new [written plan](../.turbo/plans/cortex-production-workbench.md)
was independently reviewed before implementation.

The completed workbench checkpoint covers global settings save integrity,
horizontal dock fitting, keyboard recent-project controls and exact BOM/CRLF
snapshots after AI approval. Local commits are `cfc1f30`, `c145913`, `2f1c84a`,
`852dd12` and `da99c9b`; only the earlier baseline was pushed. Focused regressions,
types/build, the 107-suite full run (1939 passes and five unchanged skips),
repeated firmware, negative self-tests, advisory benchmark and fresh native
desktop acceptance pass. See [Release validation](RELEASE-VALIDATION.md) for
source boundaries and the retained failed attempts, including a native BOM
defect and the new plan's corrected typography failure.

An additional accepted finding arose while reviewing that checkpoint: Settings
event handlers dropped rejected saves, including success-only key/URL draft
clearing. The verified renderer fix reports one credential-safe error, preserves
the programmatic rejection contract and retains failed or newer mounted drafts.
This is a scoped persistence follow-up, not a dependency or API migration.

Cross-component review also found that notifications still used saved right-dock
widths after the dock fitted a smaller window. The accepted remedy shares the
displayed width and caps the inset for narrow CSS viewports. Five actual
App/Toasts regressions fail with the stored-width behavior and pass with the fix;
native constrained/zoomed rendering also passes separately. Malformed settings
patch tests prove rejection, unchanged disk/cache, no staging leftovers and later
valid-save recovery without changing the production guards.

The independent remainder review also found that a successful earlier text-field
save resets newer typing through the generic settings input. This behavior already
exists at the baseline; it is an accepted settings-integrity follow-up, not a new
regression introduced by persistence. The verified remedy preserves newer edit
revisions, adopts external values only while clean, retains failed-save retry
and makes Escape restore the latest committed value. Deferred responses,
A-to-B-to-A edits and stable field identity have actual component regressions.
These drafts are not durable: leaving a category/view can discard unsaved input.

The completed follow-up is the separately
[reviewed file-ownership plan](../.turbo/plans/cortex-reviewed-file-ownership.md),
covering queue items 2 and 3 below. Corrected native encoding acceptance and the
combined workbench gate have passed. Actual producer, store/filesystem and
mounted-card/VCS regressions first reproduced the existing gaps. Final types/build,
111 suites (2052 passes and five unchanged skips), serial firmware/self-test,
advisory benchmark and fresh native approval/ordinary Git controls now pass.
The actual producer tests substitute provider transport; native cards are seeded.
Neither establishes live provider connectivity or native race timing.

The completed next slice is the separately
[reviewed library-documentation plan](../.turbo/plans/cortex-library-docs-provenance.md),
covering queue item 4. Qualified ownership, accepted raw resolution state and
cursor-specific lexical hardware help now pass 182 focused cases, final types/build,
112 suites/2138 passes with five unchanged skips, serial CLI checks and genuine
clangd hover/completion/save controls. Native evidence is limited to the documented
fixtures, not every installed-server payload. The completed compiler follow-up
uses the [reviewed capture plan](../.turbo/plans/cortex-bounded-compiler-diagnostics.md):
measured whole-record/normalized-array budgets, strict structured Rust data,
authoritative Cargo terminal outcomes and conditional persistent omission evidence.
Final types/build, 116 suites/2311 passes with five unchanged skips, serial CLI
checks, guard mutations and actual GCC desktop controls pass. These are diagnostic
capture bounds, not peak/total heap or Debug transport limits.

More tools focus/navigation is complete locally at `354dd1d`, with 33 focused
cases and native acceptance of 37 controls and 196 trusted input events. These
include six normal Tab exits and nine single-transition tool activations. The
requested 900x600 window was actually 900x601. This is not a complete accessibility
audit or fresh-install, hardware, provider or remote CI acceptance. At that menu
checkpoint keyboard splitter resizing remained pending a reviewed written plan. Native inspection also
found that a long review-card filename can clip its new-file badge; retain this
visible layout follow-up without claiming every badge was readable.

Keyboard panel resizing has now passed focused regressions, guard/direction
mutations, independent review, types/build, the 118-file regression and owned
native controls under the
[reviewed plan](../.turbo/plans/cortex-keyboard-panel-resizing.md), with implementation
commits `6f868d5`, `e007e8d` and `72e63dd`; see the
[separate checkpoint](RELEASE-VALIDATION.md#keyboard-panel-resizing-checkpoint)
for exact receipts and retained failed attempts. The long-filename review badge
remains separately queued. Remote CI, audit and external release gates remain open.

Remaining executable queue, in priority order:

1. Validate the locally corrected failures in exact-revision remote CI without
   weakening assertions or timeouts. Baseline Windows logs show 27 failed cases
   across datasheet/Git/configuration
   persistence and actual `RUNNER~1` temporary paths. Physical-versus-lexical root
   comparisons reject admitted aliases; the config race fixture intercepts the
   wrong path. Baseline firmware CI fails before collecting two service suites because
   their transitive Electron imports reach a deliberately absent desktop binary.
   Local corrections retain real filesystem/Git/PDF/compiler behavior, isolate
   only that main-runtime test boundary, and pass the combined regression.
   A new remote pass is still required; the failed baseline jobs are not passes.
2. Completed locally: preserve explicit file-existence provenance in reviewed AI proposals. An empty
   original is not proof that creation was reviewed; retain absence/conflict guards.
3. Completed locally: fence delayed Git-triggered tab reloads by workspace and tab ownership, so a
   closed/reopened tab cannot adopt an older asynchronous read.
4. Completed locally: require library provenance before applying supplemental stdlib documentation
   to ambiguous completion labels such as a user-defined `clear` or `size`.
5. Completed locally: measure and bound compiler-diagnostic captures, retaining real
   diagnostics and explicit omission signals. Display retention alone is not a
   producer-memory bound; full-process/peak memory remains a separate claim.
6. More tools focus/navigation is completed locally; keyboard splitter resizing
   is also verified and committed locally. The badge remains separately queued.

Policy-dependent work remains unsaved-draft Restore/Discard and retention,
recoverable deletion, and release-update/crash-reporting policy. Larger product
increments include bounded Git history, genuine selected-core Arduino IntelliSense,
multi-file project builds and additional simulator engines. Board pin/device-map
curation requires authoritative board evidence; unsupported behavior must remain
explicit. Signing, OS installer trials, actual hardware and teammate/outside-team
testing remain external release gates.

### Exact pushed-revision CI evidence

The connected GitHub job-log reader confirms the failures at the exact revision
above. [CI run 38105055828](https://github.com/Blasted-ctrl/Cortex/actions/runs/38105055828)
completed with Ubuntu types/tests/build passing and dependency advisories failing;
Windows types passed, tests failed and build/audit were skipped.
[Firmware run 38105055817](https://github.com/Blasted-ctrl/Cortex/actions/runs/38105055817)
passed types but failed unit collection (`datasheetService.test.ts` and
`projectModel.test.ts`: Electron installation-path lookup). Its desktop build,
scenarios, self-test and benchmark were skipped. Public annotation counts are not
the complete failure inventory; the decoded job logs supersede them. Both workflows
remain failed, not validated remote acceptance.

<details>
<summary>Audited Markdown files at the baseline (50)</summary>

```text
.claude/claude.md
AGENTS.md
CONSTRAINTS.md
README.md
benchmarks/README.md
docs/AI-ASSISTANT.md
docs/ARCHITECTURE.md
docs/AUDIT-ROUND4.md
docs/AUDIT-ROUND5.md
docs/AUDIT-SESSION-3D-UI.md
docs/BACKLOG.md
docs/BOARD-TOOLS.md
docs/BOARDS-AND-LIBRARIES.md
docs/CONTRIBUTING.md
docs/CPP-AUTO-INCLUDES.md
docs/DATASHEETS.md
docs/DEBUGGING.md
docs/DEPENDENCY-REMEDIATION.md
docs/FEATURES.md
docs/FIRMWARE-TESTING.md
docs/GIT.md
docs/LANGUAGES.md
docs/LSP.md
docs/PRODUCTION-READINESS.md
docs/PROJECT-CONFIG.md
docs/PROJECT-MODEL.md
docs/PROJECTS.md
docs/RELEASE-VALIDATION.md
docs/ROADMAP.md
docs/SIMULATION-WORKBENCH.md
docs/SIMULATOR-3D.md
docs/SIMULATOR.md
docs/STDLIB-DICTIONARY-WORKFLOW.md
docs/STYLE.md
docs/TASK-AUDIT.md
docs/TECH-STACK.md
docs/THEME.md
docs/VISION.md
docs/demos/README.md
docs/implementation/CORTEX_DECISIONS.md
docs/implementation/CORTEX_IMPLEMENTATION_PLAN.md
docs/implementation/CORTEX_PROGRESS.md
docs/implementation/INTELLIGENT_DEPENDENCY_SYSTEM.md
docs/implementation/UI_REWORK_PLAN.md
examples/firmware-testing/README.md
examples/multilang/README.md
examples/robot/README.md
src/main/prompts/embedded-engineer.md
tasks/plan.md
tasks/todo.md
```

</details>

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
The separate terminal ownership slice now passes 38 focused cases, full
100-suite/1813-case regression with the same five skips, types/build/CLI and
owned real-native controls, including actual failed-save quit and late-old-exit
overlap. It is not part of the Vitest migration or its fresh-install proof.
External release requirements and upstream ConPTY remediation remain unfinished.
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
| 13 | Terminal-service session ownership after the isolated Vitest checkpoint | Complete: 15 actual-service cases plus quit-wiring/neighbors (38 total), full 100-suite/1813-case regression and owned default-PowerShell/cancelled-quit/native-overlap/finite attached-graph controls pass. Current output/exit survives; native import timing and arbitrary descendants are not claimed. ConPTY warning remediation remains separate |

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
7.3.7 with the React plugin floor at 4.7.0, Vitest 4.1.11 and exact
electron-builder 26.15.3. Electron 33.4.11
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
types/build/native ABI are not inferred. That checkpoint's inclusive audit exits 1 with
25 findings (one critical, 18 high, six moderate), still blocking release.
Electron/PDF and all existing verification floors stay unchanged.

The separately approved builder upgrade is committed as `3949639`; dependency
changes are limited to the exact manifest pin and generated packaging closure. Full
101-suite/1817-pass regression plus the same five skips, types/build, repeated
CLI, negative self-tests and advisory benchmark pass. A normal new-lock fresh
install and the same 177 focused cases pass separately. The original-config
unpublished Windows package's actual CLI/serial/PTY/PDF-worker/circuit-save
controls pass without runtime/native replacement. Historical harness failures
remain in the ledger; this does not establish OS installer/signing or hardware
readiness. The current inclusive audit exits 1: 17 findings, zero critical,
seven high and ten moderate. It still blocks release; remaining majors require
individual review and approval.

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
