# Simulator architecture and future roadmap

Current implemented controls, wiring, board inspection, circuit checks and provider
exchange are documented in [Simulation workbench](SIMULATION-WORKBENCH.md).
The roadmap below is not a claim that every listed device or engine is shipped.

**Goal:** let people without physical hardware *simulate* boards and *play with circuits* - write
code, wire up components on a virtual breadboard, press Run, and watch it behave. Should feel like
**Tinkercad Circuits** and **Wokwi**.

## Why it matters
- Removes the hardware barrier: learn/prototype embedded on any laptop.
- Instant feedback loop: no flashing, no wiring mistakes frying parts.
- Pairs perfectly with the AI assistant ("why isn't my LED blinking?") and the serial plotter.

## Two execution engines (ship native-sim first, add cycle-accurate later)

### Engine A - Native host simulation (MVP, uses the g++ we already have) ✅ chosen first
Compile the user's real `setup()`/`loop()` on the host with a **mock Arduino runtime**:
- Provide a `sim/Arduino.h` shim implementing `pinMode`, `digitalWrite`, `digitalRead`,
  `analogWrite`, `analogRead`, `delay`, `delayMicroseconds`, `millis`, `micros`, `Serial.*`.
- The shim emits a line-based **pin-event protocol** on stdout, e.g. `@pin 13 1`, `@pwm 9 128`,
  `@serial hello`, and reads `@in <pin> <value>` on stdin for button/pot interaction.
- Wrap the sketch in a generated `main()` that runs `setup()` then loops `loop()`.
  The interactive desktop simulator uses elapsed host time and real waits for
  `delay()`. The headless firmware test runner explicitly selects a deterministic
  virtual clock; its delays advance simulation time without sleeping.
- Cortex compiles with `g++`/`clang++`, runs the process, parses the event stream, and drives the
  virtual components on the canvas in real time. Interaction (button press, pot turn) is written
  back to the process stdin.
- **Pros:** runs the user's *actual code*, works with the toolchain already installed, fast.
- **Cons:** not cycle-accurate; timing is approximate; not the real AVR/ESP binary.

### Engine B - Cycle-accurate MCU simulation (later, Wokwi-parity)
- **AVR (Arduino Uno/Nano/Mega):** [`avr8js`](https://github.com/wokwi/avr8js) - pure-JS AVR core.
  Feed it the compiled `.hex` (from arduino-cli/avr-gcc), tick the CPU, read `AVRIOPort`
  listeners for pin states. This is exactly how Wokwi began.
- **ESP32 / RP2040:** QEMU-based or Renode integration (heavier; separate process).
- Requires a compile-to-hex pipeline (arduino-cli), so it depends on board support.

## UI (the Wokwi/Tinkercad feel)
- A **Simulator** view (activity-bar entry + full-canvas mode).
- **Component palette:** LED, RGB LED, pushbutton, resistor, potentiometer, buzzer, servo,
  photoresistor, 7-segment, OLED (SSD1306), HC-SR04, DHT22, NeoPixel strip...
- **Virtual board** with an accurate pinout (Arduino Uno first, then ESP32 DevKit, RP2040 Pico).
- **Drag to place**, **click-drag pin→pin to wire**, color-coded nets.
- Live component state: LEDs light, servos sweep, buzzer icon animates, OLED renders pixels.
- **Run / Stop / Reset**, adjustable sim speed, and a scrubbable timeline (stretch).
- Diagram persistence: save the circuit as `<sketch>.sim.json` (Wokwi uses `diagram.json`).

## Data model
```ts
interface SimComponent { id; type; x; y; rotation; props }   // e.g. LED { color }
interface SimWire { from: {compId, pin}; to: {compId|'board', pin}; color }
interface SimDiagram { board: 'uno'|'esp32'|'pico'; components: SimComponent[]; wires: SimWire[] }
```

## Rollout
1. **MVP (native-sim):** Arduino.h shim + pin protocol + runner; canvas with board + LED + button;
   run a blink/button sketch end-to-end.
2. Add more components + wiring editor + diagram persistence.
3. Engine B: avr8js for cycle-accurate Uno; then ESP32/RP2040.
4. Sensor models (ADC curves, I²C/SPI device stubs).

## Related future work - ROS2 for robotics
Add a **ROS2** integration so Cortex can drive/inspect robotics stacks: node graph view, topic echo/
plot (reuse the serial plotter), `ros2 bag` playback, and bridging simulated firmware ↔ ROS2 topics
(e.g. Gazebo/Ignition co-simulation). Tracked here + in ROADMAP Phase 6.

## Headless behavior testing (first release)

The [firmware-testing runner](FIRMWARE-TESTING.md) shares the desktop's host
sketch/shim build preparation and protocol parser. It compiles and executes
real Uno example code without an Electron window. Each scenario starts a fresh
process with initial ADC-scale inputs, timestamped input changes, a seeded
random generator and a virtual clock. Equal-time input order follows the JSON
array order. Behavior assertions observe pin/PWM/tone events and Serial logs;
reports preserve the configuration, trace, failure evidence and build hashes.

The delivered example uses A0 sensor data, D2 sample freshness, D9 PWM and D13
fault output. Normal, sensor-timeout and invalid-input scenarios define the
tested contract. Host watchdog and event/output limits stop stuck firmware;
the deliberately broken fixture and hanging fixture exercise those failure
paths. A separate fixed workload produces host performance metrics and advisory
baseline comparisons in GitHub Actions.

Native simulation is application logic testing. It uses host C++ types and
libraries; it does not model AVR instructions, physical PWM, analog circuits,
interrupt timing or general I2C/SPI devices. Board labels outside Uno, renderer
component animations and planned cycle-accurate engines do not imply headless
test support. Desktop Run Tests calls the same runner, presents scenario results
with failure details, and can rerun saved scenario/report inputs against current
source. See [Firmware testing](FIRMWARE-TESTING.md) for instructions and limits;
unfinished external validation remains in [tasks/todo.md](../tasks/todo.md).
