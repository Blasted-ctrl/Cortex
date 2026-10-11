# Dependency release gate

Audit snapshot: 2026-10-09, the workspace's npm lockfile, `npm audit --json`.
Initial findings: 43 total, 3 critical, 27 high and 13 moderate. The release gate
is red; no forced remediation, advisory waiver or public release was performed.
The user approved cautious compatible fixes followed by individually reviewed
major upgrades. Compatible updates and their verification are tracked below.
Review owner: Cortex maintainer. Review date:
2026-10-09. Resolve before customer distribution.

## Approved compatible update pass

Before install, exact current manifests/lockfile were backed up outside the
workspace. Four compatible direct updates were installed: `@types/node`
22.20.1 to 22.20.5, `autoprefixer` 10.5.3 to 10.6.1, `postcss` 8.5.19 to
8.5.29, and `zustand` 5.0.14 to 5.0.15. Compatible transitive resolutions
include xmldom, brace-expansion, http-cache-semantics, ip-address, js-yaml and
fflate fixes. In total, 18 unique packages changed across 26 lockfile locations.
Installed package versions match the lockfile; no overrides, configuration
guard exceptions, forced major updates or native rebuilds were introduced.
Post-update types, all 83 test suites, desktop/tools build, the 29 firmware
assertions and the broken/hanging-fixture self-tests pass. These checks include
fixes for the Explorer/native shutdown defects found during verification.
Rebuilt native save/conflict/watcher/editor/3D checks also pass. The attempted
whole-root fault could not be set up because Windows refused the owned-fixture
rename; it remains unverified natively. Passing functional checks do not waive
the audit or remaining installer/hardware/user gates. See [validation evidence](RELEASE-VALIDATION.md).

The attempted `pdf2json` 4.1.0 minor was rejected because its Node >=22.23.2
requirement exceeds the pinned CI version and Electron's embedded runtime.
It remains 4.0.3, with the manifest limited to `~4.0.3` to prevent an incompatible
minor from being resolved by a future install. This is a compatibility hold,
not a security exception.

Post-install audit: 32 findings, comprising 3 critical, 19 high and 10 moderate
(initially 43: 3 critical, 27 high, 13 moderate). The high/critical release gate
still fails. Counts include affected dependency groups, not just unique exploits.

Node type definitions remain on major 22 to match the firmware/release CI pin.
General CI's older Node 20 pin is aligned by the separately approved tooling
upgrade below. Electron metadata and native runtime are both 33.4.11 and are not
included in either pass. The user reported saving/closing Cortex, but a read-only
process check still found its existing instance; it was left untouched. Runtime
replacement requires verifying that it has closed, not terminating it as a test
shortcut. Each major update needs
its migration/peer review and a separate confirmation before installation.

## First approved major upgrade: electron-vite

The user separately approved `electron-vite` 2.3.0 to 4.0.1. It is installed,
keeping Vite 5.4.21, Vitest 2.1.9 and Electron 33.4.11 unchanged. Its published
peer range admits Vite 5/6/7; `npm ls --depth=0` has no peer errors.
The v3 preload-resolution changes and v4 ESM-only tooling/Node floor were reviewed
against the [tagged changelog](https://raw.githubusercontent.com/alex8088/electron-vite/v4.0.1/CHANGELOG.md)
and [published package metadata](https://raw.githubusercontent.com/alex8088/electron-vite/v4.0.1/package.json).

Applied migration: renamed `electron.vite.config.ts` to `.mts`, updated its
`tsconfig.node.json` inclusion and documentation, and aligned general CI with the
existing exact Node 22.20.0 pin. The application's CommonJS output, optional
native/PDF externals and Monaco backport are preserved; no global `type: module`
was added. Exact pre-upgrade files were backed up outside the workspace, and
installation used `--ignore-scripts`; no runtime replacement or native rebuild.
See the [maintainer's config guidance](https://electron-vite.org/guide/troubleshooting).
Affected files: manifest/lockfile, config rename, `tsconfig.node.json`,
`.github/workflows/ci.yml` and the architecture documentation.

Types, all 83 suites (1466 passes, five explicit skips), desktop/tools build,
firmware suite (29 assertions) and broken/hanging-fixture checks pass. Types,
tools, firmware/self-test and all 83 suites also pass under the exact Node
22.20.0 CI pin using a verified portable copy, with unchanged manifests and
no global install; fresh installation and remote CI remain unverified. Actual
development/production save/conflict/watcher/editor/terminal/3D checks and native
external-module controls pass; owned processes and debugging listeners closed
normally. Native PDF-picker and hardware/installer paths remain unverified.
See [validation evidence](RELEASE-VALIDATION.md). The existing style
scanner now includes `.mts`, with a deliberate negative fixture caught and
removed before a passing rerun. The current audit is 31 findings:
3 critical, 19 high and 9 moderate. This upgrade does not clear the remaining
Vite/Vitest, Electron or packaging findings. Later majors require their own
confirmation, peer/migration review and checks, not a single forced install.

## CI enforcement without dependency upgrades

Ordinary CI now uses verified immutable checkout/Node action pins, read-only
token permissions, disabled checkout credential persistence, stable Windows/Linux
runner labels, an explicit required host-compiler probe and a bounded job timeout.
It also runs `npm audit --audit-level=high` without exceptions. These controls do
not remediate the last recorded 31 findings or turn the audit green; they make
the existing release floor visible in ordinary CI. Workflow regression checks
pass locally; remote Actions results remain unverified. See the
[CI architecture notes](ARCHITECTURE.md#continuous-integration).

## Second approved major: Vite

The user separately approved Vite 5.4.21 to 7.3.7 and raising the already
installed React plugin's manifest floor to `^4.7.0`. The installed tree now
matches both floors. See [support policy](https://vite.dev/releases) and the
[maintainer's advisory](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22).

Both [Vite 6](https://v6.vite.dev/guide/migration) and
[Vite 7](https://v7.vite.dev/guide/migration) migrations were reviewed, including
resolver conditions, stricter CommonJS evaluation, CSS configuration and browser
targets. Keep the `.mts` tooling config, Node pin, native/PDF externals and Monaco
backport/exclusion. Electron-vite 4.0.1 and installed React plugin 4.7.0 admit
Vite 7. Raising the plugin floor encodes that compatibility, not a plugin major.

Vitest/vite-node 2.1.9 still depend on Vite 5, and mocker 2 has an optional Vite 5
peer. A valid isolated upgrade must preserve their compatible nested resolution;
never force them onto Vite 7. This leaves those security findings until a separately
reviewed Vitest upgrade. Check [Vitest metadata](https://raw.githubusercontent.com/vitest-dev/vitest/v2.1.9/packages/vitest/package.json)
and [mocker metadata](https://raw.githubusercontent.com/vitest-dev/vitest/v2.1.9/packages/mocker/package.json).

Two incompatibilities were actually reproduced, not inferred from a green
application check: the retained Vitest loader rejected root Vite's ESM import,
and a dedicated config typecheck rejected the cross-major plugin type. The
config is now `vitest.config.mts`; its PDF helper builds with root Vite while
importing its plugin type from `vitest/config`. The ordinary Node typecheck now
includes this config/helper, and the actual packaging matcher excludes both
tooling config names in every supported extension. Existing assertions and
deadlines are unchanged. Separate scheduling validation serializes test files
and concurrent native compiler cases. `fileParallelism: false` resolves the
existing command's worker ceiling to one while preserving file isolation; it is
not shared-global single-fork mode. Explicit within-case races remain intact.
This does not replace builds or globally cap unrelated CLI/compiler invocations.

Portable Node 22.20.0/npm 10.9.3 installed with `--ignore-scripts`. Independent
review confirms a compatible graph and unchanged hashes for all 70
Electron/native binaries, with no package-manager guard exceptions. Root Vite
resolves 7.3.7, root esbuild
0.28.2, and the test stack keeps compatible Vite 5.4.21/esbuild 0.21.5. An npm
cleanup warning left one locked, hidden old esbuild binary; no user process was
terminated or runtime replaced. Focused config/preload/packaging/real-PDF checks
pass: four suites, 56 tests and both ordinary typechecks. The combined production
build also passes. The first full regression was interrupted by laptop sleep:
Windows recorded sleep and a 3,625,867 ms clock advance, after which the independent
watchdog stopped the owned test tree. That run is not a pass. An unchanged serial
suite rerun passes all eight applicable tests with its existing CI-only check
skipped. The awake full rerun exits 1: 96 suites pass, with two real
desktop-firmware cases exceeding their unchanged 90/60-second deadlines. Serial
checks pass. This failed receipt is retained, not waived as a slow host.

The within-file-only scheduling candidate also fails the full gate: 96 suites
pass, 1685 cases pass, two desktop cases exceed those same deadlines, and five
normal explicit skips remain. The independent watchdog does not fire. This
candidate is not credited as a remedy; a serial cross-file native-suite control
passes 31 applicable cases in two suites (one existing explicit skip), including
all 11 desktop cases within their original deadlines. The config guard fails
before adding the file-serialization setting and passes all 24 cases afterward.
The full serial gate passes: 97 suites, 1688 passing cases and the same five
existing explicit platform/CI skips. Types, the production build, nine firmware
runs (three repetitions per scenario), both negative harness checks and the
ten-run benchmark also pass. The benchmark correctly rejects its incompatible
saved baseline; no performance regression or improvement is inferred. Final
native/fresh-source acceptance remains separate, including a Windows expanded
folder restoration defect found in the final desktop checks. All failing receipts are retained in the
[validation ledger](RELEASE-VALIDATION.md).

The 2026-10-10 fresh registry audit exits 1 with 31 findings: 3 critical,
19 high, 9 moderate. Its flagged Vite paths are the retained test stack's nested
5.4.21 copies, not root 7.3.7. The full installed tree exits 0; six package-manager
configuration paths, manifests and runtime/bundle hashes remain unchanged
before/after these read-only audit/tree commands.
Nested old test tooling still contributes affected paths. No forced Vitest
upgrade or security waiver follows from this step; verify every remaining gate
before proposing another major.

The final combined baseline subsequently passes on implementation `c15627f`:
99 suites/1797 cases plus the same five skips, types/build and CLI checks. Its
normal fresh locked install, types/build and genuine native terminal controls
also pass separately. Explicit kill retains an upstream ConPTY cleanup warning
and follow-up; no fresh full-suite, clean-stderr or release claim is inferred.
The next-major baseline condition is now satisfied. See the validation ledger.

## Third approved major: Vitest 4.1.11

The user approved this isolated step on 2026-10-10, after the current combined
and fresh-install gates finish. That baseline is complete; Vitest 4.1.11 is now
installed; all 277 focused cases, types and production/tools build pass. The full
combined suite also passes: 99 files, 1797 cases and the same five explicit skips.
Repeated firmware, negative self-tests and the ten-run benchmark pass. The
unchanged-runtime desktop acceptance passes. The new-lock normal clean install
also passes, followed by the same 12 focused suites/277 cases; its first C:
attempt failed for disk exhaustion and remains recorded separately.
The official registry lists Node
20/22/24 and Vite 6/7/8 compatibility, so the pinned Node 22.20.0/root Vite 7.3.7
meet its prerequisites. The maintainer still supports the 4.1 line with important
and security backports; versions below 4.1 are unsupported. See the
[support policy](https://vitest.dev/releases) and
[fixed-version migration guide](https://raw.githubusercontent.com/vitest-dev/vitest/v4.1.11/docs/guide/migration.md).

4.1.11 fixes the recorded
[mocker path advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9);
the older 3.2 line is not a complete security stopgap. Version 4 replaces
vite-node with Vite's module runner and removes tinypool, whose retained older
versions have an [options advisory](https://github.com/tinylibs/tinypool/security/advisories/GHSA-85c8-ppgw-ccpr).
This is not a claim that it clears every release finding.

The change is confined to the test-tool stack, live commands and documentation.
The obsolete `--minWorkers` CLI option is removed; file isolation, serial native
scheduling, the worker ceiling, all deadlines, assertions, compiler prerequisites
and explicit platform skips are preserved.
Review constructor mocks and the intermediate v3 fake-timer change to
`performance.now()` ([v3 migration](https://raw.githubusercontent.com/vitest-dev/vitest/v3.2.7/docs/guide/migration.md)).
The existing test include pattern already confines discovery to `test`.
Verification reruns focused/full tests, types/build, firmware checks, native acceptance
and audit. Do not combine Electron, packaging, Tailwind or PDF major upgrades
with this step, force peer resolution, or edit the lockfile manually.

Pinned npm 10.9.3's resolving install initially fails in Arborist's circular peer
loading (`node.parent` is null before `edgesOut`). A separate copied manifest/lock
with no installed dependencies fails identically with `--package-lock-only` and
`--prefer-dedupe`; neither failure modifies the original lock or installed tree.
This matches the official [npm fix](https://github.com/npm/cli/pull/8448/files).
A disposable official npm 11.16.0 resolver, compatible with pinned Node 22.20.0,
generates the lock without scripts; then the original pinned npm 10.9.3 installs
that exact graph successfully with `--ignore-scripts` (10815 ms). No global
package manager, Node/Electron runtime, CI pin, dependency override or peer bypass
is changed. That root install is not normal fresh-install proof; the separate
exact-checkpoint D: fixture subsequently consumes the new lock with pinned npm
10.9.3, normal scripts and optional/development dependencies, exit 0 (115859 ms).
All 680 actual installed versions match the lock; all 277 focused cases pass
(86140 ms parent), with no watchdogs. Archive/runtime/configuration guards remain
unchanged. This gate does not repeat fresh full tests/types/build/native ABI checks.

Independent before-tests review verifies installed Vitest/mocker 4.1.11 sharing
root Vite 7.3.7, complete `npm ls --all` exit 0, removed vite-node/tinypool/nested
Vite 5, and a test-stack-only 78-entry lock diff. No optional Vite 8/Vitest 5 or
browser/devtools packages are installed. All 70 Electron/native binary hashes,
seven other protected package metadata files and six original npm-config paths
are unchanged. The standalone audit explicitly including development/optional
dependencies exits 1 in 4435 ms: 25 findings (one critical, 18 high, six moderate),
down from 31. The audit remains release-blocking; all other verification gates
remain required. Historical failure receipts are retained, not converted to passes.

## Next packaging candidate: reviewed, not approved or installed

Read-only preflight identifies electron-builder 25.1.8 to 26.15.3 as a bounded
next security step. Resolve that exact approved target, not an unrestricted
range that silently selects a different minor: upstream also has 26.17.0 on
its maintained v26 branch. The [immutable 26.15.3 release](https://github.com/electron-userland/electron-builder/releases/tag/electron-builder@26.15.3)
and [v26 migration notes](https://github.com/electron-userland/electron-builder/releases/tag/v26.0.0)
were reviewed against Cortex's YAML, CommonJS bundling hook and manual draft-only
wrapper. No mandatory application/configuration migration is currently identified;
removed signing/notarization/Linux desktop option shapes are not used. The tooling's
effective [rebuild Node floor](https://raw.githubusercontent.com/electron/rebuild/v4.0.4/package.json)
is 22.12.0, compatible with the existing 22.20.0 pin. Keep Electron, native/PDF
versions, CommonJS output, CI pins and `npmRebuild: false` unchanged.

The [AppImage path advisory](https://github.com/electron-userland/electron-builder/security/advisories/GHSA-7g7r-gx96-252g)
requires app-builder-lib 26.15.0 or later. Its declared tar range is not enough:
every affected resolved tar path must also reach at least the
[7.5.21 fix](https://github.com/isaacs/node-tar/security/advisories/GHSA-r292-9mhp-454m).
Before installation, this major still needs its separate user decision. Then
review the packaging-only lock closure, installed peers/engines/config/native
hashes and actual installed builder schema, matcher, CLI and publisher guard
tests; rerun types/full tests/build/audit and unpublished packaged-app/native/
bundled-CLI acceptance. Windows proof cannot establish macOS/Linux installers;
the existing signing-helper symlink privilege limitation is not bypassed.

## Triage by code path

| Package/group | Path to review | Current decision |
|---|---|---|
| Electron (high) | Shipped desktop runtime, preload isolation, navigation and native APIs | Release-blocking runtime upgrade and desktop/installer regression |
| Vite/electron-vite (previous high/moderate) | Development server and renderer/backend builds | Approved Vite 7/electron-vite 4 installed; latest audit no longer flags these groups; upgrade validation remains required |
| Vitest/tinypool (previous critical) | Test worker execution and optional UI/API server | Approved Vitest 4 installed and tinypool removed; latest audit no longer flags these groups; root full/native and new-lock normal install/focused gates pass, without waiving other findings |
| tar/build packaging dependencies (critical) | electron-builder/native rebuild/cache archive handling | Review extraction paths and upgrade packaging stack; clean-machine packaging evidence required |
| Chokidar/its transitive matching dependencies (high) | Desktop filesystem watcher and build tooling | Review actual dependency graph and watcher compatibility |
| Tailwind/build dependencies (high), PostCSS (moderate) | Renderer CSS build/source maps | Review transitive fixes and CSS/migration regressions |

These are path classifications, not proof that every advisory is exploitable.
No group is waived as unreachable. An advisory can affect a build or test system
even when that dependency is omitted from the installed desktop application's
runtime dependencies.

The maintainer's [Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-5xrq-8626-4rwp)
describes the UI/API-server conditions for file access and execution. This project's
verification used `vitest run`, not an exposed UI server; that reduces the scope of
that specific condition, but does not dispose of other Vitest/tinypool findings.
Electron's [context-isolation advisory](https://github.com/electron/electron/security/advisories/GHSA-h7rp-cf8h-j98x)
and Vite's [Windows alternate-path advisory](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff)
are additional reasons to inspect the runtime/build boundaries rather than count
green functional tests as security remediation.

## Safe upgrade sequence

1. Preserve this functional baseline and the lockfile. Use the owning npm workspace;
   do not hand-edit the lockfile or run `npm audit fix --force`.
2. Review each package's current advisory, changelog, minimum fixed version,
   migration notes, provenance and install scripts. Audit-suggested major versions
   are candidates, not automatically selected supported versions.
3. Apply patch-compatible fixes first, then small related stack upgrades separately
   so a regression has a clear cause and reversible change.
4. Run types/full tests/build, the actual save/Git/3D desktop smoke, real firmware
   compile/run, and clean-machine packaging after each relevant upgrade.
5. Re-audit the resulting lockfile. Require no high/critical findings before release,
   or a separate explicit documented owner decision identifying a genuinely
   unreachable advisory, rationale, owner and next review date.

Remaining signing, hardware, installer and human validation gates are in
[Production readiness](PRODUCTION-READINESS.md). They remain necessary after the
dependency gate becomes green.
