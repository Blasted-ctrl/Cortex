import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clone, repositories } from '../src/main/services/githubService'

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('GitHub project boundaries', () => {
  it('rejects non-GitHub URLs before launching Git', async () => {
    await expect(clone('file:///tmp/private', 'unused')).rejects.toThrow('GitHub HTTPS or SSH')
    await expect(clone('https://example.com/owner/repo', 'unused')).rejects.toThrow('GitHub HTTPS or SSH')
    await expect(clone('https://github.com/owner/../repo', 'unused')).rejects.toThrow('GitHub HTTPS or SSH')
  })

  it('refuses to overwrite an existing destination', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cortex-github-clone-'))
    temporary.push(parent)
    mkdirSync(join(parent, 'firmware'))
    await expect(clone('https://github.com/example/firmware.git', parent)).rejects.toThrow('already exists')
  })

  it('rejects invalid repository pages without contacting GitHub', async () => {
    await expect(repositories(0)).rejects.toThrow('Invalid repository page')
    await expect(repositories(101)).rejects.toThrow('Invalid repository page')
  })
})
