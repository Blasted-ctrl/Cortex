---
status: done
date: 2026-10-10
---

# Cortex production workbench integrity

## Context and contract

The user chose a written plan followed by implementation in this session. Preserve the current compact embedded-IDE design: editor in the center, project/debug tools on the left, optional AI/datasheets on the right, build controls above and diagnostics below. Improve usable space and keyboard operation rather than replacing it with a dashboard. This is one local Electron application with concurrent asynchronous main-process settings calls; no distributed service or multi-process configuration protocol is required.

Baseline is main `da1aee318de35b4ce321074ed18b37d56ec7ac87`, pushed to origin. All 50 tracked Markdown files were read across the main agent and three audit agents. Historical plans are not proof that their tasks remain unfinished. Current audit remains 17 findings (0 critical, 7 high, 10 moderate); release is blocked. Ubuntu CI for that exact revision passed compiler setup, installation, types, tests and build but failed dependency advisories. Windows CI and the firmware workflow completed with test failures; subsequent gates were skipped. Public Windows annotations identify datasheet workspace confinement failures. This remote regression is investigated separately and cannot be closed by a local green suite.

The governing constraints are `AGENTS.md` and `CONSTRAINTS.md`. Preserve user files, exact disk snapshots, existing secrets-redaction boundaries, all assertions/timeouts/skips, source provenance, and actual simulator limitations. Tests use only owned scratch projects/profiles; no hardware upload, provider credentials, customer Git changes or public release.

## Accepted findings

1. Settings writes can race and publish a cache entry before persistence succeeds. Apply serialization and staged atomic persistence following the existing project-configuration pattern, not a generic framework.
2. Valid stored horizontal dock widths can consume the editor on a smaller window. Apply measured fitting with unchanged saved preferences and drag from rendered sizes.
3. Recent-project opening is mouse-only. Apply native opening buttons and independent removal buttons, retaining appearance and failure reporting.
4. AI approval writes CRLF but records an LF disk snapshot. Apply exact persisted snapshot preservation; prove approval followed by a normal save through the native filesystem boundary.
5. Living readiness/stack/contributor summaries disagree with current source and verified evidence. Reconcile those summaries and record the complete Markdown audit and remaining queue without rewriting historical failures.

Checkpoint reviews also accepted four bounded follow-ups: report rejected settings saves without dropping the programmatic rejection; preserve newer or failed settings drafts; position notifications using fitted rather than saved dock widths; and prove malformed incoming settings patches cannot change disk/cache or leave staging files. The independent remainder review identified the generic text-input draft reset as pre-existing at the baseline: a successful earlier save can replace newer typing. Use local edit/submission revisions to distinguish clean external updates from acknowledgements of older input, including A-to-B-to-A edits. Stable field keys must also prevent a dirty input instance from migrating to a different setting when search results or categories change. These remain within the settings/layout integrity slices and do not authorize an API or dependency migration.

Native inspection caught a further file-integrity defect in slice 4: the controlled Monaco value contains the disk BOM, which the wrapper can insert as editable text. Typing at the start then moves that character into the body while the store restores another leading BOM. Keep raw disk snapshots intact; initial model construction must consume the raw file's one encoding marker, while subsequent controlled updates omit that marker. Stripping it before initial construction would make Monaco consume a second, intentional leading U+FEFF. Preserve that character and intentional interior U+FEFF, including typing/save round trips. A save acknowledgement must not reinterpret a newly typed leading literal as encoding metadata and remove it from a mounted editor. Track the mounted model's raw snapshot/marker provenance; an optional raw-snapshot mode on the existing updateContent action bypasses its legacy marker heuristic only for this encoding-aware editor. Keep default caller behavior and all existing tests unchanged; no new IPC or general concurrency framework. Add actual-component boundary regressions before the fix and require the native approval/type/save fixture to match its entire expected file, not merely start with a BOM. The earlier receipt's `passed: true` did not detect the two BOM byte sequences and is not final file-integrity acceptance.

Other source-derived findings stay explicitly queued: file-existence provenance for reviewed AI proposals; ownership of delayed Git-triggered tab reloads; library-documentation scope; bounded compiler diagnostics; More-tools keyboard navigation and keyboard splitters. Unsaved draft recovery needs a Restore/Discard and retention policy. Additional toolchain majors remain separate reviewed upgrades. Installers/signing, actual boards, teammate/outside-team trials and real credentials require external evidence. These are not marked complete by this pass.

## Pattern Survey

### Analogous Features

- `src/main/services/projectConfigService.ts:68` - Atomic settings-like persistence preserves unknown fields, stages and syncs a sibling file, rechecks the original bytes, then renames. Writes are serialized per physical project root at line 116.
- `src/main/services/fsService.ts:187` - Workspace saves similarly compare expected bytes before and after staging, preserve file permissions, and clean up only their own temporary file.
- `src/main/services/settingsService.ts:115` - Global settings currently merge a cached snapshot, update that cache before persistence, and directly overwrite JSON at line 158. Unlike project configuration, concurrent writes and failed-save cache state are not protected.
- `src/renderer/src/components/Welcome.tsx:124` - Recent-project rows support mouse activation; their clickable `div` lacks keyboard focus and activation. The independent Remove button must remain a separate action.
- `src/renderer/src/components/EditorArea.tsx:202` - Editor tabs use native buttons, explicit labels, focus-visible treatment, and keyboard navigation. `FileExplorer.tsx:144` provides the analogous roving-focus tree pattern.
- `src/renderer/src/lib/useBottomPanelLayout.ts:14` - Bottom-panel fitting observes available space, preserves the saved preference, and begins dragging from the rendered size rather than an oversized stored preference.
- `src/renderer/src/App.tsx:287` - Horizontal splitters still modify stored sidebar/right-dock widths directly; neither dock currently fits against observed workspace width.
- `docs/TASK-AUDIT.md:159` - Current acceptance status distinguishes verified work from installer, hardware, signing, and human-validation gates. Some living summaries still conflict with it: `PRODUCTION-READINESS.md:12` retains 25 findings, and `TECH-STACK.md:8` retains the old Vitest 2/Vite 5 description.

### Reusable Utilities

- `src/main/services/settingsService.ts:110` - `getPublicSettings` - Existing credential-redacted renderer response; persistence changes should preserve this boundary.
- `src/main/index.ts:561` - Local guarded `handle`/`on` registration - Existing trusted-renderer IPC convention, including settings updates.
- `src/renderer/src/store/useStore.ts:791` - `LAYOUT_LIMITS` - Shared stored-width bounds; setters at lines 1546-1556 persist preferences.
- `src/renderer/src/lib/useBottomPanelLayout.ts:8` - `fitPanel` - Existing preference-versus-available-space calculation, currently local and vertical-specific.
- `src/renderer/src/components/Splitter.tsx:22` - Pointer-capture drag handling - Existing horizontal/vertical splitter behavior and enlarged hit area.
- `test/reactHost.ts` - `createHost` / `invoke` - Existing actual-component interaction harness used by accessibility and panel-fitting tests.

### Convention Anchors

- Main-service persistence: `projectConfigPersistence.test.ts` uses owned temporary directories, deferred operations, and actual filesystem failure/concurrency controls; global settings currently have only the narrower `settingsDefaults.test.ts` coverage.
- Renderer state: `useStore.ts:2453` updates public settings only after successful IPC completion; layout preferences remain stored independently of rendered fitting.
- Accessibility: `editorAccessibility.test.ts` and `explorerAccessibility.test.ts` exercise actual components and store behavior, rather than relying solely on source-text or CSS checks.
- Geometry: `bottomPanelLayout.test.ts:74` tests constrained space, resize recovery, tiny windows, and dragging from actual displayed dimensions.
- Documentation: dated failures in `RELEASE-VALIDATION.md` remain historical evidence; current stack/readiness summaries should agree with the latest dependency and task ledgers. `CONTRIBUTING.md:51` still recommends direct `ipcMain.handle`, unlike current guarded registration.

### Proposed Alignment

Follow the existing atomic, serialized service-persistence pattern and credential-redacted IPC response without introducing a generic configuration framework. Follow native keyboard controls for recent projects and the bottom panel's observed-space/rendered-drag pattern for horizontal docks, preserving saved preferences and the current embedded-IDE layout. Reconcile living documentation with current evidence while retaining historical failures and explicitly unverified release boundaries.

## Implementation slices

### 1. Settings persistence integrity

Read `src/main/services/settingsService.ts`, existing atomic persistence in `projectConfigService.ts`, its integration-test patterns, and the actual settings IPC/store callers. Add `test/settingsPersistence.test.ts` (new) covering simultaneous patches, committed-cache visibility, failures without truncation or cache poisoning, subsequent recovery, cold reads, and public key redaction. Capture an owned allowlisted patch and nested arrays before queuing. Serialize patches in invocation order; merge against the last committed value inside that sequence. Coalesce or fence cold initialization so a deferred old read cannot replace a committed cache entry.

Stage, sync, and rename a unique sibling file, preserve existing permissions, and clean up only that file. Publish cache only after commit, returning that operation's own redacted snapshot.

Retain the existing key-encryption/fallback policy and public API. Preserve unreadable stored credentials rather than deleting them on an unrelated update. Strictly read the write baseline and compare exact bytes before replacement; do not silently overwrite an unreadable/corrupt existing settings file. Preserve startup fallback behavior and surface persistence failure without echoing private key material.

Acceptance: overlapping independent patches both persist; a failed write leaves the prior file and committed cache intact; later writes still work; renderer responses never contain the private key. New settings files use restrictive mode 0600; existing restrictive modes survive replacement. Corrupt/nonobject/non-UTF8 files, EACCES and an external edit during staging are explicit negative cases.

### 2. Horizontal workbench fitting

Read `App.tsx`, `SideBar.tsx`, `AiPanel.tsx`, `DatasheetsDock.tsx`, `Splitter.tsx`, `useBottomPanelLayout.ts`, layout limits/setters, and `bottomPanelLayout.test.ts`. Add `useHorizontalPanelLayout.ts` and `horizontalPanelLayout.test.ts` (new), reusing the observed-space convention. Calculate widths from the available inner workbench space, accounting for its gaps/padding/splitters, visible docks and a 320px editor minimum where available. Fit without persisting automatic reductions; normalize invalid preferences against existing limits. If the combined dock minima cannot fit, displayed docks may shrink below their saved preference limits to preserve the center; saved preferences remain unchanged. Feed measured widths to the existing dock wrappers and drag from the actual fitted size. Tiny windows must not create negative sizes or hide the central area behind fixed docks. Retain existing vertical fitting and tests; observer fixtures must identify their actual target rather than assume a single observer.

Acceptance: measure the inner workbench rectangle, excluding both 48px outer rails; deduct 16px padding and 17px per visible dock (two 8px gaps and a 1px splitter). Preserve a 320px center and proportionally fit visible dock preferences into the remainder. At 1366px outer width, inner width 1270px and preferences 560/620, the dock budget is 900px: displayed widths are approximately 427.119/472.881px and center is 320px. At 900px outer width, budget is 434px and displayed widths are approximately 205.966/228.034px. Shrinking/growing restores saved preferences; one or neither dock works; AI/datasheets view switches work; the first drag after fitting is continuous; all six existing bottom-panel cases retain their outcomes.

While constrained, an explicit divider drag may update both dock preferences to preserve the requested displayed ratio. Scale that pair into existing stored limits; integer setter rounding permits less than 0.5px display quantization, not a multi-pixel jump. Automatic fitting changes neither preference.

### 3. Keyboard recent projects

Read `Welcome.tsx`, `test/reactHost.ts`, and existing actual-component accessibility tests. Add `welcomeAccessibility.test.ts` (new). Render a native button for opening with its full project name/path available to assistive technology and focus-visible treatment; keep removal a sibling button visible on keyboard focus. Preserve existing error notification and retry behavior.

Acceptance: Tab reaches project opening and removal independently; Enter/Space opens; removal does not open; opening failure reports the problem and leaves the recent entry available.

### 4. Exact AI-approved disk snapshots

Read complete `approveAgentEdit`, normal save queue and `fsService.writeFile` blocks, plus `agentEditApprovalStore.test.ts`. Preserve a disk BOM even when the approved new-content proposal omits it; derive this from the reviewed disk bytes, not from guessed model behavior. Store the exact bytes written as the saved disk snapshot, including BOM/CRLF. Retain diff normalization for matching and display, not native compare-and-save baselines. Extend actual approval/save regressions through the native filesystem boundary in an owned directory; do not weaken existing typing, conflict, workspace and absence guards.

Acceptance: CRLF and BOM/CRLF approval followed by typing and ordinary saving succeeds; a genuinely external edit is still refused without overwriting it. Initial model construction receives raw file text; later controlled updates omit its single encoding marker. Store/disk snapshots preserve that marker and intentional subsequent leading or interior U+FEFF characters after typing/save. Native typing at the first character of the ordinary BOM fixture and saving must produce the exact expected file with one BOM, no newly inserted interior BOM and preserved CRLF.

### 5. Current documentation and queue

Reconcile current `PRODUCTION-READINESS.md`, `TECH-STACK.md`, `CONTRIBUTING.md`, relevant feature documentation and `TASK-AUDIT.md`/`tasks/todo.md`. Record all 50 audited Markdown paths and ranked remaining work, separating historical completed items, implementable fixes, policy choices and external validation. Correct other small source-confirmed stale statements without claiming full C++26 support, complete library dictionaries, current-machine LSP installations, or successful remote jobs that have not completed successfully.

Acceptance: current summaries agree with verified dependency versions and audit status, contributors use guarded IPC conventions, new behaviors and limitations are documented, no historical failure record is erased.

## Verification

Start with actual failing regressions, then rerun after each fix. Perform a bounded deliberate regression and restore it to prove the relevant new assertion detects the failure. Preserve all existing tests, timeouts and explicit skips. Use pinned Node 22.20.0 and the installed toolchain; no dependency upgrades in this plan. Run focused suites, types, full tests, build, firmware repeatability/self-test and an advisory benchmark after the final source state is stable. Record the still-failing dependency audit separately.

Native UI smoke uses a unique owned profile and scratch project on D:, current Electron with sandbox/context isolation intact, actual preload IPC, and an owned CDP session. No customer project/profile or existing app process is touched. Observe keyboard reopening/removal/failure; dock fitting at narrow/wide dimensions with AI and datasheets; drag continuity; editor, simulator and theme controls still present. Preserve saved preference values across automatic fitting, capture screenshots and logs, and clean up only exact owned process identities. Unit tests are not reported as native keyboard proof. Remote CI observations remain tied to their exact revision and timestamp.

## Ready criteria

The five slices are a bounded integrity/usability checkpoint, not competitor parity or a complete production release. Two internal reviews and an independent read-only Codex CLI review completed. Accepted clarifications cover shared cold initialization, captured patches, strict write baselines, restrictive modes, exact geometry and disk-derived BOM preservation. They refine the same five slices rather than introduce a different architecture or scope. No additional review round is needed after resolving these concrete findings. The self-improvement check found no new durable instruction absent from the existing project constraints; no skill or instruction file is changed. The user explicitly requested implementation after the written plan, so this artifact does not create an additional approval pause.

Completion on 2026-10-11 includes the discovered Monaco encoding correction,
59 final editor/approval/persistence cases, types/build, 107 suites with 1939
passes and five unchanged skips, repeated firmware/self-test, an advisory
benchmark and fresh native exact-byte/UI acceptance. Earlier failures remain
recorded in docs/RELEASE-VALIDATION.md. The reviewed file-ownership plan covers
the next two local queue items; dictionary/diagnostic/keyboard work and all
external release gates are not completed by this plan.
