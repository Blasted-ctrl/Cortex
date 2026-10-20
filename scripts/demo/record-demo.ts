/**
 * Scripted, re-runnable demo of Cortex: open an example project, run it on the 3D
 * board, run the firmware tests, watch the invalid-ADC scenario fail with its
 * evidence, type the fix and see every scenario pass.
 *
 * It drives the real desktop app through Playwright's Electron API, records it, and
 * cuts docs/media/cortex-demo.mp4 and docs/media/cortex-teaser.gif with ffmpeg.
 * Nothing in the app is staged: the project is a temporary copy of the example
 * controller with a real bug (examples/firmware-testing/fixtures/missing-range-check.ino),
 * clicks and typing are real input events, and the failure and the fix come from the
 * real test runner. Three things are drawn on top, and docs/media/README.md says so:
 * captions, a cursor (Playwright videos have none) and fast-forwarding while g++
 * compiles, with the real elapsed time shown on screen.
 *
 * Usage: npm run demo:video. Needs a built app (npm run build), g++ and ffmpeg on PATH,
 * and a display (on Linux, run it under xvfb-run).
 */
import { _electron as electron, type ElectronApplication, type Locator, type Page } from 'playwright'
import { spawnSync } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus, homedir, release, tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const REPO = resolve(__dirname, '..', '..')
const EXAMPLE = join(REPO, 'examples', 'firmware-testing')
const MEDIA = join(REPO, 'docs', 'media')
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const SIZE = { width: 1280, height: 720 }
const MP4_LIMIT = 9 * 1024 * 1024
const GIF_LIMIT = 5 * 1024 * 1024
/** How long a fast-forwarded compile wait lasts in the final video, in seconds. */
const FAST_SECONDS = 2
/**
 * Upper bound for one driver call. Generous because a busy laptop rendering WebGL
 * while recording can take many seconds to answer; a truly stalled call still fails.
 */
const STEP_LIMIT_MS = 30_000
const TEST_RUN_BUTTON = 'button[title="Run deterministic firmware scenarios in the Uno host model"]'

interface Segment { start: number; end: number; speed: number }
interface Clip { start: number; end: number }
interface Wait extends Clip { seconds: number; label: string }
interface Store { getState(): Record<string, any> }
declare global { interface Window { __cortexStore: Store; __cortexEditor?: any; __demoPrevious?: unknown } }

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))
function fail(message: string): never { throw new Error(message) }

/** Every driver call is bounded: an input that is never acknowledged must fail the run, not stall it for hours. */
async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms / 1000} s`)), ms) })
  try { return await Promise.race([work, expired]) } finally { clearTimeout(timer) }
}
const works = (command: string, args: string[]): boolean => spawnSync(command, args, { windowsHide: true, stdio: 'ignore' }).status === 0

/** Times on the raw recording, in seconds since the window opened. */
class Timeline {
  readonly t0 = Date.now()
  readonly marks: Record<string, number> = {}
  readonly fast: Wait[] = []
  private fastStart: number | null = null
  now(): number { return (Date.now() - this.t0) / 1000 }
  mark(name: string): void { this.marks[name] = this.now() }
  beginFast(): void { this.fastStart = this.now() }
  endFast(seconds: number, label: string): void {
    if (this.fastStart !== null) this.fast.push({ start: this.fastStart, end: this.now(), seconds, label })
    this.fastStart = null
  }
}

function cortexUserData(): string {
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Cortex')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Cortex')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Cortex')
}

/**
 * Cortex's own managed Arduino CLI from a previous normal launch, if there is one.
 * Putting it on PATH stops the throwaway profile from downloading a fresh copy and its
 * package catalogs during the recording. Board tools play no part in the demo itself.
 */
function managedArduinoCli(): string | null {
  const root = join(cortexUserData(), 'board-tools', 'cli')
  if (!existsSync(root)) return null
  const binary = process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli'
  for (const version of readdirSync(root).sort().reverse()) {
    const dir = join(root, version, `${process.platform}-${process.arch}`)
    if (existsSync(join(dir, binary))) return dir
  }
  return null
}

/** A user-style project: the buggy controller, the example scenarios and a wired circuit. */
function prepareProject(root: string): string {
  const project = join(root, 'heater-controller')
  mkdirSync(join(project, '.cortex', 'scenarios'), { recursive: true })
  copyFileSync(join(EXAMPLE, 'fixtures', 'missing-range-check.ino'), join(project, 'controller.ino'))
  for (const name of ['normal', 'sensor-timeout', 'invalid-input']) {
    const scenario = JSON.parse(readFileSync(join(EXAMPLE, 'scenarios', `${name}.json`), 'utf8'))
    // Only the sketch location changes; inputs, limits and assertions are the example's.
    scenario.firmware.source = '../../controller.ino'
    writeFileSync(join(project, '.cortex', 'scenarios', `${name}.json`), JSON.stringify(scenario, null, 2) + '\n')
  }
  copyFileSync(join(REPO, 'scripts', 'demo', 'heater-circuit.json'), join(project, '.cortex', 'diagram.json'))
  return project
}

/** Captions, cursor and fast-forward badge, drawn over the app and ignored by input. */
async function installOverlay(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.getElementById('demo-cursor')) return
    const style = document.createElement('style')
    style.textContent = `
      #demo-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
        transform: translate(640px, 420px); transition: transform 480ms cubic-bezier(.25,.8,.25,1); }
      .demo-ring { position: fixed; width: 36px; height: 36px; margin: -18px 0 0 -18px; border: 3px solid #4ea1ff;
        border-radius: 50%; z-index: 2147483646; pointer-events: none; animation: demo-ring 450ms ease-out forwards; }
      @keyframes demo-ring { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.3); opacity: 0 } }
      #demo-caption { position: fixed; top: 5px; left: 50%; transform: translateX(-50%); max-width: 72%; padding: 5px 16px;
        border-radius: 8px; background: rgba(10, 12, 16, .94); color: #f5f7fa; border: 1px solid rgba(255, 255, 255, .14);
        font: 600 15px/1.45 "Segoe UI", system-ui, sans-serif; text-align: center; z-index: 2147483645; pointer-events: none;
        box-shadow: 0 4px 18px rgba(0, 0, 0, .45); opacity: 0; transition: opacity 200ms; }
      #demo-ff { position: fixed; top: 44px; right: 14px; padding: 4px 12px; border-radius: 6px; background: #a34a12;
        color: #fff; font: 600 13px/1.45 "Segoe UI", system-ui, sans-serif; z-index: 2147483645; pointer-events: none;
        display: none; box-shadow: 0 4px 14px rgba(0, 0, 0, .4); }`
    document.head.appendChild(style)
    const cursor = document.createElement('div')
    cursor.id = 'demo-cursor'
    cursor.innerHTML = '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M1.5 1.5 L1.5 22 L6.8 16.8 L10.6 25.8 L14 24.3 L10.2 15.4 L17.8 15.4 Z" fill="#ffffff" stroke="#111111" stroke-width="1.6" stroke-linejoin="round"/></svg>'
    const caption = document.createElement('div')
    caption.id = 'demo-caption'
    const badge = document.createElement('div')
    badge.id = 'demo-ff'
    document.body.append(cursor, caption, badge)
  })
}

class Director {
  constructor(private readonly page: Page, private readonly timeline: Timeline) {}

  private log(text: string): void { console.log(`${this.timeline.now().toFixed(1).padStart(6)}s  ${text}`) }

  async caption(text: string | null): Promise<void> {
    if (text) this.log(`caption: ${text}`)
    await within(STEP_LIMIT_MS, 'Setting a caption', this.page.evaluate((value) => {
      const el = document.getElementById('demo-caption')!
      if (value) el.textContent = value
      el.style.opacity = value ? '1' : '0'
    }, text))
  }

  private async drawCursor(x: number, y: number): Promise<void> {
    await within(STEP_LIMIT_MS, 'Moving the drawn cursor', this.page.evaluate(([px, py]) => {
      document.getElementById('demo-cursor')!.style.transform = `translate(${px}px, ${py}px)`
    }, [x, y]))
  }

  async moveTo(x: number, y: number): Promise<void> {
    await this.drawCursor(x, y)
    await within(STEP_LIMIT_MS, 'Moving the mouse', this.page.mouse.move(x, y))
    await sleep(520)
  }

  private async box(target: Locator, what: string): Promise<{ x: number; y: number }> {
    await target.waitFor({ state: 'visible', timeout: 30_000 })
    const box = await within(STEP_LIMIT_MS, `Measuring ${what}`, target.boundingBox()) ?? fail(`${what} is not on screen`)
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }

  /** Real input at the element's centre. Locator.click is avoided: its post-click check never settles in this app. */
  async click(target: Locator, what: string): Promise<void> {
    const { x, y } = await this.box(target, what)
    await this.clickAt(x, y, what)
  }

  /**
   * One page call animates the drawn cursor and schedules the ring for when it arrives;
   * mouse.click then moves the real pointer and clicks. Fewer round trips keep a busy
   * machine from stretching every click in the video.
   */
  async clickAt(x: number, y: number, what: string): Promise<void> {
    this.log(`click: ${what}`)
    await within(STEP_LIMIT_MS, 'Drawing the click', this.page.evaluate(([px, py, travelMs]) => {
      document.getElementById('demo-cursor')!.style.transform = `translate(${px}px, ${py}px)`
      setTimeout(() => {
        const ring = document.createElement('div')
        ring.className = 'demo-ring'
        ring.style.left = `${px}px`
        ring.style.top = `${py}px`
        document.body.appendChild(ring)
        setTimeout(() => ring.remove(), 600)
      }, travelMs)
    }, [x, y, 480]))
    await sleep(520)
    await within(STEP_LIMIT_MS, `Clicking ${what}`, this.page.mouse.click(x, y))
    await sleep(250)
  }

  /** Drags an element vertically with real pointer input, e.g. a panel splitter. */
  async dragBy(target: Locator, dy: number, what: string): Promise<void> {
    this.log(`drag: ${what} by ${dy}px`)
    const { x, y } = await this.box(target, what)
    await this.moveTo(x, y)
    await within(STEP_LIMIT_MS, `Pressing on ${what}`, this.page.mouse.down())
    for (let step = 1; step <= 5; step++) {
      const at = y + (dy * step) / 5
      await this.drawCursor(x, at)
      await within(STEP_LIMIT_MS, `Dragging ${what}`, this.page.mouse.move(x, at))
    }
    await within(STEP_LIMIT_MS, `Releasing ${what}`, this.page.mouse.up())
    await sleep(500)
  }

  /**
   * Zooms the 3D camera. The wheel events are dispatched on the canvas and handled by
   * the same OrbitControls listener a physical wheel reaches; Playwright's own wheel
   * wheel input stalled here once, waiting for an acknowledgement that never came.
   */
  async zoom(target: Locator, dy: number, what: string): Promise<void> {
    this.log(`zoom: ${what}`)
    const { x, y } = await this.box(target, what)
    await this.moveTo(x, y)
    for (let step = 0; step < 6; step++) {
      await within(STEP_LIMIT_MS, `Zooming ${what}`, this.page.evaluate(([px, py, delta]) => {
        document.querySelector('canvas[data-engine^="three.js"]')?.dispatchEvent(
          new WheelEvent('wheel', { deltaY: delta, clientX: px, clientY: py, bubbles: true, cancelable: true }))
      }, [x, y, dy / 6]))
      await sleep(90)
    }
    await sleep(400)
  }

  async type(text: string): Promise<void> {
    this.log(`type: ${text}`)
    await within(4 * STEP_LIMIT_MS, 'Typing', this.page.keyboard.type(text, { delay: 25 }))
  }

  async press(key: string): Promise<void> {
    await within(STEP_LIMIT_MS, `Pressing ${key}`, this.page.keyboard.press(key))
  }

  /** Runs a slow step while the badge shows the real elapsed time; the cut speeds it up. */
  async fastForward<T>(label: string, work: () => Promise<T>, seconds = FAST_SECONDS): Promise<T> {
    await within(STEP_LIMIT_MS, 'Showing the fast-forward badge', this.page.evaluate((text) => {
      const badge = document.getElementById('demo-ff')!
      const started = performance.now()
      const render = (): void => { badge.textContent = `>> fast-forward: ${text}, ${((performance.now() - started) / 1000).toFixed(1)} s real time` }
      render()
      badge.style.display = 'block'
      ;(badge as HTMLElement & { timer?: number }).timer = window.setInterval(render, 100)
    }, label))
    await sleep(300)
    this.timeline.beginFast()
    try {
      return await work()
    } finally {
      this.timeline.endFast(seconds, label)
      await sleep(300)
      await within(STEP_LIMIT_MS, 'Hiding the fast-forward badge', this.page.evaluate(() => {
        const badge = document.getElementById('demo-ff') as HTMLElement & { timer?: number }
        window.clearInterval(badge.timer)
        badge.style.display = 'none'
      }))
    }
  }
}

/**
 * Polls from Node. page.waitForFunction evaluates its predicate with eval inside the
 * page, which the app's Content-Security-Policy (no 'unsafe-eval') rightly refuses.
 * Predicates run through page.evaluate, so they must not capture outer variables.
 */
async function waitFor(page: Page, what: string, predicate: () => unknown, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await within(STEP_LIMIT_MS, `Checking ${what}`, page.evaluate(predicate)))) {
    if (Date.now() > deadline) fail(`Timed out waiting for ${what}`)
    await sleep(250)
  }
}

/** Runs the firmware scenarios from the toolbar and returns the suite report. */
async function runTests(page: Page, director: Director): Promise<{ exitCode: number; results: { id: string; status: string; passed: number; total: number }[] }> {
  await page.evaluate(() => { window.__demoPrevious = window.__cortexStore.getState().firmwareTestResult })
  await director.click(page.locator(TEST_RUN_BUTTON), 'Run Tests')
  await director.fastForward('g++ compiling 3 scenarios', () => waitFor(page, 'the firmware tests', () => {
    const s = window.__cortexStore.getState()
    return s.firmwareTestError || (!s.firmwareTestRunning && s.firmwareTestResult && s.firmwareTestResult !== window.__demoPrevious)
  }, 600_000))
  const error = await page.evaluate(() => window.__cortexStore.getState().firmwareTestError as string | null)
  if (error) fail(`Firmware tests failed to run: ${error}`)
  return page.evaluate(() => {
    const report = window.__cortexStore.getState().firmwareTestResult.report
    return {
      exitCode: report.exitCode,
      results: report.results.map((r: any) => ({
        id: r.scenario?.id ?? r.scenarioPath, status: r.status,
        passed: (r.assertions ?? []).filter((a: any) => a.passed).length, total: (r.assertions ?? []).length
      }))
    }
  })
}

/** Closes the failed run's toast, as a person would, so it is not left beside the passing one. */
async function dismissNotification(page: Page, director: Director): Promise<void> {
  const close = page.locator('button[aria-label="Dismiss notification"]').first()
  if (await within(STEP_LIMIT_MS, 'Looking for a notification', close.isVisible())) await director.click(close, 'the old notification')
}

/** Clicks into the sketch where the fix goes and types it the way a person would. */
async function typeFix(page: Page, director: Director): Promise<void> {
  const target = await page.evaluate(() => {
    const editor = window.__cortexEditor ?? null
    if (!editor) return null
    const lines: string[] = editor.getModel().getValue().split(/\r?\n/)
    const index = lines.findIndex((line) => line.trim() === 'transition(reading < 400 ? HEATING : IDLE);')
    if (index < 0) return null
    const lineNumber = index + 1
    const column = lines[index].length - lines[index].trimStart().length + 1
    editor.revealLineInCenter(lineNumber)
    const at = editor.getScrolledVisiblePosition({ lineNumber, column })
    const rect = editor.getDomNode().getBoundingClientRect()
    return { lineNumber, column, x: rect.left + at.left + 2, y: rect.top + at.top + at.height / 2 }
  }) ?? fail('Could not find the line to fix in the editor')
  await sleep(400)
  await director.clickAt(target.x, target.y, 'the transition line')
  await page.evaluate(({ lineNumber, column }) => {
    window.__cortexEditor.setPosition({ lineNumber, column })
    window.__cortexEditor.focus()
  }, target)
  // Typing runs at whatever speed a busy machine allows; it is shown sped up, with its real duration.
  await director.fastForward('typing the fix', async () => {
    await director.type('if (reading < 100 || reading > 900) transition(INVALID);')
    await director.press('Escape')
    await director.press('Enter')
    await director.type('else ')
    await director.press('Escape')
  }, 3)
  const text = await page.evaluate(() => window.__cortexEditor.getModel().getValue() as string)
  const expected = '    if (reading < 100 || reading > 900) transition(INVALID);\n    else transition(reading < 400 ? HEATING : IDLE);'
  if (!text.replace(/\r\n/g, '\n').includes(expected)) fail(`The typed fix did not produce the expected code:\n${text}`)
  await director.press('Control+s')
  await waitFor(page, 'the fix to save', () => window.__cortexStore.getState().tabs.every((t: any) => t.content === t.savedContent), 15_000)
}

async function story(app: ElectronApplication, page: Page, timeline: Timeline, project: string): Promise<{ first: Awaited<ReturnType<typeof runTests>>; second: Awaited<ReturnType<typeof runTests>> }> {
  const director = new Director(page, timeline)
  // The OS folder picker cannot be recorded or scripted; answer it with the demo project.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [folder] })) as typeof dialog.showOpenDialog
  }, project)

  await installOverlay(page)
  timeline.mark('start')
  await director.caption('Cortex: write, simulate and test embedded firmware in one app')
  await sleep(1800)

  await director.caption('Open the example heater controller')
  await director.click(page.getByRole('button', { name: 'Open folder' }).first(), 'Open folder')
  await director.click(page.locator('[role="treeitem"][aria-label="controller.ino"]'), 'controller.ino')
  await waitFor(page, 'the sketch to open', () => String(window.__cortexStore.getState().activePath ?? '').endsWith('controller.ino'), 15_000)
  await sleep(1400)

  await director.caption('Run the sketch on a simulated 3D Arduino Uno')
  await director.click(page.locator('button[aria-label="Simulator"]'), 'Simulator')
  await director.click(page.locator('button[title="3D board view"]'), '3D view')
  const board = page.locator('canvas[data-engine^="three.js"]')
  await board.waitFor({ state: 'visible', timeout: 30_000 })
  await sleep(1000)
  await director.zoom(board, -480, 'the 3D board')
  await director.click(page.locator('button[title^="Simulate "]'), 'Run')
  await director.fastForward('g++ compiling the sketch', () => waitFor(page, 'the simulation to start', () => {
    const s = window.__cortexStore.getState()
    return s.simBlock || (s.simSerial ?? []).some((line: any) => String(line.text).includes('TIMEOUT'))
  }, 300_000))
  const block = await page.evaluate(() => window.__cortexStore.getState().simBlock)
  if (block) fail(`The simulator refused to run: ${JSON.stringify(block)}`)
  timeline.mark('sim-running')
  await director.caption('No sensor samples arrive, so it times out safely: heater off, fault LED on')
  await sleep(3000)
  await director.click(page.getByRole('button', { name: 'Stop', exact: true }), 'Stop')
  await waitFor(page, 'the simulation to stop', () => !window.__cortexStore.getState().simRunning, 20_000)

  await director.caption('Run the firmware test scenarios: timed sensor inputs, checked outputs')
  await director.click(page.locator('button[aria-label="Simulator"]'), 'back to the editor')
  await sleep(800)
  // A 720p window leaves the dock too short to read a report; make room the usual way.
  const dockHeight = await page.evaluate(() => window.__cortexStore.getState().bottomHeight as number)
  await director.dragBy(page.locator('[role="separator"][aria-label="Bottom panel"]'), dockHeight - 420, 'the panel splitter')
  const first = await runTests(page, director)
  const broken = first.results.find((r) => r.id === 'invalid-input')
  if (!broken || broken.status !== 'failed' || first.results.some((r) => r.id !== 'invalid-input' && r.status !== 'passed')) {
    fail(`Expected only invalid-input to fail on the buggy sketch: ${JSON.stringify(first)}`)
  }
  timeline.mark('tests-failed')
  await director.caption(`invalid-input fails ${broken.total - broken.passed} of ${broken.total} checks`)
  // Bring the assertion that shows the hazard into view, with its evidence.
  await page.evaluate(() => {
    const summary = Array.from(document.querySelectorAll('summary')).find((el) => el.textContent?.includes('invalid-low-shutdown'))
    summary?.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
  await sleep(1200)
  timeline.mark('evidence-shown')
  const evidence = await page.evaluate(() => {
    const result = window.__cortexStore.getState().firmwareTestResult.report.results.find((r: any) => r.scenario?.id === 'invalid-input')
    return result?.assertions.find((a: any) => a.id === 'invalid-low-shutdown')?.message as string | undefined
  })
  // The caption below restates this assertion; refuse to record if the report says otherwise.
  if (evidence !== 'pwm pin 9 at 430ms: expected 0, observed 180') fail(`Unexpected invalid-low-shutdown evidence: ${evidence}`)
  await director.caption('Sensor reads 0 at 420 ms, yet the heater PWM is still 180 at 430 ms (expected 0)')
  await sleep(4600)

  await director.caption('Fix it: treat readings outside 100 to 900 as a sensor fault')
  await typeFix(page, director)
  timeline.mark('fixed')
  await sleep(500)

  await director.caption('Run the same scenarios again')
  await dismissNotification(page, director)
  const second = await runTests(page, director)
  if (second.exitCode !== 0 || second.results.some((r) => r.status !== 'passed')) fail(`Expected every scenario to pass after the fix: ${JSON.stringify(second)}`)
  timeline.mark('tests-passed')
  const passed = second.results.reduce((n, r) => n + r.passed, 0)
  const total = second.results.reduce((n, r) => n + r.total, 0)
  await director.caption(`All ${second.results.length} scenarios pass: ${passed} of ${total} checks`)
  await sleep(3200)
  await director.caption(null)
  timeline.mark('end')
  return { first, second }
}

function ffmpeg(args: string[]): void {
  const run = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true, encoding: 'utf8' })
  if (run.status !== 0) fail(`ffmpeg failed: ${run.stderr || run.error?.message}`)
}

function probeDuration(file: string): number {
  const run = spawnSync(FFMPEG, ['-hide_banner', '-i', file, '-f', 'null', '-'], { windowsHide: true, encoding: 'utf8' })
  const times = [...(run.stderr || '').matchAll(/time=(\d+):(\d+):([\d.]+)/g)]
  const last = times.at(-1) ?? fail(`Could not read the duration of ${file}`)
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])
}

/** Normal-speed spans between the story marks, with each slow wait sped up to FAST_SECONDS. */
function cutList(timeline: Timeline, offset: number): Segment[] {
  const start = timeline.marks.start - offset
  const end = timeline.marks.end - offset
  const segments: Segment[] = []
  let cursor = start
  for (const wait of timeline.fast.map((f) => ({ ...f, start: f.start - offset, end: f.end - offset })).filter((f) => f.start >= start && f.end <= end)) {
    if (wait.start > cursor) segments.push({ start: cursor, end: wait.start, speed: 1 })
    segments.push({ start: wait.start, end: wait.end, speed: Math.max(1, (wait.end - wait.start) / wait.seconds) })
    cursor = wait.end
  }
  segments.push({ start: cursor, end, speed: 1 })
  return segments.filter((s) => s.end - s.start > 0.05)
}

function renderVideo(raw: string, segments: Segment[], out: string): { crf: number; fps: number; bytes: number } {
  const parts = segments.map((s, i) => `[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=(PTS-STARTPTS)/${s.speed.toFixed(4)}[v${i}]`)
  for (const [crf, fps] of [[23, 25], [26, 25], [29, 25], [29, 20], [32, 20], [35, 15]]) {
    const graph = `${parts.join(';')};${segments.map((_, i) => `[v${i}]`).join('')}concat=n=${segments.length}:v=1:a=0,fps=${fps},format=yuv420p[out]`
    ffmpeg(['-i', raw, '-filter_complex', graph, '-map', '[out]', '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf),
      '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out])
    const bytes = statSync(out).size
    if (bytes <= MP4_LIMIT) return { crf, fps, bytes }
  }
  fail(`${out} is still larger than 9 MB at the lowest quality step`)
}

function renderTeaser(raw: string, clips: Clip[], out: string): { width: number; fps: number; bytes: number } {
  const trims = clips.map((c, i) => `[0:v]trim=start=${c.start.toFixed(3)}:end=${c.end.toFixed(3)},setpts=PTS-STARTPTS[c${i}]`).join(';')
  const joined = `${clips.map((_, i) => `[c${i}]`).join('')}concat=n=${clips.length}:v=1:a=0`
  for (const [width, fps] of [[960, 10], [880, 10], [800, 10], [800, 8], [720, 8], [640, 8]]) {
    const graph = `${trims};${joined},fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`
    ffmpeg(['-i', raw, '-filter_complex', graph, '-loop', '0', out])
    const bytes = statSync(out).size
    if (bytes <= GIF_LIMIT) return { width, fps, bytes }
  }
  fail(`${out} is still larger than 5 MB at the smallest size step`)
}

async function main(): Promise<void> {
  if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) fail('Build the app first: npm run build')
  if (!works('g++', ['--version'])) fail('g++ is not on PATH; the simulator and firmware tests need a host compiler (see docs/FIRMWARE-TESTING.md)')
  if (!works(FFMPEG, ['-version'])) fail('ffmpeg is not on PATH. Install it (Windows: winget install Gyan.FFmpeg) or set FFMPEG to its path.')

  const work = mkdtempSync(join(tmpdir(), 'cortex-demo-'))
  const profile = join(work, 'profile')
  const videoDir = join(work, 'video')
  mkdirSync(videoDir)
  const project = prepareProject(work)
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined))
  delete env.ELECTRON_RUN_AS_NODE
  const cli = managedArduinoCli()
  // Windows spells it Path; adding a second PATH key would leave the child with two.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  if (cli) env[pathKey] = `${cli}${delimiter}${env[pathKey] ?? ''}`
  const electronBinary = join(REPO, 'node_modules', 'electron', 'dist', readFileSync(join(REPO, 'node_modules', 'electron', 'path.txt'), 'utf8').trim())

  console.log(`Recording in ${work}${cli ? `; reusing Arduino CLI from ${cli}` : ''}`)
  const app = await electron.launch({
    executablePath: electronBinary,
    // A throwaway profile keeps the user's settings and recent projects out of the video.
    // Scale factor 1 makes the 1280x720 window exactly 1280x720 pixels on any display.
    args: [join(REPO, 'out', 'main', 'index.js'), `--user-data-dir=${profile}`, '--force-device-scale-factor=1',
      '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
    cwd: REPO,
    env,
    recordVideo: { dir: videoDir, size: SIZE }
  })
  const log = createWriteStream(join(work, 'app.log'))
  app.process().stdout?.pipe(log)
  app.process().stderr?.pipe(log)
  // Electron's GPU and renderer children outlive a plain kill of the main process.
  const killApp = (): void => {
    const pid = app.process().pid
    if (!pid) return
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else app.process().kill('SIGKILL')
  }
  const watchdog = setTimeout(() => {
    console.error('The demo exceeded 20 minutes; stopping the app.')
    killApp()
    process.exit(1)
  }, 20 * 60_000)

  let closedAt = 0
  let outcome: Awaited<ReturnType<typeof story>> | null = null
  const page = await app.firstWindow()
  const timeline = new Timeline()
  page.on('close', () => { closedAt = Date.now() })
  page.on('console', (message) => { if (message.type() === 'error') log.write(`[renderer] ${message.text()}\n`) })
  page.on('pageerror', (error) => log.write(`[renderer exception] ${error.message}\n`))
  try {
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0]
      win.setContentSize(size.width, size.height)
      win.center()
    }, SIZE)
    await waitFor(page, 'the app to start', () => !!window.__cortexStore && !document.querySelector('.cortex-breathe'), 60_000)
    // Let first-launch work settle before the story starts; this pre-roll is cut.
    await waitFor(page, 'board tools setup', () => !window.__cortexStore.getState().boardSetupBusy, 300_000)
    await sleep(1500)
    for (const dismiss of await page.locator('button[aria-label="Dismiss notification"]').all()) {
      await within(STEP_LIMIT_MS, 'Dismissing a startup notification', dismiss.dispatchEvent('click'))
    }
    outcome = await story(app, page, timeline, project)
  } catch (error) {
    await within(STEP_LIMIT_MS, 'Saving a failure screenshot', page.screenshot({ path: join(work, 'failure.png') })).catch(() => {})
    throw error
  } finally {
    const closed = await within(60_000, 'Closing the app', app.close()).then(() => true, () => false)
    if (!closed) {
      killApp()
      console.error('The app did not close within 60 s; its video may be cut short.')
    }
    clearTimeout(watchdog)
  }
  const raw = await page.video()?.path() ?? fail('Playwright produced no video')
  if (!outcome) fail('The demo did not finish')

  // Recording starts slightly after the window opens. The video ends when the window
  // closes, so its length tells us exactly how far the timeline is offset.
  const duration = probeDuration(raw)
  const offset = Math.max(0, (closedAt - timeline.t0) / 1000 - duration)
  const segments = cutList(timeline, offset)
  mkdirSync(MEDIA, { recursive: true })
  const mp4 = renderVideo(raw, segments, join(MEDIA, 'cortex-demo.mp4'))
  const at = (name: string): number => timeline.marks[name] - offset
  const teaser = renderTeaser(raw, [
    { start: at('sim-running') + 0.5, end: at('sim-running') + 3.5 },
    { start: at('evidence-shown') + 0.3, end: at('evidence-shown') + 3.6 },
    { start: at('tests-passed') + 0.3, end: at('tests-passed') + 3.6 }
  ], join(MEDIA, 'cortex-teaser.gif'))
  const finalSeconds = segments.reduce((n, s) => n + (s.end - s.start) / s.speed, 0)

  const git = (args: string[]): string => spawnSync('git', args, { cwd: REPO, encoding: 'utf8' }).stdout.trim()
  const provenance = {
    recordedAt: new Date().toISOString(),
    commit: git(['rev-parse', 'HEAD']),
    // The outputs being written right now do not count as uncommitted source.
    dirtyWorktree: git(['status', '--porcelain', '--', '.', ':!docs/media']).length > 0,
    host: { platform: process.platform, release: release(), cpu: cpus()[0]?.model ?? 'unknown', node: process.version },
    compiler: spawnSync('g++', ['--version'], { encoding: 'utf8' }).stdout.split(/\r?\n/)[0],
    rawRecordingSeconds: Number(duration.toFixed(2)),
    finalVideoSeconds: Number(finalSeconds.toFixed(2)),
    fastForwarded: timeline.fast.map((w) => ({ what: w.label, realSeconds: Number((w.end - w.start).toFixed(2)), shownSeconds: Number(Math.min(w.end - w.start, w.seconds).toFixed(2)) })),
    firstRun: outcome.first,
    afterFix: outcome.second,
    mp4,
    teaser
  }
  writeFileSync(join(MEDIA, 'cortex-demo.json'), JSON.stringify(provenance, null, 2) + '\n')
  console.log(JSON.stringify(provenance, null, 2))
  if (!process.env.DEMO_KEEP) rmSync(work, { recursive: true, force: true })
  else console.log(`Kept the raw recording and logs in ${work}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
