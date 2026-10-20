# Firmware testing example

Run from the Cortex repository root after installing Node.js, dependencies and a
host C++ compiler:

```sh
npm run firmware:test
```

The default suite runs the three JSON files in `scenarios/` against
`controller.ino`. Expected result: `normal`, `sensor-timeout` and `invalid-input`
pass; exit code 0. Reports are written to `.cortex/test-results/`.
See the [complete quickstart](../../docs/FIRMWARE-TESTING.md) for setup, failure
reproduction, replay, JSON format and simulation limitations.

## Controller contract

The first supported target is an Arduino Uno sketch compiled into a host C++
program with Cortex's Arduino shim. The example tests logic without physical
hardware or the desktop app.

| Pin | Direction | Meaning |
|---|---|---|
| A0 / 14 | Input | Sensor ADC value, 0..1023 |
| D2 | Input | Sample-ready level toggles once per new sample |
| D9 | Output | Actuator PWM, 0 or 180; safety limit 180 |
| D13 | Output | Fault indicator, HIGH for INVALID or TIMEOUT |

Samples from 100 through 900 are valid. A fresh sample below 400 starts HEATING
with PWM 180; a valid sample at or above 400 enters IDLE with PWM 0. A0 changes
are only consumed when D2 changes level. In scenarios, D2 uses ADC-scale values
0 and 1023 to represent LOW and HIGH; digital output reports use 0 and 1.

An invalid sample enters INVALID, turns the actuator off and raises the fault
indicator. It counts as a received sample and resets the freshness deadline,
but only another fresh, valid sample clears the fault. After 250ms without any
new sample, the controller enters TIMEOUT, turns off and raises the fault.
It also accepts fresh valid samples after TIMEOUT. Each loop polls then calls
`delay(10)`, so responses occur on the 10ms polling grid.

The boot state is safe: PWM 0, fault LOW, serial log BOOT. Transitions log
HEATING, IDLE, INVALID or TIMEOUT once when the state changes.

## Scenarios

| File | Inputs | Required response |
|---|---|---|
| `scenarios/normal.json` | Fresh low/high valid samples every 100ms | Alternate HEATING and IDLE; never exceed 180 or raise a fault |
| `scenarios/sensor-timeout.json` | Fresh low readings at 20, 120 and 220ms, then no updates | Stay heating through 460ms; switch off and log TIMEOUT by 480ms; remain off |
| `scenarios/invalid-input.json` | Fresh 1023 at 120ms and 0 at 420ms; valid recovery samples | INVALID immediately on each bad sample; stay off without freshness; recover on fresh valid samples |

Sensor-invalid values are physically representable ADC values outside this
application's valid range. Sending values outside 0..1023 is a malformed
scenario, not an invalid-sensor behavior test.

`fixtures/broken-timeout.ino` deliberately removes only the timeout transition.
Run it against the stopped-sensor scenario:

```sh
npm run firmware:test -- examples/firmware-testing/scenarios/sensor-timeout.json --firmware examples/firmware-testing/fixtures/broken-timeout.ino --report-dir .cortex/broken-timeout
```

Expected: exit code 1, with `sensor-timeout-shutdown` failed. The last fresh
sample is at 220ms, but D9 remains PWM 180 past the 470ms freshness deadline.
Re-run with `--firmware examples/firmware-testing/controller.ino` to verify the
fix. `fixtures/hanging.ino` spins forever in `setup()`; it verifies that the
wall-clock watchdog terminates stuck firmware with runner-error exit code 2.

```sh
npm run firmware:selftest
```

`fixtures/missing-range-check.ino` removes only the ADC range check, so a
disconnected sensor reading 0 turns the heater on. The scripted demo
(`npm run demo:record`) starts from this file and types the fix. Against the
invalid-input scenario it fails 8 of 14 assertions, including
`invalid-low-shutdown` (PWM 180 at 430ms where 0 is required); the normal and
stopped-sensor scenarios still pass:

```sh
npm run firmware:test -- examples/firmware-testing/scenarios --firmware examples/firmware-testing/fixtures/missing-range-check.ino --report-dir .cortex/missing-range-check
```

The self-test treats the expected broken assertion and watchdog termination as
successful harness checks; it does not add those fixtures to the passing suite.
It saves its evidence in `.cortex/selftest-results/report.json` and `summary.md`.

`benchmark.json` is a fixed 60,000ms virtual workload with a 10ms step. It sits
outside `scenarios/` so benchmarks do not run as part of the default behavior
suite. Use `npm run firmware:bench` for host timing and throughput measurements.
