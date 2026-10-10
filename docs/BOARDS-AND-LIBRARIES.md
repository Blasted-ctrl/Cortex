# Boards and Libraries

Cortex manages board cores and Arduino libraries through **`arduino-cli`**. Release
installers include the CLI; development launches prepare it automatically if needed.
There is no separate CLI installation prerequisite. The managers use the Arduino
package indexes rather than a private package catalogue.

Both managers live on the activity bar: **Boards Manager** and **Library Manager**.

## Initial setup

Cortex prepares board tools and initializes package indexes on first launch. Both
managers show setup progress; a failed download offers an in-app retry. Initial setup
needs internet access. Install the core for your board through Boards Manager before
Verify or Upload. The simulator stays usable during setup and needs only a host C++
compiler. See [the real-board quickstart](BOARD-TOOLS.md) for the complete workflow.

## Boards Manager

Search the core index, then install / update / remove a platform.

| Action | Command run |
|---|---|
| List installed | `arduino-cli core list --format json` |
| Search | `arduino-cli core search <q> --format json` |
| Install | `arduino-cli core install -- <id>[@version]` |
| Remove | `arduino-cli core uninstall -- <id>` |
| Refresh index | `arduino-cli core update-index` |

- Installed cores are listed first with their version and a **Remove** action.
- Each entry has a **version dropdown**, so you can pin an older release the way the
  Arduino IDE lets you.
- Install/remove output is streamed to the **Output** panel - downloads are slow and you
  should be able to watch them.
- After an install the board list refreshes, so the new boards appear in the toolbar's
  board selector immediately.

## Library Manager

Same shape, for libraries.

| Action | Command run |
|---|---|
| List installed | `arduino-cli lib list --format json` |
| Search | `arduino-cli lib search <q> --format json` |
| Install | `arduino-cli lib install -- <name>[@version]` |
| Remove | `arduino-cli lib uninstall -- <name>` |

## Board and port selection

The toolbar carries an Arduino-style **combined board + port** control: it shows the
selected board with its port, and the dropdown lists boards detected on connected ports
(`arduino-cli board list`) so the common case is one click. "Select other board and port..."
opens the full picker for a board that is not plugged in (you can compile without a port;
you need one to upload).

## Notes on robustness

- `arduino-cli`'s JSON shape drifts across versions (bare arrays in 0.x, keyed objects in
  1.x), so every response is parsed defensively and **per entry** - one malformed row is
  skipped rather than discarding the whole list.
- Package identifiers are passed after a `--` terminator so a name starting with `-` is
  treated as a positional argument and never as a CLI flag.
- Versions are sorted newest-first with prereleases (`2.0.0-rc1`) ranked below the
  matching release.

## Files

| File | Role |
|---|---|
| `src/main/services/packageService.ts` | arduino-cli core/lib search, list, install, remove |
| `src/main/services/embeddedService.ts` | status, board list, compile, upload |
| `src/renderer/src/components/BoardsManagerPanel.tsx` | Boards Manager UI |
| `src/renderer/src/components/LibraryManagerPanel.tsx` | Library Manager UI |
