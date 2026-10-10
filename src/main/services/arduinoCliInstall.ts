import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import { ARDUINO_CLI_VERSION, arduinoCliArtifact, type ArduinoCliArtifact } from '../../shared/arduinoCliRelease'

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 128 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 120_000
const ASSET_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
const OWNED_FILES = ['LICENSE.txt', 'NOTICE.txt', 'receipt.json']

function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assetUrl(raw: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || !ASSET_HOSTS.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Board tools download redirected to an untrusted location.')
  }
  return url
}

async function download(artifact: ArduinoCliArtifact): Promise<Buffer> {
  if (artifact.size <= 0 || artifact.size > MAX_ARCHIVE_BYTES) throw new Error('Board tools archive exceeds the download limit.')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    let url = assetUrl(artifact.url)
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'Cortex-board-tools' } })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location || redirects === 5) throw new Error('Board tools download exceeded its redirect limit.')
        url = assetUrl(new URL(location, url).href)
        continue
      }
      if (!response.ok || !response.body) throw new Error(`Board tools download failed (HTTP ${response.status}).`)
      const contentLength = response.headers.get('content-length')
      if (contentLength !== null && Number(contentLength) !== artifact.size) {
        await response.body.cancel()
        throw new Error('Board tools download has an unexpected size.')
      }
      const reader = response.body.getReader()
      const chunks: Buffer[] = []
      let size = 0
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > artifact.size || size > MAX_ARCHIVE_BYTES) {
          await reader.cancel()
          throw new Error('Board tools download exceeded its size limit.')
        }
        chunks.push(Buffer.from(chunk.value))
      }
      const bytes = Buffer.concat(chunks, size)
      if (size !== artifact.size) throw new Error('Board tools download was incomplete.')
      if (hash(bytes) !== artifact.sha256) throw new Error('Board tools checksum verification failed. Retry the download.')
      return bytes
    }
    throw new Error('Board tools download exceeded its redirect limit.')
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Board tools download timed out. Check your connection and retry.')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function extractZip(bytes: Buffer, names: Set<string>): Map<string, Buffer> {
  let end = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) {
      end = offset
      break
    }
  }
  if (end < 0) throw new Error('Invalid board tools ZIP archive.')
  const count = bytes.readUInt16LE(end + 10)
  const centralSize = bytes.readUInt32LE(end + 12)
  let offset = bytes.readUInt32LE(end + 16)
  const centralEnd = offset + centralSize
  if (bytes.readUInt32LE(end + 4) !== 0 || bytes.readUInt16LE(end + 8) !== count || count > 128 || centralEnd !== end) {
    throw new Error('Unsupported board tools ZIP archive.')
  }
  const files = new Map<string, Buffer>()
  let extractedBytes = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > centralEnd || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid board tools ZIP directory.')
    const flags = bytes.readUInt16LE(offset + 8)
    const method = bytes.readUInt16LE(offset + 10)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const size = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const localOffset = bytes.readUInt32LE(offset + 42)
    const next = offset + 46 + nameLength + extraLength + commentLength
    if (next > centralEnd) throw new Error('Invalid board tools ZIP entry.')
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength)
    if (names.has(name)) {
      const mode = bytes.readUInt32LE(offset + 38) >>> 16
      if ((mode & 0xf000) === 0xa000 || (mode & 0xf000) === 0x4000 || (flags & 1) || ![0, 8].includes(method) || files.has(name)) {
        throw new Error('Unsupported board tools ZIP file.')
      }
      extractedBytes += size
      if (size === 0 || extractedBytes > MAX_EXTRACTED_BYTES || localOffset + 30 > offset || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error('Board tools ZIP file exceeds extraction bounds.')
      }
      const localNameLength = bytes.readUInt16LE(localOffset + 26)
      const start = localOffset + 30 + localNameLength + bytes.readUInt16LE(localOffset + 28)
      const localName = bytes.toString('utf8', localOffset + 30, localOffset + 30 + localNameLength)
      if (localName !== name || bytes.readUInt16LE(localOffset + 6) !== flags || bytes.readUInt16LE(localOffset + 8) !== method || start + compressedSize > bytes.readUInt32LE(end + 16)) {
        throw new Error('Invalid board tools ZIP file bounds.')
      }
      const compressed = bytes.subarray(start, start + compressedSize)
      const file = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.min(size, MAX_EXTRACTED_BYTES) })
      if (file.length !== size) throw new Error('Board tools ZIP file has an unexpected size.')
      files.set(name, file)
    }
    offset = next
  }
  if (offset !== centralEnd) throw new Error('Invalid board tools ZIP directory size.')
  return files
}

function tarString(bytes: Buffer, start: number, size: number): string {
  return bytes.toString('utf8', start, start + size).split('\0', 1)[0]
}

function tarNumber(bytes: Buffer, start: number, size: number): number {
  const value = tarString(bytes, start, size).trim()
  if (!/^[0-7]+$/.test(value)) throw new Error('Invalid board tools TAR size.')
  return parseInt(value, 8)
}

function extractTar(bytes: Buffer, names: Set<string>): Map<string, Buffer> {
  const tar = gunzipSync(bytes, { maxOutputLength: MAX_EXTRACTED_BYTES })
  const files = new Map<string, Buffer>()
  let offset = 0
  let count = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) return files
    if (++count > 128) throw new Error('Board tools TAR archive has too many entries.')
    let checksum = 0
    for (let index = 0; index < 512; index++) checksum += index >= 148 && index < 156 ? 32 : header[index]
    if (checksum !== tarNumber(header, 148, 8)) throw new Error('Invalid board tools TAR header.')
    const baseName = tarString(header, 0, 100)
    const prefix = tarString(header, 345, 155)
    const name = prefix ? `${prefix}/${baseName}` : baseName
    const size = tarNumber(header, 124, 12)
    const start = offset + 512
    if (size > MAX_EXTRACTED_BYTES || start + size > tar.length) throw new Error('Board tools TAR file exceeds extraction bounds.')
    if (names.has(name)) {
      if (![0, 48].includes(header[156]) || files.has(name) || size === 0) throw new Error('Unsupported board tools TAR file.')
      files.set(name, Buffer.from(tar.subarray(start, start + size)))
    }
    offset = start + Math.ceil(size / 512) * 512
  }
  throw new Error('Incomplete board tools TAR archive.')
}

async function assertDestination(target: string, binaryName: string): Promise<void> {
  try {
    const stat = await fs.lstat(target)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Board tools destination is not a regular directory.')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  let owned = false
  try {
    const stat = await fs.lstat(join(target, 'receipt.json'))
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 4096) {
      const receipt = JSON.parse(await fs.readFile(join(target, 'receipt.json'), 'utf8'))
      owned = receipt.version === ARDUINO_CLI_VERSION && receipt.binaryName === binaryName && receipt.owner === 'Cortex'
    }
  } catch { /* A missing or invalid receipt does not authorize overwriting files. */ }
  for (const name of [binaryName, ...OWNED_FILES]) {
    try {
      const stat = await fs.lstat(join(target, name))
      if (!owned || !stat.isFile() || stat.isSymbolicLink()) throw new Error('Board tools destination contains files Cortex does not own.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

export async function installArduinoCli(
  targetDir: string,
  platform: string = process.platform,
  arch: string = process.arch,
  onProgress?: (message: string) => void
): Promise<void> {
  if (!isAbsolute(targetDir) || dirname(resolve(targetDir)) === resolve(targetDir)) throw new Error('Board tools require an app-owned directory.')
  const artifact = arduinoCliArtifact(platform, arch)
  const target = resolve(targetDir)
  await assertDestination(target, artifact.binaryName)
  onProgress?.(`Downloading board tools ${ARDUINO_CLI_VERSION}...`)
  const archive = await download(artifact)
  onProgress?.('Verifying and unpacking board tools...')
  const names = new Set([artifact.binaryName, 'LICENSE.txt'])
  const files = artifact.archiveName.endsWith('.zip') ? extractZip(archive, names) : extractTar(archive, names)
  if (!files.has(artifact.binaryName) || !files.has('LICENSE.txt')) throw new Error('Board tools archive is missing its executable or license.')
  const receipt = {
    owner: 'Cortex', version: ARDUINO_CLI_VERSION, platform, arch, binaryName: artifact.binaryName,
    archiveName: artifact.archiveName, archiveSha256: artifact.sha256,
    binarySha256: hash(files.get(artifact.binaryName)!), sourceUrl: artifact.url
  }
  files.set('receipt.json', Buffer.from(JSON.stringify(receipt, null, 2) + '\n'))
  files.set('NOTICE.txt', Buffer.from([
    `Arduino CLI ${ARDUINO_CLI_VERSION}, an unchanged official Arduino binary.`,
    'Licensed under GNU General Public License version 3. See LICENSE.txt.',
    `Corresponding source: https://github.com/arduino/arduino-cli/tree/v${ARDUINO_CLI_VERSION}`,
    `Official release: https://github.com/arduino/arduino-cli/releases/tag/v${ARDUINO_CLI_VERSION}`,
    `Archive SHA256: ${artifact.sha256}`, ''
  ].join('\n')))
  await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const parent = await fs.realpath(dirname(target))
  const stage = await fs.mkdtemp(join(parent, '.cortex-arduino-cli-'))
  const owner = randomUUID()
  const marker = join(stage, '.owner')
  await fs.writeFile(marker, owner, { mode: 0o600, flag: 'wx' })
  let publishedDirectory = false
  try {
    for (const [name, bytes] of files) await fs.writeFile(join(stage, name), bytes, { mode: name === artifact.binaryName ? 0o755 : 0o644, flag: 'wx' })
    await assertDestination(target, artifact.binaryName)
    const existing = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (!existing) {
      await fs.rename(stage, target)
      publishedDirectory = true
      await fs.unlink(join(target, '.owner'))
    } else {
      if (await fs.realpath(target) !== join(parent, basename(target))) throw new Error('Board tools destination changed during setup.')
      // Repairs replace only known files, publishing the receipt last.
      for (const name of [artifact.binaryName, 'LICENSE.txt', 'NOTICE.txt', 'receipt.json']) await fs.rename(join(stage, name), join(target, name))
    }
    onProgress?.('Board tools installed.')
  } finally {
    if (!publishedDirectory) {
      const realStage = await fs.realpath(stage)
      if (dirname(realStage) !== parent || !basename(realStage).startsWith('.cortex-arduino-cli-') || await fs.readFile(marker, 'utf8') !== owner) {
        throw new Error('Refusing to clean up an unowned board tools directory.')
      }
      await fs.rm(realStage, { recursive: true, force: true })
    }
  }
}
