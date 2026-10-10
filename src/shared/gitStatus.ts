/**
 * Parse the output of `git status --porcelain=v1 -z --branch` into a structured
 * status. Pure so it can be unit-tested without a repo or a spawn.
 *
 * The porcelain v1 format is a stable, machine-readable contract:
 *   - With `--branch`, the first record is a `## ` header describing the current
 *     branch and its tracking / ahead-behind, e.g.
 *       `## main...origin/main [ahead 2, behind 1]`
 *       `## main` (no upstream)
 *       `## No commits yet on main`
 *       `## HEAD (no branch)` (detached)
 *   - Each subsequent record is `XY path`, where X is the staged (index) state
 *     and Y the unstaged (worktree) state (` MADRCU?!`). With `-z`, records are
 *     NUL-separated (so paths with spaces or newlines are safe), and a rename or
 *     copy (X or Y in `RC`) is followed by a second record carrying its original path.
 */

export interface GitFileStatus {
  /** Repo-relative path (for a rename, the NEW path). */
  path: string
  /** Staged (index) status char: one of ` MADRCU?!`. */
  index: string
  /** Unstaged (worktree) status char. */
  worktree: string
  /** Original path, present only for a rename/copy. */
  orig?: string
}

export interface GitStatusResult {
  branch?: string
  /** The tracked upstream ref (e.g. "origin/main"), when the branch has one. */
  upstream?: string
  ahead: number
  behind: number
  files: GitFileStatus[]
}

export function parsePorcelain(output: string): GitStatusResult {
  const records = output.split('\0')
  let branch: string | undefined
  let upstream: string | undefined
  let ahead = 0
  let behind = 0
  const files: GitFileStatus[] = []

  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (!rec) continue

    if (rec.startsWith('## ')) {
      const info = rec.slice(3)
      const NO_COMMITS = 'No commits yet on '
      if (info.startsWith(NO_COMMITS)) {
        branch = info.slice(NO_COMMITS.length).split(' ')[0]
      } else {
        // Split on the tracking separator (exactly three dots) before touching
        // spaces, so a branch name that itself contains a dot survives. The part
        // after "..." (before the " [ahead...]") is the upstream ref.
        const track = info.split('...')
        branch = track[0].split(' ')[0]
        if (track.length > 1) upstream = track[1].split(' ')[0] || undefined
      }
      const a = /\bahead (\d+)/.exec(info)
      if (a) ahead = parseInt(a[1], 10)
      const b = /\bbehind (\d+)/.exec(info)
      if (b) behind = parseInt(b[1], 10)
      continue
    }

    // A file record is `XY path`: two status chars, a space, then the path.
    if (rec.length < 4) continue
    const entry: GitFileStatus = { path: rec.slice(3), index: rec[0], worktree: rec[1] }
    if (entry.index === 'R' || entry.index === 'C' || entry.worktree === 'R' || entry.worktree === 'C') {
      // A rename/copy carries its original path in the following record.
      const orig = records[i + 1]
      if (orig !== undefined) {
        entry.orig = orig
        i++
      }
    }
    files.push(entry)
  }

  return { branch, upstream, ahead, behind, files }
}
