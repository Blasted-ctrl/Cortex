'use strict'

/** Read-only guard. Unknown network/auth/API state never permits publication. */
async function verifyRelease({ repository, tag, token, fetchImpl = fetch }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository ?? '') || !tag || !token) throw new Error('Missing or invalid release guard configuration.')
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error', signal: AbortSignal.timeout(15000)
  })
  if (response.status === 404) return 'absent'
  if (response.status !== 200) throw new Error(`Release lookup failed (HTTP ${response.status}); refusing to publish.`)
  const release = await response.json()
  if (release.draft !== true) throw new Error('This tag already has a published release. Use a new version instead of replacing customer downloads.')
  return 'draft'
}

module.exports = { verifyRelease }
if (require.main === module) {
  verifyRelease({ repository: process.env.GH_REPO, tag: process.env.RELEASE_TAG, token: process.env.GH_TOKEN })
    .then((state) => process.stdout.write(`Release lookup verified: ${state}\n`))
    .catch(() => {
      // Do not print vendor bodies, request options, tokens or credential-bearing URLs.
      process.stderr.write('::error::Release guard refused publication: lookup failed or this tag is already published. Verify the release before retrying.\n')
      process.exitCode = 1
    })
}
