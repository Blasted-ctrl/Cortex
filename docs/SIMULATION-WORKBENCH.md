# Simulation workbench

This is a working native signal simulator and circuit editor, not a Wokwi engine
embed or an electrical solver. The firmware runtime compiles a supported sketch
with host g++/clang++ and Cortex's Arduino shim. Only the Uno workflow is validated
for firmware execution; choosing another board changes inspection and circuit
checks, not the CPU or installed board target.

## Use it

1. Open your local project folder and a supported `.ino` sketch. Open Simulator.
2. Add parts. Choose Male to male, Female to female or Alligator in the Wire menu.
3. Click a connector, then another part connector or a board pin. The Circuit
   inspector provides the same controls with keyboard-accessible buttons and a
   board-pin selector. Connections can fan out to other terminals.
4. In the inspector, set an external supply's theoretical voltage. Wire its return
   and the driver ground to board GND. Connect GPIO to driver controls, not motor
   power. Supply voltages are checked, not applied as analog ADC inputs.
5. Press Run. LEDs show output, sensors feed GPIO/ADC inputs, STEP edges count
   steps, and actuator travel stops at its configured bounds. Stop resets live state.
6. Click Circuit checks for actionable findings. The absence of findings does not
   establish that hardware is safe. Click the information control for capability details.
7. Save circuit. Cortex stores `.cortex/diagram.json` in the actual project folder.
   Reopening restores the board, parts, settings, wires and connector types.
   Project switching/closing saves dirty circuits and refuses to discard failed saves.

Malformed layouts produce an error without modifying their files. Versions 1/2
migrate to version 3; their old pin links are retained. Newly explicit ground/power
terminals remain unconnected until wired. Out-of-canvas coordinates are brought
back into reach. Limits are 256 parts, 2048 wires and 2 MB for imported JSON.

## Parts and behavior

| Part | Supported behavior |
|---|---|
| LED/RGB, buzzer, seven-segment | Digital/PWM/tone signal display; explicit return terminals |
| Button | Ideal switch input; grounded presses pull LOW; INPUT_PULLUP supplies an idle HIGH |
| Potentiometer/LDR/thermistor | User-selected ADC values, not physical sensor transfer curves |
| Motor + driver | Signed PWM/direction command, not bare-motor coil current or torque |
| Stepper + driver | Rising digital STEP events, DIR and active-low ENABLE; configurable steps/revolution |
| Actuator + driver | Ideal signed travel, configured travel length and speed, clamped end limits |
| Power supply | Configured volts and explicit positive/negative net terminals for topology checks |
| Legacy servo | Illustrative PWM indicator; `Servo.h` and servo pulse timing are not supported |

The desktop uses host elapsed time, including ideal actuator preview timing. The
separate [firmware test runner](FIRMWARE-TESTING.md) uses deterministic virtual time.
External sensor controls can feed multiple connected GPIO inputs. GPIO-to-GPIO
output feedback is not implemented: wiring an OUTPUT to another GPIO may display
that net's driver signal, but does not propagate it into the other pin's
`digitalRead`/`analogRead`. Circuit checks warn when a known OUTPUT shares a net
with an input or a GPIO whose mode has not been reported. Use supported hardware
for firmware that depends on this feedback; renderer updates are not synchronous
runtime wiring.
No mechanical loads, inertia, current, thermal behavior, resistance/current-limiting
solution, protective devices or connector-contact physics are computed. Connector
types are saved metadata and visible wire styles, not mechanical-fit verification.
Resistors are not offered as nonfunctional palette decorations.

`pulseIn`, `shiftIn` and `shiftOut` now stop a running simulation with an explicit
unsupported-API error instead of returning fabricated zero/no-op success. MCU-specific
libraries and communication devices are not made available by selecting a 3D board.

### Output limits

Desktop simulation retains at most 1 MiB of compiler diagnostics and 1 MiB per
pending protocol line, measured in UTF-8 bytes. Exceeding either limit reports
failure (exit code 2), requests immediate child termination and prevents a compiler
result from launching the sketch. Output after that failure is not treated as a
successful run. Protocol framing counts toward the line limit.

The shared Arduino shim also checks its pending `Serial.print` line before
concatenating beyond 1 MiB, including repeated prints without a newline. It fails
explicitly with an actionable message instead of silently truncating the line.
Use newlines or smaller print payloads; ordinary concatenation and exit-time residue
remain supported. The headless runner has additional total-output, event-count and
wall-clock limits documented in its quickstart. These bounds protect retained
output, not arbitrary memory allocations made by native sketch code.

Interactive firmware exits explicitly flush pending Serial output. On Windows,
the disposable firmware process uses OS termination to avoid CRT/DLL teardown
under a detached input reader; it never terminates the Electron host. Virtual
test mode has no reader thread and keeps the portable termination path. Repeated
native launch tests check both successful shutdown and preserved failure codes.

## Board inspection

3D offers Top, Underside, Reset view and Pin labels. You can orbit below the board.
GPIO, power and GND sockets show details; the inspector's Board pins reference is
available without needing to hit a small 3D socket. Both views use the saved board.
Changing board models requires confirmation and clears wires, because the same
number can refer to a different physical pin. Stop simulation before changing it.

| Model | Inspection boundary |
|---|---|
| Arduino Uno | D0-D13, A0-A5, ground and supply rails; supported host-shim runtime |
| ESP32 DevKit (38-pin) | GPIO labels, input-only/flash cautions; no ESP32/WiFi emulation |
| Raspberry Pi | 40-pin header with BCM GPIO labels; no CPU/Linux emulation |
| Teensy 4.1 | Edge GPIO 0-41, GND/3.3V/VIN, underside QSPI pads 48-54; no Teensyduino emulation |

Geometry/pad placement is illustrative, not a manufacturing model. Teensy SD-socket
pins 42-47 and USB/Ethernet connector interfaces are not modeled. Pin capabilities
follow [PJRC's current front/back reference cards](https://www.pjrc.com/store/teensy41.html),
including the 3.3 V-only GPIO warning and VIN/USB backfeed caution. Other references:
[Uno](https://docs.arduino.cc/hardware/uno-rev3/),
[ESP32](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/hw-reference/esp32/get-started-devkitc.html),
[Pi GPIO](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#gpio).

## Circuit checks

Checks include supply shorts/conflicts, known GPIO overvoltage, Teensy VIN overvoltage,
missing shared ground, motor power tied to GPIO, output contention/rail opposition,
pins outside the model and documented ESP32 input-only/flash restrictions. Supply
checks use configured voltage with a shared-ground assumption; isolated or floating
supplies require separate verification. Unknown driver/device ratings are not guessed.
Warnings identify the problem and an actionable correction, never claim safety.

## Wokwi and Tinkercad integration

The information panel has Import/Export Wokwi diagram and external browser actions.
Import reads the selected local JSON, validates the whole file, then confirms replacing
dirty circuit edits. Export writes `.cortex/wokwi.diagram.json`; replacing an existing
export requires confirmation and respects external-change protection. No automatic
code upload occurs. Move the exported diagram and supported sketch into your Wokwi
project manually; execution stays in whichever simulator you choose.

Exchange supports the documented [Wokwi version 1 format](https://docs.wokwi.com/diagram-format)
for a single Uno plus LED, pushbutton with explicit `bounce: "0"`, potentiometer and
buzzer. Supported terminals, colors and connections are preserved. Placement is
adapted to Cortex's canvas; wire routing and connector metadata do not transfer as
electrical behavior. Unsupported components/behavioral attributes/terminals are
rejected, not silently removed. Wokwi Uno's unavailable 3.3V pin is not exported as
functional power. Buzzer terminal 1 is GND, terminal 2 is signal.
Custom Uno attributes, including oscillator frequency, are rejected: host-shim
timing cannot preserve an MCU frequency setting. Supported button colors are kept.

Full [Wokwi desktop integration](https://docs.wokwi.com/vscode/getting-started) has a
licensing workflow; Cortex does not redistribute its simulator engine. Tinkercad
opens in the browser: no supported native/offline circuit engine API was established.
Its documented public-design embeds are not implemented as a native simulator.
Accounts, license agreements and online-service availability remain separate.

For practical reproducible failures and known support limits, use the
[firmware testing quickstart](FIRMWARE-TESTING.md).
