import { act, createElement } from 'react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../src/renderer/src/store/useStore'
import { createHost, descendants, invoke, type HostNode } from './reactHost'

const storage = new Map<string, string>()
const api = { setSettings: vi.fn(), serialClose: vi.fn(), serialOpen: vi.fn(), nativeLibStatus: vi.fn().mockResolvedValue([]) }
vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
vi.stubGlobal('window', { api })
vi.stubGlobal('React', React)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const { useStore } = await import('../src/renderer/src/store/useStore')
const { default: SettingsView } = await import('../src/renderer/src/components/SettingsView')
const initial = useStore.getState()
const original: AppSettings = {
  theme: 'dark', defaultCppCompiler: '', defaultCppStandard: 'c++23', pythonPath: 'python',
  ai: { provider: 'none', model: '', apiKey: '', apiKeySet: false, baseUrl: '' },
  serial: { baudRate: 115200 }, boards: { additionalUrls: ['https://example.test/original.json'] }
}
const failure = new Error('Owned IPC failure containing a fake-private-marker')
const failureDetail = 'Your change was not saved. Check settings.json, file permissions, available disk space and the OS keyring, then retry.'
let committed: AppSettings
let host: ReturnType<typeof createHost>
const text = (node: HostNode): string => [node, ...descendants(node)].filter((child) => child.type === '#text').map((child) => child.props.text).join('').trim()
function button(label: string): HostNode {
  const node = host.nodes().find((node) => node.type === 'button' && text(node) === label)
  if (!node) throw new Error(`Button missing: ${label}`)
  return node
}
function control(label: string, type = 'input'): HostNode {
  const field = host.nodes().find((node) => node.type === 'label' && node.children[0] && text(node.children[0]) === label)
  const node = field && descendants(field).find((node) => node.type === type)
  if (!node) throw new Error(`Control missing: ${label}`)
  return node
}
function urlInput(): HostNode {
  const node = host.nodes().find((node) => node.props.placeholder === 'https://.../package_..._index.json')
  if (!node) throw new Error('Board URL input missing')
  return node
}
async function click(label: string): Promise<void> {
  await act(async () => { invoke(button(label), 'onClick', {}) })
}
async function type(node: HostNode, value: string): Promise<void> {
  await act(async () => { invoke(node, 'onChange', { target: { value } }) })
}
function expectFailure(): void {
  expect(useStore.getState().notifications).toEqual([expect.objectContaining({ kind: 'error', title: 'Could not save settings', detail: failureDetail })])
  expect(JSON.stringify(useStore.getState().notifications)).not.toContain('fake-private-marker')
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(async () => {
  storage.clear()
  committed = structuredClone(original)
  api.setSettings.mockReset().mockImplementation(async (patch: Partial<AppSettings>) => {
    committed = { ...committed, ...patch,
      ai: { ...committed.ai, ...patch.ai, apiKey: '', apiKeySet: !!patch.ai?.apiKey || committed.ai.apiKeySet },
      serial: { ...committed.serial, ...patch.serial }, boards: { ...committed.boards, ...patch.boards } }
    return structuredClone(committed)
  })
  api.serialClose.mockReset().mockResolvedValue(undefined)
  api.serialOpen.mockReset().mockResolvedValue(true)
  useStore.setState({ ...initial, settings: structuredClone(original), serialBaud: 115200, serialOpen: false, notifications: [], notifUnread: 0 }, true)
  host = createHost()
  await host.render(createElement(SettingsView))
})
afterEach(async () => { await host.render(null) })

describe('actual SettingsView save failures', () => {
  it.each(['updateSettings', 'setTheme'] as const)('reports once but still rejects for programmatic %s callers', async (action) => {
    api.setSettings.mockRejectedValueOnce(failure)
    const previous = useStore.getState().settings
    const writing = action === 'setTheme' ? useStore.getState().setTheme('light') : useStore.getState().updateSettings({ theme: 'light' })
    await act(async () => { await expect(writing).rejects.toBe(failure) })
    expect(useStore.getState().settings).toBe(previous)
    expectFailure()
  })

  it('handles a rejected native theme click without publishing the unsaved theme', async () => {
    api.setSettings.mockRejectedValueOnce(failure)
    await click('light')
    expect(useStore.getState().settings?.theme).toBe('dark')
    expect(button('dark').props['aria-pressed']).toBe(true)
    expectFailure()
  })

  it.each([
    { category: 'Build', label: 'Default C++ compiler', type: 'input', value: 'clang++' },
    { category: 'Build', label: 'Default C++ standard', type: 'select', value: 'c++20' },
    { category: 'Build', label: 'Python interpreter', type: 'input', value: '/owned/python' },
    { category: 'Cortex Agent', label: 'Provider', type: 'select', value: 'local' },
    { category: 'Cortex Agent', label: 'Model', type: 'input', value: 'owned-model' },
    { category: 'Cortex Agent', label: 'Base URL (optional)', type: 'input', value: 'http://localhost:11434' }
  ])('handles persistence rejection for the actual $label control', async ({ category, label, type: controlType, value }) => {
    await click(category)
    const previous = useStore.getState().settings
    api.setSettings.mockRejectedValueOnce(failure)
    await type(control(label, controlType), value)
    if (controlType === 'input') await act(async () => { invoke(control(label), 'onBlur', {}) })
    expect(useStore.getState().settings).toBe(previous)
    if (controlType === 'input') expect(control(label).props.value).toBe(value)
    expectFailure()
  })

  it('keeps a failed compiler draft available for a successful blur retry', async () => {
    await click('Build')
    api.setSettings.mockRejectedValueOnce(failure)
    await type(control('Default C++ compiler'), 'clang++')
    expect(api.setSettings).not.toHaveBeenCalled()
    await act(async () => { invoke(control('Default C++ compiler'), 'onBlur', {}) })
    expect(control('Default C++ compiler').props.value).toBe('clang++')
    expectFailure()
    await act(async () => { invoke(control('Default C++ compiler'), 'onBlur', {}) })
    expect(useStore.getState().settings?.defaultCppCompiler).toBe('clang++')
    expect(control('Default C++ compiler').props.value).toBe('clang++')
    expect(api.setSettings).toHaveBeenCalledTimes(2)
    expectFailure()
    await act(async () => { useStore.setState({ settings: { ...committed, defaultCppCompiler: 'external-compiler' } }) })
    expect(control('Default C++ compiler').props.value).toBe('external-compiler')
    expect(api.setSettings).toHaveBeenCalledTimes(2)
  })

  it('adopts committed external text when the draft is clean without saving it', async () => {
    await click('Build')
    await act(async () => { useStore.setState({ settings: { ...original, pythonPath: '/owned/external-python' } }) })
    expect(control('Python interpreter').props.value).toBe('/owned/external-python')
    expect(api.setSettings).not.toHaveBeenCalled()
  })

  it('adopts an own save and allows the next committed external value without keystroke saves', async () => {
    await click('Build')
    await type(control('Python interpreter'), '/owned/submitted-python')
    expect(api.setSettings).not.toHaveBeenCalled()
    await act(async () => { invoke(control('Python interpreter'), 'onBlur', {}) })
    expect(useStore.getState().settings?.pythonPath).toBe('/owned/submitted-python')
    expect(control('Python interpreter').props.value).toBe('/owned/submitted-python')
    await act(async () => { useStore.setState({ settings: { ...committed, pythonPath: '/owned/external-python' } }) })
    expect(control('Python interpreter').props.value).toBe('/owned/external-python')
    expect(api.setSettings).toHaveBeenCalledExactlyOnceWith({ pythonPath: '/owned/submitted-python' })
  })

  it.each([
    { category: 'Build', label: 'Default C++ compiler', nested: false },
    { category: 'Cortex Agent', label: 'Model', nested: true }
  ])('keeps newer $label typing when an earlier save succeeds, then commits the newer draft', async ({ category, label, nested }) => {
    await click(category)
    const writing = deferred<AppSettings>()
    api.setSettings.mockReturnValueOnce(writing.promise)
    await type(control(label), 'submitted-first')
    expect(api.setSettings).not.toHaveBeenCalled()
    await act(async () => { invoke(control(label), 'onBlur', {}) })
    await type(control(label), 'typed-newer')
    expect(api.setSettings).toHaveBeenCalledOnce()
    const saved = nested ? { ...original, ai: { ...original.ai, model: 'submitted-first' } } : { ...original, defaultCppCompiler: 'submitted-first' }
    await act(async () => { committed = saved; writing.resolve(structuredClone(saved)) })
    expect(control(label).props.value).toBe('typed-newer')
    expect(nested ? useStore.getState().settings?.ai.model : useStore.getState().settings?.defaultCppCompiler).toBe('submitted-first')
    await act(async () => { invoke(control(label), 'onBlur', {}) })
    expect(control(label).props.value).toBe('typed-newer')
    expect(nested ? useStore.getState().settings?.ai.model : useStore.getState().settings?.defaultCppCompiler).toBe('typed-newer')
    expect(api.setSettings).toHaveBeenCalledTimes(2)
    expect(useStore.getState().notifications).toEqual([])
  })

  it('keeps newer typing back to the original committed string when another value is saved', async () => {
    await click('Build')
    const writing = deferred<AppSettings>()
    api.setSettings.mockReturnValueOnce(writing.promise)
    await type(control('Python interpreter'), '/owned/submitted-python')
    await act(async () => { invoke(control('Python interpreter'), 'onBlur', {}) })
    await type(control('Python interpreter'), original.pythonPath)
    const saved = { ...original, pythonPath: '/owned/submitted-python' }
    await act(async () => { committed = saved; writing.resolve(structuredClone(saved)) })
    expect(control('Python interpreter').props.value).toBe(original.pythonPath)
    expect(useStore.getState().settings?.pythonPath).toBe('/owned/submitted-python')
    await act(async () => { invoke(control('Python interpreter'), 'onBlur', {}) })
    expect(control('Python interpreter').props.value).toBe(original.pythonPath)
    expect(useStore.getState().settings?.pythonPath).toBe(original.pythonPath)
    expect(api.setSettings).toHaveBeenCalledTimes(2)
  })

  it('does not acknowledge a newer same-string draft with an earlier successful submission', async () => {
    await click('Build')
    const writing = deferred<AppSettings>()
    api.setSettings.mockReturnValueOnce(writing.promise)
    await type(control('Default C++ compiler'), 'clang++')
    await act(async () => { invoke(control('Default C++ compiler'), 'onBlur', {}) })
    await type(control('Default C++ compiler'), 'g++')
    await type(control('Default C++ compiler'), 'clang++')
    await act(async () => {
      committed = { ...original, defaultCppCompiler: 'clang++' }
      writing.resolve(structuredClone(committed))
    })
    expect(control('Default C++ compiler').props.value).toBe('clang++')
    await act(async () => {
      committed = { ...committed, defaultCppCompiler: 'external-compiler' }
      useStore.setState({ settings: structuredClone(committed) })
    })
    expect(control('Default C++ compiler').props.value).toBe('clang++')
    expect(api.setSettings).toHaveBeenCalledOnce()
    await act(async () => { invoke(control('Default C++ compiler'), 'onBlur', {}) })
    expect(useStore.getState().settings?.defaultCppCompiler).toBe('clang++')
    expect(api.setSettings).toHaveBeenCalledTimes(2)
  })

  it('accepts a reverted clean draft on blur without saving or blocking later external text', async () => {
    await click('Build')
    await type(control('Python interpreter'), '/owned/not-submitted')
    await type(control('Python interpreter'), original.pythonPath)
    await act(async () => { invoke(control('Python interpreter'), 'onBlur', {}) })
    expect(api.setSettings).not.toHaveBeenCalled()
    await act(async () => { useStore.setState({ settings: { ...original, pythonPath: '/owned/external-python' } }) })
    expect(control('Python interpreter').props.value).toBe('/owned/external-python')
  })

  it('discards only the draft on Escape and adopts the latest committed text without saving', async () => {
    await click('Build')
    await type(control('Python interpreter'), '/owned/keep-draft')
    await act(async () => { useStore.setState({ settings: { ...original, pythonPath: '/owned/latest-python' } }) })
    expect(control('Python interpreter').props.value).toBe('/owned/keep-draft')
    await act(async () => { invoke(control('Python interpreter'), 'onKeyDown', { key: 'Escape' }) })
    expect(control('Python interpreter').props.value).toBe('/owned/latest-python')
    await act(async () => { useStore.setState({ settings: { ...original, pythonPath: '/owned/after-escape-python' } }) })
    expect(control('Python interpreter').props.value).toBe('/owned/after-escape-python')
    expect(api.setSettings).not.toHaveBeenCalled()
  })

  it('does not transfer a compiler draft into Python when search changes during its blur save', async () => {
    const search = host.nodes().find((node) => node.props['aria-label'] === 'Search settings')!
    await type(search, 'compiler')
    await type(control('Default C++ compiler'), 'clang++')
    const writing = deferred<AppSettings>()
    api.setSettings.mockReturnValueOnce(writing.promise)
    await act(async () => { invoke(control('Default C++ compiler'), 'onBlur', {}) })
    await type(search, 'python')
    await act(async () => {
      committed = { ...original, defaultCppCompiler: 'clang++' }
      writing.resolve(structuredClone(committed))
    })
    expect(control('Python interpreter').props.value).toBe(original.pythonPath)
    expect(useStore.getState().settings?.defaultCppCompiler).toBe('clang++')
    await act(async () => { invoke(control('Python interpreter'), 'onBlur', {}) })
    expect(api.setSettings).toHaveBeenCalledExactlyOnceWith({ defaultCppCompiler: 'clang++' })
    expect(useStore.getState().settings?.pythonPath).toBe(original.pythonPath)
    expect(useStore.getState().notifications).toEqual([])
  })

  it('keeps Build and Agent text fields separate when changing categories', async () => {
    await click('Build')
    await type(control('Default C++ compiler'), 'clang++')
    await act(async () => { invoke(control('Default C++ compiler'), 'onBlur', {}) })
    await click('Cortex Agent')
    expect(control('Model').props.value).toBe(original.ai.model)
    await type(control('Model'), 'owned-model')
    await act(async () => { invoke(control('Model'), 'onBlur', {}) })
    await click('Build')
    expect(control('Default C++ compiler').props.value).toBe('clang++')
    expect(useStore.getState().settings?.ai.model).toBe('owned-model')
    expect(useStore.getState().settings?.pythonPath).toBe(original.pythonPath)
    expect(api.setSettings).toHaveBeenCalledTimes(2)
  })

  it('retains a rejected key draft and clears it only after a successful redacted retry', async () => {
    await click('Cortex Agent')
    await type(control('API key'), 'owned-fake-key')
    api.setSettings.mockRejectedValueOnce(failure)
    await click('Save')
    expect(control('API key').props.value).toBe('owned-fake-key')
    expect(host.nodes().some((node) => node.type === '#text' && node.props.text === 'Key saved.')).toBe(false)
    expect(useStore.getState().settings?.ai.apiKeySet).toBe(false)
    expectFailure()
    expect(JSON.stringify(useStore.getState().notifications)).not.toContain('owned-fake-key')
    await click('Save')
    expect(control('API key').props.value).toBe('')
    expect(useStore.getState().settings?.ai).toMatchObject({ apiKey: '', apiKeySet: true })
    expect(host.nodes().some((node) => node.type === '#text' && node.props.text === 'Key saved.')).toBe(true)
    expectFailure()
  })

  it('does not clear newer key typing when an earlier save finishes', async () => {
    await click('Cortex Agent')
    await type(control('API key'), 'owned-first-key')
    const writing = deferred<AppSettings>()
    api.setSettings.mockReturnValueOnce(writing.promise)
    await click('Save')
    await type(control('API key'), 'owned-newer-key')
    await act(async () => { writing.resolve({ ...original, ai: { ...original.ai, apiKeySet: true } }) })
    expect(control('API key').props.value).toBe('owned-newer-key')
    expect(host.nodes().some((node) => node.type === '#text' && node.props.text === 'Key saved.')).toBe(false)
    expect(useStore.getState().notifications).toEqual([])
  })

  it('keeps a failed board URL draft and existing list for retry', async () => {
    await click('Board Manager')
    const url = 'https://example.test/new.json'
    await type(urlInput(), url)
    api.setSettings.mockRejectedValueOnce(failure)
    await click('Add')
    expect(urlInput().props.value).toBe(url)
    expect(useStore.getState().settings?.boards.additionalUrls).toEqual(original.boards.additionalUrls)
    expectFailure()
    await click('Add')
    expect(urlInput().props.value).toBe('')
    expect(useStore.getState().settings?.boards.additionalUrls).toEqual([...original.boards.additionalUrls, url])
    expectFailure()
  })

  it('does not clear a newer board URL draft when an earlier addition finishes', async () => {
    await click('Board Manager')
    const url = 'https://example.test/first.json'
    await type(urlInput(), url)
    const writing = deferred<AppSettings>()
    api.setSettings.mockReturnValueOnce(writing.promise)
    await click('Add')
    await type(urlInput(), 'https://example.test/newer.json')
    await act(async () => { writing.resolve({ ...original, boards: { additionalUrls: [...original.boards.additionalUrls, url] } }) })
    expect(urlInput().props.value).toBe('https://example.test/newer.json')
    expect(useStore.getState().notifications).toEqual([])
  })

  it('keeps a rejected board URL removal in the list and allows retry', async () => {
    await click('Board Manager')
    const remove = (): HostNode => host.nodes().find((node) => node.type === 'button' && node.props.title === 'Remove')!
    api.setSettings.mockRejectedValueOnce(failure)
    await act(async () => { invoke(remove(), 'onClick', {}) })
    expect(useStore.getState().settings?.boards.additionalUrls).toEqual(original.boards.additionalUrls)
    expectFailure()
    await act(async () => { invoke(remove(), 'onClick', {}) })
    expect(useStore.getState().settings?.boards.additionalUrls).toEqual([])
    expectFailure()
  })

  it.each([false, true])('reports unsaved baud preferences while preserving live serial behavior (open: %s)', async (serialOpen) => {
    useStore.setState({ serialOpen, serialPath: 'owned-fixture-port' })
    await click('Serial')
    api.setSettings.mockRejectedValueOnce(failure)
    await type(control('Baud rate', 'select'), '9600')
    expect(useStore.getState().serialBaud).toBe(9600)
    expect(useStore.getState().settings?.serial.baudRate).toBe(115200)
    expectFailure()
    if (serialOpen) {
      expect(api.serialClose).toHaveBeenCalledOnce()
      expect(api.serialOpen).toHaveBeenCalledExactlyOnceWith({ path: 'owned-fixture-port', baudRate: 9600 })
      expect(useStore.getState().serialOpen).toBe(true)
    } else {
      expect(api.serialClose).not.toHaveBeenCalled()
      expect(api.serialOpen).not.toHaveBeenCalled()
    }
  })
})
