# Per-project configuration, and why it is untrusted

Every project keeps its build settings in `<workspace>/.cortex/config.json`, so
opening a folder restores the compiler, standard, optimization, board target and
extra flags it was last built with.

```json
{
  "compiler": "g++",
  "std": "c++23",
  "cStd": "c11",
  "optimization": "-O0",
  "extraArgs": ["-Iinclude", "-DFEATURE_X=1"],
  "rustEdition": "2021",
  "pythonPath": ".venv/Scripts/python.exe",
  "boardFqbn": "esp32:esp32:esp32"
}
```

| Key | Applies to | Notes |
|---|---|---|
| `compiler` | C, C++ | Stored as the **C++** driver; a `.c` file maps it down to the C one |
| `std` / `cStd` | C++ / C | Also reach gdb's debug build and clangd's `.clangd` |
| `optimization` | C, C++, Rust | Host Run level; Rust maps non-`-O0` to Cargo `--release` or rustc `-O` |
| `extraArgs` | C, C++ | Applied to Run **and** Debug |
| `rustEdition` | Rust | Loose `.rs` files; a Cargo project uses its own `Cargo.toml` |
| `pythonPath` | Python | A venv. Wins over the app-wide interpreter |
| `boardFqbn` | Arduino | Last selected board |

## Choose optimization in Cortex

Open the host C/C++ target control in the toolbar and use **Optimization**.
The normal presets remain Debug (`-O0`), Balanced (`-O2`), Release (`-O3`) and
Size (`-Os`). **Advanced optimization** reveals the existing allowlisted
technical choices `-O`, `-O1`, `-Og` and `-Ofast`. An already selected advanced
level is shown by its actual flag and revealed when the menu opens; selecting a
level uses the same per-project persistence as the presets. There is no free-form
argument entry, and unsupported stored levels show the host Run fallback to
`-O0` instead of being presented as valid choices.

Optimization can change debugging behavior, speed and size; a higher level is
not a guaranteed performance improvement. In GCC, `-Ofast` also enables changes
outside strict standards compliance, including fast-math behavior, so verify
floating-point and firmware behavior before using it. Details vary by compiler
and target. See the [GCC optimization reference](https://gcc.gnu.org/onlinedocs/gcc-14.2.0/gcc/Optimize-Options.html).

These levels configure native host **Run**, not Arduino-core or deterministic
scenario build options. Host **Debug** intentionally compiles with `-g -O0`;
choosing `-Og` here does not change that debugger policy. Rust retains its
separate Debug/Release profile control and Cargo/rustc mapping above.

## This file is attacker-controlled

That is the whole point of the design: it lives in the repo so the project's
settings travel with it. Which means **cloning a repo and pressing Run must not
be able to execute code the repo chose**. Several driver flags are exactly that,
and an audit found every one of these reachable:

| Value | What it did |
|---|---|
| `extraArgs: ["-fplugin=./payload.so"]` | Loads a repo-supplied shared object **into the compiler process** |
| `extraArgs: ["-B."]` | Points the driver at a repo-local `as` / `ld` / `cc1` |
| `extraArgs: ["-specs=./evil"]` | Rewrites the driver spec wholesale |
| `extraArgs: ["@moreflags"]` | Reads further arguments out of a repo file |
| `extraArgs: ["-o", "...Startup/x.exe"]` | GCC takes the **last** `-o`, so an ordinary Run drops the binary anywhere |
| `optimization: "-fplugin=./payload.so"` | Same primitive through a different field |
| `compiler: "arm-none-eabi-g++"` | Passed `isBareCommand`; Run exec'd firmware, Debug fed it to host gdb |
| `pythonPath: "C:/anywhere/python.exe"` | `isAllowedCommand` matches the base name only, so any binary named `python` ran |

And one that needed no config file at all: **a bare command name is not resolved
the way the trust model assumed**. libuv searches the child's working directory
before it scans `PATH`, and every spawn runs with a cwd inside the project - so a
repo containing `main.py` next to a malicious `python.exe` ran that binary the
moment you pressed Run. Cortex now resolves every bare command against `PATH`
itself and hands `spawn` an absolute path (`src/main/services/commandResolver.ts`).
The same hole applied to the compiler, `cargo`, `gdb`, `arduino-cli` and
**clangd**, which needs no user action at all: it spawns on folder open.

So each field is validated at the sink, not merely on the way in:

- **`extraArgs`** goes through `sanitizeExtraArgs` (`src/shared/security.ts`), an
  allowlist of **named flags** rather than open prefixes. Prefixes are not
  enough: a rule like `/^-f(?!plugin)./` blocks the spelling you thought of and
  nothing else, and it still admitted clang's `-fpass-plugin=<dso>` (the same
  dlopen-into-the-compiler primitive under another name) and the whole
  `-fdump-*=<path>` / `-ftime-trace=<path>` family, each writing a file anywhere
  on disk. Value-consuming flags are handled as **pairs**, which both accepts the
  separated spellings gcc has always taken (`-I include`) and stops a flag
  smuggling a value through its successor - which is how `-mllvm -load=./pwn.so`
  got through. `-I`/`-L` values that are UNC paths or URLs are refused: on
  Windows the driver stat()s each one, so a share the repo names would be
  connected to and authenticated against.
- **`optimization`** must be a member of `OPT_LEVELS`, or it becomes `-O0`.
- **`compiler`** must be bare (no path separator), allowlisted, and a **host C++**
  driver after normalization (`hostCppOrNull`). A cross compiler is refused.
- **`pythonPath`** may be a path, because a venv is one, but only a path inside
  the open workspace. Otherwise the trusted app-settings interpreter is used.
- **`std` / `cStd`** are interpolated only into a `-std=` token, so the worst a
  bad value can do is fail the build.

Nothing is dropped silently. A refused flag is named in the Output panel with
the reason, so a project whose settings do not apply says so:

```
Ignoring 4 flag(s) from .cortex/config.json that could redirect the build: -fplugin=./payload.so -o C:/Users/kings/pwned.exe -B.
$ gcc -std=c11 -O0 -Wall -g ring.c -Iinclude -DEXTRA_OK=1 -o .cortex/build/ring.exe
```

Project flags sit **after** the translation unit and before `-o`. `ld` resolves
inputs in order against the symbols still undefined, so `-lmylib main.cpp`
discards the archive and the link then fails on the user's own source.

> Verified end to end by opening a workspace carrying exactly that config: the
> four dangerous flags were refused, `-Iinclude` and `-DEXTRA_OK=1` were applied
> (the build needs the former to find its header), and no file appeared at the
> `-o` target. The planted-binary case was verified separately, by putting a
> hostile `python.exe` in the workspace beside the script: the interpreter that
> ran was the one on `PATH`.

## Shared Run and Debug settings

They are separate code paths. The compiler/standard, `extraArgs` and working
directory must stay aligned: the C driver, the C standard, and `extraArgs` were each fixed
separately after each was found missing from Debug. Debug also runs the program
with the **workspace root** as its working directory, the same as Run, so a
program that opens `data.txt` relative to the project finds it under both.

`test/untrustedConfig.test.ts` covers the sanitizers; the Run/Debug parity is
asserted against a real `.c` file that only a C compiler accepts.
