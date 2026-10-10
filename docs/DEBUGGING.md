# Debugging

Cortex ships a real source-level debugger for host C and C++, driven by **gdb** over its
machine interface (MI2). Set a breakpoint in the gutter, press Debug, and you get stepping,
live variables, a call stack and a watch list - the JetBrains/VS Code debugging experience,
in an embedded IDE.

## What you get

- **Gutter breakpoints** - click the gutter next to a line. Breakpoints persist while the
  file is open and are applied to the session live (you can add and remove them while
  stopped, no restart).
- **Stepping** - continue, pause, step over, step into, step out, stop.
- **Current-line highlight** - the stopped line is highlighted in the editor and revealed.
- **Variables** - locals and arguments for the selected frame, refreshed on every stop.
- **Call stack** - click a frame to inspect that frame's variables.
- **Watch** - add expressions; they are evaluated in the selected frame on each stop.
- **Your program's output** - printf/cout appear in the console while you step.
  On Windows this is not free: MSYS2's gdb does not wrap the inferior's output
  in MI target (`@`) stream records, it hands the child the same stdout handle,
  so a printf arrives as a plain line among the MI records. Cortex treats a
  non-record line as program output rather than discarding it, which is what
  made a debugged program's output visible at all.
- **gdb console** - the raw gdb/program output stream, for when you need the truth.

The shared Output view retains a recent tail bounded by 5,000 entries and
524,288 UTF-16 code units (at most about 1 MiB of text), with an
`[Earlier console output omitted]` marker. Debug program/gdb/system streams
retain their existing stdout/stderr/system labels. This is bounded display
retention, not lossless producer-to-renderer IPC backpressure or a durable log.

## How it works

```
DebugPanel (renderer)  ──IPC──>  debugService (main)  ──stdin/stdout──>  gdb --interpreter=mi2
      ^                                  |
      └────── DEBUG_STATE / DEBUG_OUTPUT ┘
```

1. `debugService.start()` compiles the active file with `-g -O0` (plus your `-std=`) into
   `<workspace>/.cortex/debug/`. A `.c` file gets the **C** driver and the **C**
   standard, exactly as Run does: debugging one used to build it with `g++`, so
   valid C that Run compiled fine (an implicit `void*` conversion, say) failed
   to build the moment you pressed Debug. The project's `extraArgs` are applied
   here too (sanitized the same way, see [`PROJECT-CONFIG.md`](PROJECT-CONFIG.md)):
   they usually carry `-I`/`-D`, so omitting them made Debug fail on a missing
   header and blame the user's source.
2. It spawns `gdb --interpreter=mi2 <exe>` with the **workspace root** as the
   working directory, the same one Run uses, so a program that opens a file
   relative to the project behaves identically under the debugger. It speaks
   MI: `-break-insert`, `-exec-run`,
   `-exec-next`, `-stack-list-frames`, `-stack-list-variables`, ...
3. `src/shared/gdbmi.ts` parses MI output (result / async / stream records, and the
   c-string, tuple and list value grammar). It is pure and unit-tested.
4. Every stop pushes a `DebugState` to the renderer: status, stack, frame, variables.

The session runs with `mi-async on` so gdb keeps reading commands while your program runs -
that is what makes **Pause** able to interrupt a running program. (Never kill the gdb
process to pause: on Windows `kill()` maps to `TerminateProcess` and would end the session.)

## Limits, stated plainly

- **Host debugging only.** This debugs code that runs on *your machine* - the C/C++ you
  Run in Cortex. It is the right tool for algorithms, parsers, filters and the
  logic you factor out of firmware so you can test it off-target.
- **Not on-chip debugging.** Stepping firmware on an ESP32/Arduino needs a hardware debug
  probe plus OpenOCD (or the ESP32's built-in JTAG) and a different transport. That is a
  separate, larger feature - see `docs/ROADMAP.md`. The Debug action is only offered for
  files Cortex can build and run locally.
- **Single file.** The debug build compiles the active file. Multi-file and CMake targets
  are on the roadmap alongside the general multi-file build work.
- **gdb must be installed.** On Windows, MSYS2's `gdb` works well (`pacman -S mingw-w64-x86_64-gdb`).
  Without it the Debug action reports that gdb was not found rather than failing silently.
- **No thread selector.** The variables request currently targets thread 1;
  multi-thread selection, LLDB and DAP support are not implemented.
- **Project-scoped UI lifetime.** Once opened, the Debug panel remains mounted
  but hidden when another sidebar tool is selected or the sidebar is collapsed.
  Watch expressions, drafts and expression-console history survive those
  switches. Changing or closing the project resets them. Starting a new debug
  session preserves watch definitions but clears their old values and the
  console/history; late evaluations cannot populate a newer session. This is
  in-memory UI state, not saved project sessions or crash recovery.

## Safety

The debugger is a privileged surface (it compiles and executes code), so it is confined the
same way the filesystem is:

- the compiler must be an **allowlisted, bare command name** (no path), so a workspace
  config cannot point it at an arbitrary binary;
- `cwd` and the source file must be **inside the open workspace**;
- breakpoint file paths are rejected if they contain newlines (which would inject a second
  gdb MI command) or fall outside the workspace;
- pressing **Stop** during the compile actually cancels the launch, and overlapping starts
  cannot orphan a gdb process (each start owns a generation token).
- A stopped session rejects pending MI commands and ignores its late child output,
  errors, exits and frame-refresh results. Cleanup checks exact child ownership,
  so an old compiler cannot remove a newer compiler's Stop handle. Natural exits
  and errors from the active child still report normally. A natural process exit
  rejects commands immediately while its owned output streams drain until close;
  that tail cannot restart or repause the ended session.

## Files

| File | Role |
|---|---|
| `src/shared/gdbmi.ts` | Pure GDB/MI2 parser (unit-tested) |
| `src/main/services/debugService.ts` | Compile, spawn gdb, drive MI, push state |
| `src/renderer/src/components/DebugPanel.tsx` | Stack/frame variables, watch, expression console and breakpoints UI |
| `src/renderer/src/components/CodeEditor.tsx` | Gutter breakpoints + current-line highlight |
