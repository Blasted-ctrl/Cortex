'use strict'

const { spawnSync } = require('node:child_process')
const { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, delimiter, dirname, isAbsolute, join, resolve } = require('node:path')
const { load } = require('js-yaml')
const { valid } = require('semver')
const { verifyRelease } = require('./release-guard.cjs')

const root = resolve(__dirname, '..')
const repository = 'Blasted-ctrl/Cortex'
const publisher = { provider: 'github', owner: 'Blasted-ctrl', repo: 'Cortex', releaseType: 'draft' }
const tokenKeys = ['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_RELEASE_TOKEN']

function hasPublisherOverride(value) {
  return value !== null && typeof value === 'object' && Object.entries(value).some(([key, entry]) => key === 'publish' || hasPublisherOverride(entry))
}

function releasePlan(metadata, configuration, env, argv) {
  if (!Array.isArray(argv) || argv.length !== 0) throw new Error('Manual release accepts no command arguments or overrides.')
  const version = metadata?.version
  if (typeof version !== 'string' || valid(version) !== version.split('+')[0]) throw new Error('Invalid package version; use canonical SemVer before releasing.')
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) throw new Error('Invalid publisher configuration.')
  const { publish, ...remaining } = configuration
  if (!publish || Array.isArray(publish) || Object.keys(publish).length !== 4 || Object.entries(publisher).some(([key, value]) => publish[key] !== value) ||
      hasPublisherOverride(remaining) || configuration.extends != null || configuration.extraMetadata?.version != null || configuration.directories?.app != null || metadata.build != null) {
    throw new Error('Publisher configuration must use only the pinned draft GitHub destination without inherited, platform or version overrides.')
  }
  const tag = `v${version}`
  if ((env.GH_REPO !== undefined && env.GH_REPO !== repository) || (env.RELEASE_TAG !== undefined && env.RELEASE_TAG !== tag)) throw new Error('Release configuration does not match the pinned repository and package version.')
  const token = (env.GITHUB_RELEASE_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN || '').trim()
  if (!/^[.\w/=+-]+$/.test(token) || token === '__test__') throw new Error('Missing or invalid GitHub release token.')
  let npmCli
  try {
    npmCli = env.npm_execpath || resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    if (!isAbsolute(npmCli) || basename(npmCli) !== 'npm-cli.js' || !statSync(npmCli).isFile() || JSON.parse(readFileSync(resolve(dirname(npmCli), '..', 'package.json'), 'utf8')).name !== 'npm') throw new Error()
    npmCli = realpathSync(npmCli)
  } catch {
    throw new Error('Cannot locate the installed npm CLI; run this release through npm with its supported Node installation.')
  }
  return { version, tag, token, npmCli }
}

function invoke(runCommand, args, env) {
  try {
    const result = runCommand(process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true, shell: false })
    if (result.signal) return { status: null, signal: result.signal }
    return { status: result.error || !Number.isInteger(result.status) ? 1 : result.status, signal: null }
  } catch {
    return { status: 1, signal: null }
  }
}

async function verifyListedReleases(plan, fetchImpl) {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases?per_page=100`, {
    headers: { Authorization: `Bearer ${plan.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(15000)
  })
  if (response.status !== 200) throw new Error('Release listing failed.')
  const releases = await response.json()
  if (!Array.isArray(releases) || releases.length > 100 || releases.some(release => !release || typeof release.tag_name !== 'string' || typeof release.draft !== 'boolean')) throw new Error('Invalid release listing.')
  // The publisher reads the default 30-entry first page; inspect its full set.
  if (releases.some(release => release.tag_name === plan.version || (release.tag_name === plan.tag && !release.draft))) throw new Error('The listed release is unsafe to replace.')
}

async function manualRelease({ argv = process.argv.slice(2), env = process.env, runCommand = spawnSync, fetchImpl = fetch } = {}) {
  const packagePath = resolve(root, 'package.json')
  const configurationPath = resolve(root, 'electron-builder.yml')
  const packageSource = readFileSync(packagePath, 'utf8')
  const configurationSource = readFileSync(configurationPath, 'utf8')
  const configuration = load(configurationSource)
  const plan = releasePlan(JSON.parse(packageSource), configuration, env, argv)
  const requireUnchanged = () => {
    if (readFileSync(packagePath, 'utf8') !== packageSource || readFileSync(configurationPath, 'utf8') !== configurationSource) throw new Error('Release configuration changed during verification; refusing to publish.')
  }
  const gateEnv = { ...env, CI: 'true', PATH: `${dirname(process.execPath)}${delimiter}${env.PATH || ''}` }
  for (const key of Object.keys(gateEnv)) if (tokenKeys.includes(key.toUpperCase())) delete gateEnv[key]
  for (const args of [['run', 'typecheck'], ['test'], ['audit', '--include=dev', '--include=optional', '--audit-level=high'], ['run', 'build']]) {
    const result = invoke(runCommand, [plan.npmCli, ...args], gateEnv)
    if (result.status !== 0) return result
  }
  requireUnchanged()
  let alternate
  try {
    await verifyRelease({ repository, tag: plan.tag, token: plan.token, fetchImpl })
    // The installed publisher also matches bare-version releases. Never adopt one.
    alternate = await verifyRelease({ repository, tag: plan.version, token: plan.token, fetchImpl })
    await verifyListedReleases(plan, fetchImpl)
  } catch {
    throw new Error('Release lookup failed or the tag is already published; refusing to publish.')
  }
  if (alternate !== 'absent') throw new Error('An alternate bare-version release exists; refusing to publish to a different tag.')
  requireUnchanged()
  const publisherEnv = { ...gateEnv, GH_TOKEN: plan.token, GITHUB_RELEASE_TOKEN: plan.token, EP_DRAFT: 'true', GH_REPO: repository, RELEASE_TAG: plan.tag }
  const directory = mkdtempSync(join(tmpdir(), 'cortex-manual-release-'))
  try {
    const snapshotPath = join(directory, 'electron-builder.json')
    writeFileSync(snapshotPath, JSON.stringify(configuration), { mode: 0o600 })
    return invoke(runCommand, [
      require.resolve('electron-builder/cli.js'), '--publish=always', '--config', snapshotPath,
      '--config.publish.provider=github', '--config.publish.owner=Blasted-ctrl', '--config.publish.repo=Cortex',
      '--config.publish.releaseType=draft', '--config.publish.vPrefixedTagName=true', `--config.extraMetadata.version=${plan.version}`
    ], publisherEnv)
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

module.exports = { manualRelease, releasePlan }
if (require.main === module) {
  manualRelease().then(result => {
    if (result.signal) process.kill(process.pid, result.signal)
    else process.exitCode = result.status
  }).catch(() => {
    process.stderr.write('Manual release failed or was refused. Check verification, configuration and GitHub lookup; inspect any existing draft before retrying.\n')
    process.exitCode = 1
  })
}
