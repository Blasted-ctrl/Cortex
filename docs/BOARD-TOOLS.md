# Real-board tools and first upload

Cortex prepares the tools used to compile and upload embedded sketches. You do not
need to install Arduino CLI yourself or add it to `PATH`. The bundled/managed CLI
version is pinned to **1.5.1**.

Release installers include the CLI. When running a source checkout, Cortex downloads
the pinned official CLI if neither the bundled, managed nor an existing installed CLI
is usable. It then initializes board and library indexes. Setup runs in the background
without blocking the editor or simulator; Boards Manager, Library Manager and Serial
& Devices show progress and offer **Retry setup** if something fails.

Tools are selected in this order: the release's bundled CLI, an already managed CLI,
then an existing CLI on your machine. The managed download is only needed if none is
usable. Windows x64/ia32, macOS x64/arm64, and Linux x64/arm64/ia32/armv7 have pinned
portable downloads. An unsupported platform can still use its own installed CLI.
An existing native CLI selected from `PATH` retains its own Arduino configuration
and packages; Cortex does not silently migrate or rewrite that installation.

## Quickstart

1. Start Cortex with an internet connection and let initial board-tool setup finish.
   Open **Boards Manager** to see progress or retry an interrupted download.
2. Search for the core matching your board and click **Install**. For an Arduino Uno
   or classic Nano, install **Arduino AVR Boards**; for ESP32, search **ESP32** and
   choose the matching Espressif platform; for Pico/RP2040, search **RP2040** and
   choose the platform intended for your board. A core supplies its own compiler,
   board definitions and upload tools. Only the cores you choose are installed.
3. Open a sketch whose `.ino` filename matches its containing folder, for example
   `Blink/Blink.ino`. Install additional Arduino libraries in **Library Manager** if
   your sketch needs them.
4. Select the board in the toolbar's combined **board + port** control. Click
   **Verify** to compile. Compilation does not require a board to be connected.
5. Connect the board with a USB data cable, choose its port, and click **Upload**.
   Some boards require a bootloader button sequence or board-specific USB drivers.
   Cortex cannot substitute for those hardware or operating-system requirements.
6. Open **Serial Monitor** or **Serial Plotter** to inspect output from the board.

Installing a core or library streams download/build details to **Output**. Newly
installed targets appear in the board selector without restarting Cortex. A board
preset in the selector is not proof that its core is installed.

## Network failures and offline use

Initial package indexes, development CLI downloads, new cores and new libraries need
internet access. If setup fails, the manager displays the actual error and an in-app
retry action. Reconnect, check proxy/firewall settings or available disk space, then
choose **Retry setup**. Cortex does not continuously retry failed downloads on its
own. The simulator remains available while board tools are unavailable.

Once the CLI, indexes, matching core and required libraries are present, existing
sketches can compile and upload offline. Searching cached indexes can work offline;
refreshing indexes or downloading new packages cannot. Release installers bundle
the CLI, not every board core or Arduino library.

If no port appears, try a known USB data cable, rescan in **Serial & Devices**, and
check the board vendor's USB driver and bootloader instructions. Operating-system
serial permissions may also need attention. An upload requires an explicitly chosen
or unambiguous matching port; Cortex does not silently flash an arbitrary board.

## Why Cortex manages this

Previously, all real-board features depended on finding `arduino-cli` on the user's
`PATH`. A fresh installation therefore stopped at an external package-manager
instruction. The CLI is still the board build/upload engine, but Cortex now owns
preparing it and initializing its package indexes. Native host C/C++, simulation,
debugging and other languages retain their documented separate tool requirements.

Bundled binaries live in the installed application's `resources/arduino-cli`
directory. Managed downloads live beneath Electron's application-data directory at
`board-tools/cli/1.5.1/<platform>-<arch>`. Cortex owns the CLI configuration, indexes,
downloads, sketchbook and build cache beneath `board-tools`, rather than changing
your global Arduino configuration. Inherited `ARDUINO_*` overrides are not applied
to these managed commands. Installing a CLI elsewhere therefore does not require
changing `PATH` or restarting Cortex's managed setup.

Downloads are checked against the pinned official release's size and SHA256 before
extraction. Cortex requests no administrator access and changes no global `PATH`.
The unchanged CLI includes its `LICENSE.txt`, a source/release notice and a provenance
receipt alongside the executable. Source and release information are available in
[Arduino's official repository](https://github.com/arduino/arduino-cli/tree/v1.5.1).

The official board and library indexes must initialize successfully. Optional
vendor index failures do not block those base features; refresh the board index in
Boards Manager and retry if a vendor's core is missing. Board cores are installed
only when selected in Boards Manager, not automatically for every supported board.
New installations configure the ESP32/ESP8266 vendor catalogues and the Arduino-Pico
catalogue for RP2040/Pico. Existing custom additional board URLs are preserved rather
than overwritten. A vendor catalogue warning remains visible in Boards Manager even
when the official indexes and CLI are ready.

See [Boards and Libraries](BOARDS-AND-LIBRARIES.md) for manager commands and package
version selection, and [Features](FEATURES.md) for the current support matrix.
