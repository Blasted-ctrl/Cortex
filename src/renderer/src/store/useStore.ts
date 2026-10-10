import { create } from 'zustand'
import { flushCppAutoIncludes } from '../monaco/cppAutoInclude'
import type {
  FileNode,
  ToolchainInfo,
  RunOutputChunk,
  RunExit,
  RunDiagnostics,
  Diagnostic,
  SerialPortDescriptor,
  CppStandard,
  CStandard,
  ProjectConfig,
  ProjectModel,
  BoardStatus,
  BoardPort,
  BoardTarget,
  SimEvent,
  SimExit,
  AgentEvent
} from '@shared/ipc'
import { langFromPath, isHeaderPath, cDriver, cppDriver, type LanguageDef } from '@shared/languages'
import { normalizeEol, detectEol, withEol } from '@shared/diff'
import { appendConsoleEntry } from '@shared/consoleBuffer'
import { extractMissingHeaders, type EnvironmentReport } from '@shared/environment'
import { restorePlan, type LockCheck } from '@shared/lockfile'
import type { DatasheetHit, DatasheetDocMeta } from '@shared/datasheet'
import type { FirmwareTestRequest, FirmwareTestResponse } from '@shared/firmwareTest'
import { captureSession, decodeSessions, sessionPath, updateSessions, SESSION_STORAGE_KEY, type WorkspaceSession } from '@shared/workspaceSession'
import type { LspAvailability } from '@shared/lsp'
import type { DebugState, DebugOutput, FileReadResult } from '@shared/ipc'

const IDLE_DEBUG: DebugState = { status: 'idle', stack: [], frame: 0, variables: [] }
import { extractSeries } from '@shared/serialPlot'
import { isHostCpp, hostCppOrNull } from '@shared/security'
import { freeSpawnPoint, clampToSpace } from '@shared/simLayout'
import { PART_PINS, decodeSimDiagram, wiresFromParts, resolveCircuitParts, connectedBoardPins, defaultPartProps, updateStepper, advanceActuator,
  type SimBoardId, type SimPart, type SimPartType, type SimWire, type SimTerminal, type JumperKind, type StepperState, type ActuatorState } from '@shared/simCircuit'
export { PART_PINS } from '@shared/simCircuit'
export type { SimPart, SimPartType } from '@shared/simCircuit'
import {
  resolve as resolveGroups,
  addTab as addTabToGroups,
  focusPath as focusPathInGroups,
  focusInGroup as focusPathInGroup,
  focusGroup as focusGroupLayout,
  removeTab as removeTabFromGroups,
  moveTab as moveTabBetweenGroups,
  reorderTab as reorderTabInGroup,
  type ResolvedGroups
} from '@shared/editorGroups'

/** Spread only the store fields a group transition touches (drop the derived
 *  `split` flag, which the UI recomputes). */
function groupPatch(r: ResolvedGroups<Tab>): Pick<State, 'tabs' | 'activePath' | 'activeGroup' | 'groupActive'> {
  return { tabs: r.tabs, activePath: r.activePath, activeGroup: r.activeGroup, groupActive: r.groupActive }
}

/** Languages Cortex builds before it runs, so the status bar shows "Compiling"
 * first. Python/JS go straight to 'run'. */
const COMPILED_LANGS = new Set(['cpp', 'c', 'rust'])

export const isSketch = (path: string | null): boolean => !!path && path.toLowerCase().endsWith('.ino')

export type MainView = 'editor' | 'simulator' | 'settings'

/** Which board the 3D simulator view renders. A view preference, not project
 *  data, so it is not workspace-scoped. The engine still models an Uno. */
export type Sim3dBoardId = SimBoardId

/** Parts whose value the user drives to feed analogRead/digitalRead. */
export const INPUT_PARTS: SimPartType[] = ['potentiometer', 'ldr', 'thermistor']

/** Named pins each part exposes (order matters for connector layout). */

export interface WiringTarget {
  partId: string
  pinName: string
}

/**
 * The live pin snapshot. The canvas paints these with no simRunning gate, so
 * every path that ends a run must clear them or the board keeps asserting the
 * pin state of a process that no longer exists (a stopped blink left its LED
 * lit, and whether it did was a coin flip on where loop() happened to be).
 * Shared because there are three such paths and only startSim used to do it.
 */
const SIM_PIN_RESET = { simPinStates: {}, simPinPwm: {}, simPinModes: {}, simStepperStates: {}, simActuatorStates: {} } as const

/**
 * Part ids must be unique across sessions, not just within one. A per-session
 * counter minted `led-1` again after a restore of a saved `led-1`, and every
 * mutator matches by id across the whole array, so the duplicate broadcast:
 * dragging one LED moved both, deleting one deleted both. The default parts
 * used a third scheme (`led-13` = type-pin), which collided with the 13th LED
 * added in a fresh session.
 */
export const mintPartId = (type: string): string => `${type}-${crypto.randomUUID().slice(0, 8)}`

/**
 * A fresh rig: the onboard LED and a button, the two parts a blink or a
 * debounce sketch needs. A function, not a const, because opening another
 * workspace must reset to a new copy rather than share one mutable array.
 */
export const defaultSimParts = (): SimPart[] => [
  { id: mintPartId('led'), type: 'led', x: 470, y: 110, rotation: 0, color: '#E05561', pins: { sig: 13, gnd: -1 } },
  { id: mintPartId('button'), type: 'button', x: 175, y: 110, rotation: 0, pins: { sig: 2, gnd: -1 } }
]

/**
 * Everything that belongs to one project and must not survive into the next.
 *
 * Exported and named so it can be tested, because the bug this replaces was not
 * a mistake in the reset: it was that the reset listed seven keys and every
 * workspace-scoped key added afterwards was never added here. Opening a second
 * folder carried the first project's circuit, tabs, board target and live
 * processes into it, and saveDiagram then wrote project A's rig into project
 * B's .cortex/diagram.json.
 *
 * Add a key here whenever you add workspace-scoped state. The test in
 * test/workspaceReset.test.ts is what makes forgetting it fail loudly.
 */
export function workspaceScopedReset(): Record<string, unknown> {
  const parts = defaultSimParts()
  return {
    // tree
    childrenCache: {},
    expanded: new Set<string>(),
    // editor: tabs point at files under the old root, and fsService repoints
    // its write confinement on watchStart, so saving a carried tab is refused.
    tabs: [],
    activePath: null,
    activeGroup: 0,
    groupActive: {},
    reveal: null,
    // simulator
    simParts: parts,
    simWires: wiresFromParts(parts),
    sim3dBoard: 'uno',
    simDiagramDirty: false,
    simDiagramError: null,
    simDiagramSavedContent: undefined,
    simSerial: [],
    simInputs: {},
    simWiring: null,
    simBlock: null,
    ...SIM_PIN_RESET,
    simRunning: false,
    simRunId: null,
    // run
    running: false,
    runId: null,
    runPhase: 'idle' as const,
    runAction: null,
    lastExitCode: null,
    output: [],
    diagnostics: [],
    firmwareTestRunId: null,
    firmwareTestRunning: false,
    firmwareTestStopping: false,
    firmwareTestResult: null,
    firmwareTestError: null,
    // board target is per project (.cortex/config.json)
    selectedFqbn: '',
    // Derived from the old project's includes + board; re-inspected on demand.
    environmentReport: null,
    envLoading: false,
    // The lock belongs to the old project's .cortex; re-read on demand. lockBusy
    // and lockRestoring are cleared too, so a snapshot/restore in flight during a
    // switch cannot leave the new project's buttons stuck disabled.
    lockCheck: null,
    lockBusy: false,
    lockRestoring: false,
    // The imported document corpus and any query results belong to the old
    // project's .cortex; a switch must not carry them into the next project.
    datasheets: [],
    datasheetResults: [],
    datasheetQuery: '',
    datasheetBusy: false,
    // The agent transcript, staged edits, and conversation all reference the old
    // project's files, so a switch must not carry them (and any in-flight run's
    // events are dropped once agentRunId is cleared).
    agentRunning: false,
    agentRunId: null,
    agentStatus: '',
    agentLog: [],
    agentEdits: [],
    agentMessages: [],
    // Derived from the OLD workspace's files; refreshProjectModel rebuilds it
    // for the new one from openWorkspace, but a switch that never gets there
    // (an early return, a thrown readDir) should not leave the previous
    // project's board/pins showing under the new project's name.
    projectModel: null,
    // Also per project. loadProjectConfig reassigns it, but that returns early
    // when there is no workspace root, and a venv interpreter carried into the
    // next project would run its code under the wrong Python.
    projectPython: '',
    // NOT lspServers/lspBusy. Availability is a property of what is INSTALLED,
    // not of the project, and nothing re-probes it on a plain state reset: the
    // client probes once at startup, so zeroing it here left every language
    // badge reading "off" for the rest of the session after one workspace
    // switch. openWorkspace re-probes explicitly instead, which also clears a
    // crash lockout in main.
    debugRunId: null,
    // A gdb session belongs to the project that started it. Leaving it meant the
    // new runActive guard read a stale 'stopped' and refused every Run in the
    // NEW project, with the offending session belonging to a closed one.
    debug: { status: 'idle' as const, stack: [], frame: 0, variables: [] },
    breakpoints: {},
    // serial payloads are per session, not per project; the port itself is not
    serialLines: [],
    serialCarry: '',
    serialError: null,
    plotSeries: {}
  }
}

export interface RevealLocation {
  path: string
  line: number
  column: number
}

export type RunAction = 'run' | 'verify' | 'upload'

export interface Tab {
  path: string
  name: string
  content: string
  savedContent: string
  language: LanguageDef
  /**
   * Set when the file is not editable text (binary, or too large). The tab
   * shows a placeholder instead of mounting Monaco, which also means it can
   * never be dirtied and so can never be saved back over the original.
   */
  readOnlyReason?: string
  /** Which editor group (pane) this tab lives in: 0 (left, default) or 1
   *  (right, present only while the editor is split). See shared/editorGroups.ts. */
  group: number
}

export interface OutputLine {
  stream: 'stdout' | 'stderr' | 'system'
  text: string
}

export interface SerialLine {
  text: string
  ts: number
}

/** A simulator console line. `system` lines are ours (build errors, status),
 *  `serial` lines came from the sketch's Serial.print. Rendering a compile
 *  error as green Serial output is a lie about where it came from. */
export interface SimLine {
  text: string
  kind: 'serial' | 'system'
}

/** Why the simulator is blocked from running: a missing host C++ compiler (the
 *  simulator compiles on this machine), or a file that is not an Arduino sketch.
 *  `path` is the file the block was raised for, so the panel follows that file:
 *  switching to another tab reveals the canvas, and switching back shows the same
 *  (still-accurate) message rather than a stale one naming the wrong file. */
export type SimBlock =
  | { reason: 'compiler'; path: string }
  | { reason: 'not-sketch'; path: string; lines: string[] }

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

// ---- AI engineering agent (renderer view of a tool-loop run) --------------

/** One staged, not-yet-applied edit plus its review state. */
export interface AgentEdit {
  id: string
  path: string
  oldContent: string
  newContent: string
  summary?: string
  error?: string
  status: 'pending' | 'applying' | 'approved' | 'rejected' | 'failed' | 'stale'
}

/** An ordered transcript entry the agent panel renders. Tool calls are shown so
 *  the run is auditable; edits reference an entry in `agentEdits`. */
export type AgentEntry =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool'; tool: string; input: string; ok: boolean; result: string }
  | { type: 'edit'; editId: string }
  | { type: 'error'; text: string }

export interface AppSettings {
  theme: 'dark' | 'light'
  defaultCppCompiler: string
  defaultCppStandard: string
  pythonPath: string
  ai: {
    provider: 'anthropic' | 'openai' | 'gemini' | 'local' | 'custom' | 'none'
    model: string
    apiKey: string
    baseUrl: string
    apiKeySet?: boolean
  }
  serial: { baudRate: number }
  boards: { additionalUrls: string[] }
}

export type SidebarView =
  | 'explorer'
  | 'search'
  | 'boards'
  | 'libraries'
  | 'hardware'
  | 'environment'
  | 'debug'
  | 'serial'
  | 'vcs'
  | 'ai'

// What the right dock shows. Datasheets and the Agent are reference/assist
// surfaces that belong on the right, next to the editor; the right-edge rail
// toggles between them (or hides the dock with null).
export type RightView = 'agent' | 'datasheets' | null

/** A one-line async result surfaced as a toast + in the status-bar history. */
export interface AppNotification {
  id: string
  kind: 'success' | 'error' | 'info'
  title: string
  detail?: string
  ts: number
}
export type BottomView = 'output' | 'serial' | 'problems' | 'terminal' | 'tests'

let runCounter = 0
const nextRunId = (): string => `run-${++runCounter}`

// Promise resolver for the themed confirm dialog. Kept module-level (not in the
// store snapshot) so the store never holds a function; the host answers via
// answerConfirm(). Replaces native window.confirm, which renders an unthemed OS
// modal that breaks the Cortex identity.
let confirmResolver: ((ok: boolean) => void) | null = null

/** A pending themed confirmation. `danger` styles the confirm button as a
 *  destructive action. */
export interface ConfirmRequest {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}
export type ConfirmOptions = ConfirmRequest

// Latest-wins guard for environment inspects: a slow earlier inspect must not
// clobber the report of a newer one (e.g. after a board change).
let envInspectSeq = 0
let boardStatusSeq = 0
let boardSetupTask: Promise<void> | null = null
// Same guard for lock checks, which also re-run on a board change.
let lockCheckSeq = 0
// Latest-wins for datasheet queries, so a slow earlier query cannot clobber a
// newer one's results.
let datasheetQuerySeq = 0
/** Reopen only the monitor belonging to this upload, never a newly chosen port. */
let reopenSerialAfterUpload: { runId: string; workspaceRoot: string | null; port: string; operation: number } | null = null
let serialMonitorSeq = 0
// The file a Run/Verify/Upload targeted, captured at start so the completion
// notification names the right file even if the user has since switched tabs.
let runTargetFile = ''

/**
 * Shared setup for a streamed arduino-cli package operation (core/lib install,
 * remove, update-index): reveal the Output panel, mark the app busy, then run.
 * Completion arrives via handleRunExit (phase 'run'), which clears `running`.
 */
// A package op streams asynchronously: fn(id) only STARTS it, and completion
// arrives later as a RUN_EXIT event handled by handleRunExit. These waiters let
// runPackageOp resolve when the op actually FINISHES (not when it starts), so a
// caller can sequence several installs - handleRunExit resolves the waiter for
// the run id on every terminal exit.
const pkgOpWaiters = new Map<string, () => void>()
function resolvePkgOp(id: string): void {
  const w = pkgOpWaiters.get(id)
  if (w) {
    pkgOpWaiters.delete(id)
    w()
  }
}

async function runPackageOp(
  get: () => State,
  set: (partial: Partial<State>) => void,
  fn: (id: string) => Promise<void>
): Promise<void> {
  if (get().running || runStartToken) return
  const id = nextRunId()
  set({
    runId: id,
    running: true,
    runAction: null,
    runPhase: 'run',
    lastExitCode: null,
    output: [],
    diagnostics: [],
    bottomView: 'output',
    bottomVisible: true
  })
  const done = new Promise<void>((resolve) => pkgOpWaiters.set(id, resolve))
  try {
    await fn(id)
  } catch (err) {
    // The op never started, so no RUN_EXIT will come: resolve the waiter here so
    // a sequencing caller is not left hanging.
    resolvePkgOp(id)
    set({
      running: false,
      runPhase: 'idle',
      lastExitCode: 1,
      output: [{ stream: 'stderr', text: `Operation failed: ${String(err)}\n` }]
    })
    return
  }
  // Resolve on actual completion (RUN_EXIT), so `await installLib(...)` means the
  // install finished, not merely began.
  await done
}

interface State {
  // workspace / tree
  workspaceRoot: string | null
  workspaceName: string
  recents: RecentWorkspace[]
  removeRecent: (path: string) => void
  tree: FileNode[]
  childrenCache: Record<string, FileNode[]>
  expanded: Set<string>

  // editor
  tabs: Tab[]
  activePath: string | null
  /** 1-based cursor position in the focused editor, or null when none is focused. */
  cursorPos: { line: number; column: number } | null
  /** Which editor group has focus (0 or 1). activePath is always the active
   *  tab of this group. */
  activeGroup: number
  /** The active tab path within each group, so both panes remember their
   *  selection while the editor is split. */
  groupActive: Record<number, string | null>

  // layout
  mainView: MainView
  sim3dBoard: Sim3dBoardId
  sidebarView: SidebarView
  sidebarVisible: boolean
  bottomView: BottomView
  bottomVisible: boolean
  /** Which tool the right dock shows (Agent / Datasheets), or null when hidden. */
  rightView: RightView
  sidebarWidth: number
  aiWidth: number
  bottomHeight: number

  // simulator
  simRunId: string | null
  simRunning: boolean
  simPinStates: Record<number, number>
  simPinPwm: Record<number, boolean>
  simPinModes: Record<number, number>
  simParts: SimPart[]
  simWires: SimWire[]
  simWireKind: JumperKind
  simDiagramDirty: boolean
  simDiagramError: string | null
  simDiagramSavedContent: string | null | undefined
  simStepperStates: Record<string, StepperState>
  simActuatorStates: Record<string, ActuatorState>
  simWiring: WiringTarget | null // (part, pin) awaiting a board-pin click, or null
  simInputs: Record<number, number> // user-driven pin inputs (buttons, pots)
  simSerial: SimLine[]
  /** Why the simulator cannot run this sketch, shown as a friendly full-stage
   *  state (a missing host compiler, or a non-sketch file) instead of a cryptic
   *  serial line. Null when the sim can run. */
  simBlock: SimBlock | null
  /** True while recheckCompiler is re-scanning after a "no compiler" block. */
  simRechecking: boolean

  // toolchains + build config
  toolchains: ToolchainInfo[]
  compiler: string
  std: CppStandard
  optimization: string

  // derived project model: languages, board/platform, GPIO usage
  projectModel: ProjectModel | null

  // notifications: async results (build/upload done, etc.) surface here as
  // toasts + a status-bar history, instead of only in whichever panel was open.
  notifications: AppNotification[]
  notifUnread: number

  // run
  runId: string | null
  running: boolean
  runPhase: 'idle' | 'compile' | 'run'
  runAction: RunAction | null
  lastExitCode: number | null
  output: OutputLine[]
  diagnostics: Diagnostic[]
  firmwareTestRunId: string | null
  firmwareTestRunning: boolean
  firmwareTestStopping: boolean
  firmwareTestResult: FirmwareTestResponse | null
  firmwareTestError: string | null
  runFirmwareTests: (options?: Pick<FirmwareTestRequest, 'path' | 'replay' | 'firmware'>) => Promise<void>
  stopFirmwareTests: () => Promise<void>
  reveal: RevealLocation | null

  // language servers (which are installed; set once the editor initialises LSP)
  lspServers: LspAvailability
  setLspServers: (a: LspAvailability) => void
  /** Servers still loading/indexing: installed, but cannot answer yet. */
  lspBusy: Partial<Record<string, boolean>>
  setLspBusy: (lang: string, busy: boolean) => void

  // embedded boards
  boardStatus: BoardStatus | null
  boardSetupBusy: boolean
  boardSetupMessage: string
  boardSetupError: string | null
  environmentReport: EnvironmentReport | null
  envLoading: boolean
  /** A pending themed confirmation dialog, or null. Driven by confirm(). */
  confirmDialog: ConfirmRequest | null
  /** Show a themed confirm dialog and resolve true (confirmed) / false. Replaces
   *  window.confirm so destructive prompts match the Cortex identity. */
  confirm: (opts: ConfirmOptions) => Promise<boolean>
  /** The dialog host calls this with the user's choice. */
  answerConfirm: (ok: boolean) => void

  /** The stored environment lock paired with its drift, or null when there is
   *  no lock (reproducibility: see @shared/lockfile). */
  lockCheck: LockCheck | null
  lockBusy: boolean
  /** True while a restore-from-lock is installing the locked versions. */
  lockRestoring: boolean

  // datasheet / document intelligence
  /** Imported documents in this project (.cortex/datasheets manifest). */
  datasheets: DatasheetDocMeta[]
  /** The latest query's retrieved passages with citations. */
  datasheetResults: DatasheetHit[]
  datasheetQuery: string
  datasheetBusy: boolean
  boards: BoardPort[]
  boardTargets: BoardTarget[]
  selectedFqbn: string

  // serial
  ports: SerialPortDescriptor[]
  serialOpen: boolean
  serialPlot: boolean
  serialPath: string
  serialBaud: number
  serialLines: SerialLine[]
  serialCarry: string
  serialError: string | null
  plotSeries: Record<string, number[]>

  // ai
  chat: ChatMessage[]
  aiStreaming: boolean

  // ai engineering agent
  agentMode: boolean // panel shows the agent (task) view vs plain chat
  agentRunning: boolean
  agentRunId: string | null
  agentStatus: string // transient "Thinking..." line while running
  agentLog: AgentEntry[]
  agentEdits: AgentEdit[]
  agentMessages: ChatMessage[] // the conversation sent to the model

  // settings
  settings: AppSettings | null

  // ---- actions ----
  openWorkspace: (path: string) => Promise<void>
  /** Close the current folder and return to the Welcome screen, saving dirty
   *  tabs and tearing down the workspace's processes, watchers, and servers. */
  closeWorkspace: () => Promise<void>
  refreshTree: () => Promise<void>
  toggleDir: (node: FileNode) => Promise<void>
  openFile: (path: string) => Promise<void>
  setActive: (path: string) => void
  closeTab: (path: string) => Promise<void>
  /** Focus a tab within a specific editor group (a tab-strip click). */
  setActiveInGroup: (group: number, path: string) => void
  /** Make an editor group the focused one (a click inside its pane). */
  focusGroup: (group: number) => void
  /** Move a tab into another editor group. Moving to group 1 when it does not
   *  exist yet splits the editor; moving the last tab out of a group collapses
   *  it. This is the drag-to-split action. */
  moveTabToGroup: (path: string, group: number) => void
  /** Reorder a tab within its own group (drag-to-reorder). */
  reorderTab: (path: string, toIndex: number) => void
  updateContent: (path: string, content: string) => void
  /** Report the focused editor's cursor position for the status bar. */
  setCursor: (pos: { line: number; column: number } | null) => void
  /** Reflect a change made to a file outside the editor (e.g. a rename
   *  refactor that already rewrote it on disk): set the tab's content AND
   *  savedContent to the new text, so it shows the change and is not falsely
   *  marked dirty. No-op if the file has no open tab. */
  applyExternalEdit: (path: string, content: string) => void
  /** Re-sync every open tab with disk after the working tree changed underneath
   *  the editor (a branch switch): reload clean tabs, close ones whose file is
   *  gone. The caller must first ensure no tab has UNSAVED edits. */
  reloadOpenTabsFromDisk: () => Promise<void>
  reloadActiveFromDisk: () => Promise<void>
  saveActive: () => Promise<void>
  saveAll: () => Promise<void>
  renameEntry: (path: string, newName: string) => Promise<void>
  deleteEntry: (path: string) => Promise<void>
  createNewFile: (dir: string, name: string) => Promise<void>
  createNewFolder: (dir: string, name: string) => Promise<void>

  setMainView: (v: MainView) => void
  setSim3dBoard: (b: Sim3dBoardId) => void
  setSidebarWidth: (w: number) => void
  setAiWidth: (w: number) => void
  setBottomHeight: (h: number) => void
  setSidebar: (v: SidebarView) => void
  toggleSidebar: () => void
  setBottom: (v: BottomView) => void
  openTerminal: () => void
  toggleBottom: () => void
  /** Post a notification (toast + history). Generates id + timestamp. */
  notify: (kind: AppNotification['kind'], title: string, detail?: string) => void
  /** Mark the notification history as seen (clears the unread count). */
  markNotifsRead: () => void
  /** Clear the notification history. */
  clearNotifications: () => void
  setSerialPlot: (on: boolean) => void
  /** Toggle the Agent in the right dock (kept as toggleAi for its many callers). */
  toggleAi: () => void
  /** Show a tool in the right dock, or hide it when it is already showing. */
  setRightView: (v: 'agent' | 'datasheets') => void

  // simulator
  startSim: () => Promise<void>
  stopSim: () => Promise<void>
  /** Re-scan the toolchains after a "no compiler" block and, if one is now
   *  found, run the simulation. */
  recheckCompiler: () => Promise<void>
  handleSimEvent: (e: SimEvent) => void
  handleSimExit: (e: SimExit) => void
  advanceSimTime: (elapsedMs: number) => void
  addPart: (type: SimPartType) => void
  movePart: (id: string, x: number, y: number) => void
  rotatePart: (id: string) => void
  setPartColor: (id: string, color: string) => void
  setPartProps: (id: string, props: NonNullable<SimPart['props']>) => void
  setWireKind: (kind: JumperKind) => void
  removeWire: (id: string) => void
  connectTerminal: (terminal: SimTerminal) => void
  removePart: (id: string) => void
  beginWire: (partId: string, pinName: string) => void
  attachWire: (boardPin: number) => void
  cancelWire: () => void
  detachWire: (partId: string, pinName: string) => void
  setSimInput: (pin: number, value: number) => void
  setPartInput: (partId: string, value: number) => void
  setPartButton: (partId: string, pressed: boolean) => void
  saveDiagram: () => Promise<void>
  loadDiagram: () => Promise<void>
  importDiagram: (data: unknown) => void

  detectToolchains: (force?: boolean) => Promise<void>
  refreshProjectModel: () => Promise<void>
  setCompiler: (c: string) => void
  setStd: (s: CppStandard) => void
  setOptimization: (o: string) => void
  rustEdition: string
  setRustEdition: (e: string) => void
  cStd: CStandard
  setCStd: (s: CStandard) => void
  /** Per-project extra compiler flags from .cortex/config.json. */
  extraArgs: string[]
  /** Per-project Python interpreter (a venv), '' when the project pins none. */
  projectPython: string
  /** Id the debug build's diagnostics arrive under, so Problems accepts them. */
  debugRunId: string | null

  runActive: () => Promise<void>
  stopRun: () => Promise<void>
  clearOutput: () => void
  appendOutput: (c: RunOutputChunk) => void
  handleRunExit: (e: RunExit) => void
  handleDiagnostics: (d: RunDiagnostics) => void
  sendRunInput: (text: string) => Promise<void>
  revealLocation: (path: string, line: number, column: number) => Promise<void>
  clearReveal: () => void

  // project config
  loadProjectConfig: () => Promise<void>
  persistProjectConfig: (patch: ProjectConfig) => Promise<void>

  // embedded boards
  refreshBoardStatus: () => Promise<void>
  setupBoardTools: () => Promise<void>
  inspectEnvironment: (refresh?: boolean) => Promise<void>
  /** Load the stored lock and its drift against the current environment. */
  checkLock: () => Promise<void>
  /** Snapshot the current installed environment to the lockfile, then re-check. */
  snapshotEnvironment: () => Promise<void>
  /** Install the locked versions of every drifted core/library (through the same
   *  gated, streamed path as a user-triggered install), then re-check. */
  restoreFromLock: () => Promise<void>
  /** Open a native dialog to import a document into the project's corpus. */
  importDatasheet: () => Promise<void>
  /** Reload the imported-document list for the open project. */
  refreshDatasheets: () => Promise<void>
  /** Retrieve cited passages for a query (latest-wins). */
  queryDatasheets: (query: string) => Promise<void>
  refreshBoards: () => Promise<void>
  refreshBoardTargets: () => Promise<void>
  setFqbn: (fqbn: string) => void
  /** Pick a board and its upload/monitor port together (the toolbar selector). */
  setBoardAndPort: (fqbn: string, port: string) => void
  verifyBoard: () => Promise<void>
  uploadBoard: () => Promise<void>

  // Boards Manager (cores) + Library Manager. Search/list are read directly from
  // window.api by the panels; these run the streamed install/remove operations.
  installCore: (name: string, version?: string) => Promise<void>
  uninstallCore: (coreId: string) => Promise<void>
  updateCoreIndex: () => Promise<void>
  installLib: (name: string, version?: string) => Promise<void>
  uninstallLib: (name: string) => Promise<void>

  // debugger (gdb, host C/C++)
  debug: DebugState
  breakpoints: Record<string, number[]> // file path -> line numbers
  setDebug: (s: DebugState) => void
  appendDebugOutput: (o: DebugOutput) => void
  startDebug: () => Promise<void>
  stopDebug: () => void
  debugContinue: () => void
  debugStepOver: () => void
  debugStepInto: () => void
  debugStepOut: () => void
  debugPause: () => void
  selectDebugFrame: (level: number) => void
  toggleBreakpoint: (file: string, line: number) => void

  refreshPorts: () => Promise<void>
  toggleSerial: () => Promise<void>
  setSerialPath: (p: string) => void
  setSerialBaud: (b: number) => Promise<void>
  appendSerial: (data: string) => void
  clearSerial: () => void

  sendChat: (text: string, context?: string) => Promise<void>
  appendAiDelta: (delta: string) => void
  finishAi: (error?: string) => void

  setAgentMode: (on: boolean) => void
  runAgent: (text: string) => Promise<void>
  cancelAgent: () => void
  clearAgent: () => void
  handleAgentEvent: (e: AgentEvent) => void
  approveAgentEdit: (id: string) => Promise<void>
  rejectAgentEdit: (id: string) => void

  loadSettings: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  /** Switch and persist the app theme. App applies it to <html data-theme>. */
  setTheme: (theme: 'dark' | 'light') => Promise<void>
}

const baseName = (p: string): string => p.split(/[\\/]/).pop() || p

// ---- resizable layout -----------------------------------------------------
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v))
export const LAYOUT_LIMITS = {
  sidebar: { min: 180, max: 560 },
  ai: { min: 260, max: 620 },
  bottom: { min: 120, max: 640 }
}
function lsNum(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? v : fallback
  } catch {
    return fallback
  }
}
function lsSet(key: string, v: number): void {
  try {
    localStorage.setItem(key, String(v))
  } catch {
    /* storage unavailable */
  }
}
function lsBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}
function lsSetBool(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? '1' : '0')
  } catch {
    /* storage unavailable */
  }
}

/** A workspace the user has opened before. An IDE that forgets your project on
 *  every launch makes you re-pick it forever, and pushes your hand onto whatever
 *  button is nearest. */
export interface RecentWorkspace {
  path: string
  name: string
  ts: number
}
const RECENTS_KEY = 'cortex.recents'
export const LAST_WORKSPACE_KEY = 'cortex.lastWorkspace'
/** Windows names are case-insensitive; POSIX names need to remain distinct. */
export const normPath = (p: string): string => /^[a-z]:[\\/]/i.test(p) || /^(\\\\|\/\/)/.test(p)
  ? p.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '')
  : p.replace(/\/+$/, '')

function loadRecents(): RecentWorkspace[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    const v = raw ? JSON.parse(raw) : []
    if (!Array.isArray(v)) return []
    const seen = new Set<string>()
    return v.filter((entry): entry is RecentWorkspace => {
      if (!entry || typeof entry.path !== 'string' || !entry.path.trim() || typeof entry.name !== 'string' ||
        !Number.isFinite(entry.ts) || entry.ts < 0) return false
      const key = normPath(entry.path)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 8)
  } catch {
    return []
  }
}

let sessionRestoringRoot: string | null = null
let sessionInteractionEpoch = 0
let workspaceGeneration = 0
const directoryReadTokens = new Map<string, object>()
function savedSessions(): WorkspaceSession[] {
  try { return decodeSessions(localStorage.getItem(SESSION_STORAGE_KEY)) } catch { return [] }
}
function rememberSession(state: State): void {
  const session = captureSession(state)
  if (!session) return
  try { localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(updateSessions(savedSessions(), session))) } catch { /* Editing still works when local storage is full or unavailable. */ }
}

async function restoreSession(session: WorkspaceSession, baseline: State, interactionEpoch: number): Promise<void> {
  const root = baseline.workspaceRoot!
  const current = (): boolean => {
    const state = useStore.getState()
    return sessionInteractionEpoch === interactionEpoch && state.workspaceRoot === root && state.tree === baseline.tree && state.childrenCache === baseline.childrenCache && state.tabs === baseline.tabs && state.expanded === baseline.expanded &&
      state.activeGroup === baseline.activeGroup && state.groupActive === baseline.groupActive
  }
  if (!current()) return
  const tabs: Tab[] = []
  const expanded = new Set<string>()
  const childrenCache: Record<string, FileNode[]> = {}
  let bytes = 0
  let skipped = 0
  for (const entry of session.tabs) {
    if (!current()) return
    const path = sessionPath(root, entry.path)
    if (!path) continue
    try {
      const read = await window.api.readWorkspaceFile(root, path)
      if (!current()) return
      bytes += read.kind === 'text' ? new TextEncoder().encode(read.content).length : 0
      if (bytes > 32 * 1024 * 1024) { skipped += session.tabs.length - tabs.length; break }
      tabs.push({ path, name: baseName(path), ...readTabState(read), language: langFromPath(path), group: entry.group })
    } catch { skipped++ }
  }
  for (const entry of session.expanded) {
    if (!current()) return
    const path = sessionPath(root, entry)
    if (!path) continue
    try {
      childrenCache[path] = await window.api.readWorkspaceDir(root, path)
      if (!current()) return
      expanded.add(path)
    } catch { skipped++ }
  }
  if (!current()) return
  useStore.setState({ ...groupPatch(resolveGroups({ tabs, activeGroup: session.activeGroup, groupActive: {
    0: sessionPath(root, session.groupActive[0] ?? ''), 1: sessionPath(root, session.groupActive[1] ?? '')
  } })), expanded, childrenCache })
  if (skipped) useStore.getState().notify('info', 'Some saved project items were not reopened', `${skipped} missing, unreadable or oversized items were skipped. Files on disk were not changed.`)
}

const pendingSaves = new Map<string, Promise<void>>()
let simStartToken: object | null = null
let runStartToken: object | null = null
let treeRefreshToken: object | null = null

/** A save can outlive Stop or a project/target change. Reserve one preparation
 *  and revalidate its target before issuing any launch request. */
function beginRunPreparation(get: () => State, path: string): {
  isSaved: () => boolean
  ownsRun: (id: string) => boolean
  finish: () => void
} {
  const token = {}
  const workspaceRoot = get().workspaceRoot
  runStartToken = token
  return {
    isSaved: () => {
      const state = get()
      const tab = state.tabs.find((candidate) => candidate.path === path)
      return runStartToken === token && state.workspaceRoot === workspaceRoot && state.activePath === path &&
        !!tab && !tab.readOnlyReason && tab.content === tab.savedContent
    },
    ownsRun: (id) => runStartToken === token && get().workspaceRoot === workspaceRoot && get().runId === id,
    finish: () => { if (runStartToken === token) runStartToken = null }
  }
}

function queueFileSave(path: string, content: string): Promise<void> {
  const key = normPath(path)
  const previous = pendingSaves.get(key) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(async () => {
    try {
      const expected = useStore.getState().tabs.find((tab) => tab.path === path)?.savedContent
      await window.api.writeFile(path, content, expected)
      useStore.setState((state) => ({ tabs: state.tabs.map((tab) => tab.path === path ? { ...tab, savedContent: content } : tab) }))
    } catch (error) {
      useStore.getState().notify('error', `Could not save ${baseName(path)}`, `${error instanceof Error ? error.message : String(error)} Your changes are still open. Retry saving before closing.`)
      throw error
    }
  }).finally(() => {
    if (pendingSaves.get(key) === task) pendingSaves.delete(key)
  })
  pendingSaves.set(key, task)
  return task
}

let workspaceTransition: Promise<void> = Promise.resolve()
async function beginWorkspaceTransition(): Promise<() => void> {
  const previous = workspaceTransition
  let complete!: () => void
  workspaceTransition = new Promise<void>((resolve) => { complete = resolve })
  await previous
  return complete
}

function assertSavedWorkspace(state: Pick<State, 'tabs' | 'simDiagramDirty'>): void {
  if (state.simDiagramDirty || state.tabs.some((tab) => !tab.readOnlyReason && tab.content !== tab.savedContent)) {
    throw new Error('New edits were made while saving. Save your changes and try again.')
  }
}

function assertEntryName(name: string, parent: string): void {
  if (!name.trim() || name === '.' || name === '..' || /[\\/\x00-\x1f\x7f]/.test(name)) {
    throw new Error('Choose a file or folder name without path separators or control characters.')
  }
  const windows = /^[a-z]:[\\/]/i.test(parent) || /^(\\\\|\/\/)/.test(parent)
  if (windows && (/[<>:"|?*]|[. ]$/.test(name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))) {
    throw new Error('This name is not supported by Windows. Choose another file or folder name.')
  }
}

function readTabState(read: FileReadResult): Pick<Tab, 'content' | 'savedContent' | 'readOnlyReason'> {
  const content = read.kind === 'text' ? read.content : ''
  const readOnlyReason = read.kind === 'binary'
    ? 'This file is binary or is not valid UTF-8. Cortex will not edit it as text.'
    : read.kind === 'too-large'
      ? `This file is ${(read.size / (1024 * 1024)).toFixed(1)} MB, too large to open in the editor.`
      : undefined
  return { content, savedContent: content, readOnlyReason }
}

const initialSimParts = defaultSimParts()
export const useStore = create<State>((set, get) => ({
  workspaceRoot: null,
  workspaceName: '',
  recents: loadRecents(),
  tree: [],
  childrenCache: {},
  expanded: new Set(),

  tabs: [],
  activePath: null,
  cursorPos: null,
  activeGroup: 0,
  groupActive: {},

  mainView: 'editor',
  sim3dBoard: 'uno',
  sidebarView: 'explorer',
  sidebarVisible: true,
  bottomView: 'output',
  bottomVisible: true,
  // JetBrains-style: the AI assistant is a tool window you opt into, not
  // something that claims editor width before you've asked for it. Remembered
  // per-machine after that, the same way its width already is.
  rightView: ((): RightView => {
    const v = localStorage.getItem('cortex.rightView')
    if (v === 'agent' || v === 'datasheets') return v
    // A stored value that is neither (the '' written on close) is an explicit
    // "hidden" and must win, or a closed dock would never stick. Only when the
    // key was never written do we fall back to the legacy aiVisible flag,
    // carrying a previously-open AI panel over to the Agent dock.
    if (v !== null) return null
    return lsBool('cortex.aiVisible', false) ? 'agent' : null
  })(),
  sidebarWidth: lsNum('cortex.sidebarWidth', 256),
  aiWidth: lsNum('cortex.aiWidth', 320),
  bottomHeight: lsNum('cortex.bottomHeight', 256),

  simRunId: null,
  simRunning: false,
  simPinStates: {},
  simPinPwm: {},
  simPinModes: {},
  // Positions live in the SimCanvas design space (see W/H there).
  simParts: initialSimParts,
  simWires: wiresFromParts(initialSimParts),
  simWireKind: 'male-male',
  simDiagramDirty: false,
  simDiagramError: null,
  simDiagramSavedContent: undefined,
  simStepperStates: {},
  simActuatorStates: {},
  simWiring: null,
  simInputs: {},
  simSerial: [],
  simBlock: null,
  simRechecking: false,

  toolchains: [],
  projectModel: null,
  compiler: 'g++',
  std: 'c++23',
  rustEdition: '2021',
  cStd: 'c17',
  extraArgs: [],
  projectPython: '',
  debugRunId: null,
  optimization: '-O0',

  notifications: [],
  notifUnread: 0,

  runId: null,
  running: false,
  runPhase: 'idle',
  runAction: null,
  lastExitCode: null,
  output: [],
  diagnostics: [],
  firmwareTestRunId: null,
  firmwareTestRunning: false,
  firmwareTestStopping: false,
  firmwareTestResult: null,
  firmwareTestError: null,
  reveal: null,

  lspServers: { cpp: false, python: false, rust: false },
  // NOT workspace-scoped: dispose() pushes busy:false for a server it kills, and
  // a server KEPT across a re-open of the same folder is still indexing. Wiping
  // this here made the renderer disagree with main, with no resync path.
  lspBusy: {},
  setLspBusy: (lang, busy) => set({ lspBusy: { ...get().lspBusy, [lang]: busy } }),
  setLspServers: (lspServers) => set({ lspServers }),

  debug: IDLE_DEBUG,
  breakpoints: {},

  boardStatus: null,
  boardSetupBusy: false,
  boardSetupMessage: '',
  boardSetupError: null,
  boards: [],
  boardTargets: [],
  confirmDialog: null,
  environmentReport: null,
  envLoading: false,
  lockCheck: null,
  lockBusy: false,
  lockRestoring: false,
  datasheets: [],
  datasheetResults: [],
  datasheetQuery: '',
  datasheetBusy: false,
  selectedFqbn: '',

  ports: [],
  serialOpen: false,
  serialPlot: false,
  serialPath: '',
  serialBaud: 115200,
  serialLines: [],
  serialCarry: '',
  serialError: null,
  plotSeries: {},

  chat: [],
  aiStreaming: false,

  agentMode: lsBool('cortex.agentMode', true),
  agentRunning: false,
  agentRunId: null,
  agentStatus: '',
  agentLog: [],
  agentEdits: [],
  agentMessages: [],

  settings: null,

  async openWorkspace(path) {
    const complete = await beginWorkspaceTransition()
    try {
      const tree = await window.api.readDir(path)
      await get().saveAll()
      if (get().simDiagramDirty) await get().saveDiagram()
      assertSavedWorkspace(get())
      await get().stopRun()
      await get().stopSim()
      await get().stopFirmwareTests()
      get().stopDebug()
      get().cancelAgent()
      const previousRoot = get().workspaceRoot
      try {
        await window.api.watchStop()
        await window.api.watchStart(path)
        assertSavedWorkspace(get())
      } catch (error) {
        if (previousRoot) await window.api.watchStart(previousRoot)
        throw error
      }
      rememberSession(get())
      const session = savedSessions().find(entry => normPath(entry.root) === normPath(path))
      sessionRestoringRoot = path
      directoryReadTokens.clear()
      workspaceGeneration++
      set({ ...workspaceScopedReset(), workspaceRoot: path, workspaceName: baseName(path), tree })
      const sessionBaseline = get()
      const sessionEpoch = sessionInteractionEpoch
      window.__cortexTerminal?.dispose()
      void window.api.lspDisposeRoot(path)

      const entry: RecentWorkspace = { path, name: baseName(path), ts: Date.now() }
      const recents = [entry, ...get().recents.filter((r) => normPath(r.path) !== normPath(path))].slice(0, 8)
      set({ recents })
      try {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(recents))
        localStorage.setItem(LAST_WORKSPACE_KEY, path)
      } catch {
        /* storage unavailable */
      }

      await get().loadProjectConfig()
      await get().loadDiagram()
      if (session) await restoreSession(session, sessionBaseline, sessionEpoch)
      sessionRestoringRoot = null
      if (get().workspaceRoot === path) rememberSession(get())
      void get().refreshBoardStatus()
      void get().refreshProjectModel()
      void window.api.lspServers(true).then((a) => {
        if (get().workspaceRoot === path) set({ lspServers: a })
      })
    } finally {
      if (sessionRestoringRoot === path) sessionRestoringRoot = null
      complete()
    }
  },
  async closeWorkspace() {
    const complete = await beginWorkspaceTransition()
    try {
      const root = get().workspaceRoot
      if (!root) return
      await get().saveAll()
      if (get().simDiagramDirty) await get().saveDiagram()
      assertSavedWorkspace(get())
      await get().stopRun()
      await get().stopSim()
      await get().stopFirmwareTests()
      get().stopDebug()
      get().cancelAgent()
      try {
        await window.api.watchStop()
        assertSavedWorkspace(get())
      } catch (error) {
        await window.api.watchStart(root)
        throw error
      }
      void window.api.lspDisposeRoot(root)
      set({ ...workspaceScopedReset(), workspaceRoot: null, workspaceName: '', tree: [], mainView: 'editor' })
      window.__cortexTerminal?.dispose()
      try {
        localStorage.removeItem(LAST_WORKSPACE_KEY)
      } catch {
        /* storage unavailable */
      }
    } finally {
      complete()
    }
  },
  removeRecent(path) {
    const recents = get().recents.filter((r) => normPath(r.path) !== normPath(path))
    set({ recents })
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(recents))
    } catch {
      /* storage unavailable */
    }
  },

  async refreshTree() {
    directoryReadTokens.clear()
    const token = {}
    treeRefreshToken = token
    const { workspaceRoot, expanded, tree: previousTree } = get()
    if (!workspaceRoot) return
    const isCurrent = (): boolean => treeRefreshToken === token && get().workspaceRoot === workspaceRoot && get().tree === previousTree
    let tree: FileNode[]
    try {
      tree = await window.api.readDir(workspaceRoot)
    } catch (error) {
      if (isCurrent()) {
        get().notify('error', 'Could not refresh project files', `${error instanceof Error ? error.message : String(error)} Restore the project folder or check its permissions, then refresh. Your open files and last known file list were kept.`)
      }
      return
    }
    if (!isCurrent()) return
    const cache: Record<string, FileNode[]> = {}
    for (const dir of expanded) {
      try {
        cache[dir] = await window.api.readDir(dir)
      } catch {
        /* directory may have been removed */
      }
      if (!isCurrent()) return
    }
    if (isCurrent()) set({ tree, childrenCache: cache })
  },

  async toggleDir(node) {
    sessionInteractionEpoch++
    const { workspaceRoot, expanded, childrenCache } = get()
    const next = new Set(expanded)
    if (next.has(node.path)) {
      directoryReadTokens.delete(node.path)
      next.delete(node.path)
      set({ expanded: next })
    } else {
      next.add(node.path)
      set({ expanded: next })
      if (childrenCache[node.path]) return
      const token = {}
      directoryReadTokens.set(node.path, token)
      const current = (): boolean => get().workspaceRoot === workspaceRoot && directoryReadTokens.get(node.path) === token && get().expanded.has(node.path)
      try {
        const children = await window.api.readDir(node.path)
        if (current()) set({ childrenCache: { ...get().childrenCache, [node.path]: children } })
      } catch (error) {
        if (current()) {
          const remaining = new Set(get().expanded)
          remaining.delete(node.path)
          set({ expanded: remaining })
          get().notify('error', 'Could not open folder', String(error))
        }
      } finally {
        if (directoryReadTokens.get(node.path) === token) directoryReadTokens.delete(node.path)
      }
    }
  },

  async openFile(path) {
    sessionInteractionEpoch++
    const generation = workspaceGeneration
    const { tabs, workspaceRoot } = get()
    // Match case-insensitively / separator-insensitively so a diagnostic path
    // (forward slashes, from gcc) focuses the existing tab instead of duplicating.
    const existing = tabs.find((t) => normPath(t.path) === normPath(path))
    if (existing) {
      // Focus it in whichever group already holds it, and show the editor.
      set({ ...groupPatch(focusPathInGroups(get(), existing.path)), mainView: 'editor' })
      return
    }
    const read = await window.api.readFile(path)
    if (workspaceGeneration !== generation || get().workspaceRoot !== workspaceRoot) return
    // Re-read tabs AFTER the await: the captured list is stale if another file
    // was opened while this read was in flight, which would drop that tab.
    const raced = get().tabs.find((t) => normPath(t.path) === normPath(path))
    if (raced) {
      // Activate the tab's OWN path string. Consumers look tabs up with strict
      // equality, so activating a differently-spelled path (gcc's forward
      // slashes vs the explorer's backslashes) would blank the editor pane.
      set({ ...groupPatch(focusPathInGroups(get(), raced.path)), mainView: 'editor' })
      return
    }
    // addTab assigns the tab to (and focuses) whichever group is active, so a
    // file opened while the right pane has focus opens there.
    set({
      ...groupPatch(
        addTabToGroups(get(), { path, name: baseName(path), ...readTabState(read), language: langFromPath(path) })
      ),
      // Opening a file shows it: leave the Settings surface / Simulator.
      mainView: 'editor'
    })
  },

  setActive(path) {
    // Focusing a file returns to the editor: a file click from the explorer
    // while the Settings surface (or the Simulator) is up should show the file.
    set({ ...groupPatch(focusPathInGroups(get(), path)), mainView: 'editor' })
  },
  setCursor(pos) {
    // Skip no-op writes so a click that lands on the same spot does not churn
    // the store (the status bar subscribes to this).
    const cur = get().cursorPos
    if (cur?.line === pos?.line && cur?.column === pos?.column) return
    set({ cursorPos: pos })
  },

  setActiveInGroup(group, path) {
    set(groupPatch(focusPathInGroup(get(), group, path)))
  },

  focusGroup(group) {
    set(groupPatch(focusGroupLayout(get(), group)))
  },

  moveTabToGroup(path, group) {
    set(groupPatch(moveTabBetweenGroups(get(), path, group)))
  },

  reorderTab(path, toIndex) {
    set(groupPatch(reorderTabInGroup(get(), path, toIndex)))
  },

  async closeTab(path) {
    const root = get().workspaceRoot
    const generation = workspaceGeneration
    const pending = pendingSaves.get(normPath(path))
    if (pending) await pending.catch(() => {})
    if (workspaceGeneration !== generation || get().workspaceRoot !== root) return
    const closing = get().tabs.find((t) => t.path === path)
    if (!closing) return
    // Guard against silent data loss on unsaved edits (themed confirm).
    if (closing && closing.content !== closing.savedContent) {
      const ok = await get().confirm({
        title: 'Discard unsaved changes?',
        message: `"${closing.name}" has changes that haven't been saved. Discard them?`,
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true
      })
      if (!ok) return
    }
    if (workspaceGeneration !== generation || get().workspaceRoot !== root || get().tabs.find(tab => tab.path === path) !== closing) return
    set(groupPatch(removeTabFromGroups(get(), path)))
  },

  updateContent(path, content) {
    set({ tabs: get().tabs.map((t) => t.path === path ? {
      ...t, content: t.savedContent.startsWith('\ufeff') && !content.startsWith('\ufeff') ? '\ufeff' + content : content
    } : t) })
  },

  applyExternalEdit(path, content) {
    set({
      tabs: get().tabs.map((t) =>
        normPath(t.path) === normPath(path) ? { ...t, content, savedContent: content } : t
      )
    })
  },
  async reloadOpenTabsFromDisk() {
    // The working tree changed underneath the editor (a branch switch). Bring
    // each open tab back in sync with disk. The caller checks for unsaved edits
    // BEFORE the switch, but the editor stays live during the async checkout, so
    // re-check each tab LIVE here and NEVER overwrite one that is dirty now - a
    // clean tab is safe to adopt (and to close, since closeTab only saves dirty
    // tabs), a dirty one keeps the user's in-flight edit.
    const paths = get().tabs.map((t) => t.path)
    const live = (p: string): Tab | undefined => get().tabs.find((t) => normPath(t.path) === normPath(p))
    for (const p of paths) {
      const t0 = live(p)
      if (!t0 || t0.content !== t0.savedContent) continue // gone from the list, or edited during the switch
      let r: FileReadResult
      try {
        r = await window.api.readFile(p)
      } catch {
        await get().closeTab(p) // file no longer exists on the new tree
        continue
      }
      const t = live(p)
      if (!t || t.content !== t.savedContent) continue // became dirty during the read
      if (r.kind === 'text') {
        if (t.readOnlyReason) await get().closeTab(p) // was a placeholder, now editable text: drop the stale placeholder
        else get().applyExternalEdit(p, r.content) // clean editable text: adopt the new content
      } else if (!t.readOnlyReason) {
        // was editable text, now binary/too-large: the stale editable buffer
        // would overwrite the new file on save, so drop it (it is clean).
        await get().closeTab(p)
      }
      // else: still a read-only placeholder - leave it.
    }
  },

  async reloadActiveFromDisk() {
    const path = get().activePath
    if (!path) return
    const pending = pendingSaves.get(normPath(path))
    if (pending) await pending.catch(() => {})
    const tab = get().tabs.find((entry) => entry.path === path)
    if (!tab) return
    const root = get().workspaceRoot
    const read = await window.api.readFile(path)
    const current = (): Tab | undefined => get().tabs.find((entry) => entry.path === path)
    const assertUnchanged = (): void => {
      const live = current()
      if (!live || get().workspaceRoot !== root || live.content !== tab.content || live.savedContent !== tab.savedContent) {
        throw new Error('The editor changed while reloading. Your changes were kept. Retry reload when you are ready.')
      }
    }
    assertUnchanged()
    if (tab.content !== tab.savedContent && !await get().confirm({
      title: 'Reload from disk?',
      message: `Discard unsaved edits to "${tab.name}" and load the file currently on disk? This does not change the saved file.`,
      confirmLabel: 'Discard and reload',
      cancelLabel: 'Keep editing',
      danger: true
    })) return
    assertUnchanged()
    set({ tabs: get().tabs.map((entry) => entry.path === path ? { ...entry, ...readTabState(read) } : entry) })
  },

  async saveActive() {
    const pendingPath = get().activePath
    if (pendingPath) flushCppAutoIncludes(pendingPath)
    const { tabs, activePath } = get()
    const tab = tabs.find((t) => t.path === activePath)
    if (!tab) return
    // A binary/oversized tab holds '' (there is no editor to hold anything
    // else), so saving it would truncate the real file to zero bytes. Ctrl+S,
    // the File menu, the palette and every run/debug/upload path call this, so
    // the refusal has to live here rather than in the editor.
    if (tab.readOnlyReason) return
    // Mark clean against the content we actually WROTE. Reading t.content after
    // the await would mark keystrokes made during the write as saved, and the
    // dirty-close guard would then stay silent while they are lost.
    const written = tab.content
    await queueFileSave(tab.path, written)
  },

  async saveAll() {
    flushCppAutoIncludes()
    const pending = [...pendingSaves.values()]
    const written = get()
      .tabs.filter((t) => !t.readOnlyReason && t.content !== t.savedContent)
      .map((t) => ({ path: t.path, content: t.content }))
    const results = await Promise.allSettled([...pending, ...written.map((w) => queueFileSave(w.path, w.content))])
    const failed = results.find((result) => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  },

  async renameEntry(path, newName) {
    assertEntryName(newName, path)
    await Promise.all([...pendingSaves].filter(([key]) => key === normPath(path) || key.startsWith(normPath(path) + '/')).map(([, save]) => save))
    const sep = path.includes('\\') ? '\\' : '/'
    const dir = path.replace(/[\\/][^\\/]+$/, '')
    const newPath = dir + sep + newName
    await window.api.rename(path, newPath)
    // Update any open tabs for the renamed file, or files under a renamed folder.
    const tabs = get().tabs.map((t) => {
      if (normPath(t.path) === normPath(path)) return { ...t, path: newPath, name: newName }
      if (normPath(t.path).startsWith(normPath(path) + '/')) {
        const np = newPath + t.path.slice(path.length)
        return { ...t, path: np, name: baseName(np) }
      }
      return t
    })
    // The panes render groupActive, not activePath, so the per-group active
    // paths have to follow the rename too. Remap them (file and files under a
    // renamed folder) and re-resolve so both panes point at the renamed tabs.
    const remap = (p: string | null): string | null => {
      if (!p) return p
      if (normPath(p) === normPath(path)) return newPath
      if (normPath(p).startsWith(normPath(path) + '/')) return newPath + p.slice(path.length)
      return p
    }
    const groupActive = { 0: remap(get().groupActive[0] ?? null), 1: remap(get().groupActive[1] ?? null) }
    set(groupPatch(resolveGroups({ tabs, activeGroup: get().activeGroup, groupActive })))
    await get().refreshTree()
  },
  async deleteEntry(path) {
    await Promise.all([...pendingSaves].filter(([key]) => key === normPath(path) || key.startsWith(normPath(path) + '/')).map(([, save]) => save))
    await window.api.deletePath(path)
    const remaining = get().tabs.filter(
      (t) => normPath(t.path) !== normPath(path) && !normPath(t.path).startsWith(normPath(path) + '/')
    )
    // Re-resolve so a deleted active tab, an emptied group, or a stale
    // active-group index are all repaired (rather than resurfacing as a blank
    // pane or a phantom re-split on the next open).
    set(groupPatch(resolveGroups({ tabs: remaining, activeGroup: get().activeGroup, groupActive: get().groupActive })))
    await get().refreshTree()
  },
  async createNewFile(dir, name) {
    assertEntryName(name, dir)
    const sep = dir.includes('\\') ? '\\' : '/'
    const p = dir + sep + name
    await window.api.createFile(p)
    await get().refreshTree()
    await get().openFile(p)
  },
  async createNewFolder(dir, name) {
    assertEntryName(name, dir)
    const sep = dir.includes('\\') ? '\\' : '/'
    await window.api.createDir(dir + sep + name)
    await get().refreshTree()
  },

  setMainView(v) {
    set({ mainView: v })
  },
  setSim3dBoard(b) {
    if (b === get().sim3dBoard) return
    if (get().simRunning) { get().notify('info', 'Stop the simulation before changing the board model.'); return }
    if (get().simWires.length && !window.confirm('Changing the board clears circuit wiring because GPIO numbers can mean different physical pins. Continue?')) return
    set({ sim3dBoard: b, simWires: [], simParts: resolveCircuitParts(get().simParts, []), simWiring: null, simDiagramDirty: true, ...SIM_PIN_RESET })
  },
  setSidebarWidth(w) {
    const v = clamp(Math.round(w), LAYOUT_LIMITS.sidebar.min, LAYOUT_LIMITS.sidebar.max)
    set({ sidebarWidth: v })
    lsSet('cortex.sidebarWidth', v)
  },
  setAiWidth(w) {
    const v = clamp(Math.round(w), LAYOUT_LIMITS.ai.min, LAYOUT_LIMITS.ai.max)
    set({ aiWidth: v })
    lsSet('cortex.aiWidth', v)
  },
  setBottomHeight(h) {
    const v = clamp(Math.round(h), LAYOUT_LIMITS.bottom.min, LAYOUT_LIMITS.bottom.max)
    set({ bottomHeight: v })
    lsSet('cortex.bottomHeight', v)
  },
  setSidebar(v) {
    const { sidebarView, sidebarVisible } = get()
    // The sidebar is a column of its own: App renders it next to whichever main
    // view is up, so it is on screen in the Simulator too and its visibility has
    // nothing to do with mainView. Clicking the panel you are already looking at
    // collapses it; anything else opens that panel where you are, without
    // yanking you back to the editor.
    if (sidebarView === v && sidebarVisible) set({ sidebarVisible: false })
    else set({ sidebarView: v, sidebarVisible: true })
  },
  toggleSidebar() {
    set({ sidebarVisible: !get().sidebarVisible })
  },
  setSerialPlot(on) {
    set({ serialPlot: on })
  },
  setBottom(v) {
    // The bottom dock only renders in the editor view, so every entry point that
    // reveals a dock tab (rail Problems, the serial accelerator, the toolbar
    // chips) must leave the Settings surface / Simulator first, the way
    // openTerminal already does - otherwise the click silently flips state with
    // nothing on screen.
    set({ mainView: 'editor', bottomView: v, bottomVisible: true })
  },
  openTerminal() {
    // The bottom dock (and the terminal) only render in the editor view of an
    // open workspace, so every terminal entry point routes through here: leave
    // the simulator first, and no-op with no workspace (the menu item that
    // advertises it is disabled in that state). Without this, Ctrl+`, the Tools
    // item, and the palette command silently did nothing from the simulator or
    // the Welcome screen.
    if (!get().workspaceRoot) return
    set({ mainView: 'editor', bottomView: 'terminal', bottomVisible: true })
  },
  toggleBottom() {
    set({ bottomVisible: !get().bottomVisible })
  },
  notify(kind, title, detail) {
    const n: AppNotification = { id: `n-${performance.now()}`, kind, title, detail, ts: Date.now() }
    // Newest first; cap the log so a long session cannot grow it without bound.
    set({ notifications: [n, ...get().notifications].slice(0, 50), notifUnread: get().notifUnread + 1 })
  },
  markNotifsRead() {
    if (get().notifUnread !== 0) set({ notifUnread: 0 })
  },
  clearNotifications() {
    set({ notifications: [], notifUnread: 0 })
  },
  toggleAi() {
    const v: RightView = get().rightView === 'agent' ? null : 'agent'
    set({ rightView: v })
    localStorage.setItem('cortex.rightView', v ?? '')
  },
  setRightView(v) {
    const next: RightView = get().rightView === v ? null : v
    set({ rightView: next })
    localStorage.setItem('cortex.rightView', next ?? '')
  },

  async startSim() {
    const { tabs, activePath, workspaceRoot, simRunning } = get()
    if (simRunning || simStartToken || !activePath) return
    const tab = tabs.find((t) => t.path === activePath)
    if (!tab) return
    const token = {}
    simStartToken = token
    const isCurrent = (): boolean => simStartToken === token && get().workspaceRoot === workspaceRoot &&
      get().activePath === activePath && get().tabs.some((entry) => entry.path === activePath)
    try {
      // Detection and saving can finish after the user closes this project or
      // selects another file. A cancelled start must not launch its old target.
      if (get().toolchains.length === 0) await get().detectToolchains()
      if (!isCurrent()) return
      const cpp = get().toolchains.find((t) => t.available && isHostCpp(t.command))
      if (!cpp) {
        set({ mainView: 'simulator', simBlock: { reason: 'compiler', path: activePath }, simSerial: [] })
        return
      }
      const currentTab = get().tabs.find((entry) => entry.path === activePath)
      if (!currentTab) return
      const hasMain = /^\s*(int|void)\s+main\s*\(/m.test(currentTab.content)
      const hasSetupLoop = /\bvoid\s+setup\s*\(/.test(currentTab.content) && /\bvoid\s+loop\s*\(/.test(currentTab.content)
      if (!isSketch(activePath) && (hasMain || !hasSetupLoop)) {
        set({
          mainView: 'simulator',
          simSerial: [],
          simBlock: {
            reason: 'not-sketch',
            path: activePath,
            lines: [
              `Cannot simulate ${currentTab.name}.`,
              'The simulator runs Arduino sketches: a file with setup() and loop() and no main().',
              'Open a .ino sketch and press Run, or use New sketch on the Welcome screen to get one.'
            ]
          }
        })
        return
      }
      await get().saveActive()
      if (!isCurrent()) return
      const savedTab = get().tabs.find((entry) => entry.path === activePath)
      // A save can finish while the user is typing or the file becomes
      // read-only. Do not run an older disk snapshot under newer editor text.
      if (!savedTab || savedTab.readOnlyReason || savedTab.content !== savedTab.savedContent) return
      const id = `sim-${crypto.randomUUID()}`
      const cwd = workspaceRoot || activePath.replace(/[\\/][^\\/]+$/, '')
      set({
        simRunId: id,
        simRunning: true,
        ...SIM_PIN_RESET,
        simInputs: {},
        simSerial: [],
        simBlock: null,
        mainView: 'simulator'
      })
      try {
        await window.api.simStart({ id, filePath: activePath, cwd, compiler: get().compiler })
        if (simStartToken !== token || get().workspaceRoot !== workspaceRoot || get().simRunId !== id) await window.api.simStop(id)
      } catch (err) {
        if (simStartToken === token && get().workspaceRoot === workspaceRoot && get().simRunId === id) {
          set({ simRunning: false, simRunId: null, ...SIM_PIN_RESET, simSerial: [{ text: `Failed to start simulation: ${String(err)}`, kind: 'system' }] })
        }
      }
    } finally {
      if (simStartToken === token) simStartToken = null
    }
  },
  async recheckCompiler() {
    set({ simRechecking: true })
    // Force a fresh scan: a user who just installed a compiler needs the cached
    // detection cleared, exactly what Rescan does.
    await get().detectToolchains(true)
    set({ simRechecking: false })
    const cpp = get().toolchains.find((t) => t.available && isHostCpp(t.command))
    // Found one: clear the block and run. Still missing: leave the guidance up.
    if (cpp) {
      set({ simBlock: null })
      await get().startSim()
    }
  },
  async stopSim() {
    simStartToken = null
    const { simRunId } = get()
    if (simRunId) await window.api.simStop(simRunId)
    // simRunId deliberately survives: the sketch is still flushing its last
    // Serial output in response to @stop, and handleSimEvent/handleSimExit both
    // drop events whose id does not match, so clearing it here threw that
    // output away. handleSimExit clears it when the process is actually gone.
    if (get().simRunId === simRunId) set({ simRunning: false, ...SIM_PIN_RESET })
  },
  handleSimEvent(e) {
    if (e.id !== get().simRunId) return
    if (e.kind === 'mode') {
      const modes = { ...get().simPinModes, [e.pin]: e.value }
      set({ simPinModes: modes, simParts: resolveCircuitParts(get().simParts, get().simWires, modes) })
    } else if (e.kind === 'pin') {
      set({
        simPinStates: { ...get().simPinStates, [e.pin]: e.value },
        simPinPwm: { ...get().simPinPwm, [e.pin]: false }
      })
    } else if (e.kind === 'pwm') {
      set({
        simPinStates: { ...get().simPinStates, [e.pin]: e.value },
        simPinPwm: { ...get().simPinPwm, [e.pin]: true }
      })
    } else if (e.kind === 'tone') {
      // Buzzer: nonzero frequency = sounding.
      set({ simPinStates: { ...get().simPinStates, [e.pin]: e.value > 0 ? 1 : 0 }, simPinPwm: { ...get().simPinPwm, [e.pin]: false } })
    } else if (e.kind === 'serial' || e.kind === 'system') {
      set({ simSerial: appendConsoleEntry(get().simSerial, { text: e.text, kind: e.kind }, 500) })
    }
    if (e.kind === 'pin') {
      const states = { ...get().simStepperStates }
      for (const part of get().simParts) if (part.type === 'stepper') states[part.id] = updateStepper(part, states[part.id] ?? { steps: 0, lastStep: 0 }, e, get().simPinStates)
      set({ simStepperStates: states })
    }
  },
  advanceSimTime(elapsedMs) {
    if (!get().simRunning || !Number.isFinite(elapsedMs) || elapsedMs < 0) return
    const states = { ...get().simActuatorStates }
    for (const part of get().simParts) if (part.type === 'actuator') states[part.id] = advanceActuator(part, states[part.id] ?? { positionMm: 0, atMin: true, atMax: false }, elapsedMs, get().simPinStates, get().simPinPwm)
    set({ simActuatorStates: states })
  },
  handleSimExit(e) {
    if (e.id !== get().simRunId) return
    // This is the common path (natural exit and compile failure both land
    // here), so it must clear everything stopSim does.
    set({ simRunning: false, simRunId: null, ...SIM_PIN_RESET })
  },
  addPart(type) {
    if (!PART_PINS[type]) return
    if (get().simParts.length >= 256) { get().notify('error', 'Circuit limit reached', 'A circuit can contain at most 256 parts.'); return }
    const id = mintPartId(type)
    const color = type === 'led' ? '#6FB65A' : type === 'rgb' ? '#C58BE6' : undefined
    const pins = Object.fromEntries(PART_PINS[type].map((name) => [name, null]))
    set({
      simParts: [
        ...get().simParts,
        { id, type, ...freeSpawnPoint(get().simParts), rotation: 0, color, pins, props: defaultPartProps(type) }
      ],
      simDiagramDirty: true
    })
  },
  movePart(id, x, y) {
    // Clamped like every other producer of a part position. Pointer capture
    // keeps a drag alive outside the SVG, so raw coordinates could strand a
    // part where it is invisible and unclickable, and saveDiagram would then
    // write that to disk.
    const at = clampToSpace({ x, y })
    set({ simParts: get().simParts.map((p) => (p.id === id ? { ...p, ...at } : p)), simDiagramDirty: true })
  },
  rotatePart(id) {
    set({ simParts: get().simParts.map((p) => (p.id === id ? { ...p, rotation: (p.rotation + 90) % 360 } : p)), simDiagramDirty: true })
  },
  setPartColor(id, color) {
    set({ simParts: get().simParts.map((p) => (p.id === id ? { ...p, color } : p)), simDiagramDirty: true })
  },
  setPartProps(id, props) {
    try {
      const diagram = decodeSimDiagram({ version: 3, board: get().sim3dBoard, parts: get().simParts.map((p) => p.id === id ? { ...p, props: { ...p.props, ...props } } : p), wires: get().simWires })
      set({ simParts: resolveCircuitParts(diagram.parts, diagram.wires, get().simPinModes), simDiagramDirty: true })
    } catch (err) { get().notify('error', 'Invalid part setting', String(err)) }
  },
  setWireKind(kind) { set({ simWireKind: kind }) },
  removeWire(id) {
    const wires = get().simWires.filter((w) => w.id !== id)
    set({ simWires: wires, simParts: resolveCircuitParts(get().simParts, wires, get().simPinModes), simDiagramDirty: true })
  },
  removePart(id) {
    const wires = get().simWires.filter((w) => !(w.from.kind === 'part' && w.from.partId === id) && !(w.to.kind === 'part' && w.to.partId === id))
    set({
      simParts: resolveCircuitParts(get().simParts.filter((p) => p.id !== id), wires, get().simPinModes),
      simWires: wires,
      simDiagramDirty: true,
      simWiring: get().simWiring?.partId === id ? null : get().simWiring
    })
  },
  beginWire(partId, pinName) {
    const part = get().simParts.find((p) => p.id === partId)
    if (!part || !PART_PINS[part.type].includes(pinName)) return
    const w = get().simWiring
    if (w && !(w.partId === partId && w.pinName === pinName)) { get().connectTerminal({ kind: 'part', partId, pin: pinName }); return }
    set({ simWiring: w && w.partId === partId && w.pinName === pinName ? null : { partId, pinName } })
  },
  attachWire(boardPin) {
    get().connectTerminal({ kind: 'board', pin: boardPin })
  },
  connectTerminal(terminal) {
    const w = get().simWiring
    if (!w) return
    const from: SimTerminal = { kind: 'part', partId: w.partId, pin: w.pinName }
    if (JSON.stringify(from) === JSON.stringify(terminal)) { get().cancelWire(); return }
    const wires = [...get().simWires, { id: crypto.randomUUID(), from, to: terminal, kind: get().simWireKind }]
    try {
      const diagram = decodeSimDiagram({ version: 3, board: get().sim3dBoard, parts: get().simParts, wires })
      set({ simParts: resolveCircuitParts(diagram.parts, diagram.wires, get().simPinModes), simWires: diagram.wires, simWiring: null, simDiagramDirty: true })
    } catch (err) { get().notify('error', 'Cannot connect', String(err)) }
  },
  cancelWire() {
    set({ simWiring: null })
  },
  detachWire(partId, pinName) {
    const wires = get().simWires.filter((w) => !(w.from.kind === 'part' && w.from.partId === partId && w.from.pin === pinName) && !(w.to.kind === 'part' && w.to.partId === partId && w.to.pin === pinName))
    set({
      simWires: wires, simParts: resolveCircuitParts(get().simParts, wires, get().simPinModes), simDiagramDirty: true
    })
  },
  setSimInput(pin, value) {
    if (!Number.isInteger(pin) || pin < 0 || pin > 63 || !Number.isFinite(value)) return
    value = Math.max(0, Math.min(1023, Math.round(value)))
    set({ simInputs: { ...get().simInputs, [pin]: value } })
    const { simRunId, simRunning } = get()
    if (simRunning && simRunId) void window.api.simInput(simRunId, pin, value)
  },
  setPartInput(partId, value) {
    const part = get().simParts.find((p) => p.id === partId)
    if (!part || (!INPUT_PARTS.includes(part.type) && part.type !== 'button')) return
    for (const pin of connectedBoardPins(get().simParts, get().simWires, { kind: 'part', partId, pin: 'sig' })) get().setSimInput(pin, value)
  },
  setPartButton(partId, pressed) {
    const part = get().simParts.find((p) => p.id === partId && p.type === 'button')
    if (!part) return
    // A grounded switch closes to LOW independently of the input mode.
    // Released plain INPUT is floating: do not manufacture a HIGH reading.
    if (part.pins.gnd !== -1) {
      get().notify('info', 'Button needs GND', 'Connect the button ground terminal to board GND. Use INPUT_PULLUP for a defined released state.')
      return
    }
    for (const pin of connectedBoardPins(get().simParts, get().simWires, { kind: 'part', partId, pin: 'sig' })) {
      if (get().simPinModes[pin] === 1) continue
      if (pressed) get().setSimInput(pin, 0)
      else if (get().simPinModes[pin] === 2) get().setSimInput(pin, 1023)
    }
  },
  async saveDiagram() {
    const root = get().workspaceRoot
    if (!root) throw new Error('Open a folder to save your circuit.')
    if (get().simDiagramError && !window.confirm('The saved circuit could not be loaded. Replace that file with the current circuit?')) throw new Error('Circuit save cancelled; the original file was preserved.')
    const sep = root.includes('\\') ? '\\' : '/'
    const dir = `${root}${sep}.cortex`
    const file = `${dir}${sep}diagram.json`
    const key = normPath(file)
    // Derived runtime GPIO bindings are not layout edits. Persist canonical
    // graph bindings so pinMode events cannot turn a successful save dirty.
    const snapshot = JSON.stringify({ version: 3, board: get().sim3dBoard, parts: resolveCircuitParts(get().simParts, get().simWires), wires: get().simWires }, null, 2)
    const previous = pendingSaves.get(key) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      try {
        if (get().workspaceRoot !== root) throw new Error('The project changed before the circuit could be saved.')
        decodeSimDiagram(JSON.parse(snapshot))
        let expected = get().simDiagramSavedContent
        if (expected === undefined) {
          if (!await window.api.exists(file)) expected = null
          else {
            const read = await window.api.readFile(file)
            if (read.kind !== 'text') throw new Error('The saved circuit is not readable UTF-8 text. Its file was preserved.')
            expected = read.content
          }
        }
        if (get().workspaceRoot !== root) throw new Error('The project changed before the circuit could be saved.')
        await window.api.createDir(dir)
        await window.api.writeFile(file, snapshot, expected)
        if (get().workspaceRoot === root) {
          const current = JSON.stringify({ version: 3, board: get().sim3dBoard, parts: resolveCircuitParts(get().simParts, get().simWires), wires: get().simWires }, null, 2)
          set({ simDiagramDirty: current !== snapshot, simDiagramError: null, simDiagramSavedContent: snapshot })
          if (current !== snapshot) throw new Error('The circuit changed while saving. Save again before closing.')
        }
      } catch (err) { get().notify('error', 'Circuit save failed', String(err)); throw err }
    }).finally(() => {
      if (pendingSaves.get(key) === task) pendingSaves.delete(key)
    })
    pendingSaves.set(key, task)
    await task
  },
  async loadDiagram() {
    const root = get().workspaceRoot
    if (!root) return
    const sep = root.includes('\\') ? '\\' : '/'
    const file = `${root}${sep}.cortex${sep}diagram.json`
    // Authoritative: every path must land on a definite set of parts. Returning
    // early left whatever the previous project had on the canvas, and
    // saveDiagram would then write those parts into this project's file.
    // A workspace with no diagram is the common case, not an error. Probing
    // first keeps it off the throw path (and out of the main process log).
    try {
      const exists = await window.api.exists(file)
      if (get().workspaceRoot !== root) return
      if (!exists) {
        const parts = defaultSimParts()
        set({ simParts: parts, simWires: wiresFromParts(parts), sim3dBoard: 'uno', simDiagramDirty: false, simDiagramError: null, simDiagramSavedContent: null })
        return
      }
      const read = await window.api.readFile(file)
      if (get().workspaceRoot !== root) return
      if (read.kind !== 'text') throw new Error('Circuit file must be UTF-8 JSON text.')
      set({ simDiagramSavedContent: read.content })
      if (read.content.length > 2_000_000) throw new Error('Circuit file exceeds 2 MB.')
      const data = decodeSimDiagram(JSON.parse(read.content))
      if (get().workspaceRoot !== root) return
      set({ simParts: resolveCircuitParts(data.parts, data.wires), simWires: data.wires, sim3dBoard: data.board, simDiagramDirty: false, simDiagramError: null })
    } catch (err) {
      if (get().workspaceRoot !== root) return
      const message = `Circuit not loaded: ${String(err)}. The saved file was not changed.`
      set({ simParts: [], simWires: [], sim3dBoard: 'uno', simDiagramDirty: false, simDiagramError: message })
      get().notify('error', 'Circuit not loaded', message)
    }
  },
  importDiagram(raw) {
    if (!get().workspaceRoot || get().simRunning) throw new Error('Open a folder and stop simulation before importing a circuit.')
    const data = decodeSimDiagram(raw)
    if (get().simDiagramDirty && !window.confirm('Replace unsaved circuit edits with the imported circuit?')) return
    set({ simParts: data.parts, simWires: data.wires, sim3dBoard: data.board, simWiring: null, simDiagramDirty: true, ...SIM_PIN_RESET })
  },

  async detectToolchains(force) {
    const chains = await window.api.detectToolchains(force)
    const cppAvail = chains.find((c) => c.available && isHostCpp(c.command))
    set({ toolchains: chains })
    // A rescan is exactly when a language server the user just installed should
    // become visible; without re-probing, availability stayed cached from
    // startup and only a full restart picked it up.
    if (force) {
      void window.api.lspServers(true).then((a) => set({ lspServers: a }))
    }
    if (cppAvail && !chains.find((c) => c.command === get().compiler && c.available)) {
      set({ compiler: cppAvail.command })
    }
  },
  async refreshProjectModel() {
    const root = get().workspaceRoot
    if (!root) return
    const model = await window.api.buildProjectModel(root)
    // The workspace can have changed while the scan was running (it walks up
    // to 8000 files); only apply a result that's still for the current one.
    if (get().workspaceRoot === root) set({ projectModel: model })
  },
  setCompiler(c) {
    set({ compiler: c })
    void get().persistProjectConfig({ compiler: c })
  },
  setStd(s) {
    set({ std: s })
    void get().persistProjectConfig({ std: s })
  },
  setCStd(v) {
    set({ cStd: v })
    void get().persistProjectConfig({ cStd: v })
  },
  setRustEdition(e) {
    set({ rustEdition: e })
    void get().persistProjectConfig({ rustEdition: e })
  },
  setOptimization(o) {
    set({ optimization: o })
    void get().persistProjectConfig({ optimization: o })
  },

  async runActive() {
    const { tabs, activePath, workspaceRoot, running } = get()
    if (running || runStartToken) return
    const tab = tabs.find((t) => t.path === activePath)
    if (!tab) return
    // F5, the Monaco keybinding, the palette and the Sketch menu all reach here
    // without the toolbar's gating, so a bare `return` made Run look broken:
    // zero pixels changed. Always say why instead.
    const say = (text: string): void => {
      set({ bottomVisible: true, bottomView: 'output', output: [{ stream: 'system', text }] })
    }
    if (!tab.language.runnable) {
      say(`Cortex has no runner for ${tab.language.label} files. They are edit-only here.\n`)
      return
    }
    // startDebug refuses while a run is active; the reverse was never enforced,
    // so Run during a debug session started a second process against the same
    // build directory while the debugger's stack and variables stayed on screen.
    const dbg = get().debug.status
    if (dbg !== 'idle' && dbg !== 'exited') {
      say('A debug session is running. Stop it before running this file.\n')
      return
    }
    // A header is not a program: `g++ util.hpp -o util.exe` exits 0 and writes a
    // precompiled header, which then fails to execute.
    if (isHeaderPath(tab.path)) {
      say('A header is not a program. Open the .cpp/.c that includes it and run that.\n')
      return
    }
    // An Arduino sketch must never be handed to the host compiler: `g++ blink.ino`
    // fails with "file format not recognized". F5 / the command palette reach this
    // path even though the toolbar hides Run for sketches, so route them properly.
    if (isSketch(activePath)) {
      const { boardStatus, selectedFqbn } = get()
      if (boardStatus?.available && !boardStatus.setupRequired && selectedFqbn) return get().verifyBoard()
      return get().startSim()
    }
    const preparation = beginRunPreparation(get, tab.path)
    try {
      await get().saveActive()
      const state = get()
      if (!preparation.isSaved() || state.running || (state.debug.status !== 'idle' && state.debug.status !== 'exited')) return
      runTargetFile = baseName(tab.path)
      const id = nextRunId()
      set({
        runId: id,
        running: true,
        runAction: 'run',
        runPhase: COMPILED_LANGS.has(tab.language.id) ? 'compile' : 'run',
        lastExitCode: null,
        output: [],
        diagnostics: [],
        bottomView: 'output',
        bottomVisible: true
      })
      try {
        await window.api.runStart({
          id,
          filePath: tab.path,
          language: tab.language.id,
          cwd: workspaceRoot || tab.path.replace(/[\\/][^\\/]+$/, ''),
          // C uses its C driver/standard, not the C++ configuration.
          compiler: tab.language.id === 'c' ? cDriver(state.compiler) : state.compiler,
          std: tab.language.id === 'c' ? state.cStd : state.std,
          optimization: state.optimization,
          rustEdition: state.rustEdition,
          extraArgs: state.extraArgs,
          projectPython: state.projectPython,
          pythonPath:
            state.settings?.pythonPath ||
            state.toolchains.find((t) => t.id === 'python' && t.available)?.command ||
            state.toolchains.find((t) => t.id === 'python3' && t.available)?.command ||
            'python'
        })
        if (!preparation.ownsRun(id)) await window.api.runStop(id)
      } catch (err) {
        if (preparation.ownsRun(id)) set({
          running: false,
          runPhase: 'idle',
          runAction: null,
          runId: null,
          output: [{ stream: 'stderr', text: `Failed to start run: ${String(err)}\n` }]
        })
      }
    } finally {
      preparation.finish()
    }
  },
  async runFirmwareTests(options = {}) {
    if (get().firmwareTestRunning) return
    get().setBottom('tests')
    const root = get().workspaceRoot
    if (!root) { set({ firmwareTestError: 'Open a project folder before running firmware tests.' }); return }
    const id = crypto.randomUUID()
    const owns = (): boolean => get().workspaceRoot === root && get().firmwareTestRunId === id
    set({ firmwareTestRunId: id, firmwareTestRunning: true, firmwareTestStopping: false, firmwareTestError: null, firmwareTestResult: null })
    try {
      await get().saveAll()
      if (!owns() || get().firmwareTestStopping) return
      if (get().tabs.some(tab => tab.content !== tab.savedContent)) throw new Error('Files changed during Save All. Save them before running tests.')
      const result = await window.api.firmwareTestRun({ ...options, id, workspaceRoot: root, compiler: hostCppOrNull(get().compiler) || 'g++' })
      if (owns()) {
        set({ firmwareTestResult: result })
        get().notify(result.report.exitCode === 0 ? 'success' : 'error', result.report.exitCode === 0 ? 'Firmware tests passed' : 'Firmware tests need attention', result.reportPath)
      }
    } catch (error) {
      if (owns()) {
        const message = error instanceof Error ? error.message : String(error)
        set({ firmwareTestError: message })
        get().notify('error', 'Could not run firmware tests', message)
      }
    } finally {
      if (owns()) set({ firmwareTestRunning: false, firmwareTestStopping: false, firmwareTestRunId: null })
    }
  },
  async stopFirmwareTests() {
    const id = get().firmwareTestRunId
    if (!id || get().firmwareTestStopping) return
    set({ firmwareTestStopping: true })
    try { await window.api.firmwareTestStop(id) }
    finally {
      if (get().firmwareTestRunId === id) set({ firmwareTestRunId: null, firmwareTestRunning: false, firmwareTestStopping: false })
    }
  },
  async stopRun() {
    runStartToken = null
    reopenSerialAfterUpload = null
    const { runId } = get()
    if (runId) await window.api.runStop(runId)
    // Clear runId so late output/exit/diagnostics for the stopped run are ignored.
    if (get().runId === runId) set({ running: false, runPhase: 'idle', runAction: null, runId: null })
  },
  clearOutput() {
    set({ output: [] })
  },
  appendOutput(c) {
    if (c.id !== get().runId) return
    // Bound retained text too: a few huge chunks can overwhelm a count-only cap.
    set({ output: appendConsoleEntry(get().output, { stream: c.stream, text: c.data }, 5000) })
  },
  handleRunExit(e) {
    // Resolve a package-op sequencing waiter for this run id first, independent
    // of the runId guard below (a package op is the only thing that registers a
    // waiter, and it emits exactly one terminal RUN_EXIT).
    resolvePkgOp(e.id)
    if (e.id !== get().runId) return
    const { runAction } = get()
    const file = runTargetFile || 'the sketch'
    // A signal-terminated process reports code null; naming the signal is truer
    // than "exit code null".
    const cause = e.signal ? `terminated by ${e.signal}` : `exit code ${e.code}`
    // Board verify/upload: the compile step is terminal (no run phase follows).
    if (runAction === 'verify' || runAction === 'upload') {
      set({ running: false, runPhase: 'idle', runAction: null, lastExitCode: e.code })
      const verb = runAction === 'verify' ? 'Verify' : 'Upload'
      if (e.code === 0) get().notify('success', `${verb} complete`, file)
      else get().notify('error', `${verb} failed`, cause)
      if (runAction === 'upload' && reopenSerialAfterUpload) {
        const monitor = reopenSerialAfterUpload
        reopenSerialAfterUpload = null
        if (monitor.runId === e.id && monitor.workspaceRoot === get().workspaceRoot &&
          monitor.port === get().serialPath && monitor.operation === serialMonitorSeq && !get().serialOpen) {
          void get().toggleSerial().catch((error) => get().notify('error', 'Could not reopen serial monitor', String(error)))
        }
      }
      return
    }
    if (e.phase === 'compile' && e.code !== 0) {
      set({ running: false, runPhase: 'idle', runAction: null, lastExitCode: e.code })
      get().notify('error', 'Build failed', `${file}: ${cause}`)
    } else if (e.phase === 'run') {
      // Package ops (installLib/installCore/restoreFromLock) share this branch
      // with runAction null; only a real program Run should notify. Their own
      // results are reported by their callers.
      const wasRun = runAction === 'run'
      set({ running: false, runPhase: 'idle', runAction: null, lastExitCode: e.code })
      if (wasRun) {
        if (e.code === 0) get().notify('success', 'Program finished', file)
        else get().notify('error', 'Program exited', `${file}: ${cause}`)
      }
    } else if (e.phase === 'compile') {
      // compile succeeded → the run phase begins
      set({ runPhase: 'run' })
    }
  },
  handleDiagnostics(d) {
    // Sim compile errors arrive under simRunId; they belong in Problems too.
    // Sim compile errors arrive under simRunId and debug build errors under
    // debugRunId; both belong in Problems. Omitting debugRunId here made the
    // whole debug-diagnostics path dead code, and since startDebug also clears
    // `diagnostics`, a previous Run's errors were wiped with nothing replacing
    // them - strictly worse than not having tried.
    if (d.id !== get().runId && d.id !== get().simRunId && d.id !== get().debugRunId) return
    set({ diagnostics: d.diagnostics })
    if (d.diagnostics.length > 0 && d.id === get().simRunId) {
      // The simulator view does not render the bottom panel, so surfacing
      // Problems there would show nothing. Return to the editor, where the
      // clickable diagnostics and Monaco markers actually live.
      set({ mainView: 'editor', bottomView: 'problems', bottomVisible: true })
    }
  },
  async sendRunInput(text) {
    const { runId, running } = get()
    if (!runId || !running) return
    await window.api.runInput(runId, text + '\n')
    set({ output: [...get().output, { stream: 'system', text: `> ${text}\n` }] })
  },
  async revealLocation(path, line, column) {
    await get().openFile(path)
    set({ reveal: { path, line, column } })
  },
  clearReveal() {
    set({ reveal: null })
  },

  async refreshPorts() {
    const ports = await window.api.serialList()
    set({ ports })
    if (!get().serialPath && ports.length) set({ serialPath: ports[0].path })
  },
  async toggleSerial() {
    const { workspaceRoot, serialOpen, serialPath, serialBaud } = get()
    const operation = ++serialMonitorSeq
    const isCurrent = (): boolean => operation === serialMonitorSeq && get().workspaceRoot === workspaceRoot && get().serialPath === serialPath
    if (serialOpen) {
      await window.api.serialClose()
      // The carry is a partial line from this session. Left behind, it gets
      // glued onto the first line of the next one and plotted as a fused value.
      if (isCurrent()) set({ serialOpen: false, serialCarry: '' })
    } else if (serialPath) {
      const ok = await window.api.serialOpen({ path: serialPath, baudRate: serialBaud })
      if (isCurrent()) set({ serialOpen: ok, serialCarry: '' })
    }
  },
  setSerialPath(p) {
    if (p !== get().serialPath) ++serialMonitorSeq
    set({ serialPath: p })
  },
  async setSerialBaud(b) {
    const operation = ++serialMonitorSeq
    const { workspaceRoot, serialPath, serialOpen } = get()
    const isCurrent = (): boolean => operation === serialMonitorSeq && get().workspaceRoot === workspaceRoot && get().serialPath === serialPath
    set({ serialBaud: b })
    // The rate is read only when the port opens, so changing it mid-session
    // used to move the dropdown and nothing else: the SerialPort kept its
    // constructor-time rate and the user watched the garbage that produces.
    void get().updateSettings({ serial: { baudRate: b } })
    if (serialOpen && serialPath) {
      await window.api.serialClose()
      if (!isCurrent()) return
      const ok = await window.api.serialOpen({ path: serialPath, baudRate: b })
      if (isCurrent()) set({ serialOpen: ok, serialCarry: '' })
    }
  },
  appendSerial(data) {
    // Buffer across chunk boundaries; only COMPLETE lines are shown and plotted
    // (parsing raw chunks would split a value like `24` + `.5` across reads).
    const buf = get().serialCarry + data
    const parts = buf.split(/\r?\n/)
    const carry = parts.pop() ?? ''
    const plot = { ...get().plotSeries }
    const newLines = [...get().serialLines]
    for (const line of parts) {
      newLines.push({ text: line, ts: performance.now() })
      const series = extractSeries(line)
      for (const key of Object.keys(series)) {
        plot[key] = [...(plot[key] || []), series[key]].slice(-200)
      }
    }
    set({ serialLines: newLines.slice(-2000), serialCarry: carry, plotSeries: plot })
  },
  clearSerial() {
    set({ serialLines: [], serialCarry: '', plotSeries: {} })
  },

  async sendChat(text, context) {
    const chat = [...get().chat, { role: 'user' as const, content: text }, { role: 'assistant' as const, content: '' }]
    set({ chat, aiStreaming: true, rightView: 'agent' })
    const id = `ai-${performance.now()}`
    await window.api.aiComplete({
      id,
      messages: chat.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
      context
    })
  },
  appendAiDelta(delta) {
    const chat = [...get().chat]
    if (chat.length) chat[chat.length - 1] = { ...chat[chat.length - 1], content: chat[chat.length - 1].content + delta }
    set({ chat })
  },
  finishAi(error) {
    if (error) {
      const chat = [...get().chat]
      if (chat.length) chat[chat.length - 1] = { role: 'assistant', content: `⚠️ ${error}` }
      set({ chat })
    }
    set({ aiStreaming: false })
  },

  setAgentMode(on) {
    set({ agentMode: on })
    lsSetBool('cortex.agentMode', on)
  },

  async runAgent(text) {
    if (!text.trim() || get().agentRunning) return
    const root = get().workspaceRoot
    if (!root) return
    const messages = [...get().agentMessages, { role: 'user' as const, content: text }]
    const id = `agent-${performance.now()}`
    set({
      agentRunning: true,
      agentRunId: id,
      agentMessages: messages,
      rightView: 'agent',
      agentStatus: 'Thinking...',
      agentLog: [...get().agentLog, { type: 'user', text }]
    })
    try {
      await window.api.agentRun({
        id,
        messages,
        workspaceRoot: root,
        activePath: get().activePath ?? undefined,
        diagnostics: get().diagnostics
      })
    } catch (e) {
      get().handleAgentEvent({ id, kind: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  },

  cancelAgent() {
    const id = get().agentRunId
    if (id) window.api.agentCancel(id)
    // Clear the run id too, so late events from the in-flight request (which the
    // main process cannot interrupt) are dropped by handleAgentEvent's id gate
    // rather than streaming text, tool chips, or an approvable edit into a run
    // the user stopped.
    set({ agentRunning: false, agentStatus: '', agentRunId: null })
  },

  clearAgent() {
    if (get().agentRunning) return
    set({ agentLog: [], agentEdits: [], agentMessages: [], agentStatus: '' })
  },

  handleAgentEvent(e) {
    // Drop events from a superseded run (a workspace switch clears agentRunId).
    if (e.id !== get().agentRunId) return
    if (e.kind === 'status') {
      set({ agentStatus: e.text })
    } else if (e.kind === 'text') {
      const log = [...get().agentLog]
      const last = log[log.length - 1]
      // Coalesce consecutive text into one assistant bubble; a tool call between
      // two text blocks starts a fresh bubble.
      if (last && last.type === 'assistant') log[log.length - 1] = { type: 'assistant', text: last.text + e.delta }
      else log.push({ type: 'assistant', text: e.delta })
      set({ agentLog: log })
    } else if (e.kind === 'tool') {
      set({ agentLog: [...get().agentLog, { type: 'tool', tool: e.tool, input: e.input, ok: e.ok, result: e.result }] })
    } else if (e.kind === 'edit') {
      const editId = `edit-${get().agentEdits.length}-${Math.round(performance.now())}`
      const edit: AgentEdit = { id: editId, ...e.edit, status: e.edit.error ? 'failed' : 'pending' }
      set({ agentEdits: [...get().agentEdits, edit], agentLog: [...get().agentLog, { type: 'edit', editId }] })
    } else if (e.kind === 'error') {
      set({ agentLog: [...get().agentLog, { type: 'error', text: e.error }], agentRunning: false, agentStatus: '' })
    } else if (e.kind === 'done') {
      // Fold THIS run's assistant text (after the last user entry) into the
      // conversation so a follow-up task has context.
      const log = get().agentLog
      let from = 0
      for (let i = log.length - 1; i >= 0; i--) if (log[i].type === 'user') { from = i; break }
      const answer = log
        .slice(from)
        .filter((x): x is Extract<AgentEntry, { type: 'assistant' }> => x.type === 'assistant')
        .map((x) => x.text)
        .join('\n')
      const messages = answer.trim()
        ? [...get().agentMessages, { role: 'assistant' as const, content: answer }]
        : get().agentMessages
      set({ agentRunning: false, agentStatus: '', agentMessages: messages })
    }
  },

  async approveAgentEdit(id) {
    const edit = get().agentEdits.find((e) => e.id === id)
    if (!edit || edit.status !== 'pending') return
    const setStatus = (patch: Partial<AgentEdit>): void =>
      set({ agentEdits: get().agentEdits.map((e) => (e.id === id ? { ...e, ...patch } : e)) })

    // Reconcile against reality before clobbering: the file may have changed
    // since the agent proposed this (a prior approved edit, an external tool, or
    // unsaved edits in its open tab). The reviewed diff was oldContent ->
    // newContent, so applying blindly would silently discard those changes.
    const tab = get().tabs.find((t) => normPath(t.path) === normPath(edit.path))
    if (tab && tab.content !== tab.savedContent) {
      setStatus({ status: 'stale', error: `${tab.name} has unsaved edits. Save or reject, then re-run the agent.` })
      return
    }
    let current = ''
    try {
      const r = await window.api.readFile(edit.path)
      if (r.kind !== 'text' && (await window.api.exists(edit.path))) {
        setStatus({ status: 'stale', error: 'The file is no longer a text file.' })
        return
      }
      current = r.kind === 'text' ? r.content : ''
    } catch {
      current = '' // gone since propose: treated as a new file below
    }
    if (normalizeEol(current) !== normalizeEol(edit.oldContent)) {
      setStatus({ status: 'stale', error: 'The file changed since this was proposed. Re-run the agent to see a fresh diff.' })
      return
    }

    // Flip status BEFORE the await so a fast second click cannot write twice.
    setStatus({ status: 'applying' })
    try {
      // Preserve the file's existing line endings so approving does not silently
      // rewrite a CRLF file to LF. writeFile is workspace-confined in main, so
      // the edit passes the same boundary a user edit does; an open tab is
      // synced (undoable via Monaco's controlled value).
      const toWrite = withEol(edit.newContent, detectEol(edit.oldContent || current))
      await window.api.writeFile(edit.path, toWrite)
      if (tab) get().applyExternalEdit(edit.path, toWrite)
      setStatus({ status: 'approved' })
      // Surface a newly created file; a refresh failure must NOT flip an
      // already-applied edit to failed.
      void get().refreshTree()
    } catch (err) {
      setStatus({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
    }
  },

  rejectAgentEdit(id) {
    set({
      agentEdits: get().agentEdits.map((e) => (e.id === id && e.status === 'pending' ? { ...e, status: 'rejected' } : e))
    })
  },

  async loadSettings() {
    const s = (await window.api.getSettings()) as AppSettings
    set({
      settings: s,
      compiler: s.defaultCppCompiler || get().compiler,
      std: (s.defaultCppStandard as CppStandard) || get().std,
      serialBaud: s.serial?.baudRate || get().serialBaud
    })
  },
  async updateSettings(patch) {
    const s = (await window.api.setSettings(patch)) as AppSettings
    set({ settings: s })
  },

  async setTheme(theme) {
    await get().updateSettings({ theme })
  },

  async loadProjectConfig() {
    const { workspaceRoot } = get()
    if (!workspaceRoot) return
    const cfg = await window.api.getProjectConfig(workspaceRoot)
    // Authoritative: every one of these is per project (.cortex/config.json), so
    // falling back to get().X carried the previous project's build settings into
    // this one. They resolve here rather than in workspaceScopedReset because
    // that is a pure function with no access to settings or detection.
    //
    // compiler and std are two-level (project, then app default), so an empty
    // project value must land on the app default, not on a literal: hardcoding
    // 'g++' would clobber a clang++ that detection correctly chose on a machine
    // with no g++. boardFqbn has no app-level default, so '' is its floor.
    const s = get().settings
    const detected = get().toolchains.find((t) => t.available && isHostCpp(t.command))?.command
    set({
      // The stored compiler is the canonical C++ driver, and this file is
      // untrusted: normalize it (a project may legitimately write 'gcc') and
      // require a HOST C++ driver. Without the host check a cloned repo could
      // pin 'arm-none-eabi-g++' and Run would exec firmware, or pin 'gcc' and
      // every C++ build would fail to link libstdc++. `detected` one line up is
      // filtered exactly this way already.
      compiler: hostCppOrNull(cfg.compiler) || s?.defaultCppCompiler || detected || 'g++',
      std: ((cfg.std || s?.defaultCppStandard) as CppStandard) || 'c++23',
      optimization: cfg.optimization || '-O0',
      cStd: (cfg.cStd as CStandard) || 'c17',
      rustEdition: cfg.rustEdition || '2021',
      extraArgs: Array.isArray(cfg.extraArgs) ? cfg.extraArgs : [],
      // A per-project interpreter is how a venv is expressed
      // (.venv/Scripts/python.exe). It was in the config schema and in the
      // ProjectConfig type but was never read back, so setting it did nothing.
      // '' means "not set", so the app-level interpreter still applies.
      projectPython: typeof cfg.pythonPath === 'string' ? cfg.pythonPath : '',
      selectedFqbn: cfg.boardFqbn || ''
    })
  },
  async persistProjectConfig(patch) {
    const { workspaceRoot } = get()
    if (!workspaceRoot) return
    try {
      await window.api.setProjectConfig(workspaceRoot, patch)
    } catch (error) {
      get().notify('error', 'Could not save project settings',
        `${workspaceRoot}: ${String(error)}. The selection is active for this session but was not saved.`)
    }
  },

  async refreshBoardStatus() {
    if (boardSetupTask) return boardSetupTask
    const seq = ++boardStatusSeq
    try {
      const status = await window.api.boardStatus()
      if (seq !== boardStatusSeq) return
      set({ boardStatus: status })
      if (!status.available || status.setupRequired) {
        if (!get().boardSetupError) await get().setupBoardTools()
      } else {
        set({ boardSetupError: null })
        await Promise.allSettled([get().refreshBoards(), get().refreshBoardTargets()])
      }
    } catch (err) {
      if (seq === boardStatusSeq) set({ boardSetupError: `Could not check board tools: ${String(err)}` })
    }
  },

  setupBoardTools() {
    if (boardSetupTask) return boardSetupTask
    ++boardStatusSeq
    set({ boardSetupBusy: true, boardSetupMessage: 'Preparing board tools...', boardSetupError: null })
    let unsubscribe = (): void => {}
    boardSetupTask = (async () => {
      try {
        unsubscribe = window.api.onBoardSetupProgress((message) => set({ boardSetupMessage: message }))
        const status = await window.api.setupBoardTools()
        set({ boardStatus: status })
        if (!status.available || status.setupRequired) throw new Error(status.hint || 'Board tools are not ready yet.')
        set({ boardSetupMessage: 'Board tools are ready.' })
        await Promise.allSettled([
          get().refreshBoards(),
          get().refreshBoardTargets(),
          get().detectToolchains(true),
          get().inspectEnvironment(true)
        ])
      } catch (err) {
        set({ boardSetupError: `Board tools setup failed: ${String(err)}` })
        get().notify('error', 'Board tools setup failed', 'Open Boards Manager to review the error and retry. The simulator is still available.')
      }
    })().finally(() => {
      unsubscribe()
      boardSetupTask = null
      set({ boardSetupBusy: false })
    })
    return boardSetupTask
  },

  async inspectEnvironment(refresh = false) {
    const root = get().workspaceRoot
    if (!root) {
      set({ environmentReport: null })
      return
    }
    const seq = ++envInspectSeq
    set({ envLoading: true })
    // The last build's compiler diagnostics are certain evidence of missing
    // headers; pass them so the report can confirm 'missing'.
    const buildMissingHeaders = extractMissingHeaders(get().diagnostics)
    try {
      const report = await window.api.envInspect(root, get().selectedFqbn || null, refresh, buildMissingHeaders)
      // Apply only if still the latest inspect, so a slower earlier run cannot
      // overwrite a newer report.
      if (seq === envInspectSeq) set({ environmentReport: report })
    } catch {
      if (seq === envInspectSeq) set({ environmentReport: null })
    } finally {
      if (seq === envInspectSeq) set({ envLoading: false })
    }
  },

  confirm(opts) {
    // Resolve any prior pending confirm as cancelled before opening a new one,
    // so a stale promise never dangles.
    confirmResolver?.(false)
    return new Promise<boolean>((resolve) => {
      confirmResolver = resolve
      set({ confirmDialog: opts })
    })
  },
  answerConfirm(ok) {
    const resolve = confirmResolver
    confirmResolver = null
    set({ confirmDialog: null })
    resolve?.(ok)
  },

  async checkLock() {
    const root = get().workspaceRoot
    if (!root) {
      set({ lockCheck: null })
      return
    }
    const seq = ++lockCheckSeq
    try {
      const lockCheck = await window.api.envLockCheck(root, get().selectedFqbn || null)
      if (seq === lockCheckSeq) set({ lockCheck })
    } catch {
      if (seq === lockCheckSeq) set({ lockCheck: null })
    }
  },

  async snapshotEnvironment() {
    const root = get().workspaceRoot
    if (!root || get().lockBusy) return
    set({ lockBusy: true })
    try {
      await window.api.envLockWrite(root, get().selectedFqbn || null)
      // Re-check so the panel reflects the just-written lock (now in sync).
      await get().checkLock()
    } catch {
      // A failed write leaves the previous lock state untouched.
    } finally {
      set({ lockBusy: false })
    }
  },

  async restoreFromLock() {
    const lc = get().lockCheck
    // Nothing to do if there is no lock, it is already in sync, or an op is
    // already running. Board changes and extras are shown as drift but are
    // deliberately NOT restored (see restorePlan): only installable
    // missing/changed cores and libraries are brought back to the locked version.
    if (!lc || lc.drift.inSync || get().running || get().lockBusy || get().lockRestoring) return
    const plan = restorePlan(lc.drift)
    if (plan.length === 0) return
    set({ lockRestoring: true })
    try {
      for (const step of plan) {
        // runPackageOp now resolves on completion, so these run one at a time
        // through the same gated, streamed path as a user-triggered install.
        if (step.kind === 'core') await get().installCore(step.target, step.version)
        else await get().installLib(step.target, step.version)
        // Stop on the first failed install rather than blindly pressing on: the
        // remaining steps may depend on it, and a half-applied restore should not
        // be silently reported as done.
        if (get().lastExitCode !== 0) break
      }
    } finally {
      set({ lockRestoring: false })
      // Reflect the new reality: the package cache was invalidated at each op's
      // completion, so re-check drift and re-inspect the environment.
      await get().checkLock()
      void get().inspectEnvironment(false)
    }
  },

  async importDatasheet() {
    const root = get().workspaceRoot
    if (!root || get().datasheetBusy) return
    set({ datasheetBusy: true })
    try {
      const res = await window.api.datasheetImport(root)
      if (res.ok) await get().refreshDatasheets()
      // A canceled dialog or a rejected file is a no-op (res.ok false); the panel
      // surfaces res.error transiently through the action's return if needed.
    } catch {
      /* import failed; leave the corpus unchanged */
    } finally {
      set({ datasheetBusy: false })
    }
  },

  async refreshDatasheets() {
    const root = get().workspaceRoot
    if (!root) {
      set({ datasheets: [] })
      return
    }
    try {
      const datasheets = await window.api.datasheetList(root)
      set({ datasheets })
    } catch {
      set({ datasheets: [] })
    }
  },

  async queryDatasheets(query) {
    const root = get().workspaceRoot
    set({ datasheetQuery: query })
    if (!root || !query.trim()) {
      set({ datasheetResults: [] })
      return
    }
    const seq = ++datasheetQuerySeq
    try {
      const results = await window.api.datasheetQuery(root, query)
      if (seq === datasheetQuerySeq) set({ datasheetResults: results })
    } catch {
      if (seq === datasheetQuerySeq) set({ datasheetResults: [] })
    }
  },

  async refreshBoards() {
    const boards = await window.api.boardListConnected()
    set({ boards })
    // Auto-select a detected board's fqbn if we don't have one yet.
    if (!get().selectedFqbn) {
      const detected = boards.find((b) => b.fqbn)
      if (detected?.fqbn) set({ selectedFqbn: detected.fqbn })
    }
  },
  async refreshBoardTargets() {
    const boardTargets = await window.api.boardListAll()
    set({ boardTargets })
  },
  setFqbn(fqbn) {
    // A board change invalidates the previous target's build diagnostics: they
    // describe a different toolchain/core, so they must not linger in Problems
    // or be reused as missing-dependency evidence for the new board.
    const changed = fqbn !== get().selectedFqbn
    set(changed ? { selectedFqbn: fqbn, diagnostics: [] } : { selectedFqbn: fqbn })
    void get().persistProjectConfig({ boardFqbn: fqbn })
  },
  setBoardAndPort(fqbn, port) {
    // One port drives both upload and the serial monitor, the way Arduino's
    // single Board+Port selection does. serialPath is that shared port.
    if (fqbn) {
      const changed = fqbn !== get().selectedFqbn
      set(changed ? { selectedFqbn: fqbn, diagnostics: [] } : { selectedFqbn: fqbn })
      void get().persistProjectConfig({ boardFqbn: fqbn })
    }
    if (port) get().setSerialPath(port)
  },

  async verifyBoard() {
    const { tabs, activePath, running, selectedFqbn } = get()
    if (running || runStartToken || !activePath || !selectedFqbn) return
    const tab = tabs.find((t) => t.path === activePath)
    if (!tab) return
    const preparation = beginRunPreparation(get, activePath)
    try {
      await get().saveActive()
      if (!preparation.isSaved() || get().running || get().selectedFqbn !== selectedFqbn) return
      runTargetFile = baseName(activePath)
      const id = nextRunId()
      set({
        runId: id,
        running: true,
        runAction: 'verify',
        runPhase: 'compile',
        lastExitCode: null,
        output: [],
        diagnostics: [],
        bottomView: 'output',
        bottomVisible: true
      })
      try {
        await window.api.boardCompile({ id, sketchPath: activePath, fqbn: selectedFqbn })
        if (!preparation.ownsRun(id)) await window.api.runStop(id)
      } catch (err) {
        if (preparation.ownsRun(id)) set({ running: false, runPhase: 'idle', runAction: null, runId: null, output: [{ stream: 'stderr', text: `Verify failed: ${String(err)}\n` }] })
      }
    } finally {
      preparation.finish()
    }
  },
  async uploadBoard() {
    const { tabs, activePath, workspaceRoot, running, selectedFqbn, serialPath, boards } = get()
    if (running || runStartToken || !activePath || !selectedFqbn) return
    const tab = tabs.find((t) => t.path === activePath)
    if (!tab) return
    // Never fall back to boards[0]: with two boards plugged in that silently
    // flashes whichever enumerated first. Require an explicit or unambiguous port.
    const matching = boards.filter((board) => board.fqbn === selectedFqbn)
    const port = serialPath || (matching.length === 1 ? matching[0].address : undefined)
    if (!port) {
      set({
        output: [
          {
            stream: 'system',
            text:
              boards.length > 1
                ? 'Multiple boards detected. Pick a port in Serial & Devices before uploading.\n'
                : 'No serial port selected. Connect a board and pick a port in Serial & Devices.\n'
          }
        ],
        bottomView: 'output',
        bottomVisible: true
      })
      return
    }
    const preparation = beginRunPreparation(get, activePath)
    const isReady = (): boolean => {
      const state = get()
      const currentMatches = state.boards.filter((board) => board.fqbn === selectedFqbn)
      return preparation.isSaved() && !state.running && state.selectedFqbn === selectedFqbn &&
        state.serialPath === serialPath && (!!serialPath || (currentMatches.length === 1 && currentMatches[0].address === port))
    }
    let closedMonitor = false
    let launched = false
    let uploadId: string | null = null
    let monitorOperation: number | null = null
    try {
      // A save failure must not interrupt a working monitor.
      await get().saveActive()
      if (!isReady()) return
      // arduino-cli needs the port; close our monitor only after saving and
      // recheck after that await, before admitting any physical-board upload.
      if (get().serialOpen) {
        monitorOperation = ++serialMonitorSeq
        await window.api.serialClose()
        if (monitorOperation !== serialMonitorSeq || get().workspaceRoot !== workspaceRoot || get().serialPath !== serialPath) return
        set({ serialOpen: false, serialCarry: '' })
        closedMonitor = true
      }
      if (!isReady()) return
      runTargetFile = baseName(activePath)
      const id = nextRunId()
      uploadId = id
      if (closedMonitor && monitorOperation !== null) reopenSerialAfterUpload = { runId: id, workspaceRoot, port, operation: monitorOperation }
      set({
        runId: id,
        running: true,
        runAction: 'upload',
        runPhase: 'compile',
        lastExitCode: null,
        output: [],
        diagnostics: [],
        bottomView: 'output',
        bottomVisible: true
      })
      try {
        await window.api.boardUpload({ id, sketchPath: activePath, fqbn: selectedFqbn, port })
        if (!preparation.ownsRun(id)) await window.api.runStop(id)
        else launched = true
      } catch (err) {
        if (preparation.ownsRun(id)) set({ running: false, runPhase: 'idle', runAction: null, runId: null, output: [{ stream: 'stderr', text: `Upload failed: ${String(err)}\n` }] })
      }
    } finally {
      preparation.finish()
      if (closedMonitor && !launched) {
        if (reopenSerialAfterUpload?.runId === uploadId) reopenSerialAfterUpload = null
        if (monitorOperation === serialMonitorSeq && get().workspaceRoot === workspaceRoot && get().serialPath === port && !get().serialOpen && !get().running) {
          void get().toggleSerial().catch((error) => get().notify('error', 'Could not reopen serial monitor', String(error)))
        }
      }
    }
  },

  // Package operations stream to the Output panel and finish through
  // handleRunExit (phase 'run'). The managers watch `running` to refresh once
  // an operation completes.
  async installCore(name, version) {
    await runPackageOp(get, set, (id) => window.api.coreInstall({ id, name, version }))
  },
  async uninstallCore(coreId) {
    await runPackageOp(get, set, (id) => window.api.coreUninstall(id, coreId))
  },
  async updateCoreIndex() {
    await runPackageOp(get, set, (id) => window.api.coreUpdateIndex(id))
    if (get().lastExitCode === 0) await get().refreshBoardStatus()
  },
  async installLib(name, version) {
    await runPackageOp(get, set, (id) => window.api.libInstall({ id, name, version }))
  },
  async uninstallLib(name) {
    await runPackageOp(get, set, (id) => window.api.libUninstall(id, name))
  },

  // ---- debugger (gdb) ----
  setDebug(s) {
    set({ debug: s })
    // A stopped session jumps the editor to the current line.
    if (s.status === 'stopped' && s.currentFile && s.currentLine) {
      void get().revealLocation(s.currentFile, s.currentLine, 1)
    }
  },
  appendDebugOutput(o: DebugOutput) {
    const stream: 'stdout' | 'stderr' | 'system' =
      o.stream === 'program' ? 'stdout' : o.stream === 'gdb' ? 'stderr' : 'system'
    set((st) => ({ output: appendConsoleEntry(st.output, { stream, text: o.text }, 5000) }))
  },
  async startDebug() {
    const { activePath, tabs, workspaceRoot, running, debug, compiler, std, breakpoints } = get()
    if (!activePath || !workspaceRoot || running || debug.status === 'running' || debug.status === 'stopped') return
    const tab = tabs.find((t) => t.path === activePath)
    if (!tab) return
    // DebugPanel's button reaches here without the toolbar's gating, so refuse
    // with a reason rather than a bare return that changes nothing on screen.
    const refuse = (error: string): void => set({ debug: { ...IDLE_DEBUG, status: 'exited', error } })
    if (!tab.language.debuggable) {
      refuse(`Cortex debugs C and C++ with gdb. ${tab.language.label} debugging is not supported yet.`)
      return
    }
    // .ino maps to cpp, so the language check alone would let a sketch through
    // to `g++ blink.ino` and a confusing build failure.
    if (isSketch(activePath)) {
      refuse('Arduino sketches cannot be debugged with host gdb. Use Simulate, or upload to the board.')
      return
    }
    if (isHeaderPath(activePath)) {
      refuse('A header is not a program. Open the .cpp/.c that includes it and debug that.')
      return
    }
    await get().saveActive()
    const bps = Object.entries(breakpoints).flatMap(([file, lines]) => lines.map((line) => ({ file, line })))
    // The debug build's diagnostics travel on the run-diagnostics channel, so
    // it needs an id the renderer will accept. `diagnostics: []` matters as much
    // as `output: []`: every other build-initiating action clears both, and
    // without it a previous Run's errors stayed listed (and stayed applied as
    // Monaco markers) over lines that now compile.
    const debugRunId = nextRunId()
    set({
      debug: { ...IDLE_DEBUG, status: 'starting' },
      debugRunId,
      output: [],
      diagnostics: [],
      bottomView: 'output',
      bottomVisible: true,
      sidebarView: 'debug',
      sidebarVisible: true
    })
    // Same C mapping as the Run path. Sending the canonical C++ driver here
    // meant debugging a .c file compiled it with g++ (as C++), so it could fail
    // to build code that Run builds fine.
    const isCFile = tab.language.id === 'c'
    await window.api.debugStart({
      runId: debugRunId,
      filePath: activePath,
      cwd: workspaceRoot,
      compiler: isCFile ? cDriver(compiler) : compiler,
      std: isCFile ? get().cStd : std,
      // Run sends these; Debug did not, so a project whose flags carry -I/-D
      // built under Run and failed under Debug with a missing-header error that
      // blamed the user's source.
      extraArgs: get().extraArgs,
      breakpoints: bps
    })
  },
  stopDebug() {
    void window.api.debugStop()
    set({ debug: IDLE_DEBUG })
  },
  debugContinue() {
    set((st) => ({ debug: { ...st.debug, status: 'running' } }))
    void window.api.debugContinue()
  },
  debugStepOver() {
    void window.api.debugStepOver()
  },
  debugStepInto() {
    void window.api.debugStepInto()
  },
  debugStepOut() {
    void window.api.debugStepOut()
  },
  debugPause() {
    void window.api.debugPause()
  },
  selectDebugFrame(level) {
    void window.api.debugSelectFrame(level)
  },
  toggleBreakpoint(file, line) {
    const cur = get().breakpoints[file] ?? []
    const next = cur.includes(line) ? cur.filter((l) => l !== line) : [...cur, line].sort((a, b) => a - b)
    set({ breakpoints: { ...get().breakpoints, [file]: next } })
    // Push live to a running session so it takes effect without a restart.
    if (get().debug.status !== 'idle') void window.api.debugSetBreakpoints(file, next)
  }
}))

useStore.subscribe((state, previous) => {
  if (state.workspaceRoot !== previous.workspaceRoot) { directoryReadTokens.clear(); workspaceGeneration++ }
  if (previous.workspaceRoot && state.workspaceRoot !== previous.workspaceRoot) rememberSession(previous)
  if (!state.workspaceRoot || state.workspaceRoot !== previous.workspaceRoot || state.workspaceRoot === sessionRestoringRoot) return
  // Source edits do not change layout and must never be stored in session metadata.
  const sameTabs = state.tabs.length === previous.tabs.length && state.tabs.every((tab, index) => tab.path === previous.tabs[index].path && tab.group === previous.tabs[index].group)
  if (!sameTabs || state.expanded !== previous.expanded || state.activeGroup !== previous.activeGroup || state.groupActive !== previous.groupActive) rememberSession(state)
})
