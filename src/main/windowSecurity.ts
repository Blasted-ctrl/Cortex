import { pathToFileURL } from 'node:url'

interface RendererFrame {
  readonly url: string
}

interface RendererContents {
  isDestroyed(): boolean
  readonly mainFrame: RendererFrame
}

interface RendererWindow {
  isDestroyed(): boolean
  readonly webContents: RendererContents
}

interface RendererSender {
  readonly sender: RendererContents
  readonly senderFrame: RendererFrame | null
}

interface NavigationEvent {
  readonly url: string
  readonly isMainFrame: boolean
  preventDefault(): void
}

interface NavigationContents {
  on(event: 'will-frame-navigate' | 'will-redirect', listener: (event: NavigationEvent) => void): unknown
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
}

export function resolveRendererDocumentUrl(isPackaged: boolean, devUrl: string | undefined, rendererFile: string): string {
  if (isPackaged || !devUrl) return pathToFileURL(rendererFile).href
  try {
    const url = new URL(devUrl)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password &&
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.href
  } catch { /* Reject malformed development targets without logging their contents. */ }
  throw new Error('Development renderer must use a credential-free loopback HTTP or HTTPS URL.')
}

export function isRendererDocumentUrl(candidate: string, expected: string | null): boolean {
  if (!expected) return false
  try {
    const actualUrl = new URL(candidate)
    const expectedUrl = new URL(expected)
    if (actualUrl.username || actualUrl.password || expectedUrl.username || expectedUrl.password) return false
    actualUrl.hash = ''
    expectedUrl.hash = ''
    return actualUrl.href === expectedUrl.href
  } catch {
    return false
  }
}

export function installWindowNavigationGuards(contents: NavigationContents, expected: string, openExternal: (url: string) => Promise<unknown>): void {
  const guardNavigation = (event: NavigationEvent): void => {
    if (!event.isMainFrame || !isRendererDocumentUrl(event.url, expected)) event.preventDefault()
  }
  contents.on('will-frame-navigate', guardNavigation)
  contents.on('will-redirect', guardNavigation)
  contents.setWindowOpenHandler(({ url: target }) => {
    try {
      const url = new URL(target)
      if (url.protocol === 'https:' && !url.username && !url.password) {
        void Promise.resolve().then(() => openExternal(url.href)).catch(() => {
          console.warn('[cortex] Could not open external browser link.')
        })
      }
    } catch { /* Malformed and unsafe links never leave the application. */ }
    return { action: 'deny' }
  })
}

export function isTrustedRendererSender(event: RendererSender, window: RendererWindow | null, expected: string | null): boolean {
  try {
    if (!window || window.isDestroyed() || window.webContents.isDestroyed() || event.sender !== window.webContents) return false
    const frame = event.senderFrame
    return frame !== null && frame === window.webContents.mainFrame && isRendererDocumentUrl(frame.url, expected)
  } catch {
    return false
  }
}

export function guardRendererInvoke<Event extends RendererSender, Args extends unknown[], Result>(
  getWindow: () => RendererWindow | null,
  getDocument: () => string | null,
  listener: (event: Event, ...args: Args) => Result
): (event: Event, ...args: Args) => Result {
  return (event, ...args) => {
    if (!isTrustedRendererSender(event, getWindow(), getDocument())) throw new Error('Untrusted renderer IPC sender')
    return listener(event, ...args)
  }
}

export function guardRendererEvent<Event extends RendererSender, Args extends unknown[]>(
  getWindow: () => RendererWindow | null,
  getDocument: () => string | null,
  listener: (event: Event, ...args: Args) => void
): (event: Event, ...args: Args) => void {
  return (event, ...args) => {
    if (isTrustedRendererSender(event, getWindow(), getDocument())) listener(event, ...args)
  }
}
