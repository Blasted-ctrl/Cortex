# Building projects

Click the hammer beside **Run** to compile without launching a program or
uploading firmware. A successful build does not flash or validate hardware.

With `platformio.ini` at the open project's root, Build runs `pio run` in that
folder. PlatformIO Core must be installed and its `pio` command available on
PATH. The board, framework, build flags and dependencies come from
`platformio.ini`; the host compiler selector does not override them. The hammer
stays available when a header or configuration file is active, or no file is open.
Edited project tabs are saved before the build. A failed save or files changing
during saving prevent the build from starting.

Outside PlatformIO projects, Build compiles the active C/C++ or Rust source;
Rust crates use `cargo build`. Run launches host programs. Arduino sketches
outside PlatformIO projects use the board Verify/Upload controls.

## Read the first compiler error

On failure, Problems shows located compiler errors and supported fix hints.
Click a problem to open its source location. The notification names the first
compiler error; Output retains the complete build log. Failures without a located
compiler diagnostic remain in Output, including tool launch errors.

`pio run -t compiledb` generates compilation metadata for the editor. It is
separate from the normal `pio run` firmware build. A compilation database's
existence does not prove that the firmware builds successfully.

## ESP32Servo cannot be found

PlatformIO expects [`lib_deps`](https://docs.platformio.org/en/latest/projectconf/sections/env/options/library/lib_deps.html),
not `libs_deps`. Declare `madhephaestus/ESP32Servo` under the correct key and
choose a release compatible with the installed Arduino-ESP32 core. Rebuild to
install the dependency. Installing a library for the host compiler or Arduino
CLI does not declare a PlatformIO project dependency.

Check compatibility before selecting a version: the current
[ESP32Servo documentation](https://github.com/madhephaestus/ESP32Servo)
targets Arduino-ESP32 3.x, while some PlatformIO board platforms still provide
Arduino-ESP32 2.x. Cortex does not silently upgrade a project's core or libraries.

A local build check used `espressif32@7.0.1` (Arduino-ESP32 2.0.17) with
`madhephaestus/ESP32Servo@1.2.1` and produced an ESP32 firmware image through the
hammer action. This records one tested combination, not physical-board validation.

## OpenCV camera code in firmware

The ordinary OpenCV `VideoCapture(0)`, `imshow` and `waitKey` workflow uses PC
camera/display services. It cannot run as written inside ESP32 Arduino firmware.
Installing OpenCV on the laptop does not supply those services on the board.

Keep laptop vision code in a separate host program with a normal `main()` and
OpenCV's headers/libraries; the desktop camera and display stay on the laptop.
Keep the Arduino `setup()`/`loop()`, GPIO and actuator control in the firmware.
A real ESP32 camera requires the board's camera hardware/driver and an algorithm
that fits its memory and processing limits. Choosing that architecture is a
source change, not an include-path fix.

## Extending build support

Route new project formats through the same runner as their toolbar action. Save
the files the project build consumes, preserve cancellation and project-switch
checks, stream tool output, and publish actual compiler locations. Add hints only
when the available source/target facts support them. Never replace a compiler
failure with a fabricated success or offer a host-library installation as a fix
for an unsupported firmware API.
