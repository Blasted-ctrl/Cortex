# Cortex release constraints

Established for customer-release hardening on 2026-10-09. This is a quality gate,
not a promise of zero bugs or a certification of electrical safety.

## Always enforced

- Preserve user data on failed saves, cancelled actions and failed project switches.
- Do not silently overwrite external file changes or delete an existing rename target.
- No new type-check suppressions, unimplemented success stubs, or weakened assertions.
- Do not skip tests to obtain a green build. Platform/compiler prerequisites must be
  explicit, with a CI compiler guard.
- No secrets in code, reports or error details. Do not publish credential-bearing URLs.
- A simulation pass cannot certify a physical circuit. Unsupported APIs must fail
  explicitly rather than return invented successful data.
- Preserve old diagram versions; reject unknown or malformed input before modifying
  the active circuit. Never silently drop unsupported imported components.
- No automatic public release, user project commit/push, or board flash during tests.

## Verification gates

| Gate | Verdict | Reproducible command |
|---|---|---|
| Types | Zero errors in both processes | `npm run typecheck` |
| Regression tests and existing style checks | All applicable tests pass | `npm test -- --maxWorkers=4 --minWorkers=1` |
| Desktop and bundled tools build | Successful build | `npm run build` |
| Dependency audit (external advisory database) | No high/critical findings before release | `npm audit --audit-level=high` |
| Firmware behavior and watchdog | Correct fixture passes; broken/hanging fixtures caught | `npm run firmware:test` and `npm run firmware:selftest` |

Zero type errors and failed regression cases are blocking because they are known
defects, not statistical budgets. High/critical audit findings block release until
remediated or reviewed through an explicit, documented decision; do not lower the
audit threshold. Local functional work can proceed while this gate is red.

Review the diff for suppressions, deleted/skipped assertions and incomplete stubs
at task completion. This floor review is manual; no new coverage percentage or
automatic floor-scanning tool is claimed. CI enforces types, tests, build and audit
before packaging. More expensive firmware scenarios run in their dedicated workflow.

## Customer release gates still requiring evidence

- Run the release workflow on Windows, macOS and Linux; install its actual artifacts
  on clean machines. A source build is not installer validation.
- Authenticode/signing/notarization and release credentials require owner setup.
- Validate Verify/Upload with explicitly selected hardware and ports; no automatic
  flashing as a test substitute.
- Exercise actual credentials/remotes, conflicts and offline recovery without using
  customer repositories as disposable fixtures.
- Two teammates and one outside team must complete the fresh-install workflow.
- Decide supported OS/compiler/board combinations and retain evidence for each.
- Review updates, crash recovery, crash-reporting privacy and dependency remediation.

New numeric coverage/performance/accessibility budgets require measurements and
working checks first. Host benchmark time is separate from virtual simulation time.
