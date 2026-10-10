# Automated firmware testing

## First release

- [x] Share headless build preparation and add deterministic Uno shim mode.
  Acceptance: desktop retains interactive behavior; test delay advances virtual
  time; input ties preserve JSON order; fresh processes reset state.
  Verify: real-compiler shim and desktop stop tests. Dependencies: none.
- [x] Add versioned scenarios, CLI runner, behavior assertions and reports.
  Acceptance: exit 0 pass, 1 assertion failure, 2 runner error; bounded execution;
  reports preserve scenario, inputs/outputs, logs, failures and build configuration.
  Verify: validator/assertion tests and end-to-end CLI. Depends on shim mode.
- [x] Deliver normal, stopped-sensor and invalid-reading workflows.
  Acceptance: correct firmware passes; broken fixture fails a named assertion;
  repeated runs reproduce the timeline; hanging firmware is terminated.
  Verify: integration tests and one-command suite. Depends on runner.
- [x] Add repeatable benchmark, saved baseline and GitHub Actions reports.
  Acceptance: pinned toolchain/library versions; functional failures fail CI;
  artifacts/summary published; host/virtual metrics separate; alerts advisory.
  Verify: local benchmark and baseline comparison plus workflow inspection.
  Depends on runner and scenarios.
- [x] Document every first-release feature and publish a complete quickstart.
  Acceptance: install, one-command run, failure, fix, replay, scenario reference,
  expected results, capabilities and limitations are all covered.
  Verify: execute documented commands. Depends on preceding tasks.

## Follow-up release and user validation

- [ ] Verify the first remote GitHub Actions run after this change is pushed.
- [ ] Capture/promote a compatible Linux CI baseline after observing normal
  variability. The saved Windows baseline is actual local evidence; incompatible
  environments publish metrics but do not produce a misleading speed comparison.
- [x] Add desktop Run Tests action calling the same headless runner.
- [x] Add desktop results view with failure inputs, outputs and logs.
- [x] Add saved-scenario/report rerun in desktop; preserve reproduction config.
- [x] Record demonstration: correct firmware passes, broken firmware fails,
  report explains failure, and the fix passes.
- [ ] Have two teammates try the quickstart from fresh installations; record
  setup/toolchain/report confusion and resolve identified problems.
- [ ] Have one outside team try the workflow with its firmware; record usefulness,
  unsupported capabilities and priorities for the next board/peripheral.

Do not mark user trials or demonstration complete without actual evidence.

## Local verification evidence (2026-10-09)

- Full Vitest run: 54 suites, 880 passed and one CI-only check skipped locally.
- Added/updated targeted checks: 42 passed, including process limits, compile
  error configuration/log retention and replay after deleting scenario JSON.
- Type checks and desktop production build passed.
- Default suite repeated three times: nine successful runs, 29 assertions per
  three-scenario suite, matching virtual trace fingerprints.
- Harness self-test: broken timeout fails the shutdown assertion; hanging setup
  is killed by the independent wall clock. Both guard checks passed.
- Actual 10-run benchmark saved with separate host/virtual metrics; local
  compatible baseline comparison ran successfully and remained advisory.
- Pinned workflow inspected locally; remote CI and human trials remain open.

## Automatic C++ includes (2026-10-09)

- [x] Add missing owner headers for explicitly mapped qualified `std::` symbols
  while typing, pasting and completing, without requiring clangd.
- [x] Preserve clangd's initial and resolved completion include edits for
  project/library symbols the server identifies.
- [x] Keep caret, multiple cursors and scrolled code anchored; support ordinary
  Undo/Redo and deliberate header removal without reinsertion loops.
- [x] Preserve comments/literals, exact existing headers, full-file guards,
  leading configuration macros, BOM and CRLF; leave C and module units alone.
- [x] Flush pending edits centrally before Save/Save All, including workflows
  invoked through menus, toolbar, keyboard and save-before-build actions.
- [x] Document usage, supported symbol families and limitations in
  `docs/CPP-AUTO-INCLUDES.md`, the feature inventory, README and LSP guide.
- [x] Verify 91 focused tests. Full suite: 59 suites, 976 passed and one
  CI-only check skipped; both type checks and desktop production build passed.
- [x] Isolated Electron smoke: line-300 caret/viewport, real multicursor input,
  undo/redo, duplicate prevention, comment/string negatives, Save flushing,
  toolbar Run with a successful real compile, and no renderer exceptions.

This feature was verified locally before its source checkpoint commit; no push
was performed for this feature.

## Managed real-board tools (2026-10-09)

- [x] Replace the external Arduino CLI prerequisite with a shared bundled/managed
  resolver used by compilation, upload, package managers and toolchain detection.
- [x] Pin official CLI 1.5.1 portable artifacts; bound downloads and extraction,
  verify SHA256/size, publish owned files safely, and retain license/source notices.
- [x] Bundle the target-platform CLI outside ASAR during installer packaging.
  Source launches prepare a private CLI automatically when needed; no admin or
  global PATH changes are requested by board-tool setup.
- [x] Initialize private board/library catalogs with an isolated config/environment;
  preserve existing native PATH configurations and custom vendor URL preferences.
- [x] Add first-run progress and explicit retry in managers/devices/toolbar without
  blocking editing or simulation. Refresh installed targets and environment caches.
- [x] Keep optional vendor-catalog warnings actionable and clear them after a
  successful index refresh. Seed the matching Pico catalog for new configurations.
- [x] Document first setup, board-core installation, Verify/Upload, cached offline
  use, supported download targets and USB/driver limitations.
- [x] Verify 45 installer/packaging, 30 service-boundary, 13 provisioning and seven
  real-store cases. Full suite with four workers: 63 suites, 1068 passed and one
  CI-only skip; three warning-recovery guards added afterward also passed.
  Both type checks and the desktop/tools production build passed.
- [x] Real isolated Electron flow with no CLI on PATH: download and checksum
  verification, private catalogs, real AVR core install through Boards Manager,
  and toolbar Verify compiling Uno blink successfully. No hardware flashed.
- [x] Visible mock-preload UI smoke: progress, network failure, real Retry click,
  successful Library Manager, cleaned-up progress subscription, refreshed lists,
  and no renderer exceptions. Captured and visually checked all three states.
- [x] Real packaging hook produced runnable CLI plus license/notice/receipt.
  Staged Windows app launched with an isolated profile and reported bundled tools
  ready; an updated preview remains open for user validation.
- [x] Download and extract the actual pinned Linux x64 and macOS ARM64 archives
  with the public installer; checksums and expected license/provenance files match.
  Non-host executables were not run; native platform runtime testing remains open.
- [ ] Complete normal Windows installer generation on a host that permits the
  signing helper's symlinks. Local packing reached verified CLI bundling, then the
  existing signing-tool extraction failed for missing Windows symlink privilege.
- [ ] Validate actual board upload with the user's selected hardware and port.

Verification did not commit or push a user project, publish a release, change
system permissions or install a global CLI. Source checkpoints are saved separately.
# Customer release hardening (2026-10-09)

- [x] Implement atomic/conflict-checked file saves and guarded project/close transitions.
- [x] Add explicit reload-from-disk recovery and accessible recent-project actions.
- [x] Fix Git confinement, literal paths, rename unstaging and bounded operations;
  add repository initialization, branch creation, confirmed fetch and FF-only pull.
- [x] Add validated circuit v3 with backward migration, explicit power/ground terminals,
  part-to-part wires and saved connector types/settings/board.
- [x] Add driver-controlled motor/stepper/actuator signals and configured power sources;
  report known hazards without pretending to solve current or loads.
- [x] Remove persistent "Logic view" strip; add contextual capabilities/findings,
  underside access, pin inspection and Teensy 4.1 model.
- [x] Add limited validated Wokwi JSON exchange and browser provider actions.
- [x] Make releases quality/audit-gated and draft-only; point package publishing at
  Blasted-ctrl/Cortex without publishing anything during this work.
- [x] Complete full regression/build and isolated desktop evidence for this slice:
  81 suites, 1456 passing tests, four explicit local/platform skips; types/build
  and final firmware suite/self-test passed. See `docs/RELEASE-VALIDATION.md`.
- [x] Fix pending/duplicate/stale Run/Verify/Upload/Sim launches and native serial
  callbacks; bound callbacks/output and preserve normal UTF-8/Serial behavior.
- [x] Serialize and atomically save project configuration; preserve malformed,
  external and failed-save disk contents and report unsaved setting selections.
- [x] Reproduce and fix native Monaco tab-switch cancellation errors and 3D
  camera far-plane clipping; verify actual underside pin inspection after zoom.
- [x] Install and verify compatible dependency fixes: four direct updates and
  compatible transitives; hold pdf2json on its compatible 4.0 line. Final automated
  pass: 83 suites, 1466 passing tests, five explicit local/platform skips;
  types/build/firmware/self-test pass. Audit improves from 43 to 32, still blocked.
- [x] Reproduce and fix rapid rename/delete Explorer ghosts, stale directory reads,
  missing-root refresh errors and intermittent native Windows firmware shutdown;
  retain failing evidence and real regression cases.
- [x] Finish rebuilt save/conflict/watcher/editor/3D verification after compatible
  fixes; retain screenshots/reports. Whole-root native fault remains unverified
  because Windows blocked the fixture rename; store-level error cases passed.
- [x] Verify the separately approved electron-vite 4.0.1 migration, ESM tooling
  config and Node 22.20.0 CI alignment; retain CommonJS desktop/native externals.
  Types/full 83-suite regression/firmware checks pass under Node 24.12 and the
  exact portable Node 22.20 pin. Actual dev/rebuilt-production save, watcher,
  editor, native terminal/serial/PDF and 3D smoke pass; owned processes cleaned
  up. Audit remains blocking at 31; no runtime replacement or release.
- [ ] Continue the approved cautious dependency strategy by reviewing and verifying
  each major upgrade individually. Do not replace a
  runtime still used by the user's open Cortex window.
- [ ] Remediate/triage remaining audit findings: 31 total (19 high, 3 critical).
- [ ] Run the three-platform release workflow and validate real clean-install artifacts.
- [ ] Validate real hardware, advanced Git/conflicts, recovery and human/outside-team trials.
- [ ] Expand actual MCU/peripheral/electrical coverage; do not market inspection models
  as Teensy/ESP32/Pi CPU simulation or native Tinkercad/Wokwi engines.

## Markdown task execution (2026-10-10)

See `docs/TASK-AUDIT.md` for current tasks versus historical and future scope.

- [x] Exclude the renamed ESM tooling config from packages; actual electron-builder
  file-matcher regression fails before the fix and passes with application controls.
- [x] Propagate firmware cancellation through compiler/run processes; verify an
  already-cancelled request never launches and a live child stops with retained logs.
- [x] Bound debugger console text with the existing output-retention helper.
- [x] Isolate PDF parsing so a CPU-stuck parser cannot block the main-process timeout.
- [x] Preserve debugger watch/console state when changing sidebar tools.
- [x] Complete locally verifiable Explorer/editor keyboard and ARIA follow-ups.
  Actual native keys exercise nested tree navigation, context-menu focus return,
  manual tab activation and dirty Delete/cancel then Ctrl+S/close. This is not a
  complete accessibility audit.
- [x] Verify saved workspace tabs/expanded folders without overwriting unsaved data.
  Native visible-folder checks exposed a Windows separator mismatch; failing
  React/store/native receipts precede the fix. Five focused suites/87 cases,
  types/style/build and rebuilt actual expanded/selected/two-group disk restore,
  Reload and watcher checks pass. Full combined verification remains separate.
- [x] Verify persisted advanced optimization choices without losing custom values.
  Focused allowlist/persistence tests and actual native -O0/-O1 compiler arguments,
  executable markers, disk round-trip and visible -Ofast warning pass.
- [ ] Verify hardened renderer sandbox/navigation in native dev/production workflows.
- [x] Verify a fresh locked source installation in an owned temporary directory.
- [x] Verify bounded producer-to-renderer output delivery with stalled consumers.
  Actual native 16 MiB stdout with a 2000 ms renderer stall exits 0, retains
  295018 UTF-16 code units, reports omitted bytes and leaves the bridge responsive.
  Run-id reuse after a genuine reload also passes; no total-memory claim is made.
- [x] Verify bottom-panel fitting and dragging in a short native window.
  Native resize to 1000x650 and 110% zoom preserve the 640 preference while fitting
  around the editor; a real two-pixel drag and hide/show preserve the new 508
  preference. Genuine noisy-firmware failure details scroll internally, not the
  document. The full combined regression remains a separate gate.
- [ ] Finish combined verification of separately approved Vite 7.3.7 and its
  demonstrated Vitest config/typing/packaging migrations; keep Electron unchanged.
- [ ] Close the discovered manual release-script bypass of CI quality/audit and
  draft-only guards; verify exact-target rejection without real publication.
- [ ] Fix the native debugger Stop lifecycle failure: a disposed process's late
  exit must not overwrite idle or a new session; verify real Stop/restart after
  focused callback/command ownership regressions.
- [x] Reconcile stale capability/status documentation against actual source evidence.

Current checkpoint evidence: `f89dce0` desktop tests/security, `2d429fb` PDF worker,
`b9fca01` debugger state, `b1ca901` advanced optimization, `2d96c01` keyboard/ARIA,
and `7f508e5` saved sessions. The corrected combined pass covers 89 suites/1610
tests plus five existing explicit platform/local skips; types/build, CLI suite
and negative self-tests pass. Session/keyboard follow-up adds 165 focused passes
and zero type errors; native latest-snapshot checks remain in progress.

Actual desktop correct/broken/deleted-scenario-replay/fixed runs and live hanging
fixture Stop passed in an isolated project. Genuine built PDF-worker import and
termination passed with only the OS file picker substituted by an owned fixture;
the picker itself remains unverified. The [recorded WebM](../docs/demos/README.md)
passed full decoding, real seek/frame checks and visual pass/failure/fix inspection;
it predates the committed panel-height fix. Fresh locked source
installation/build/native terminal passed; its full suite also passed: 89 suites,
1610 tests and the same five existing skips on the archived `f89dce0` snapshot.
This fresh-install result does not substitute for verification of later source.
These statements are local evidence, not human trials or customer release approval.
