/**
 * The one canonical list of serial baud rates, shared by the serial monitor's
 * dropdown and the Settings baud control so the two can never drift (a rate
 * present in only one would blank the other's select). Includes the ESP32
 * bootloader's 74880 and the high rates real firmware logs at.
 */
export const BAUD_RATES = [
  9600, 19200, 38400, 57600, 74880, 115200, 230400, 250000, 460800, 500000, 921600
]

/**
 * True for a plain serial device name: COM3 on Windows, /dev/ttyUSB0, /dev/cu.usbserial-1410
 * and similar elsewhere. Used before a name is handed to a flashing tool as an argument,
 * so it can never be an option (a leading dash), a path elsewhere, or contain whitespace.
 */
export function isSerialPortName(name: string): boolean {
  return /^COM\d{1,3}$/i.test(name) || /^\/dev\/(?:tty|cu)[A-Za-z0-9._-]*$/.test(name)
}

interface PortLike {
  path: string
  vendorId?: string
}

/**
 * The port to select when the user has not chosen one. A real USB serial adapter (it has a
 * USB vendor id) beats a Bluetooth or built-in port: on Windows the first listed port is
 * often a Bluetooth link, which is never the board.
 */
export function pickDefaultPort(ports: readonly PortLike[]): string | undefined {
  return (ports.find((p) => !!p.vendorId) ?? ports[0])?.path
}

/**
 * The port a firmware upload may use, or undefined when the choice is ambiguous. An explicit
 * selection always wins. Otherwise only a single USB serial device is accepted: with two
 * boards plugged in, guessing could flash the wrong one.
 */
export function choosePlatformioUploadPort(selected: string, ports: readonly PortLike[]): string | undefined {
  if (selected) return isSerialPortName(selected) ? selected : undefined
  const usb = ports.filter((p) => !!p.vendorId && isSerialPortName(p.path))
  return usb.length === 1 ? usb[0].path : undefined
}
