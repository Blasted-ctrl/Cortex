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

## Next proposed major: Vite (not installed)

Propose Vite 5.4.21 to 7.3.7, subject to separate user confirmation after the
current step finishes. Vite 7.3 receives important/security fixes; 6.4.4 remains
a smaller security-only alternative. Vite 7.3.7 contains the current filesystem
advisory fixes. See [support policy](https://vite.dev/releases) and the
[maintainer's advisory](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22).

Both [Vite 6](https://v6.vite.dev/guide/migration) and
[Vite 7](https://v7.vite.dev/guide/migration) migrations were reviewed, including
resolver conditions, stricter CommonJS evaluation, CSS configuration and browser
targets. Keep the `.mts` tooling config, Node pin, native/PDF externals and Monaco
backport/exclusion. Electron-vite 4.0.1 and installed React plugin 4.7.0 admit Vite
7; raise that plugin's manifest floor from `^4.3.4` to `^4.7.0` to encode the
already installed compatible version, not to introduce a plugin major.

Vitest/vite-node 2.1.9 still depend on Vite 5, and mocker 2 has an optional Vite 5
peer. A valid isolated upgrade must preserve their compatible nested resolution;
never force them onto Vite 7. This leaves those security findings until a separately
reviewed Vitest upgrade. Check [Vitest metadata](https://raw.githubusercontent.com/vitest-dev/vitest/v2.1.9/packages/vitest/package.json)
and [mocker metadata](https://raw.githubusercontent.com/vitest-dev/vitest/v2.1.9/packages/mocker/package.json).

Expected scope: manifest/lockfile, version/support documentation, and only config
changes required by demonstrated incompatibilities. Verify the installed graph,
types/full tests/build, firmware, native dev/production startup and a fresh audit
before proposing another major. Electron runtime/packaging remain unchanged.

## Triage by code path

| Package/group | Path to review | Current decision |
|---|---|---|
| Electron (high) | Shipped desktop runtime, preload isolation, navigation and native APIs | Release-blocking runtime upgrade and desktop/installer regression |
| Vite/electron-vite (high/moderate) | Development server and renderer/backend builds | Review Windows path handling and network exposure; upgrade compatible stack |
| Vitest/tinypool (critical) | Test worker execution and optional UI/API server | Upgrade together; do not expose a test UI/API server as a mitigation substitute |
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
