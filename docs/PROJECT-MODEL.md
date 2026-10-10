# Project model and hardware graph

The first pieces of Cortex's project-intelligence layer: a derived, read-only
picture of what a workspace actually is, built by inspecting the project
rather than asking the engineer to describe it.

```ts
interface ProjectModel {
  languages: LanguageBreakdown[]   // what's in the tree, from shared/languages.ts
  boards: BoardInfo[]              // from platformio.ini, only when one exists
  toolchains: ToolchainInfo[]      // whatever's actually installed (toolchainService)
  pins: PinUsage[]                 // pinMode/digitalWrite/digitalRead/analogWrite/analogRead call sites
  pinsTruncated: boolean           // true when the pin list is a sample, not exhaustive
  buses: BusUsage[]                // Wire/SPI/Serial call sites: instance, role, literal i2c addresses, baud
  busesTruncated: boolean
  libraries: LibraryUsage[]        // #include targets, verbatim
  librariesTruncated: boolean
}
```

On top of the model sits the **hardware graph**
(`src/shared/hardwareGraph.ts`, pure - no fs, no Electron):

```text
board
file:src/main.cpp ──uses-pin──────────> pin:13
file:src/main.cpp ──opens-bus─────────> bus:i2c:Wire   (addresses seen: 0x68)
file:src/imu.cpp  ──includes-driver───> device:mpu6050
device:mpu6050    ──likely-on-bus─────> bus:i2c:Wire   (note: why we think so)
```

Every `uses-pin` / `opens-bus` / `includes-driver` edge carries the file and
line it was read from. `likely-on-bus` is the graph's only *inferred* edge,
and it's held to a strict bar: drawn only when the device can live on exactly
one bus kind AND the project opens exactly one instance of that kind - and
never for UART, because `Serial` doubles as the USB debug console on most
boards, so "only one UART open" usually means the console, not the device's
port. When literal I2C addresses were seen on the bus, the edge's note says
whether they match the part's documented address range or explicitly flags
the mismatch.

Device recognition comes from `DEVICE_MAP`: well-known Arduino driver
headers (Adafruit_MPU6050.h, DallasTemperature.h, MFRC522.h, ...) mapped to
what they drive, each entry verifiable against the part's own docs. It's
curated under the same rules as the stdlib dictionary - small verified
batches, real documentation only, never guessed at in bulk (the recurring
dictionary agent covers the stdlib files today; extending it to DEVICE_MAP
is planned, see docs/STDLIB-DICTIONARY-WORKFLOW.md). An include is evidence
the driver is compiled in, not proof the part is wired up, which is why the
relation is named `includes-driver`.

## Where it lives

- `src/main/services/projectModelService.ts` builds it: `buildProjectModel(root)`.
- `src/shared/ipc.ts` has the types (`ProjectModel`, `BoardInfo`, `PinUsage`, `LanguageBreakdown`)
  and the `IPC.PROJECT_MODEL_BUILD` channel.
- The renderer calls it once per workspace open (`useStore.refreshProjectModel`,
  fired from `openWorkspace` the same way `refreshBoardStatus` already is),
  and holds the result in `projectModel` state.
- `StatusBar.tsx` shows the board name when one was found.
- `HardwarePanel.tsx` (the Hardware view in the activity bar) renders the
  graph as a tree - board, devices (with their bus-attachment reasoning),
  buses, pins - with every entry's call site clickable, jumping the editor
  to the exact line that put it in the graph.
- `AiPanel.tsx` folds a compact summary (board/platform/framework, language
  mix, buses opened, devices recognized, and the active file's own pin
  usage) into every AI request's context, ahead of the file content. This is
  the actual point of building it: the product's stated differentiator is
  that Cortex understands the system the firmware controls, not just the
  text in the editor, and this is the first real instance of that rather
  than a slogan.

## What it deliberately does NOT do

- **No board guessing.** `boards` is populated only by parsing a real
  `platformio.ini`'s `[env:NAME]` sections. An `.ino`/`.cpp` file that
  `#include`s `<Arduino.h>` does NOT get a heuristic "this is probably an
  Uno" guess - a wrong board is worse than an honestly empty list, and
  `docs/LSP.md`'s clangd bridge already had to learn that lesson once
  (Arduino.h resolution) for a related reason.
- **No exhaustive claim on pins.** The scan caps at 400 source files and 200
  pin-usage entries (`MAX_SCAN_FILES` / `MAX_PIN_ENTRIES` in
  `projectModelService.ts`) so it stays cheap enough to run on every
  workspace open without becoming the thing that makes opening a project feel
  slow. `pinsTruncated` says so when the cap was hit, so a caller (the AI
  context builder especially) never implies a complete picture from a partial
  scan.
- **No firmware execution.** Source analysis reads files
  already inside the open workspace (the same confinement `fsService` uses
  elsewhere) plus regex matching. This analysis does not compile source;
  `toolchains` comes from `toolchainService.detectToolchains()`. Cached results
  can be reused; discovery on a cache miss can invoke trusted tools' version
  probes. That discovery is not a firmware compilation or execution.

## Why regex instead of a real parse

There's no compile database in a bare Cortex workspace to drive a real AST
walk (the same gap `docs/LSP.md` describes for clangd - see "the toolchain
bridge"), so `pinMode`/`digitalWrite`/`digitalRead`/`analogWrite`/`analogRead`
call sites are found with a line-based regex scan
(`PIN_PATTERNS` in `projectModelService.ts`), not a real parser. This is a
real signal read from the actual source - not invented - but it is not an AST.
The scanner now strips `//` comments and ordinary double-quoted strings before
matching pins and buses; includes are matched as anchored preprocessor directives.
Block comments, multiline raw strings, macro expansion and conditional
compilation remain limitations of this
line-based analysis; the graph must not imply compiler-level certainty.

## Extending this

The graph now exists (`buildHardwareGraph` / `hardwareForFile` in
`src/shared/hardwareGraph.ts`); what it doesn't yet do:

- **Board-specific pin-name resolution.** `LED_BUILTIN` or `PA5` stays a
  token; mapping it to a physical pin number needs per-board pin tables
  keyed off `boards[].platform`/`name`.
- **Physical bus pinout.** `bus:i2c:Wire` isn't connected to the SDA/SCL
  pins it rides on - that's per-board wiring the source text doesn't state.
- **Address resolution through #defines.** `Wire.beginTransmission(MPU_ADDR)`
  records no address; following the token to its `#define` is a real
  next step.
- **More devices.** `DEVICE_MAP` is a curated verified seed; extending the
  recurring dictionary workflow to it is still planned, not enabled by this
  graph or by the existing stdlib routine.
