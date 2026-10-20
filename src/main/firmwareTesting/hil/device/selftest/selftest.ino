// Cortex HIL electrical self-test. Unlike the scenario layer, this sketch drives and
// reads real pins, so it needs two jumper wires (see docs/HIL.md):
//   OUT -> IN    digital loopback
//   OUT -> ADC   the same net on an analog input
// It repeats its checks every second and prints one block each time:
//   HIL selftest begin
//   HIL selftest <check> <expected> <actual> PASS|FAIL
//   HIL_DONE <passed>/<total>
#include <Arduino.h>

#if defined(ARDUINO_TEENSY41) || defined(ARDUINO_TEENSY40)
const int OUT_PIN = 2, IN_PIN = 3, ADC_PIN = A0;  // A0 is pin 14
const int ADC_MAX = 1023;
#elif defined(ESP32)
const int OUT_PIN = 25, IN_PIN = 26, ADC_PIN = 34;  // GPIO 34 is input-only ADC1
const int ADC_MAX = 4095;
#elif defined(ARDUINO_ARCH_STM32)
const int OUT_PIN = D7, IN_PIN = D8, ADC_PIN = A0;
const int ADC_MAX = 1023;
#else
const int OUT_PIN = 2, IN_PIN = 3, ADC_PIN = A0;
const int ADC_MAX = 1023;
#endif

static int passed = 0, total = 0;

static void report(const char *name, const char *expected, long actual, bool ok) {
  Serial.print("HIL selftest ");
  Serial.print(name);
  Serial.print(' ');
  Serial.print(expected);
  Serial.print(' ');
  Serial.print(actual);
  Serial.println(ok ? " PASS" : " FAIL");
  total++;
  if (ok) passed++;
}

static void drive(int level) {
  pinMode(OUT_PIN, OUTPUT);
  digitalWrite(OUT_PIN, level);
  delay(5);
}

void setup() {
  Serial.begin(115200);
}

void loop() {
  passed = total = 0;
  Serial.println("HIL selftest begin");
  pinMode(IN_PIN, INPUT);

  drive(HIGH);
  report("gpio-loopback-high", "1", digitalRead(IN_PIN), digitalRead(IN_PIN) == HIGH);
  const int high = analogRead(ADC_PIN);
  report("adc-reads-driven-high", ">=90%", high, high >= ADC_MAX * 9 / 10);

  drive(LOW);
  report("gpio-loopback-low", "0", digitalRead(IN_PIN), digitalRead(IN_PIN) == LOW);
  const int low = analogRead(ADC_PIN);
  report("adc-reads-driven-low", "<=10%", low, low <= ADC_MAX / 10);

  // With OUT released, only IN's internal pull-up holds the net, so it must read HIGH.
  pinMode(OUT_PIN, INPUT);
  pinMode(IN_PIN, INPUT_PULLUP);
  delay(5);
  report("internal-pullup", "1", digitalRead(IN_PIN), digitalRead(IN_PIN) == HIGH);
  pinMode(IN_PIN, INPUT);

  Serial.print("HIL_DONE ");
  Serial.print(passed);
  Serial.print('/');
  Serial.println(total);
  delay(1000);
}
