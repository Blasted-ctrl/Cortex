// Cortex hardware-in-the-loop layer, part 2 of 2: included after the firmware source.
// The firmware's setup() and loop() were renamed by cortex_hil.h; these are the real
// ones the core calls. They wait for a scenario schedule, start the clock, run the
// firmware until the scenario's duration, then report @done.
#pragma once
#undef setup
#undef loop

namespace cortex_hil {

static char line[64];
static uint8_t lineLength = 0;

// Returns true when a complete line is in `line`; never blocks.
static inline bool pollLine() {
  while (port().available() > 0) {
    const int c = port().read();
    if (c < 0) break;
    if (c == '\n') {
      line[lineLength] = 0;
      lineLength = 0;
      return true;
    }
    if (c != '\r' && lineLength < sizeof(line) - 1) line[lineLength++] = (char)c;
  }
  return false;
}

static inline bool startsWith(const char *text, const char *prefix) {
  return strncmp(text, prefix, strlen(prefix)) == 0;
}

static inline void serviceCommand() {
  if (strcmp(line, "@hil reset") == 0) reset();
}

// Announces readiness until a full schedule and "@hil go" arrive.
static inline void awaitSchedule() {
  uint32_t lastAnnounce = 0;
  int32_t expected = -1;
  for (;;) {
    if (realMicros() - lastAnnounce > 500000UL || lastAnnounce == 0) {
      port().println("@hil ready 1");
      lastAnnounce = realMicros();
    }
    if (pollLine()) {
      if (startsWith(line, "@hil schedule ")) {
        unsigned long durationMs = 0;
        long count = 0;
        if (sscanf(line + 14, "%lu %ld", &durationMs, &count) == 2 && count >= 0 && count <= CORTEX_HIL_MAX_INPUTS) {
          durationUs = durationMs * 1000UL;
          expected = count;
          inputCount = 0;
        } else {
          port().println("@hil error bad schedule");
        }
      } else if (expected >= 0 && inputCount < expected && line[0] != '@') {
        unsigned long atUs = 0;
        int pin = 0, value = 0;
        if (sscanf(line, "%lu %d %d", &atUs, &pin, &value) == 3 && pin >= 0 && pin < 128 && value >= 0 && value <= 1023) {
          inputs[inputCount].atUs = atUs;
          inputs[inputCount].pin = (uint8_t)pin;
          inputs[inputCount].value = (int16_t)value;
          external[pin] = true;
          inputCount++;
          if (inputCount == expected) {
            port().print("@hil scheduled ");
            port().println(inputCount);
          }
        } else {
          port().println("@hil error bad input");
        }
      } else if (strcmp(line, "@hil go") == 0 && expected >= 0 && inputCount == expected) {
        return;
      } else {
        serviceCommand();
      }
    }
    delay(1);
  }
}

}  // namespace cortex_hil

void cortex_hil_user_setup();
void cortex_hil_user_loop();

void setup() {
  cortex_hil::port().begin(CORTEX_HIL_BAUD);
  cortex_hil::awaitSchedule();
  cortex_hil::port().println("@hil started");
  cortex_hil::startUs = cortex_hil::realMicros();
  // Initial state is applied before setup(), exactly as the simulator does.
  cortex_hil::applyDue();
  cortex_hil_user_setup();
}

void loop() {
  if (cortex_hil::finished) {
    if (cortex_hil::pollLine()) cortex_hil::serviceCommand();
    delay(1);
    return;
  }
  if (cortex_hil::nowUs() >= cortex_hil::durationUs) {
    cortex_hil::serial.flushResidue();
    cortex_hil::port().print("@done ");
    cortex_hil::port().println(cortex_hil::nowUs());
    cortex_hil::port().println("@hil done");
    cortex_hil::finished = true;
    return;
  }
  cortex_hil::applyDue();
  cortex_hil_user_loop();
}
