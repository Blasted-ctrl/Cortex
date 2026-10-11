# Automated firmware testing and CI benchmarks

## Current production-readiness slice

The [reviewed workbench plan](../.turbo/plans/cortex-production-workbench.md)
is verified after a complete audit of the 50 tracked Markdown files at
`da1aee3`. It protects global settings persistence and exact AI-approved disk
snapshots, fits horizontal docks, and adds keyboard-accessible recent projects.
The next execution uses the
[reviewed file-ownership plan](../.turbo/plans/cortex-reviewed-file-ownership.md):
main-derived proposal existence and lifetime-safe Git/editor reconciliation.
That plan is ready, not yet implemented or validated by the workbench checks.
The firmware design below remains implemented historical context, not a fresh
unstarted task list. Remote Windows and firmware CI failures and the red
dependency audit remain open; see [Task audit](../docs/TASK-AUDIT.md).

First release: sections 1-3 of the requested feature and a complete quickstart.
The actual Uno sketch runs as a host C++ executable against Cortex's existing
Arduino shim; this is firmware logic testing, not AVR instruction emulation.

## Design

- Share Electron-free simulation build preparation between the desktop and CLI.
- Use a test-only virtual microsecond clock, deterministic input ordering, a
  seeded random generator, and a fresh firmware process for each scenario.
- Start with a Uno sensor controller: A0 reading, D2 sample-ready toggle,
  D9 PWM actuator, D13 fault indicator, and Serial state logs.
- Define and strictly validate version 1 JSON scenarios. Check event deadlines,
  sampled output state, continuous actuator limits, and ordered state logs.
- Independently bound build/run wall time and output volume. Runner errors
  differ from failed firmware assertions and cannot count as expected failures.
- Save full scenario configuration, source/build fingerprints, input/output
  timeline, logs, and assertion evidence in JSON and readable summaries.
- Benchmark repeated executions of a fixed workload without compilation inside
  the measured interval. Save host and virtual-time metrics separately and make
  environment-aware baseline comparisons advisory.
- Run CI on pull requests and main pushes, pin tooling, upload reports even
  after failure, and publish summaries without writing PR comments.

## Ordered work

1. Confirm capabilities; extract build preparation and add deterministic mode.
2. Implement scenario validation, headless runner, assertions, reports and CLI.
3. Add documented normal, timeout and invalid-input scenarios plus broken and
   hanging fixtures; prove failure detection and reproducibility.
4. Add repeatable benchmark and advisory baseline comparison; wire GitHub CI.
5. Publish quickstart, capability/feature documentation, and deferred tasks.

## Verification

- Real host compilation and execution, not mocked outputs.
- Correct sketch passes three scenarios; broken timeout sketch fails the
  specific safety assertion; runner/hang errors have exit code 2.
- Repeated identical inputs yield identical virtual timelines/assertions.
- Malformed scenarios and unsupported boards are rejected before compilation.
- Existing desktop shim/stop tests, full Vitest, type checks and build pass.
- Run CLI failure/fix/replay workflow and benchmark locally; document which
  parts have and have not been exercised in GitHub Actions or by real users.

## Later release

Desktop Run Tests/results/replay is implemented and locally exercised. Its actual
recorded demonstration is playback-validated in `docs/demos/README.md`. Two
fresh-install teammate trials and one external-team trial remain in tasks/todo.md.
Human validation cannot be marked complete based on local agent tests.
# Customer release hardening follow-up

Preserve the firmware first-release plan above. Current implementation extends it
with verified vertical slices rather than replacing unfinished human-validation work.

1. Repair data-loss boundaries: disk saves, external edits, project switching/close,
   rename/delete, recent-project corruption and failed operations.
2. Repair Git boundaries and add initialization, branch creation, fetch/FF-only pull.
3. Introduce circuit schema v3/real terminal graph; validate old layouts and exchange.
4. Add driver-controlled signal parts, configured supplies/jumpers and conservative checks.
5. Repair board inspection/underside access and move clutter into contextual details.
6. Run focused regression cases, full typechecks/tests/build and isolated desktop smoke.
7. Hold customer release until audit, all-platform installers, hardware and human trials
   pass; no claim of electrical safety, full MCU/provider parity or zero edge cases.

## Markdown task execution (2026-10-10)

The current finite queue is indexed in `docs/TASK-AUDIT.md`; historical logs,
recurring dictionary maintenance and long-term vision are not silently converted
into release requirements. Preserve all unfinished external validation tasks.

1. Close verified packaging and output-retention gaps; add cancellable firmware
   child processes before exposing desktop test execution.
2. Add a workspace-confined desktop test API calling the headless runner; reject
   malformed scenarios, escaped paths, duplicate starts and stale project requests.
3. Add Run Tests and a keyboard-accessible results/details panel; save edited
   firmware before running and preserve pending saves/errors across transitions.
4. Rerun report-embedded scenario configuration against current source, retaining
   source fingerprints and explaining changes; record an actual failure/fix demo.
5. Isolate PDF parsing, retain debugger tool state, and verify the remaining
   local accessibility/session/optimization/security tasks in separate slices.
6. Correct stale capability documentation and verify a fresh owned source install.
7. Close the discovered local publication bypass: keep packaging non-publishing,
   enforce the same quality/audit and exact-target draft guards for manual
   publication, and test failures without publishing a real release.
8. Close the discovered existing AI-approval data-loss race with deferred store
   regressions, disk comparison and live buffer/project/proposal ownership checks.
9. After closing the isolated Vitest upgrade, reproduce terminal-service stale
   same-ID callbacks and deferred-create teardown with fake native boundaries.
   Preserve natural output/exit, verify current-session native controls and keep
   the separate ConPTY descendant/warning investigation explicitly bounded.

Terminal ownership acceptance is now complete: all 38 focused and 1813 full-suite
cases pass with the same five existing skips, types/build and CLI gates pass,
and owned actual PowerShell/cancelled-quit/same-ID native-overlap/finite attached
child controls pass. See the release ledger for source fingerprints and receipts.
The upstream warning still appears; its remediation, individually approved major
upgrades and external release requirements remain unfinished.

Each slice needs focused failure-path tests, relevant types/build/runtime checks
and a scoped commit. Full regression/firmware/audit checks close the combined pass.
Hardware, credentials, human trials, remote CI and individually approved major
upgrades remain honest external/owner gates, not assumed passes.
