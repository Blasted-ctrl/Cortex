# Cortex Progress Log

Newest first. One entry per completed slice: what shipped, how it was verified,
and what it unblocks. See `CORTEX_IMPLEMENTATION_PLAN.md` for the full plan.

## PDF parser worker isolation

The documented main-thread parsing gap below is now implemented as a disposable
Node worker. The existing `extractPdf` result, `loadPDF(file)` parser API and
page/line citations are retained. Electron's main thread owns the 25-second
watchdog and waits for termination after each result/error/timeout, including a
CPU-stuck worker. The 20 MiB input and 400-page limits now reject rather than
silently import the first 400 pages. Extracted text is limited to the existing
8 MiB readable-document bound, with a 20 MiB serialized result cap before posting.
The 256 MiB worker V8 heap limit is not a total-memory or security sandbox; the
input precheck is not a locked snapshot of a concurrently changing file.

Verification: a generated 401-page PDF first failed its regression because the
old adapter returned partial success. Worker parsing, the existing genuine PDF
and corpus integration tests, and real worker lifecycle tests then passed. The
deliberate infinite loop is terminated at the full 25-second deadline while the
main-loop heartbeat remains responsive. Build-path adaptation for Vitest emits
the real worker in owned Temp and removes that generated bundle on close. No
main-thread parsing fallback, dependency upgrade, renderer IPC expansion or new
type suppression was added. Native dev/production smoke and installer validation
remain distinct gates. Current capabilities and limits: `docs/DATASHEETS.md`.

## Datasheet intelligence: PDF adapter

Extended document intelligence to PDFs - the format datasheets actually ship in
- as a contained adapter behind the existing `DatasheetSection[]` interface, so
the BM25 engine, citations, IPC, and panel are unchanged. A new `pdfExtractor.ts`
uses **pdf2json** (pure-JS, zero native deps, Node-20-safe) loaded lazily and
declared an OPTIONAL dependency, so a missing/broken install degrades to
`isPdfAvailable()=false` and never blocks app start. It reads the structured
per-page text runs, rebuilds lines gap-aware, splits pages into blocks, and is
bounded. pdfjs-dist was rejected: its `Promise.withResolvers` needs Node 22 and
Electron 33's Node is 20. On import a PDF is stored as a revealable `<stem>.pdf.txt`
plus a `<stem>.pdf.sections.json` sidecar carrying page provenance; `loadCorpus`
reads the sidecar (through the same symlink/realpath corpus confinement) and a
citation now carries `p.N`. pdf2json is externalized in electron.vite.config.ts
(kept a runtime dynamic import, not bundled - verified in the prod build).

An adversarial find->verify review (16 agents) confirmed 11 findings, ALL fixed
here before commit:
- [HIGH] pdf2json v4 dropped URI-encoding, so the initial `decodeURIComponent`
  double-decoded and corrupted any literal %XX (e.g. `printf("0x%02X")` injected
  a control byte) - a verbatim/honesty violation my %-free test PDFs missed. Now
  the run text is used as-is; a `%02X` regression test asserts byte-identical
  output.
- [HIGH]/[MED] robustness: the parse runs on the main thread and a same-thread
  timeout cannot interrupt a synchronous pdf.js hang, and the parser was never
  torn down (leak). Fixed the over-claiming docstring to be honest, added a
  `finalize()` that clears the timer + `parser.destroy()` (aborts pdf2json's
  async pipeline, frees buffers) on every settle path, and lowered the byte cap
  to 20MB as the real main-thread guard. Full main-thread-hang immunity
  (worker_thread/utilityProcess isolation) is the documented next hardening.
- [MED] a crafted PDF sidecar could inject a "verbatim" passage absent from the
  stored .txt: `loadCorpus` now cross-checks each PDF section's text is a
  substring of the revealable .txt and drops any that isn't (this also
  neutralizes the non-atomic-write [LOW]: a torn write yields fewer sections,
  never wrong ones).
- [MED] namespace collision (`notes.txt` vs a `notes.pdf` import) caused silent
  data loss: PDF artifacts now live under a `.pdf.txt`/`.pdf.sections.json`
  namespace and imports refuse to overwrite a file owned by a different document.
- [MED] the dataError handler discarded the real IO error (mislabeling an
  ENOENT/EBUSY as "corrupt PDF"); it now preserves the raw Error.
- [LOW] gap-aware line join keeps kerning-split tokens whole (`0x68`, not
  `0x 68`); [LOW] sidecar line/page must be positive integers; [LOW] isPdfAvailable
  no longer caches a transient import failure.

Verified: 7 extractor + 17 service tests (real PDFs via a `test/makePdf.ts`
generator, no mocks) covering page/line provenance, the %XX regression, gap-join,
the fabricated-sidecar and numeric-sanity confinements, and the namespace-
collision protection; full suite green (763 passed); prod `npm run build`
succeeds with pdf2json externalized; live - a real BME280 PDF imported through the
actual pipeline, and the app returned its page-2 section with a rendered
`p.2 L:4` citation, still correct after the security hardening. Docs in
`docs/DATASHEETS.md`.

## Datasheet / document intelligence (foundation)

Engineering-context retrieval with citations, not "chat with a PDF" (CLAUDE.md
section 12). Import datasheets / reference manuals / app notes; every answer is a
verbatim passage carrying a citation back to the document, section, and line, and
when nothing matches the system says so instead of inventing a value.

Pure core (`src/shared/datasheet.ts`, dependency-free, unit-tested): markdown /
text sectionizers that record 1-based line provenance, a local BM25 lexical index
+ query (offline, deterministic, no embeddings/network - it can make no claim it
cannot back), citation formatting, hardware-graph query enrichment, and a
doc<->device matcher. `KNOWN_DEVICES` was added to hardwareGraph.ts as the deduped
join surface. Main service (`datasheetService.ts`): import (copy into the
workspace corpus), list, and a cached search. The corpus lives in
`<workspace>/.cortex/datasheets/`. Retrieval reaches the engineer three ways
through one formatter: a Datasheets sidebar panel (import + query + cited results
+ device-linked corpus), a read-only `search_docs` agent tool, and pre-injected
passages in the chat + structured-fallback context - each degrading silently to
plain behavior with no workspace or no docs. Text/markdown first (zero new deps);
PDF is a contained follow-on adapter feeding the same section shape. See
`docs/DATASHEETS.md`.

Reviewed by a find->verify workflow (3 dimensions, 10 agents) that confirmed 7
findings, ALL fixed before commit:
- (security, high/med) An untrusted, repo-shipped manifest could point a doc path
  at a symlink escaping the workspace, or at any in-workspace file (.env,
  secrets.h), and the read fed it verbatim into the model. Reads now ignore the
  manifest path beyond its basename (forcing it into the corpus dir), reject a
  symlink via lstat, and require the corpus dir's realpath to stay in the
  workspace; imports refuse to write THROUGH a symlink and confine the corpus
  dir's realpath. Regression-tested (manifest ../ and in-workspace escapes; the
  symlink case is guarded for Windows privilege).
- (perf, med) search() rebuilt the whole project model on every chat message /
  query; the enrichment graph is now cached with the index and rebuilt only on
  import.
- (retrieval, med) matchDeviceForDoc now links hyphenated part numbers
  (MPU-6050) and label alternatives (ADS1115) via contiguous-token joins, without
  short-key false positives.
- (retrieval, low) enrichQueryFromGraph now scopes a bus-specific query to
  devices on that bus and drops bare-number/short description terms; docstring
  corrected.
- (retrieval, low) a heading-only match now shows the heading text, never an
  empty passage.
- (integration, low) a doc's id is the unique stored name, so two source names
  that slug alike no longer collide (React key / citation docId).

Verified live against the running app: importing-shaped corpus -> list shows the
doc with its mpu6050 device link -> query "wake from sleep, PWR_MGMT_1" returns
the exact PWR_MGMT_1 section at line 3, verbatim, and the panel renders it with a
clickable citation; retrieval still serves legit docs after the security
hardening. 19 pure + 12 service (incl. 4 confinement) unit/integration tests, the
agent-tool contract test extended, and workspace-reset keys guarded. Typecheck
(node+web) and full suite green (751 passed). The native-dialog import step is the
only part not driven in the live check (a dialog cannot be scripted via CDP); its
copy + manifest + device-link path is covered by the service integration tests.

## Environment-aware agent tools (Stage 8)

Gave the engineering agent the hardware-aware context that the whole dependency/
graph system exists to produce. Two new READ-ONLY agent tools (SAFE tier,
auto-run, workspace-confined, no arguments): `get_environment` returns the
evidence-based environment report (is the board core installed; each #include
resolved via a named library / provided by the toolchain / unverified / MISSING;
updates with risk; hardware findings), and `get_hardware_graph` returns the
device/bus/pin relationship graph with its inferred, hedged bus attachments. The
system prompt now tells the agent to consult them and to trust what they report
rather than assume a library or device is present.

The formatters are pure and unit-tested (`src/shared/agentContext.ts`) so the
exact bytes the model sees are pinned down and, crucially, honest: an unverified
dependency is never rendered as present, and a "likely on <bus>" inference keeps
its qualifier and note - the agent can tell what Cortex knows from what it
guesses. The executors (in agentService) reuse the already-verified primitives -
environmentService.inspect for the report (board from the persisted project
config), buildProjectModel + buildHardwareGraph for the graph - and add no new
path-handling or mutation surface. The structured fallback (non-tool providers)
now includes the same environment + graph context up front.

Verified: node+web typecheck clean; full suite green (717 passed), including new
tests that the tools are registered as read-only no-arg tools (not in
MUTATION_TOOLS) and that the formatters preserve the honesty of unverified deps
and hedged bus inferences. The app boots with the new agentService (no import
cycle from the added environmentService dependency). The end-to-end LLM tool-call
was not exercised here (no AI provider key is configured in this environment),
but the executors are thin wrappers over primitives proven live in Stages 4-7 and
the tool contract/formatters are unit-tested.

## Firmware <-> simulator consistency (Stage 7)

Closed the audit's core gap: the source-derived hardware graph and the simulator
were two separate models with nothing verifying they agree, so a sketch could
drive a pin the simulation never modelled (its effect invisible) or a part could
sit on a pin the firmware never touches (inert), with no signal either way. A new
pure module (`src/shared/simConsistency.ts`) reconciles the firmware's pin usage
(ProjectModel.pins) against what the simulator has wired (its parts' board-pin
connections) and reports two certain mismatches: "not-simulated" (a firmware pin
with nothing wired to it, so its behavior will not appear in simulation) and
"inert-part" (a part on a pin the firmware never uses).

It holds the same honesty line as the rest of the system. Source pins are tokens:
a numeric one ("5", "GPIO5") resolves to a board pin unambiguously (reusing
pinCapability.parseGpio), but a named one ("A0", "LED_BUILTIN") needs a
board-specific map we do not have, so it is listed as unresolved and never
produces a claim. Crucially the inert-part check runs ONLY when every source
token resolved - an unresolved "LED_BUILTIN" could be exactly the pin a part is
on, and flagging it would be a false claim - so it is skipped (with an honest
note) whenever a named token is present. The findings surface as a "Simulator
consistency" section in the existing Hardware panel, beside the source-derived
graph, each not-simulated finding click-to-source.

Verified live against the real app in both directions: a sketch driving GPIO5/7/9
plus analogRead(A0) with the default sim rig (LED on 13, button on 2) showed
three not-simulated findings (5/7/9), A0 listed as an unchecked named pin, and NO
inert claim about the LED or button (A0 unresolved -> inert check suppressed);
removing the A0 read so every token resolved then produced five findings - the
same three plus the LED@13 and button@2 correctly flagged inert. 10 new unit
tests (both finding kinds, the unresolved-token suppression, dedupe, ordering).
Typecheck (node+web) and full suite green (710 passed). Fully verifiable with no
external mutation, so it needed none.

## Intelligent Dependency & Environment System: restore-from-lock (Stage 6)

Made the Stage-5 lockfile actionable: a Restore that installs the locked version
of every drifted core and library, bringing the environment back to the
snapshot. A new pure helper (`restorePlan(drift)` in src/shared/lockfile.ts)
turns the drift into an ordered install plan - cores first, then libraries, each
at the LOCKED version - and is deliberately conservative: it NEVER uninstalls an
extra (a destructive change the engineer did not ask for) and NEVER reverts the
board target (a deliberate project choice, shown as drift but not touched). So
Restore only appears when there is something it can safely install.

Execution reuses the existing gated, streamed package path rather than a new
one: `runPackageOp` now resolves on the op's actual COMPLETION (a RUN_EXIT
waiter, resolved in handleRunExit) instead of at start, so `restoreFromLock` runs
the installs one at a time, stopping on the first failure rather than pressing on
with a half-applied environment. The drift list the engineer sees is the plan and
the Restore button is the approval - the honesty/safety contract ("never silently
rewrite the environment; propose, then apply") holds, and an AI-initiated restore
would pass exactly the same gate. The Reproducibility panel section gained a
"Restore N" button (N = installable drift count) beside Re-snapshot, disabled
while any op runs; after a restore it re-checks drift and re-inspects.

Verified live against the real arduino-cli: with the lock hand-edited to a
different ESP32Servo version, the panel rendered "1 change since the snapshot",
the changed drift row, and a "Restore 1" button; re-snapshotting cleared the
drift, flipped the status to "In sync with the lockfile", and hid the button.
The mutating install itself was deliberately NOT executed in verification (it
would downgrade a real globally-installed library) - it reuses the installLib/
installCore path proven in Stage 2, now sequenced by the completion-await. 3 new
restorePlan unit tests (in-sync empty, missing+changed at locked version cores-
first, and the non-destructive board/extra case). runPackageOp's completion
semantics change is safe: every renderer caller is fire-and-forget (void), so
resolving later only makes an awaited call more correct. Typecheck (node+web) and
full suite green (700 passed).

## Intelligent Dependency & Environment System: reproducibility (Stage 5)

Gave the environment a lockfile, so it can be reproduced and its drift made
visible. A new pure module (`src/shared/lockfile.ts`) models the lock as an
OBSERVED snapshot - the exact installed cores and libraries (with versions) plus
the board target and MCU - and computes drift between a stored lock and the
current environment. It is deterministic (sorts and dedups so the same
environment always serializes to the same bytes and the file diffs cleanly in
git), clock-free (the gatherer stamps the timestamp), and holds the honesty
line: everything reported is an observed difference, never a compatibility
judgement. `parseLock` validates the untrusted on-disk file (a cloned repo can
ship one) and returns null on any malformed shape.

A thin main-process service (`lockfileService.ts`) owns the file I/O at
`<workspace>/.cortex/cortex.lock.json` and reuses environmentService's shared
single-flight cache for the installed packages and the board MCU, so a snapshot
or check never storms arduino-cli with its own reads. Two workspace-confined IPC
channels (`ENV_LOCK_WRITE`, `ENV_LOCK_CHECK`) expose it. The Environment panel
gained a Reproducibility section: a compact status line (in sync / N changes
since the snapshot, with the snapshot time) and a Snapshot action, expanding to
the concrete differences (board change, missing/changed cores and libraries)
only when the environment has drifted; extras are shown as info, not as
breaking. A completed package op re-checks the drift in lockstep with the
re-inspect, so installing a locked-but-missing library brings the panel back
into sync on its own.

While wiring the MCU into the lock, two real robustness bugs in the Stage-4 MCU
resolver surfaced and were fixed: `arduino-cli board details` is a genuinely
slow (~8s) call, and under contention with the package-snapshot reads it blew
the 12s timeout and returned null; worse, that null was cached, so a transient
timeout suppressed an otherwise-certain MCU fact permanently. The timeout is now
25s, only SUCCESSFUL resolutions are cached (a failure is retried next inspect),
and the lookup is single-flighted per fqbn so a panel mount's concurrent inspect
and lock-check share one board-details call instead of racing two.

Verified live end to end against the real arduino-cli 1.5.1 (esp32:esp32 3.3.11;
three installed cores and three libraries): a snapshot wrote a lockfile
capturing all three cores, all three libraries, the fqbn, `build.mcu` = esp32,
and a timestamp; a check immediately after reported in sync; hand-editing the
lock to a different ESP32Servo version made the check report exactly one
library-changed drift (locked 3.0.0 vs installed 3.2.1) and the panel rendered
"1 change since the snapshot" with the changed row. 15 new unit tests
(lockfile: build determinism, untrusted-shape rejection, and the diff cases),
plus lockCheck added to the workspace-reset guard. Typecheck (node+web) and full
suite green (691 passed). Reviewed adversarially before commit.

This unblocks Stage 6 (restore-from-lock, which installs the locked versions
through the existing gated, streamed package path).

## Intelligent Dependency & Environment System: the Doctor (Stage 4)

The Environment panel became the Environment Doctor: two evidence-based
capabilities added to the reconcile engine, both holding the honesty line that a
strong claim (missing / hardware conflict) must be certain.

1. Build correlation. `extractMissingHeaders` parses the compiler's
   "X.h: No such file or directory" errors, and the engine upgrades an
   `unverified` header to `missing` (certain) only when the build reported it
   not-found, emitting an error finding with a Find-library action. This is the
   certain verdict the static reconcile deliberately withholds; the store passes
   the last build's diagnostics through each inspect, and the panel re-inspects
   when a build finishes, so a failed compile turns "fatal error: Foo.h" into
   "No installed library provides Foo.h" with the source site.
2. Hardware-aware checks. A new curated, conservative module
   (`src/shared/pinCapability.ts`) knows the one board fact it can state with
   certainty: the classic ESP32 die routes GPIO34-39 to input-only pads. The
   engine flags a pin driven as an output (digitalWrite / analogWrite / pinMode
   OUTPUT) on such a pad as a `hardware` finding with the source site, one per
   pad; it makes no claim on a target whose silicon it does not know. Crucially,
   the capability is keyed on the actual MCU (`arduino-cli board details`
   build.mcu, e.g. `esp32`), NOT the board id in the fqbn: several esp32:esp32
   boards (Arduino Nano ESP32 `nano_nora`, the Heltec `*_V3` family) are built on
   the ESP32-S3 die but carry ids with no "s3" token, so a name-based heuristic
   would assert a false input-only claim on them. The gatherer resolves build.mcu
   per fqbn (cached, dropped on package change) and threads it into the engine.

Findings gained optional file/line so the panel shows click-to-source; the
Environment panel renders the missing/hardware findings (red) with the honest
"unverified" explanation surfaced, and a Find-library action for missing headers.

Verified live against the real arduino-cli (esp32:esp32 3.3.11): GPIO34 output
flagged at its source line; a real-format missing-header diagnostic upgraded a
header to `missing` with the Find-library action, while an installed library's
header stayed `resolved`. New unit tests (pinCapability incl. the S3-die
no-false-claim case, extractMissingHeaders, build-correlation and hardware cases
in environment.test); typecheck and full suite green.

A 2-dimension adversarial review confirmed three findings, all fixed before
commit. Stale build diagnostics from a previous board could produce a false
`missing` after a board switch: `setFqbn`/`setBoardAndPort` now clear diagnostics
when the target changes. A basename-only missing match could cross-attribute a
bare `config.h` to a used `vendor/config.h`: the missing match is now full-path
only. And the pin-capability check's fqbn-name heuristic could not be certain
(the S3-die boards above): rekeyed on the real MCU as described.

## Intelligent Dependency & Environment System: the Environment panel (Stage 2)

Made the Stage-1 report real and visible. `arduino-cli lib list` exposes
`provides_includes` per installed library (verified: ESP32Servo advertises 5
headers), so `packageService.normalizeLib` now surfaces it (and architectures)
on `LibPackage`. A new gatherer, `environmentService.ts`, composes the derived
project model + installed cores/libraries + the selected board + arduino-cli
availability into the reconcile input and returns the report over a new
`ENV_INSPECT` IPC channel (workspace-confined like the project-model build); the
slow installed-package reads are cached with a single-flight guard. A new
Environment sidebar panel (activity-bar rail + command palette) renders the
report on the HardwarePanel read-only-analysis template: board/core status,
Diagnostics (evidence-based findings with install actions), per-header
Dependencies (resolved with provider+version / toolchain / unverified, each
click-to-source), and available Updates with risk. Installs/updates go through
the existing gated, streamed `runPackageOp` path.

Verified live end to end against the real arduino-cli 1.5.1 (esp32:esp32 3.3.11;
ESP32Servo + DHT installed): the panel shows core installed, resolves
`ESP32Servo.h` -> ESP32Servo and `DHT.h` -> DHT sensor library, marks `Wire.h`
toolchain and a missing header / `<vector>` unverified.

A 2-dimension adversarial review (9 agents) confirmed four findings, all fixed.
The major one was a freshness-timing bug (self-inflicted by a first-pass
renderer stale-flag that cleared before an install landed, so watching an
install mid-flight left the report stale): replaced with cache invalidation at
op COMPLETION, driven from `packageService`'s stream-close via a callback wired
in main to `environmentService.invalidate` (no import cycle), plus the panel
re-inspecting on any op completion regardless of which panel started it, and a
latest-wins seq guard + service single-flight against concurrent inspects. The
minors: the update-index path now invalidates too; the panel no longer
misattributes an unrelated op's completion to a dropped install (removed the
pending ref, added a call-time running guard); and the library-level
"unverified" explanation is now surfaced in Diagnostics, not dropped. Live
re-verified; unit tests extended (packageService provides_includes guard,
workspaceReset guard); typecheck and full suite green.

## Intelligent Dependency & Environment System: foundation (Stage 1)

Kicked off the initiative to turn package handling from a thin arduino-cli UI
into an intelligence layer over the ecosystem. First a parallel inspection
mapped the five subsystems it must extend (packages/boards, build/toolchain,
project+hardware model, simulator, renderer/store/agent), confirming: two flows
that never talk (arduino-cli package management vs the derived ProjectModel/
hardware graph), no dependency resolution/lock/manifest, no compatibility
reasoning, and the audit's real graph-vs-simulator mismatch. That grounded the
design of record, `docs/implementation/INTELLIGENT_DEPENDENCY_SYSTEM.md` (goals,
non-goals, architecture, data model, honesty-tiered resolution, failure states,
UI, AI, security, caching, reproducibility, testing, extension points, and an
8-slice order).

Stage-1 foundation shipped: `src/shared/environment.ts`, a pure, dependency-free
`reconcileEnvironment` engine that composes what the project declares/uses
(#include headers) against what is installed (cores/libraries) and the selected
board, into an evidence-based `EnvironmentReport` (core-installed status,
per-header dependency tiers, update risk from real semver deltas, and ordered
findings with structured install/update suggestions). Its governing rule is
honesty: it only claims what it can prove. A header is `resolved` (an installed
library declares it provides it), `provided-by-toolchain` (a curated set proven
universal across every target), or `unverified` (cannot prove a provider - a
build confirms); it never emits a static `missing`, which would be a false
positive for a core-bundled or new header.

A 2-dimension adversarial review (15 agents) found a real class of honesty
violations, all fixed: the toolchain set over-claimed on AVR (the C++ STL and
`EEPROM.h` and several libc headers avr-libc lacks are not universal, so
`<vector>` on an Uno was a false green) - the set is now the proven intersection
across cores and the STL/EEPROM fall to `unverified`; the classifier now checks
the library provider first (fixing an ordering bug) and only basename-matches a
header one library provides (no cross-attribution); an empty `installedVersion`
(arduino-cli's not-installed sentinel) no longer reads as installed; when
arduino-cli itself is unavailable the engine reports that rather than a wrong
"install this core"; and `usedAt` de-dupes. The design doc's minor divergences
(a static `missing` tier, the parallel-input-contract vs extend-DTOs principle,
`provides_includes` tracking, a security claim, the cache key) were corrected too.
24 unit tests; typecheck and full suite green. No UI yet: the gatherer service +
Dependencies/Environment panel are the next slice.

## Senior-engineer operating manual as the AI system prompt (Phase 3)

The agent and the chat assistant had short, generic system prompts. Both now run
on a real operating manual, `src/main/prompts/embedded-engineer.md`, that gives
them the discipline of a senior embedded engineer rather than a code vending
machine. It distills the workflows the human engineering process here follows:
the investigation loop (characterize, isolate, hypothesize with falsifiable
hypotheses, test one at a time, fix causes not symptoms), the code-writing
discipline (establish the code needs to exist, reuse, follow the local pattern,
mirror the surrounding code, keep symmetry, default to no comment), the review
lenses applied before proposing (correctness, concurrency/interrupts, timing,
memory, hardware, consistency/simplicity/coverage, each with a failure
scenario), plan-proportionally, verify-before-claiming-done, real embedded-domain
judgment (register/prescaler/ISR/DMA/RTOS reasoning), and two rules above all:
be honest (never fabricate a pin, register, API, or file) and ground every claim
in evidence.

The manual is the single source of truth for both surfaces: the agent's system
prompt is the manual followed by the tool contract, and the chat assistant's is
the manual followed by a no-tools note. It is authored as markdown and inlined
at build with a Vite `?raw` import (ambient-typed in
`src/main/prompts/raw-md.d.ts`), so editing the .md changes both assistants and
there is no runtime file read.

Verified: `?raw` inlines the guide into the built main bundle; a live agent run
(mock provider, user settings preserved) shows the full manual plus the tool
contract reach the model as the system prompt (9705 chars, all sections
present). Typecheck clean, style rules pass. Reviewed for embedded accuracy and
wiring before commit.

## AI engineering agent: the first real tool-loop step (Phase 3 keystone)

The AI panel was a single-shot chat: it answered questions but could not act.
This turns it into a task-oriented agent. The user chose the engine (a
provider-native tool loop with a structured fallback) and the approval
granularity (per-file approve/reject) via AskUserQuestion.

The agent runs a real tool-calling loop in the main process (Anthropic tool use
and the OpenAI tool-calls format; Gemini and unconfigured providers fall back to
a single structured-proposal request). Its scoped tools follow CLAUDE.md's trust
tiers: read_file, search_project, get_diagnostics, and get_project_model are SAFE
and auto-run behind the workspace boundary; propose_edit is REVIEW-REQUIRED and
NEVER writes to disk. It stages a whole-file replacement that the panel renders
as a unified diff; only when the engineer approves it per file does the renderer
apply it, through the same workspace-confined write path a user edit uses
(window.api.writeFile + applyExternalEdit to sync an open tab, undoable via
Monaco's controlled value). Every tool call is surfaced in the transcript, so a
run is auditable.

Security: tool paths resolve against the trusted main-process workspace root
(never a renderer-supplied path) and are confined with fsService.withinWorkspace;
no model output ever reaches a shell; the API key stays in main; the loop caps
at MAX_AGENT_STEPS; cancel stops it between steps; a workspace switch cancels the
run and clears the transcript, staged edits, and conversation (dropped by run id
if any events arrive late).

Pure logic is unit-tested and shared: agentTools.ts (tool schema, provider
adapters, the fallback JSON parser that tolerates fences/prose and ignores braces
in strings) and diff.ts (LCS line diff + collapsing hunks + a too-large guard).
The renderer view (AgentView + DiffView) lives beside the existing chat behind an
Agent/Chat toggle.

Verified live end-to-end via CDP against a mock OpenAI-compatible server (so no
real provider was needed and the user's settings were preserved, key untouched):
the loop ran read_file then propose_edit, staged exactly one PENDING edit with
nothing written to disk, and only after approve did the file on disk change to
the proposed content; the transcript rendered the tool chips and a themed unified
diff with Approve/Reject. Unit tests for agentTools and diff; workspaceReset guard
extended to the agent state.

A 3-dimension adversarial review (17 agents) ran on the diff; all eleven
confirmed findings were fixed. The critical one: approve blindly wrote the
propose-time snapshot, silently discarding unsaved editor edits or a change made
since the proposal, now approve first re-reads the file and refuses (marking the
edit "stale") if the on-disk content changed or the tab is dirty, rather than
clobbering (verified live: an out-of-band change is kept and the agent edit is
refused). The majors: string-only workspace confinement let a symlink escape via
the un-gated read_file, now the path is verified with realpath (physical
confinement) before any read or staged write; a CRLF file diffed as fully changed
and was rewritten to LF on approve, now the diff is line-ending tolerant and the
write preserves the file's existing EOL (verified live: a CRLF file stays CRLF);
plain cancel left the in-flight run streaming into the transcript, now it clears
the run id (and the loops check cancellation after each request) so late events
are dropped; the large-file path told the user to approve before reviewing, now
it warns, and a rewrite that drops most of a file shows a truncation warning; and
the O(n*m) line diff, recomputed twice per render on every streamed event, is now
memoized and single-pass. The minors (tool-chip ok flag, fallback conversation
history, a refreshTree failure mislabeling an applied edit, double-click writing
twice, and a trailing-newline-only change) were all fixed too. Re-verified: full
suite green, targeted diff/agentTools tests extended.

## Integrated terminal: a real pty-backed shell (Phase 1)

The audit's most-cited P0 (nine users, "back to VS Code within the hour"):
Cortex had no shell, so esptool, idf.py, pip, git, and custom scripts were
impossible in-app. Added a real pty-backed terminal (node-pty + xterm.js), the
execution model the user chose over a command-allowlist runner. A user-typed
terminal is user-authorized: it spawns the user's own shell (PowerShell on
Windows, $SHELL/bash on posix) at the user's own privileges, with the open
workspace as the cwd. The security boundary is explicit and preserved: the shell
is spawned as file + argv (never a shell string), the cwd is chosen in the main
process from the trusted workspace root (never a renderer-supplied path), IPC
inputs are validated, sessions are capped, and every shell is killed on window
close and before quit. AI-initiated commands do not flow through this terminal;
they stay behind the allowlist / approval gate for the agent slice.

Architecture: the pure shell/dimension logic is a unit-tested shared module
(`src/shared/terminalConfig.ts`). The pty sessions live in a main-process
service (`terminalService.ts`), loaded lazily as an optional native dependency
so a machine without the prebuilt binary still starts (the terminal reports
unavailable). The xterm view and its session live in a module-level controller
(`terminalController.ts`) outside React, so a running `pio run` survives every
way the bottom dock unmounts (tab switch, panel close, simulator switch); the
controller re-parents a persistent wrapper into whatever host mounts. node-pty
is a native module: `externalizeDepsPlugin` does not externalize
optionalDependencies, so it was being bundled and its loader could not find its
binary; the vite config now externalizes it (and serialport) explicitly.

Reachable from Tools > Terminal, the command palette, and Ctrl+` (which now
toggles the terminal, VS Code style). On a workspace switch the shell is
disposed after the root switch commits and respawns in the new project's cwd;
on Close Folder it is disposed with no stray shell. xterm.js is lazy-loaded so
it stays out of the startup bundle.

Verified live via CDP against a real workspace: the terminal spawns PowerShell
in the workspace cwd; a typed `echo` round-trips renderer -> main -> pty ->
xterm; exactly one shell survives a tab round-trip and a panel close/reopen with
scrollback intact; switching projects respawns a fresh shell in the new cwd with
no stale prompt; closing spawns no stray shell. Unit tests cover the pure
config, the service security invariants, and the controller supersession logic;
the workspaceReset guard was extended to assert terminal teardown.

A 3-dimension adversarial review (12 agents) ran on the diff; all confirmed
findings were fixed and re-verified, and four false positives were rejected
(single-window session-id ownership, output coalescing, a create-reject stuck
state, and electron-builder packaging). The findings: (1) a race, `start()` had
no supersession check across its async `create()`, so a workspace switch or
close mid-spawn could orphan a shell or double-spawn one, fixed with an epoch
captured before the await and re-checked after (the superseded start kills its
just-spawned pty and bails; dispose bumps the epoch); (2) the terminal entry
points (Ctrl+`, Tools, palette) silently no-opped from the simulator view and
with no workspace open, fixed with an `openTerminal()` action that leaves the
simulator and requires a workspace (the menu item is disabled without one); (3)
the Output tab wore the ">_" shell glyph while the real Terminal tab got the
boxed one, now swapped. A related robustness gap found during verification (a
renderer reload leaks the old ptys, since a reload never runs killAll) was also
closed by reaping terminal sessions on the renderer's next top-level load.

## First-run compiler wall: a friendly, actionable state (Phase 2)

Audit P0: New Sketch opens the Simulator, which compiles the sketch on the host,
so on a machine with no g++/clang++ it dead-ended with five cryptic lines (a raw
winget command among them) in the serial pane. Now startSim sets a structured
`simBlock` and the simulator stage shows a friendly SimBlockedPanel: a headline,
a per-OS install command with a Copy button, a follow-up note, a Recheck button
(re-scans the toolchains and runs if a compiler is now found), and a
documentation link. The OS/command mapping is a pure, unit-tested module
(`src/shared/compilerHelp.ts`). The not-a-sketch case uses the same friendly
panel instead of serial text.

Verified live: forcing the compiler-missing state shows the panel with the
Windows winget command, Recheck, and MSYS2 link; Recheck (with g++ present)
clears the block and runs the sim. 6 compilerHelp unit tests; workspaceReset
guard extended to 52; full suite green. Designed with the Taste-Skill honoring
the existing dense IDE tokens.

A 2-dimension adversarial review ran on the diff; all confirmed findings were
fixed and re-verified. The main one was a real regression: the block was cleared
only on a run or a workspace switch, so switching files left the full-height
panel plastered over a now-valid sketch, with a message that could even name a
file you had already closed. The fix ties the block to the file that raised it
(`SimBlock.path`) and renders the panel only while that file is active, so
switching tabs reveals the canvas and switching back shows the same accurate
message (verified live: the not-sketch panel appears over its file, disappears
on switching to another, and reappears on switching back). The follow-ons: the
"Add a part" wiring hint no longer overlays the blocked panel and the part
palette is disabled while blocked (parts would land on a hidden canvas); and
`detectOS` now tests mac/darwin before windows (the substring "win" inside
"darwin" had made the darwin branch dead code, so a Darwin user agent was
misread as Windows). Both the block-follows-its-file behavior and the Darwin
case are now guarded by unit tests.

## Board Manager URLs: install the ESP32 core in-app (Phase 2)

Audit P0: an ESP32-focused IDE could not install the ESP32 core because there
was no way to register arduino-cli board-index URLs, so only Arduino-maintained
cores appeared. Added a persisted `boards.additionalUrls` setting, pre-seeded
with the Espressif ESP32 and ESP8266 index URLs, threaded into every core
command (search, list, install, update-index) as a single joined
`--additional-urls` argument (a hostile entry can never be read as a separate
flag; only http/https URLs pass). A Settings section lists the URLs with add/
remove. The pure URL logic lives in `src/shared/boardUrls.ts` and is unit-tested.

Verified live: `arduino-cli core search esp32 --additional-urls <esp32>` and the
app's own `coreSearch('esp32')` now return `esp32:esp32` (the real Espressif
core), which was absent before; the seeded URLs show in Settings. 7 boardUrls
unit tests; full suite green (565).

A 3-dimension adversarial review ran on the diff; all confirmed findings were
fixed and re-verified: URL validation now rejects commas/whitespace (a comma is
arduino-cli's own --additional-urls separator, so a comma inside one entry could
have smuggled a non-http index of any scheme past the http/https check);
coreSearch falls back to a search without the extra URLs when an added or
uncached index is unreachable, so a bad or offline URL no longer empties the
whole Boards Manager (verified: with an unreachable URL, `avr` still lists 7
built-in cores); the add/remove handlers read the current URL array from the
store to avoid a stale-closure race; and the settings hint no longer overstates
a manual Update Index step (a new URL takes effect on the next search/install).

## Split / draggable editor tabs (Phase 1)

The requested feature: with two files open, drag a tab to the side to view both
side by side (like VS Code / JetBrains / Visual Studio), and drag tabs to
reorder. Implemented as two editor groups (panes). The layout logic is a pure,
unit-tested module (`src/shared/editorGroups.ts`): each tab carries a group (0
or 1); `resolve()` keeps the invariants (collapse the split when a group
empties, cluster, repair each group's active tab, keep the active group
non-empty), and open/focus/close/move/reorder are pure transitions. The store
delegates to it; `openFile`, `setActive`, and `closeTab` are unchanged in
behavior for the single-pane case. `EditorArea` renders one or two panes with a
Splitter between them, HTML5 drag-and-drop (draggable tabs, an accent-tinted
drop overlay, drag-to-edge to split), and a focus indicator on the active
pane's tab. `CodeEditor` tracks editor focus so the format/rename actions target
the focused pane.

Verified live against EdgeInspect: opening main.cpp and main.py and moving one
to the second group renders two Monaco editors side by side, each 480x327 with
its own content; collapsing returns to a single editor. 18 editorGroups unit
tests, workspaceReset guard extended, full suite green. Designed with the
Taste-Skill (redesign-skill) honoring the existing dense IDE tokens, not a
generic redesign.

A 4-dimension adversarial review ran on the diff; all confirmed findings were
fixed and re-verified live: renameEntry/deleteEntry now route through the group
resolver (a renamed open file no longer blanks its pane; a deleted file no
longer strands the active group or re-splits on the next open); dropping a tab
onto an editor no longer injects the file path into the document (custom drag
mime + Monaco drop-into-editor disabled); the unsaved-changes tab dot that the
user had removed is not re-added; the focused editor now follows the active
file so Format/Rename and Save target the same pane; the single-tab split
affordance is gated so it is never a no-op; and reorder honors the pointer
(before/after the target).

## Library member/class autocomplete + clangd include config (Phase 2)

The reported gap: with ESP32Servo.h included, `Servo myservo; myservo.` offered
nothing and `Serv` did not suggest the `Servo` class. Root cause: clangd, run
under the host toolchain, cannot find the library's headers, so it cannot
resolve library types (the same reason find-references and go-to-definition
returned nothing in ESP32 projects). Two complementary fixes:

1. clangd include configuration (`clangdConfig.ts`): `discoverIncludeDirs`
   finds the project's own include/src and every library under lib/ and
   .pio/libdeps, and feeds them to clangd (project dirs as -I, vendored
   libraries as -isystem so their internal warnings stay quiet). PlatformIO
   deps are added first and all loops are capped.
2. A curated hardware-library dictionary (`src/shared/stdlib/cpp-libraries.json`,
   seeded with the full ESP32Servo `Servo` API from the real header) plus
   scope-aware completion (`src/shared/libraryComplete.ts`): infers a variable's
   type from its declaration in the same file (value, reference, and pointer
   styles) and offers that class's members with signatures, descriptions, and
   documentation links (the Roblox-style popup). It defers to real clangd
   members when clangd resolved the class (dedup on the bare name), so it
   supplements and never duplicates.

Verified live against EdgeInspect: `servo.` and `Servo *sp; sp->` both list all
13 Servo members with descriptions and no duplicates; `.clangd` now carries the
project and ESP32Servo include dirs. 41 targeted tests; full suite green.
A 4-dimension adversarial review ran on the diff; its confirmed findings (dedup
keyed on the signature-bearing label, the pointer-sigil regex gap, per-request
full-document scans, comment/string-unaware scanning, and hover over-broadening)
were all fixed before commit.

Unblocks: the same include config makes clangd resolve more library symbols
(better real completion/references/definition over time); the dictionary is
grown by the recurring agent for more libraries.

## Close Folder / switch workspace (Phase 1)

Added a `closeWorkspace` store action and File-menu + command-palette entries.
Closing saves all dirty tabs first, then runs the same teardown as a project
switch (stop run/sim/debug, stop the file watcher, dispose the root's language
servers), applies the full workspace reset, returns the main view to the editor
so Welcome shows, and forgets the last workspace so it is not reopened on next
launch.

Verified live: open project, Close Folder returns to the Welcome screen with
tabs/tree cleared and the last-workspace key removed; reopening restores the
project. Typecheck clean; workspaceReset suite extended to 47 tests (a new
closeWorkspace block asserting save-before-teardown, full reset, process/watcher/
server teardown, and return-to-Welcome).

Unblocks: a user can move between projects without restarting the app (explicit
request); the teardown path is shared groundwork for multi-root later.

## Editor actions + trust cleanup (Phase 0 / Phase 1 start)

Wired real LSP rename, find-references, and document-formatting providers over
the existing LSP bridge; the previously-dead Auto Format menu item now formats
C/C++ and Rust. Made the advertised menu accelerators real global shortcuts
(Ctrl+O, Ctrl+comma, Ctrl+Shift+M, Ctrl+Shift+I, Ctrl+T). Added the four editor
actions to the command palette. Replaced the decoy status-bar git-branch icon
with a folder icon. Rename applies correctly across files (active file undoable
via Monaco, other clean files rewritten on disk with open tabs synced, dirty
cross-file targets refused with a clear message). Extracted the edit-application
into a pure, unit-tested shared helper (`src/shared/textEdit.ts`) reusable by the
future agent file-edit tool.

Verified: formatting reflowed a real file live through clangd (Monaco has no
built-in C++ formatter, proving the new provider + bridge path). Typecheck clean,
full suite green (507 passed), textEdit helper unit-tested (7 cases).

Unblocks: the file-edit-with-diff step of the AI agent (Phase 3) reuses the
edit helper; the references/goto gap it exposed points directly at the clangd
include-config work (Phase 2).

## Hardware graph + Hardware panel

Bus and include scanning added to the project model; `src/shared/hardwareGraph.ts`
derives a board/pin/bus/device/file graph with provenance edges and a strictly
gated bus-attachment inference. New Hardware sidebar panel with click-to-jump.
Verified live against a real ESP32 project; 18 graph tests plus adversarial
multi-agent review of the diff.

## Project model

`buildProjectModel` derives languages, board (from platformio.ini only), and
GPIO pin usage, excluding vendored dirs. Feeds the AI context and a status-bar
board indicator. Tested.
