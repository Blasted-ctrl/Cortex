#include <Arduino.h>

// Demo fixture: the example controller with its ADC range check removed. A sensor
// that is disconnected or shorted reads 0 or 1023, and this version treats that as
// a real temperature: a reading of 0 turns the heater on. The invalid-input
// scenario must reject it. The fix is the range check in ../controller.ino.
const int SENSOR_PIN = A0;
const int SAMPLE_READY_PIN = 2;
const int ACTUATOR_PIN = 9;
const int FAULT_PIN = 13;
const unsigned long SENSOR_TIMEOUT_MS = 250;
const int ACTUATOR_LIMIT = 180;

enum ControllerState { BOOT, HEATING, IDLE, TIMEOUT, INVALID };
ControllerState state = BOOT;
int previousReady = LOW;
unsigned long lastSampleMs = 0;

void transition(ControllerState next) {
  if (next == state) return;
  state = next;
  analogWrite(ACTUATOR_PIN, next == HEATING ? ACTUATOR_LIMIT : 0);
  digitalWrite(FAULT_PIN, next == TIMEOUT || next == INVALID ? HIGH : LOW);
  switch (next) {
    case BOOT: Serial.println("BOOT"); break;
    case HEATING: Serial.println("HEATING"); break;
    case IDLE: Serial.println("IDLE"); break;
    case TIMEOUT: Serial.println("TIMEOUT"); break;
    case INVALID: Serial.println("INVALID"); break;
  }
}

void setup() {
  pinMode(SENSOR_PIN, INPUT);
  pinMode(SAMPLE_READY_PIN, INPUT);
  pinMode(ACTUATOR_PIN, OUTPUT);
  pinMode(FAULT_PIN, OUTPUT);
  analogWrite(ACTUATOR_PIN, 0);
  digitalWrite(FAULT_PIN, LOW);
  previousReady = digitalRead(SAMPLE_READY_PIN);
  lastSampleMs = millis();
  Serial.begin(115200);
  Serial.println("BOOT");
}

void loop() {
  const unsigned long now = millis();
  const int ready = digitalRead(SAMPLE_READY_PIN);
  if (ready != previousReady) {
    previousReady = ready;
    lastSampleMs = now;
    const int reading = analogRead(SENSOR_PIN);
    transition(reading < 400 ? HEATING : IDLE);
  } else if (now - lastSampleMs >= SENSOR_TIMEOUT_MS) {
    transition(TIMEOUT);
  }
  delay(10);
}
