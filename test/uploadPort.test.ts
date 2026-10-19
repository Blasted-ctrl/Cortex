import { describe, it, expect } from 'vitest'
import { choosePlatformioUploadPort, isSerialPortName, pickDefaultPort } from '../src/shared/serial'

// This is the shape of the machine this was written for: two Bluetooth links listed
// before the ESP32's USB-serial adapter.
const BT3 = { path: 'COM3' }
const BT4 = { path: 'COM4' }
const ESP = { path: 'COM5', vendorId: '10C4' }

describe('isSerialPortName', () => {
  it('accepts plain device names', () => {
    for (const ok of ['COM5', 'com12', '/dev/ttyUSB0', '/dev/ttyACM1', '/dev/cu.usbserial-1410', '/dev/cu.SLAB_USBtoUART']) {
      expect(isSerialPortName(ok), ok).toBe(true)
    }
  })
  it('refuses anything that could act as an option, a path or a second argument', () => {
    for (const bad of ['', '-t', '--upload-port', 'COM5 --erase', 'COM5;calc', 'C:/x/COM5', '/tmp/ttyUSB0', '/dev/sda', '../dev/ttyUSB0', 'COM1234', 'COM']) {
      expect(isSerialPortName(bad), bad).toBe(false)
    }
  })
})

describe('pickDefaultPort', () => {
  it('prefers a USB adapter over Bluetooth links listed first', () => {
    expect(pickDefaultPort([BT3, BT4, ESP])).toBe('COM5')
  })
  it('falls back to the first port when none has a vendor id', () => {
    expect(pickDefaultPort([BT3, BT4])).toBe('COM3')
  })
  it('returns undefined with no ports', () => {
    expect(pickDefaultPort([])).toBeUndefined()
  })
})

describe('choosePlatformioUploadPort', () => {
  it('uses an explicit selection, even a Bluetooth-looking one the user chose on purpose', () => {
    expect(choosePlatformioUploadPort('COM3', [BT3, ESP])).toBe('COM3')
  })
  it('rejects an explicit selection that is not a plain port name', () => {
    expect(choosePlatformioUploadPort('--erase', [ESP])).toBeUndefined()
  })
  it('picks the only USB serial device when nothing is selected', () => {
    expect(choosePlatformioUploadPort('', [BT3, BT4, ESP])).toBe('COM5')
  })
  it('refuses to guess between two boards', () => {
    expect(choosePlatformioUploadPort('', [ESP, { path: 'COM6', vendorId: '1A86' }])).toBeUndefined()
  })
  it('refuses when there is no USB device', () => {
    expect(choosePlatformioUploadPort('', [BT3, BT4])).toBeUndefined()
    expect(choosePlatformioUploadPort('', [])).toBeUndefined()
  })
})
