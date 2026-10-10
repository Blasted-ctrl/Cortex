# 3D simulator view

A 3D board view sits alongside the 2D schematic canvas, toggled by the `2D | 3D`
control in the Simulator toolbar. Both are drop-in siblings that read and mutate
the **same** store (`simParts`, `simWires`, the pin-state maps), so add/delete,
wiring, running and live pin values stay in sync between them. Only the
rendering differs. `simWiring` is the pending connection gesture, not the saved
wire graph. See [SIMULATION-WORKBENCH.md](SIMULATION-WORKBENCH.md) for the shared
version 3 diagram and circuit checks.

## Why it is built this way

- **One source of truth.** Parts, explicit terminal-to-terminal wires, selected
  board and pin state are shared rather than maintained as separate 2D/3D
  circuits. `.cortex/diagram.json` persists the board, parts and wire graph;
  legacy diagram versions are decoded through the shared model.
- **Lazy-loaded.** `SimCanvas3D` is loaded with `React.lazy`, so its three.js/drei
  dependencies can be split from the editor's initial bundle. The 3D view is
  loaded when opened; this is not a measured startup-performance guarantee.
- **CSP-safe.** No `drei` helper that fetches an external asset is used (no
  `Environment` HDR, no troika `Text` font). Labels are `drei/Html` (DOM over
  the canvas), so the strict production CSP is never violated and the app works
  offline.

## Geometry

`src/renderer/src/components/sim3d/board3d.ts` defines centred board geometry.
The shared bounded design coordinates map `(x, y)` to world `(x, z)`, scaled to
each board footprint; design `y` becomes world `z`. Uno execution pin numbers
are D0-D13 = 0-13 and A0-A5 = 14-19. Other boards expose their own inspection
labels/functions, not an interchangeable executable Uno pinout.

## Boards

`components/sim3d/board3d.ts` is a registry of four stylized inspection models,
with mm-derived proportions, labelled pins and landmark features. These are not
manufacturer CAD models or proof of every connector's physical placement:

- **Arduino Uno** (`uno`) - 68.6x53.4mm, D0-D13 + A0-A5, ATmega328P, USB-B,
  barrel jack, the onboard "L" LED that mirrors D13.
- **ESP32 DevKit** (`esp32`) - ~28x55mm, the ESP-WROOM-32 shield can, 2x19
  headers labelled by GPIO, micro-USB, EN/BOOT buttons.
- **Raspberry Pi** (`pi`) - 85.6x56.5mm, the 40-pin 2x20 GPIO header, BCM2711
  SoC, USB/Ethernet/HDMI/USB-C ports.
- **Teensy 4.1** (`teensy41`) - top and underside pin inspection, including
  GND/power/function labels and explicit limits for illustrative pad placement.

The board selector sets the shared `sim3dBoard`. Switching is blocked during a
simulation and asks for confirmation when wires exist, because identical GPIO
numbers can mean different physical pins. A confirmed change clears wiring,
resets pin state and marks the diagram dirty; it does not silently reinterpret
the old circuit. The view reframes for the selected board.

## Interaction

- **Wiring.** Explicit part terminals, board pins and power/GND endpoints use
  the shared wire graph, including part-to-part connections and jumper metadata.
  A wire's connector style is not a contact-resistance or mechanical model.
- **Dragging.** All four boards map workbench dragging back to the shared design
  coordinates through `movePart`, keeping 2D and 3D placement in sync.
- **Inspection.** Orbit above or below the board, choose Top/Underside, toggle
  pin labels and inspect a pin's name/functions and warnings. Dense labels may
  need zooming; unsupported inspection-only pads do not become runtime GPIOs.

## What the engine actually drives

The supported executable target is the Uno-oriented host Arduino shim, not an
emulated MCU. ESP32, Raspberry Pi and Teensy models provide inspection and
topology editing; choosing one does not add its CPU, SDK, WiFi/BLE, Pi Linux GPIO
or Teensyduino runtime. Legacy LEDC shim compatibility is not ESP32 execution
support. Circuit warnings are conservative checks, not physical certification.

The desktop runs host-time sketches; [firmware tests](FIRMWARE-TESTING.md) use the
separate deterministic virtual-time harness. Neither path currently provides
cycle-accurate timing, general electrical solving or mechanical motion physics.

Pinouts and drag-coordinate math are covered by `test/board3d.test.ts`; shared
diagram/wiring behavior by `test/simCircuit.test.ts`, and launch/state guards by
`test/simLifecycleStore.test.ts`. These tests do not establish physical board
execution support.
