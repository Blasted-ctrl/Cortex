// Cortex hardware-in-the-loop layer, part 1 of 2. The HIL harness
// (src/main/firmwareTesting/hil) generates a sketch that includes this header, then the
// unchanged firmware source, then cortex_hil_main.h. The firmware runs on the real MCU,
// with its real compiler, clock and serial port, against a scenario's input schedule,
// and every output is reported in the simulator's own trace protocol
// (src/shared/simProtocol.ts) so the host evaluates the same assertions on both.
//
// I/O model, matching the host shim in src/main/services/arduinoShim.ts: pins are the
// scenario's logical Uno numbers (A0..A5 = 14..19). Reads see the scheduled values on
// the ADC scale 0..1023 and digitalRead thresholds at 512. Writes are recorded, not
// driven, so a scenario can never toggle a pin wired to something else on this board
// (ESP32 GPIO 6..11, for example, carry its flash). Electrical I/O is checked separately
// by device/selftest. Time is micros() since the scenario started.
//
// Protocol on the board's Serial port, one line per message:
//   board -> host  @hil ready 1          repeated until a schedule arrives
//   host -> board  @hil schedule <durationMs> <count>, then <count> lines "<atUs> <pin> <value>"
//   board -> host  @hil scheduled <count>
//   host -> board  @hil go
//   board -> host  @hil started, then @time/@pin/@pwm/@mode/@tone/@serial events,
//                  then @done <us> and @hil done
//   host -> board  @hil reset            software reset before the next scenario
#pragma once
#include <Arduino.h>
#if defined(__AVR__)
#include <avr/wdt.h>
#endif

#ifndef CORTEX_HIL_BAUD
#define CORTEX_HIL_BAUD 115200
#endif
#define CORTEX_HIL_MAX_INPUTS 128

namespace cortex_hil {

// The board's real serial port, captured before Serial is redirected at the end of this file.
static inline decltype(Serial) &port() { return Serial; }

struct Input { uint32_t atUs; uint8_t pin; int16_t value; };
static Input inputs[CORTEX_HIL_MAX_INPUTS];
static uint16_t inputCount = 0;
static uint16_t nextInput = 0;
static int16_t slot[128];
static bool external[128];
static uint8_t modes[128];
static uint32_t startUs = 0;
static uint32_t durationUs = 0;
static bool finished = false;

static inline uint32_t realMicros() { return micros(); }
static inline uint32_t nowUs() { return realMicros() - startUs; }

static inline void stamp() {
  port().print("@time ");
  port().println(nowUs());
}

// Scheduled inputs take effect at their time, whenever the firmware next looks.
static inline void applyDue() {
  const uint32_t now = nowUs();
  while (nextInput < inputCount && inputs[nextInput].atUs <= now) {
    slot[inputs[nextInput].pin & 127] = inputs[nextInput].value;
    nextInput++;
  }
}

static inline int analogSlot(int p) {
#if defined(PIN_A0)
  if (p == PIN_A0) return 14;
#elif defined(ESP32)
  if (p == A0) return 14;
#endif
#if defined(PIN_A1)
  if (p == PIN_A1) return 15;
#endif
#if defined(PIN_A2)
  if (p == PIN_A2) return 16;
#endif
#if defined(PIN_A3)
  if (p == PIN_A3) return 17;
#endif
#if defined(PIN_A4)
  if (p == PIN_A4) return 18;
#endif
#if defined(PIN_A5)
  if (p == PIN_A5) return 19;
#endif
  return p >= 0 && p < 6 ? p + 14 : (p & 127);
}

static inline int hilDigitalRead(int p) {
  applyDue();
  return slot[p & 127] >= 512 ? HIGH : LOW;
}

static inline int hilAnalogRead(int p) {
  applyDue();
  return slot[analogSlot(p)];
}

static inline void hilPinMode(int p, int m) {
  // The trace uses AVR's numbering (INPUT 0, OUTPUT 1, INPUT_PULLUP 2) on every board.
  const uint8_t mode = m == OUTPUT ? 1 : m == INPUT_PULLUP ? 2 : m == INPUT ? 0 : (uint8_t)m;
  modes[p & 127] = mode;
  if (mode == 2 && !external[p & 127]) slot[p & 127] = 1023;
  stamp();
  port().print("@mode ");
  port().print(p);
  port().print(' ');
  port().println(mode);
}

static inline void ensureOutput(int p) {
  if (modes[p & 127] != 1) hilPinMode(p, OUTPUT);
}

static inline void hilDigitalWrite(int p, int v) {
  slot[p & 127] = v ? 1023 : 0;
  stamp();
  port().print("@pin ");
  port().print(p);
  port().print(' ');
  port().println(v ? 1 : 0);
}

static inline void hilAnalogWrite(int p, int v) {
  ensureOutput(p);
  stamp();
  port().print("@pwm ");
  port().print(p);
  port().print(' ');
  port().println(v < 0 ? 0 : v > 255 ? 255 : v);
}

static inline void hilTone(int p, unsigned int frequency) {
  ensureOutput(p);
  stamp();
  port().print("@tone ");
  port().print(p);
  port().print(' ');
  port().println(frequency);
}
static inline void hilTone(int p, unsigned int frequency, unsigned long) { hilTone(p, frequency); }
static inline void hilNoTone(int p) {
  stamp();
  port().print("@tone ");
  port().print(p);
  port().println(" 0");
}

static inline unsigned long hilMillis() { return nowUs() / 1000UL; }
static inline unsigned long hilMicros() { return nowUs(); }

// Serial.print from the firmware becomes @serial events, one per line.
class SerialProxy : public Print {
 public:
  template <typename... Args> void begin(Args...) {}
  void end() {}
  int available() { return 0; }
  int read() { return -1; }
  int peek() { return -1; }
  void flush() {}
  operator bool() { return true; }
  size_t write(uint8_t c) override {
    if (c == '\n') emitLine();
    else if (c != '\r' && length < sizeof(buffer) - 1) buffer[length++] = (char)c;
    return 1;
  }
  using Print::write;
  void flushResidue() { if (length) emitLine(); }

 private:
  void emitLine() {
    buffer[length] = 0;
    stamp();
    port().print("@serial ");
    port().println(buffer);
    length = 0;
  }
  char buffer[256];
  size_t length = 0;
};
static SerialProxy serial;

static inline void reset() {
  port().flush();
  delay(50);
#if defined(ESP32) || defined(ESP8266)
  ESP.restart();
#elif defined(CORE_TEENSY)
  SCB_AIRCR = 0x05FA0004;
#elif defined(ARDUINO_ARCH_RP2040)
  rp2040.reboot();
#elif defined(ARDUINO_ARCH_STM32) || defined(ARDUINO_ARCH_SAMD)
  NVIC_SystemReset();
#elif defined(__AVR__)
  wdt_enable(WDTO_15MS);
  for (;;) {}
#else
#error "Cortex HIL: add a software reset for this board in cortex_hil.h"
#endif
}

}  // namespace cortex_hil

// From here on the firmware's calls reach the layer above, never the pins.
#undef digitalRead
#undef analogRead
#undef digitalWrite
#undef analogWrite
#undef pinMode
#undef tone
#undef noTone
#undef millis
#undef micros
#undef Serial
#define digitalRead(p) cortex_hil::hilDigitalRead(p)
#define analogRead(p) cortex_hil::hilAnalogRead(p)
#define digitalWrite(p, v) cortex_hil::hilDigitalWrite((p), (v))
#define analogWrite(p, v) cortex_hil::hilAnalogWrite((p), (v))
#define pinMode(p, m) cortex_hil::hilPinMode((p), (m))
#define tone(...) cortex_hil::hilTone(__VA_ARGS__)
#define noTone(p) cortex_hil::hilNoTone(p)
#define millis() cortex_hil::hilMillis()
#define micros() cortex_hil::hilMicros()
#define Serial cortex_hil::serial
#define setup cortex_hil_user_setup
#define loop cortex_hil_user_loop
