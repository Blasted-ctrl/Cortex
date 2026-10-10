/**
 * Shared IPC contract between the Electron main process and the renderer.
 * Channel names are centralized here so both sides stay in sync.
 */

import type { GitFileStatus } from './gitStatus'
export type { GitFileStatus }

export const IPC = {
  // Dialogs / workspace
  DIALOG_OPEN_FOLDER: 'dialog:openFolder',
  DIALOG_OPEN_FILE: 'dialog:openFile',

  // Filesystem
  FS_READ_DIR: 'fs:readDir',
  FS_LIST_ALL: 'fs:listAll',
  FS_SEARCH: 'fs:search', // content search across the workspace
  FS_READ_FILE: 'fs:readFile',
  FS_READ_WORKSPACE_FILE: 'fs:readWorkspaceFile',
  FS_READ_WORKSPACE_DIR: 'fs:readWorkspaceDir',
  FS_EXISTS: 'fs:exists',
  FS_WRITE_FILE: 'fs:writeFile',
  FS_CREATE_FILE: 'fs:createFile',
  FS_CREATE_DIR: 'fs:createDir',
  FS_RENAME: 'fs:rename',
  FS_DELETE: 'fs:delete',
  FS_WATCH_START: 'fs:watchStart',
  FS_WATCH_STOP: 'fs:watchStop',
  FS_EVENT: 'fs:event', // main -> renderer

  // Toolchains / build / run
  TOOLCHAIN_DETECT: 'toolchain:detect',
  RUN_START: 'run:start',
  RUN_STOP: 'run:stop',
  RUN_INPUT: 'run:input',
  RUN_OUTPUT: 'run:output', // main -> renderer (streamed)
  RUN_EXIT: 'run:exit', // main -> renderer
  RUN_DIAGNOSTICS: 'run:diagnostics', // main -> renderer (parsed compiler diagnostics)

  // Per-project configuration (.cortex/config.json)
  PROJECT_CONFIG_GET: 'project:configGet',
  PROJECT_CONFIG_SET: 'project:configSet',

  // Derived project model: languages, board/platform, GPIO usage
  PROJECT_MODEL_BUILD: 'project:modelBuild',

  // Intelligent Dependency & Environment System: reconcile what the project
  // uses against what is installed + the selected board into an evidence-based
  // report (invoke -> EnvironmentReport | null).
  ENV_INSPECT: 'env:inspect',
  // Reproducibility: snapshot the installed environment to a lockfile, and check
  // the current environment against the stored lock for drift.
  ENV_LOCK_WRITE: 'env:lockWrite',
  ENV_LOCK_CHECK: 'env:lockCheck',

  // Datasheet / document intelligence: import engineering docs (import opens a
  // native dialog in main), list the corpus, and query it for cited passages.
  DATASHEET_IMPORT: 'datasheet:import',
  DATASHEET_LIST: 'datasheet:list',
  DATASHEET_QUERY: 'datasheet:query',

  // Embedded boards (arduino-cli / PlatformIO): ESP32, RP2040, AVR/Arduino, ...
  BOARD_STATUS: 'board:status', // is arduino-cli available?
  BOARD_SETUP: 'board:setup',
  BOARD_SETUP_PROGRESS: 'board:setupProgress',
  BOARD_LIST_CONNECTED: 'board:listConnected',
  BOARD_LIST_ALL: 'board:listAll',
  BOARD_COMPILE: 'board:compile',
  BOARD_UPLOAD: 'board:upload',

  // Boards Manager (cores) + Library Manager, via arduino-cli
  CORE_SEARCH: 'core:search',
  CORE_INSTALLED: 'core:installed',
  CORE_INSTALL: 'core:install', // streamed to RUN_OUTPUT/RUN_EXIT
  CORE_UNINSTALL: 'core:uninstall', // streamed
  CORE_UPDATE_INDEX: 'core:updateIndex', // streamed
  LIB_SEARCH: 'lib:search',
  LIB_INSTALLED: 'lib:installed',
  LIB_INSTALL: 'lib:install', // streamed
  LIB_UNINSTALL: 'lib:uninstall', // streamed

  // Debugger (gdb, host C/C++)
  DEBUG_START: 'debug:start',
  DEBUG_STOP: 'debug:stop',
  DEBUG_CONTINUE: 'debug:continue',
  DEBUG_STEP_OVER: 'debug:stepOver',
  DEBUG_STEP_INTO: 'debug:stepInto',
  DEBUG_STEP_OUT: 'debug:stepOut',
  DEBUG_PAUSE: 'debug:pause',
  DEBUG_SET_BREAKPOINTS: 'debug:setBreakpoints',
  DEBUG_EVALUATE: 'debug:evaluate',
  DEBUG_SELECT_FRAME: 'debug:selectFrame',
  DEBUG_STATE: 'debug:state', // main -> renderer push
  DEBUG_OUTPUT: 'debug:output', // main -> renderer: program + gdb text

  // Version control (git)
  GIT_STATUS: 'git:status',
  GIT_DIFF: 'git:diff',
  GIT_STAGE: 'git:stage',
  GIT_UNSTAGE: 'git:unstage',
  GIT_COMMIT: 'git:commit',
  GIT_PUSH: 'git:push',
  GIT_BRANCHES: 'git:branches',
  GIT_SWITCH: 'git:switch',
  GIT_INIT: 'git:init',
  GIT_CREATE_BRANCH: 'git:createBranch',
  GIT_FETCH: 'git:fetch',
  GIT_PULL: 'git:pull',

  // Simulator (Wokwi/Tinkercad-style native simulation)
  SIM_START: 'sim:start',
  SIM_STOP: 'sim:stop',
  SIM_INPUT: 'sim:input',
  SIM_EVENT: 'sim:event', // main -> renderer (pin/pwm/serial/system)
  SIM_EXIT: 'sim:exit', // main -> renderer

  // Deterministic firmware behavior tests (same headless runner as the CLI).
  FIRMWARE_TEST_CHOOSE: 'firmware:choose',
  FIRMWARE_TEST_RUN: 'firmware:run',
  FIRMWARE_TEST_STOP: 'firmware:stop',

  // Integrated terminal (pty-backed shell). A user-driven terminal is
  // user-authorized: keystrokes go to the user's own shell at the user's own
  // privileges. AI-initiated commands do NOT flow here; they stay behind the
  // command allowlist / approval gate.
  TERMINAL_CREATE: 'terminal:create', // invoke -> TerminalCreateResult
  TERMINAL_INPUT: 'terminal:input', // renderer -> main: user keystrokes
  TERMINAL_RESIZE: 'terminal:resize', // renderer -> main: cols/rows
  TERMINAL_KILL: 'terminal:kill', // renderer -> main: dispose a session
  TERMINAL_DATA: 'terminal:data', // main -> renderer: shell output
  TERMINAL_EXIT: 'terminal:exit', // main -> renderer: shell exited

  // Serial
  SERIAL_LIST: 'serial:list',
  SERIAL_OPEN: 'serial:open',
  SERIAL_CLOSE: 'serial:close',
  SERIAL_WRITE: 'serial:write',
  SERIAL_DATA: 'serial:data', // main -> renderer
  SERIAL_STATUS: 'serial:status', // main -> renderer

  // Language servers (LSP: clangd / pyright / rust-analyzer)
  LSP_SERVERS: 'lsp:servers', // which languages have a server (invoke)
  LSP_REQUEST: 'lsp:request', // request/response (invoke)
  LSP_NOTIFY: 'lsp:notify', // didOpen/didChange/didClose (invoke -> void)
  LSP_DIAGNOSTICS: 'lsp:diagnostics', // main -> renderer push
  LSP_BUSY: 'lsp:busy', // main -> renderer: server is indexing, not ready yet
  LSP_SERVER_EXIT: 'lsp:serverExit', // main -> renderer: a server died, replay didOpen
  LSP_DISPOSE_ROOT: 'lsp:disposeRoot', // renderer -> main: drop servers for other roots

  // AI
  AI_COMPLETE: 'ai:complete',
  AI_STREAM: 'ai:stream', // main -> renderer

  // AI engineering agent (tool loop). Read-only tools auto-run behind the
  // workspace boundary; file edits are staged as reviewable diffs and never
  // written by the agent, only by the renderer after the human approves.
  AGENT_RUN: 'agent:run', // renderer -> main (invoke): start a task
  AGENT_CANCEL: 'agent:cancel', // renderer -> main: stop the running task
  AGENT_EVENT: 'agent:event', // main -> renderer: streamed steps/edits/result

  // App
  APP_INFO: 'app:info',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  APP_CLOSE_REQUESTED: 'app:closeRequested', // main -> renderer: save dirty tabs, then confirm
  APP_READY_TO_CLOSE: 'app:readyToClose' // renderer -> main (invoke), once saveAll() settles
} as const

export type LanguageId =
  | 'cpp'
  | 'c'
  | 'python'
  | 'rust'
  | 'javascript'
  | 'typescript'
  | 'lua'
  | 'zig'
  // Ancillary project files (edit-only, but they should still be highlighted).
  | 'markdown'
  | 'yaml'
  | 'json'
  | 'ini'
  | 'xml'
  | 'shell'
  | 'plaintext'

export interface FileNode {
  name: string
  path: string
  isDir: boolean
  children?: FileNode[]
}

export interface ToolchainInfo {
  id: string
  name: string
  /** 'cpp'/'c' are HOST compilers. 'embedded' cross-compiles firmware for a
   *  chip and cannot build anything runnable on this machine. */
  kind: 'cpp' | 'c' | 'embedded' | 'python' | 'rust' | 'node' | 'cmake' | 'other'
  command: string
  version: string
  available: boolean
  path?: string
}

/** C standards, offered for .c files. A C++ standard is not merely wrong there:
 * gcc rejects `-std=c++23` outright for C. */
export type CStandard = 'c99' | 'c11' | 'c17' | 'c23'

export type CppStandard =
  | 'c++11'
  | 'c++14'
  | 'c++17'
  | 'c++20'
  | 'c++23'
  | 'c++2c'

export interface RunRequest {
  id: string
  filePath: string
  language: LanguageId
  cwd: string
  // C/C++ options
  compiler?: string // e.g. 'g++' | 'clang++' (or gcc/clang for a .c file)
  /** The C++ standard, or the C standard when language === 'c'. */
  std?: CppStandard | CStandard
  optimization?: string // e.g. '-O0' | '-O2'
  extraArgs?: string[]
  // Rust options
  rustEdition?: string // '2015' | '2018' | '2021' | '2024'
  // C options (std above carries the C standard when language === 'c')
  // Python options
  pythonPath?: string
  /**
   * Interpreter pinned by the workspace's .cortex/config.json (a venv). Kept
   * separate from `pythonPath` because that one comes from app settings and is
   * trusted, while this file travels with a cloned repo: main applies a
   * stricter rule to it and falls back to `pythonPath` if it fails.
   */
  projectPython?: string
}

export interface RunOutputChunk {
  id: string
  stream: 'stdout' | 'stderr' | 'system'
  data: string
}

export interface RunExit {
  id: string
  code: number | null
  signal: string | null
  durationMs: number
  phase: 'compile' | 'run'
}

export type DiagnosticSeverity = 'error' | 'warning' | 'note' | 'info'

export interface Diagnostic {
  file: string // absolute path (best-effort resolved from the compiler's report)
  line: number // 1-based
  column: number // 1-based
  severity: DiagnosticSeverity
  message: string
  code?: string // e.g. the "-Wunused-variable" flag, when present
}

export interface RunDiagnostics {
  id: string
  diagnostics: Diagnostic[]
}

/**
 * Result of reading a file for the editor. A bare utf8 read turned a .bin/.elf
 * into editable mojibake, and saving that tab wrote U+FFFD back over the
 * artifact, so the reader reports what it found instead of guessing.
 */
export type FileReadResult =
  | { kind: 'text'; content: string }
  | { kind: 'binary' }
  | { kind: 'too-large'; size: number }

export interface ProjectConfig {
  compiler?: string
  std?: CppStandard
  optimization?: string
  extraArgs?: string[]
  cStd?: CStandard
  rustEdition?: string
  pythonPath?: string
  /** Last-used board (fqbn) for embedded upload. */
  boardFqbn?: string
}

// ---- Project model ---------------------------------------------------------
// A derived, read-only picture of what a workspace actually is: what languages
// it's written in, what board/platform it targets (when that's discoverable
// from a real config file, not guessed), and which GPIO pins the source code
// touches. Built by inspecting the project, never by asking the user to
// describe it. See docs/PROJECT-MODEL.md.

export interface LanguageBreakdown {
  id: string
  label: string
  fileCount: number
}

export interface BoardInfo {
  name: string
  platform?: string
  framework?: string
  /** Where this came from, so the UI/AI can say how confident to be. */
  source: 'platformio.ini'
  /** The platformio.ini [env:NAME] section this was read from, when there's more than one. */
  env: string
}

export type PinRole = 'pinMode' | 'digitalWrite' | 'digitalRead' | 'analogWrite' | 'analogRead'

export interface PinUsage {
  file: string
  line: number
  pin: string
  role: PinRole
  /** For pinMode specifically: OUTPUT / INPUT / INPUT_PULLUP / ... */
  mode?: string
}

export type BusKind = 'i2c' | 'spi' | 'uart'

export interface BusUsage {
  file: string
  line: number
  bus: BusKind
  /** The object the code called this on: "Wire", "Wire1", "SPI", "Serial1", ... */
  instance: string
  role: string
  /** i2c only, and only when the address in source is a literal (not a #define/variable). */
  address?: string
  /** uart only: the baud rate passed to .begin(), when it's a literal. */
  baud?: number
}

export interface LibraryUsage {
  file: string
  line: number
  /** The #include target verbatim, e.g. "Adafruit_MPU6050.h" or "freertos/task.h". */
  header: string
}

export interface ProjectModel {
  languages: LanguageBreakdown[]
  boards: BoardInfo[]
  toolchains: ToolchainInfo[]
  pins: PinUsage[]
  /** True when the pin scan stopped at its file/match cap - the list above is
   *  a sample, not exhaustive, and callers (the AI context builder especially)
   *  should say so rather than imply completeness. */
  pinsTruncated: boolean
  buses: BusUsage[]
  busesTruncated: boolean
  libraries: LibraryUsage[]
  librariesTruncated: boolean
}

// ---- Embedded boards ------------------------------------------------------

export interface BoardStatus {
  available: boolean
  version: string
  source?: 'bundled' | 'managed' | 'path'
  /** Cortex-owned package indexes must be initialized before package searches. */
  setupRequired?: boolean
  /** true when the ESP32/RP2040/etc core is likely needed but not installed */
  hint?: string
}

/** A physical board connected to a serial/USB port (from `arduino-cli board list`). */
export interface BoardPort {
  address: string // e.g. COM5 or /dev/ttyUSB0
  protocol: string // 'serial'
  label?: string
  boardName?: string // detected board, if any
  fqbn?: string // detected fully-qualified board name, if any
}

/** An installable/known board target (from `arduino-cli board listall`). */
export interface BoardTarget {
  name: string // "ESP32 Dev Module"
  fqbn: string // "esp32:esp32:esp32"
}

export interface BoardCompileRequest {
  id: string
  sketchPath: string // path to the .ino file (its folder is used as the sketch)
  fqbn: string
}

export interface BoardUploadRequest {
  id: string
  sketchPath: string
  fqbn: string
  port: string
}

// ---- Workspace search -----------------------------------------------------

export interface SearchQuery {
  root: string
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}
export interface SearchMatch {
  line: number // 1-based
  column: number // 1-based
  preview: string // the full matching line, trimmed to a sane length
  matchStart: number // 0-based offset into preview where the match begins
  matchEnd: number // 0-based offset into preview where the match ends
}
export interface SearchFileResult {
  path: string
  matches: SearchMatch[]
}
export interface SearchResults {
  files: SearchFileResult[]
  total: number // total match count
  truncated: boolean // hit a cap
}

/** A board-support platform (core) from `arduino-cli core search/list`. */
export interface CorePlatform {
  id: string // "esp32:esp32"
  name: string // "esp32"
  maintainer?: string
  installedVersion: string // "" when not installed
  latestVersion: string
  versions: string[] // installable versions, newest first
  boards: string[] // board names this platform provides
  deprecated?: boolean
}

/** A library from `arduino-cli lib search/list`. */
export interface LibPackage {
  name: string
  author?: string
  sentence?: string // one-line description
  installedVersion: string // "" when not installed
  latestVersion: string
  versions: string[] // installable versions, newest first
  website?: string
  /** Headers this library provides (`lib list` provides_includes); the
   *  Intelligent Dependency System resolves an #include to its providing
   *  library through this. Empty for `lib search` results and older CLIs. */
  providesIncludes?: string[]
  /** Architectures the library declares support for (e.g. ["esp32"] or ["*"]). */
  architectures?: string[]
}

/** Install a specific core/library version (blank version = latest). */
export interface PackageInstallRequest {
  id: string // run id for streamed output
  name: string // core id or library name
  version?: string
}

// ---- Debugger (gdb) -------------------------------------------------------

export interface DebugStartRequest {
  /** Correlates this build's diagnostics with the Problems panel, the same way
   *  a run id does. Debug used to report build errors as loose text only. */
  runId: string
  filePath: string // the .cpp/.c to debug
  cwd: string
  compiler?: string
  // A .c file is debugged with the C driver and a C standard, exactly like Run.
  std?: CppStandard | CStandard
  /** Project flags from .cortex/config.json. These usually carry -I/-D/-l, so
   *  omitting them made Debug fail to build what Run built fine. */
  extraArgs?: string[]
  breakpoints: { file: string; line: number }[]
}
export interface DebugFrame {
  level: number
  func: string
  file: string // basename or as gdb reports
  fullname: string // absolute path when known
  line: number
  addr: string
}
export interface DebugVariable {
  name: string
  value: string
  type?: string
}
export type DebugStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'exited'
export interface DebugState {
  status: DebugStatus
  reason?: string // breakpoint-hit, end-stepping-range, exited-normally, signal...
  stack: DebugFrame[]
  frame: number // selected frame level
  variables: DebugVariable[] // locals + args of the selected frame
  currentFile?: string
  currentLine?: number
  exitCode?: number
  error?: string
}
/** main -> renderer stream of program stdout/stderr and gdb messages. */
export interface DebugOutput {
  stream: 'program' | 'gdb' | 'system'
  text: string
}

// ---- Version control (git) ------------------------------------------------
/** Working-tree status for the open workspace. `isRepo` is false when the
 *  workspace is not a git repository; `error` is set when git IS a repo (or
 *  git could not be run) but the status could not be read, so the panel never
 *  fabricates a clean tree from a failure. Paths are repo-root-relative and
 *  already confined to the open workspace. */
export interface GitStatus {
  isRepo: boolean
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  files: GitFileStatus[]
  error?: string
}
/** Which side of a file's change to diff, matching how the row is grouped. */
export type GitDiffKind = 'staged' | 'unstaged' | 'untracked'
/** Result of a mutating git op (stage / unstage / commit): a plain success, or
 *  an honest error message lifted from git's own stderr. */
export interface GitOpResult {
  ok: boolean
  error?: string
}
/** Local branches and the current one (null when detached / not a repo). */
export interface GitBranches {
  current: string | null
  branches: string[]
}
/** One file's diff as two contents for the shared DiffView. The pair depends on
 *  the kind: staged = HEAD (or the rename origin) vs the index; unstaged = the
 *  index vs the working tree; untracked = empty vs the working tree. `binary` is
 *  set when either side has a NUL byte; `directory` when the entry is a folder
 *  (not line-diffable). */
export interface GitFileDiff {
  path: string
  oldContent: string
  newContent: string
  binary: boolean
  directory?: boolean
}

// ---- Simulator ------------------------------------------------------------

export interface SimStartRequest {
  id: string
  filePath: string
  cwd: string
  compiler?: string
}

export type SimEvent =
  | { id: string; kind: 'mode'; pin: number; value: number }
  | { id: string; kind: 'pin'; pin: number; value: number }
  | { id: string; kind: 'pwm'; pin: number; value: number }
  | { id: string; kind: 'tone'; pin: number; value: number }
  | { id: string; kind: 'serial'; text: string }
  | { id: string; kind: 'system'; text: string }

export interface SimExit {
  id: string
  code: number | null
}

// ---- Integrated terminal --------------------------------------------------

export interface TerminalCreateRequest {
  /** Renderer-minted session id, correlated on data/exit/input/resize/kill. */
  id: string
  cols: number
  rows: number
}

/** The cwd is chosen in main from the trusted open-workspace root, never from a
 *  renderer-supplied string, so it is reported back for display only. */
export type TerminalCreateResult =
  | { ok: true; id: string; shell: string; cwd: string }
  | { ok: false; error: string }

export interface TerminalDataChunk {
  id: string
  data: string
}

export interface TerminalExit {
  id: string
  exitCode: number
  signal?: number
}

export interface SerialPortDescriptor {
  path: string
  manufacturer?: string
  serialNumber?: string
  vendorId?: string
  productId?: string
  friendlyName?: string
}

export interface SerialOpenOptions {
  path: string
  baudRate: number
  dataBits?: 5 | 6 | 7 | 8
  stopBits?: 1 | 1.5 | 2
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space'
}

// ---- AI engineering agent -------------------------------------------------

export interface AgentChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/** A run request. The renderer passes the snapshot the agent's read-only tools
 *  need but the main process cannot cheaply re-derive (the live Problems feed);
 *  file reads/search/project-model are served by main directly from disk. */
export interface AgentRunRequest {
  id: string
  messages: AgentChatMessage[]
  workspaceRoot: string
  activePath?: string
  diagnostics: Diagnostic[]
}

/** A staged, not-yet-applied whole-file replacement for human review. */
export interface AgentStagedEdit {
  path: string
  oldContent: string
  newContent: string
  summary?: string
  /** Set when the file could not be read or the path was refused; the UI shows
   *  the reason instead of a diff, and the edit cannot be applied. */
  error?: string
}

/** Streamed agent progress. Every tool call is surfaced so the run is auditable. */
export type AgentEvent =
  | { id: string; kind: 'status'; text: string }
  | { id: string; kind: 'tool'; tool: string; input: string; ok: boolean; result: string }
  | { id: string; kind: 'text'; delta: string }
  | { id: string; kind: 'edit'; edit: AgentStagedEdit }
  | { id: string; kind: 'done' }
  | { id: string; kind: 'error'; error: string }

export interface AppInfo {
  version: string
  platform: NodeJS.Platform
  arch: string
  home: string
  electron: string
  node: string
  chrome: string
}
