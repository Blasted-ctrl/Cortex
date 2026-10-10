# Production readiness

Updated 2026-10-10 for customer-release hardening. Working features are not the
same thing as a validated release. Cortex is not yet approved for customer rollout.
The executable quality floor is [CONSTRAINTS.md](../CONSTRAINTS.md).

## Release blockers

1. Dependency remediation. After compatible fixes and the approved tooling
   changes, local
   `npm audit --audit-level=high` still fails with 31 findings: 3 critical,
   19 high and 9 moderate (initially 43, then 32 after compatible fixes).
   The separately approved electron-vite 4.0.1 upgrade removes one moderate
   affected dependency group. Root Vite 7.3.7 is separately approved and installed;
   its retained Vitest 2 stack still has compatible nested Vite 5.4.21 findings.
   Combined/native upgrade verification is recorded separately, not inferred from
   an audit count. This includes desktop and
   build/test tooling; dev-only is not automatically unreachable. The audit remains
   a blocking CI gate. Remaining major Electron/Vitest/packaging changes need version-by-
   version review and verification; no forced upgrade or advisory waiver was applied.
   Owner: project maintainer; review date: 2026-10-10; deadline: before any release.
   See [Dependency remediation](DEPENDENCY-REMEDIATION.md) for the path-based triage.
2. Signing and clean-machine installer tests. Windows Authenticode and macOS
   signing/notarization still need owner credentials. A local Windows package
   attempt hit the signing-tools archive's symlink privilege requirement. A staged
   bundled-tools preview is not proof that installation/uninstallation works.
   Run and install the actual Windows/macOS/Linux workflow artifacts.
3. Hardware validation. Verify/Upload needs a matching board core, explicit
   port, USB permissions and sometimes vendor drivers/bootloader setup. No real
   board was flashed during this hardening pass. Managed Arduino CLI removes a
   separate CLI installation requirement, not these hardware prerequisites.
4. Fresh-install trials. Two teammates and an outside team still need to run
   the documented firmware workflow and report setup/recovery problems. The
   [recorded local demonstration](demos/README.md) now shows the passing sketch,
   broken sketch, failure evidence and verified fix; it is not a human trial.
5. Recovery and maintenance. Decide release update policy and validate crash
   recovery/unsaved-work recovery. An auto-updater and privacy-reviewed crash
   reporting pipeline are not implemented.

## Implemented safeguards

- Local folders are real filesystem projects. Save/Save All propagate failures;
  successful buffers become clean individually. Writes stage and flush a temporary
  sibling before replacement; external edits are compared with the saved text.
  Rename refuses existing destinations, and mutation paths are checked against
  the real workspace including symlink/junction destinations.
- Folder transitions and window close wait for file and circuit saves. Failed writes
  leave the project and dirty buffers available. Missing/unreadable recents report
  errors. Invalid UTF-8 and binary files cannot silently become writable text.
  Circuit saves are ordered and compare the last loaded/saved disk snapshot.
  These checks narrow overwrite races; they are not OS-level atomic compare-and-swap.
- Git status/diffs, staging, unstaging, commits, branch selection/creation, init,
  fetch, fast-forward-only pull and upstream-scoped push are wired to the desktop.
  Literal pathspecs, subprocess timeouts, environment isolation, error redaction
  and workspace/repository scope checks protect the command boundary.
  No customer repository was committed or pushed as a test fixture.
- Diagram v3 persists board choice, real part-to-part/board wires, jumper kind and
  component settings. Old layouts migrate; malformed/unsupported layouts are
  rejected without replacing their saved files. Motors, stepper driver signals,
  bounded ideal actuators and configurable theoretical power supplies have models,
  not just palette icons. Ground, supply, voltage, pin and driver warnings explain
  the supported topology checks.
- The 3D view supports full orbit, top/underside camera presets, pin labels and pin
  function inspection. Teensy 4.1 includes edge pins and separately labeled
  underside QSPI pads. Geometry is stylized, not a manufacturing/CAD drawing.
- The release pipeline gates all three OS packages on type checks, real firmware
  tests, audit and build, then creates a draft only. Published tags and ambiguous
  release lookups are refused; credentials are not persisted by checkout.

## Packaging and manual publication

`npm run dist`, `npm run dist:win` and `npm run dist:dir` build local artifacts
with publication disabled. These commands do not upload a GitHub release.

For an authorized maintainer publication, use `npm run release` with the supported
Node/npm installation and a release-scoped GitHub token in `GITHUB_RELEASE_TOKEN`,
`GH_TOKEN` or `GITHUB_TOKEN` (in that priority order). Do not put tokens in source
or command arguments. The command accepts no forwarded arguments. It runs type
checks, tests with the existing CI compiler-prerequisite guard active, the
blocking high-severity audit and the build before any release lookup or publisher
invocation. The audit explicitly includes development and optional dependencies,
even when the incoming environment requests their omission. The current red audit
intentionally prevents publication. See npm's [audit configuration](https://docs.npmjs.com/cli/v10/commands/npm-audit/).

The destination is pinned to `Blasted-ctrl/Cortex` and `v<package version>`.
Only an absent tag or an existing matching draft is eligible; published releases,
bare-version aliases, malformed responses and lookup failures are refused. A
tag lookup alone does not establish draft absence, so the command also checks the
first 100 listed releases, covering the installed publisher's default 30-entry
lookup. See GitHub's [tag lookup](https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name)
and [release listing](https://docs.github.com/en/rest/releases/releases#list-releases)
contracts. This is not an exhaustive inventory of older releases.

Configuration must use the single pinned draft publisher, without inherited,
platform-specific or version overrides. The verified configuration is handed to
electron-builder as an owned, credential-free temporary JSON snapshot, then
removed after the child finishes. Quality-check children do not receive the
publication token. Publisher exits/signals fail the command; if it fails after
invocation, inspect any existing draft before retrying. Creating a draft does not
approve customer distribution. This wrapper protects the documented commands,
not arbitrary direct electron-builder invocations or maintainer-modified source.
No real publication was attempted during verification.

## Honest simulation and integration boundaries

The supported firmware runtime compiles real Uno-style `setup()`/`loop()` against
a host Arduino shim. It is not an AVR/ESP32/Teensy CPU emulator or a Linux runtime.
The other board choices are inspection/topology models, not new executable cores.
Unsupported pulse/shift APIs now fail explicitly instead of returning fake data.

Electrical warnings are bounded topology heuristics, not SPICE, circuit certification
or a guarantee against damaged hardware. There is no resistor/current/thermal
solver, bare stepper coil physics, real servo pulse model, motor torque/load model,
complete sensor catalog, or I2C/SPI/UART-device emulation. Desktop actuator motion
uses host elapsed time; it is not the deterministic CLI virtual-time benchmark.

Wokwi JSON import/export supports a strict documented Uno/LED/ideal-button/
potentiometer/buzzer subset. Unsupported parts and switch bounce are rejected;
neither a Wokwi license nor its full simulator engine is embedded. Tinkercad opens
in the browser; a native/offline Tinkercad simulator is not integrated. See
[Simulation workbench](SIMULATION-WORKBENCH.md) for formats and exact limits.

## Verification and remaining coverage

Automated tests exercise native temporary filesystem/Git repositories, delayed
store saves and transitions, diagram validation/topology, host-compiled Arduino
behavior, firmware failure detection/watchdogs, reporting and benchmarks. Some
older source-text guards remain, supplemented with actual store-behavior tests.
The suite is not proof of arbitrary UI, peripheral or OS correctness.

Desktop smoke tests must use isolated profiles/projects and positive controls for
save and close before testing failure paths. Keep screenshots and exact observed
outcomes; do not substitute DOM presence for a rendered 3D view or claim untouched
hardware/platforms were tested.

Run:

```sh
npm run typecheck
npm test -- --maxWorkers=4 --minWorkers=1
npm run build
npm audit --audit-level=high
npm run firmware:test
npm run firmware:selftest
```

Feature instructions: [Projects](PROJECTS.md), [Git](GIT.md),
[Board tools](BOARD-TOOLS.md), [Automatic includes](CPP-AUTO-INCLUDES.md),
[Firmware testing](FIRMWARE-TESTING.md). Remaining acceptance work is tracked in
[tasks/todo.md](../tasks/todo.md). Historical audit notes remain in
[AUDIT-ROUND5.md](AUDIT-ROUND5.md).
Current local evidence and explicit untested boundaries are in
[Release validation](RELEASE-VALIDATION.md).
