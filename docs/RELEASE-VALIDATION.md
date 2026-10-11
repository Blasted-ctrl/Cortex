# Customer-release validation evidence

Started 2026-10-09; updated 2026-10-11 during workbench verification. This is local
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
and `cortex-debug-drain-*` Temp directories. The final production build includes
this correction and the AI approval fix; its additional native control is below.

### Final production source and debugger acceptance

Exact Node 22.20.0 typechecks and production/tools build pass on implementation
checkpoint `c15627f` (24666/97461 ms; independent watchdogs unused). Main SHA256
is `c0c49e617e5c64b86f91de03393b12794a893df1a48235cb78e843eb00c642ab`;
preload is unchanged, and renderer `index-CM13FjqO.js` has SHA256
`a55ade87792b987fc583d62b978d2ba835d68bc204885a2e70630ebd75b5a556`.

Two genuine g++/GDB controls pause at line 5. Stop reaps exact GDB child 27864
and leaves Idle; restart/Continue produces a real inferior exit 0 and retains
`CORTEX_NATIVE_DEBUG_NATURAL_EXIT 48` in the shared stdout output. The actual
output screenshot was personally inspected. This proves a real program exit,
not a synthesized OS GDB-process exit-before-stdio-close race; the latter remains
the separately passing 15-case actual-service regression. The first native
helper queried a nonexistent debug-output field; that failed harness receipt
is retained alongside the paired control observing the unchanged actual shared
output, without recompilation or forced state.

`native-debug-natural-exit-output-control.json` and
`debug-natural-shared-output-helper-error.json` are in the owned production
artifacts directory. Normal close reaps Electron 25988/CLI 18264 and all captured
children, including the remaining GDB session; ports 9342/9344/9742 are free and
the unrelated user instance remains untouched. Runtime exceptions are empty;
deliberate missing-file approval errors remain logged as fixture controls.
Final combined regression and fresh-install gates remain separate.

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

## Native Vite development acceptance

An owned copied-source development launch loads the actual `.mts` config with
Vite 7.3.7. Two genuine WebSocket component updates show the temporary StatusBar
marker and its restoration without a page reload; the original root/copy bytes
are unchanged afterward. Actual sandboxed preload/native bridge, editor saving,
external-conflict recovery, automatic create/rename/delete watching and 30 Monaco
focus/tab rounds pass. A genuine PowerShell PTY prints the marker and exits
normally. Serial modules enumerate without opening a port. The built PDF worker
imports real text and terminates; only the OS picker uses an explicit fixture.

The initial copied-source dependency junction causes a font HTTP 403 because its
resolved dependency path is outside that owned server's filesystem allowance.
The harness-only correction allows the copied source and exact resolved
`node_modules` directory, not the workspace or all filesystem paths. Actual font
HTTP 200 (80340 bytes), Chromium's loaded codicon face, real fold/unfold clicks
and both served Monaco backport calls then pass. No application security/config
change follows from this fixture problem. Real Teensy underside 48-54/GND mesh
inspection passes again in development. The HMR, terminal and fold screenshots
were personally inspected.

The copied source explicitly predates the AI approval and final GDB tail fixes;
`dev-source-snapshot.json` records hashes instead of claiming an exact HEAD.
Receipts and screenshots are in owned `cortex-md-desktop-ra4M3K/dev/artifacts`,
including the retained `dev-before-exact-dependency-allowlist` directory,
`dev-real-font-control.json` and `owned-normal-recovery-cleanup.json`.
Published Monaco dependency sourcemap ENOENT and standard Electron development
CSP warnings remain visible. WebGL context-loss informational messages accompany
keyed canvas resets; replacement scenes render, and runtime exceptions are empty.
All captured owned children exit normally, ports 9342/9344/9742 are released, and
the unrelated user instance is untouched. Latest-source production acceptance
and fresh installation remain separate checks.

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
provider. [AI assistant usage](AI-ASSISTANT.md) records the supported contract.

The final production build's four genuine Electron approval controls pass in
4.663 seconds: CRLF disk contents and the retained-CRLF Monaco model synchronize
with normalized clean store text; newer disk contents are refused and preserved;
real keyboard unsaved changes are refused and retained, then Ctrl+S saves; and
an absent unopened file crosses a real serialized Electron ENOENT and is created
with exact approved bytes. Proposals and local-configured UI state are explicit
seeded fixtures; Approve clicks and preload/IPC/native file operations are real,
with no provider/model call or mocked filesystem API. Deferred races remain the
separate actual-store tests, not a native probe claim.

`latest-native-agent-approval.json` and four screenshots are retained in owned
production artifacts; applied-CRLF and dirty-refusal screenshots were personally
inspected. Two raw-versus-normalized EOL expectation mistakes in the helper are
retained separately; correcting the fixture did not change source or deadlines.
Runtime exceptions are empty. Final combined/fresh-install verification remains
open.

## Final approved-Vite combined baseline

Implementation source `c15627f` passes the exact Node 22.20.0 combined gate:
99 suites, 1797 passing cases and the same five existing explicit platform/CI
skips, exit 0 (481.66 seconds Vitest; 484772 ms independent parent). File/case
serialization preserves isolation, all deadlines, assertions and explicit
within-case races. Types/build and the final native controls above also pass.
Independent floor review finds no new suppression, weakened test or success
stub in the post-Vite implementation checkpoints.

The CLI repeats all three scenarios three times: nine passes with identical
virtual trace fingerprints (27674 ms). The negative self-test catches the broken
shutdown assertion and the independent hanging-firmware runner error (20337 ms).
The benchmark passes ten measured runs plus two warmups, all traces identical:
host median 47.90 ms, p95 57.58 ms, min 43.24 ms; exact Node 22.20.0/g++ 14.2.0.
The saved baseline remains incompatible by workload/shim and host Node version;
it is not replaced, and no performance improvement/regression is inferred.
All independent watchdogs remain unused. Receipts and reports are under
`.cortex/release-smoke/md-final-combined-*`.

CLI/benchmark metadata records HEAD `0da8fab` with dirty-worktree status from the
preserved unrelated untracked user file. Every tracked source/test/tooling/config
and dependency-manifest diff from `c15627f` is empty; subsequent commits contain
documentation only. The normal fresh `c15627f` installation remains a separate
completed check below. This baseline still uses Vitest 2.1.9; the user approved
Vitest 4.1.11 only after combined/fresh acceptance. No major install, release,
remote push, physical upload or customer/human validation is inferred.

## Final approved-Vite normal fresh installation

An archive of exact implementation `c15627f9a14a8b0e2f3dfe8e0a1a4664d9430518`
(SHA256 `1759c5311f9c13444a377748e0875b3932eb3edfc651569af7886907bd84e62c`)
was extracted into an owned temporary directory with no initial dependencies.
Portable Node 22.20.0/npm 10.9.3 ran normal `npm ci --include=dev --include=optional`
against the official registry, retaining lifecycle scripts and all optional/dev
packages. An owned npm cache and process-local empty user/global npm configs avoid
modifying original settings. Installation exits 0 in 95589 ms; complete dependency
tree validation exits 0. Both types exit 0 in 41909 ms and production/tools build
exits 0 in 103377 ms. No independent watchdog fires. Canonical manifest/lock
contents match the committed blobs despite archive/working-copy EOL differences.

The actual fresh Electron 33.4.11 binary starts its built CommonJS main, sandboxed
renderer and genuine preload bridge. Electron embeds Node 20.18.3, ABI 130/NAPI 9;
the configured pinned-Node REPL shell crosses real PTY create/input/data/exit and
kill IPC. Computed markers cannot pass by input echo. Natural exit returns 0;
explicit kill returns its expected signal exit. Fresh ConPTY and serial NAPI
bindings load; PDF dependency import succeeds. This probe does not open a serial
port, test a physical board, parse a PDF, or establish default PowerShell behavior.
The earlier dev probe is separate default-PowerShell evidence.

The bounded native probe exits 0 in 9399 ms and its window closes normally.
Explicit kill prints upstream `AttachConsole failed` from the ConPTY console-list
helper; stderr and the
[upstream race report](https://github.com/microsoft/node-pty/issues/952) are retained.
Observed owned processes are gone, but arbitrary detached-pipeline cleanup and
clean stderr are not established. A separate investigation remains open.
The initial harness's assumption that `getLastWebPreferences()` returns a preload
path failed before PTY interaction; actual configured source/hash plus real bridge
invocation replace that invalid assumption. Its failed receipt remains separate.

Root independently reads the receipts and screenshot, and verifies unchanged
original manifests, six npm-config paths, eight package versions and all 70
Electron/native binary hashes. Owned processes close without touching user
windows. Local artifacts live under Temp `cortex-fresh-c15627f-5c24cc1f32724249bbdc342b1f2c8564/receipts`.
This is fresh install/types/build/native evidence, not a second full-suite result,
customer installer test, human trial, or an audit pass. The audit remains red at
31 findings; the condition for starting the approved Vitest migration is satisfied.

Cache-scope correction: that helper used `ELECTRON_CACHE`, which installed
Electron 33's `install.js` does not consume. Its fresh executable and native
results remain valid, but its binary ZIP cache was not proven isolated. The
subsequent Vitest fixture uses the supported
[`electron_config_cache`](https://www.electronjs.org/docs/latest/tutorial/installation#cache)
in its owned directory, without changing user configuration or checksum checks.

## Approved isolated Vitest migration: installation and focused gate

The pre-migration combined/fresh baseline above finishes before installation.
Only the Vitest floor changes (`^2.1.9` to `^4.1.11`), npm regenerates the lock,
and live commands remove unsupported `--minWorkers`. No application source,
test fixture/assertion/skip/deadline, `.mts` config, isolation or native scheduling
changes are needed. The first exact Node 22.20.0/npm 10.9.3 resolving install exits
1 in 9967 ms: Arborist reads `edgesOut` on a detached null-parent peer node before
reification. Original lock, installed metadata, native binaries and npm settings
remain unchanged; `npm ls` correctly fails because installed Vitest is still 2.1.9.
A copied manifest/lock with no installed dependencies fails the same way with
lock-only/deduplication options (5022 ms). Both failed receipts are retained.

The official [npm circular-peer fix](https://github.com/npm/cli/pull/8448/files)
is present in a disposable npm 11.16.0 resolver, whose Node engine admits the
pinned host. Its copied-pair lock-only control passes (25277 ms); original root
lock-only resolution then passes (14544 ms), producing identical lock SHA256
`c09c427da22bdb313a1cea605b9c6740f917a71ad5021b7089deb0971d6a69f7`.
Pinned npm 10.9.3 consumes that graph successfully without scripts (10815 ms).
No global tool, Node/Electron runtime, CI package-manager pin, override or peer
bypass changes. The disposable resolver is not an application dependency.

Independent before-tests review records complete tree exit 0, actual Vitest and
mocker 4.1.11 sharing Vite 7.3.7, valid peers, no old vite-node/tinypool/nested
Vite 5 and no optional Vitest 5/browser/devtools installation. All 70 protected
native/runtime binary hashes, seven other package metadata files and six original
npm-config paths match the preserved baseline. The 78 changed lock entries are
confined to the test stack/root declaration. The initial review's shallow-path
assumption about missing old mocker is corrected separately: old mocker remained
nested under Vitest, not deleted by the failed install.

All 12 focused suites pass, 277 cases, exit 0 (59.93 seconds Vitest; 64870 ms
independent parent), under actual installed Vitest 4.1.11. These exercise fake
timers, genuine React editor paths, deferred AI approval/store races, GDB lifecycle
and MI parsing, output transport, real PDF worker isolation/parsing, installed
release guards and existing style rules. Intentional invalid-PDF diagnostics are
retained. No watchdog fires and no test/config migration or suppression is added.
Root types pass (40272 ms) and production/tools build passes (51477 ms), both
exit 0 without watchdogs. Main/preload/renderer entry hashes remain identical to
the pre-upgrade production build. The standalone development/optional-inclusive
high-severity audit exits 1 (4435 ms): 25 findings, one critical/18 high/six moderate.
It remains release-blocking. Subsequent combined/native acceptance is recorded
below; new-lock normal fresh installation is a separate passing gate below.
Root receipts are `.cortex/release-smoke/vitest4-*`; backup
and resolver controls are Temp `cortex-vitest4-before-f63fa3cf4c5241689ce39cb6a387ed09`.
Independent review is retained with the preceding fresh-copy receipts under
`post-vitest/independent-review.md`.

### Post-upgrade combined regression and firmware commands

Exact Node 22.20.0 runs actual Vitest 4.1.11 on checkpoint `88a9044` with the
unchanged configuration: 99 suites, 1797 passes and the same five explicit skips,
exit 0 (478.64 seconds Vitest; 480711 ms independent parent). The original
isolation, serial scheduling, assertions and deadlines remain intact. Expected
invalid-PDF diagnostics and owned local-bare-remote Git fixture output are retained;
neither is a GitHub push. The parent watchdog does not fire.

All three firmware scenarios repeat three times: nine passes, 29 assertions per
suite, identical per-scenario trace hashes and unchanged virtual durations
(31866 ms parent, exit 0). The self-test passes (22731 ms), retaining the broken
shutdown failure at 480 ms virtual and the independently terminated hanging
fixture's runner error. The ten measured benchmark runs plus two warmups pass
(15453 ms), with identical traces and the unchanged workload fingerprint. Host
median is 48.33 ms and p95 54.70 ms on the recorded Windows/Node 22/g++ 14.2 host;
these are not virtual timing or a speed-improvement claim. The saved baseline is
incompatible with the workload/shim and host Node, stays unchanged and produces
no misleading comparison. CLI metadata records `88a9044` and a dirty worktree
because the unrelated untracked file is preserved. All four gates exit 0 without
parent watchdogs; this is not a new-lock fresh-install or remote CI result.

### Post-upgrade unchanged-runtime desktop acceptance

All 43 built output files, all 153 application/build source files and protected
Electron/native binary hashes match the accepted pre-Vitest production snapshot.
The genuine built CommonJS main/preload start in an owned Electron 33.4.11 profile;
sandboxed/context-isolated renderer app-info IPC and actual native serial import/
listing pass without opening a port. Exact selected-pane Ctrl+S disk bytes,
external clean edit/Reload, create/rename/delete watcher updates and four tab
switches pass. The PowerShell terminal produces a computed stdout marker and
exits naturally. Actual PDF import/IPC uses the built parser worker, preserves
exact text/sections and observes its exit; only the OS picker selection is
substituted, not claimed verified. Top/underside, real WebGL pad hits 48-54 and
GND, wheel/pan and readable pin detail captures pass without renderer exceptions.
Negative IPC controls use constructed handler events, not native exploit attempts.

The first editor probe wrongly equates Monaco's in-memory URI with a disk path.
Its failed JSON/screenshot is retained; the ignored helper is corrected against
actual CodeEditor source to check selected tab/path and rendered-pane containment.
The passing probe changes no product code or deadline. Normal close releases the
owned app, CLI, captured descendants and CDP listener; the unrelated user process
is never targeted. The owned held-process receipt records exit 0. Native receipts
and inspected PNGs are under Temp `cortex-md-desktop-ra4M3K/production/artifacts`,
including `post-vitest-runtime-invariance.json`, `post-vitest-native-editor.json`,
`post-vitest-pin-inspection-report.json` and `owned-normal-recovery-cleanup.json`.
These controls do not repeat HMR/GDB/firmware or establish installer, hardware,
default-shell descendant teardown or a fresh native ABI. The earlier explicit-kill
ConPTY warning remains separate; the new-lock normal install/focused gate follows.

### New-lock clean-install environmental failure

The first exact `88a9044` archive fixture on C: fails normal pinned Node 22.20.0/
npm 10.9.3 `ci --include=dev --include=optional` in 87015 ms, exit 4294963241.
The actual error is `ENOSPC`, errno -4055, during writes; tar space errors and
owned-directory cleanup warnings are retained. No parent watchdog fires, and
tree/focused verification does not run. Root manifest/configuration and all 70
protected runtime/native binary hashes remain unchanged. This is not credited as
a passing installation or attributed to Vitest assertions.

The complete attempt is preserved under Temp
`cortex-vitest4-fresh-88a9044-1dffa31a68e641d485ed0fd9e8613ae4/receipts/install-attempt-1-enospc`.
C: had roughly 630 MB free, insufficient for the normal dependency tree and
caches. A new owned exact-archive fixture was prepared on the fixed NTFS D:
drive, which had roughly 476 GB free. Only child-scoped temporary/configuration/
cache paths change; original files, evidence, environment, tool versions and
normal lifecycle/dev/optional installation requirements remain untouched.

### New-lock normal clean installation and focused acceptance

The same exact `88a904481a099442ff95af50f8317b9ee3cedccc` source archive, SHA256
`a4581f55e914be565cf0d32882494471c404449f88fa25ca266712f71743c93d`, is extracted
without initial dependencies under owned
`D:/cortex-vitest4-fresh-88a9044-20261011-native-check`. The original immutable
root-before guard is copied byte-for-byte, not replaced with a new baseline.
Pinned Node 22.20.0/npm 10.9.3 consumes the committed new lock using normal
`npm ci --include=dev --include=optional`, scripts enabled and the official registry:
exit 0 in 115859 ms. Complete `npm ls --all` exits 0 (1455 ms); configuration
inspection exits 0 (369 ms), with no omit or ignore-scripts override.

Before tests, all 680 installed package versions match the lock, Vitest/mocker
4.1.11 and both build plugins resolve compatible root Vite 7.3.7, and the obsolete
vite-node/tinypool/nested Vite 5 stack is absent. Fresh Electron 33.4.11 distribution
version and 70 runtime/native binary presences/hashes are recorded, not treated as
native ABI execution. Its actual 115028145-byte ZIP is in the supported owned
Electron cache and matches the package's embedded SHA256 checksum. User/global
configuration, original manifest/lock bytes, nine protected package metadata
files and all 70 original runtime/native binaries remain unchanged.

The same 12 focused suites pass all 277 cases under actual fresh Vitest 4.1.11:
exit 0, 82.15 seconds Vitest, 86140 ms independent parent, no new skips or watchdogs.
Expected invalid-PDF diagnostics remain. The root independently reads result/log/
graph/configuration/integrity evidence; owned receipts are in that D: fixture's
`receipts` directory. This proves normal new-lock installation and focused test
loading, not another fresh full-suite/types/build/native run, remote CI, signed
installer or human trial. The preceding independent inclusive audit remains red
at 25 findings; normal npm install success is not an audit pass or release approval.

## Separate terminal ownership hardening (2026-10-10)

This is a source safety fix after the completed Vitest checkpoint, not another
dependency migration. The working tree on parent `cc82a4a` changes only terminal
session ownership and terminal quit timing; Electron 33.4.11, PTY 0.14.1,
package/lock bytes, tooling configuration and production native files are unchanged.
The owned report fingerprints the exact main/service source and copied build;
the preceding `88a9044` fresh-install evidence does not cover this new source.

### Deterministic regressions and review

Fifteen actual-service cases cover retired same-ID data/exit, writable/resizable
replacements, synchronous and reentrant kill callbacks, overlapping deferred
creates during loading/cached teardown, destroyed windows, natural final output
and exit, slot/duplicate limits and backend/spawn errors. Their closed VM loader
transpiles the actual service source and cannot import a real native dependency.
The first mock-factory fixture exposed an overlapping-import escape to the native
module; that fixture was replaced, retaining all assertions and both concurrent
creates. Its retained failure is not claimed as a hermetic production regression.
No production loader workaround, test suppression or deadline/skip change was added.

The quit-wiring guard fails before moving terminal cleanup from
`before-quit` to `will-quit`: one failure and 37 passes, exit 1 in 5108 ms.
Afterward all four focused suites/38 cases pass. Inverting only the data-ownership
check deliberately fails six cases (exit 1); restoring it passes all 38 again
(exit 0, 7246 ms). Full Node/renderer typechecks pass (37854 ms), as does the
desktop/tools build (65300 ms), under pinned Node 22.20.0/npm 10.9.3.
Independent source and fixture review reports no scoped blocker. Focused,
mutation, type and build receipts remain under `.cortex/release-smoke/terminal-*`.
The full regression and CLI closing gates are recorded below, separately from
the earlier Vitest clean-install evidence.

### Genuine Windows desktop and bounded child controls

An immutable production copy with all 43 initial output hashes matching the root
build runs in new owned `D:/cortex-native-smoke/cortex-terminal-JXwgjE`, with its
own profile/project and no provider or hardware operation. Default PowerShell
uses its unchanged empty argument list; a read-only preflight finds all four
startup profiles absent. Host Node is 22.20.0; unchanged Electron embeds Node
20.18.3. Actual preview CLI 27848 owns Electron 12964, with CDP port 9346.

- Actual typed dirty edits and an externally deleted owned file make a genuine
  `app.quit()` save fail. `before-quit` occurs without `will-quit`; the dirty
  buffer and same native PowerShell PID 29420/session remain usable, producing
  a computed post-failure stdout marker. Restoring the original owned file and
  real Ctrl+S save the exact dirty bytes. No buffer is discarded to close the app.
- Genuine terminal input/natural exit 0, Restart, Close Folder disposal and
  Open Recent/new-project shell pass. Disposed sessions send no stale renderer
  exit; current natural exits still do. Screenshots are visually inspected.
- A finite genuine shell/Node child/grandchild graph is alive before explicit
  kill. PIDs 3768/26300/26016 are gone at 7679 ms after kill, before the earliest
  natural expiry; the independent sibling graph 16660/29560/22000 is still alive
  then and later exits naturally with code 0. This is controlled attached-process
  evidence, not a guarantee about arbitrary detached pipelines.
- Same-ID replacement PID 16784 spawns at 01:00:05.394 UTC; the original native
  exit actually arrives later at 01:00:05.463. No stale renderer exit is forwarded;
  replacement input works and its own natural exit 0 is forwarded.
- Normal clean-window close exits the CLI with code 0. All 92 captured exact
  PID/creation-time identities are gone, CDP 9346 is released, and there are zero
  renderer exceptions. Five protected source/config/manifest hashes, unchanged
  Electron version/executable, PTY version/JavaScript and seven native files match
  their before/after baselines. The host helper itself exits 0; no forced app kill is used.

The intentional file-save failure and two upstream `AttachConsole failed`
console-list-helper errors remain in raw stderr. In the unchanged PTY library,
kill starts asynchronous console enumeration and immediately closes the native
PTY; enumeration has a five-second shell-PID fallback. The recorded failures and
successful bounded graph control do not prove a warning fix, eliminate PID-reuse
risk in that upstream fallback or establish arbitrary descendant cleanup. That
separate investigation/remediation task remains open; no warning filter, native
file patch or silently changed shell/backend was applied. Pending native-load
timing is deterministic-service coverage, not a delayed real-native-import claim.

The [matching tagged native source](https://raw.githubusercontent.com/homebridge/node-pty-prebuilt-multiarch/v0.14.1/src/win/conpty_console_list.cc)
throws a generic attachment error without recording the Win32 error code.
Teardown racing enumeration is a supported inference, also described in the
[upstream issue](https://github.com/microsoft/node-pty/issues/952), not proof of
the exact OS failure in this run. The installed public `useConptyDll` option is
explicitly experimental and changes teardown/output behavior; it was not enabled
as a warning workaround. Registry review finds no newer stable 0.14 patch.
Any backend/prerelease migration or experimental A/B needs its own reviewed scope
and native/platform evidence under the cautious dependency strategy.

The canonical `artifacts/terminal-owned-run.json`, full probe/observations/raw
logs and `terminal-cancelled-quit-live.png`/`terminal-natural-ui.png` are retained
in that owned D: directory. Local artifacts are not a signed installer, remote
CI result, hardware test, human trial or customer-release approval.

### Closing regression, firmware and audit gates

Root runs the actual full Vitest 4.1.11 suite under pinned Node 22.20.0/npm 10.9.3:
100 suites, 1813 passes and the same five existing skips, exit 0 in 478721 ms
independent parent (476.85 seconds Vitest). Expected invalid-PDF diagnostics and
owned temporary local-Git fixture output remain visible. Review finds no new
suppressions, removed/skipped assertions, changed deadlines or incomplete stubs;
production imports, native dependencies and CI scheduling remain unchanged.

The final CLI suite repeats each of the three scenarios three times: nine passes,
29 assertions per three-scenario suite and identical repeated virtual traces,
exit 0 in 23715 ms. Self-test exits 0 in 18731 ms because it catches the broken
firmware's `sensor-timeout-shutdown` failure at 480 virtual ms and the hanging
fixture's independent 1000 ms wall-clock runner error; neither negative fixture
is counted as passing firmware. The ten-run benchmark plus two warmups passes
with identical workload traces, exit 0 in 12351 ms. Its host median is 40.40 ms,
p95 45.76 ms, recorded separately from model throughput. The saved baseline is
incompatible and unchanged; no speedup or virtual/hardware timing claim follows.

The refreshed inclusive `npm audit --include=dev --include=optional --audit-level=high`
exits 1 in 8678 ms: 25 findings, one critical, 18 high and six moderate. This is
a release-blocking result, not a tolerated functional-test failure or waiver.
Gate results/logs and complete CLI reports are retained under
`.cortex/release-smoke/terminal-final-*`; root independently reads the actual
receipts. All other external release requirements and the separate ConPTY
remediation remain open.

## Simulator canvas text cleanup (2026-10-10)

On parent `7e72001`, remove the shared empty-canvas tutorial banner, the duplicate
2D wiring banner and the inspector's instructional sentence. Keep the concise
connection source, selector/Cancel, Escape handling, pin labels, blocked-state
remedies and circuit warnings. The walkthrough remains in
[the workbench guide](SIMULATION-WORKBENCH.md); no new setting or dependency is added.

Four actual React/store cases cover empty/populated canvases, wiring and compiler
blocking. They use real components/store with the existing fake host; browser
layout and WebGL visibility are verified separately below. Before the fix, the
focused run fails three cases with 165 passes; afterward all six suites/168 cases
pass. Both typechecks and the production/tools
build exit 0 under pinned Node 22.20.0/npm 10.9.3. Independent review finds no
scoped blocker or weakened assertions/skips/deadlines.

The genuine production Electron run uses new owned
`D:/cortex-native-smoke/cortex-simulator-clutter-gXlNrY`. All 43 copied output
hashes match the root build. Actual clicks verify empty 2D/3D views without the
banners, Underside/Pin labels, LED SIG-to-D13 wiring, Cancel/Escape, pin functions,
a missing-ground finding and saving only that owned circuit. Root inspects all
seven PNGs and the actual reports. Ordinary close exits 0; all 33 captured exact
PID/creation-time identities are gone and CDP 9362 is released. Eight guarded
source/config/manifest/Electron hashes and the copied output remain unchanged.
Zero renderer exceptions are recorded; two WebGL context-loss INFO lines and
the expected DevTools listener remain in raw logs. Startup tool-version discovery
and LSP initialization are not a firmware build/run, PTY or hardware operation.
Reports and images are retained in that owned directory's `artifacts` folder.

The final full regression exits 0: 101 files, 1817 passes and the same five
explicit skips (466485 ms parent). Nine firmware runs pass all 29 assertions
per scenario set with identical repeated traces (39692 ms). The negative
self-test catches the broken shutdown at virtual 480 ms and the hanging fixture
with its independent 1000 ms wall-clock limit (30811 ms parent, exit 0). The
benchmark passes ten measured runs/two warmups with identical traces (17301 ms);
host median/p95 are 58.99/182.32 ms. Its saved baseline is incompatible, so no
performance comparison is credited. Raw gate logs, exit receipts and complete
CLI reports are retained under ignored `.cortex/release-smoke/` with the prefix
`simulator-clutter-final`. No independent gate watchdog fires.

The refreshed inclusive audit still exits 1 with 25 findings (one critical,
18 high and six moderate). This UI cleanup does not waive security remediation,
ConPTY remediation or external customer-release validation.

## Approved isolated electron-builder upgrade (2026-10-10)

After the terminal and simulator checkpoints, the user separately approves
25.1.8 to exactly 26.15.3. Parent is `0ebf813e2a4bff85c3c2bf427e4ebf0e23acb71a`.
The only manifest change is the exact builder pin; pinned Node 22.20.0/npm
10.9.3 resolves and installs it normally with scripts disabled in the existing
tree (39751 ms, exit 0). This deliberately preserves the held runtime/native
files and is not normal fresh-install evidence. The existing CommonJS app,
Electron 33.4.11, PDF 4.0.3, PTY 0.14.1, serialport 12, CI pins, original YAML,
Arduino bundling hook and `npmRebuild: false` remain unchanged. No source/test
migration, forced resolution, override or suppressed guard is needed.

### Installed dependency and supply-chain review

The immutable before/after receipts in owned
`D:/cortex-dependency-checks/cortex-builder26-f2Ho50` retain the original
manifest/lock, installed graph, engine/peer checks and protected byte inventories.
All 602 materialized versions match; 74 unsupported optional platform packages
are explicitly accounted for. All installed engines accept the pinned Node;
`npm ls --all` exits 0 (1659 ms). The exact builder/Squirrel family is 26.15.3,
builder-util-runtime 9.7.0, rebuild 4.2.1 and node-gyp 12.4.0. The sole resolved
tar is 7.5.22, above the required 7.5.21 fix.

The generated lock changes 244 packaging-closure/flag locations. Independent
lock-aware traversal confirms the non-builder reachable graph still has 445
locations/392 logical package names, with no changed version sets. The entire
Electron distribution, all 70 held native binary hashes, protected package
metadata, source/test/config/output inventory and six original npm-config paths
match their before-install values. The approval does not upgrade the app runtime.

Lifecycle review finds one added hook: electron-winstaller 5.4.0 copies bundled
host-architecture 7-Zip files within its own package. An initial static concern
about its `os.arch` expression is disproved by actual pinned Node evaluation;
its custom primitive conversion selects `x64`. No workaround is installed.
The previous six lifecycle package versions are unchanged; Darwin-only fsevents
is not executed on Windows. Six Windows-runnable hooks are explicitly reviewed,
including existing Electron downloads, esbuild binary validation and native
PTY/serial fallback behavior. Sixteen inspected source files match the retained
earlier same-version fresh copy; this is not a newly captured before-hook baseline.
The official Electron archive checksum is frozen for the separate normal install.

### Verification status

The pre-install control passes seven focused suites/177 cases (51177 ms).
After installation, the identical seven suites/177 cases pass (62097 ms),
including actual installed CLI/schema/Packager/publisher construction without
publication and the native/PDF boundary regressions. Typechecks exit 0 (27396 ms)
and the production/tools build exits 0 (47713 ms). Expected invalid-PDF/control
warnings remain in raw logs; passing focused tests are not a clean-stderr claim.
The full regression then exits 0: 101 files, 1817 passes and the same five
explicit skips (522299 ms parent, no watchdog). All original deadlines,
assertions, native-file scheduling and isolation are preserved. CLI and
packaged-app checks subsequently pass below on committed implementation
`39496398ba3e48041e00a7f49e82fa7d6d5ecd42`.

### Headless firmware and advisory benchmark

The three scenarios repeated three times pass all nine runs/87 assertions with
identical traces (21908 ms parent). The negative self-test exits 0 (31626 ms):
broken firmware fails `sensor-timeout-shutdown` at virtual 480 ms, while hanging
firmware is stopped by the independent 1000 ms wall-clock watchdog as an expected
runner error. These failed/error fixture reports are retained, not counted as
passing firmware. Compiler is MSYS2 g++ 14.2.0; reports identify the implementation
revision and retain their actual dirty-worktree flag.

The benchmark exits 0 (13353 ms), with ten successful measured runs, two warmups
and identical traces. Host median/p95 are 43.12/46.32 ms; compilation and warmups
are excluded. Each run covers 60000 virtual ms. Median model throughput is
1391446.10 virtual ms/host second, separately labeled from hardware timing and
host execution. The unchanged saved baseline is incompatible by workload/shim
and host Node; comparison stays advisory and no performance improvement or
regression is inferred. Raw logs, full input/output/assertion reports and build
metadata use `.cortex/release-smoke/builder26-final-*`.

### Normal fresh installation

Owned `D:/cortex-builder26-fresh/cortex-builder26-TkRTVA` starts with 367 tracked
current-source files and no inherited dependency tree. With isolated empty npm
configs and D: cache/temp/native-build locations, pinned npm 10.9.3 performs
normal `ci --include=dev --include=optional` with scripts enabled, exit 0
(135883.8035 ms, no watchdog). All six runnable lifecycle hooks exit 0, including
the new local-copy installer hook. The existing PTY download/build fallback is
not suppressed. Inherited binary, Electron, npm and Node override settings are
cleared only in the owned child environment; no global configuration is changed.

All 602 actual versions match the frozen lock. The 74 absent optional packages
are individually platform-incompatible leaves, not ignored install failures.
All reviewed lifecycle metadata/command hashes match; the fresh Electron ZIP
matches the frozen official SHA256
`f64c8a5a81d9b420b636fdba13e180f49d69f2198e1d86a8b01f858b17a9483c`.
Seventy-seven native files are inventoried, including actual PTY and serial
bindings. Root manifest/lock/runtime/native/config guards remain unchanged.
This is normal install and file-inventory evidence, not native ABI execution,
a second full regression/build or installer proof. The same seven focused
suites/177 cases then pass (91332.475 ms parent, no watchdog), with all frozen
source/root/config guards intact. Expected PDF rejection warnings remain in raw
stderr; no test is skipped or weakened. Complete installation/focused receipts
and stdout/stderr are retained under that fixture's `receipts` directory.

### Original-config unpublished Windows package

In owned `D:/cortex-builder26-acceptance/cortex-builder26-AASS6j`, the actual
installed builder packages a tracked-source/current-output snapshot with a
read-only original dependency junction. Its command is Windows x64 `--dir
--publish never`, with only output/cache/temp location overrides. Original YAML,
CommonJS hook, security/signing defaults and `npmRebuild: false` stay unchanged;
no native rebuild occurs. The actual command exits 0 after approximately six
minutes, including official Electron acquisition and bundled Arduino CLI setup.
File traversal is slow but finite; dependency collection has already completed
when the duplicate-reference diagnostic is printed. No watchdog fires.

The first payload check fails because its ignored harness passes forward-slash
names to the Windows ASAR reader. Two independent checks find the actual PDF
worker in the archive and prove its bytes match the snapshot. The ignored helper
uses native `path.join` lookups; no application/configuration change, second
package or disk extraction is needed. The original failing `package-report.json`
remains byte-identical and explicitly hash-linked in a separate
`package-accepted-report.json`; a failed packaging command is never salvaged.

Acceptance then verifies all 24 main/preload/renderer output members and eight
Windows native payloads byte-for-byte. The entire 244-file outer package,
root source/config/manifests/native/PDF/Electron/output and original logs remain
unchanged. All six exact owned packager PID/creation-time identities are gone.
Bundled CLI executable/license/notice/provenance hashes are retained. Runtime
acceptance subsequently passes below. This is an unpublished unpacked Windows
app, not an NSIS installer, clean-machine installation or Authenticode certification.

### Actual unpublished packaged runtime

Two initial runtime attempts fail in ignored inspection code, not application
code: `process.mainModule.require.resolve` is unavailable on that bound require,
then a literal carriage return makes a terminal-input expression invalid JavaScript.
Both original failure receipts/logs remain byte-identical. Their normal app
closure, owned-process cleanup and unchanged-byte controls pass, but neither
attempt is credited with unfinished PDF/Save/terminal-exit acceptance. The
helper uses `createRequire` for actual module resolution and JSON-stringifies
terminal input; all 27 shared inspection expressions parse before the next
owned launch. No application, native module, ASAR or packaging change is made.

The third attempt in `runtime-attempt-90Ed5N` uses a new empty owned profile and
project and exits 0 (02:11:12 to 02:11:29 UTC on 2026-10-11). Its genuine pristine
`Cortex.exe` reports `isPackaged: true`, Electron 33.4.11/embedded Node 20.18.3,
the exact ASAR/profile, sandbox/context isolation enabled and Node integration
disabled. Actual controls pass:

- Bundled Arduino CLI 1.5.1 executes its version command; executable, receipt,
  GPL license and notices match. Genuine startup downloads official catalogs,
  signatures and builtin serial/mdns discovery tools into the owned profile.
  No board core installation, serial-port opening or flashing is performed.
- Real renderer/preload serial IPC and the native packaged serial class enumerate
  two ports. The native PTY starts the explicit pinned Node shell, produces a
  computed marker and its actual PID, reports a real 132x30 resize and exactly
  one natural exit-0 event. This does not establish default-PowerShell UI behavior.
- The original packaged PDF worker runs inside the actual Electron main process,
  exits 0 and returns the expected fixture text/page section. The unchanged
  pdf2json library's `Warning: Setting up fake worker.` remains in raw stdout;
  no mock replaces the real Node worker. Native PDF-picker/RAG import is not tested.
- Actual Simulator palette interaction adds an LED and Save persists a clean
  version-3 circuit. The screenshot shows board/pin labels, controls and the
  useful warning badge without the requested tutorial banner.

Normal app close exits 0; all ten exact owned PID/creation-time identities are
gone and ports 9364/9365 are free. Zero renderer/main exceptions are captured;
raw inspector/library logs are retained. All 244 outer package files and root
source/config/manifests/native/PDF/Electron/output inventories remain unchanged.
Independent root checks after the CLI/self-test/benchmark confirm those bytes,
cleanup and both failed runtime receipt hashes again. The final runtime receipt
SHA256 is `1125401a0b69029d3feccd01dcf596f117e46f9743e8dc6a40f8bbdbf7bfbe02`;
it links the separate payload acceptance and both historical failures. Receipt,
raw logs and screenshot remain under the owned attempt's `artifacts` directory.

The inclusive audit exits 1 (4987 ms): 17 findings, zero critical/seven high/ten
moderate, down from 25. The targeted AppImage/tar findings are absent. Packaging
still has moderate findings and runtime/watcher/CSS findings remain high; no
threshold is lowered and the audit's suggested builder downgrade is not applied.
The audit remains a customer-release blocker. Local receipts/logs use the ignored
`builder26-final` prefix; temporary D: evidence is not shipped or guaranteed to
survive later cleanup. Installer/signing, hardware, remote CI and human trials
remain separate release gates.

## Production workbench checkpoints and encoding stop-line

The requested push put `da1aee3` on remote `main`. Later completed checkpoints
are local commits, not automatically pushed: `cfc1f30` serializes global settings
and fixes recent-project keyboard controls; `c145913` preserves physical project
ownership across admitted path aliases; `2f1c84a` fits horizontal docks and error
cards; `852dd12` reports settings-save failures and preserves newer mounted drafts.
`da99c9b` preserves exact approval/editor encoding snapshots through typing and
saves. These are verified local checkpoints, not a new remote CI pass.

Local focused evidence includes 38 settings service/default cases, 84 physical
alias/Git/config cases plus one unchanged local platform skip, 43 horizontal/
bottom/debug/notification cases, and 78 settings service/default/UI cases. Actual
original-behavior and faithful regression experiments failed the relevant checks
before exact restoration. The final pre-encoding full run exits 0: 106 suites,
1924 passes plus the same five explicit skips (1929 total); Vitest 629.09 seconds,
parent 635283 ms, no watchdog. Its `workbench-drafts-final-tests` receipt predates
the new editor-model tests and final encoding correction; it is not their gate.

Three separately retained native attempts explain the encoding stop-line:

- `native-vaSywM` fails in the inspection helper before UI acceptance. Its later
  OS absence does not retroactively establish successful native cleanup.
- `native-ZWNMAC` reaches the genuine sandboxed window but fails to observe Enter
  activation because its CDP key helper omitted character text. Normal close/
  owned cleanup pass; unfinished UI scenarios do not.
- `native-yhF8Rt` proves trusted recent-project Enter/Space actions, dock fitting
  at 1366/900/1800 pixels, contained highly zoomed notifications, continuous
  two-pixel dragging, original Simulator switching, and real settings failure/
  repair/retry. It closes normally with no renderer/main exceptions and all
  23 observed exact owned identities gone. However, its driver `passed` flag
  missed a duplicated BOM after Monaco typing. Raw saved bytes contain UTF-8
  EFBBBF at offsets 0 and 20; disk/saved-snapshot equality alone is insufficient.
  This attempt is **not file-integrity acceptance**.

All three reports/logs/screenshots remain in separate children of the owned
`D:/cortex-workbench-acceptance` directory. None used customer files, provider
calls or hardware. The initial correction's later types/build pass does not close
the defect: review also found that stripping a marker before initial model
construction loses an intentional second leading UFEFF. Initial construction and
controlled updates have different Monaco semantics. No old failure is overwritten
or reclassified as a pass.

The final correction separates raw model construction from controlled text and
tracks each mounted model's raw-snapshot/marker provenance. Save acknowledgements
cannot reinterpret a newly typed literal as encoding metadata. The existing
store action has an optional exact-raw mode for this encoding-aware editor;
ordinary callers retain their previous BOM-preservation behavior. Actual-component
regressions use the installed React wrapper and production store/native filesystem,
with only Monaco/browser/host boundaries substituted. Final focused verification
passes 59 cases across three suites. Faithful construction and raw-boundary
regressions fail seven and one cases respectively before exact restoration.
Both typechecks and desktop/tools build pass; nine firmware runs pass 87
assertions with identical per-scenario traces. The broken shutdown and independent
hang watchdog are caught by the separate self-test. Full combined regression and
the advisory benchmark now pass. The first full encoding run retained a style
failure in the new plan (1938 passes, one failure and five skips, exit 1). After
correcting only that punctuation, all four style cases pass and the full rerun
exits 0: 107 suites, 1939 passes and the same five skips (1944 total), Vitest
547.14 seconds and parent 550567 ms, without watchdog. Application source hashes
remain unchanged between those runs and the verified encoding commit. The
`workbench-encoding-style-corrected-tests` receipt is the final full gate.

The final ten-run benchmark passes after two warmups with identical virtual
traces; host execution median is 46.54 ms and p95 is 50.74 ms. Its saved baseline
is incompatible because the workload/shim and host Node differ; this is not a
measured speed regression, and no baseline is replaced. Host and virtual metrics
remain separate and comparisons advisory. This report records pre-commit
`852dd12` with a dirty worktree; it does not identify a clean committed revision.

Fresh native `native-DTQyHJ` now passes the six planned workflows in the original
sandboxed production Electron 33.4.11, with genuine preload IPC, Monaco typing,
Ctrl+S and unkeyed file switching. Whole saved files match independently constructed
expected bytes: `main.cpp` is 59 bytes with only its encoding BOM; `literal.cpp`
is 63 bytes with its encoding marker and intentional interior U+FEFF. Tail and
prefix edits preserve the original two-marker file. Keyboard recents, fitted
docks, contained notifications, two-pixel dragging, original Simulator and real
settings failure/repair/retry also pass. Root and the native tester inspect the
actual screenshots, not just geometry flags. Runtime exception arrays are empty;
raw logs retain the two expected owned missing-folder/corrupt-settings errors.
Normal close exits 0; all 19 observed exact owned PID/creation identities are
absent and both inspection ports are free. Source/build/native hash inventories
and root's four Git tree checks are unchanged. Wrapper exit 0 takes 26816 ms
without timeout. The report SHA256 is
`7fff089f501277ffc8838fd339388a65243ac307cfcef11134d09329e681b44f`.
This closes the scoped native file-integrity stop-line, not external release gates.

The portable verification runtime's extracted C: directory subsequently became
unavailable while its official archive and old receipts remained. Restoration
uses the same Node 22.20.0/npm 10.9.3 archive, verified again against Node's
official release SHA256, in an owned D: tools directory. This is not a toolchain
upgrade, global installation or fresh app dependency installation.

The actual remote workflows on `da1aee3` remain failed. Local alias fixes and
Electron-free service test boundaries have passed locally but have not run on a
new pushed revision. Dependency audit still blocks release at 17 findings (seven
high, ten moderate). Signed OS installers, selected hardware and human trials
remain unverified. Subsequent file-provenance/Git-reconciliation implementation
can now begin under its separately reviewed written plan; it is not verified by
these workbench receipts.

## Reviewed file and Git ownership (2026-10-11)

This is a separate slice after workbench commit `da99c9b` and documentation
checkpoint `5bb4603`, not evidence inherited from their native receipts.
Main-derived proposal existence, conservative legacy-empty review, original-clean
tab reconciliation and VCS project-lifetime ownership are implemented test-first.

The actual main producer first fails nine cases (18 pass), then passes all 27
producer/tool-contract cases. Its single ENOENT predicate regression fails five
cases; exact restoration again passes 27. The producer uses the actual runner,
event emission and owned filesystem/settings, substituting only the Electron
host and local/OpenAI-compatible provider transport. This is not real provider,
Gemini or OS ACL-denial acceptance; the non-ENOENT input is a genuine Node invalid
path rejection.

Approval's corrected original-behavior run fails ten cases with 100 passes,
including actual native-filesystem data-loss cases and real mounted-card labels.
The implemented focused run passes all 110 across five suites. An earlier
retained run also fails one new fixture's incorrect CRLF expectation for an
existing empty file; the fixture now uses LF to isolate existence behavior.
Existing nonempty BOM/CRLF and ordinary-save assertions remain unchanged.

Git's original-behavior run fails 39 cases with 96 passes. Implemented ownership
and additional normal-action/cancellation/save-recovery controls pass all 150
across seven suites. Deferred store/component tests substitute Git outcomes;
the mounted VCS fixture uses the real filesystem for tab/tree reconciliation.
Real owned-Git service tests and native ordinary switching remain separate gates.

Faithful existence-guard omission fails four cases; workspace-generation-only
ownership fails 13 Git cases and exact-tab omission fails nine. Exact restorations
pass. Independent combined code review is complete, including a second actual
read-only Codex review after an internal finding tightened missing-file errors.
An ENOENT-looking quoted filename must not turn EACCES or a refused read into
absence. Those discriminating regressions fail three approval and three Git
cases with the earlier loose prefix, then pass after restoration: approval 113
and Git 154 focused cases. These are serialized error fixtures, not native
Windows POSIX-colon filename or OS ACL-denial evidence.

Final pinned Node 22.20.0 verification closes without an outside watchdog:

| Gate | Actual result |
|---|---|
| Types | Both processes pass; 54,980 ms outside gate |
| Full regression/style | 111 suites; 2052 passes, five unchanged skips; 769,708 ms outside gate |
| Desktop/tools build | Pass; 89,688 ms outside gate |
| Serial firmware suite | Nine passes, 87 assertions, identical per-scenario traces; 53,939 ms |
| Serial negative self-test | Broken shutdown assertion and independent hang timeout caught; 17,762 ms |
| Advisory benchmark | Ten passes plus two warmups, identical traces; 48,003 ms outside gate |
| Inclusive dependency audit | Still fails: 17 findings, seven high and ten moderate, zero critical |

Receipts use `.cortex/release-smoke/ownership-errno-final-*`,
`ownership-serial-final-*` and `ownership-final-serial-d-scratch-bench-*`.
The earlier parallel firmware/self-test runs are retained but the final CLI
evidence is serial. The benchmark runs after the other Cortex checks close,
with private TEMP/TMP on D: after a C: space shortage. Host median is 89.30 ms
and p95 106.72 ms, excluding compilation/warmups; virtual model throughput is
separate. Revision is `5bb4603` with the reviewed dirty source. All measured
traces are `aa8cd6b2b90d60dea2f3028895b1a4c38291bb56137dd766518ac15bc82fba75`.
The baseline is incompatible (workload/shim and host Node differ), remains
advisory and was not replaced. Unrelated host activity is not controlled.

Fresh native evidence is
`D:/cortex-reviewed-file-ownership/native-pn5ZzN/artifacts/file-ownership-native-report.json`:
2084 lines, SHA256 `0C8F16209F6E40FE4C2C245FD2594D03AE241FF119E472DA85A4DA4DB2FD2A9A`.
The root read the full receipt and raw logs and inspected eight key PNGs; the
executor independently read the full receipt/logs and viewed all 18 PNGs.
Original Electron 33.4.11/Node 20.18.3 retained sandbox/context isolation and no
renderer Node integration. Five trusted Approve actions produce two correct
whole-file writes and three stale refusals, including the no-open-tab deletion
and externally created empty target. Existing empty is not new; reviewed absence
is visibly new in the shorter-path control. Its one-BOM/CRLF creation is exact.

Actual GUI alternate/main switches reconcile the original clean BOM/CRLF tab
and remove/restore main-only.cpp. Dirty switching refuses while preserving disk,
branch and buffer; native Ctrl+S then writes the independently expected 62 bytes.
These are ordinary native operations, not delayed-race or live-provider proof.
The cards/log entries are explicit memory-local seeds; the genuine main producer
is covered separately by controlled-transport tests. No Send/provider request,
remote, customer repository or hardware action is performed. Normal automatic
tool/catalog discovery stays in the disposable profile.

App PID 4764 (parent 30044, creation `2026-10-11T13:53:21.0463560Z`) exits normally
with code 0. All 38 observed owned identities are gone; the root and executor
independently confirm wrapper/driver/app absence and bindable ports 9741/9742.
Renderer/main exception arrays are empty. Raw stderr retains three expected
fs:readFile ENOENT logs for the deliberately absent files; this is not a
clean-stderr claim. All 370 distinct protected source/config/native/build/helper
paths and the Git executable hash match. Before/after index, tracked diff, branch,
HEAD and in-scope status are exact. Complete status differs only because concurrent
unrelated untracked website files were added; neither those files nor 3744 were
read, changed, staged or moved by this work.

One visual limitation remains: `created-after-review-review.png` clips the new
badge beside its long filename. DOM state is correct but that badge is not
visibly readable; no all-badges-visible claim is made. The visible layout fix is
recorded separately in tasks/todo.md.

All three earlier native attempts remain failed/unverified and immutable:
`native-gt1v07` refuses the initial overbroad Git-environment check before launch;
`native-RqvcQ0` never admits Welcome Open; `native-7enpLV` hits an incomplete
startup CIM row before interaction and has unverified natural-exit cleanup.
Independent later OS checks find no remaining owned processes/port owners, but
do not reconstruct lifecycle success. Separately reviewed helper copies retain
the exact two benign Git environment values, fence the new reload document and
wait for complete same-PID identity before unchanged identity assertions. No
in-run retry, source patch, forced app kill, signing/hook override or old receipt
overwrite turns a failure into a pass. No new remote CI or release pass is claimed.

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
