import { execFile } from 'child_process'
import { promisify } from 'util'
import { readFile, lstat, readlink, realpath } from 'fs/promises'
import { join, isAbsolute, relative, dirname } from 'path'
import type { GitStatus, GitFileDiff, GitDiffKind, GitOpResult, GitBranches } from '../../shared/ipc'
import { parsePorcelain } from '../../shared/gitStatus'
import { getWorkspaceRoot, withinWorkspace } from './fsService'
import { safeCommand, needsShell } from './commandResolver'
import { isWithin } from '../../shared/security'

/**
 * Git surface for the open workspace. Every git invocation goes
 * through execFile with an ARGUMENT ARRAY and NO SHELL, so a branch or file
 * name can never be interpreted as a command; git itself is resolved from PATH
 * via safeCommand (never the workspace, so a repo shipping a git.exe cannot
 * hijack it), and a git resolved to a .cmd/.bat shim is refused outright rather
 * than run through a shell (which would reintroduce argument injection via a
 * crafted path). Porcelain paths are repo-root-relative, so all commands run
 * with cwd at the repository top level and results are confined to the open
 * workspace. Repository-wide mutations require the repository root to be open.
 */

const execFileAsync = promisify(execFile)
const NOT_REPO: GitStatus = { isRepo: false, ahead: 0, behind: 0, files: [] }

/** Forward slashes for git rev:path specs, even on Windows. */
const gp = (p: string): string => process.platform === 'win32' ? p.replace(/\\/g, '/') : p
const GIT_ARGS = ['--no-pager', '--literal-pathspecs', '-c', 'color.ui=false', '-c', 'core.fsmonitor=false']
const DIFF_LIMIT = 4 * 1024 * 1024

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|EXEC_PATH|PREFIX|CONFIG(?:_.*)?|GLOB_PATHSPECS|NOGLOB_PATHSPECS|LITERAL_PATHSPECS|ICASE_PATHSPECS)$/i.test(name)) delete env[name]
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANGUAGE: 'C' }
}

async function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; error?: string }> {
  const bin = safeCommand('git', getWorkspaceRoot())
  // Only a real executable: a .cmd/.bat shim would need a shell, and a shell
  // would let a crafted path/branch inject a command. Refusing is safe-fail.
  if (!bin || needsShell(bin)) return { ok: false, stdout: '' }
  try {
    const { stdout } = await execFileAsync(bin, [...GIT_ARGS, ...args], {
      cwd,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 15_000,
      env: gitEnv()
    })
    return { ok: true, stdout: stdout as string }
  } catch (error) {
    // A non-zero exit (not a repo, path not in this ref, a lock, an overflow)
    // is an expected outcome, surfaced as ok:false rather than thrown.
    const failure = error as { stderr?: string; killed?: boolean }
    return { ok: false, stdout: '', error: failure.killed ? 'Git timed out.' : String(failure.stderr ?? '').slice(0, 1000) }
  }
}

/** Repository root, null for a non-repository, undefined for a failed probe. */
async function repoRoot(): Promise<string | null | undefined> {
  const ws = getWorkspaceRoot()
  if (!ws) return null
  const r = await runGit(ws, ['rev-parse', '--show-toplevel'])
  if (!r.ok) return /not a git repository/i.test(r.error ?? '') ? null : undefined
  const top = r.ok ? r.stdout.trim() : ''
  return top && isWithin(top, ws) && ws === getWorkspaceRoot() ? top : undefined
}

function gitRunnable(): boolean {
  const bin = safeCommand('git', getWorkspaceRoot())
  return !!bin && !needsShell(bin)
}

export async function status(): Promise<GitStatus> {
  const ws = getWorkspaceRoot()
  if (!ws) return NOT_REPO
  if (!gitRunnable()) return { isRepo: false, ahead: 0, behind: 0, files: [], error: 'git is not available on PATH.' }
  const root = await repoRoot()
  if (root === undefined) return { ...NOT_REPO, error: 'Could not locate the repository. Check Git permissions and refresh.' }
  if (!root) return NOT_REPO // rev-parse said this is not a work tree
  // -uall lists untracked files individually so an untracked directory is not
  // collapsed to a single un-diffable "dir/" row.
  const res = await runGit(root, ['status', '--porcelain=v1', '-z', '--branch', '-uall'])
  if (!res.ok) return { isRepo: true, ahead: 0, behind: 0, files: [], error: 'Could not read git status.' }
  if (ws !== getWorkspaceRoot()) return { ...NOT_REPO, error: 'The open project changed. Refresh its status.' }
  const parsed = parsePorcelain(res.stdout)
  // Porcelain paths are repo-root-relative; keep only those inside the open
  // workspace (which may be a subdirectory of the repo).
  const files = parsed.files.filter((f) => withinWorkspace(join(root, f.path)))
  return {
    isRepo: true,
    branch: parsed.branch,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    files
  }
}

/** Content of a repo-relative path at a git ref (`HEAD:p`, `:p` for the index),
 *  or '' when the path does not exist in that ref (a new or deleted file). */
async function showAt(root: string, spec: string): Promise<string> {
  const r = await runGit(root, ['show', '--no-ext-diff', '--no-textconv', spec, '--'])
  if (r.ok) return r.stdout
  if (/does not exist|exists on disk, but not in|not in the index|invalid object name 'HEAD'|bad revision 'HEAD:/.test(r.error ?? '')) return ''
  throw new Error('Could not read repository content.')
}

async function readWorking(abs: string): Promise<string> {
  try {
    const stat = await lstat(abs)
    if (stat.isSymbolicLink()) return readlink(abs)
    if (!stat.isFile() || stat.size > DIFF_LIMIT) throw new Error('File is not a supported text diff.')
    return await readFile(abs, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
}

async function safePath(root: string, path: unknown): Promise<boolean> {
  if (typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path)) return false
  const normalized = gp(path)
  if (normalized.split('/').some((part) => part === '.' || part === '..' || part.toLowerCase() === '.git')) return false
  const abs = join(root, normalized)
  if (!withinWorkspace(abs) || abs === getWorkspaceRoot()) return false
  try {
    const ws = await realpath(getWorkspaceRoot()!)
    let parent = dirname(abs)
    for (;;) {
      try {
        return isWithin(ws, await realpath(parent))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
        const next = dirname(parent)
        if (next === parent) return false
        parent = next
      }
    }
  } catch {
    return false
  }
}

export async function fileDiff(relPath: string, kind: GitDiffKind, orig?: string): Promise<GitFileDiff | null> {
  const ws = getWorkspaceRoot()
  if (!ws || !['staged', 'unstaged', 'untracked'].includes(kind)) return null
  const root = await repoRoot()
  if (!root) return null
  if (!await safePath(root, relPath) || (orig !== undefined && !await safePath(root, orig))) return null
  const abs = join(root, relPath)
  if (!withinWorkspace(abs)) return null
  // An untracked directory (should not occur with -uall) is not a file to diff.
  if (relPath.endsWith('/')) return { path: relPath, oldContent: '', newContent: '', binary: false, directory: true }

  let oldContent = ''
  let newContent = ''
  try {
    if (kind === 'untracked') {
      newContent = await readWorking(abs)
    } else if (kind === 'staged') {
      oldContent = await showAt(root, `HEAD:${gp(orig ?? relPath)}`)
      newContent = await showAt(root, `:${gp(relPath)}`)
    } else {
      oldContent = await showAt(root, `:${gp(relPath)}`)
      newContent = await readWorking(abs)
    }
  } catch {
    return null
  }
  if (Buffer.byteLength(oldContent, 'utf8') > DIFF_LIMIT || Buffer.byteLength(newContent, 'utf8') > DIFF_LIMIT || ws !== getWorkspaceRoot()) return null
  const binary = oldContent.includes('\0') || newContent.includes('\0')
  return { path: relPath, oldContent: binary ? '' : oldContent, newContent: binary ? '' : newContent, binary }
}

// ---- mutations (stage / unstage / commit) ---------------------------------

/** Run a mutating git command; on failure lift git's own stderr as the error,
 *  first line only and length-capped, so the panel can show it honestly. */
let mutationRunning = false

async function runMutation(cwd: string, args: string[], workspace = getWorkspaceRoot()): Promise<GitOpResult> {
  if (!workspace || workspace !== getWorkspaceRoot()) return { ok: false, error: 'The open project changed. Try again.' }
  if (mutationRunning) return { ok: false, error: 'A git operation is already running.' }
  const bin = safeCommand('git', getWorkspaceRoot())
  if (!bin || needsShell(bin)) return { ok: false, error: 'git is not available on PATH.' }
  mutationRunning = true
  try {
    await execFileAsync(bin, [...GIT_ARGS, ...args], {
      cwd,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      // Fail fast instead of blocking the whole panel forever: a stalled network
      // push, or a credential/askpass GUI, would otherwise hang the child (busy
      // stays set). GIT_TERMINAL_PROMPT=0 stops git's own terminal prompt; the
      // timeout backstops the cases it does not cover.
      timeout: 60_000,
      env: gitEnv()
    })
    return { ok: true }
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; killed?: boolean; signal?: string; code?: string }
    if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { ok: false, error: 'Git output exceeded the capture limit. Check repository hooks and try again.' }
    if (err?.killed) return { ok: false, error: 'Git timed out after 60 seconds. Check hooks, signing, credentials or the remote connection.' }
    if (err?.signal) return { ok: false, error: 'Git stopped unexpectedly. Check your Git tools and try again.' }
    // git writes its real reason to stderr OR (for `commit` with nothing to
    // commit) to stdout. Deliberately NEVER fall back to Node's e.message: it is
    // "Command failed: <absolute git.exe path> commit -m <the message>", which
    // leaks the binary path and the user's commit text and is not git's reason.
    const lines = (s: unknown): string[] =>
      String(s ?? '').split('\n').map((x) => x.trim()).filter((x) => x.length > 0 && !x.startsWith('Command failed'))
    const stderr = lines(err?.stderr)
    const stdout = lines(err?.stdout)
    // Prefer the actual reason. A rejected push leads with "To <remote>" (an
    // unhelpful header that also spells out the remote path), so skip it and
    // pick the fatal/error/rejected/hint line; a `commit` with nothing to do
    // prints only to stdout, where the reason is the last line after "On branch".
    const reason =
      stderr.find((l) => /\[rejected\]|\[remote rejected\]|^error:|^fatal:|^hint:|^remote:/.test(l)) ||
      stderr.find((l) => !l.startsWith('To ')) ||
      stderr[0]
    const msg = reason || stdout[stdout.length - 1] || 'git command failed.'
    const redacted = msg
      .replace(/((?:https?|ssh):\/\/)[^\s/@]+@/gi, '$1[redacted]@')
      .replace(/([?&](?:access_token|token|key|api_key|password|auth)=)[^&\s'"]+/gi, '$1[redacted]')
    return { ok: false, error: redacted.slice(0, 300) }
  } finally {
    mutationRunning = false
  }
}

async function safePaths(root: string, paths: unknown): Promise<string[] | null> {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > 10000) return null
  const out: string[] = []
  for (const p of paths) {
    if (!await safePath(root, p)) return null
    try {
      if ((await lstat(join(root, p))).isDirectory()) return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
    }
    out.push(gp(p))
  }
  return out
}

export async function stage(paths: string[]): Promise<GitOpResult> {
  const ws = getWorkspaceRoot()
  const root = await repoRoot()
  if (!root) return { ok: false, error: 'Not a git repository.' }
  const ps = await safePaths(root, paths)
  if (!ps) return { ok: false, error: 'Invalid path.' }
  // `--` ends options, so a path beginning with '-' is a path, never a flag.
  return runMutation(root, ['add', '--', ...ps], ws)
}

export async function unstage(paths: string[]): Promise<GitOpResult> {
  const ws = getWorkspaceRoot()
  const root = await repoRoot()
  if (!root) return { ok: false, error: 'Not a git repository.' }
  const ps = await safePaths(root, paths)
  if (!ps) return { ok: false, error: 'Invalid path.' }
  // `git reset` needs a HEAD to reset the index against; before the first commit
  // there is none, so an added path is dropped from the index instead.
  const head = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (!head.ok && head.error) return { ok: false, error: 'Could not verify the current commit. Nothing was unstaged.' }
  // -f only overrides the "staged content differs" refusal for an added-then-
  // edited file; --cached keeps it index-only, so the working file is never
  // touched (it becomes untracked, matching what `git reset` does with a HEAD).
  return head.ok
    ? runMutation(root, ['reset', '--quiet', '--', ...ps], ws)
    : runMutation(root, ['rm', '--cached', '-f', '--quiet', '--', ...ps], ws)
}

export async function commit(message: string): Promise<GitOpResult> {
  const ws = getWorkspaceRoot()
  const root = await repoRoot()
  if (!root) return { ok: false, error: 'Not a git repository.' }
  if (typeof message !== 'string' || !message.trim() || message.includes('\0') || message.length > 65536) return { ok: false, error: 'Enter a valid commit message (up to 64 KB).' }
  if (relative(root, ws!) !== '') return { ok: false, error: 'Open the repository root before committing. Other staged files may be outside this project.' }
  // The message is a single argv (no shell), so newlines and metacharacters in
  // it are literal text, never interpretable as commands. git itself rejects an
  // empty index ("nothing to commit") or a missing identity, surfaced as-is.
  return runMutation(root, ['commit', '-m', message], ws)
}

/** Push the current branch to its configured upstream. Outward-facing: the
 *  caller confirms first. An explicit refspec prevents matching-branch defaults
 *  or configured push refspecs from publishing other branches. */
export async function push(): Promise<GitOpResult> {
  const ws = getWorkspaceRoot()
  const root = await repoRoot()
  if (!root) return { ok: false, error: 'Not a git repository.' }
  if (relative(root, ws!) !== '') return { ok: false, error: 'Open the repository root before pushing its commits.' }
  const current = await runGit(root, ['branch', '--show-current'])
  if (!current.ok || !current.stdout.trim()) return { ok: false, error: 'Switch to a local branch before pushing.' }
  const upstream = await runGit(root, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${current.stdout.trim()}`])
  const [remote, ref] = upstream.stdout.trimEnd().split('\0')
  if (!upstream.ok || !remote || remote.startsWith('-') || !ref?.startsWith('refs/heads/')) return { ok: false, error: 'This branch has no upstream. Configure it in the terminal first.' }
  return runMutation(root, ['push', remote, `HEAD:${ref}`], ws)
}

/** Local branches + the current one. Branch names cannot contain a newline, so
 *  newline-splitting for-each-ref output is safe. */
export async function branches(): Promise<GitBranches> {
  const root = await repoRoot()
  if (!root) return { current: null, branches: [] }
  const cur = await runGit(root, ['branch', '--show-current'])
  const list = await runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
  if (!cur.ok || !list.ok) throw new Error('Could not read local branches.')
  const names = list.ok ? list.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : []
  return { current: cur.ok ? cur.stdout.trim() || null : null, branches: names }
}

/** Switch to an existing local branch. `git switch` refuses (does not force) when
 *  local changes would be overwritten, surfacing that as an honest error; the
 *  caller separately guards unsaved editor buffers (invisible to git). */
export async function switchBranch(name: string): Promise<GitOpResult> {
  const ws = getWorkspaceRoot()
  const root = await repoRoot()
  if (!root) return { ok: false, error: 'Not a git repository.' }
  if (relative(root, ws!) !== '') return { ok: false, error: 'Open the repository root before switching branches. Other project files may change.' }
  // The name comes from branches() (git's own output), but validate anyway: no
  // control chars, not empty/oversized, and never a leading '-' (which would be
  // read as an option since there is no shell to abuse).
  if (typeof name !== 'string' || name.length === 0 || name.length > 255 || /[\r\n\0]/.test(name) || name.startsWith('-'))
    return { ok: false, error: 'Invalid branch name.' }
  const local = await runGit(root, ['show-ref', '--verify', `refs/heads/${name}`])
  if (!local.ok) return { ok: false, error: 'That local branch no longer exists. Refresh the branch list.' }
  return runMutation(root, ['switch', '--no-guess', name], ws)
}

export async function init(): Promise<GitOpResult> {
  const ws = getWorkspaceRoot()
  if (!ws) return { ok: false, error: 'Open a project folder first.' }
  const root = await repoRoot()
  if (root === undefined) return { ok: false, error: 'Could not verify repository ownership. Check Git permissions and try again.' }
  if (root) return { ok: false, error: 'This project already belongs to a git repository.' }
  return runMutation(ws, ['init', '--initial-branch=main'], ws)
}

export async function createBranch(name: string): Promise<GitOpResult> {
  const ws = getWorkspaceRoot()
  const root = await repoRoot()
  if (!root) return { ok: false, error: 'Not a git repository.' }
  if (relative(root, ws!) !== '') return { ok: false, error: 'Open the repository root before creating a branch.' }
  if (typeof name !== 'string' || !name || name.length > 255 || /[\r\n\0]/.test(name) || name.startsWith('-') || name.startsWith('@{') || name === '@') return { ok: false, error: 'Enter a valid branch name.' }
  const valid = await runGit(root, ['check-ref-format', '--branch', name])
  if (!valid.ok) return { ok: false, error: 'Enter a valid branch name, such as feature/motor-control.' }
  return runMutation(root, ['switch', '--no-guess', '-c', name], ws)
}

export async function fetch(): Promise<GitOpResult> {
  const ws = getWorkspaceRoot()
  const root = await repoRoot()
  if (!root) return { ok: false, error: 'Not a git repository.' }
  if (relative(root, ws!) !== '') return { ok: false, error: 'Open the repository root before fetching its remote.' }
  const remotes = await runGit(root, ['remote'])
  if (!remotes.ok || !remotes.stdout.trim()) return { ok: false, error: 'No remote is configured. Add a remote in the terminal first.' }
  return runMutation(root, ['fetch', '--all'], ws)
}

export async function pull(): Promise<GitOpResult> {
  const ws = getWorkspaceRoot()
  const root = await repoRoot()
  if (!root) return { ok: false, error: 'Not a git repository.' }
  if (relative(root, ws!) !== '') return { ok: false, error: 'Open the repository root before pulling its changes.' }
  const tree = await runGit(root, ['status', '--porcelain=v1', '-z', '-uall'])
  if (!tree.ok) return { ok: false, error: 'Could not verify that the working tree is clean.' }
  if (tree.stdout) return { ok: false, error: 'Commit or stash your local changes before pulling. No files were changed.' }
  const upstream = await runGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  if (!upstream.ok) return { ok: false, error: 'This branch has no upstream. Configure it in the terminal first.' }
  return runMutation(root, ['pull', '--ff-only', '--no-rebase'], ws)
}
