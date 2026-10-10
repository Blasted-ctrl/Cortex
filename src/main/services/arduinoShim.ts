/**
 * A host-compilable mock of the Arduino runtime. Compiling a real sketch
 * against this with g++/clang++ lets Cortex "simulate" the board natively:
 * the sketch's actual setup()/loop() run, and every I/O call emits a line-based
 * event on stdout that the Simulator view turns into live components.
 *
 * Interaction flows back over stdin: `@in <pin> <value>` (button/pot), `@stop`.
 * CORTEX_TEST replaces the input thread and wall time with a scheduled virtual clock.
 *
 * Covers the common surface (digital/analog I/O, timing, Serial incl.
 * base-formatted print + F(), tone, map/constrain, bit ops). Not cycle-accurate
 * - see docs/SIMULATOR.md.
 */
import { ADC_MAX, LOGIC_THRESHOLD, PWM_MAX } from '../../shared/simProtocol'

/** Retained Serial lines, desktop protocol fragments and compiler diagnostics. */
export const SIM_BUFFER_LIMIT_BYTES = 1024 * 1024

export const ARDUINO_SHIM = String.raw`#pragma once
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <atomic>
#include <thread>
#include <chrono>
#include <string>
#include <sstream>
#include <iomanip>
#include <iostream>
#if defined(_WIN32) && !defined(CORTEX_TEST)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif
#ifdef CORTEX_TEST
#include <vector>
#include <algorithm>
#endif

// This exits only the disposable firmware process, never the Electron host.
// MSVCRT _Exit still enters Windows DLL teardown and can race the detached
// reader's startup. Bypass that teardown after callers explicitly flush output.
[[noreturn]] inline void __sim_terminate(int code) {
#if defined(_WIN32) && !defined(CORTEX_TEST)
  if (!TerminateProcess(GetCurrentProcess(), (UINT)code)) {
    fprintf(stderr, "Cortex could not terminate the firmware process (Windows error %lu).\n", (unsigned long)GetLastError());
    fflush(stderr);
    std::_Exit(2);
  }
#endif
  std::_Exit(code);
}

typedef uint8_t byte;
typedef bool boolean;
#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define LED_BUILTIN 13
#define A0 14
#define A1 15
#define A2 16
#define A3 17
#define A4 18
#define A5 19
#define DEC 10
#define HEX 16
#define OCT 8
#define BIN 2
#define PI 3.1415926535897932384626433832795
#define F(x) x
#define bitRead(v,b) (((v) >> (b)) & 0x01)
#define bitSet(v,b) ((v) |= (1UL << (b)))
#define bitClear(v,b) ((v) &= ~(1UL << (b)))
#define bitWrite(v,b,x) ((x) ? bitSet(v,b) : bitClear(v,b))

inline std::atomic<int> __sim_in[128];
inline std::atomic<int> __sim_modes[128];
inline std::atomic<bool> __sim_run{true};

#ifdef CORTEX_TEST
inline uint64_t __sim_time_us = 0;
inline uint64_t __sim_limit_us = 0;
inline uint32_t __sim_random_state = 0;
inline bool __sim_external_input[128]{};
struct __SimTestInput { uint64_t at_us; int pin; int value; };
inline std::vector<__SimTestInput> __sim_test_inputs;
inline size_t __sim_next_input = 0;
inline bool __sim_inputs_sorted = true;

inline void __sim_trace_time() {
  printf("@time %llu\n", (unsigned long long)__sim_time_us);
}
inline void __sim_test_init(uint32_t seed, uint64_t duration_us) {
  __sim_time_us = 0;
  __sim_limit_us = duration_us;
  __sim_random_state = seed;
  __sim_run = true;
  __sim_test_inputs.clear();
  __sim_next_input = 0;
  __sim_inputs_sorted = true;
  for (int p = 0; p < 128; p++) { __sim_in[p] = 0; __sim_modes[p] = INPUT; __sim_external_input[p] = false; }
}
inline void __sim_test_input(uint64_t at_us, int pin, int value) {
  __sim_test_inputs.push_back({at_us, pin, value});
  __sim_inputs_sorted = false;
}
inline void __sim_test_advance(uint64_t delta_us) {
  if (!__sim_inputs_sorted) {
    std::stable_sort(__sim_test_inputs.begin(), __sim_test_inputs.end(),
        [](const __SimTestInput& a, const __SimTestInput& b) { return a.at_us < b.at_us; });
    __sim_inputs_sorted = true;
  }
  const uint64_t remaining = __sim_limit_us - __sim_time_us;
  const uint64_t next_us = __sim_time_us + (delta_us > remaining ? remaining : delta_us);
  while (__sim_next_input < __sim_test_inputs.size() && __sim_test_inputs[__sim_next_input].at_us <= next_us) {
    const auto& input = __sim_test_inputs[__sim_next_input++];
    __sim_time_us = input.at_us;
    __sim_in[input.pin & 127] = input.value;
    __sim_external_input[input.pin & 127] = true;
    __sim_trace_time();
    printf("@input %d %d\n", input.pin, input.value);
    fflush(stdout);
  }
  __sim_time_us = next_us;
  __sim_run = __sim_time_us < __sim_limit_us;
}
#else
inline void __sim_trace_time() {}
inline auto __sim_t0 = std::chrono::steady_clock::now();

struct __SimIn {
  __SimIn() {
    std::thread([] {
      std::string l;
      while (std::getline(std::cin, l)) {
        if (l.rfind("@stop", 0) == 0) { __sim_run = false; break; }
        int p, v;
        if (sscanf(l.c_str(), "@in %d %d", &p, &v) == 2) __sim_in[p & 127] = v;
      }
    }).detach();
  }
};
inline __SimIn __sim_in_thread;
#endif

inline void pinMode(int p, int m) {
  __sim_modes[p & 127] = m;
#ifdef CORTEX_TEST
  if (m == INPUT_PULLUP && !__sim_external_input[p & 127]) __sim_in[p & 127] = ${ADC_MAX};
#else
  if (m == INPUT_PULLUP) __sim_in[p & 127] = ${ADC_MAX}; // pull-ups idle HIGH until pressed
#endif
  __sim_trace_time();
  printf("@mode %d %d\n", p, m);
  fflush(stdout);
}
// ArduinoCore-avr 1.8.6 sets OUTPUT in analogWrite() and tone(). Report mode
// transitions without adding redundant events to every iteration of a PWM loop.
inline void __sim_ensure_output(int p) {
  if (__sim_modes[p & 127].load() != OUTPUT) pinMode(p, OUTPUT);
}
inline void digitalWrite(int p, int v) {
  // Latch on the ADC scale so digitalRead(p) reads it back AND analogRead(p)
  // reports full scale on a driven-high pin, as it would on real hardware.
  // The emitted @pin event stays 0/1: that is the protocol's contract.
  __sim_in[p & 127] = v ? ${ADC_MAX} : 0;
  __sim_trace_time();
  printf("@pin %d %d\n", p, v ? 1 : 0);
  fflush(stdout);
}
// digitalRead must return exactly HIGH or LOW. Every pin slot is on the ADC
// scale (see shared/simProtocol.ts), so thresholding is what lets one slot
// serve both digitalRead and analogRead.
inline int digitalRead(int p) { return __sim_in[p & 127].load() >= ${LOGIC_THRESHOLD} ? HIGH : LOW; }
// @pwm's contract is 0..${PWM_MAX}, matching the 8-bit register on the board.
// Emitting v raw let an out-of-range duty cycle drive LED brightness and servo
// angles past their limits on the canvas.
inline void analogWrite(int p, int v) {
  __sim_ensure_output(p);
  int d = v < 0 ? 0 : (v > ${PWM_MAX} ? ${PWM_MAX} : v);
  __sim_trace_time();
  printf("@pwm %d %d\n", p, d);
  fflush(stdout);
}
// On real hardware analogRead(0) is analogRead(A0). The canvas wires A0..A5 to
// 14..19, so bare 0..5 must map onto the same slots or the sketch reads nothing.
// Only 0..5 remap: an Uno has exactly six analog inputs, and the wider p < 14
// test sent analogRead(13) to slot 27, so it could never see pin 13 at all.
inline int analogRead(int p) { return __sim_in[((p >= 0 && p < 6 ? p + 14 : p)) & 127].load(); }
#ifdef CORTEX_TEST
inline unsigned long millis() { return (unsigned long)(__sim_time_us / 1000); }
inline unsigned long micros() { return (unsigned long)__sim_time_us; }
inline void delay(unsigned long ms) { __sim_test_advance((uint64_t)ms * 1000); }
inline void delayMicroseconds(unsigned long us) { __sim_test_advance(us); }
#else
inline unsigned long millis() {
  return (unsigned long)std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::steady_clock::now() - __sim_t0).count();
}
inline unsigned long micros() {
  return (unsigned long)std::chrono::duration_cast<std::chrono::microseconds>(
      std::chrono::steady_clock::now() - __sim_t0).count();
}
inline void delay(unsigned long ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }
inline void delayMicroseconds(unsigned long us) { std::this_thread::sleep_for(std::chrono::microseconds(us)); }
#endif
inline void tone(int p, unsigned int f) { __sim_ensure_output(p); __sim_trace_time(); printf("@tone %d %u\n", p, f); fflush(stdout); }
inline void tone(int p, unsigned int f, unsigned long) { tone(p, f); }
inline void noTone(int p) { __sim_trace_time(); printf("@tone %d 0\n", p); fflush(stdout); }

// ESP32 LEDC PWM. Enough of the API that a typical ESP32 sketch compiles and
// drives a pin: ledcWrite emits @pwm on the mapped pin, scaled from the channel
// resolution down to the 8-bit range the canvas expects. Both the classic
// channel API (ledcSetup + ledcAttachPin + ledcWrite(channel,duty)) and the
// 3.0 pin API (ledcAttach + ledcWrite(pin,duty)) are supported; chip specifics
// (exact frequency, channel arbitration) are not modelled.
inline int __ledc_pin[16];    // channel API: channel -> pin
inline int __ledc_res[16];    // channel API: channel -> resolution bits
inline int __ledc_pinres[48]; // pin API: pin -> resolution bits (-1 = unattached)
struct __LedcInit {
  __LedcInit() {
    for (int i = 0; i < 16; i++) { __ledc_pin[i] = -1; __ledc_res[i] = 8; }
    for (int i = 0; i < 48; i++) __ledc_pinres[i] = -1;
  }
};
inline __LedcInit __ledc_init;
// Returns the frequency, like the real API, so a sketch can capture it. One
// overload (int res) covers uint8_t callers by promotion.
inline double ledcSetup(int ch, double freq, int res) { if (ch >= 0 && ch < 16) __ledc_res[ch] = res; return freq; }
inline void ledcAttachPin(int pin, int ch) { if (ch >= 0 && ch < 16) __ledc_pin[ch] = pin; }
// Pin API (ESP32 core 3.0): resolution is stored per PIN across the full GPIO
// range, not just 0-15, or a fade on GPIO16+ saturates at full brightness.
inline bool ledcAttach(int pin, double, int res) { if (pin >= 0 && pin < 48) __ledc_pinres[pin] = res; return true; }
inline bool ledcAttachChannel(int pin, double, int res, int ch) { if (ch >= 0 && ch < 16) { __ledc_pin[ch] = pin; __ledc_res[ch] = res; } return true; }
inline void ledcWrite(int chOrPin, int duty) {
  int pin, res;
  if (chOrPin >= 0 && chOrPin < 16 && __ledc_pin[chOrPin] >= 0) {
    pin = __ledc_pin[chOrPin]; // channel API: first arg is a channel
    res = __ledc_res[chOrPin];
  } else {
    pin = chOrPin; // pin API (or a raw pin never attached)
    res = (chOrPin >= 0 && chOrPin < 48 && __ledc_pinres[chOrPin] >= 0) ? __ledc_pinres[chOrPin] : 8;
  }
  long maxv = (1L << res) - 1;
  int scaled = maxv > 0 ? (int)((long)duty * 255 / maxv) : duty;
  if (scaled < 0) scaled = 0;
  if (scaled > 255) scaled = 255;
  __sim_trace_time();
  printf("@pwm %d %d\n", pin, scaled);
  fflush(stdout);
}
inline void ledcWriteTone(int ch, double freq) {
  int pin = (ch >= 0 && ch < 16 && __ledc_pin[ch] >= 0) ? __ledc_pin[ch] : ch;
  __sim_trace_time();
  printf("@tone %d %u\n", pin, (unsigned)freq);
  fflush(stdout);
}
inline void ledcDetachPin(int) {}
inline void ledcDetach(int) {}
[[noreturn]] inline void __sim_unsupported(const char* api) {
  fprintf(stderr, "Cortex simulation does not support %s. Use a supported signal workflow or test on hardware.\n", api);
  fflush(stderr);
  __sim_terminate(2);
}
inline unsigned long pulseIn(int, int, unsigned long = 1000000UL) { __sim_unsupported("pulseIn"); }
inline byte shiftIn(int, int, int) { __sim_unsupported("shiftIn"); }
inline void shiftOut(int, int, int, int) { __sim_unsupported("shiftOut"); }

inline long map(long x, long a, long b, long c, long d) {
  return (b - a) == 0 ? c : (x - a) * (d - c) / (b - a) + c;
}
inline long constrain(long x, long lo, long hi) { return x < lo ? lo : (x > hi ? hi : x); }
template <class T, class U> constexpr auto min(T a, U b) { return a < b ? a : b; }
template <class T, class U> constexpr auto max(T a, U b) { return a > b ? a : b; }
#ifdef CORTEX_TEST
inline uint32_t __sim_random_next() {
  __sim_random_state = __sim_random_state * 1664525u + 1013904223u;
  return __sim_random_state;
}
inline long random(long hi) { return hi <= 0 ? 0 : (long)(__sim_random_next() % (unsigned long)hi); }
inline long random(long lo, long hi) { return hi <= lo ? lo : lo + random(hi - lo); }
inline void randomSeed(unsigned long s) { __sim_random_state = (uint32_t)s; }
#else
inline long random(long hi) { return hi <= 0 ? 0 : (long)(rand() % hi); }
inline long random(long lo, long hi) { return hi <= lo ? lo : lo + (long)(rand() % (hi - lo)); }
inline void randomSeed(unsigned long s) { srand((unsigned)s); }
#endif

// Serial buffers output and emits one "@serial <line>" per newline, so
// consecutive print()/println() on the same logical line concatenate correctly
// and never inject the protocol marker mid-line.
struct SerialClass {
  std::string __buf;
  void __flushLines() {
    size_t nl;
    while ((nl = __buf.find('\n')) != std::string::npos) {
      __sim_trace_time();
      std::cout << "@serial " << __buf.substr(0, nl) << "\n";
      __buf.erase(0, nl + 1);
    }
    std::cout.flush();
  }
  void __append(const std::string& s) {
    size_t offset = 0;
    while (offset < s.size()) {
      const size_t nl = s.find('\n', offset);
      const size_t length = (nl == std::string::npos ? s.size() : nl) - offset;
      if (length > ${SIM_BUFFER_LIMIT_BYTES} - __buf.size()) {
        fprintf(stderr, "Cortex simulation Serial line exceeded the ${SIM_BUFFER_LIMIT_BYTES}-byte buffer limit. Add newlines or reduce the print payload.\n");
        fflush(stderr);
        __sim_terminate(2);
      }
      __buf.append(s, offset, length);
      if (nl == std::string::npos) break;
      __buf.push_back('\n');
      __flushLines();
      offset = nl + 1;
    }
  }
  // Serial output is line-buffered so a partial print can never be split across
  // an @serial marker. That means a sketch which only ever prints without a
  // newline (Serial.print("Ready...")) would otherwise show nothing at all for
  // its whole run, so the residue is emitted before the process goes away.
  void __flushResidue() {
    if (!__buf.empty()) {
      __sim_trace_time();
      std::cout << "@serial " << __buf << "\n";
      __buf.clear();
    }
    std::cout.flush();
  }
  ~SerialClass() { __flushResidue(); }
  /** The bits the core would show for anything it routes through print(long). */
  static unsigned long long __LONG(long long v) { return (unsigned long long)(uint32_t)v; }
  // The core prints hex in uppercase.
  void __digits(unsigned long long bits, int base) {
    const char* d = "0123456789ABCDEF";
    std::string s;
    if (bits == 0) s = "0";
    while (bits) { s = std::string(1, d[bits % base]) + s; bits /= base; }
    __append(s);
  }
  /**
   * Base 10 prints the value; any other base prints raw bits.
   *
   * Callers pass the bits already narrowed to the width the core would use.
   * Arduino's long is 32 bits and its Print has no 64-bit overload, so a host
   * long long carrying -1 must still print FFFFFFFF, not sixteen Fs.
   */
  void __sig(long long v, unsigned long long bits, int base) {
    if (base == 10) { std::ostringstream o; o << v; __append(o.str()); return; }
    __digits(bits, base);
  }
  // Separate from __sig because base 10 must print an unsigned value as
  // unsigned: routing it through a signed parameter printed ULLONG_MAX as -1.
  void __uns(unsigned long long v, unsigned long long bits, int base) {
    if (base == 10) { std::ostringstream o; o << v; __append(o.str()); return; }
    __digits(bits, base);
  }
  // The core prints 2 decimals by default and never uses scientific notation.
  void __fixed(double v, int digits) {
    std::ostringstream o;
    o << std::fixed << std::setprecision(digits) << v;
    __append(o.str());
  }
  void begin(long) {}
  void end() {}
  int available() { return 0; }
  int read() { return -1; }
  int peek() { return -1; }
  void flush() { std::cout.flush(); }
  explicit operator bool() const { return true; }
  // Arduino's Print defines a typed overload set, not a generic template. A
  // template here made every 2-arg call ambiguous at identical conversion rank,
  // so Serial.println(voltage, 2) and Serial.println(millis(), DEC) (two of the
  // most common idioms there are) failed to compile. Because simService injects
  // #line, that error landed on the user's own correct sketch. The template is
  // kept only as the fallback for types the core does not enumerate.
  template <class T> void print(const T& v) { std::ostringstream o; o << v; __append(o.str()); }
  template <class T> void println(const T& v) { print(v); __append("\n"); }

  // char stays a character; the integer types do not. byte is uint8_t, so the
  // template printed a byte of 10 as a newline and split the line in two.
  //
  // WIDTH: the core's long is 32 bits and it routes every integer <= long
  // through print(long), so a non-decimal base shows 32 bits. __LONG masks to
  // that. Passing the host's 64-bit value straight through printed
  // Serial.println(-1, HEX) as sixteen Fs.
  void print(char v) { __append(std::string(1, v)); }
  void print(unsigned char v) { __uns(v, v, DEC); }
  void print(signed char v) { __sig(v, __LONG(v), DEC); }
  void print(short v) { __sig(v, __LONG(v), DEC); }
  void print(unsigned short v) { __uns(v, v, DEC); }
  void print(int v) { __sig(v, __LONG(v), DEC); }
  void print(unsigned int v) { __uns(v, v, DEC); }
  void print(long v) { __sig(v, __LONG(v), DEC); }
  void print(unsigned long v) { __uns(v, __LONG(v), DEC); }
  void print(long long v) { __sig(v, (unsigned long long)v, DEC); }
  void print(unsigned long long v) { __uns(v, v, DEC); }
  void print(double v) { __fixed(v, 2); }
  void print(float v) { __fixed((double)v, 2); }

  // No print(char, int): the core has none, so a char promotes to int and
  // Serial.println('A', HEX) prints 41. An exact-match char overload here beat
  // that promotion and silently threw the base away, printing 'A'.
  void print(unsigned char v, int base) { __uns(v, v, base); }
  void print(signed char v, int base) { __sig(v, __LONG(v), base); }
  void print(short v, int base) { __sig(v, __LONG(v), base); }
  void print(unsigned short v, int base) { __uns(v, v, base); }
  void print(int v, int base) { __sig(v, __LONG(v), base); }
  void print(unsigned int v, int base) { __uns(v, __LONG(v), base); }
  void print(long v, int base) { __sig(v, __LONG(v), base); }
  void print(unsigned long v, int base) { __uns(v, __LONG(v), base); }
  void print(long long v, int base) { __sig(v, (unsigned long long)v, base); }
  void print(unsigned long long v, int base) { __uns(v, v, base); }
  // The core reads the second argument as decimal places for reals.
  void print(double v, int digits) { __fixed(v, digits); }
  void print(float v, int digits) { __fixed((double)v, digits); }

  void println(char v) { print(v); __append("\n"); }
  void println(unsigned char v) { print(v); __append("\n"); }
  void println(signed char v) { print(v); __append("\n"); }
  void println(short v) { print(v); __append("\n"); }
  void println(unsigned short v) { print(v); __append("\n"); }
  void println(int v) { print(v); __append("\n"); }
  void println(unsigned int v) { print(v); __append("\n"); }
  void println(long v) { print(v); __append("\n"); }
  void println(unsigned long v) { print(v); __append("\n"); }
  void println(long long v) { print(v); __append("\n"); }
  void println(unsigned long long v) { print(v); __append("\n"); }
  void println(double v) { print(v); __append("\n"); }
  void println(float v) { print(v); __append("\n"); }

  // No println(char, int) either: it would reintroduce the exact-match overload
  // that print(char, int) was deleted for.
  void println(unsigned char v, int base) { print(v, base); __append("\n"); }
  void println(signed char v, int base) { print(v, base); __append("\n"); }
  void println(short v, int base) { print(v, base); __append("\n"); }
  void println(unsigned short v, int base) { print(v, base); __append("\n"); }
  void println(int v, int base) { print(v, base); __append("\n"); }
  void println(unsigned int v, int base) { print(v, base); __append("\n"); }
  void println(long v, int base) { print(v, base); __append("\n"); }
  void println(unsigned long v, int base) { print(v, base); __append("\n"); }
  void println(long long v, int base) { print(v, base); __append("\n"); }
  void println(unsigned long long v, int base) { print(v, base); __append("\n"); }
  void println(double v, int digits) { print(v, digits); __append("\n"); }
  void println(float v, int digits) { print(v, digits); __append("\n"); }
  void println() { __append("\n"); }
  size_t write(uint8_t c) { __append(std::string(1, (char)c)); return 1; }
  size_t write(const char* s) { __append(std::string(s)); return strlen(s); }
  size_t write(const uint8_t* b, size_t n) { __append(std::string((const char*)b, n)); return n; }
};
inline SerialClass Serial;

/**
 * The only supported way out of a sketch process.
 *
 * The stdin reader is a detached thread blocked in getline, so it cannot be
 * joined and it outlives main. Returning from main then runs static destructors
 * underneath a live thread that is touching std::cin and __sim_in, which is
 * undefined: in practice the process aborts and reports a nonzero exit that the
 * user reads as "my sketch crashed". The platform termination helper avoids
 * static and Windows DLL teardown beneath that reader. It also means the
 * residue flush has to be explicit, hence the call here.
 */
inline void __sim_exit(int code) {
  Serial.__flushResidue();
  std::cout.flush();
  __sim_terminate(code);
}
`
