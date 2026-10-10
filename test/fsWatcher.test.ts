import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { BrowserWindow } from 'electron'
import * as files from '../src/main/services/fsService'
import { IPC } from '../src/shared/ipc'

let fixture: string | undefined
let watcher: FSWatcher | undefined

afterEach(async () => {
  files.stopWatch()
  await watcher?.close()
  vi.restoreAllMocks()
  if (fixture) await fs.rm(fixture, { recursive: true, force: true })
})

describe('project filesystem watcher events', () => {
  it('reports deletion after a rename destination was visible to an earlier directory refresh', async () => {
    fixture = await fs.mkdtemp(join(tmpdir(), 'cortex-watch-'))
    const source = join(fixture, 'source.cpp')
    const destination = join(fixture, 'renamed.cpp')
    await fs.writeFile(source, '// owned project fixture\n')
    const messages: Array<{ type: string; path: string }> = []
    let sourceRemoved!: () => void
    const removal = new Promise<void>((resolve) => { sourceRemoved = resolve })
    const win = {
      isDestroyed: () => false,
      webContents: { send: (channel: string, event: { type: string; path: string }) => {
        if (channel !== IPC.FS_EVENT) return
        messages.push(event)
        if (event.type === 'unlink' && event.path === source) sourceRemoved()
      } }
    } as unknown as BrowserWindow
    const watch = vi.spyOn(chokidar, 'watch')
    files.startWatch(fixture, win)
    watcher = watch.mock.results[0].value as FSWatcher
    await new Promise<void>((resolve, reject) => {
      watcher!.once('ready', resolve)
      watcher!.once('error', reject)
    })
    await fs.rename(source, destination)
    await removal
    expect((await files.readDir(fixture)).map((entry) => entry.path)).toEqual([destination])
    await fs.unlink(destination)
    await vi.waitFor(() => expect(messages).toContainEqual(expect.objectContaining({
      type: 'unlink', path: destination
    })), { timeout: 2000, interval: 20 })
    expect(await files.readDir(fixture)).toEqual([])
  }, 10_000)
})
