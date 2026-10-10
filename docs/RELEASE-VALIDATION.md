# Customer-release validation evidence

Started 2026-10-09; updated 2026-10-10 after tooling verification. This is local
Windows evidence, not release approval, a claim
of zero edge cases, or proof that every supported platform/board works.
The evidence below was collected before the local source checkpoint commits;
no release was published. Verified source changes are committed on `main` under
the user's standing instruction, without automatic pushes or releases.

## Pre-update functional baseline

| Check | Evidence |
|---|---|
| `npm test -- --maxWorkers=4 --minWorkers=1` | 81 suites passed; 1456 tests passed, four explicit local/platform skips |
| `npm run typecheck` | Both process type checks passed |
| `npm run build` | Desktop and bundled-tools production build passed |
| `npm audit --audit-level=high` | Blocking: 43 advisories, including 27 high and 3 critical |
| `npm run firmware:test` | Final shim: all three supported Uno scenarios passed, 29 assertions |
| `npm run firmware:selftest` | Final shim: broken shutdown assertion and independent hang watchdog caught |

New failure-path tests first reproduced delayed-save/stale-run launches, concurrent
configuration corruption, failed-save loss, pending-start cancellation, unbounded
simulation output, and unsupported net feedback before their fixes or warnings.
Native filesystem/Git tests use owned temporary projects. Serial and cancellation
tests use controlled mocks; they are not hardware tests. Host-compiled Arduino
tests exercise the actual C++ shim, not fake firmware outputs.
The four skips are three CI-only compiler-prerequisite guards and a POSIX
case-sensitive filename check on Windows. The actual compiled shim cases ran.
These results precede the separately tracked cautious dependency-update pass.

## Compatible-update verification

The user selected compatible fixes first, then individually reviewed majors.
Four direct packages and compatible transitive resolutions changed; the PDF
parser was held at 4.0.3 after its newer minor exceeded the runtime requirement.
An independent review confirmed installed versions, original parent ranges,
runtime/CI compatibility and unchanged native modules. Audit fell to 32 findings
(3 critical, 19 high, 10 moderate), so customer release remains blocked.

The first post-install full run exited 1: 80 suites passed and one compiled
sketch intermittently failed after correct stdout. Repeating the unchanged
executable reproduced Windows 0xC00000FD exits. Removing the detached reader
or delaying exit changed the outcome; untying `cin` did not fix it. A scoped
Windows termination experiment passed 1000 launches. The exact native exception
frame was not captured, so this is a verified lifecycle mitigation, not proof
of a specific upstream DLL defect. The new repeated-launch regression first
failed; targeted shutdown/output/stop/unsupported-API suites then passed
42 tests with four local CI-only guards skipped. The production helper also
preserves failure codes and flushed diagnostics; virtual mode has no reader.
[Microsoft termination guidance](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-exitprocess).

Actual desktop checks exposed a second, pre-existing timing bug: rapid external
rename/delete left a ghost Explorer entry because write-finish delay suppressed
both the destination's pending add and unlink. Genuine IPC, disk contents and
the editor store confirmed it. Native watcher and stale-read regressions failed
before fixing metadata event delay and refresh ordering. Earlier failed reports
are retained separately from passing reruns. Missing-root refresh errors also
preserve open dirty buffers and the last known tree, with actionable restoration
advice; stale/superseded errors are ignored.

Final post-update automated gate:

| Check | Result |
|---|---|
| Full regression suite | Exit 0: 83 suites, 1466 passing tests, five explicit local/platform skips |
| Type checks | Exit 0: both processes |
| Desktop/tools production build | Exit 0 |
| Supported firmware suite | Exit 0: three scenarios, 29 assertions |
| Broken fixture and hang watchdog | Exit 0: both expected failures caught |
| Dependency audit | Exit 1: 32 findings; 3 critical and 19 high remain blocking |

The five skips are four CI-only compiler guards and one POSIX filename check;
the actual compiler/shutdown tests ran. The new shutdown regression launches the
native process 500 times without retries and separately verifies error code 2.
The rebuilt desktop passed exact Save, external-edit conflict/confirmed Reload,
automatic external create/rename/delete, the identical rapid watcher regression,
and 30 editor-switch rounds with zero renderer exceptions. A reversible whole-root
fault remains unverified: Windows returned EBUSY on both owned-fixture rename
attempts, so the directory was never moved. The watcher was restored, pending
edits saved and original bytes restored; this blocked setup is not a product
failure or a passing missing-root fault. Store-level missing-root cases passed.
Latest rebuilt 3D visual verification also passed: actual top/underside geometry,
native pan/zoom, pad 48-54 and GND mesh clicks with expected function/voltage
details, and zero renderer exceptions. Readable captures require zoom; the
fit view remains dense and geometry is not CAD-accurate. New artifacts use the
`dependency-patch-verified-*` prefix in the same owned temporary artifacts
directory; earlier watcher failures remain separate.
The owned preview then closed normally with clean buffers/circuit; all five
observed descendants exited and its debugging listener was released. The user's
normal IDE and the unrelated packaged preview were left running. The retained
save-error toast in the pin screenshot is the intentional conflict notification,
not a new post-recovery failure.

The narrow Monaco build-time backport matches the upstream delayed-highlight
rejection handlers. Review/removal is required when an editor upgrade changes
those calls. Ordinary errors still surface; no global cancellation filter or
disabled highlighting was used. References: [reported upstream bug](https://github.com/microsoft/monaco-editor/issues/4859),
[upstream source](https://github.com/microsoft/vscode/blob/main/src/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.ts).

## First approved tooling major: electron-vite 4.0.1

The user separately approved this migration after the compatible pass. Exact
current manifests/configuration were backed up outside the dirty workspace;
only electron-vite changed among existing installed packages. Its esbuild 0.25.12
dependency was added. Electron 33.4.11, Vite 5.4.21, Vitest 2.1.9 and the native
and PDF modules are unchanged; install scripts were not run. Independent review
confirmed lockfile/installed-tree agreement, peers, unchanged package-manager
guards and byte-identical tooling config under its new `.mts` filename.

General CI now uses the existing exact Node 22.20.0 pin. Source development
requires `^20.19.0 || >=22.12.0`; the initial local checks used Node 24.12.0.
A separate official portable Node 22.20.0/npm 10.9.3 copy was downloaded to an
owned Temp directory and SHA256-verified against the official release manifest.
With a process-local PATH, types, tools build, all 29 firmware assertions,
broken/hang self-tests and the full 83-suite/1466-pass/five-skip regression also
passed (214.43 seconds for Vitest). Each gate recorded unchanged manifest/lock
hashes; no global install or `.npmrc` was created. This exercised the installed
tree, not a fresh `npm ci`; actual remote CI remains a separate release gate.
Main/preload output
is still CommonJS, with native/PDF dynamic imports external. The production
renderer entry hash remains `index-7JHEgUxf.js`.

| Check | Result |
|---|---|
| Full regression suite | Exit 0: 83 suites, 1466 passes, five explicit local/platform skips |
| Both type checks | Exit 0 |
| Desktop/tools build | Exit 0; real `.mts` config loaded |
| Firmware behavior suite | Exit 0: three scenarios, 29 assertions |
| Broken fixture/hang watchdog | Exit 0: both expected failures caught |
| `npm audit --audit-level=high --json` | Exit 1: 31 findings; 3 critical, 19 high, 9 moderate |

Each automated npm gate had a separate 15-minute host watchdog. Logs/results
and audit JSON are retained locally under `.cortex/release-smoke/ev4-*`.
The existing style scanner was extended to `.mts` so the config rename does not
remove coverage. An owned temporary `.mts` containing a deliberate violation
failed the expected assertion and named that file; removing only the fixture
restored all four style cases. No assertion was disabled or suppressed.

Separately, the development smoke helper initially generated its third-party
dependency cache inside the source tree, causing an unchanged style assertion
to catch upstream font-encoding tables. The failed logs were preserved; only
that owned generated cache moved to the owned Temp fixture and the helper now
keeps its cache outside the repository. All four style cases pass again, with
no new ignored directories or relaxed rules.

Actual isolated development and rebuilt production checks both pass. Development
loads the real `.mts` config through an ignored wrapper changing only output/cache
paths and loopback ports; production uses actual `preview --skipBuild` against
the successful production build. That preview does not reload the config itself.
Each mode passes real disk Save, external-conflict preservation/Reload, automatic
create/rename/immediate-delete watcher updates, and 30 Monaco switch rounds with
zero renderer exceptions. Served development source confirms both cancellation
handlers. Native terminal echo/normal exit, actual SerialPort import/class/list
and PDF `loadPDF(file)` text parsing also pass; no physical port was opened.
Top/underside, native zoom and Teensy pads 48-54/GND were inspected and captured.
Fit-scale labeling remains dense and the model is not CAD-accurate.

Earlier helper-only expression/selector/soft-wrap failures and the parser's pooled
buffer probe are preserved separately. Controls confirmed the PDF fixture's xref
and text were valid; matching Cortex's existing `loadPDF` API passes inside
Electron. The buffer-only defect is consistent with the upstream
[pdf2json report](https://github.com/modesty/pdf2json/issues/427), not a failing
application import. The native OS PDF-picker UI remains unverified. The terminal
helper now reports unavailable coverage as a failure, not successful validation.

Both owned groups closed normally, with all observed descendants exited and
ports 9342/9344/9742 released. Existing user/packaged instances were untouched.
Retained logs include the deliberately rejected Save, PDF fake-worker warning and
Three context-disposal information. Development also reports a missing Monaco
source map and development CSP warning; no errors were suppressed. Startup
observations (65.287 seconds under concurrent load for dev, 7.253 for production)
are not benchmarks or before/after comparisons.

Reports and inspected PNGs are retained in the owned Temp artifacts directory
under `evite-dev/` and `evite-production/`; pinned Node logs/results are in the
separate owned `cortex-node22-*` Temp directory. No runtime was replaced and no
user process was terminated. This functional migration does not clear the audit
or other customer-release gates.

## Markdown task checkpoints and second approved tooling major

The local task pass added the shared desktop firmware runner/results/replay,
terminable PDF parsing, debugger tool-state preservation, Explorer/tab keyboard
semantics, bounded workspace-session metadata and advanced optimization choices.
The recorded [firmware demonstration](demos/README.md) was fully decoded, checked
with real seek/frame callbacks and visually inspected at the pass, failure and
fix chapters. Its immutable `f89dce0` production snapshot predates later panel,
output-delivery and tooling changes; it is not proof of those later changes.

A normal fresh source install of archived `f89dce0` passed `npm ci`, types,
build, 89 regression suites (1610 passes, five existing explicit skips), the
firmware suite and negative self-tests using Node 22.20.0/npm 10.9.3. Its genuine
Electron/native-terminal startup passed in an owned profile. This is source
installation evidence, not a signed installer or fresh verification of later
source. Artifact hashes and playback/source details are retained with the demo
and local receipts; human trials remain open.

Later checkpoints add bottom-panel fitting/dragging (`6b55381`) and acknowledged
build/run output delivery (`e8cd435`). Six actual React geometry regressions
failed before the panel fix and passed afterward. The output slice passed 186
focused cases and independent review. Controlled stalled-consumer workloads bound
console packets and retain explicit per-stream omitted-byte markers; full
structured compiler diagnostics and firmware reports remain separate. See the
[measured transport ledger](ARCHITECTURE.md#bounded-buildrun-console-delivery).
These measurements are not Chromium memory measurements or host speed claims.

The separately approved Vite 7.3.7 step preserves Electron/native binaries and
Vitest 2's compatible nested Vite 5. The actual ESM loader/type incompatibilities
were reproduced before migrating `vitest.config.mts`, covering it in the ordinary
Node typecheck and excluding both tooling configs from packages. Four focused
suites/56 cases, types and the production desktop/tools build pass.

The first full post-upgrade regression is **not a pass**. Its independent host
watchdog stopped the owned test tree, with a reported 3,832,595 ms elapsed and
an incomplete serial suite. Windows System events record Button/Lid sleep at
01:30:48 local, then hardware-clock synchronization advancing 3,625,867 ms at
02:31:16, followed by hibernation. This explains the unusually long elapsed
durations; it does not turn incomplete tests into passes. Original logs/results
remain under `.cortex/release-smoke/md-vite7-final-*`. The unchanged isolated
serial suite rerun passes all eight applicable cases with its normal CI-only
prerequisite check skipped (33.08 seconds). The full-suite rerun, firmware checks
and final native checks remain pending.
No test timeout, assertion, skip policy or dependency guard was weakened.

The subsequent awake four-worker run also exits 1, for a different reason:
96 suites pass, but two real desktop firmware cases exceed their existing
90-second and 60-second test deadlines (1684 passes, two failures, five normal
explicit skips). The serial suite passes in this run. Its complete receipt is
`.cortex/release-smoke/md-vite7-awake-tests.log` and result JSON; the watchdog
itself did not fire. This run is not credited as a successful upgrade gate.

The unchanged desktop suite then passes all 11 cases in isolation (187.76
seconds): default/report preservation 66.498 seconds, failure/replay/fix 37.120,
cancellation/replay 50.632 and linked-project admission 27.495. Original deadlines
remain 90/60/90/30 seconds. Independent lifecycle review finds no nonsettling path
in the reviewed run/Stop/process guards. The contention hypothesis is stronger:
the four-worker command also permits five concurrent native compiler cases inside
one worker. A within-file scheduling bound is being validated against the full
gate; no compiler cache, higher deadlines, user-process termination or antivirus
changes are used. These observations do not prove that Vite caused a slowdown.

The within-file-only bound is insufficient: the third full regression still
exits 1 with 96 passing suites, 1685 passing cases, two desktop-firmware deadline
failures and the same five explicit skips (324.49 seconds). Its independent
watchdog does not fire. Receipts remain under
`.cortex/release-smoke/md-vite7-bounded-*`; this candidate is not credited as a fix.
A serial native-suite control then passes 31 applicable cases in two files,
with one existing explicit skip (251.83 seconds). All 11 desktop cases pass;
default/report preservation takes 31.287 seconds, failure/replay/fix 27.509,
cancellation/replay 44.798 and linked-project admission 11.718. No compiler
prerequisite, deadline, assertion or fixture execution changes. Receipts remain
under `.cortex/release-smoke/md-vite7-serial-control-*`.

The next controlled configuration serializes files with `fileParallelism: false`
alongside `maxConcurrency: 1`. Official Vitest 2 semantics and independent source
review confirm that the existing `--maxWorkers=4 --minWorkers=1` command then
resolves to one effective worker with file isolation intact. It is not
`singleFork`/shared-global execution, and explicit races inside individual tests
remain unchanged. The checked-in configuration guard fails before adding the
file setting, then all 24 guard cases pass. The full serial gate was pending;
its independent 15-minute watchdog and all test deadlines remain unchanged.

The full serial gate now exits 0: all 97 suites pass, with 1688 passing cases
and the same five existing explicit platform/CI skips (1693 total). Vitest takes
545.91 seconds; the independent parent records 549522 ms without a timeout.
All 11 desktop firmware cases pass within the original 90/60/90/30-second
deadlines: 29.760/21.607/21.069/6.905 seconds respectively. Receipts remain under
`.cortex/release-smoke/md-vite7-serial-final-*`. Earlier failing runs are not
discarded or reclassified. Both typechecks then pass (48783 ms). The firmware
suite passes all nine repeated runs with identical per-scenario traces (45790
ms); its 29 assertions per three-scenario suite run three times. Negative checks
catch the broken shutdown assertion and stop hanging firmware as a runner error
(26818 ms). These CLI reports record Node 22.20.0. A ten-run benchmark with two
warmups also passes under Node 22.20.0, with identical traces and a 42.16 ms host
median; its baseline is incompatible because workload/shim and host Node differ.
These observations are not a before/after speed comparison. The first benchmark
invocation used host Node 24.12.0; both receipts remain separate. The verification
helper now sets its owned child's PATH to the selected portable Node. Latest
receipts use `md-vite7-node22-final-bench-*`; other serial-final receipts retain
their original prefix. Final native and fresh-source acceptance remain open.

Actual native reopen reveals a separate Windows restoration defect: forward-slash
saved expansion/cache keys do not match backslash Explorer nodes, so a folder is
visually collapsed despite its saved expanded metadata. A metadata-only assertion
was insufficient; actual `aria-expanded` and visible descendants are required.
The unchanged immutable build reproduces `aria-expanded=false` and missing
nested rows in a visible/focused window with no renderer exception. Both new
React/store regressions fail first; five focused suites then pass all 87 cases,
including POSIX identity controls and collapse/reopen stale-read ownership. Types
pass (34424 ms), style passes all four cases, and the rebuilt production/tools
build passes (145504 ms). The renderer is `index-BS3X1PrX.js`, SHA256
`27a8ae3a3d2400770a18c066a10aee7227a982ebcb2cf67cc77974ceca4ae4bf`;
main/preload hashes remain unchanged. Actual rebuilt native reopen passes in
2.44 seconds: both folders are visibly expanded, the selected child is visible,
two editor groups read current disk bytes, and explicit Reload plus automatic
create/rename/immediate-unlink watcher updates work. The missing-file admission
control is retained from the earlier reopen; later metadata already omits it.
The before/after screenshots are personally inspected. Owned native RED processes
close normally with their listener released; other user instances are untouched.
This is a separately verified session checkpoint, not a claim that its combined
regression or all final desktop tasks have finished.

Final native editor keyboard validation also exposed a 5-by-5-pixel Monaco view
inside a full-size selected tab pane. The unchanged-build discriminator measures
the actual mount at 879.67-by-85 pixels, a valid live model, visible CSS and an
ordinary nonminimized native window, but Chromium reports the document hidden;
its screenshot request also times out. An ordinary show/focus of only the owned
window changes the document to visible, restores the inner editor to 880-by-85
and permits a screenshot showing readable code. No resize, forced editor layout
or source patch is used. This supports native test-window occlusion/frame
scheduling, not the initial unproven wrong-observer-target diagnosis. Subsequent
render checks require a visible owned window. Failing evidence and the
focus-only control are retained in the owned `cortex-md-desktop-*/production`
artifacts; neither assertions nor helper deadlines were weakened.

The fresh 2026-10-10 registry audit exits 1: 31 findings (3 critical, 19 high,
9 moderate). Its Vite findings point only to the retained Vitest/vite-node Vite
5.4.21 copies, not root 7.3.7. `npm ls --all --json` exits 0. Independent checks
confirm unchanged manifests, six npm configuration paths, Electron executable
and renderer bundle before/after those read-only commands. Receipts are in the
owned `cortex-post-vite-audit-*` Temp directory. The audit remains release-blocking.

## Final native follow-ups after Vite and session fixes

An owned production copy of the rebuilt session checkpoint passes actual
Explorer tree keys, editor tab focus/activation and dirty-close recovery. The
keyboard control puts tabs in the same editor group through the existing layout
action before testing manual focus; focusing a different group legitimately
changes its active file. No product assertion is weakened for that setup.

Actual compiler sinks use `-O0` and `-O1`, with distinct executable output markers,
exit 0, saved `-O1` settings and a visible `-Ofast` behavior warning. A fresh
process reopens the expanded folders, current disk-backed tabs/groups and saved
optimization, while excluding a freshly deleted tab. Genuine Reload permits
another successful `run-1` after the previous `run-1` completes. An earlier
immediate post-reload click did not admit a run and lacks a hit-target snapshot;
that inconclusive receipt remains separate from the visible, focused, hit-tested
positive control.

A real 16 MiB stdout workload stalls the renderer for 2000 ms. It exits 0,
retains 295018 UTF-16 code units and displays an omission marker for 16482401
stdout bytes and 29 stderr bytes; the genuine bridge remains responsive. This
proves bounded delivery/retention behavior, not total RSS or Chromium heap use.
Structured compiler diagnostics remain a separate unbounded-memory path.

Native panel checks preserve the 640 preference while fitting at 1000x650 and
110% zoom, leaving approximately 120 CSS pixels for the editor. An actual
two-pixel drag stores 508; hide/show retains it. A genuinely compiled broken
firmware fixture produces 68419 stdout bytes and the expected shutdown failure
at 480 ms. Its saved report and UI agree; the detail region scrolls from 7470 to
9070 within 17151 pixels of content and a 312-pixel viewport, while document/root
scroll remains zero. The inspected screenshot shows the failure's reproduction
configuration, not a synthetic preloaded report. Built PDF parsing also succeeds
and terminates its worker; only the OS picker is substituted with an owned file.

Actual GDB 15.2 pauses at the real breakpoint on line 5, shows `localValue=7`,
evaluates Watch `counter=41` and Console `counter+1=42`, and preserves drafts and
history across sidebar changes. However, Stop kills the child and then a late
exit changes the renderer to Exited instead of Idle. This genuine failing
receipt is retained and requires a service lifecycle fix plus native recheck;
successful Watch/Console controls do not waive it.

Native WebGL clicks inspect each Teensy underside pad 48-54 and an independently
reframed GND mesh with readable Ground reference details. Zoom is still needed
for readable stylized labels. Screenshots and exact receipts are in the owned
`cortex-md-desktop-*/production/artifacts` directory, including
`latest-ui-report.json`, `latest-native-output-burst.json`,
`native-reloaded-run-id-control.json` and `md-production-pin-inspection-report.json`.
These screenshots were personally inspected. Owned windows and captured children
close normally and release port 9342; the unrelated user instance is untouched.
Combined later-source, debugger-fix, dev/HMR and fresh-install gates remain open.

### Debugger lifecycle implementation and native control

Actual-service fake-MI regressions reproduce disposed output/exit/error,
initialization/evaluation settlement, late frame results and compiler ownership
races before the fix. Fourteen lifecycle cases plus the unchanged parser and
style checks pass (32 total); types and the production build pass. That build's
main SHA256 is `737b8c172df523420d3b834cb8ed7300f839675d27cb28835ac57c84ecd9b548`.
Its actual native three-session control passes in 15.23 seconds: each Stop waits
for the exact GDB child to exit before requiring Idle, restart clears old Console
results/drafts, and project switching clears prior Watch/Console state. The
inspected screenshot and `gdb-native-stop-restart-project-green-main737b.json`
retain this precise pre-drain-correction build boundary.

Independent review then finds an introduced natural-exit output-tail regression:
Node can emit exit before stdio closes. A new actual-service case fails before
the correction, then passes with all original controls. Command settlement stays
at exit/error while separate exact-child output ownership lasts until close;
late async records cannot revive the session, and Stop/supersession mutes it.
All 33 lifecycle/parser/style cases and node types pass, with watchdogs unused.
See Node's [exit/close contract](https://nodejs.org/download/release/v22.20.0/docs/api/child_process.html#event-exit).
Receipts are in owned `cortex-debug-lifecycle-*`, `cortex-debug-final-checks-*`
and `cortex-debug-drain-*` Temp directories. The final combined build/native
recheck must include this correction and the separately pending AI-approval fix.

## Manual publication guard follow-up

Final inspection found that the old `npm run release` invoked electron-builder
without CI's quality/audit and draft-only guard. The replacement accepts no
forwarded overrides, pins the repository/version/draft policy, runs CI-prerequisite
tests and an explicitly dev/optional-inclusive blocking audit, then performs
bounded release checks and passes an immutable credential-free configuration
snapshot to the publisher. Default distribution commands disable publication.

The legacy-policy and lookup-drift/list/snapshot regressions fail before their
fixes. All 84 release-guard cases pass after the final environment hardening,
with an independent watchdog unused (7032 ms). Original 24 cases are retained.
Injected command/API fixtures prove failed gates, signals, published/alternate
tags, malformed/network responses, source drift and cleanup outcomes; they do
not run a real release or actual quality-check children. Actual installed
electron-builder 25.1.8 CLI normalization, `Packager.validateConfig`, schema and
GitHub publisher construction confirm the snapshot excludes a malicious owned
live platform publisher and preserves project/output/hook bases, draft mode and
the pinned version/token. The publisher's lazy network lookup is not activated.
The initial direct `getConfig` proof modeled an inherited merge incorrectly;
that failing harness receipt is retained separately from the corrected exact
Packager path. Node syntax and scoped whitespace checks pass.

Receipts are in the owned `cortex-manual-release-*` Temp directory. Instructions
and bounded lookup/direct-invocation limits are in
[production readiness](PRODUCTION-READINESS.md#packaging-and-manual-publication).
A separate actual read-only audit with the same dev/optional include flags exits
1 in 28579 ms and still reports 31 findings (3 critical, 19 high, 9 moderate);
its independent watchdog is unused. The receipt is
`.cortex/release-smoke/md-manual-final-auditAll-*`. No release was published.
The blocking audit and all-platform, signing, hardware and human validation
remain required.

## Reviewed AI edit approval follow-up

The original approval path allowed overlapping approvals and stale reads/writes
to replace newer editor or disk contents. Actual-store deferred regressions
first fail 22 cases with four positive controls. Additional failing controls
cover a tab opening during the missing-file check and two distinct proposals
targeting the same normalized Windows path. The fix locks before reading,
checks exact proposal/project generation ownership after awaits, refuses
non-text or unreadable files, and passes exact raw expected disk bytes (or null
for a confirmed absent new file) to the existing confined write API.

All 31 approval cases and unchanged persistence/reset/diff/tool/style neighbors
pass: 171 cases in six suites, 8.58 seconds, with the independent watchdog
unused. Renderer types and scoped whitespace checks pass. Independent review
finds no qualifying issue. Receipts are in owned
`cortex-agent-approval-final-green-mkml9V` and the retained RED Temp directories.
A separate initially mis-sequenced fixture waited on its own deferred read and
hit its harness watchdog; it is not credited as a product failure. No deadline,
assertion or existing skip was relaxed.

The temporary subscription protecting a closed/reopened tab is released on all
settlements. Already-dispatched native writes cannot be undone by Reject or
project switching; late UI effects are suppressed. The native comparison is not
atomic CAS, and an absent unopened empty-old-content proposal cannot distinguish
new creation from a formerly empty deleted file. These tests do not call a model
provider. Genuine Electron approval controls and final combined gates remain
separate; [AI assistant usage](AI-ASSISTANT.md) records the supported contract.

## Native desktop checks

The desktop used an isolated Electron profile and a temporary laptop project,
not the user's open IDE/profile/repository. Actual mouse/keyboard/native API
interactions and screenshots established:

- Explorer creates a real file; editing and Ctrl+S save exact editor bytes.
- A successful clean-window close is the control for the failure test. Deleting
  an owned parent directory then trying a normal window close preserves the
  dirty buffer and window. Restoring the directory permits save and recovery.
- An external disk edit is not overwritten by Save. The newer disk file and
  unsaved editor text both survive; confirmed Reload adopts disk contents.
- Close Folder returns to Welcome; its recent-project entry reopens the folder.
- Git initialization, staging, commit and clean status work in a disposable local
  repository. Those desktop tests did not commit, push or initialize Cortex itself;
  implementation checkpoint commits are a separate source-maintenance step.
- Uno and Teensy top, underside and reset display actual WebGL board geometry.
  The camera far-plane regression was reproduced and fixed. Native pan/zoom
  makes Teensy underside pads 48-54 and GND readable; each mesh opens its details.
  Fit-scale labels still overlap, so zoom is needed. Geometry remains stylized.
- Added motor, stepper, actuator and supply settings survive a real v3 circuit
  save. A supply wired to VIN/GND accepts the 5 V control and visibly warns at
  12 V on the Teensy inspection model. This does not execute Teensy firmware.
- The identical 30-round focus/tab-disposal sequence produced seven unhandled
  Monaco cancellations before the backport and zero after it. Follow-up native
  close and pin-inspection interactions also had zero renderer exceptions.

Reports and PNGs are retained in the owned temporary `cortex-release-ui-*/artifacts`
directory: `results.json`, `final-render-report.json`, `pin-inspection-report.json`,
`editor-regression-before.json`, `editor-regression-after.json`, and the inspected
save/conflict/close/recent/Git/board/pin/voltage screenshots. Historical failing
reports remain separate from post-fix results. Temporary artifacts are local
evidence, not files guaranteed to survive cleanup or customer distributions.

## Benchmark and remaining release gates

A ten-run benchmark repeated identical virtual traces with two warmups. The
saved baseline comparison correctly reports incompatibility because the firmware
shim changed; it must not be called a measured performance regression. Host time
is separate from virtual-time throughput, and performance alerts remain advisory.
Promote a new baseline only after reviewing the new workload/environment.
The post-update run again passed all ten measured runs with identical traces;
its saved baseline remained incompatible and was not replaced. Reports are in
`.cortex/benchmarks-comparison/`, including host/environment/revision metadata.

No physical board was flashed. Remote Git credentials/fetch/pull/push, real OS
installers, signing/notarization, remote GitHub Actions, native Wokwi/Tinkercad
engines, arbitrary firmware memory use, crash recovery, and fresh-install human
trials were not validated here. The provider workflow is limited JSON exchange
and browser links, not complete embedded engines. Full CPU/electrical/peripheral
parity remains future work.

Before customers, complete [production readiness](PRODUCTION-READINESS.md) and
[dependency remediation](DEPENDENCY-REMEDIATION.md), following
[CONSTRAINTS.md](../CONSTRAINTS.md). Outstanding tasks remain in
[tasks/todo.md](../tasks/todo.md).
