#include <Arduino.h>

void setup() {
  Serial.begin(115200);
  Serial.println("HANGING_FIXTURE");
  // No delay or return: virtual time cannot advance. The independent host
  // watchdog must terminate this process and classify it as a runner error.
  while (true) {}
}

void loop() {}
