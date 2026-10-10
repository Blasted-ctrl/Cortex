import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  FileNode,
  FileReadResult,
  ToolchainInfo,
  RunRequest,
  RunOutputChunk,
  RunExit,
  RunDiagnostics,
  SerialPortDescriptor,
  SerialOpenOptions,
  AppInfo,
  ProjectConfig,
  ProjectModel,
  BoardStatus,
  BoardPort,
  BoardTarget,
  BoardCompileRequest,
  BoardUploadRequest,
  CorePlatform,
  LibPackage,
  PackageInstallRequest,
  SearchQuery,
  SearchResults,
  DebugStartRequest,
  DebugState,
  DebugOutput,
  GitStatus,
  GitFileDiff,
  GitDiffKind,
  GitOpResult,
  GitBranches,
  SimStartRequest,
  SimEvent,
  SimExit,
  TerminalCreateRequest,
  TerminalCreateResult,
  TerminalDataChunk,
  TerminalExit,
  AgentRunRequest,
  AgentEvent
} from '../shared/ipc'
import type { LspCall, LspAvailability, LspDiagnosticsPush, LspServerExit, LspBusy } from '../shared/lsp'
import type { EnvironmentReport } from '../shared/environment'
import type { CortexLock, LockCheck } from '../shared/lockfile'
import type { DatasheetHit, DatasheetDocMeta, DatasheetImportResult } from '../shared/datasheet'

type Unsub = () => void

function on<T>(channel: string, cb: (payload: T) => void): Unsub {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  // dialogs
  openFolder: (): Promise<string | null> => ipcRenderer.invoke(IPC.DIALOG_OPEN_FOLDER),
  openFileDialog: (): Promise<string | null> => ipcRenderer.invoke(IPC.DIALOG_OPEN_FILE),

  // filesystem
  readDir: (p: string): Promise<FileNode[]> => ipcRenderer.invoke(IPC.FS_READ_DIR, p),
  listAllFiles: (p: string): Promise<string[]> => ipcRenderer.invoke(IPC.FS_LIST_ALL, p),
  searchInFiles: (q: SearchQuery): Promise<SearchResults> => ipcRenderer.invoke(IPC.FS_SEARCH, q),
  readFile: (p: string): Promise<FileReadResult> => ipcRenderer.invoke(IPC.FS_READ_FILE, p),
  exists: (p: string): Promise<boolean> => ipcRenderer.invoke(IPC.FS_EXISTS, p),
  writeFile: (p: string, c: string, expectedContent?: string | null): Promise<void> => ipcRenderer.invoke(IPC.FS_WRITE_FILE, p, c, expectedContent),
  createFile: (p: string): Promise<void> => ipcRenderer.invoke(IPC.FS_CREATE_FILE, p),
  createDir: (p: string): Promise<void> => ipcRenderer.invoke(IPC.FS_CREATE_DIR, p),
  rename: (a: string, b: string): Promise<void> => ipcRenderer.invoke(IPC.FS_RENAME, a, b),
  deletePath: (p: string): Promise<void> => ipcRenderer.invoke(IPC.FS_DELETE, p),
  watchStart: (p: string): Promise<void> => ipcRenderer.invoke(IPC.FS_WATCH_START, p),
  watchStop: (): Promise<void> => ipcRenderer.invoke(IPC.FS_WATCH_STOP),
  onFsEvent: (cb: (e: { type: string; path: string; name: string }) => void): Unsub =>
    on(IPC.FS_EVENT, cb),

  // toolchains
  detectToolchains: (force?: boolean): Promise<ToolchainInfo[]> =>
    ipcRenderer.invoke(IPC.TOOLCHAIN_DETECT, force),

  // run / build
  runStart: (req: RunRequest): Promise<void> => ipcRenderer.invoke(IPC.RUN_START, req),
  runStop: (id: string): Promise<void> => ipcRenderer.invoke(IPC.RUN_STOP, id),
  runInput: (id: string, data: string): Promise<void> => ipcRenderer.invoke(IPC.RUN_INPUT, id, data),
  onRunOutput: (cb: (c: RunOutputChunk) => void): Unsub => on(IPC.RUN_OUTPUT, cb),
  onRunExit: (cb: (e: RunExit) => void): Unsub => on(IPC.RUN_EXIT, cb),
  onRunDiagnostics: (cb: (d: RunDiagnostics) => void): Unsub => on(IPC.RUN_DIAGNOSTICS, cb),

  // project config
  getProjectConfig: (root: string): Promise<ProjectConfig> =>
    ipcRenderer.invoke(IPC.PROJECT_CONFIG_GET, root),
  setProjectConfig: (root: string, patch: ProjectConfig): Promise<ProjectConfig> =>
    ipcRenderer.invoke(IPC.PROJECT_CONFIG_SET, root, patch),
  buildProjectModel: (root: string): Promise<ProjectModel | null> => ipcRenderer.invoke(IPC.PROJECT_MODEL_BUILD, root),
  envInspect: (
    root: string,
    fqbn: string | null,
    refresh?: boolean,
    buildMissingHeaders?: string[]
  ): Promise<EnvironmentReport | null> => ipcRenderer.invoke(IPC.ENV_INSPECT, root, fqbn, refresh, buildMissingHeaders),
  envLockWrite: (root: string, fqbn: string | null): Promise<CortexLock | null> =>
    ipcRenderer.invoke(IPC.ENV_LOCK_WRITE, root, fqbn),
  envLockCheck: (root: string, fqbn: string | null): Promise<LockCheck | null> =>
    ipcRenderer.invoke(IPC.ENV_LOCK_CHECK, root, fqbn),

  // datasheet / document intelligence
  datasheetImport: (root: string): Promise<DatasheetImportResult> => ipcRenderer.invoke(IPC.DATASHEET_IMPORT, root),
  datasheetList: (root: string): Promise<DatasheetDocMeta[]> => ipcRenderer.invoke(IPC.DATASHEET_LIST, root),
  datasheetQuery: (root: string, query: string): Promise<DatasheetHit[]> =>
    ipcRenderer.invoke(IPC.DATASHEET_QUERY, root, query),

  // embedded boards
  boardStatus: (): Promise<BoardStatus> => ipcRenderer.invoke(IPC.BOARD_STATUS),
  setupBoardTools: (): Promise<BoardStatus> => ipcRenderer.invoke(IPC.BOARD_SETUP),
  onBoardSetupProgress: (cb: (message: string) => void): Unsub => on(IPC.BOARD_SETUP_PROGRESS, cb),
  boardListConnected: (): Promise<BoardPort[]> => ipcRenderer.invoke(IPC.BOARD_LIST_CONNECTED),
  boardListAll: (): Promise<BoardTarget[]> => ipcRenderer.invoke(IPC.BOARD_LIST_ALL),
  boardCompile: (req: BoardCompileRequest): Promise<void> => ipcRenderer.invoke(IPC.BOARD_COMPILE, req),
  boardUpload: (req: BoardUploadRequest): Promise<void> => ipcRenderer.invoke(IPC.BOARD_UPLOAD, req),

  // Boards Manager (cores) + Library Manager
  coreSearch: (q: string): Promise<CorePlatform[]> => ipcRenderer.invoke(IPC.CORE_SEARCH, q),
  coreInstalled: (): Promise<CorePlatform[]> => ipcRenderer.invoke(IPC.CORE_INSTALLED),
  coreInstall: (req: PackageInstallRequest): Promise<void> => ipcRenderer.invoke(IPC.CORE_INSTALL, req),
  coreUninstall: (id: string, coreId: string): Promise<void> => ipcRenderer.invoke(IPC.CORE_UNINSTALL, id, coreId),
  coreUpdateIndex: (id: string): Promise<void> => ipcRenderer.invoke(IPC.CORE_UPDATE_INDEX, id),
  libSearch: (q: string): Promise<LibPackage[]> => ipcRenderer.invoke(IPC.LIB_SEARCH, q),
  libInstalled: (): Promise<LibPackage[]> => ipcRenderer.invoke(IPC.LIB_INSTALLED),
  libInstall: (req: PackageInstallRequest): Promise<void> => ipcRenderer.invoke(IPC.LIB_INSTALL, req),
  libUninstall: (id: string, name: string): Promise<void> => ipcRenderer.invoke(IPC.LIB_UNINSTALL, id, name),

  // debugger (gdb)
  debugStart: (req: DebugStartRequest): Promise<void> => ipcRenderer.invoke(IPC.DEBUG_START, req),
  debugStop: (): Promise<void> => ipcRenderer.invoke(IPC.DEBUG_STOP),
  debugContinue: (): Promise<void> => ipcRenderer.invoke(IPC.DEBUG_CONTINUE),
  debugStepOver: (): Promise<void> => ipcRenderer.invoke(IPC.DEBUG_STEP_OVER),
  debugStepInto: (): Promise<void> => ipcRenderer.invoke(IPC.DEBUG_STEP_INTO),
  debugStepOut: (): Promise<void> => ipcRenderer.invoke(IPC.DEBUG_STEP_OUT),
  debugPause: (): Promise<void> => ipcRenderer.invoke(IPC.DEBUG_PAUSE),
  debugSelectFrame: (level: number): Promise<void> => ipcRenderer.invoke(IPC.DEBUG_SELECT_FRAME, level),
  debugSetBreakpoints: (file: string, lines: number[]): Promise<void> =>
    ipcRenderer.invoke(IPC.DEBUG_SET_BREAKPOINTS, file, lines),
  debugEvaluate: (expr: string): Promise<string> => ipcRenderer.invoke(IPC.DEBUG_EVALUATE, expr),

  // version control (git), read-only
  gitStatus: (): Promise<GitStatus> => ipcRenderer.invoke(IPC.GIT_STATUS),
  gitDiff: (path: string, kind: GitDiffKind, orig?: string): Promise<GitFileDiff | null> =>
    ipcRenderer.invoke(IPC.GIT_DIFF, path, kind, orig),
  gitStage: (paths: string[]): Promise<GitOpResult> => ipcRenderer.invoke(IPC.GIT_STAGE, paths),
  gitUnstage: (paths: string[]): Promise<GitOpResult> => ipcRenderer.invoke(IPC.GIT_UNSTAGE, paths),
  gitCommit: (message: string): Promise<GitOpResult> => ipcRenderer.invoke(IPC.GIT_COMMIT, message),
  gitPush: (): Promise<GitOpResult> => ipcRenderer.invoke(IPC.GIT_PUSH),
  gitBranches: (): Promise<GitBranches> => ipcRenderer.invoke(IPC.GIT_BRANCHES),
  gitSwitch: (name: string): Promise<GitOpResult> => ipcRenderer.invoke(IPC.GIT_SWITCH, name),
  gitInit: (): Promise<GitOpResult> => ipcRenderer.invoke(IPC.GIT_INIT),
  gitCreateBranch: (name: string): Promise<GitOpResult> => ipcRenderer.invoke(IPC.GIT_CREATE_BRANCH, name),
  gitFetch: (): Promise<GitOpResult> => ipcRenderer.invoke(IPC.GIT_FETCH),
  gitPull: (): Promise<GitOpResult> => ipcRenderer.invoke(IPC.GIT_PULL),
  onDebugState: (cb: (s: DebugState) => void): Unsub => on(IPC.DEBUG_STATE, cb),
  onDebugOutput: (cb: (o: DebugOutput) => void): Unsub => on(IPC.DEBUG_OUTPUT, cb),

  // simulator
  simStart: (req: SimStartRequest): Promise<void> => ipcRenderer.invoke(IPC.SIM_START, req),
  simStop: (id: string): Promise<void> => ipcRenderer.invoke(IPC.SIM_STOP, id),
  simInput: (id: string, pin: number, value: number): Promise<void> =>
    ipcRenderer.invoke(IPC.SIM_INPUT, id, pin, value),
  onSimEvent: (cb: (e: SimEvent) => void): Unsub => on(IPC.SIM_EVENT, cb),
  onSimExit: (cb: (e: SimExit) => void): Unsub => on(IPC.SIM_EXIT, cb),

  // integrated terminal (pty)
  terminal: {
    create: (req: TerminalCreateRequest): Promise<TerminalCreateResult> =>
      ipcRenderer.invoke(IPC.TERMINAL_CREATE, req),
    input: (id: string, data: string): void => ipcRenderer.send(IPC.TERMINAL_INPUT, id, data),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send(IPC.TERMINAL_RESIZE, id, cols, rows),
    kill: (id: string): void => ipcRenderer.send(IPC.TERMINAL_KILL, id),
    onData: (cb: (c: TerminalDataChunk) => void): Unsub => on(IPC.TERMINAL_DATA, cb),
    onExit: (cb: (e: TerminalExit) => void): Unsub => on(IPC.TERMINAL_EXIT, cb)
  },

  // serial
  serialList: (): Promise<SerialPortDescriptor[]> => ipcRenderer.invoke(IPC.SERIAL_LIST),
  serialOpen: (opts: SerialOpenOptions): Promise<boolean> => ipcRenderer.invoke(IPC.SERIAL_OPEN, opts),
  serialClose: (): Promise<void> => ipcRenderer.invoke(IPC.SERIAL_CLOSE),
  serialWrite: (data: string): Promise<void> => ipcRenderer.invoke(IPC.SERIAL_WRITE, data),
  onSerialData: (cb: (d: { data: string; path?: string }) => void): Unsub => on(IPC.SERIAL_DATA, cb),
  onSerialStatus: (cb: (s: { open: boolean; path: string; message?: string }) => void): Unsub =>
    on(IPC.SERIAL_STATUS, cb),

  // language servers (LSP)
  lspServers: (refresh?: boolean): Promise<LspAvailability> => ipcRenderer.invoke(IPC.LSP_SERVERS, refresh),
  lspRequest: (call: LspCall): Promise<unknown> => ipcRenderer.invoke(IPC.LSP_REQUEST, call),
  lspNotify: (call: LspCall): Promise<void> => ipcRenderer.invoke(IPC.LSP_NOTIFY, call),
  lspDisposeRoot: (keepRoot: string): Promise<void> => ipcRenderer.invoke(IPC.LSP_DISPOSE_ROOT, keepRoot),
  onLspDiagnostics: (cb: (d: LspDiagnosticsPush) => void): Unsub => on(IPC.LSP_DIAGNOSTICS, cb),
  onLspServerExit: (cb: (e: LspServerExit) => void): Unsub => on(IPC.LSP_SERVER_EXIT, cb),
  onLspBusy: (cb: (b: LspBusy) => void): Unsub => on(IPC.LSP_BUSY, cb),

  // ai
  aiComplete: (req: {
    id: string
    messages: { role: 'user' | 'assistant'; content: string }[]
    context?: string
  }): Promise<void> => ipcRenderer.invoke(IPC.AI_COMPLETE, req),
  onAiStream: (cb: (s: { id: string; delta: string; done: boolean; error?: string }) => void): Unsub =>
    on(IPC.AI_STREAM, cb),

  // ai engineering agent (tool loop)
  agentRun: (req: AgentRunRequest): Promise<void> => ipcRenderer.invoke(IPC.AGENT_RUN, req),
  agentCancel: (id: string): void => ipcRenderer.send(IPC.AGENT_CANCEL, id),
  onAgentEvent: (cb: (e: AgentEvent) => void): Unsub => on(IPC.AGENT_EVENT, cb),

  // settings / app
  getSettings: (): Promise<unknown> => ipcRenderer.invoke(IPC.SETTINGS_GET),
  setSettings: (patch: unknown): Promise<unknown> => ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
  appInfo: (): Promise<AppInfo> => ipcRenderer.invoke(IPC.APP_INFO),
  onCloseRequested: (cb: () => void): Unsub => on(IPC.APP_CLOSE_REQUESTED, cb),
  readyToClose: (): Promise<void> => ipcRenderer.invoke(IPC.APP_READY_TO_CLOSE)
}

export type CortexApi = typeof api

contextBridge.exposeInMainWorld('api', api)
