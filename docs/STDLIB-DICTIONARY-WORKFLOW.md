# The stdlib dictionary workflow

This describes an async, ongoing process for building up a hand-curated dictionary of
language/library functions with real descriptions and documentation links, so
completion suggestions read the way JetBrains' or VS Code's do: not just a name, but
what it does and where to read more.

## Why this exists alongside the LSP

Cortex already gets real completions from clangd/pyright/rust-analyzer: scope-aware
locals, real signatures, and version-correct suggestions (clangd is driven by the
actual compiler frontend on the project's configured `-std=`, so it already refuses to
suggest `auto` under `-std=c++98` for free, no hand-maintained gating needed). That
part should stay LSP-driven. Reinventing signatures and scope tracking by hand would
both duplicate something already correct and inevitably drift out of sync with it.

What the LSP genuinely cannot give us is the one thing that started this: a link to
the real documentation page, and a description with the polish of hand-written docs
rather than a raw Doxygen/docstring dump (or nothing, for entries with no doc comment
at all). That's what this dictionary is for. It's a supplement to `detail`/
`documentation`, not a replacement for the completion engine.

## Data shape

One JSON file per language under `src/shared/stdlib/` (e.g. `cpp.json`,
`python.json`), keyed by library, then by symbol:

```json
{
  "vector": {
    "header": "<vector>",
    "since": null,
    "symbols": {
      "push_back": {
        "kind": "method",
        "signature": "void push_back(const T& value)",
        "description": "Appends a copy of value to the end of the container.",
        "since": null,
        "docUrl": "https://en.cppreference.com/w/cpp/container/vector/push_back"
      }
    }
  },
  "chrono": {
    "header": "<chrono>",
    "since": "c++11",
    "symbols": {
      "duration_cast": {
        "kind": "function",
        "signature": "template<class ToDuration, class Rep, class Period> constexpr ToDuration duration_cast(const duration<Rep, Period>& d)",
        "description": "Converts a duration to another duration type, truncating toward zero.",
        "since": "c++11",
        "docUrl": "https://en.cppreference.com/w/cpp/chrono/duration/duration_cast"
      }
    }
  }
}
```

- `since` at the library level describes the whole header's introduction; at the
  symbol level it describes an individual addition to an existing header
  (e.g. `std::vector::append_range` needing
  C++23 inside `<vector>`, which has existed since C++98).
- `since: null` means no introduction note is supplied, not that every compiler
  or configured standard supports the entry.
- Completion enrichment supplements items the LSP already proposed; it does not
  create additional stdlib completions. Library and symbol stay together in the
  presentation index. Supported explicitly qualified C++ labels or complete
  qualified declarators can establish vector/chrono ownership; bare labels,
  foreign/conflicting owners and incidental type or prose references cannot.
  Python/Rust have no trusted owner contract here, so their server text remains
  raw. Stdlib hover is server-authored without dictionary attribution. `since`
  is a displayed note, not a compiler/version eligibility gate. Compiler/LSP
  availability and standard configuration remain separate.

## The agent's loop

Run this as its own background/scheduled agent, separate from interactive coding
sessions, so it doesn't compete with normal work for this session's attention:

1. Pick one language, one library already partially covered (or a well-known library
   not covered at all yet; inspect the current JSON before selecting a library).
2. Read that library's real reference documentation (cppreference for C++, the
   Python docs for Python, the std docs / docs.rs for Rust).
3. Diff: which public symbols does the reference doc list that `src/shared/stdlib/<lang>.json`
   doesn't have yet for this library?
4. Add 10-20 of them per run - description, signature, `since` if the symbol was
   added after the library's own baseline, and a `docUrl` pointing at that exact
   symbol's page (not the library's index page). Small batches so each run is
   checkable, not a wall of unverified entries.
5. Commit with a message naming exactly what was added (e.g. "cpp stdlib: add 14
   std::vector members").

Coverage priority order for C++ once `<vector>`/`<string>`/`<algorithm>` basics
exist: extend the seeded `<chrono>` coverage, then `<map>`/`<unordered_map>`, `<memory>` (smart pointers),
`<thread>`/`<mutex>`, `<optional>`/`<variant>`, `<filesystem>`. For Python:
`os`, `sys`, `pathlib`, `json`, `re`, `itertools`, `collections`, `typing`. Adjust
as real usage in opened projects shows what's actually being typed.

## Verifying an entry before it ships

Before an entry is trusted, if the language's LSP is available: open a scratch file
with `#include <the header>` (or the Python/Rust equivalent import), and confirm the
LSP's own completion for that symbol actually appears - i.e. the symbol is real and
spelled the way the dictionary claims. An entry that doesn't correspond to anything
the compiler/server recognizes is worse than no entry.

## Status

The C++ owner matcher, index and supplemental formatter live in
`src/renderer/src/lsp/stdlibDocumentation.ts`. Completion and resolution share
that owner result; accepted raw text and same-item resolution ownership remain
in `lspClient.ts`. Seeded data so far:

- `src/shared/stdlib/python.json`: `time` (ten seeded entries), `os` (a few common
  entries), `random`
- `src/shared/stdlib/cpp.json`: `<vector>`, `<chrono>`

The earlier pyright enrichment observation predates the ownership guard and
does not establish safe attribution for shadowing user symbols. Python entries
remain curated data, but are not currently applied to completions without a
trusted ownership contract. Controlled-provider tests are distinct from actual
installed-server visibility; see [Release validation](RELEASE-VALIDATION.md).

Construct snippets live in `src/shared/stdlib/*-snippets.json`
(construct templates - `class`, `for`, `if __name__`, etc. - matched by
prefix the same way any other completion label is). Client-side
call-parens insertion (`withCallParens` in `lspClient.ts`) means a bare function
completion like `print` inserts `print()` with the cursor between the
parens, regardless of whether the server itself supports that.

The intended daily cloud routine follows this document: choose one under-covered
library, add 10-20 verified entries, run checks and commit. Its external schedule
and successful runs are not verified by this checkout. Extending it to the hardware
DEVICE_MAP in `src/shared/hardwareGraph.ts` requires the same small, source-verified
batches and separate scope authorization.
