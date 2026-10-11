# Languages

Cortex is multi-language on purpose: real embedded work is firmware plus the
Python tests, dashboards and tooling around it. This is what each language
actually gets today, and what it does not.

## Support matrix

| Language | Highlighting | IntelliSense (LSP) | Run | Debug | Notes |
|---|---|---|---|---|---|
| **C++** (`.cpp .cc .cxx .c++ .hpp .hh .hxx .h`) | yes | **clangd** | yes | **yes (gdb)** | Standard selectable C++11 → C++23, plus experimental `c++2c` when the selected compiler supports it |
| **C** (`.c`) | yes | **clangd** | yes | **yes (gdb)** | Built with `gcc` and a **C** standard (c99/c11/c17/c23) |
| **Arduino** (`.ino`) | yes (as C++) | no (by design) | Verify/Upload + **3D Simulator** | no | clangd cannot find the Arduino core without a compile DB |
| **Python** (`.py .pyw`) | yes | Pyright *(if installed)* | yes | not yet | Falls back to `python3` when `python` is absent |
| **Rust** (`.rs`) | yes | rust-analyzer *(if installed)* | yes (cargo or rustc) | not yet | Edition + debug/release in the toolbar; exact diagnostic spans |
| **JavaScript** (`.js .jsx .mjs .cjs`) | yes | no | yes (node) | no | |
| **TypeScript** (`.ts .tsx`) | yes | no | no | no | Edit-only |
| **Zig** (`.zig`) | yes (Cortex grammar) | no | no | no | Edit-only; Monaco ships no Zig grammar, so Cortex registers one |
| **Lua** (`.lua`) | yes | no | no | no | Edit-only |
| **Markdown / YAML / JSON / INI / XML / Shell** | yes | no | no | no | The ancillary files every embedded repo carries |

"Edit-only" is stated, not implied: pressing Run on such a file prints
`Cortex has no runner for <language> files. They are edit-only here.` in the
Output panel, and the Run button's tooltip says the same. Nothing silently does
nothing.

## Language servers

Only **clangd** is required for the headline C/C++ experience, and Cortex
auto-configures it against your own compiler (see [`LSP.md`](LSP.md)). Pyright
and rust-analyzer are wired and will be used the moment they are on your `PATH`;
until then the status bar shows `Pyright off` rather than pretending.

A subtlety worth recording: Monaco registers **`c` and `cpp` as separate
language ids**, so a server has to be registered against every id it serves.
Registering only `cpp` left every `.c` file with a green clangd badge, working
squiggles, and completely dead completion/hover/go-to-definition.

## Rust

Run picks the right tool for the shape of the project:

- **Cargo project** (a `Cargo.toml` at or above the file, without escaping the
  workspace): `cargo run --message-format=json`, from the crate root. `rustc`
  alone cannot resolve the dependencies in `Cargo.toml`, nor apply cargo's
  profiles, features or workspace layout.
- **Loose `.rs` file**: `rustc` with the edition from the toolbar.

The toolbar carries Rust's own build settings (**edition** 2015/2018/2021/2024
and a **debug/release** profile), persisted per project in `.cortex/config.json`
like the C++ ones.

Diagnostics are read from the machine format in both cases, so the Problems
panel and the gutter get **exact spans** (including errors in a module file you
do not have open) rather than a scrape of human text. What you *see* is still
the compiler's own rendering, with its caret underline: cargo's machine records
are filtered out of the Output panel, so running a program shows the program's
output, not a wall of JSON.

Filtering cargo's records means Cortex line-buffers cargo's stdout, which has
two consequences worth stating:

- A trailing line with **no newline** is still shown immediately when it cannot
  be a cargo record. An interactive program doing
  `print!("Enter a threshold: ")` shows its prompt while it waits on stdin,
  rather than looking hung until it exits.
- A trailing line that *could* still be an unfinished record (it starts with
  `{`) is held only for 250 ms. A program that prints a bare `{` and then blocks
  on input used to stay invisible until it exited.
- Only cargo's **own** `reason` values are treated as machine records, so a
  program that prints its own JSON (telemetry with a `reason` field) reaches the
  Output panel untouched.

cargo builds and runs in a single process, so there is no second spawn to mark
the end of compiling. Cortex reads cargo's own `build-finished` record (or the
program's first line of output, whichever lands first) and moves the run into
its run phase then. Without it the status bar said "Compiling..." for the
program's whole life and the stdin box, which is gated on the run phase, never
appeared, so an interactive cargo program could not be given input.

Diagnostics are emitted as each record arrives, not at exit, so a long-running
binary or a server still populates Problems, and pressing Stop does not discard
them. They are capped at 500 per run, and when the cap is hit Cortex says so in
the Output panel rather than letting a truncated Problems list look complete.

> Both paths are verified end-to-end against rustc/cargo 1.97.1, and the parsers
> are tested against captured real output (`test/cargo.test.ts`,
> `test/realRustc.test.ts`).

## Binary and oversized files

An embedded tree is full of `.elf`, `.bin`, `.o` and `.png` artifacts. Opening
one as text used to produce editable mojibake, and saving that tab re-encoded
U+FFFD over the artifact and destroyed it.

Cortex now sniffs the first 8 KB for a NUL byte (the same heuristic git uses)
and refuses anything binary or larger than 8 MB, showing a placeholder instead.
The tab never mounts an editor, so it cannot be dirtied, which means it cannot
be saved back over the original. `.hex` files stay editable, because Intel HEX
is ASCII.

## Things that are deliberately refused

Cortex says no, with a reason, rather than producing a confusing failure:

- **Headers.** `g++ util.hpp -o util.exe` exits 0 and writes a *precompiled
  header*, which then fails to execute. Run and Debug refuse a `.h/.hpp/.hxx`
  and point you at the `.cpp` that includes it.
- **Debugging a sketch.** `.ino` maps to C++, so host gdb would happily try to
  build `blink.ino` and fail on the Arduino API. Debug refuses and points at
  Simulate or upload.
- **Debugging a non-C language.** The Debug button is disabled with the reason,
  instead of being enabled and doing nothing.

## Per-project build settings

The toolbar's build controls are per language, and every one is persisted to
`<workspace>/.cortex/config.json` so a project keeps its own settings:

| Language | Controls |
|---|---|
| C++ | compiler, C++ standard (c++11 - c++2c), optimization |
| C | compiler (the **C** driver), C standard (c99 - c23), optimization |
| Rust | edition (2015 - 2024), debug/release |
| Python / JS | none in the toolbar; the interpreter lives in Settings |

`extraArgs` in that file is passed to the compile command (Run **and** Debug),
so a project can carry its own flags:

```json
{ "compiler": "g++", "std": "c++23", "cStd": "c11",
  "extraArgs": ["-DCORTEX_EXTRA_FLAG=1", "-Wextra"] }
```

That file travels with a cloned repo, so every value in it is validated before
it reaches a command line: several GCC flags (`-fplugin=`, `-B`, `-specs=`,
`@file`, a second `-o`) are compile-time code execution or redirect the build.
See [`PROJECT-CONFIG.md`](PROJECT-CONFIG.md).

One subtlety: Cortex keeps a **single** `compiler` setting across languages, and
treats the C++ driver as canonical. Opening a `.c` file maps it to the C
counterpart (`g++` to `gcc`, `clang++` to `clang`) for both the build and the
toolbar display, so what you see is what runs. Storing `gcc` directly would
otherwise leak into C++ builds, where it cannot link the standard library.

The mapping is by driver **suffix**, not a lookup table, so a cross toolchain
maps too and keeps its target prefix: `avr-g++` to `avr-gcc`,
`arm-none-eabi-g++` to `arm-none-eabi-gcc`. A table missed those and fell back
to building C as C++.

That one mapping is applied in three places, and all three are verified against
a real `.c` file that only a C compiler accepts (an implicit `void*`
conversion): **Run**, **Debug**, and the **`.clangd`** config that drives
IntelliSense. The C standard follows the same route, so the toolbar's `c99`
reaches gdb's build and clangd's analysis, not just Run.

## Missing toolchains

Every runner names what is missing and how to get it, instead of leaking
`Error: spawn rustc ENOENT` and `exit -4058`:

```
'rustc' was not found on your PATH.
Install Rust (winget install Rustlang.Rustup, or https://rustup.rs), then rescan in Settings.
```

## Adding a language

1. Add it to `LANGUAGES` in `src/shared/languages.ts` (extensions, Monaco id,
   `runnable`, `debuggable`).
2. If Monaco has no grammar, register one under `src/renderer/src/monaco/` and
   call it from `CodeEditor`'s `beforeMount` (see `zig.ts`).
3. Add a runner case in `src/main/services/runnerService.ts` and an install hint
   in `INSTALL_HINT`.
4. Probe its toolchain in `src/main/services/toolchainService.ts`.
5. For a language server, see the "Adding a server" section of [`LSP.md`](LSP.md).
6. `test/multilang.test.ts` asserts the extension lists never drift apart.
