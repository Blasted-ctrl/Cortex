import { execFile } from 'child_process'
import { promisify } from 'util'
import { lstat, realpath } from 'fs/promises'
import { basename, join } from 'path'
import { safeCommand, needsShell } from './commandResolver'

const exec = promisify(execFile)
const repoPath = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i
const secretLine = /^(?:password|oauth_token|access_token)=/i

export interface GitHubRepo {
  fullName: string
  cloneUrl: string
  private: boolean
  description: string | null
}

function gitBinary(): string {
  const git = safeCommand('git', null)
  if (!git || needsShell(git)) throw new Error('Install Git for Windows to use GitHub projects.')
  return git
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|EXEC_PATH|PREFIX|CONFIG(?:_.*)?|GLOB_PATHSPECS|NOGLOB_PATHSPECS|LITERAL_PATHSPECS|ICASE_PATHSPECS)$/i.test(name)) delete env[name]
  }
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
}

export async function accounts(): Promise<string[]> {
  try {
    const { stdout } = await exec(gitBinary(), ['credential-manager', 'github', 'list'], {
      windowsHide: true, timeout: 15_000, maxBuffer: 16_384, env: gitEnvironment()
    })
    return stdout.split(/\r?\n/).map(s => s.trim()).filter(s => /^[A-Za-z0-9-]{1,39}$/.test(s) && s !== 'x-access-token')
  } catch {
    return []
  }
}

export async function signIn(): Promise<string[]> {
  try {
    await exec(gitBinary(), ['credential-manager', 'github', 'login', '--browser'], {
      windowsHide: true, timeout: 180_000, maxBuffer: 16_384, env: gitEnvironment()
    })
  } catch {
    throw new Error('GitHub sign-in did not finish. Check the browser window and try again.')
  }
  return accounts()
}

async function githubToken(): Promise<string> {
  // Git Credential Manager owns the secret. It is read only in main, used for
  // this request, and never sent to the renderer, logged, or saved by Cortex.
  const { spawn } = await import('child_process')
  const child = spawn(gitBinary(), ['credential', 'fill'], {
    windowsHide: true, env: { ...gitEnvironment(), GCM_INTERACTIVE: 'never' }, stdio: ['pipe', 'pipe', 'ignore']
  })
  child.stdin.end('protocol=https\nhost=github.com\n\n')
  const output: Buffer[] = []
  let size = 0
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > 16_384) child.kill()
    else output.push(chunk)
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('GitHub credentials timed out.')) }, 15_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', value => { clearTimeout(timer); resolve(value) })
  })
  if (code !== 0) throw new Error('Sign in to GitHub to browse your repositories.')
  const token = Buffer.concat(output).toString('utf8').split(/\r?\n/).find(line => secretLine.test(line))?.split('=').slice(1).join('=')
  if (!token) throw new Error('GitHub credentials are unavailable. Sign in and try again.')
  return token
}

export async function repositories(page: number): Promise<GitHubRepo[]> {
  if (!Number.isInteger(page) || page < 1 || page > 100) throw new Error('Invalid repository page.')
  const token = await githubToken()
  let response: Response
  try {
    response = await fetch(`https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&sort=pushed&per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'Cortex' },
      signal: AbortSignal.timeout(15_000)
    })
  } catch {
    throw new Error('Could not reach GitHub. Check your connection and try again.')
  }
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'GitHub access expired or your organization needs authorization.' : 'Could not load GitHub repositories.')
  const data: unknown = await response.json()
  if (!Array.isArray(data)) throw new Error('GitHub returned an unexpected repository list.')
  return data.flatMap((item): GitHubRepo[] => {
    if (!item || typeof item !== 'object') return []
    const repo = item as Record<string, unknown>
    if (typeof repo.full_name !== 'string' || typeof repo.clone_url !== 'string' || !repoPath.test(repo.clone_url)) return []
    return [{ fullName: repo.full_name, cloneUrl: repo.clone_url, private: repo.private === true, description: typeof repo.description === 'string' ? repo.description : null }]
  })
}

export async function clone(url: string, parent: string): Promise<string> {
  if (typeof url !== 'string' || url.length > 300 || !repoPath.test(url)) throw new Error('Enter a GitHub HTTPS or SSH repository URL.')
  if (typeof parent !== 'string') throw new Error('Choose a destination folder.')
  const physicalParent = await realpath(parent)
  if (!(await lstat(physicalParent)).isDirectory()) throw new Error('Choose a destination folder.')
  const match = repoPath.exec(url)!
  const name = match[2]
  if (name === '.' || name === '..' || basename(name) !== name) throw new Error('Invalid repository name.')
  const target = join(physicalParent, name)
  try {
    await lstat(target)
    throw new Error(`A folder named ${name} already exists. Choose another destination.`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await exec(gitBinary(), ['clone', '--', url, target], {
      cwd: physicalParent, windowsHide: true, timeout: 180_000, maxBuffer: 65_536, env: gitEnvironment()
    })
  } catch {
    throw new Error(`Could not clone ${match[1]}/${name}. Check access, your Git credentials, and the destination folder.`)
  }
  return target
}
