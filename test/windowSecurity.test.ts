import { EventEmitter } from 'node:events'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  guardRendererEvent,
  guardRendererInvoke,
  installWindowNavigationGuards,
  isRendererDocumentUrl,
  isTrustedRendererSender,
  resolveRendererDocumentUrl
} from '../src/main/windowSecurity'

const rendererFile = resolve(tmpdir(), 'Cortex security fixture', 'renderer', 'index.html')
const rendererUrl = pathToFileURL(rendererFile).href
const devUrl = 'http://localhost:5173/'

class WindowContents extends EventEmitter {
  popupHandler: ((details: { url: string }) => { action: 'deny' }) | null = null
  mainFrame = { url: rendererUrl }
  destroyed = false

  isDestroyed(): boolean { return this.destroyed }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void {
    this.popupHandler = handler
  }
}

afterEach(() => vi.restoreAllMocks())

describe('renderer document selection', () => {
  it.each(['https://hostile.example/secret?token=fixture', 'not a URL', undefined])('ignores the renderer environment in packaged applications (%s)', (environmentUrl) => {
    expect(resolveRendererDocumentUrl(true, environmentUrl, rendererFile)).toBe(rendererUrl)
  })

  it('loads the built file in a non-development preview', () => {
    expect(resolveRendererDocumentUrl(false, undefined, rendererFile)).toBe(rendererUrl)
  })

  it.each(['http://localhost:5173/', 'http://127.0.0.1:8123/', 'https://[::1]:5173/app?mode=dev'])('allows a credential-free loopback development URL (%s)', (url) => {
    expect(resolveRendererDocumentUrl(false, url, rendererFile)).toBe(url)
  })

  it.each([
    'not a URL',
    'https://hostile.example/',
    'http://localhost.hostile.example/',
    'http://user:fixture-password@localhost:5173/',
    'file:///another-renderer.html',
    'javascript:alert(1)'
  ])('rejects unsafe development renderer targets without leaking their contents (%s)', (url) => {
    const select = (): string => resolveRendererDocumentUrl(false, url, rendererFile)
    expect(select).toThrow('credential-free loopback HTTP or HTTPS URL')
    try { select() } catch (error) {
      expect(String(error)).not.toContain(url)
      expect(String(error)).not.toContain('fixture-password')
    }
  })
})

describe('exact renderer document identity', () => {
  it.each([rendererUrl, `${rendererUrl}#editor`, devUrl, `${devUrl}#editor`])('allows the selected document and same-document fragments (%s)', (candidate) => {
    expect(isRendererDocumentUrl(candidate, candidate.startsWith('file:') ? rendererUrl : devUrl)).toBe(true)
  })

  it('does not trust a different file document with the same null origin', () => {
    const other = pathToFileURL(resolve(tmpdir(), 'other-renderer.html')).href
    expect(new URL(other).origin).toBe(new URL(rendererUrl).origin)
    expect(isRendererDocumentUrl(other, rendererUrl)).toBe(false)
  })

  it.each([
    'http://localhost:5173/other.html',
    'http://localhost:5173/?other=true',
    'http://localhost:5174/',
    'https://localhost:5173/',
    'http://127.0.0.1:5173/',
    'http://localhost:5173.hostile.example/',
    'http://user:fixture-password@localhost:5173/',
    'javascript:alert(1)',
    'not a URL'
  ])('rejects a different development document or malformed URL (%s)', (candidate) => {
    expect(isRendererDocumentUrl(candidate, devUrl)).toBe(false)
  })

  it('rejects an uninitialized or invalid expected document', () => {
    expect(isRendererDocumentUrl(devUrl, null)).toBe(false)
    expect(isRendererDocumentUrl(devUrl, 'not a URL')).toBe(false)
  })
})

describe('window navigation boundary', () => {
  it.each(['will-frame-navigate', 'will-redirect'])('allows only the exact main document for %s', (eventName) => {
    const contents = new WindowContents()
    installWindowNavigationGuards(contents, rendererUrl, vi.fn())
    for (const candidate of [rendererUrl, `${rendererUrl}#editor`]) {
      const event = { url: candidate, isMainFrame: true, preventDefault: vi.fn() }
      contents.emit(eventName, event)
      expect(event.preventDefault).not.toHaveBeenCalled()
    }
    for (const candidate of ['https://hostile.example/', pathToFileURL(resolve(tmpdir(), 'other.html')).href]) {
      const event = { url: candidate, isMainFrame: true, preventDefault: vi.fn() }
      contents.emit(eventName, event)
      expect(event.preventDefault).toHaveBeenCalledOnce()
    }
  })

  it.each(['will-frame-navigate', 'will-redirect'])('blocks unused subframe documents for %s', (eventName) => {
    const contents = new WindowContents()
    installWindowNavigationGuards(contents, rendererUrl, vi.fn())
    const event = { url: rendererUrl, isMainFrame: false, preventDefault: vi.fn() }
    contents.emit(eventName, event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it.each([
    'https://wokwi.com/',
    'https://www.tinkercad.com/circuits',
    'https://www.msys2.org/',
    'https://developer.apple.com/xcode/resources/',
    'https://gcc.gnu.org/install/'
  ])('opens supported HTTPS references in the OS browser, never a child window (%s)', async (url) => {
    const contents = new WindowContents()
    const openExternal = vi.fn().mockResolvedValue(undefined)
    installWindowNavigationGuards(contents, rendererUrl, openExternal)
    expect(contents.popupHandler?.({ url })).toEqual({ action: 'deny' })
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith(url))
  })

  it.each([
    'http://hostile.example/',
    'https://user:fixture-password@hostile.example/',
    'file:///private-document.html',
    'javascript:alert(1)',
    'data:text/html,hostile',
    'custom-tool:execute',
    'not a URL'
  ])('does not launch the browser or a child window for unsafe links (%s)', async (url) => {
    const contents = new WindowContents()
    const openExternal = vi.fn().mockResolvedValue(undefined)
    installWindowNavigationGuards(contents, rendererUrl, openExternal)
    expect(contents.popupHandler?.({ url })).toEqual({ action: 'deny' })
    await Promise.resolve()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it.each(['synchronous', 'asynchronous'])('handles %s browser failures locally without logging URLs or errors', async (kind) => {
    const contents = new WindowContents()
    const sensitiveError = new Error('fixture-browser-secret https://private.example/?token=fixture')
    const openExternal = kind === 'synchronous'
      ? vi.fn(() => { throw sensitiveError })
      : vi.fn().mockRejectedValue(sensitiveError)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    installWindowNavigationGuards(contents, rendererUrl, openExternal)
    expect(contents.popupHandler?.({ url: 'https://wokwi.com/' })).toEqual({ action: 'deny' })
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce())
    expect(warn).toHaveBeenCalledWith('[cortex] Could not open external browser link.')
  })
})

describe('trusted renderer IPC sender', () => {
  it('accepts only the current window main frame on the selected renderer document', () => {
    const contents = new WindowContents()
    const window = { webContents: contents, isDestroyed: () => false }
    const event = { sender: contents, senderFrame: contents.mainFrame }
    expect(isTrustedRendererSender(event, window, rendererUrl)).toBe(true)
    contents.mainFrame.url = `${rendererUrl}#editor`
    expect(isTrustedRendererSender(event, window, rendererUrl)).toBe(true)
  })

  it('rejects another window or a subframe even if its document URL matches', () => {
    const contents = new WindowContents()
    const other = new WindowContents()
    const window = { webContents: contents, isDestroyed: () => false }
    expect(isTrustedRendererSender({ sender: other, senderFrame: other.mainFrame }, window, rendererUrl)).toBe(false)
    expect(isTrustedRendererSender({ sender: contents, senderFrame: { url: rendererUrl } }, window, rendererUrl)).toBe(false)
  })

  it('rejects missing, destroyed or navigated renderers', () => {
    const contents = new WindowContents()
    const event = { sender: contents, senderFrame: contents.mainFrame }
    const window = { webContents: contents, isDestroyed: () => false }
    expect(isTrustedRendererSender(event, null, rendererUrl)).toBe(false)
    expect(isTrustedRendererSender(event, window, null)).toBe(false)
    expect(isTrustedRendererSender({ ...event, senderFrame: null }, window, rendererUrl)).toBe(false)
    expect(isTrustedRendererSender(event, { ...window, isDestroyed: () => true }, rendererUrl)).toBe(false)
    contents.destroyed = true
    expect(isTrustedRendererSender(event, window, rendererUrl)).toBe(false)
    contents.destroyed = false
    contents.mainFrame.url = pathToFileURL(resolve(tmpdir(), 'other.html')).href
    expect(isTrustedRendererSender(event, window, rendererUrl)).toBe(false)
  })

  it('fails closed if a disposed frame cannot be inspected', () => {
    const contents = new WindowContents()
    const window = { webContents: contents, isDestroyed: () => false }
    const disposed = { get url(): string { throw new Error('disposed frame') } }
    expect(isTrustedRendererSender({ sender: contents, senderFrame: disposed }, window, rendererUrl)).toBe(false)
    const event = { sender: contents, get senderFrame(): never { throw new Error('disposed frame') } }
    expect(isTrustedRendererSender(event, window, rendererUrl)).toBe(false)
  })
})

describe('trusted renderer IPC dispatch', () => {
  it('returns invoke results and arguments only to an admitted sender', () => {
    const contents = new WindowContents()
    const window = { webContents: contents, isDestroyed: () => false }
    const handler = guardRendererInvoke(() => window, () => rendererUrl, (_event, path: string) => `read ${path}`)
    expect(handler({ sender: contents, senderFrame: contents.mainFrame }, 'main.ino')).toBe('read main.ino')
  })

  it('rejects an unauthorized invocation before privileged work starts', () => {
    const contents = new WindowContents()
    const foreign = new WindowContents()
    const window = { webContents: contents, isDestroyed: () => false }
    const privileged = vi.fn(() => 'private result')
    const handler = guardRendererInvoke(() => window, () => rendererUrl, privileged)
    expect(() => handler({ sender: foreign, senderFrame: foreign.mainFrame })).toThrow('Untrusted renderer IPC sender')
    expect(privileged).not.toHaveBeenCalled()
  })

  it('does not consume a close acknowledgement when an unauthorized invocation arrives first', () => {
    const contents = new WindowContents()
    const window = { webContents: contents, isDestroyed: () => false }
    let readyToClose = false
    const close = vi.fn(() => { readyToClose = true })
    const handler = guardRendererInvoke(() => window, () => rendererUrl, close)
    expect(() => handler({ sender: contents, senderFrame: { url: rendererUrl } })).toThrow('Untrusted renderer IPC sender')
    expect(readyToClose).toBe(false)
    expect(close).not.toHaveBeenCalled()
    handler({ sender: contents, senderFrame: contents.mainFrame })
    expect(readyToClose).toBe(true)
    expect(close).toHaveBeenCalledOnce()
  })

  it('checks the current window at dispatch, rejecting an old renderer after recreation', () => {
    const oldContents = new WindowContents()
    const newContents = new WindowContents()
    let currentWindow = { webContents: oldContents, isDestroyed: () => false }
    const privileged = vi.fn()
    const handler = guardRendererInvoke(() => currentWindow, () => rendererUrl, privileged)
    currentWindow = { webContents: newContents, isDestroyed: () => false }
    expect(() => handler({ sender: oldContents, senderFrame: oldContents.mainFrame })).toThrow('Untrusted renderer IPC sender')
    expect(privileged).not.toHaveBeenCalled()
    handler({ sender: newContents, senderFrame: newContents.mainFrame })
    expect(privileged).toHaveBeenCalledOnce()
  })

  it('ignores unauthorized fire-and-forget events without invoking privileged listeners', () => {
    const contents = new WindowContents()
    const window = { webContents: contents, isDestroyed: () => false }
    const writes: string[] = []
    const listener = guardRendererEvent(() => window, () => rendererUrl, (_event, input: string) => { writes.push(input) })
    expect(() => listener({ sender: contents, senderFrame: { url: rendererUrl } }, 'unsafe')).not.toThrow()
    expect(writes).toEqual([])
    listener({ sender: contents, senderFrame: contents.mainFrame }, 'safe')
    expect(writes).toEqual(['safe'])
  })

  it('preserves genuine async invocation failures for the caller', async () => {
    const contents = new WindowContents()
    const window = { webContents: contents, isDestroyed: () => false }
    const failure = new Error('Cannot save; the file changed on disk')
    const handler = guardRendererInvoke(() => window, () => rendererUrl, async () => { throw failure })
    await expect(handler({ sender: contents, senderFrame: contents.mainFrame })).rejects.toBe(failure)
  })
})
