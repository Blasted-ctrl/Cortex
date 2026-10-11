---
status: done
---

# Plan: Preserve exact-byte assertions without oversized matcher allocations

## Observed failure

The More tools regression pass exposed an existing oversized-file preservation
test timing out. The isolated, unchanged 16-case provenance suite reproduces one
120-second timeout; the other 15 cases pass. Its 8,388,609-byte Buffer fixture is
compared with Vitest 4.1.11's generic iterable/deep matcher, which traverses bytes
and materializes both Buffers' indexed `Object.entries` arrays. The production
file-size refusal remains unchanged and rejects this fixture before reading it.

## Bounded change

Change only the final preservation comparison in
`test/agentProposalProvenance.test.ts`'s binary/invalid-UTF-8/oversized parameterized
case to `Buffer.equals`, asserted true. Both operands are plain Buffers; this
still requires identical length and every byte. Keep the complete fixture,
refusal assertion, tool failure, directory-content assertion and all existing
timeouts, configuration and skips. No production, dependency or compiler changes.

This is a separate test-harness checkpoint, not a new More tools behavior or a
claim that host contention explains every initial failure.

## Verification

- Retain the original failing full run and the isolated 140,451ms timeout case.
- Run all 16 cases after the change in an owned physical D: source snapshot.
- In another owned D: copy only, flip the actual read Buffer's final byte for
  the oversized case; verify exactly that preservation assertion fails while
  the other 15 cases pass. Also retain the unchanged green comparison.
- Review the one-line change for all five quality axes and unchanged assertion
  semantics. Run final types, build and complete regression without overlapping
  heavyweight gates; keep their existing deadlines.
- Commit this verified test-only checkpoint separately from the menu feature,
  with precise staging on main, unchanged signing/hooks and no additional push.

## Limits

The measured suite durations are local single-run observations, not a portable
performance budget or full-process memory bound. Window-buffer JetBrains
references, native menu verification and external release gates remain separate.
