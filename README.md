# Cortex

Customer-release hardening: [local projects and save recovery](docs/PROJECTS.md),
[Git workflows](docs/GIT.md), and [simulation workbench](docs/SIMULATION-WORKBENCH.md).
See [release constraints](CONSTRAINTS.md) before treating a build as customer-ready.

Cortex is a desktop IDE built for embedded development: C and C++ (up to C++23), Python, Rust, and JavaScript, all in one workspace, with real compiling, real debugging, and a 3D simulator you can run without any hardware plugged in.

## The problem

Embedded projects span firmware, board toolchains, serial tools, datasheets, debugging and host-side test scripts. Cortex brings its supported workflows into one desktop workspace, with explicit limits documented below. It does not claim to replace every capability of Arduino IDE, PlatformIO, STM32CubeIDE or JetBrains IDEs.

None of those tools talk to each other. You end up being the integration layer yourself.

## What it's for

Cortex is an attempt to be that integration layer instead of you. It's one workspace where:

- You write and compile modern C++ (up to C++23) using whatever compiler you already have installed (GCC, Clang, ARM-GCC, AVR-GCC), not something bundled and outdated.
- You can drop Python, Rust, or JavaScript files into the same project for tests, data analysis, or a small dashboard, and run them the same way you run your firmware.
- The editor is Monaco, the same engine behind VS Code, wired up to clangd for real completion, hover docs, and go-to-definition when clangd is available on your machine.
- Missing C++ standard headers are added as you type: `std::mutex` inserts `<mutex>` at the top without moving your caret. See [automatic includes](docs/CPP-AUTO-INCLUDES.md).
- You can set breakpoints and step through C/C++ code with gdb, right inside the app.
- You can flash and monitor real boards (ESP32, RP2040, Arduino), with board tools prepared automatically by Cortex and a live serial plotter instead of a wall of scrolling text.
- Or you can skip the hardware entirely and run your actual sketch against a 3D simulated board, to check the logic before you touch a soldering iron.
- You can run a supported Uno controller headlessly against repeatable sensor inputs, check behavior and deadlines, and publish reports and advisory benchmarks in GitHub Actions.

There's also an AI assistant panel you can point at Anthropic, OpenAI, or Gemini, or at a local model through Ollama or LM Studio, tuned to talk about interrupts, DMA, RTOS tasks, and peripheral registers instead of generic web dev advice.

## How it's different

Cortex isn't trying to be a prettier version of the Arduino IDE. It's closer to combining a JetBrains-style development experience with the idea that a single embedded project is rarely just C++, so the IDE shouldn't pretend otherwise.

Cortex invokes your existing native compiler for host C/C++, so C++17, C++20, and C++23 work instead of being locked out. Real-board tools are managed separately: release installers include Arduino CLI, and source-checkout launches download it automatically if needed. Cortex initializes the package indexes, then you install the matching board core inside Boards Manager. The Settings panel reports detected tools, and unavailable optional integrations explain their requirements.

## Where it's at right now

This is an early, actively developed project, not a finished product. C++23 compiling, the simulator, and the Arduino compatibility shim are the parts that have actually been run and verified end to end. Code intelligence, the AI assistant, and the simulator's accuracy are all real but limited in scope right now, and the packaged build isn't signed or auto-updating yet. The `docs/` folder, especially `PRODUCTION-READINESS.md`, is deliberately upfront about what's solid and what still needs work.

## Download

Check the [Releases page](https://github.com/Blasted-ctrl/Cortex/releases) for available Windows, macOS, and Linux installers.

One honest caveat: the build isn't code-signed yet, so on Windows you'll hit a SmartScreen "unrecognized app" prompt on first launch. Click "More info" then "Run anyway." A signed, notarized build is on the list, just not there yet.

## Getting started

```bash
npm install
npm run dev
```

That launches the IDE in development mode with hot reload. To build a distributable app yourself instead of downloading one:

```bash
npm run build
npm run dist:win
```

Native programs and the simulator use tools already on your machine. Board compilation and uploads use Cortex's automatically prepared board tools:

| To do this | You need |
|---|---|
| Compile/run C or C++ | g++ / clang++ (anything recent supports C++23) |
| C/C++ code intelligence | clangd |
| Debug C/C++ | gdb |
| Run Python | python |
| Run Rust | rustc |
| Run JavaScript | node |
| Flash boards, manage libraries | Cortex prepares board tools; install your board core in Boards Manager |

Open Settings → Toolchains inside the app and it will scan your machine and show you exactly what it found.

You do not need to download Arduino CLI separately. First-time board setup and core installation need an internet connection; progress and retry are available inside Cortex. See the [real-board quickstart](docs/BOARD-TOOLS.md) for core selection, uploading, offline use and USB requirements.

## Documentation

More detail lives in `docs/`, including the architecture, the per-language support matrix, the debugger, the 3D simulator, and a roadmap of what's planned next.

## Automated firmware tests

With Node.js 22.20.0 and a host C++ compiler (`g++` or `clang++`) installed, run from
this source checkout:

```bash
npm ci
npm run firmware:test
```

The three Uno controller scenarios cover normal operation, stopped sensor
updates and invalid ADC readings. Reports in `.cortex/test-results/` show each
assertion and its input/output evidence. `npm run firmware:selftest` verifies
that a deliberately broken timeout fails and hanging firmware is terminated.
`npm run firmware:bench` measures a fixed workload with host and virtual time
reported separately. The CLI runs without opening Electron.

The [firmware-testing quickstart](docs/FIRMWARE-TESTING.md) covers installation,
reproducing a failure, verifying the fix, saved-report replay, scenario format,
CI and benchmark baselines. [Feature documentation](docs/FEATURES.md) records
the delivered capabilities and desktop follow-up work. Native simulation tests
firmware logic against an Arduino shim; it is not AVR instruction emulation.

## License

MIT
