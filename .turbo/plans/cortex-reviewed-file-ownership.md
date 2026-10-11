---
status: done
date: 2026-10-11
---

# Cortex reviewed file and Git reconciliation ownership

## Context

The complete Markdown audit identifies two existing file-integrity gaps: an empty AI proposal original is mistaken for reviewed absence, and delayed Git-triggered tab reads can replace a newer clean editor instance. Preserve the current compact IDE and existing reviewed-edit/Git workflows while closing these gaps. This follows the workbench checkpoint; implementation starts only after its discovered native BOM save defect is corrected and its actual save path is verified.

Deployment is one local Electron application with asynchronous renderer/main calls, editable files also changed by external programs, and no distributed writers or durable proposal store. Main derives file facts; existing workspace generation and exact object ownership protect renderer continuations. No new persistence schema, concurrency framework, provider call, customer repository mutation, hardware operation, dependency migration or release is part of this change. Exact bytes and physical workspace admission remain required; comparing bytes is not an OS-level atomic filesystem compare-and-swap.

## Acceptance criteria

- A reviewed existing empty file must not be recreated if deleted, even when it has no open editor tab. A reviewed absent target must not overwrite a file created afterward, including an empty one.
- New proposals represent original existence from the actual main-process read. Only actual ENOENT establishes absence; unreadable, binary, oversized and refused paths never become approvable creations. Model-supplied fields cannot invent this evidence.
- A valid reviewed creation and a valid reviewed existing-empty replacement still succeed. Legacy proposals without existence evidence may modify matching nonempty existing text; ambiguous empty originals require a fresh proposal and cannot create a file. Existing pending proposals are memory-local; no stored migration is required.
- The review card labels only explicit reviewed absence as a new file. Empty existing and unknown originals are not labeled new. Existing error/status/rejection behavior remains.
- Bulk Git reconciliation changes only the original clean tab in the original workspace lifetime. Closing/reopening, editing/saving, workspace A-to-B-to-A or a later reconciliation must invalidate an older read's success and error continuations.
- A confirmed missing file may close its owned clean tab. Only an ENOENT errno prefix, optionally inside Electron's fs:readFile error envelope, establishes missing-file evidence; ENOENT in a quoted path or other error text does not. Other read failures preserve the tab and report failure. Dirty buffers remain untouched and normal clean reloads still adopt disk changes.
- A delayed close waiting for a save must not close a replacement tab. Existing discard-confirmation ownership remains intact.
- Switch/create/pull completion from an older workspace lifetime must not reload files, refresh state or publish success into the current project. Mutations remain serialized through their owned post-operation reconciliation, not merely through gitStatus. Confirmation and dirty-buffer checks remain required.
- Document the changed review-card and file-reconciliation behavior, including conservative legacy handling and remaining limits. Record observed verification without presenting fixture success as production-release evidence.

## Pattern Survey

### Analogous Features

- `src/main/services/fsService.ts:186` - Guarded saves distinguish absent (`expectedContent: null`), existing empty (`''`), and unchecked (`undefined`) targets; only Node `ENOENT` establishes absence.
- `test/filePersistence.test.ts:151` - Owned real-filesystem tests reject deleted-file recreation and unexpected target creation, including changes during staging.
- `src/renderer/src/store/useStore.ts:2364` - AI approval uses exact proposal identity, workspace root and `workspaceGeneration` across awaits; tab lifetime tracking prevents adopting results into a closed/reopened editor.
- `test/agentEditApprovalStore.test.ts:275` - A deferred approval read is invalidated when the same project is closed and reopened.
- `src/renderer/src/store/useStore.ts:1355` - `closeTab` checks root/generation after waiting for saves and exact tab identity after discard confirmation.
- `test/workspaceSessionStore.test.ts:167` - Delayed confirmation cannot remove newer edits or a reopened tab.
- `src/renderer/src/components/VcsPanel.tsx:91` - Diff, status and branch reads use separate generation counters; workspace-effect cleanup invalidates their older responses.
- `src/main/services/gitService.ts:199` - Backend mutations validate repository ownership before spawning, serialize operations, use a fixed repository cwd and enforce a timeout.

### Reusable Utilities

- `src/main/services/agentService.ts:177` - `execTool` - Common proposal producer for provider loops and structured fallback; its `PROPOSE_EDIT` branch computes `isNew` but omits it from the emitted proposal.
- `src/shared/ipc.ts:644` - `AgentStagedEdit` - Shared path/text/error contract; original existence is currently unrepresented.
- `src/renderer/src/store/useStore.ts:280` - `AgentEdit` - Renderer review state wraps proposal content and identity; it also lacks original existence.
- `src/preload/index.ts:227` - `onAgentEvent` - Transparent typed event subscription, forwarded by `App.tsx:111`.
- `src/renderer/src/store/useStore.ts:2325` - `handleAgentEvent` - Rejects superseded runs and retains proposal fields through object spreading.
- `src/main/services/fsService.ts:114` - `readFile` - Distinguishes text, binary and oversized data; existing empty files remain text. `exists` at line 149 is only an optional-file probe because it suppresses every access error.
- `src/renderer/src/store/useStore.ts:858` - `workspaceGeneration` - Existing store-local lifetime fence; root-transition subscription at line 2979 observes transitions independently of React rendering.
- `src/renderer/src/store/useStore.ts:1391` - `reloadOpenTabsFromDisk` - Existing bulk reconciliation preserves dirty buffers, but currently accepts any clean same-path tab after a read and treats every read failure as deletion.
- `src/renderer/src/components/VcsPanel.tsx:181` - `doOp` - Existing serialization boundary checks root before the operation, but performs its subsequent refresh without an operation-lifetime check.

### Convention Anchors

- Main-derived evidence: `agentService.ts:240` reads original file state independently of model input; `src/shared/agentTools.ts:102` exposes only replacement path/text/summary.
- Error boundaries: main filesystem guards inspect actual errno codes; renderer approval recognizes Electron's serialized `ENOENT:` message at `useStore.ts:2400`.
- Raw-versus-review text: approval compares normalized EOLs for review but supplies exact current bytes to `writeFile` at `useStore.ts:2424`; native filesystem approval tests retain BOM/CRLF and external edits.
- Review presentation: `AgentView.tsx:214` currently infers "new" from empty original text, sharing the provenance ambiguity.
- Local async ownership: store operations use root/generation/object identity; VCS reads use component-local generation refs. These are existing narrow patterns, not a shared asynchronous framework.
- Git completion consumers: switch, branch creation and pull call bulk reload after `doOp` at `VcsPanel.tsx:265`, `295` and `324`; their current callbacks can reach the newly current workspace after an older operation finishes.
- Test layering: `gitService.test.ts` exercises owned repositories and local remotes; `gitCommandSafety.test.ts:81` covers project change during discovery. Existing store tests cover pending saves and delayed close confirmation, but no direct mounted-VCS stale-completion or bulk-reload ownership suite was found.
- Evidence boundary: these are baseline source-confirmed contracts and gaps; no new tests or native race observations were performed.

### Proposed Alignment

Follow the existing typed main-to-renderer proposal flow, nullable file snapshot semantics, and local generation/exact-owner fences. Those patterns leave reviewed existence, conservative legacy-proposal handling, and Git-triggered post-await workspace/tab ownership to be represented explicitly. Keep both fixes within their existing service, component and store boundaries rather than introducing a cross-application async framework.

## Implementation steps

1. Represent main-derived reviewed existence in the existing proposal contract.
   - Extend `AgentStagedEdit` in `src/shared/ipc.ts` and renderer `AgentEdit` in `useStore.ts` with an optional `originalExists` field. Document omitted evidence as unknown, not absent.
   - In `agentService.ts`'s common `execTool` proposal branch, use the actual `fsService.readFile` outcome rather than its permissive `exists` probe. Successful text reads set existence true; only actual Node ENOENT sets it false. Retain refused/nontext/error behavior, workspace resolution and common provider/fallback routing.
   - Existing preload/App forwarding and `handleAgentEvent` spreading must retain the field; no new IPC channel or model tool argument is introduced.
2. Enforce the reviewed fact at approval and presentation.
   - In `approveAgentEdit`, require both existence and reviewed text to match the current target before writing. Retain null-versus-empty native expected snapshots, disk-derived BOM, exact saved bytes and all current generation/proposal/typing guards.
   - Fail ambiguous legacy empty originals closed with the existing needs-re-run recovery. Matching legacy nonempty text remains compatible.
   - In `AgentView.tsx`'s `EditCard`, derive the new badge only from explicit absence and no error.
   - Add actual `agentService.run` event tests (new `test/agentProposalProvenance.test.ts`) through a controlled provider transport and owned filesystem. Do not expose private `execTool` merely to test it or substitute the producer. Extend actual approval-store and native-filesystem tests, and add actual component label coverage.
3. Fence bulk reload and save-waiting closes.
   - In `reloadOpenTabsFromDisk`, capture root/generation, a latest-reconciliation token and the original clean tab object before awaiting its read. Check that ownership on both success and failure before adoption, notification or closing. A newer reconciliation supersedes earlier work; completed work retains no ongoing resource.
   - Treat serialized ENOENT as missing; retain the tab on EACCES/other read failures with an actionable notification. Preserve existing editable-versus-placeholder transitions and dirty-buffer safety.
   - In `closeTab`, track whether the tab was removed/reopened while waiting for an existing save, reusing approval's bounded lifetime observation and cleaning up the subscription on every exit. A successful save replaces the tab object when advancing `savedContent`; do not mistake that normal replacement for reopening. After the save, capture the current owned tab for the existing exact-object discard-confirmation guard.
   - Missing/nontext bulk reconciliation must retain its original clean-tab ownership through any internal save wait too. Do not initiate a discard prompt or close after newer typing invalidates that owner.
   - Add new actual-store deferred cases in `test/gitTabReconciliation.test.ts`; keep the complete existing project/session suites.
4. Keep VCS post-operation work under its operation owner.
   - Capture the store's existing workspace lifetime at each VCS user action's entry, before its first awaited confirmation or Git request. Pass that owner through `VcsPanel.tsx`'s existing `doOp` and recheck it before admitting a mutation. Capturing only after a delayed confirmation would mistake a reopened same-root project for the original lifetime. A small new store-local exported ownership-capture helper may expose that check without exposing mutable generation state or adding an application-wide framework.
   - Cover switch, branch creation and pull's tab/tree reconciliation inside the busy operation lifetime. Before and after awaited work, suppress effects when the project lifetime is no longer owned, including A-to-B-to-A. Inspect every `doOp` caller, including stage/unstage, commit, init and fetch, so stale completion cannot leak notifications/draft changes either.
   - Keep real backend Git authorization/confinement/timeout policy unchanged. This renderer guard cannot roll back an operation already executed against its captured repository.
   - Add new mounted-component deferred cases in `test/vcsOperationOwnership.test.ts` using the actual store/React host and clearly substituted Git IPC outcomes. Normal backend repository behavior remains covered separately by owned real-Git tests.
5. Document only the behavior changed here: proposal provenance and legacy recovery in `docs/AI-ASSISTANT.md`, and clean-tab reconciliation/error handling in `docs/GIT.md`. Record this task's actual results and remaining gaps in the existing `docs/TASK-AUDIT.md`, `tasks/todo.md` and `docs/RELEASE-VALIDATION.md`; do not create a new ledger or general maintenance system. This fulfills the user's explicit feature-documentation and Markdown-task requirements. Do not mark remote workflows, provider credentials, customer repositories or hardware validated by fixture tests.

## Verification

Use regressions that fail on the original behavior before each fix. Approval cases include existing-empty then deleted without a tab, absent then externally created empty/nonempty, legacy unknown-empty refusal, valid creation/existing-empty/nonempty legacy, unreadable/nontext inputs and raw BOM/CRLF preservation. Producer cases use actual event emission and file reads, with only transport/Electron host boundaries substituted; malicious model-supplied provenance cannot change the main-derived value.

Deferred bulk-reload cases cover success and rejection after close/reopen, typing followed by a completed save, project switch and same-root ABA, overlapping reconciliations, pending-save close with a replacement tab, genuine missing/binary transitions, ordinary clean adoption and dirty preservation. The existing successful pending-save close must still complete without a discard prompt; an object replaced by its own successful save is not a reopened tab. Component cases cover stale switch/create/pull and unchanged normal actions, serialization through reconciliation, a delayed confirmation accepted after project A-to-B-to-A, existing confirmations and no side effects into a replacement workspace. Existing Git-service tests retain real owned repository/local-remote behavior.

Perform faithful guard regressions and restore exact source. Preserve all assertions, independent timeouts and existing explicit skips. Final types, full regression and build cover the final combined source. Native acceptance in an owned sandboxed desktop profile covers explicit empty/absent proposals and normal real Git switching without touching customer projects; report any unexercised race as fixture evidence, not native proof. Firmware repeatability/self-test and advisory benchmarks remain separate unchanged workflows; dependency advisories and external release gates remain red until separately resolved.

## Context files

- `AGENTS.md` and `CONSTRAINTS.md` - governing unchanged quality/file-safety floor.
- `src/main/services/agentService.ts` and `src/shared/ipc.ts` - actual proposal producer and typed transport contract.
- `src/renderer/src/store/useStore.ts` - workspace lifetime, approval, save queue, close and bulk-reload ownership.
- `src/renderer/src/components/VcsPanel.tsx` - operation consumers and component-local read generations.
- `test/agentEditApprovalStore.test.ts`, `test/agentEditApprovalFilesystem.test.ts` and `test/workspaceSessionStore.test.ts` - existing deferred and real-disk safety conventions.
