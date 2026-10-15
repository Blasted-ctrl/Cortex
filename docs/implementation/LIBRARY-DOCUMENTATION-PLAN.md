# Plan: complete library documentation in the editor

Written for Codex (and any agent or engineer continuing the library-documentation
work). It is self-contained: read it, then work phase by phase.

## Goal

When someone types `cv::`, `Serial.`, `std::this_thread::` or `import cv2`, the editor
should explain what each thing does, with its real signature, the units and failure
behavior that matter, and a short example that is known to compile. This is already
true for ESP32Servo, OpenCV (core subset), raylib, SDL2 and GLFW. The job is to extend
it to everything a Cortex user is likely to touch, without ever shipping an
unverified claim.

The product test from CLAUDE.md applies: documentation that helps someone understand
the hardware and code in front of them is in scope; volume for its own sake is not.

## Current state (verified 2026-10-15, commit 6f96967)

| Source | What exists | How it reaches the editor |
|---|---|---|
| `src/shared/stdlib/cpp-libraries.json` | ESP32Servo (1 class, 13 members); OpenCV (46 functions, 8 classes, 57 members, namespace `cv`); raylib (21 functions); SDL2 (14); GLFW (13) | `libraryComplete.ts` + `lspClient.ts`: attached to clangd's own completion and hover items |
| `src/shared/stdlib/cpp.json` | C++ standard library: `std::vector` (11 symbols), `std::chrono` (2) | `stdlibDocumentation.ts` owner policy (`cppOwners`) |
| `src/shared/stdlib/python.json` | `time`, `os`, `random` | **Not consumed anywhere.** Only mocked in a test. Python has no curated-doc path today. |
| `src/shared/stdlib/*-snippets.json` | small snippet lists | snippet completion |

Mechanism, in one paragraph: clangd decides which symbols exist. The dictionary only
adds the human explanation. A match needs (a) an enabling header included, (b) the right
context (`ns::`, `ns::Class::`, a `receiver.` whose declared type is the class, a
`using namespace`), and (c) the item's kind and bare name. Anything else (another
namespace, a missing include, comments, strings) must get nothing. Read
`docs/STDLIB-DICTIONARY-WORKFLOW.md` and `docs/NATIVE-LIBRARIES.md` first; they define
the contract and the schema (`headers`, `namespace`, `functions`, `classes`).

Tests that pin the behavior (copy their style): `test/libraryComplete.test.ts`,
`test/libraryNamespaces.test.ts` (pure logic), `test/lspOpenCvDocs.test.ts` (the real
editor path with clangd-shaped items), `test/lspDocumentation.test.ts` (Servo, stdlib).

Tool that pins accuracy: `node scripts/check-library-examples.cjs [key]` compiles every
example against the real installed library (it fails on a bad example and on a
dictionary key it does not know how to build).

## Known gaps (what this plan must close)

1. **No constants or enums.** `cv::COLOR_BGR2GRAY`, `cv::IMREAD_GRAYSCALE`, `KEY_RIGHT`,
   `SDL_INIT_VIDEO`, `GLFW_KEY_ESCAPE` are the arguments people most need explained.
2. **Overloads share one entry.** clangd lists `imread` twice (the `Mat`-returning one
   and the output-parameter one) and both get the same text.
3. **OpenCV is a subset** (core, imgproc basics, highgui, videoio, a Haar cascade). Missing:
   most of `Mat`, features2d, calib3d, video, dnn, photo, objdetect beyond cascades.
4. **Embedded, Cortex's core domain, is nearly empty.** No Arduino core (`Serial`,
   `pinMode`, `digitalWrite`, `analogRead`, `delay`, `millis`, `attachInterrupt`), no ESP32
   APIs (`ledcSetup`, `WiFi`, `Preferences`, FreeRTOS), no common sensor libraries.
5. **C++ standard library is almost empty** (`vector`, two chrono symbols). The
   original motivating example, `std::this_thread::sleep_for`, is not covered.
6. **Python has no consumer** (see table) and no third-party docs (`cv2`, `numpy`).
7. **Bundle size.** `cpp-libraries.json` is imported into the renderer (84 KB now). Full
   coverage could reach megabytes. It must load lazily per library (see Phase 0.4).
8. **Nothing verifies that a documented symbol exists.** Examples are compile-checked;
   names and signatures are not. A typo'd function name would pass.

## Rules for every entry

These are the existing contract plus lessons from the OpenCV work.

- **Accuracy over volume.** Check every signature against the installed headers and every
  behavior claim against the library's own reference. If unsure, leave the entry out.
  Never invent an API, a flag, a constant value or a URL.
- **Write plain English, do not paste doxygen or vendor prose.** Say what it does, what
  each argument means, units, valid ranges, what is returned, how it fails, and the one
  mistake beginners make (BGR vs RGB, `Size(width, height)` vs `Mat(rows, cols)`).
- **Examples compile.** Class examples are complete programs (include, then `main`).
  Function examples are statement fragments. No external files (draw synthetic images).
  Run `scripts/check-library-examples.cjs` before every commit.
- **Embedded claims need evidence.** Do not state pin numbers, voltages, timings or
  limits unless they are in the datasheet or the framework source. Say which chip/core
  version. Examples must build for the target (Phase 3), not only parse.
- **ASCII only, no em or en dashes, no unicode ellipsis** (`test/style.test.ts`).
  JSON is 2-space indent, LF endings. Do not reformat existing entries.
- **Do not widen matching.** A new entry never gets documentation in a context the
  contract excludes. Add boundary tests for any new schema field.
- **Do not copy** `.pio/`, node_modules or machine-specific paths into docs.

## Phase 0: tooling and schema (do this first, small commits)

0.1 **Symbol verifier.** Add `scripts/check-library-symbols.cjs`: for every function and
    class in a library entry, compile `using ns::name;` (or `using ::name;`) against the
    real header. It fails when the name does not exist. For members, ask a real clangd
    (see `scratchpad`-style harness: open `cv::Mat m; m.`, request completion, collect
    names) and assert every curated member is in the list. Report signature drift by
    comparing the curated `signature` text's parameter count with clangd's label for the
    same name (warn, do not fail, since overloads differ).
0.2 **Link check (optional, online).** `--online` mode that HEAD-requests every `docUrl`,
    rate-limited, and reports 404s. Not part of the default run.
0.3 **npm scripts.** `docs:check-examples` and `docs:check-symbols`. They need native
    libraries installed (Settings > Libraries), so they are not part of `npm test`.
0.4 **Lazy per-library data.** Split `cpp-libraries.json` into one file per library under
    `src/shared/stdlib/libs/` plus a small index mapping each enabling header to its file.
    `lspClient.ts` loads a library's file with a dynamic `import()` the first time one of
    its headers is included, then caches it. Keep the existing public functions
    (`indexLibraries`, `librarySuggestions`) working; the dictionary shape does not change.
    Acceptance: the main renderer chunk no longer contains OpenCV text; existing tests
    pass; add a test that a file with no curated include loads nothing.
0.5 **Constants.** Add an optional `constants: Record<string, { value?: string,
    description: string, group?: string }>` to a library entry. Match completion items of
    kind Constant/EnumMember/Variable by bare name in the same contexts as functions
    (`cv::`, `using namespace cv`, or global). Group related ones (all `COLOR_*`,
    `THRESH_*`) so one description can cover a family with the specific meaning per name.
    Tests: same boundaries as `test/libraryNamespaces.test.ts`.
0.6 **Overloads.** Let a function entry carry `overloads: { signature, description?, example? }[]`.
    Completion items are matched by signature text when it is available, falling back to
    the shared description. Tests for the two `imread` overloads.
0.7 **Version metadata.** Entries gain `version` (the library version the text was
    checked against). `docs:check-symbols` prints the installed version and warns on a
    mismatch. This is the drift alarm for Phase 7.

Acceptance for Phase 0: the three scripts run clean; typecheck and the full test suite
pass (the 4 `firmwareDesktop` failures on a machine with no host g++ are known and
unrelated); `docs/STDLIB-DICTIONARY-WORKFLOW.md` documents `constants`, `overloads`,
`version` and the lazy loading.

## Phase 1: OpenCV to full practical coverage

Install via Settings > Libraries (OpenCV 4.x from MSYS2). Work module by module; one
commit per module; each ends with `check-library-examples` and `check-library-symbols`
green.

- **core (finish `Mat`):** `Mat` constructors and every commonly used member (`ptr`, `at`,
  `rowRange`, `colRange`, `diag`, `dot`, `mul`, `inv`, `cross`, `reshape`, `step`, `elemSize`,
  `forEach`, `operator()` ROI), `Vec`, `Matx`, `Point3`, `Rect` ops, `RotatedRect`, `Range`,
  `FileStorage`, `RNG`, `TickMeter`; functions `add`, `subtract`, `multiply`, `divide`,
  `norm`, `sum`, `reduce`, `minMaxIdx`, `mean`/`meanStdDev`, `transpose`, `repeat`, `hconcat`,
  `vconcat`, `copyMakeBorder`, `LUT`, `dft`, `bitwise_or/xor/not`, `compare`, `inRange`,
  `getTickCount`/`getTickFrequency`, `setNumThreads`, `parallel_for_`.
- **imgproc:** `Sobel`, `Scharr`, `Laplacian`, `filter2D`, `sepFilter2D`, `remap`,
  `getPerspectiveTransform`, `warpPerspective`, `getAffineTransform`, `calcHist`,
  `compareHist`, `moments`, `HuMoments`, `approxPolyDP`, `convexHull`, `convexityDefects`,
  `minAreaRect`, `minEnclosingCircle`, `fitEllipse`, `fitLine`, `pointPolygonTest`,
  `floodFill`, `grabCut`, `watershed`, `distanceTransform`, `connectedComponents`
  (+`WithStats`), `cornerHarris`, `goodFeaturesToTrack`, `ellipse`, `polylines`, `fillPoly`,
  `arrowedLine`, `getTextSize`, `applyColorMap`, `CLAHE`, `integral`, `pyrDown`/`pyrUp`.
- **imgcodecs / highgui / videoio:** `imdecode`, `imencode`, `imreadmulti`, trackbars
  (`createTrackbar`, `getTrackbarPos`), `setMouseCallback`, `selectROI`, `moveWindow`,
  `resizeWindow`, `setWindowTitle`; `VideoCapture` backends (`CAP_DSHOW`, `CAP_MSMF`,
  `CAP_V4L2`), `CAP_PROP_*`, `VideoWriter` codec notes per platform.
- **objdetect:** `CascadeClassifier` (done), `HOGDescriptor` + `setSVMDetector`,
  `QRCodeDetector`, `aruco` (note: contrib in some builds; verify the installed build has it).
- **features2d / calib3d:** `ORB`, `SIFT`, `AKAZE`, `BFMatcher`, `FlannBasedMatcher`,
  `drawKeypoints`, `drawMatches`, `findHomography`, `findChessboardCorners`,
  `calibrateCamera`, `undistort`, `solvePnP`, `Rodrigues`.
- **video / dnn / photo:** `calcOpticalFlowPyrLK`, `calcOpticalFlowFarneback`,
  `createBackgroundSubtractorMOG2`, `KalmanFilter`; `dnn::readNet`, `blobFromImage`,
  `Net::forward`; `inpaint`, `fastNlMeansDenoising`, `detailEnhance`.
- **Constants (needs 0.5):** every enum family used above: `COLOR_*`, `IMREAD_*`,
  `IMWRITE_*`, `THRESH_*`, `ADAPTIVE_THRESH_*`, `MORPH_*`, `INTER_*`, `BORDER_*`, `LINE_*`,
  `FONT_*`, `CAP_PROP_*`, `WINDOW_*`, `RETR_*`, `CHAIN_APPROX_*`, `TM_*`, `HOUGH_*`,
  `NORM_*`, `ROTATE_*`, `CV_8UC*`/`CV_32F*` depth macros. State each constant's meaning,
  not just its name, and flag the ones with surprising behavior (`THRESH_OTSU` is a
  modifier OR-ed in, not a type).

Acceptance: a person following only the editor's hover can write the existing
`tools/edge_detect.cpp` demo and a webcam loop without opening the web docs. Spot check
with a fresh file and `cv::` completion.

## Phase 2: the other catalog libraries

Keep the catalog (`src/shared/nativeLibs.ts`) and the dictionary in step: a library in
one must be in the other, and `scripts/check-library-examples.cjs` `LIBRARY_CHECKS` must
know how to build it.

- **raylib:** shapes, text, textures/images, input (keyboard, mouse, gamepad), audio,
  camera 2D/3D, models, collisions, `Color`/`Vector2`/`Rectangle`/`Texture2D`/`Camera2D`
  structs and the named colors and key/mouse constants.
- **SDL2:** video (surfaces, textures, `SDL_Rect`, `SDL_Event` and its union members),
  events and keycodes, timers, audio, `SDL_Log`. Note the Windows `SDL_main` rule.
  Consider separate catalog entries for `SDL2_image` and `SDL2_ttf` if people ask.
- **GLFW:** input and callbacks, monitors/video modes, joysticks, window attributes, the
  `GLFW_KEY_*` constants, context and vsync notes.

Acceptance: the same spot check as Phase 1 for a small game loop in each library.

## Phase 3: embedded (highest product value; do not skip)

This is Cortex's reason to exist, so it gets the strictest standard.

- **Verification backend.** Extend `check-library-examples.cjs` with a `platformio`
  backend: generate a scratch PlatformIO project for `esp32dev` (Arduino framework) with
  the needed `lib_deps`, put the example in `setup()`/`loop()`, and run `pio run`. PlatformIO
  is installed with Cortex's board tools on a developer machine; if absent, skip with a
  loud notice rather than pass. Keep generated projects under `os.tmpdir()`, never in the repo.
- **Arduino core:** `Serial` (begin, print, println, printf on ESP32, available, read,
  readStringUntil, flush), `pinMode`, `digitalWrite`, `digitalRead`, `analogRead`,
  `analogWrite` (and the ESP32 caveat), `delay`, `delayMicroseconds`, `millis`, `micros`,
  `attachInterrupt`/`detachInterrupt` (ISR rules: `IRAM_ATTR`, no blocking), `map`,
  `constrain`, `tone`, `pulseIn`, `shiftOut`, `String` pitfalls on small heaps.
- **ESP32 specifics:** `ledcSetup`/`ledcAttachPin`/`ledcWrite` (and the core 3.x
  `ledcAttach` change, per core version), `WiFi` (begin, status, localIP, events),
  `WebServer`, `HTTPClient`, `Preferences`, `Wire` (begin pins, clock, return codes),
  `SPI`, `EEPROM`, `esp_sleep_*`, FreeRTOS (`xTaskCreate`, `vTaskDelay`, queues, mutexes,
  stack sizes), ADC channel and pin limits.
- **Common libraries:** `ESP32Servo` (done; re-verify), `Adafruit_Sensor`, `DHT`,
  `MPU6050`, `LiquidCrystal(_I2C)`, `SD`, `NeoPixel`. One library per commit.
- **Link to project intelligence.** Where a function takes a pin, point to the existing
  capability facts (`src/shared/pinCapability.ts`, input-only pins) in the description
  rather than restating them, so there is one source of truth.
- **Per-core version.** Arduino-ESP32 changed APIs between 2.x and 3.x. Record the core
  version in `version` and state which versions an entry applies to.

Acceptance: an `esp32dev` Blink with `Serial`, a PWM LED, a WiFi connect and a servo sweep
can be written from hover docs alone, and every example built with `pio run`.

## Phase 4: C++ standard library

Extend `cpp.json` and the `cppOwners` map in `stdlibDocumentation.ts` (this uses the
stricter qualified-owner policy, not the library-dictionary path; read the tests in
`test/lspDocumentation.test.ts` before changing it). Priority for embedded and
beginners: `std::this_thread` (`sleep_for`, `sleep_until`, `yield`, `get_id`), `std::thread`,
`std::mutex`/`lock_guard`/`unique_lock`, `std::atomic`, `std::string`/`string_view`,
`std::array`, `std::map`/`unordered_map`, `std::algorithm` (sort, find, transform,
accumulate), `std::optional`, `std::unique_ptr`/`shared_ptr`/`make_unique`, `std::function`,
`std::chrono` (finish), `<cstdint>` types, `std::filesystem`. Add an "on microcontrollers"
note where it matters (heap use, exceptions and RTTI often disabled, `std::thread` on
ESP32 is FreeRTOS underneath). Verify examples with the host compiler and cppreference URLs.

## Phase 5: Python

1. **Build the consumer first.** `python.json` is not read by any code. Design the Python
   analogue of the C++ path: hover and completion for `module.symbol` after `import module`,
   attached to pyright's items. Same boundary rules (no import, shadowed name, comments).
   Reuse the pure matching style of `libraryComplete.ts`; do not special-case in `lspClient.ts`.
2. **Verification.** Examples are run (not just parsed) in a venv with `python -I`, with
   the package installed. A script `scripts/check-python-examples.cjs` mirrors the C++ one.
3. **Content:** finish `time`, `os`, `random`; add `pathlib`, `json`, `math`, `collections`,
   `itertools`, `subprocess`, `argparse`, `serial` (pyserial, relevant to Cortex's serial
   tools), then third-party: `cv2` (same coverage list as Phase 1, using Python
   signatures and noting BGR and `numpy` array shapes), `numpy` essentials.

## Phase 6: maintenance and coverage reporting

- `docs:coverage`: for each library, list the public symbols clangd reports versus the
  curated ones, and print a percentage. Publish the table in `docs/NATIVE-LIBRARIES.md`.
  Coverage is a guide, not a goal; never add low-quality entries to move it.
- Drift alarm: CI job (optional) that runs the three checks against pinned library versions.
- Contribution template: a checklist in `docs/STDLIB-DICTIONARY-WORKFLOW.md` (header keys,
  namespace, example rules, the three commands).

## Working agreement

- A Claude session is also editing `src/renderer/src/lsp/lspClient.ts`,
  `src/main/services/clangdConfig.ts` and the Settings UI. `git pull` before starting a
  phase, commit small and often, and do not reformat files you are not changing.
- One library or one module per commit. Message style: `feat: document <thing>` or
  `fix: ...`. Update the docs in the same commit.
- Run before every commit: `npm run typecheck`, the library tests
  (`npx vitest run test/libraryComplete.test.ts test/libraryNamespaces.test.ts
  test/lspOpenCvDocs.test.ts test/lspDocumentation.test.ts test/style.test.ts`),
  and the example/symbol checkers for the library you touched.
- Do not push release tags, change Electron security settings or touch the installer.
  Pushing to `main` follows the owner's instruction; ask if unsure.
- If a claim cannot be verified on this machine (hardware behavior, a library you cannot
  install), leave it out and list it under "Unverified" in the commit message.

## Definition of done

- Each phase's acceptance check passes and is recorded in `docs/implementation/CORTEX_PROGRESS.md`.
- Every curated symbol exists (symbol check), every example builds or runs (example check),
  every context boundary has a test, and the renderer bundle only loads documentation for
  libraries a file actually includes.
- A newcomer can use OpenCV, raylib, an ESP32 Arduino sketch, `std::thread` and `cv2` from
  the editor's popups alone.
