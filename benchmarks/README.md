# Firmware benchmarks

Run the supported Arduino Uno sensor-controller workload without opening Cortex:

```sh
npm ci
npm run firmware:bench -- --runs 10 --baseline benchmarks/firmware-baseline.json --report-dir .cortex/benchmarks
```

The default workload is `examples/firmware-testing/benchmark.json`: 60,000 ms of virtual time with repeatable timestamped sensor updates. The runner builds once, excludes two warmup runs, then starts a fresh simulator process for each of ten measured runs. The seed, inputs, firmware bytes, shim bytes and scenario limits identify the workload. All warmup and measured traces must match. Firmware assertions, runner errors and inconsistent traces fail the command; performance alerts do not.

## What is measured

`benchmark.json` contains every measured sample, the environment, compiler flags/version, source hashes, revision and dirty-worktree status. `summary.md` shows the median, nearest-rank p95, minimum and maximum for:

| Measurement | Meaning |
| --- | --- |
| Host execution, ms | Simulator startup, execution and output collection. Excludes compilation and warmups. |
| Virtual ms / host second | Model throughput. A virtual minute can execute much faster than a real minute. This does not predict hardware timing. |
| Output events / host second | Number of captured pin/mode/PWM/tone/serial output events divided by host duration. Input injection events are excluded. |

Virtual time remains deterministic even when host timings vary. Measurements include process startup, so they describe this end-to-end runner workload rather than isolated MCU instruction speed. The simulator executes host-compiled sketch C++ with Cortex's API shim; it does not execute an AVR binary or model the Uno instruction pipeline.

## Baseline comparisons

The committed `firmware-baseline.json` is an actual saved report, not a performance target. A comparison requires matching scenario/firmware/shim hashes, run and warmup counts, compiler version/flags, host OS, architecture, CPU model and Node version. Temporary build paths are normalized. Revisions and runner source hashes may differ because measuring changes is the purpose of a baseline. The kernel release is recorded but not required to match because hosted runners receive kernel patches.

This first workload is a standalone sketch. Its firmware hash covers the
top-level source file; included custom headers/libraries are not fingerprinted.
Pin and preserve such dependencies when benchmarking custom sketches. Stored
baseline paths are normalized placeholders; the recorded measurements and
environment are from the actual local run.

A median host-duration increase over 20%, or throughput decrease over 20%, produces an advisory in the readable summary. The command still succeeds when firmware behavior and reproducibility pass. Host load and GitHub runner allocation can change timings; collect repeated observations before treating an alert as a performance regression.

If the saved baseline was captured on Windows and CI runs Linux, or GitHub assigns a different CPU model, the report explicitly says the comparison is incompatible and gives the reasons. It publishes the measurements without implying an apples-to-apples speed comparison. The initial baseline is only a bootstrap measurement; it is not evidence that CI variability is established.

To establish a baseline on a chosen machine or CI environment, run without `--baseline`, inspect its successful reproducible report, then save a new baseline and review the change:

```sh
npm run firmware:bench -- --runs 10 --report-dir .cortex/benchmarks
npm run firmware:bench -- --runs 10 --save-baseline benchmarks/firmware-baseline.json --report-dir .cortex/benchmarks
```

`--save-baseline` only saves a successful reproducible report. Alternatively, copy an inspected report with PowerShell's `Copy-Item .cortex/benchmarks/benchmark.json benchmarks/firmware-baseline.json` or Linux/macOS's `cp .cortex/benchmarks/benchmark.json benchmarks/firmware-baseline.json`. Download the `firmware-reports-*` artifact to promote a successful CI report instead. Do not manufacture a Linux baseline from Windows measurements. An explicitly requested missing, malformed, failed or non-repeatable baseline is a runner error rather than a silently skipped comparison.

## CI and pinned dependencies

`.github/workflows/firmware-tests.yml` runs on pull requests, pushes to `main`, and manual dispatch. It typechecks, runs unit tests and builds Cortex before running the three firmware scenarios three times, the broken-fixture/watchdog self-test, and the benchmark. Reports are published in the job summary and uploaded even when a preceding test fails. The hidden `.cortex` directory is included explicitly; GitHub's artifact action otherwise excludes hidden files. See the official [artifact action documentation](https://github.com/actions/upload-artifact#uploading-hidden-files) and [job summary documentation](https://docs.github.com/en/actions/reference/workflow-commands-for-github-actions#adding-a-job-summary).

CI uses Ubuntu 24.04 with the official GCC 14.2.0 Debian Bookworm `linux/amd64` image pinned to `sha256:82549aa8f90ada3236a8be70c74543132a76662ef33f0c3271ed802b81584a82`, resolved from the official Docker registry. This fixes GCC, libstdc++, libc and image build utilities together. Cortex's simulation shim is committed source; no downloaded Arduino library is needed for this example. [Docker digests](https://docs.docker.com/dhi/explore/security-concepts/digests/) identify immutable image content; GitHub documents [container jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/run-jobs-in-a-container).

Node is pinned to [22.20.0](https://nodejs.org/en/blog/release/v22.20.0). `npm ci` installs the committed lockfile. Checkout v4.2.2, setup-node v4.4.0 and upload-artifact v4.6.2 are pinned to verified release commit SHAs. Update the pins deliberately and capture a new compatible baseline after a toolchain change. The GitHub host itself is not immutable; recording its CPU, kernel and Node version is necessary context for the advisory measurements.
