import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { safeCommand } from '../services/commandResolver'

export interface ProcessResult {
  code: number | null
  stdout: string
  stderr: string
  wallMs: number
  error?: string
}

export function runProcess(command: string, args: string[], options: {
  cwd: string
  timeoutMs: number
  maxBytes?: number
  onStdout?: (chunk: string) => void
}): Promise<ProcessResult> {
  return new Promise(resolve => {
    const started = performance.now()
    const child = spawn(command, args, { cwd: options.cwd, windowsHide: true, detached: process.platform !== 'win32' })
    child.stdin.on('error', () => {})
    child.stdin.end()
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let error: string | undefined
    let terminationTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(terminationTimer)
      resolve({ code, stdout, stderr, wallMs: performance.now() - started, ...(error ? { error } : {}) })
    }
    const kill = (): void => {
      if (process.platform === 'win32' && child.pid) {
        const taskkill = safeCommand('taskkill')
        if (taskkill) {
          const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          killer.unref()
          const fallback = setTimeout(() => child.kill('SIGKILL'), 1000)
          child.once('close', () => clearTimeout(fallback))
          killer.on('error', () => child.kill('SIGKILL'))
          killer.on('close', code => { if (code !== 0) child.kill('SIGKILL') })
        } else child.kill('SIGKILL')
      } else if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      }
    }
    const abort = (message: string): void => {
      if (error) return
      error = message
      kill()
      terminationTimer = setTimeout(() => {
        error += '; process termination was not confirmed within 2000ms'
        child.kill('SIGKILL')
        child.stdout.destroy()
        child.stderr.destroy()
        child.stdin.destroy()
        child.unref()
        finish(null)
      }, 2000)
    }
    const timer = setTimeout(() => abort(`Wall-clock timeout after ${options.timeoutMs}ms`), options.timeoutMs)
    const capture = (chunk: string, stream: 'stdout' | 'stderr'): void => {
      if (error) return
      bytes += Buffer.byteLength(chunk)
      if (bytes > (options.maxBytes ?? 4_000_000)) { abort(`Process output exceeded the ${options.maxBytes ?? 4_000_000}-byte capture limit`); return }
      if (stream === 'stdout') {
        stdout += chunk
        try { options.onStdout?.(chunk) } catch (e) { abort(e instanceof Error ? e.message : String(e)) }
      } else stderr += chunk
    }
    child.stdout.on('data', chunk => capture(chunk, 'stdout'))
    child.stderr.on('data', chunk => capture(chunk, 'stderr'))
    child.on('error', e => { error = `Cannot launch ${command}: ${e.message}` })
    child.on('close', finish)
  })
}
