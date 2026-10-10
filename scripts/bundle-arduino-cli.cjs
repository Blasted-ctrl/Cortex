const path = require('node:path')
const { installArduinoCli } = require('../out/tools/main/services/arduinoCliInstall.js')

exports.default = async function bundleArduinoCli(context) {
  const platform = context.electronPlatformName
  const architectures = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']
  const arch = architectures[context.arch]
  if (!arch || arch === 'universal') throw new Error('Bundle board tools separately for each supported CPU architecture.')
  const resources = platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  await installArduinoCli(path.join(resources, 'arduino-cli'), platform, arch === 'armv7l' ? 'arm' : arch, message => console.log(message))
}
