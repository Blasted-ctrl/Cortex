---
status: done
date: 2026-10-11
---

# Cortex library documentation ownership

## Context

The Markdown audit's fourth executable item is misleading supplemental library documentation. The renderer currently indexes standard-library descriptions by bare name, so a user-defined `clear` or `size` can receive vector documentation. A broad text hint also mislabels functions as standard-library functions when only their return type, parameter or prose mentions `std`. Hardware hover selects the first matching receiver on a line rather than the receiver at the cursor. Preserve the current compact IDE, insertion behavior and authoritative language-server text while correcting those narrow presentation defects.

Bounds are one local Electron installation, model-local asynchronous language-server requests and externally maintained finite dictionaries. Customer rollout remains subject to CONSTRAINTS.md; no multi-user service or full C++ semantic parser is introduced. The preceding file-ownership source stays frozen until its owned native checks close. No dependency upgrade, new IPC/request, dictionary expansion, provider credential, customer-project write, hardware operation or release belongs to this change. Unknown provenance remains unknown, even when that means showing less supplemental prose.

## Acceptance criteria

- A supported, explicitly qualified C++ completion naming a curated vector member or chrono symbol receives only that owner's supplemental description and standard-library badge. Bare names, foreign owners, contradictory owners and unsupported declaration shapes preserve server documentation without the guessed badge.
- A standard-library name in a return type, parameter, example, opaque completion data or explanatory prose alone cannot establish the completed symbol's owner. Python and Rust completions remain server-authored unless a trusted origin contract is separately established; no such contract currently exists here.
- Initial and richer resolved server documentation survive later omitted or null resolution. Explicit blank documentation clears the accepted raw prose rather than resurrecting an older response. Contradictory explicit ownership removes previously supplemental prose and the badge. A cancelled or superseded resolution cannot change the item's accepted documentation, detail or additional edits.
- Stdlib hover preserves nonempty server text without a bare-name dictionary lookup; unresolved stdlib hover stays absent. The hardware fallback remains available only for a genuine code word and its immediate simple receiver at that cursor, with an included header and existing known-type inference.
- For `servo.write(...); widget.write(...)` on one line, hovering either word uses that word's receiver rather than the earlier call. Comments, strings, raw/unfinished literals, chained, namespace-qualified, call and subscript receivers do not acquire guessed hardware hover. Dot/arrow, whitespace, CRLF and supplementary Unicode retain correct cursor offsets.
- Genuine angle and quoted headers allow existing hardware help; commented/string/raw-string pseudo-includes do not. Whole-file known-type inference remains deliberately limited: this change does not establish local shadowing, aliases, conditional include evaluation or general C++ scope resolution.
- Existing auto-includes, call snippets, kinds, cancellation and initial/resolved additional edits remain intact. Documentation describes the conservative capability and unsupported cases without claiming every server payload is enriched or every library is supported.

## Pattern Survey

### Analogous Features

- `src/shared/libraryComplete.ts:41` - `indexLibraries` retains each class's originating header alongside its definition.
- `src/renderer/src/lsp/lspClient.ts:67` - Completion origins retain the original LSP response and document in a private WeakMap for lazy resolution.
- `src/renderer/src/lsp/lspClient.ts:261` - Library scans are cached per model version instead of repeatedly scanning unchanged buffers.
- `src/shared/cppAutoInclude.ts:138` - Auto-include planning uses separate code-masked and comments-only views to identify genuine directives while retaining quoted header text.
- `test/lspCompletionEdits.test.ts:54` - Tests capture actual registered completion providers and exercise initial edits, lazy resolution and cancellation through the renderer API boundary.

### Reusable Utilities

- `src/shared/cppAutoInclude.ts:64` - `maskNonCode` - Private, pure lexer preserving UTF-16 offsets and newlines while masking comments and literals, including unfinished literals; not yet a shared export.
- `src/shared/libraryComplete.ts:65` - `includedHeaders` - Collects normalized header basenames from include directives.
- `src/shared/libraryComplete.ts:87` - `inferKnownType` - Recognizes known class declarations anywhere in the supplied text; deliberately lacks lexical-scope and shadowing resolution.
- `src/shared/libraryComplete.ts:113` - `librarySuggestions` - Uses an end-anchored receiver/operator pattern on the cursor's line prefix.
- `src/renderer/src/lsp/lspClient.ts:188` - `stdlibIndex` - Caches dictionary entries, but currently flattens raw library keys into bare-symbol keys.
- `src/renderer/src/lsp/lspClient.ts:121` - `contentsToMarkdown` - Preserves server text for display; array entries currently lose their language tag during conversion.
- `node_modules/monaco-editor/monaco.d.ts:1558` - `IWordAtPosition` - Installed Monaco 0.52.2 exposes the selected word's start/end columns.
- `node_modules/monaco-editor/monaco.d.ts:2129` - `ITextModel.getOffsetAt` - Converts model positions into zero-based offsets; the implementation validates positions before accessing the text buffer.

### Convention Anchors

- Pure shared C++ helpers: auto-includes and library completion logic live under `src/shared`, with dependency-free tests in `test/cppAutoInclude.test.ts` and `test/libraryComplete.test.ts`.
- Authoritative server text: `lspClient.ts` keeps server documentation below supplemental material; insertion text, snippets, kinds and additional edits have separate handling.
- Finite dictionary ownership: `cpp.json` has vector/chrono; `python.json` has time/os/random; `cpp-libraries.json` contains header-owned Servo. No trusted origin field currently accompanies those dictionary matches.
- Provider-test boundary: `test/lspCompletionEdits.test.ts` exercises the actual provider but mocks every dictionary empty. `test/libraryComplete.test.ts` uses real Servo data through pure helpers, not the registered hover provider.
- Local inference limitations: `libraryHover` currently searches the entire line's first matching receiver; class lookup occurs before member lookup. Existing declaration inference is not a global scope parser.
- Upstream design evidence only: [LSP completion](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/language/completion.md) has no required owner field and keeps data opaque. [clangd rendering](https://raw.githubusercontent.com/llvm/llvm-project/main/clang-tools-extra/clangd/CodeComplete.cpp) can place return types in detail; [Pyright information](https://raw.githubusercontent.com/microsoft/pyright/main/packages/pyright-internal/src/languageService/completionProvider.ts) is conditional. These sources were read, but no local server payload was observed. They do not establish installed-version compatibility.

### Proposed Alignment

Follow the existing owner-preserving dictionary and private completion-origin patterns, while keeping unsupported provenance unchanged rather than guessing from bare names or incidental type text. Blend Monaco's selected-word coordinates with the existing offset-preserving lexical masking and versioned scan cache for cursor-specific hardware hover. These patterns leave explicit ownership matching, partial-resolution preservation and provider-level documentation coverage to be established without assuming universal server payload shapes or full C++ scope analysis.

## Implementation steps

1. Reuse the existing lexer without changing auto-include behavior.
   - Mechanically move private `maskNonCode` from `src/shared/cppAutoInclude.ts` into new `src/shared/cppLexical.ts` as new `maskCppNonCode`; preserve both modes and update every existing internal call in `cppHeadersForChanges` and `planCppAutoIncludes`.
   - Keep existing auto-include assertions unchanged. Add direct lexical controls for offsets/literals only where the existing tests do not pin them. No parser or editor policy changes belong to this extraction.
2. Preserve dictionary ownership inside the LSP presentation layer.
   - Move the existing stdlib formatting/index responsibilities from `src/renderer/src/lsp/lspClient.ts` into new `src/renderer/src/lsp/stdlibDocumentation.ts` rather than growing the already large provider module.
   - Keep library and symbol together. Add one new narrow C++ completion-owner matcher consumed by both `friendlyDetail` and documentation enrichment; recognize supported qualified labels and complete qualified declarator names in detail, not nearby qualified types. Unknown, multiple or foreign evidence remains raw. Unsupported templates/presentation prefixes may remain raw; do not invent a universal upstream payload shape.
   - Remove the broad `STD_LIB_HINT` inference and bare-name stdlib hover enrichment. Retain variable/field/property/constant friendly details, server documentation, snippets and existing insert/additional-edit behavior. No Markdown signature parser is introduced for hover.
3. Retain accepted raw completion state through lazy resolution.
   - Extend the existing private `completionOrigin` record, not a new registry, to retain effective raw server detail/documentation separately from rendered supplemental Markdown. Its initial provider creates the record; the owning noncancelled resolution alone commits accepted raw fields and presentation; the WeakMap key's lifetime releases it.
   - Use a small latest-resolution token in that record for same-item overlapping requests. Clear it in finally only if the record still holds that exact token; an older request cannot clear a newer request's owner. Reject superseded/cancelled results before any item or raw-state mutation. Keep the initial raw request payload used by completionItem/resolve unchanged, including opaque data.
   - Null responses and omitted documentation preserve the latest accepted raw documentation; explicit blank documentation replaces it with blank. Explicit conflicting owner evidence must not be merged away or hidden by prior qualified evidence. Recompute supplemental Markdown and badge from accepted evidence and raw text, never from already enriched Markdown, and explicitly replace stale displayed values even when the new raw result is empty.
4. Make hardware hover cursor-specific using the same lexical view.
   - Replace the existing versioned `libScan` result's regex-stripped `clean` text with the offset-preserving code mask. Route that same code view to `librarySuggestions` and `inferKnownType`, not only cursor checking: a raw literal containing a fake declaration cannot infer a hardware receiver type. Gate genuine include directives with that code view and read their header names from the comments-only view; do not run include detection against either view alone.
   - In `libraryHover`, reject a masked/changed cursor word before class lookup, then anchor simple receiver matching to the selected word's start using the installed model offset/column API. Reject compound receivers instead of selecting their final identifier. Retain existing known-type/header/member checks and raw server hover below valid hardware fallback.
   - Keep known-type inference narrow and its scope/shadowing limitation explicit, correcting its current claim that a false match cannot invent a wrong type. This is no new C++ semantic engine.
5. Pin actual provider behavior and update capability documents.
   - Add new `test/lspDocumentation.test.ts` with nonempty real stdlib/hardware dictionaries and the actual registered completion/hover providers. Substitute the renderer's LSP transport and Monaco host only, not enrichment, scanning, matching or resolution producers.
   - Retain the complete existing `test/lspCompletionEdits.test.ts`, `test/libraryComplete.test.ts` and auto-include suites. Update `docs/LSP.md`, `docs/STDLIB-DICTIONARY-WORKFLOW.md` and the task/validation ledgers to distinguish supported synthetic payload handling, actual desktop visibility and unobserved server/version compatibility.

## Verification

- New actual-provider cases discriminate qualified vector/chrono positives from bare user/map names and qualified return/argument/prose negatives; opaque data must not qualify ownership. Assert exact retained raw documentation and the right-aligned detail, not only substring presence. Python shadowing and Rust incidental std text remain raw.
- Resolution cases cover initial proof to partial/null response, richer resolve to null response, explicit blank then null response, new proof during resolve, contradictory owner and cancelled response. Deferred overlaps cover both orders: A starts, B starts, A finishes, B finishes; and B finishes before A. Only B may commit, and A's finally cannot clear B's owner. Retain exact initial/resolved additional edits and request data, with no duplicate supplemental block.
- Hardware hover cases cover both same-line receivers in both orders, dot/arrow/whitespace, unknown receiver/header absence, comments/strings/raw/unfinished literals, compound receivers, class hover, quoted/angle headers versus fake includes, CRLF and supplementary Unicode offsets. Include a real header with a fake Servo declaration inside a raw literal containing an unmatched internal quote, followed by a genuine code `fake.write()`; inference must not leak from the literal. Assertions read actual returned provider documentation; no other fixture producer supplies it. A source-read-only Node/transpile observation found the simple balanced raw example already masked, but the unmatched-internal-quote and unfinished variants distinguish the existing regex from the existing lexical masker; this is not an actual server observation.
- Run the existing auto-include and completion-edit suites against the actual moved helper and registered providers. A faithful owner/receiver condition omission must make its discriminating regression fail, with exact source restored before final verification.
- Existing types, complete regression/style and desktop/tools build remain gates. Rebuilt owned native editor checks should retain actual hover visibility and a normal completion/insertion control; use isolated fixtures and no customer files, provider credentials or hardware. Missing native setup or unsupported server provenance remains unverified rather than an invented pass.
- Repeated supported firmware traces, broken/hanging self-tests, environment-labelled advisory benchmark and the unchanged inclusive audit remain separate regression/release evidence; none establishes universal language-server support or release approval.

## Context files

- `AGENTS.md`, `CONSTRAINTS.md` - ownership and unchanged quality floor.
- `src/renderer/src/lsp/lspClient.ts` - provider consumers, raw origins and scan cache.
- `src/shared/cppAutoInclude.ts`, `src/shared/libraryComplete.ts` - existing lexical and known-type inference contracts.
- `src/shared/stdlib/cpp.json`, `src/shared/stdlib/cpp-libraries.json` - finite curated owners and supported hardware entries.
- `test/lspCompletionEdits.test.ts`, `test/libraryComplete.test.ts` - actual provider and pure helper test conventions.
- `docs/LSP.md`, `docs/STDLIB-DICTIONARY-WORKFLOW.md` - capability and recurring curation claims.

## Completion evidence

Source `8b93a74` follows mechanical extraction `2bafd3c`. Test-first failures,
faithful owner/receiver omissions, an independently found raw-completion-prefix
defect and its six red regressions precede final 182 focused passes. Actual
read-only peer review converges. Final Node 22.20.0 types/build and full 112-suite
regression pass (2138 tests, five unchanged skips), as do serial firmware,
negative self-test and advisory benchmark. Genuine clangd 22.1.8 desktop hover,
completion and exact save controls pass in an owned project/profile; all five
screenshots and cleanup evidence are inspected. See docs/RELEASE-VALIDATION.md
for exact boundaries, hashes, retained failures and external release blockers.
The audit still fails at 17 findings (seven high). No fresh-install, universal
server support, customer release or later push is claimed.
