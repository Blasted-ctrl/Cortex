/** Portable official binaries. Update version, sizes and hashes together. */
export const ARDUINO_CLI_VERSION = '1.5.1'

export interface ArduinoCliArtifact {
  archiveName: string
  binaryName: string
  sha256: string
  size: number
  url: string
}

const releases: Record<string, [string, number, string]> = {
  'win32-x64': ['Windows_64bit.zip', 17965819, 'fabe42e0eb04d00e776a66178299ff95a46c623dbc260f997e58fd514853dd40'],
  'win32-ia32': ['Windows_32bit.zip', 17468455, '885e491c7c7fb8b396151c09daa5c4c56d8b60697d172a5cfe72c939eed50fe3'],
  'linux-x64': ['Linux_64bit.tar.gz', 17630765, '28a8e119c498a25607821c36cb2dc49e8463941b261a0d99091baa7bc692dd2b'],
  'linux-arm64': ['Linux_ARM64.tar.gz', 16155457, '1e69e077479f300614d4551334e0a33f08ee40b04315d83b8e7e0e94f0d0ee62'],
  'linux-ia32': ['Linux_32bit.tar.gz', 17006509, '85ed48978e7553b16f187971f8202d380421b352696ab28327a36cc6d8f11c6a'],
  'linux-arm': ['Linux_ARMv7.tar.gz', 16434757, '890af36e9873606e4dfa743534846186621b9f3a339175ea3ec481adecf07143'],
  'darwin-x64': ['macOS_64bit.tar.gz', 19355892, 'c982e940027996bea9901050e95fae99c59c1dcfee54beedecaf28141e7bf2e7'],
  'darwin-arm64': ['macOS_ARM64.tar.gz', 17370016, 'cb952e8c1621c95ef5f1d17831c945e3d0ec5973f89c557a7ec8feb9c4f7d4c9']
}

export function arduinoCliArtifact(platform: string, arch: string): ArduinoCliArtifact {
  const release = releases[`${platform}-${arch}`]
  if (!release) throw new Error(`Board tools are not supported on ${platform}/${arch}.`)
  const [suffix, size, sha256] = release
  const archiveName = `arduino-cli_${ARDUINO_CLI_VERSION}_${suffix}`
  return {
    archiveName, size, sha256,
    binaryName: platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli',
    url: `https://github.com/arduino/arduino-cli/releases/download/v${ARDUINO_CLI_VERSION}/${archiveName}`
  }
}
