import { describe, it, expect } from 'vitest'
import { DEFAULT_BOARD_URLS, isValidIndexUrl, buildAdditionalUrlArgs } from '../src/shared/boardUrls'

describe('isValidIndexUrl', () => {
  it('accepts http and https URLs', () => {
    expect(isValidIndexUrl('https://espressif.github.io/arduino-esp32/package_esp32_index.json')).toBe(true)
    expect(isValidIndexUrl('http://example.com/index.json')).toBe(true)
  })
  it('rejects non-http protocols and junk', () => {
    expect(isValidIndexUrl('file:///etc/passwd')).toBe(false)
    expect(isValidIndexUrl('ftp://x/y')).toBe(false)
    expect(isValidIndexUrl('not a url')).toBe(false)
    expect(isValidIndexUrl('')).toBe(false)
    // A flag-shaped string is not a URL, so it can never leak through as an arg.
    expect(isValidIndexUrl('--some-flag')).toBe(false)
  })
  it('rejects a URL containing a comma, so a second index cannot be smuggled past the scheme check', () => {
    // A comma is legal in a URL path, so this parses as a valid https URL, but
    // arduino-cli would CSV-split --additional-urls and load the file:// half.
    expect(isValidIndexUrl('https://ok.com/i.json,file:///C:/evil_index.json')).toBe(false)
    expect(isValidIndexUrl('https://ok.com/a,b.json')).toBe(false)
    // Whitespace is likewise rejected.
    expect(isValidIndexUrl('https://ok.com/ index.json')).toBe(false)
  })
})

describe('buildAdditionalUrlArgs', () => {
  it('returns no flag when there are no valid URLs', () => {
    expect(buildAdditionalUrlArgs([])).toEqual([])
    expect(buildAdditionalUrlArgs(['nonsense', 'file:///x'])).toEqual([])
  })
  it('joins valid URLs into a single comma-separated argument', () => {
    const args = buildAdditionalUrlArgs(['https://a/x.json', 'https://b/y.json'])
    expect(args).toEqual(['--additional-urls', 'https://a/x.json,https://b/y.json'])
    // Exactly two argv tokens: the flag and one joined value, so a URL can never
    // be parsed by arduino-cli as its own flag.
    expect(args).toHaveLength(2)
  })
  it('drops invalid entries but keeps the valid ones', () => {
    expect(buildAdditionalUrlArgs(['https://a/x.json', 'junk', 'ftp://b'])).toEqual([
      '--additional-urls',
      'https://a/x.json'
    ])
  })
  it('the seeded ESP32/ESP8266/Pico defaults are all valid index URLs', () => {
    expect(DEFAULT_BOARD_URLS.every(isValidIndexUrl)).toBe(true)
    expect(DEFAULT_BOARD_URLS.some((u) => u.includes('esp32'))).toBe(true)
    expect(DEFAULT_BOARD_URLS.some((u) => u.includes('package_rp2040_index.json'))).toBe(true)
    expect(buildAdditionalUrlArgs(DEFAULT_BOARD_URLS)).toHaveLength(2)
  })
})
