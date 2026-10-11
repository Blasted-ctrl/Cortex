import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setProjectConfig } from '../src/main/services/projectConfigService'

let fixture: string
let root: string
let config: string

beforeEach(async () => {
  fixture = await fs.mkdtemp(join(tmpdir(), 'cortex-config-save-'))
  root = join(fixture, 'project')
  config = join(root, '.cortex', 'config.json')
  await fs.mkdir(join(root, '.cortex'), { recursive: true })
  await fs.writeFile(config, JSON.stringify({ compiler: 'tools/private-compiler', std: 'c++17' }))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(fixture, { recursive: true, force: true })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((ok) => { resolve = ok })
  return { promise, resolve }
}

describe('project config persistence', () => {
  it('merges concurrent setting changes instead of losing either patch', async () => {
    const read = fs.readFile.bind(fs)
    const held = deferred()
    const firstCaptured = deferred()
    const secondCaptured = deferred()
    const physicalConfig = await fs.realpath(config)
    let reads = 0
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
      const value = await read(...args)
      if (String(args[0]) === physicalConfig) {
        ++reads
        if (reads === 1) { firstCaptured.resolve(); await held.promise }
        else if (reads === 2) secondCaptured.resolve()
      }
      return value
    })
    const first = setProjectConfig(root, { std: 'c++23' })
    await firstCaptured.promise
    const second = setProjectConfig(root, { optimization: '-O2' })
    // If reads are not serialized, capture both old snapshots before releasing
    // the first. A correctly queued second read waits for this release deadline.
    let timer!: ReturnType<typeof setTimeout>
    await Promise.race([secondCaptured.promise, new Promise<void>((resolve) => { timer = setTimeout(resolve, 100) })])
    clearTimeout(timer)
    held.resolve()
    await Promise.all([first, second])
    expect(JSON.parse(await read(config, 'utf8'))).toEqual({ compiler: 'tools/private-compiler', std: 'c++23', optimization: '-O2' })
  })

  it('preserves the old config when a write fails after writing partial bytes', async () => {
    const original = await fs.readFile(config, 'utf8')
    const write = fs.writeFile.bind(fs)
    const open = fs.open.bind(fs)
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
      if (String(args[0]) === config) {
        await write(config, '{partial')
        throw new Error('Disk full')
      }
      return write(...args)
    })
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (basename(String(args[0])).startsWith('.config.json.cortex-save-')) {
        const writeHandle = handle.writeFile.bind(handle)
        vi.spyOn(handle, 'writeFile').mockImplementation(async () => {
          await writeHandle('{partial', 'utf8')
          throw new Error('Disk full')
        })
      }
      return handle
    })
    await expect(setProjectConfig(root, { std: 'c++23' })).rejects.toThrow('Disk full')
    expect(await fs.readFile(config, 'utf8')).toBe(original)
    expect(await fs.readdir(join(root, '.cortex'))).toEqual(['config.json'])
  })

  it('preserves the old config if atomic replacement fails', async () => {
    const original = await fs.readFile(config, 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('File is locked'))
    await expect(setProjectConfig(root, { std: 'c++23' })).rejects.toThrow('File is locked')
    expect(await fs.readFile(config, 'utf8')).toBe(original)
    expect(await fs.readdir(join(root, '.cortex'))).toEqual(['config.json'])
  })

  it('does not replace a malformed existing config with an empty merge', async () => {
    await fs.writeFile(config, '{unfinished')
    await expect(setProjectConfig(root, { std: 'c++23' })).rejects.toThrow()
    expect(await fs.readFile(config, 'utf8')).toBe('{unfinished')
  })

  it('does not treat a permission error reading existing settings as an empty config', async () => {
    const original = await fs.readFile(config, 'utf8')
    vi.spyOn(fs, 'readFile').mockRejectedValueOnce(Object.assign(new Error('Permission denied'), { code: 'EACCES' }))
    await expect(setProjectConfig(root, { std: 'c++23' })).rejects.toThrow('Permission denied')
    vi.restoreAllMocks()
    expect(await fs.readFile(config, 'utf8')).toBe(original)
  })

  it('refuses a .cortex directory linked outside the admitted project', async () => {
    const outside = join(fixture, 'outside')
    await fs.mkdir(outside)
    const external = join(outside, 'config.json')
    await fs.writeFile(external, '{"std":"c++17"}')
    await fs.rm(join(root, '.cortex'), { recursive: true })
    await fs.symlink(outside, join(root, '.cortex'), 'junction')
    await expect(setProjectConfig(root, { std: 'c++23' })).rejects.toThrow('outside')
    expect(await fs.readFile(external, 'utf8')).toBe('{"std":"c++17"}')
  })

  it('refuses a config file linked outside the admitted project', async () => {
    const outside = join(fixture, 'outside')
    await fs.mkdir(outside)
    const external = join(outside, 'config.json')
    await fs.writeFile(external, '{"std":"c++17"}')
    await fs.rm(config)
    // A relative file link requires elevated privileges on some Windows hosts;
    // link a directory entry named config.json instead, which is also refused.
    await fs.symlink(outside, config, 'junction')
    await expect(setProjectConfig(root, { std: 'c++23' })).rejects.toThrow('outside')
    expect(await fs.readFile(external, 'utf8')).toBe('{"std":"c++17"}')
  })

  it('creates a missing configuration without leaving a staging file', async () => {
    await fs.rm(join(root, '.cortex'), { recursive: true })
    expect(await setProjectConfig(root, { std: 'c++23' })).toEqual({ std: 'c++23' })
    expect(JSON.parse(await fs.readFile(config, 'utf8'))).toEqual({ std: 'c++23' })
    expect(await fs.readdir(join(root, '.cortex'))).toEqual(['config.json'])
  })

  it('keeps the newest same-field update and merges through a root alias', async () => {
    const alias = join(fixture, 'alias')
    await fs.symlink(root, alias, 'junction')
    await Promise.all([
      setProjectConfig(root, { std: 'c++20' }),
      setProjectConfig(alias, { optimization: '-O2' }),
      setProjectConfig(root, { std: 'c++23' })
    ])
    expect(JSON.parse(await fs.readFile(config, 'utf8'))).toEqual({ compiler: 'tools/private-compiler', std: 'c++23', optimization: '-O2' })
  })

  it('allows a later queued save to recover after the previous save fails', async () => {
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('File is locked'))
    const [first, second] = await Promise.allSettled([
      setProjectConfig(root, { optimization: '-O2' }),
      setProjectConfig(root, { std: 'c++23' })
    ])
    expect(first.status).toBe('rejected')
    expect(second.status).toBe('fulfilled')
    expect(JSON.parse(await fs.readFile(config, 'utf8'))).toEqual({ compiler: 'tools/private-compiler', std: 'c++23' })
    expect(await fs.readdir(join(root, '.cortex'))).toEqual(['config.json'])
  })

  it('does not overwrite external settings changed while a save was staging', async () => {
    const open = fs.open.bind(fs)
    const external = '{"std":"c++20","optimization":"-O3"}'
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      if (basename(String(args[0])).startsWith('.config.json.cortex-save-')) {
        const write = handle.writeFile.bind(handle)
        vi.spyOn(handle, 'writeFile').mockImplementation(async (...writeArgs) => {
          await write(...writeArgs)
          await fs.writeFile(config, external)
        })
      }
      return handle
    })
    await expect(setProjectConfig(root, { std: 'c++23' })).rejects.toThrow('changed on disk')
    expect(await fs.readFile(config, 'utf8')).toBe(external)
    expect(await fs.readdir(join(root, '.cortex'))).toEqual(['config.json'])
  })
})
