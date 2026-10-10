# Customer-release validation evidence

Date: 2026-10-09. This is local Windows evidence, not release approval, a claim
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
