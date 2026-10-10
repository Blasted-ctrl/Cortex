/**
 * Board-manager index URLs (the "Additional Boards Manager URLs" of the Arduino
 * IDE) and the arduino-cli arguments built from them. Kept pure and free of any
 * Electron/Node dependency so it is unit-tested and shared between the settings
 * service and the package service.
 */

/** The vendor index URLs an embedded IDE should know about out of the box. */
export const DEFAULT_BOARD_URLS = [
  'https://espressif.github.io/arduino-esp32/package_esp32_index.json',
  'https://arduino.esp8266.com/stable/package_esp8266com_index.json',
  'https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json'
]

/** A well-formed http(s) URL, so a garbage entry cannot break arduino-cli. */
export function isValidIndexUrl(u: string): boolean {
  // Reject commas and whitespace up front. A comma is arduino-cli's own
  // --additional-urls separator, so a comma inside one entry (legal in a URL
  // path) would let a second index URL of ANY scheme ride past this http/https
  // check when the entries are joined into one argument. A real single index
  // URL contains neither, so this closes the smuggling hole without cost.
  if (/[,\s]/.test(u)) return false
  try {
    const p = new URL(u)
    return p.protocol === 'http:' || p.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The `--additional-urls` args for a core command. All URLs are joined into ONE
 * argument (comma separated, arduino-cli's own format), so even a hostile entry
 * can never be read by the CLI as a separate flag. Empty when nothing valid is
 * configured, so the flag is omitted entirely.
 */
export function buildAdditionalUrlArgs(urls: string[]): string[] {
  const valid = urls.filter(isValidIndexUrl)
  return valid.length ? ['--additional-urls', valid.join(',')] : []
}
