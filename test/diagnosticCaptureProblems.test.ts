import { act, createElement } from 'react'
import * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { createHost, descendants, invoke, type HostNode } from './reactHost'
import { createCompilerDiagnostics } from '../src/main/services/compilerDiagnostics'
import type { Diagnostic } from '../src/shared/ipc'

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key)
})
const api = { readFile: vi.fn(), runStop: vi.fn() }
vi.stubGlobal('window', { api })
vi.stubGlobal('React', React)
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const { useStore } = await import('../src/renderer/src/store/useStore')
const { default: ProblemsPanel } = await import('../src/renderer/src/components/ProblemsPanel')
const initial = useStore.getState()
const root = 'D:/owned-diagnostic-view-fixture'
const record = 'main.cpp:3:7: error: missing value'
const problem: Diagnostic = {
  file: resolve(root, 'main.cpp'), line: 3, column: 7, severity: 'error', message: 'missing value'
}
const options = { cwd: root, format: 'text' as const, maxRecordBytes: 64, maxDiagnosticsBytes: 4096 }
let host: ReturnType<typeof createHost>

function text(nodes = host.nodes()): string {
  return nodes.filter(node => node.type === '#text').map(node => String(node.props.text)).join(' ')
}

function notice(): HostNode {
  const nodes = host.nodes().filter(node => node.props.role === 'status')
  expect(nodes).toHaveLength(1)
  return nodes[0]
}

beforeEach(async () => {
  storage.clear()
  api.readFile.mockReset().mockResolvedValue({ kind: 'text', content: 'int main() {}' })
  api.runStop.mockReset().mockResolvedValue(undefined)
  useStore.setState({ ...initial, workspaceRoot: root, runId: 'current-build', diagnostics: [], notifications: [] }, true)
  host = createHost()
  await host.render(createElement(ProblemsPanel))
})

afterEach(async () => { await host.render(null) })

describe('actual collector, store and mounted Problems view', () => {
  it('has no persistent notice and does not certify an empty list as a clean build', () => {
    expect(host.nodes().filter(node => node.props.role === 'status')).toEqual([])
    expect(text()).toContain('No located compiler diagnostics.')
    expect(text()).not.toContain('No problems detected')
    expect(host.nodes().filter(node => node.type === 'button')).toEqual([])
  })

  it('shows a complete successful warning without an omission notice', async () => {
    const capture = createCompilerDiagnostics(options)
    capture.write('main.cpp:2:5: warning: unused value [-Wunused-variable]\n')
    await act(async () => { useStore.getState().handleDiagnostics({ id: 'current-build', ...capture.finish() }) })

    expect(host.nodes().filter(node => node.props.role === 'status')).toEqual([])
    expect(text()).toContain('unused value')
    expect(text()).toContain('-Wunused-variable')
    const spans = host.nodes().filter(node => node.type === 'span')
    expect(spans.some(node => text(descendants(node)).replace(/\s/g, '') === '2:5')).toBe(true)
    expect(host.nodes().filter(node => node.type === 'button')).toHaveLength(1)
  })

  it.each([1, 2])('shows %s known omitted diagnostics even when none fit', async (count) => {
    const capture = createCompilerDiagnostics({ ...options, maxDiagnosticsBytes: 2 })
    capture.write((record + '\n').repeat(count))
    const result = capture.finish()
    expect(result).toEqual({ diagnostics: [], capture: { omittedDiagnostics: count, unparsedBytes: 0 } })
    await act(async () => { useStore.getState().handleDiagnostics({ id: 'current-build', ...result }) })

    const status = notice()
    expect(status.props['aria-live']).toBe('polite')
    expect(text(descendants(status))).toContain('Diagnostics incomplete.')
    expect(text(descendants(status))).toContain(`${count} additional diagnostic${count === 1 ? '' : 's'} omitted.`)
    expect(text(descendants(status))).not.toContain('unknown')
    expect(text()).toContain('No located compiler diagnostics.')
    expect(host.nodes().filter(node => node.type === 'button')).toEqual([])
  })

  it('distinguishes discarded bytes from a known number of omitted diagnostics', async () => {
    const capture = createCompilerDiagnostics(options)
    capture.write('x'.repeat(65) + '\n')
    const result = capture.finish()
    expect(result).toEqual({ diagnostics: [], capture: { omittedDiagnostics: 0, unparsedBytes: 65 } })
    await act(async () => { useStore.getState().handleDiagnostics({ id: 'current-build', ...result }) })

    const status = notice()
    expect(text(descendants(status))).toContain('65 bytes of compiler output skipped')
    expect(text(descendants(status))).toContain('additional diagnostic count unknown')
    expect(text(descendants(status))).not.toContain('65 additional diagnostics')
    expect(text()).not.toContain('No problems detected')
  })

  it('keeps retained problems navigable beside known and unknown omissions', async () => {
    const budget = Buffer.byteLength(JSON.stringify([problem]), 'utf8')
    const capture = createCompilerDiagnostics({ ...options, maxDiagnosticsBytes: budget })
    capture.write(record + '\n' + record + '\n' + 'x'.repeat(65) + '\n')
    const result = capture.finish()
    expect(result).toEqual({ diagnostics: [problem], capture: { omittedDiagnostics: 1, unparsedBytes: 65 } })
    await act(async () => { useStore.getState().handleDiagnostics({ id: 'current-build', ...result }) })

    const status = notice()
    expect(text(descendants(status))).toContain('1 additional diagnostic omitted.')
    expect(text(descendants(status))).toContain('additional diagnostic count unknown')
    const buttons = host.nodes().filter(node => node.type === 'button')
    expect(buttons).toHaveLength(1)
    expect(text(descendants(buttons[0]))).toContain('missing value')
    await act(async () => { invoke(buttons[0], 'onClick', {}) })

    expect(api.readFile).toHaveBeenCalledExactlyOnceWith(problem.file)
    expect(useStore.getState().reveal).toEqual({ path: problem.file, line: 3, column: 7 })
    expect(useStore.getState().tabs[0].path).toBe(problem.file)
    expect(useStore.getState().diagnostics).toEqual([problem])
  })

  it('keeps the notice when Console is cleared and the build is stopped', async () => {
    const capture = createCompilerDiagnostics(options)
    capture.write('x'.repeat(65) + '\n')
    await act(async () => {
      useStore.getState().handleDiagnostics({ id: 'current-build', ...capture.finish() })
      useStore.getState().clearOutput()
      await useStore.getState().stopRun()
    })

    expect(text(descendants(notice()))).toContain('additional diagnostic count unknown')
    expect(useStore.getState().diagnosticCapture).toEqual({ omittedDiagnostics: 0, unparsedBytes: 65 })
  })

  it('removes the old notice on a later complete empty result', async () => {
    const incomplete = createCompilerDiagnostics(options)
    incomplete.write('x'.repeat(65) + '\n')
    await act(async () => { useStore.getState().handleDiagnostics({ id: 'current-build', ...incomplete.finish() }) })
    notice()
    const complete = createCompilerDiagnostics(options)
    await act(async () => { useStore.getState().handleDiagnostics({ id: 'current-build', ...complete.finish() }) })

    expect(host.nodes().filter(node => node.props.role === 'status')).toEqual([])
    expect(text()).toContain('No located compiler diagnostics.')
    expect(useStore.getState().diagnosticCapture).toBe(null)
  })

  it('does not replace the mounted current result with a stale omission envelope', async () => {
    const complete = createCompilerDiagnostics(options)
    complete.write(record + '\n')
    await act(async () => { useStore.getState().handleDiagnostics({ id: 'current-build', ...complete.finish() }) })
    const stale = createCompilerDiagnostics(options)
    stale.write('x'.repeat(65) + '\n')
    await act(async () => { useStore.getState().handleDiagnostics({ id: 'old-build', ...stale.finish() }) })

    expect(host.nodes().filter(node => node.props.role === 'status')).toEqual([])
    expect(text()).toContain('missing value')
    expect(useStore.getState().diagnostics).toEqual([problem])
    expect(useStore.getState().diagnosticCapture).toBe(null)
  })
})
