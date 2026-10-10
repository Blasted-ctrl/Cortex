import { open, readdir, stat } from 'node:fs/promises'
import { isUtf8 } from 'node:buffer'
import { join, resolve } from 'node:path'
import type { FirmwareScenario } from '../../shared/firmwareTest'
import { validateScenario } from './scenario'

export interface ReplayEntry { path: string; scenario?: FirmwareScenario; firmware?: string; sourceSha256?: string }

export async function readBoundedJson(path: string, maxBytes: number, label: string): Promise<unknown> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile()) throw new Error(`${label} must be a regular file`)
    if (info.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes / 1024 / 1024} MiB`)
    const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1))
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (!chunk.bytesRead) break
      bytesRead += chunk.bytesRead
    }
    if (bytesRead > maxBytes || bytesRead > info.size) throw new Error(`${label} grew while reading; retry`)
    if (!isUtf8(buffer.subarray(0, bytesRead))) throw new Error(`${label} must use valid UTF-8`)
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
  } finally { await file.close() }
}

export async function scenarioPaths(path: string): Promise<string[]> {
  const target = resolve(path)
  if (!(await stat(target)).isDirectory()) return [target]
  const files = (await readdir(target)).filter(name => name.endsWith('.json')).sort().map(name => join(target, name))
  if (!files.length) throw new Error(`No JSON scenarios in ${target}`)
  return files
}

export async function replayEntries(path: string): Promise<ReplayEntry[]> {
  const value = await readBoundedJson(resolve(path), 32 * 1024 * 1024, 'Replay report')
  if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 ||
      !('results' in value) || !Array.isArray(value.results) || !value.results.length || value.results.length > 5000) {
    throw new Error('Replay requires a version 1 Cortex suite report with 1..5000 results')
  }
  const seen = new Set<string>()
  const entries: ReplayEntry[] = []
  for (const result of value.results) {
    if (!result || typeof result !== 'object' || !('scenario' in result) || typeof result.scenarioPath !== 'string' || result.scenarioPath.length > 4096) {
      throw new Error('Replay report is missing a scenario configuration; correct the runner error and rerun the original scenario')
    }
    const scenario = validateScenario(result.scenario)
    const firmware = result.firmwarePath ?? result.build?.sourcePath
    const sourceSha256 = result.build?.sourceSha256
    if (firmware !== undefined && (typeof firmware !== 'string' || !firmware || firmware.length > 4096)) throw new Error('Replay has an invalid firmware path')
    if (sourceSha256 !== undefined && (typeof sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceSha256))) throw new Error('Replay has an invalid source fingerprint')
    const identity = JSON.stringify({ path: result.scenarioPath, scenario, firmware })
    if (seen.has(identity)) continue
    seen.add(identity)
    entries.push({ path: result.scenarioPath, scenario, firmware, sourceSha256 })
  }
  return entries
}
