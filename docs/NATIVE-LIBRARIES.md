# Native libraries (OpenCV, raylib, SDL2, GLFW)

Host C/C++ and Python programs often need a third-party library. Cortex finds it,
installs it when missing, and gives the compiler the right flags, without asking
you to edit an environment variable or a build file.

## What a build actually needs

| Need | Where Cortex gets it |
|---|---|
| Header search path (`-I`) | `pkg-config --cflags <module>` of the installed library |
| Library search path and names (`-L`, `-l`) | `pkg-config --libs <module>` |
| Runtime DLLs on `PATH` | The compiler's MSYS2 `bin` directory, added to Cortex's own `PATH` (see `addKnownToolDirs`) |
| A library built for the same compiler ABI | Packages are taken from the **same MSYS2 environment** as the resolved `g++` |
| Editor resolution (`#include` squiggle gone) | The library's include dirs are added to the generated `.clangd` |

A prebuilt OpenCV from opencv.org (`C:\opencv\build\x64\vc16`) is built for MSVC and
cannot be linked by MinGW `g++`. Cortex installs the MinGW build instead.

## Why not an environment variable, or a setting?

Neither is the source of truth. An environment variable is global, silently stale
and per-user; a setting does not know which compiler produced the library. The
package manager already knows exactly what is installed and for which compiler, so
Cortex asks it each build. The project only has to name what it uses, and it does
that by `#include`-ing it.

## Using it

1. `#include <opencv2/opencv.hpp>` (or `import cv2` in Python).
2. If it is not installed, the squiggle's hover explains it and **Ctrl+.** offers
   **Install OpenCV**. The same buttons live in **Settings > Libraries**.
3. Press Run. Cortex adds the flags for every catalog library the file includes.

Install output streams to the Output panel. The editor restarts its C++ analysis
when the install finishes so the include resolves.

## Platform support

| Platform | C/C++ install | Python install |
|---|---|---|
| Windows + MSYS2 `g++` | Automatic (`pacman`) | Automatic (`pip`) |
| Windows, other compiler | Not automatic; Settings explains why | Automatic |
| macOS / Linux | Detects installed libs via `pkg-config`; shows the `brew` / `apt` command to run | Automatic |

OpenCV through MSYS2 is large: about 155 packages and 400 MB. raylib, SDL2 and GLFW
are small.

## Security model

`.cortex/config.json` travels with a cloned repo, so it is untrusted
([PROJECT-CONFIG.md](PROJECT-CONFIG.md)). Native-library flags therefore never come
from it:

- An install request names a **catalog id** (`opencv`), never a package or command.
  The package name is derived from the catalog and the compiler's MSYS2 environment.
- pkg-config output is filtered to `-I`, `-L`, `-l`, `-D` and `-pthread`. Anything
  else (`-fplugin=`, `-specs=`, `@file`, `-Wl,`) is dropped.
- The Python interpreter is chosen by the same rule the runner uses
  (`pickPythonInterpreter`): a pinned venv only if it is inside the workspace. The
  import check runs with `-I` so a project file cannot answer for the import.
- Installs run through the same streamed, single-flight path as board packages.

## Adding a library

Add one entry to `NATIVE_LIBS` in `src/shared/nativeLibs.ts`: the headers that imply
it, its pkg-config module, the MSYS2 package suffix, and optionally the brew/apt
package and PyPI package. Detection, status, install, Quick Fix and the Settings row
all follow from that entry.

## Code map

- `src/shared/nativeLibs.ts`: catalog and pure logic (detection, flag filtering, MSYS2 mapping)
- `src/main/services/nativeLibFlags.ts`: toolchain resolution, pkg-config, status, editor include dirs
- `src/main/services/nativeLibService.ts`: install (pacman / pip) and Python status
- `src/main/services/runnerService.ts`: injects flags into the C/C++ compile
- `src/main/services/clangdConfig.ts`: adds installed libraries' headers to `.clangd`
- `src/renderer/src/lsp/nativeLibQuickFix.ts`, `components/NativeLibrariesSettings.tsx`: the UI

## Testing

`test/nativeLibs.test.ts` covers detection, flag filtering, MSYS2 mapping and the
diagnostic hints. `test/pickPythonInterpreter.test.ts` pins the interpreter trust
rules. The install and link path was also verified against a real MSYS2 install
(raylib installed, linked into an executable) and a real venv (pip install, then
import).

## Known limits

- Only libraries in the catalog are known. An unlisted library needs its flags added
  by hand in `extraArgs` as before.
- Only the single file being run is scanned for includes; a multi-file build must
  list its own flags.
- macOS and Linux get detection and a copyable command, not an automatic install
  (it needs `sudo`).
- OpenCV's C++ build via MSYS2 has not been compiled in this repo's tests yet; the
  pipeline was verified with raylib.
