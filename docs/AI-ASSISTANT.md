# AI chat and reviewed edits

Open the right-side AI panel and choose Chat for an answer or Agent for a
workspace task. Configure the provider, model and endpoint in Settings first;
the local-provider option does not require an API key. An unconfigured panel
explains setup rather than pretending a model ran. Agent mode also needs an
open project.

Chat includes the active file as context. Agent mode can read/search the open
workspace, inspect diagnostics/project/hardware information and search imported
documentation. Read-only tool activity appears in its transcript. Imported
document passages can also be added to chat context with citations; see
[Datasheets](DATASHEETS.md) for supported imports, search and PDF limits.

## Reviewing a proposed file edit

`propose_edit` stages complete old/new file contents and a diff; the tool itself
does not write the file. Review each card, then choose Approve or Reject. A large
replacement that removes most of an existing file is highlighted for review.
Approval uses Cortex's workspace-confined file-write path, not a model-supplied
shell command. Save or reject your own unsaved edits before approving a proposal
against that file; if its reviewed contents are stale, request a fresh proposal.

Approval locks before reading and checks the reviewed contents against disk and
the live editor. Changed, unreadable or non-text files are refused. The native
write also receives the exact expected disk bytes; a later conflicting write
fails rather than silently overwriting them. Matching approvals for the same
file cannot apply concurrently. Typing during a dispatched write stays in the
editor as unsaved work; closing/reopening a tab or changing projects prevents
late approval results from adopting that new editor session.

Creating a file requires an absent, unopened path and an empty reviewed old
content. The current proposal format cannot distinguish this from a deleted
empty file that was not open. Disk comparison is not an OS-level atomic
compare-and-swap; see [file save boundaries](PROJECTS.md).
The approval card locks while applying; Reject is a pending-proposal action,
not cancellation or undo of a dispatched filesystem write. Successful edits
remain ordinary disk files; use the editor or your [Git workflow](GIT.md) to
review or reverse them. This is not an atomic multi-file transaction.

## Boundaries and privacy

- The configured provider receives submitted chat/source context and tool results
  selected by the agent, including relevant imported-document passages. Workspace
  confinement does not make that data private from the chosen provider. Review
  that provider's terms and do not submit secrets or restricted customer material.
- Stop cancels the UI run and ignores its late events. It does not promise to
  revoke a request already sent to a provider or undo an approved disk write.
- Imported passages and model answers are assistance, not verified electrical
  safety or a replacement for compiling, testing and checking primary datasheets.
- The current tool contract is read-oriented with reviewed per-file proposals.
  Autonomous repository-wide edits, schematic image analysis, MCP flashing and
  register/test-execution tools are not implemented by this workflow.

Provider connectivity is not established by local fixture tests. Current
verification and remaining combined/fresh-install checks are in
[Release validation](RELEASE-VALIDATION.md).
