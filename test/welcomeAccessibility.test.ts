import { act, createElement } from 'react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHost, invoke, type HostNode } from './reactHost'

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
vi.stubGlobal('window', { api: { githubAccounts: async () => [] } })
vi.stubGlobal('React', React)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const { useStore } = await import('../src/renderer/src/store/useStore')
const { default: Welcome } = await import('../src/renderer/src/components/Welcome')
const initial = useStore.getState()
const recent = { path: 'C:/owned-welcome-fixture/motor', name: 'motor', ts: 1 }
let host: ReturnType<typeof createHost>
const openWorkspace = vi.fn()

function button(label: string): HostNode {
  const node = host.nodes().find((node) => node.type === 'button' && node.props['aria-label'] === label)
  if (!node) throw new Error(`Button missing: ${label}`)
  return node
}

beforeEach(async () => {
  storage.clear()
  openWorkspace.mockReset().mockResolvedValue(undefined)
  useStore.setState({ ...initial, recents: [recent], openWorkspace, notifications: [], notifUnread: 0 }, true)
  host = createHost()
  await host.render(createElement(Welcome))
})
afterEach(async () => { await host.render(null) })

describe('actual Welcome recent-project controls', () => {
  it('offers native opening and removal buttons with distinct accessible paths', () => {
    const open = button(`Open ${recent.name}: ${recent.path}`)
    const remove = button(`Remove ${recent.name} from recent projects: ${recent.path}`)
    expect(open.props.tabIndex).not.toBe(-1)
    expect(open.props.className).toContain('focus-visible:')
    expect(remove.props.className).toContain('group-focus-within:opacity-100')
    expect(remove.props.className).toContain('focus-visible:')
    expect(open.parent).not.toBe(remove)
    expect(remove.parent).not.toBe(open)
  })

  it('opens the selected project from its native button', async () => {
    await act(async () => { invoke(button(`Open ${recent.name}: ${recent.path}`), 'onClick', {}) })
    expect(openWorkspace).toHaveBeenCalledExactlyOnceWith(recent.path)
    expect(useStore.getState().recents).toEqual([recent])
  })

  it('removes only that recent entry without opening it', async () => {
    const other = { ...recent, name: 'other', path: 'C:/owned-welcome-fixture/other' }
    await act(async () => { useStore.setState({ recents: [recent, other] }) })
    await act(async () => { invoke(button(`Remove ${recent.name} from recent projects: ${recent.path}`), 'onClick', {}) })
    expect(openWorkspace).not.toHaveBeenCalled()
    expect(useStore.getState().recents).toEqual([other])
    expect(storage.get('cortex.recents')).toBe(JSON.stringify([other]))
  })

  it('reports opening failure and preserves the entry for retry or removal', async () => {
    openWorkspace.mockRejectedValueOnce(new Error('Folder is unavailable'))
    await act(async () => { invoke(button(`Open ${recent.name}: ${recent.path}`), 'onClick', {}) })
    expect(openWorkspace).toHaveBeenCalledExactlyOnceWith(recent.path)
    expect(useStore.getState().recents).toEqual([recent])
    expect(useStore.getState().notifications).toEqual([expect.objectContaining({ kind: 'error', title: 'Could not open recent project', detail: expect.stringContaining('Folder is unavailable') })])
    await act(async () => { invoke(button(`Open ${recent.name}: ${recent.path}`), 'onClick', {}) })
    expect(openWorkspace).toHaveBeenCalledTimes(2)
  })
})
