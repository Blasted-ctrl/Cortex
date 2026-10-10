# Automated firmware testing and CI benchmarks

Cortex can compile a supported Uno sketch, run it against repeatable simulated
inputs, check behavior and save reports without opening the desktop app. The
first release tests the actual C++ firmware logic using the existing host
Arduino shim. It does not execute an AVR firmware binary or emulate the chip's
instructions.

## Install from a fresh checkout

You need Git, Node.js 22.20.0 (the CI pin) and npm, plus a host `g++` or `clang++` that accepts
`-std=c++23` and supports C++ threads. No board, Arduino core, Arduino CLI,
sensor library or Electron window is required for this example. The JavaScript
dependencies are installed from `package-lock.json`; CI selects explicit
toolchain versions in its workflow.

Install [Node.js](https://nodejs.org/en/download) and then a compiler:

- Windows: install [MSYS2](https://www.msys2.org/), open its UCRT64 terminal and
  run `pacman -S --needed mingw-w64-ucrt-x86_64-gcc`. Add
  `C:\msys64\ucrt64\bin` to your user PATH and reopen PowerShell. If MSYS2 is in
  another directory, use that directory's `ucrt64\bin`. Microsoft documents
  the [MinGW compiler and PATH setup](https://code.visualstudio.com/docs/cpp/config-mingw).
- Ubuntu: `sudo apt-get update` followed by `sudo apt-get install g++` installs
  the host compiler. A recent distribution/compiler is required for C++23.
  See Microsoft's [Linux compiler setup](https://code.visualstudio.com/docs/cpp/config-linux).
- macOS: run `xcode-select --install` to install Apple's command-line developer
  tools, then use `--compiler clang++` with the commands below. A recent Clang
  is required. See [Apple's developer tools](https://developer.apple.com/xcode/resources/).

```sh
git clone https://github.com/Blasted-ctrl/Cortex.git
cd Cortex
node --version
g++ --version
npm ci
npm run firmware:test
```

On macOS, check `clang++ --version` in place of `g++ --version` and run
`npm run firmware:test -- --compiler clang++`. On Windows, the compiler's
`bin` directory must remain on PATH when running the resulting executable so
its runtime DLLs can be found.

Expected result: all three scenarios pass and the command exits 0. Read
`.cortex/test-results/summary.md` and inspect `.cortex/test-results/report.json`.
The [example README](../examples/firmware-testing/README.md) defines the pins,
sensor policy, deadlines and expected state transitions.

## Reproduce a failure, understand it, verify the fix

The broken fixture retains heating after the sensor stops updating:

```sh
npm run firmware:test -- examples/firmware-testing/scenarios/sensor-timeout.json --firmware examples/firmware-testing/fixtures/broken-timeout.ino --report-dir .cortex/broken-timeout
```

Expected: exit 1. The report identifies `sensor-timeout-shutdown`, its
470..480ms deadline and the relevant timeline. The last fresh D2 toggle is at
220ms; D9 stays at PWM 180 instead of turning off after the 250ms freshness
limit. The firmware bug is the missing timeout branch in
`fixtures/broken-timeout.ino`, not a compiler or runner failure.

Run the same inputs against the corrected controller:

```sh
npm run firmware:test -- examples/firmware-testing/scenarios/sensor-timeout.json --firmware examples/firmware-testing/controller.ino --report-dir .cortex/fixed-timeout
```

Expected: exit 0, D9 becomes 0, D13 becomes 1 and Serial logs TIMEOUT at 470ms.
The named assertion and remaining timeout checks pass.

Use the harness self-test for a one-command failure-detection check:

```sh
npm run firmware:selftest
```

It confirms the specific assertion failure from the broken fixture and
confirms that hanging firmware is killed as a runner error. Expected: the
self-test itself exits 0 when these checks succeed. Its report records the
expected failed/error scenarios; those statuses are evidence of the negative
tests, not an unexpected suite failure. Check the passing controller and
identical traces separately:

```sh
npm run firmware:test -- --repeat 3
```

Expected: all nine runs pass and the suite report has `reproducible: true`.

## Commands and exit codes

Run commands from the repository root. Forward CLI options after npm's `--`.

| Command or option | Behavior |
|---|---|
| `npm run firmware:test` | Run the three scenarios in `examples/firmware-testing/scenarios` |
| `npm run firmware:test -- path/to/scenario.json` | Run one saved scenario |
| `npm run firmware:test -- path/to/scenarios` | Run the JSON scenarios in a directory |
| `--firmware path/to/sketch.ino` | Override the scenario's source with a local sketch |
| `--compiler g++` or `--compiler clang++` | Select the host compiler |
| `--report-dir path/to/results` | Save reports in a separate directory |
| `--repeat 3` | Build each scenario once, run it in fresh processes three times and check matching deterministic traces |
| `--replay path/to/report.json` | Rerun scenarios preserved in a saved report |
| `npm run firmware:bench` | Measure repeated executions of the fixed benchmark workload |
| `npm run firmware:selftest` | Verify the known assertion failure and independent hang protection |

| Exit | Meaning |
|---|---|
| 0 | All requested scenarios passed |
| 1 | Firmware ran, but at least one behavior assertion failed |
| 2 | Runner error: invalid scenario, unsupported board, compiler failure, missing source, timeout, process failure or execution limit |

The compiler has a separate 60-second build timeout and its version probe has
a 5-second timeout. `wallTimeoutMs` bounds each firmware execution, not the
compiler. The virtual simulation limit and independent host watchdog serve different
purposes. A sketch that never returns or advances virtual time still gets
terminated by the wall-clock watchdog. Firmware assertion failures do not turn
compiler errors or a watchdog termination into expected test success.

Captured stdout and stderr are bounded to 4 MB in addition to `maxEvents`.
If termination cannot be confirmed, the runner closes its streams and returns
an error after a further two-second termination grace period.

## Version 1 JSON scenarios

The authoritative types are in
[`src/shared/firmwareTest.ts`](../src/shared/firmwareTest.ts); the editor/tooling
schema is [`schemas/firmware-scenario-v1.schema.json`](../schemas/firmware-scenario-v1.schema.json).
A scenario contains
a target, seed, initial pin state, timestamped inputs, limits and assertions:

```json
{
  "version": 1,
  "id": "fresh-low-reading",
  "description": "A new low sensor reading enables the actuator.",
  "firmware": { "board": "uno", "source": "../controller.ino" },
  "seed": 12345,
  "initialState": [{ "pin": 14, "value": 300 }, { "pin": 2, "value": 0 }],
  "inputs": [
    { "atMs": 20, "pin": 14, "value": 300 },
    { "atMs": 20, "pin": 2, "value": 1023 }
  ],
  "limits": { "durationMs": 100, "stepMs": 10, "wallTimeoutMs": 3000, "maxEvents": 1000 },
  "assertions": [
    { "id": "heat-on-time", "kind": "event", "event": "pwm", "pin": 9, "value": 180, "fromMs": 20, "toMs": 30 },
    { "id": "safe-limit", "kind": "range", "event": "pwm", "pin": 9, "min": 0, "max": 180, "fromMs": 0, "toMs": 100 }
  ]
}
```

`firmware.source` is resolved relative to the scenario file, while CLI override
paths are resolved from your working directory. Version 1 supports only
`board: "uno"`. Pin numbers are Uno digital 0..13 and analog A0..A5 as 14..19.
All scenario input values are integers on the ADC scale 0..1023, including
digital inputs: use 0 for LOW and 1023 for HIGH. PWM observations use 0..255;
digital output observations use 0 or 1.

Initial state is applied before `setup()`. Inputs are applied in timestamp order
with their JSON array order preserved for equal timestamps. Put the sensor
reading before its readiness toggle at the same timestamp. Each scenario uses
a fresh firmware process, resets simulator state and seeds the shim's random
generator. Virtual `delay`, `delayMicroseconds`, `millis` and `micros` make the
inputs and event timestamps independent of host scheduling. Use explicit
delays or a returning `loop()` so the simulation can make progress.

`durationMs` is the virtual-time stop, `stepMs` controls advancement between
returning loop iterations, `wallTimeoutMs` bounds host execution and
`maxEvents` bounds captured events. Time values and assertion windows must fit
the scenario duration. The validator rejects unsupported versions/boards and
invalid fields before launching firmware.

## Assertions

Windows are inclusive and use virtual milliseconds. Assertions inspect the
event timeline, not pixels or desktop component animations.

| Kind | Fields beyond `id` and `kind` | Checks |
|---|---|---|
| `event` (serial) | `event: "serial"`, `text`, `fromMs`, `toMs` | Matching state/log text appears within the deadline |
| `event` (output) | `event: "pin"`, `"pwm"`, `"tone"` or `"mode"`, `pin`, `value`, `fromMs`, `toMs` | Required output event appears within the deadline |
| `state` | `event: "pin"`, `"pwm"` or `"tone"`, `pin`, `value`, `atMs` | Latest known output at that instant equals the expected value |
| `range` | Output `event`, `pin`, `min`, `max`, `fromMs`, `toMs` | Output stays within the bounds across the window, including the state entering it |
| `sequence` | `texts`, `fromMs`, `toMs` | Serial state texts occur in the specified order within the window |

Give every assertion a meaningful, unique ID such as
`sensor-timeout-shutdown`. A range check covers actuator limits; an event check
enforces the deadline; sampled state and sequence checks capture recovery and
state transitions. A range with no known output cannot prove safety.

## Reports and replay

The readable summary lists scenario status, failed assertion IDs and failure
times. The suite report is a version 1 object with `generatedAt`, `exitCode`,
`reproducible` and `results`. Each completed result preserves the complete
scenario, assertion verdict and evidence,
input/output timeline, stdout/stderr, compiler output and the build
configuration. Build information includes the compiler/version/arguments,
top-level source/shim/generated C++ driver SHA-256 fingerprints, host environment, Git revision and
dirty-worktree state. A scenario that cannot be loaded has an error result
with its scenario path and message. Execution metrics separate host wall time from simulated
duration; a trace fingerprint supports reproducibility checks.

Build failures preserve validated scenario configuration and the firmware path,
with compiler arguments, build metadata and structured compiler output when
compilation was reached. They can be replayed after fixing the source or toolchain.

Keep a report directory per failure so a later run does not replace the report
you are investigating. Replay saved configuration:

```sh
npm run firmware:test -- --replay .cortex/broken-timeout/report.json --report-dir .cortex/replayed-timeout
```

Keep the firmware source and toolchain available as well as the report. Replay
uses embedded scenario configuration even if the original JSON was edited or
deleted; it uses the original recorded source path unless `--firmware` overrides
it. Fingerprints show whether the code or
simulation implementation has changed. It is not a portable precompiled
firmware archive. To verify a fix, replay with a corrected source using
`--firmware examples/firmware-testing/controller.ino`.

## CI and benchmarks

The [firmware GitHub Actions workflow](../.github/workflows/firmware-tests.yml)
runs on pull requests, pushes to main and manual dispatch,
installs pinned tooling with the lockfile, executes the passing suite and
harness self-test, writes a job summary and uploads reports even when a test
fails. Functional failures and runner errors fail the job. The workflow is
source-controlled; an actual remote CI result must be checked in GitHub
Actions after a push. It pins Node 22.20.0, the official GCC 14.2.0 container by
digest and GitHub actions by commit SHA; `npm ci` uses the committed lockfile.
No external Arduino library is needed for this example.

```sh
npm run firmware:bench -- --runs 10 --baseline benchmarks/firmware-baseline.json --report-dir .cortex/benchmarks
```

The workload is
[`examples/firmware-testing/benchmark.json`](../examples/firmware-testing/benchmark.json):
60,000ms of virtual time at a 10ms step, fixed inputs and seed. By default two
warmup runs are excluded before ten measured runs; `--warmup` and `--runs`
select the counts. Compilation is outside the timed run interval. Repeated host execution times and simulation
throughput are reported with compiler, platform, CPU, Node version and source
revision. Virtual time describes the workload, not hardware speed or a sensor
deadline measured on the host. Host time includes the cost of launching and
running the simulation process and collecting its output. The summary reports
median, p95, minimum and maximum host milliseconds, virtual milliseconds per
host second and output events per host second; input injection is excluded
from the output-event count.

Baseline comparisons are advisory while CI variability is established. A
median host duration increase over 20%, or throughput decrease over 20%, flags
an advisory without failing an otherwise passing benchmark. Compare
like environments and workloads; results from a different CPU, OS, compiler or
code/configuration are contextual data rather than a trustworthy performance
regression. Reports are `.cortex/benchmarks/benchmark.json` and `summary.md`.
The checked-in initial baseline was captured locally on Windows; an Ubuntu CI
run reports the environment mismatch as advisory while a suitable CI baseline
is established. Save a passed, reproducible workload explicitly:

```sh
npm run firmware:bench -- --runs 10 --save-baseline .cortex/my-firmware-baseline.json
```

Review the captured environment and measurements before promoting that file
to `benchmarks/firmware-baseline.json`. No baseline is compared unless
`--baseline` is supplied, and CI does not silently replace it. A requested
missing or invalid baseline is a runner error. See the
[benchmark reference](../benchmarks/README.md) for compatibility checks and
baseline promotion.

## Supported capabilities and limits

The first tested workflow uses analog input, digital sample-ready input, PWM,
digital fault output, Serial logs and Arduino timing APIs. Cortex shares build
preparation with the desktop simulator, but the desktop remains interactive
and uses elapsed host time; the CLI selects deterministic virtual time.

This is native single-sketch C++ execution against a shim: host integer sizes,
floating-point behavior and standard library differ from AVR. There is no CPU
cycle accuracy, instruction timing, analog circuit solver, electrical fault
model, interrupt/RTOS scheduling guarantee, real serial device, or general
I2C/SPI sensor model. PWM is an observed duty value, not a physical waveform.
Passing tests establish the behavior asserted for the supplied scenarios; they
do not establish physical-board timing or safety. Third-party libraries that
require MCU registers, real hardware or unsupported APIs need separate support.

The shipped firmware examples are single files. Local includes can compile, but
the current source fingerprint covers the top-level sketch, shim and generated
driver, not external headers or libraries. Preserve those dependencies and use
the recorded Git revision when reproducing a custom sketch; baseline comparisons
cannot detect an included-file change from the top-level fingerprint alone.

The first release intentionally ships the CLI, scenarios, reports, CI,
benchmarks and this quickstart. Desktop Run Tests/results/replay, a recorded
demonstration, two fresh-install teammate trials and one outside-team trial are
tracked in [tasks/todo.md](../tasks/todo.md). Those user trials have not been
completed by automated local tests.

## Troubleshooting

- Compiler not found: run `g++ --version` or `clang++ --version` in the same
  terminal, fix PATH and select the installed compiler with `--compiler`.
- C++23 option rejected: update the host compiler. AVR/ARM cross-compilers
  cannot produce the host executable used by this runner.
- Windows executable fails to start: keep the compiler's runtime DLL directory
  on PATH and inspect the report's stderr/runner error.
- Exit 1: open the failed assertion and trace around its virtual timestamp;
  compare the last sensor input with the corresponding PWM/pin/Serial output.
- Exit 2: inspect compiler logs or the runner error before changing assertions.
  Increase the host watchdog only for measured slow execution, not to hide an
  infinite loop.
- A0 changes have no effect: toggle D2 as well; the example consumes only fresh
  samples. Use ADC-scale digital input values rather than `1` for HIGH.
