import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { deflateRawSync, gzipSync } from 'node:zlib'
import { installArduinoCli } from '../src/main/services/arduinoCliInstall'
import type { ArduinoCliArtifact } from '../src/shared/arduinoCliRelease'

const state = vi.hoisted(() => ({ artifact: undefined as ArduinoCliArtifact | undefined }))
vi.mock('../src/shared/arduinoCliRelease', () => ({
  ARDUINO_CLI_VERSION: '1.5.1',
  arduinoCliArtifact: () => {
    if (!state.artifact) throw new Error('Unsupported fixture platform')
    return state.artifact
  }
}))

interface Entry { name: string; bytes: Buffer; mode?: number; method?: number; type?: string }
const binary = Buffer.from('portable official executable fixture')
const license = Buffer.from('GNU GENERAL PUBLIC LICENSE\nVersion 3')

function zip(entries: Entry[]): Buffer {
  const locals: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const method = entry.method ?? 0
    const compressed = method === 8 ? deflateRawSync(entry.bytes) : entry.bytes
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.bytes.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, compressed)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.bytes.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((entry.mode ?? 0x81ed) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    directory.push(central, name)
    offset += local.length + name.length + compressed.length
  }
  const central = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(central.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, end])
}

function tar(entries: Entry[]): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    header.write(entry.name)
    header.write('0000755\0', 100)
    header.write(entry.bytes.length.toString(8).padStart(11, '0') + '\0', 124)
    header.fill(32, 148, 156)
    header.write(entry.type ?? '0', 156)
    header.write('ustar\0', 257)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148)
    const padded = Buffer.alloc(Math.ceil(entry.bytes.length / 512) * 512)
    entry.bytes.copy(padded)
    parts.push(header, padded)
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]))
}

function setArtifact(bytes: Buffer, archiveName = 'fixture.zip', binaryName = 'arduino-cli.exe'): void {
  state.artifact = {
    archiveName, binaryName, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    url: 'https://github.com/arduino/arduino-cli/releases/download/v1.5.1/fixture.zip'
  }
}

let directory: string
let target: string
let archive: Buffer
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), 'cortex-cli-install-'))
  target = join(directory, 'tools')
  archive = zip([{ name: 'arduino-cli.exe', bytes: binary }, { name: 'LICENSE.txt', bytes: license }])
  setArtifact(archive)
  fetchMock = vi.fn(async () => new Response(new Uint8Array(archive)))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await fs.rm(directory, { recursive: true, force: true })
})

describe('verified portable Arduino CLI installation', () => {
  it('publishes the exact executable, license and provenance after checking the archive', async () => {
    const progress: string[] = []
    await installArduinoCli(target, 'win32', 'x64', message => progress.push(message))
    expect(await fs.readFile(join(target, 'arduino-cli.exe'))).toEqual(binary)
    expect(await fs.readFile(join(target, 'LICENSE.txt'))).toEqual(license)
    expect(await fs.readFile(join(target, 'NOTICE.txt'), 'utf8')).toContain('https://github.com/arduino/arduino-cli/tree/v1.5.1')
    expect(JSON.parse(await fs.readFile(join(target, 'receipt.json'), 'utf8'))).toMatchObject({
      owner: 'Cortex', version: '1.5.1', platform: 'win32', arch: 'x64',
      archiveSha256: state.artifact!.sha256,
      binarySha256: createHash('sha256').update(binary).digest('hex')
    })
    expect(await fs.readdir(directory)).toEqual(['tools'])
    expect((await fs.readdir(target)).sort()).toEqual(['LICENSE.txt', 'NOTICE.txt', 'arduino-cli.exe', 'receipt.json'])
    expect(progress).toEqual(['Downloading board tools 1.5.1...', 'Verifying and unpacking board tools...', 'Board tools installed.'])
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' })
  })

  it('extracts a deflated ZIP executable', async () => {
    archive = zip([{ name: 'arduino-cli.exe', bytes: binary, method: 8 }, { name: 'LICENSE.txt', bytes: license, method: 8 }])
    setArtifact(archive)
    await installArduinoCli(target)
    expect(await fs.readFile(join(target, 'arduino-cli.exe'))).toEqual(binary)
  })

  it('extracts exact TAR files and sets Unix executable permission', async () => {
    archive = tar([{ name: 'arduino-cli', bytes: binary }, { name: 'LICENSE.txt', bytes: license }])
    setArtifact(archive, 'fixture.tar.gz', 'arduino-cli')
    await installArduinoCli(target, 'linux', 'arm64')
    expect(await fs.readFile(join(target, 'arduino-cli'))).toEqual(binary)
    if (process.platform !== 'win32') expect((await fs.stat(join(target, 'arduino-cli'))).mode & 0o777).toBe(0o755)
  })

  it('rejects a checksum mismatch before creating installed files', async () => {
    state.artifact!.sha256 = '0'.repeat(64)
    await expect(installArduinoCli(target)).rejects.toThrow('checksum verification failed')
    expect(await fs.readdir(directory)).toEqual([])
  })

  it('rejects an incorrect Content-Length', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(archive), { headers: { 'content-length': '1' } }))
    await expect(installArduinoCli(target)).rejects.toThrow('unexpected size')
  })

  it('rejects an incomplete streamed response', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(archive.subarray(0, -1))))
    await expect(installArduinoCli(target)).rejects.toThrow('incomplete')
  })

  it('cancels a stream larger than the pinned archive size', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(Buffer.concat([archive, Buffer.from('extra')]))))
    await expect(installArduinoCli(target)).rejects.toThrow('size limit')
  })

  it('refuses oversized archive metadata without making a network request', async () => {
    state.artifact!.size = 64 * 1024 * 1024 + 1
    await expect(installArduinoCli(target)).rejects.toThrow('download limit')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports an HTTP download error', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }))
    await expect(installArduinoCli(target)).rejects.toThrow('HTTP 503')
  })

  it('follows a bounded official HTTPS asset redirect', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/123/cli.zip' } }))
    await installArduinoCli(target)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(String(fetchMock.mock.calls[1][0])).toContain('https://release-assets.githubusercontent.com/')
  })

  it.each([
    'http://github.com/archive.zip', 'https://example.com/archive.zip',
    'https://github.com.evil.test/archive.zip', 'https://github.com:444/archive.zip',
    'https://user:password@github.com/archive.zip', 'https://127.0.0.1/archive.zip'
  ])('refuses an unsafe redirect: %s', async location => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location } }))
    await expect(installArduinoCli(target)).rejects.toThrow('untrusted location')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('limits redirect loops and does not request the seventh location', async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 302, headers: { location: 'https://github.com/loop' } }))
    await expect(installArduinoCli(target)).rejects.toThrow('redirect limit')
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it('aborts a hung download at its independent wall-clock deadline', async () => {
    vi.useFakeTimers()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      started()
    }))
    const operation = expect(installArduinoCli(target)).rejects.toThrow('timed out')
    await ready
    await vi.advanceTimersByTimeAsync(120_000)
    await operation
    expect(await fs.readdir(directory)).toEqual([])
  })

  it.each(['../escape.exe', '/escape.exe', 'nested/arduino-cli.exe', '..\\escape.exe'])('never writes an unrelated archive path: %s', async name => {
    archive = zip([{ name, bytes: Buffer.from('untrusted') }, { name: 'arduino-cli.exe', bytes: binary }, { name: 'LICENSE.txt', bytes: license }])
    setArtifact(archive)
    await installArduinoCli(target)
    expect((await fs.readdir(target)).sort()).toEqual(['LICENSE.txt', 'NOTICE.txt', 'arduino-cli.exe', 'receipt.json'])
    expect(await fs.readdir(directory)).toEqual(['tools'])
  })

  it.each([0xa1ff, 0x41ed])('rejects an executable ZIP symlink or directory (mode %s)', async mode => {
    archive = zip([{ name: 'arduino-cli.exe', bytes: binary, mode }, { name: 'LICENSE.txt', bytes: license }])
    setArtifact(archive)
    await expect(installArduinoCli(target)).rejects.toThrow('Unsupported board tools ZIP file')
  })

  it('rejects duplicate executable entries', async () => {
    archive = zip([{ name: 'arduino-cli.exe', bytes: binary }, { name: 'arduino-cli.exe', bytes: binary }, { name: 'LICENSE.txt', bytes: license }])
    setArtifact(archive)
    await expect(installArduinoCli(target)).rejects.toThrow('Unsupported board tools ZIP file')
  })

  it('rejects unsupported ZIP compression', async () => {
    archive = zip([{ name: 'arduino-cli.exe', bytes: binary, method: 99 }, { name: 'LICENSE.txt', bytes: license }])
    setArtifact(archive)
    await expect(installArduinoCli(target)).rejects.toThrow('Unsupported board tools ZIP file')
  })

  it('rejects ZIP content that declares excessive expanded bytes', async () => {
    const centralOffset = archive.readUInt32LE(archive.length - 6)
    archive.writeUInt32LE(128 * 1024 * 1024 + 1, centralOffset + 24)
    setArtifact(archive)
    await expect(installArduinoCli(target)).rejects.toThrow('extraction bounds')
  })

  it('rejects ZIP offsets outside the downloaded buffer', async () => {
    const centralOffset = archive.readUInt32LE(archive.length - 6)
    archive.writeUInt32LE(0xffffffff, centralOffset + 42)
    setArtifact(archive)
    await expect(installArduinoCli(target)).rejects.toThrow('extraction bounds')
  })

  it('rejects an archive missing its license', async () => {
    archive = zip([{ name: 'arduino-cli.exe', bytes: binary }])
    setArtifact(archive)
    await expect(installArduinoCli(target)).rejects.toThrow('missing its executable or license')
  })

  it.each(['1', '2', '5'])('rejects TAR executable links or directories (type %s)', async type => {
    archive = tar([{ name: 'arduino-cli', bytes: binary, type }, { name: 'LICENSE.txt', bytes: license }])
    setArtifact(archive, 'fixture.tar.gz', 'arduino-cli')
    await expect(installArduinoCli(target)).rejects.toThrow('Unsupported board tools TAR file')
  })

  it('does not overwrite an existing executable without a Cortex receipt', async () => {
    await fs.mkdir(target)
    await fs.writeFile(join(target, 'arduino-cli.exe'), 'existing user file')
    await expect(installArduinoCli(target)).rejects.toThrow('does not own')
    expect(await fs.readFile(join(target, 'arduino-cli.exe'), 'utf8')).toBe('existing user file')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a destination directory symlink', async () => {
    const outside = join(directory, 'outside')
    await fs.mkdir(outside)
    await fs.symlink(outside, target, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(installArduinoCli(target)).rejects.toThrow('not a regular directory')
    expect(await fs.readdir(outside)).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('repairs only owned files and preserves unrelated files', async () => {
    await installArduinoCli(target)
    await fs.writeFile(join(target, 'arduino-cli.exe'), 'corrupt cache')
    await fs.writeFile(join(target, 'keep.txt'), 'user data')
    await installArduinoCli(target)
    expect(await fs.readFile(join(target, 'arduino-cli.exe'))).toEqual(binary)
    expect(await fs.readFile(join(target, 'keep.txt'), 'utf8')).toBe('user data')
    expect(await fs.readdir(directory)).toEqual(['tools'])
  })

  it('cleans its own stage if publication fails, without removing the target', async () => {
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('Publication denied'), { code: 'EACCES' }))
    await expect(installArduinoCli(target)).rejects.toThrow('Publication denied')
    expect(await fs.readdir(directory)).toEqual([])
    rename.mockRestore()
    await installArduinoCli(target)
    expect(await fs.readFile(join(target, 'arduino-cli.exe'))).toEqual(binary)
  })

  it('allows retry after a rejected archive', async () => {
    state.artifact!.sha256 = '0'.repeat(64)
    await expect(installArduinoCli(target)).rejects.toThrow('checksum')
    setArtifact(archive)
    await installArduinoCli(target)
    expect(await fs.readFile(join(target, 'arduino-cli.exe'))).toEqual(binary)
  })

  it('rejects a relative or root destination before download', async () => {
    await expect(installArduinoCli('relative-tools')).rejects.toThrow('app-owned directory')
    await expect(installArduinoCli(process.platform === 'win32' ? 'C:\\' : '/')).rejects.toThrow('app-owned directory')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('pinned official Arduino CLI release metadata', () => {
  it('selects a pinned asset for each supported operating system and architecture', async () => {
    const release = await vi.importActual<typeof import('../src/shared/arduinoCliRelease')>('../src/shared/arduinoCliRelease')
    for (const [platform, arch] of [
      ['win32', 'x64'], ['win32', 'ia32'], ['darwin', 'x64'], ['darwin', 'arm64'],
      ['linux', 'x64'], ['linux', 'ia32'], ['linux', 'arm64'], ['linux', 'arm']
    ]) {
      const artifact = release.arduinoCliArtifact(platform, arch)
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(artifact.size).toBeGreaterThan(10_000_000)
      expect(artifact.size).toBeLessThan(64 * 1024 * 1024)
      expect(artifact.url).toBe(`https://github.com/arduino/arduino-cli/releases/download/v${release.ARDUINO_CLI_VERSION}/${artifact.archiveName}`)
      expect(artifact.binaryName).toBe(platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli')
    }
    expect(() => release.arduinoCliArtifact('win32', 'arm64')).toThrow('not supported')
    expect(() => release.arduinoCliArtifact('unknown', 'x64')).toThrow('not supported')
  })
})

describe('packaged board tools', () => {
  async function packagingHook(install: ReturnType<typeof vi.fn>): Promise<(context: unknown) => Promise<void>> {
    const source = await fs.readFile(join(__dirname, '../scripts/bundle-arduino-cli.cjs'), 'utf8')
    const exports: { default?: (context: unknown) => Promise<void> } = {}
    runInNewContext(source, {
      exports, console: { log: vi.fn() },
      require: (name: string) => {
        if (name === 'node:path') return { join }
        if (name === '../out/tools/main/services/arduinoCliInstall.js') return { installArduinoCli: install }
        throw new Error(`Unexpected packaging dependency: ${name}`)
      }
    })
    return exports.default!
  }

  it.each([
    ['win32', 1, 'x64', ['resources', 'arduino-cli']],
    ['linux', 3, 'arm64', ['resources', 'arduino-cli']],
    ['linux', 2, 'arm', ['resources', 'arduino-cli']],
    ['darwin', 3, 'arm64', ['Cortex.app', 'Contents', 'Resources', 'arduino-cli']]
  ] as const)('bundles %s architecture %s outside the ASAR', async (platform, arch, expectedArch, segments) => {
    const install = vi.fn(async () => {})
    const hook = await packagingHook(install)
    await hook({ electronPlatformName: platform, arch, appOutDir: directory, packager: { appInfo: { productFilename: 'Cortex' } } })
    expect(install).toHaveBeenCalledWith(join(directory, ...segments), platform, expectedArch, expect.any(Function))
  })

  it('fails packaging if the verified tool download fails', async () => {
    const hook = await packagingHook(vi.fn(async () => { throw new Error('checksum verification failed') }))
    await expect(hook({ electronPlatformName: 'win32', arch: 1, appOutDir: directory })).rejects.toThrow('checksum verification failed')
  })

  it('refuses a universal or unknown architecture rather than bundling the wrong executable', async () => {
    const install = vi.fn(async () => {})
    const hook = await packagingHook(install)
    for (const arch of [4, 99]) await expect(hook({ arch })).rejects.toThrow('separately')
    expect(install).not.toHaveBeenCalled()
  })
})
