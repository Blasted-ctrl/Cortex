# Cortex

Cortex is a desktop IDE for embedded development. C and C++ (up to C++23), Python, Rust and JavaScript sit in one workspace, and Cortex compiles and debugs them with real toolchains. There's also a 3D simulator, so you can run a sketch with no hardware plugged in.

Don't treat a build as customer-ready until you've read the [release constraints](CONSTRAINTS.md). The hardening work so far covers [local projects and save recovery](docs/PROJECTS.md), [Git workflows](docs/GIT.md) and the [simulation workbench](docs/SIMULATION-WORKBENCH.md).

## The problem

An embedded project is rarely one thing. There's firmware, a board toolchain, a serial monitor, a stack of datasheets, a debugger, and usually a few host-side scripts for testing. Each comes with its own tool, none of those tools talk to each other, and you end up being the integration layer yourself.

Cortex pulls the workflows it supports into one desktop workspace. It doesn't replace everything Arduino IDE, PlatformIO, STM32CubeIDE or the JetBrains IDEs can do, and the limits are written down below.

## What it's for

Cortex tries to be that integration layer so you don't have to. In one workspace:

- You compile host C++ (up to C++23) with the GCC or Clang already on your machine. Real-board builds use the selected board core and its toolchain instead. A cross-compiler on its own can't build a program your PC can run.
- Python, Rust or JavaScript files can live in the same project for tests, data analysis or a small dashboard, and they run the same way your firmware does.
- The editor is Monaco, the engine behind VS Code. If clangd is installed, it's wired in for completion, hover docs and go-to-definition.
- Missing C++ standard headers get added as you type. Write `std::mutex` and `<mutex>` appears at the top of the file without your caret moving. See [automatic includes](docs/CPP-AUTO-INCLUDES.md).
- You can set breakpoints and step through C/C++ code with gdb without leaving the app.
- Real boards (ESP32, RP2040, Arduino) can be flashed and monitored. Cortex prepares the board tools for you, and serial output can feed a live plotter instead of a wall of scrolling text.
- Or skip the hardware and run your actual sketch against a 3D simulated board, to check the logic before you pick up a soldering iron.
- A supported Uno controller can run headlessly against repeatable sensor inputs. Cortex checks its behavior and deadlines, then publishes the reports and advisory benchmarks from GitHub Actions.

There's an AI assistant panel too. Point it at Anthropic, OpenAI or Gemini, or at a local model through Ollama or LM Studio. It's tuned to talk about interrupts, DMA, RTOS tasks and peripheral registers rather than hand you generic web dev advice.

## How it's different

A prettier Arduino IDE was never the goal. The closer comparison is a JetBrains-style IDE built around one stubborn idea: an embedded project is rarely just C++, so the IDE shouldn't pretend it is.

For host C/C++, Cortex calls the native compiler you already have, so C++17, C++20 and C++23 all work and nothing locks you to an older standard. Board tools are handled separately. Release installers ship with Arduino CLI, and a source checkout downloads it the first time it's needed. Cortex sets up the package indexes, and you install the matching board core from Boards Manager. Settings shows which tools were detected, and an optional integration that isn't available tells you what it needs.

## Where it's at right now

This is an early project under active development, not a finished product. The parts that have actually been run and verified end to end are C++23 compiling, the simulator and the Arduino compatibility shim. Code intelligence, the AI assistant and the simulator's accuracy are real but limited for now, and the packaged build isn't signed and doesn't auto-update yet. I'd rather you hear that here than find out later. The `docs/` folder, `PRODUCTION-READINESS.md` especially, is deliberately upfront about what's solid and what still needs work.

## Download

No release has been published yet, so for now you run Cortex from source (see below). Windows, macOS and Linux installers will show up on the [Releases page](https://github.com/Blasted-ctrl/Cortex/releases) once one is.

Two release gates are still open: code signing and testing the installers on clean machines. A successful source build isn't a verified customer installer, so read [production readiness](docs/PRODUCTION-READINESS.md) before you hand a build to anyone.

## Getting started

To work from source, use Node.js 22.20.0 (the version CI pins) or a newer compatible release. The build tools need `^20.19.0 || >=22.12.0`. Installed desktop builds bring their own Electron runtime, so this only applies to source checkouts.

```bash
npm install
npm run dev
```

That starts the IDE in development mode with hot reload. To build a distributable app yourself instead of downloading one:

```bash
npm run build
npm run dist:win
```

Native programs and the simulator use tools already on your machine. Board compilation and uploads use the board tools Cortex prepares for you:

| To do this | You need |
|---|---|
| Compile/run C or C++ | g++ / clang++ (anything recent supports C++23) |
| C/C++ code intelligence | clangd |
| Debug C/C++ | gdb |
| Run Python | python |
| Run Rust | Rust toolchain: rustc; Cargo for Cargo.toml projects |
| Run JavaScript | node |
| Flash boards, manage libraries | Cortex prepares board tools; install your board core in Boards Manager |

Open Settings → Toolchains in the app and it scans your machine and shows exactly what it found.

You don't need to download Arduino CLI yourself. First-time board setup and core installs do need an internet connection, and Cortex shows progress and lets you retry. The [real-board quickstart](docs/BOARD-TOOLS.md) covers choosing a core, uploading, working offline and USB requirements.

The hammer next to Run builds without launching or uploading anything. In a PlatformIO project it saves your edited project files and runs `pio run`, even when the active file is a configuration file or a header. Build errors land in Problems with their source locations, and the full log stays in Output. More in [building projects and fixing build errors](docs/BUILDING-PROJECTS.md).

## Documentation

There's more in `docs/`: the architecture, the per-language support matrix, the debugger, the 3D simulator and a roadmap of what's planned next.

The public product and download site has its own repository, [Vexaile/Vexaile-Main-Website](https://github.com/Vexaile/Vexaile-Main-Website).

## Automated firmware tests

With Node.js 22.20.0 and a host C++ compiler (`g++` or `clang++`) installed, run this from the source checkout:

```bash
npm ci
npm run firmware:test
```

That runs three scenarios against an Uno controller sketch: normal operation, a sensor that stops sending updates, and invalid ADC readings. The reports in `.cortex/test-results/` show every assertion along with the input and output evidence behind it. `npm run firmware:selftest` checks the checker: a deliberately broken timeout has to fail, and firmware that hangs has to get killed. `npm run firmware:bench` times a fixed workload and reports host time and virtual time separately. None of this opens Electron.

The [firmware-testing quickstart](docs/FIRMWARE-TESTING.md) walks through installation, reproducing a failure, verifying the fix, replaying a saved report, the scenario format, CI and benchmark baselines. In the desktop app, **Run Tests** uses the same runner, and the Firmware Tests panel shows failure details and replays saved inputs. The [feature documentation](docs/FEATURES.md) lists what's supported.

One caveat: native simulation tests your firmware logic against an Arduino shim. It is not AVR instruction emulation.

## License

MIT
