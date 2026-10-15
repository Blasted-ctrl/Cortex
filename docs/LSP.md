# Language Server Protocol integration

Cortex bridges Monaco to installed language servers (clangd, Pyright,
rust-analyzer) for completion, hover, go-to-definition, signature help and
diagnostics. Availability and accuracy depend on the server, project and
toolchain configuration; this is not a claim of parity with another IDE.

C++ completions preserve the server's additional text edits, including missing
header insertions returned immediately or during completion resolution. Local
[automatic includes](CPP-AUTO-INCLUDES.md) also work while typing or pasting
known standard-library symbols without clangd; arbitrary library owners still
require the server's knowledge of the project.

## Supplemental help and ownership

Server text remains authoritative. Curated C++ descriptions and the standard
library badge require explicit ownership of the completed symbol: a supported
qualified label, or a complete qualified declarator in detail, naming an entry
under `std::vector` or `std::chrono`. A bare `clear`, a user-defined owner or a
`std` type mentioned only in a return type, parameter or prose does not qualify.
Unsupported payload shapes stay raw; the matcher is not a C++ semantic parser.
Python and Rust completions do not receive guessed library attribution.

Lazy resolution keeps accepted raw server detail and documentation separate
from supplemental Markdown. Omitted/null results preserve that text; explicit
blank documentation clears it. Conflicting ownership retracts supplemental
help. Cancelled or superseded resolutions cannot change the accepted item.
The original completion payload, including opaque server data, is still sent
unchanged for each resolve request. Insertion and additional header edits remain
separate from presentation.

Stdlib hover is server-authored, without a bare-name dictionary lookup. Curated
hardware hover can fill an unresolved symbol only when a genuine included
header and code word identify a known class or an immediate simple receiver
at the cursor. Multiple calls on one line use their own receivers. Comments,
strings/raw literals and compound receivers do not qualify. Declaration
inference scans the whole file: aliases, lexical shadowing and conditional
include evaluation are not established by this fallback.

Hardware completion also reads receiver prefixes from the masked code view.
Member-like text inside a comment or literal cannot supply a receiver.

The provider regression command is:

```sh
npx vitest run test/lspDocumentation.test.ts test/lspCompletionEdits.test.ts test/libraryComplete.test.ts test/cppAutoInclude.test.ts test/cppAutoIncludeEditor.test.ts
```

These tests use actual registered providers and nonempty dictionaries with a
controlled transport/Monaco host. They do not establish compatibility of every
installed-server payload. Current verification and native observations are in
[Release validation](RELEASE-VALIDATION.md).

## Shape

```
Monaco (renderer)                main process                    server
  providers  ── window.api.lspRequest ──>  lspService  ── stdio ──>  clangd
  markers    <── onLspDiagnostics ────────  (per lang+root)
```

- `src/shared/lsp.ts` is pure and dependency-free (TextEncoder, not Buffer): the
  Content-Length JSON-RPC codec, the server table, `langForFile`, `pathToUri`.
  It runs in the main process and is unit-tested in the node env.
- `src/main/services/lspService.ts` spawns one server per `(language, root)`,
  runs the `initialize` handshake once, correlates requests by JSON-RPC id, and
  pushes `publishDiagnostics` to the window. An absent server is a normal state:
  `availableServers()` reports what is installed and requests to a missing server
  resolve to `null`, so the editor degrades to plain highlighting.
- `src/renderer/src/lsp/lspClient.ts` registers the Monaco providers, syncs the
  open document (`didOpen` / debounced `didChange` / `didClose`), and turns
  pushed diagnostics into Monaco markers. It honours Monaco cancellation tokens
  and flushes a pending edit before any request so the server never answers about
  a stale buffer.
- `StatusBar.tsx` shows a per-file indicator: the server name in moss when it is
  live, or "<name> off" in muted grey when it is not installed.

`.ino` is deliberately excluded from LSP (`langForFile` returns null): clangd
treats it as C++ but cannot find the Arduino core without a compile database, so
it would flood every sketch with "Arduino.h not found". The 3D Simulator covers
`.ino`.

For PlatformIO `.cpp` files, run `pio run -t compiledb` in the project root
when board-core headers are missing from editor analysis. Cortex watches for
the generated `compile_commands.json`, restarts clangd after it settles, and
replays open editor buffers (including unsaved edits). Save the file as well:
the on-disk source and the editor buffer can contain different header names.

## The toolchain bridge (the hard part)

clangd is built on clang, but Cortex projects build with whatever toolchain the
user installed (on the dev machine that is MSYS2 MinGW `g++` 14.2). Left alone,
clang cannot find `<iostream>` and defaults to an old `-std`, so every C++ file
lights up with false errors and completion returns nothing.

`src/main/services/clangdConfig.ts` bridges the two. Before clangd starts for a
workspace it:

1. asks the project's compiler where its headers live and what it targets:
   `g++ -E -xc++ -v -` (empty input) prints the system include search paths and
   the target triple;
2. writes a `.clangd` config at the workspace root so clangd analyses code the
   way the build does: `--target=<triple>` plus every `-isystem <dir>` globally,
   and `-std` scoped by file extension.

The `-std` scope matters: a C++ standard flag is a hard error on a C file
(`invalid argument '-std=c++23' not allowed with 'C'`), and one clangd serves
both. So the config uses multi-document YAML: `-std=c++23` under a `PathMatch`
for C++ extensions, `-std=c17` under a `PathMatch` for `.c`. Both standards come
from the project's `.cortex/config.json` (`std` and `cStd`), so clangd analyses
the code against the same standard the build uses; the C one used to be pinned
to `c17` regardless of the toolbar setting.

Safety:

- a user-authored `.clangd` is never touched; Cortex recognises its own by a
  marker header line and only refreshes that;
- the compiler string is user-controlled (project config), so it runs only
  through the same allowlist gate the build path uses;
- if the compiler cannot be probed, no file is written and clangd falls back to
  its defaults rather than a broken half-config.

Verified on the dev machine: with the bridge, `sense.cpp` (C++23, `std::array`
CTAD, `std::views::enumerate`) goes from 12 errors and zero completions to zero
errors, member completion resolving `push(float sample)`, and hover returning
the rendered `class MovingAverage<4ULL>` with its doc comment.

## Dev tools

- `scripts/lspcheck.mjs` drives clangd through the whole handshake on a scratch
  file, proving the transport independently of the app.
- `scripts/lspprobe.mjs` isolates toolchain issues: it opens the real file with
  and without the derived flags and prints the error counts and completion, which
  is how the `<iostream> not found` root cause was found.

## Robustness and security (post-audit)

A multi-agent adversarial audit of this subsystem found 13 real defects, all
fixed:

- **Untrusted compiler (was: drive-by RCE).** `.cortex/config.json` travels with
  a workspace, so its `compiler` is untrusted; it is spawned by both the build
  path and the LSP toolchain probe. `getProjectConfig` now drops a `compiler`
  that contains a path separator (`isBareCommand`), so only a PATH-resolved name
  runs; an absolute compiler path is a trusted app-settings concern. The
  clangd probe re-checks at the spawn site.
- **Root confinement.** The renderer supplies `root` (spawn cwd, `.clangd` write
  target, config read source). The `LSP_REQUEST`/`LSP_NOTIFY` handlers now reject
  any root outside the open workspace (`fsService.withinWorkspace`), the same
  confinement file writes have.
- **Crash budget.** A server that dies is respawned lazily and the renderer
  replays `didOpen` for its open documents - but that replay is exactly what
  respawns it, so a file that makes clangd fault while building its preamble
  closed a loop with nothing to damp it (crash, replay, initialize, crash) and
  spun processes at full core until the tab was closed. More than 3 crashes in
  60 seconds now stops the replay, reports the server as off (the honest state,
  and one the status bar already renders) rather than showing a green badge over
  an IntelliSense that will never answer, and a rescan in Settings clears it.
- **Crash recovery.** A server that dies is respawned lazily, but the fresh
  process never heard the already-open documents. `onExit` now pushes
  `LSP_SERVER_EXIT`; the renderer replays `didOpen` (current buffer) for that
  server's docs, so features do not go silently dead. A failed handshake
  (spawn error, broken `.cmd` shim, init error/timeout) resets the server so the
  next request retries instead of reusing a rejected promise. `MessageBuffer` is
  reset on teardown so a mid-frame crash cannot splice bytes onto the respawn.
- **Leaks.** Servers for an abandoned workspace are disposed on folder switch
  (`disposeExcept`); every request has a 20s timeout that prunes its pending
  entry so a wedged server cannot grow the map unbounded.
- **Correctness.** Diagnostics are keyed by a normalized path (decoded, drive
  case-folded) so encoding/case drift between our URI and the server's does not
  silently drop markers. The compiler probe is async (never `spawnSync`) so it
  cannot freeze the main process. The generated `.clangd` is gitignored and
  marked machine-specific; its `PathMatch` set matches `langForFile`.

## Installed is not the same as ready

clangd answers almost immediately. **rust-analyzer does not**: it loads the
Cargo workspace, builds proc macros and indexes dependencies first, and until
that finishes it answers every request with an empty result. Showing a green
"rust-analyzer" badge during that window reads as "IntelliSense is broken".

So Cortex declares `window.workDoneProgress` in its client capabilities, which
is what makes a server send `$/progress` at all, and turns those into a distinct
status: **`rust-analyzer indexing...`** in cyan with a pulsing icon, becoming
green only once the server reports it is done.

Measured on the dev machine with a small crate: ~4s warm, considerably longer
on a cold `target/`.

Two details that are easy to get wrong, and were:

- **Progress is refcounted, not a boolean.** rust-analyzer runs several
  work-done tokens *concurrently* (`Fetching`, `Roots Scanned`, `Building
  CrateGraph`, `Indexing`, `cachePriming`, flycheck) and their begin/end pairs
  interleave rather than nest. A single flag let the first `end` declare the
  server ready while it was still loading, so the badge flickered green and then
  lied. Cortex tracks the set of open tokens and is busy while any is open.
- **Busy is cleared on teardown.** A server that dies between `begin` and `end`,
  or is disposed on a workspace switch, would otherwise strand a pulsing
  "indexing..." forever. `reset()` and `dispose()` clear it and push the
  compensating state, and `lspBusy` is part of the workspace-scoped reset.

The wording is per-server, because "indexing" does not mean the same thing
everywhere: rust-analyzer returns empty results while loading, whereas clangd
keeps answering completion and hover for the open file from its preamble and
only cross-file search is incomplete (`LSP_BUSY_HINT` in `shared/lsp.ts`).

## When a server is missing

The status bar names the server and says how to get it, rather than only
reporting that it is off:

```
Pyright is not installed, so this file has basic highlighting only.
npm install -g pyright
Then press Rescan in Settings; no restart needed.
```

Availability is cached (the probe scans PATH x extension), but **Rescan in
Settings re-probes it**, so a server you install while Cortex is open becomes
live without restarting the app.

## Adding a server

Add it to `LSP_SERVERS` (command + args) and `LSP_SERVER_LABEL` in
`src/shared/lsp.ts`, extend `langForFile` for its extensions, and allowlist the
command in `src/shared/security.ts`. Pyright and rust-analyzer are wired and
available when their executables are installed and detected. They need no C++
toolchain bridge: Pyright finds its own stdlib, and rust-analyzer uses Cargo.
