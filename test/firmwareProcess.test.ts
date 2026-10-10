import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { runProcess } from '../src/main/firmwareTesting/process'

describe('independent firmware process guard', () => {
  it('does not launch a process when its request was already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runProcess('cortex-must-not-launch', [], {
      cwd: tmpdir(), timeoutMs: 5000, signal: controller.signal
    })
    expect(result).toMatchObject({ code: null, stdout: '', stderr: '', error: 'Firmware test cancelled' })
  })

  it('stops live firmware on cancellation and retains its earlier output', async () => {
    const controller = new AbortController()
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000)'], {
      cwd: tmpdir(), timeoutMs: 10000, signal: controller.signal,
      onStdout: () => controller.abort()
    })
    expect(result).toMatchObject({ stdout: 'ready', error: 'Firmware test cancelled' })
    expect(result.code).not.toBe(0)
    expect(result.wallMs).toBeLessThan(5000)
  })

  it('removes the cancellation listener when a process finishes normally', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("done")'], {
      cwd: tmpdir(), timeoutMs: 5000, signal: controller.signal
    })
    expect(result).toMatchObject({ code: 0, stdout: 'done' })
    expect(result.error).toBeUndefined()
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort()
  })

  it('captures UTF-8 stdout/stderr and reports the real exit code', async () => {
    const chunks: string[] = []
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("ready"); process.stderr.write("diagnostic"); process.exitCode = 7'], {
      cwd: tmpdir(), timeoutMs: 5000, onStdout: chunk => { chunks.push(chunk) }
    })
    expect(result).toMatchObject({ code: 7, stdout: 'ready', stderr: 'diagnostic' })
    expect(result.error).toBeUndefined()
    expect(chunks.join('')).toBe('ready')
  })

  it('terminates a process that makes no progress without relying on virtual time', async () => {
    const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: tmpdir(), timeoutMs: 500 })
    expect(result.error).toContain('Wall-clock timeout after 500ms')
    expect(result.wallMs).toBeLessThan(5000)
    expect(result.code).not.toBe(0)
  })

  it('stops a runaway output stream at the capture bound', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000)); setInterval(() => {}, 1000)'], {
      cwd: tmpdir(), timeoutMs: 5000, maxBytes: 1000
    })
    expect(result.error).toContain('capture limit')
    expect(result.stdout.length).toBeLessThanOrEqual(1000)
  })

  it('terminates and reports a protocol parser error instead of continuing the firmware', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("invalid\\n"); setInterval(() => {}, 1000)'], {
      cwd: tmpdir(), timeoutMs: 5000, onStdout: () => { throw new Error('Malformed simulation output') }
    })
    expect(result.error).toBe('Malformed simulation output')
    expect(result.stdout).toBe('invalid\n')
  })
})
