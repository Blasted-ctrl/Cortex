---
status: ready
date: 2026-10-11
---

# Cortex bounded compiler diagnostics

Reviewed in three rounds: internal structure/scope and the read-only Codex peer
report no new qualifying defects in the final round. Accepted revisions separate
format recognition from retention, close both Cargo terminal outcomes, and make
the baseline/configurable-collector/comparison/default-selection order explicit.
Implementation and production byte defaults are not yet verified.

## Context

The Markdown audit's next local task is producer-side compiler diagnostic capture.
C/C++ Run, standalone rustc, board Verify/Upload and Debug retain full stderr until
exit. Cargo caps the problem count but accepts complete oversized JSON records,
unbounded fields and a UTF-16-length partial threshold named bytes. Bounded console
retention and acknowledged Run output do not bound these separate captures.
Keep real locations and warning/error results while bounding the records and
structured data retained for Problems. Missing information must be visible rather
than silently implying that an incomplete list proves a clean build.

Bounds are one local desktop installation and its already owned compiler children;
one collector belongs to one child, not to a reusable run ID or a global registry.
Stop/close and existing reservation/generation fences remain authoritative. No
new execution framework, persistent state, dependency, compiler flag, IPC channel,
toolchain install, provider request, customer repository operation, hardware flash
or release is needed. No total-process/renderer heap or Debug-output-transport
guarantee is claimed. Legacy simulation compile capture already has its separate
bounded failure policy; preserve that policy and its existing emitter contract.

## Acceptance criteria

- Real compiler errors and successful warnings keep their exact severity, message,
  code and source location, resolved against the correct build cwd. Empty successful
  builds clear old diagnostics and capture metadata.
- Every covered collector has an enforced UTF-8 unfinished-record budget, a total
  serialized retained-diagnostic budget and the existing maximum 500 diagnostics.
  Select and document numeric byte budgets only after the finite measurements and
  working boundary checks below. Continue draining the compiler after overflow;
  omission does not manufacture a build failure, kill the compiler or change its
  exit code.
- Oversized records are discarded as whole physical records until their newline;
  parsing resumes for later records. Never parse a truncated JSON/text prefix,
  join formerly nonadjacent Rust header/location lines, or report invented paths.
  Do not shorten file paths or individual diagnostic fields to fit a cap.
- Problems retains bounded diagnostics and a conditional omission notice, including
  when the retained list is empty. Distinguish recognized omitted diagnostics from
  unparsed discarded input: the latter has an unknown problem count. The notice
  survives Console clearing/eviction and follows the same run-ID/workspace guards
  and all existing diagnostic resets; a new complete result removes old metadata.
- Standalone Rust shows bounded complete human renderings, preserving JSON spans,
  text fallback, UTF-8 chunk decoding, CRLF and final unterminated records. Text
  capture keeps current GCC-before-textual-Rust and JSON-before-text fallback
  precedence, not mixed-format merging. Recognized primary-format diagnostics
  select that format even when none can be retained; fallback retention cannot
  steal the budget or masquerade as the selected primary format.
- Cargo preserves human rendering, prompts, its terminal build-finished boundary
  and post-build program output. Oversized or timed-out potential machine input is
  not evidence that compilation succeeded. Both successful and failed
  build-finished records finalize capture and end machine classification; only
  success permits the compile-success/run-phase transition. After either boundary,
  even program output shaped like compiler JSON remains ordinary program output.
  Slow incomplete records must stay bounded without stranding interactive prompts.
- Cancellation, duplicate starts and exact-child/generation ownership continue to
  work. A stopped or older Debug build cannot publish a newer session's result.
  No new all-callback race guarantee is implied for unchanged lifecycle paths.
- As an IDE user, I can click retained compiler problems and know when the list is
  incomplete, without learning a new settings workflow or seeing persistent
  tutorial text during ordinary builds.

## Pattern Survey

### Analogous Features

- `src/main/services/runnerService.ts:217` - Native full stderr capture until close.
- `src/main/services/runnerService.ts:321` - rustc raw transcript plus partial-line
  rendering; both can grow before the existing 500-result pure parser runs.
- `src/main/services/embeddedService.ts:158` - Verify and Upload share full stderr.
- `src/main/services/debugService.ts:445` - Debug compiler capture has generation
  and exact-child data guards; DEBUG_OUTPUT is outside the acknowledged Run broker.
- `src/main/services/runnerService.ts:431` - Cargo machine/program framing caps
  only an unfinished UTF-16 string; complete large lines bypass the threshold.
- `src/main/services/runnerService.ts:568` - Cargo collects at most 500 diagnostics
  but does not cap their fields or serialized payload. Console-only omission text
  is evictable and is not persistent Problems metadata.
- `src/main/services/simService.ts:87` - Byte-accounted simulation overflow stops
  that specialized build; reuse accounting ideas, not its different kill policy.

### Reusable Utilities

- `src/shared/diagnostics.ts` - Pure GCC/Clang, Rust JSON/text and Cargo parsing,
  human renderers and terminal-record recognition. Preserve existing contracts.
- `src/main/services/runnerService.ts:84` - Absolute-cwd diagnostic publication;
  `emitDiagnostics` is also used by simulation, board builds and Debug.
- `src/main/services/runOutputDelivery.ts` - Existing byte-aware output omission,
  packet fences and surrogate-safe slicing. This is a separate text-delivery path.
- `src/shared/consoleBuffer.ts` - Renderer tail budget; not a producer capture.
- `src/shared/ipc.ts:272` - `RunDiagnostics` currently carries ID and array only.
- `src/renderer/src/store/useStore.ts:2184` - Current-run/sim/debug acceptance gate.

### Convention Anchors

- Collector state should be a child-local closure, following native/Rust/board
  capture ownership, not a new global per-ID map.
- Run's reservation/abort ownership (`beginRunStart`, `finishRunStart`) and exact
  child removal remain intact. Publication timing currently precedes some cancel
  checks; capture work does not silently claim to repair every older callback race.
- Debug's `startGen`, `compileChild`, `current` and post-await generation check
  already suppress superseded compilation results.
- The store has nine diagnostic-array reset assignments: initial state, workspace
  reset, package operation, Debug, board target changes (two), Verify, Upload and
  ordinary Run. Pair metadata resets with each; Stop retains existing diagnostics.
- `test/runCancellation.test.ts`, `test/debugLifecycle.test.ts` and board service
  tests exercise deferred children, but some replace diagnostic emitters. Those
  mocks are not proof that the new capture/parser actually produces Problems data.
- Existing parser fixtures `test/tmp/diag.json` and `cargo-{ok,err}.json` are real
  recorded controls, not a measurement of all current tool output or sufficient
  evidence for choosing a production cap.

### Proposed Alignment

One new Node-side child-owned collector in
`src/main/services/compilerDiagnostics.ts` frames bounded records and retains
bounded normalized diagnostics through the existing pure parsers. Own byte/count
accounting there; do not move Node/path dependencies into shared parsers. Keep
format recognition separate from retained-array length. Reclaim lower-priority
fallback retention and its selected-lane counters when the first primary-format
diagnostic is recognized; then retain/count only the selected format. This bounds
combined retained size without allocating a full independent budget to each lane.
Use the existing diagnostic IPC envelope with optional bounded capture metadata,
accepted/reset alongside the diagnostic array. Cargo keeps its program-output
decision outside diagnostic parsing, so omission cannot create a compile-success
transition. A callback for complete-record rendering belongs only where needed;
no generic process runner or telemetry framework is introduced.

## Implementation steps

1. Baseline current producers and prepare finite pressure fixtures.
   - Measure actual installed GCC template failure and successful warning, rustc
     JSON error and frontend warning, and dependency-free offline Cargo records
     in owned physical D: projects. Record tool versions, exact argv/source hashes,
     raw UTF-8 record sizes, structured payload size and intended source locations.
     Rust metadata-only warning is not linker/runtime acceptance. Initial actual
     measurements at `D:/cortex-diagnostic-measurements/baseline-YXOj1S` close 0
     under Node 22.20.0: GCC 14.2.0, rustc/Cargo 1.97.1; intended source locations
     and severity/markers match. Raw records peak at 2363 bytes for these small
     examples. Synthetic in-memory parser controls retain a 16 MiB preamble before
     finding a late error, and accept a 4 MiB rendering around a small Rust primary
     diagnostic. They are not actual service/child-pressure or peak-memory proof.
     Timing includes measurement bookkeeping; heap/RSS samples are endpoints.
   - Measure fixed 4/16 MiB synthetic floods, complete versus unfinished oversized
     records, many short diagnostics and large message/rendered fields. Compare
     the unchanged actual service collectors first and retain fixtures for the
     later comparison. Separately measure
     logical retained/partial/serialized bytes, processing/close latency and
     heap/RSS observations. Endpoint samples are not peak or a total-memory bound.
   - Existing recorded fixtures are small (largest measured record 2384 bytes),
     but that does not establish generic-heavy output bounds. Leave final byte
     budgets undecided until real output and complete pressure measurements exist;
     then record rationale and enforce exact cap/one-byte-over checks.
2. Add configurable bounded framing and child-owned diagnostic retention, then
   select production budgets from the comparative measurements.
   - Create new `src/main/services/compilerDiagnostics.ts`, used by ordinary
     native/Rust, board, Debug and Cargo compilation producers. Feed decoded chunks;
     finish once on the owning child's terminal path; release closure state after
     existing close/error handling. Do not retain a second raw full transcript.
     Require explicit record/payload limits in the collector's initial test and
     measurement configuration; no provisional production default is assumed.
     Run the retained pressure fixtures against this runnable collector, compare
     with step 1, then choose and document production defaults. Pin exact-cap and
     one-byte-over regressions before wiring those defaults into the producers.
   - Reuse `parseDiagnostics`, `parseRustJsonDiagnostics`, `parseCargoDiagnostics`
     and existing rendering helpers on whole bounded records. Textual Rust pairs
     only immediately adjacent physical lines: an omitted record is an explicit
     adjacency barrier. Preserve parser precedence and at most one preceding
     bounded text record; JSON parsing never sees partial/discarded fragments.
     Select primary format on recognized diagnostics independently of retention,
     reclaiming lower-priority diagnostics/accounting immediately. Once selected,
     an omitted primary diagnostic cannot reactivate fallback. Unparsed-input
     accounting remains global because its problem count and format are unknown.
   - Compute retained payload budget after cwd resolution, including all strings
     and JSON serialization overhead. Retain whole diagnostics until count/byte
     budgets are exhausted and count recognized later omissions without retaining
     them. Track discarded unparsed bytes separately, with bounded/saturating
     counters. No oversized path/message/code truncation or fabricated location.
3. Connect every covered compilation producer without changing exit policy.
   - Replace full captures in `compileNative` and `compileRust` in runnerService,
     `streamCli` in embeddedService and `start`'s compile promise in debugService.
     Use a new named captured-result publication helper; preserve the existing
     string-taking `emitDiagnostics` simulation interface and its callers/tests.
   - Standalone Rust renders only complete bounded records and a concise omission
     marker; text forwarding still uses the existing Run output broker. Preserve
     setEncoding and final residue; do not independently decode raw chunk bytes.
   - Replace Cargo's unfinished-record handling in `runProcess` and `startReservedRun`
     with bounded physical framing that checks complete lines too. Preserve prompt
     passthrough/250 ms hold and post-terminal program data. Distinguish incomplete
     potential machine records from proven program text without treating discarded
     input as program evidence; receive the genuine build-finished record later.
     Treat both success:true and success:false as terminal classification/flush
     boundaries. Only success:true enters the run phase; a failed terminal record
     also disables later prompt/spill heuristics from emitting compile success.
     Preserve `isBuildFinished`'s existing success-only contract and add one new
     pure terminal-outcome helper in shared/diagnostics.ts for Cargo's caller,
     rather than broadening that public success-only boolean.
     Keep coalesced bounded diagnostic snapshots, including metadata-only changes
     and final flush, and prevent pending flushes from publishing retired state.
4. Surface and reset capture metadata with existing Problems state.
   - Extend `RunDiagnostics` in `src/shared/ipc.ts` with optional bounded capture
     summary (known omitted diagnostics versus unparsed omitted bytes). The existing
     preload subscription uses that envelope unchanged; no new channel is needed.
   - Add companion state in useStore; `handleDiagnostics` accepts both only after
     its existing ID gate and replaces/clears metadata on every accepted result.
     Pair all nine diagnostics resets, preserve Stop, and do not alter Monaco
     markers, badges, missing-header extraction or agent diagnostic inputs.
   - In `ProblemsPanel.tsx`, show one conditional accessible notice for incomplete
     capture, also for an empty list. Make its empty text describe absence of
     located diagnostics rather than certify a clean build. Keep groups, clickable
     locations, compact layout and ordinary builds free of a permanent notice.
5. Pin behavior and document the actual boundary.
   - Add new collector, producer and actual Problems/store tests. Preserve all
     existing parser/cancellation/debug/board/output assertions and skips.
   - Update `docs/ARCHITECTURE.md`, `docs/LANGUAGES.md`, `docs/DEBUGGING.md` and
     task/validation ledgers with measured budgets, omission semantics and limits.
     Keep transport retention, capture retention and whole-process memory distinct.

## Verification

- New `test/compilerDiagnostics.test.ts`: exact positive GCC/Rust/Cargo locations,
  successful warnings, empty clears, Windows cwd resolution, Unicode/CRLF/chunk
  splits/final residue, count 500/501, measured exact byte boundaries, oversized
  complete/unfinished records, late error after flood and adjacency-gap rejection.
  Inputs and byte/count oracles are literal fixtures, not computed by the target
  parser. Include small primary diagnostic plus huge rendering, and huge path,
  message/code/payload cases without false locations or field truncation.
  Include fallback filling the budget followed by a primary diagnostic, and a
  recognized-but-omitted primary followed by fallback: only the selected format
  may remain, with exact selected-lane omissions and no false fallback revival.
- New actual-producer integration suite exercises native, rustc, board and Debug
  child data/close with the real collector/emitter; only subprocess/window/tool
  provisioning are substituted. Existing mocked emitters cannot establish the
  result. Verify success warnings, failure errors, Stop/overlap/final residue and
  exact single terminal result without orphaned collection state.
- Cargo controls cover complete giant JSON in one chunk, slow split record,
  non-newline prompt, build-finished success and failure, omitted input followed
  by real terminal signal, user cargo-shaped JSON after that signal, final flush,
  immediate Stop and old queued flush versus replacement. Omission is never
  observed as synthetic compile success. A failed terminal record flushes the
  final diagnostic/omission snapshot, stops later machine classification and
  never emits code-0 compile success, including subsequent non-newline text or
  compiler-shaped output. Preserve the actual failing process exit code.
- New actual mounted Problems/store cases show retained clickable data plus
  metadata-only omissions, unknown problem count, Console clearing, stale-ID
  refusal, complete-result metadata clearing and all nine reset paths. No renderer
  test fabricates the collector's omission result as proof of producer accounting.
- A faithful record/aggregate guard omission must make discriminating regressions
  fail; exact source restoration precedes final verification. No assertions,
  deadlines, skips or type-check suppressions are weakened.
- Repeat real GCC/Rust/Cargo controls and fixed owned child pressure before/after.
  Retain byte metrics, timings, raw logs, environment/revision and cleanup evidence;
  no improvement claim within host noise or total-memory inference from endpoints.
- Final types, complete regression/style, desktop/tools build, repeated supported
  firmware, negative self-test and advisory benchmark remain separate gates.
  Inclusive audit remains release-blocking until genuinely remediated.
- Rebuilt original-runtime native acceptance uses an owned project/profile: ordinary
  warning/error locations, pressure omission notice, later rerun clearing and
  retained clickable navigation. Inspect actual screenshots and saved fixture
  bytes, normal exit, original runtime/source/build guards and released processes/
  ports. No real hardware upload, provider request or customer file mutation.

## Context files

- `AGENTS.md`, `CONSTRAINTS.md` - ownership and unchanged quality floor.
- `src/shared/diagnostics.ts`, `src/shared/ipc.ts` - pure parser and IPC contracts.
- `src/main/services/runnerService.ts`, `embeddedService.ts`, `debugService.ts` -
  actual producer lifetime, format and cancellation paths.
- `src/main/services/runOutputDelivery.ts` - separate existing text transport.
- `src/renderer/src/store/useStore.ts`,
  `src/renderer/src/components/ProblemsPanel.tsx` - accepted diagnostic state,
  resets and conditional presentation.
- `test/diagnostics.test.ts`, `test/rust.test.ts`, `test/cargo.test.ts` - parser
  conventions; runCancellation/debugLifecycle establish lifecycle neighbors.
