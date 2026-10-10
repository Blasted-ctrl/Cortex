# Firmware failure/fix demonstration

[Play the desktop recording](firmware-testing.webm) in a browser or a VP8/WebM
player. It is a 128.303-second, 1280x800 recording of the actual isolated Cortex
window, without audio or the surrounding OS desktop.

- Around 54 seconds: all three supported scenarios pass.
- Around 67 seconds: `broken-timeout.ino` fails `sensor-timeout-shutdown`. The
  expanded report shows that pin 9 never reaches zero in the 470-480 ms virtual
  deadline window.
- Around 91 seconds: the saved inputs are rerun with `controller.ino`; the
  shutdown assertion and the rest of the timeout scenario pass. The source-change
  notice explains that this is the current firmware, not the earlier broken file.

The recording also exercises saved-report replay after removing the scenario
JSON and stopping a genuinely hanging fixture. Follow the
[quickstart](../FIRMWARE-TESTING.md) to reproduce the pass/failure/fix workflow.
The firmware runs against the Uno host shim, not a physical board or an AVR CPU.

Recorded on 2026-10-10 from the immutable production snapshot corresponding to
`f89dce0`, renderer `index-D_7wiv83.js`. This predates the panel-height fix
`6b55381`: the short-window scrolling defect is visible and intentionally has
not been edited out. It is not a recording of the latest layout or Vite upgrade.

Validation used a separate sandboxed Electron player: full sequential decoding,
actual timestamp movement on seeks, distinct decoded-frame hashes, and visual
inspection of the pass, failure evidence and corrected result. The file is
349000 bytes; SHA256:
`96cd10bb57421a2d1bf8321838c497e84de5e17a93254043bbb4e7b30d2ceb1e`.
Human fresh-install trials remain separate, unfinished release gates.
