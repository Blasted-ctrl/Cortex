import { Play, Square, CheckCircle2, UploadCloud, AlertTriangle, Radio, LineChart, Bug, CircleX, Loader2, FlaskConical, Hammer } from 'lucide-react'
import { useStore, isSketch, isPlatformioProject } from '../store/useStore'
import { isHeaderPath } from '@shared/languages'
import BoardPortSelect from './BoardPortSelect'
import TargetSelect from './TargetSelect'

/**
 * The run/build toolbar: the build Target selector for the active file, the
 * primary action buttons (Run / Stop, or the Arduino Verify / Upload pair),
 * the Board + Port selector, and Serial Monitor / Plotter. It lives on
 * its own row below the title bar so build configuration is no longer crammed
 * into the window chrome. Build config is per-project (ProjectConfig) and lives
 * behind the Target selector (components/TargetSelect.tsx).
 */
export default function Toolbar(): JSX.Element {
  const {
    tabs,
    activePath,
    projectModel,
    tree,
    running,
    runPhase,
    runAction,
    runActive,
    buildActive,
    uploadPlatformio,
    stopRun,
    diagnostics,
    boardStatus,
    boardSetupBusy,
    boardSetupMessage,
    boardSetupError,
    setupBoardTools,
    selectedFqbn,
    verifyBoard,
    uploadBoard,
    startSim,
    simRunning,
    stopSim,
    setBottom,
    setSerialPlot,
    startDebug,
    workspaceRoot,
    firmwareTestRunning,
    firmwareTestStopping,
    runFirmwareTests,
    stopFirmwareTests,
    debug
  } = useStore()

  const boardsReady = !!boardStatus?.available && !boardStatus.setupRequired

  const openSerial = (plot: boolean): void => {
    setSerialPlot(plot)
    // setBottom reveals the panel; a stale-read toggleBottom() would re-close it.
    setBottom('serial')
  }

  const activeTab = tabs.find((t) => t.path === activePath)
  const sketch = isSketch(activePath)
  const platformio = isPlatformioProject(tree, projectModel)
  // A header shares the C++ language entry but is not a translation unit: `g++
  // util.hpp` writes a precompiled header that then fails to execute.
  const header = isHeaderPath(activePath ?? '')
  const isNative = !sketch && !header && (activeTab?.language.id === 'cpp' || activeTab?.language.id === 'c')
  const isRust = activeTab?.language.id === 'rust'
  const isC = activeTab?.language.id === 'c'
  const canRun = !!activeTab?.language.runnable && !header
  const runTitle = header
    ? 'A header is not a program. Open the .cpp/.c that includes it.'
    : canRun
      ? 'Run (F5)'
      : `Cortex cannot run ${activeTab?.language.label ?? 'this'} files`

  // Problems count from the last build's diagnostics (real feed, not fabricated).
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length
  const warnCount = diagnostics.filter((d) => d.severity === 'warning').length
  // What the current in-progress action is doing, so the run row narrates the
  // build instead of just showing a bare Stop.
  const phaseLabel =
    runAction === 'verify'
      ? 'Compiling'
      : runAction === 'build'
        ? 'Building'
        : runAction === 'upload'
          ? runPhase === 'compile'
            ? 'Compiling'
            : 'Uploading'
          : runPhase === 'compile'
            ? 'Compiling'
            : 'Running'

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-ide-border bg-ide-bar px-2 text-[12px]">
      {/* Build target: compiler / standard / optimization for host C/C++, or
          edition / profile for Rust. Sketches target a board, chosen via the
          Board + Port control further right. */}
      {isNative && <TargetSelect kind={isC ? 'c' : 'cpp'} />}
      {isRust && <TargetSelect kind="rust" />}

      {/* Problems summary from the last build. Solid red/amber on the bar (both
          AA per contrast.test.ts), not a tinted badge, so it stays legible.
          Opens the Problems panel. */}
      {(errorCount > 0 || warnCount > 0) && (
        <button
          className="row h-7 shrink-0 items-center gap-2 rounded border border-ide-border bg-ide-bar px-2 text-[11px] transition-colors hover:border-ide-faint"
          onClick={() => setBottom('problems')}
          title="Open Problems"
        >
          {errorCount > 0 && (
            <span className="row items-center gap-1 text-ide-red">
              <CircleX size={13} />
              {errorCount}
            </span>
          )}
          {warnCount > 0 && (
            <span className="row items-center gap-1 text-ide-amber">
              <AlertTriangle size={13} />
              {warnCount}
            </span>
          )}
        </button>
      )}

      <div className="flex-1" />

      {/* Action buttons (Verify / Upload for a sketch; Run / Debug for host
          code), then the Board + Port selector to their right the way Arduino
          IDE lays it out. */}
      <div className="flex shrink-0 items-center gap-1 pl-1">
        <button className="btn" disabled={!workspaceRoot || firmwareTestStopping} title="Run deterministic firmware scenarios in the Uno host model" onClick={() => void (firmwareTestRunning ? stopFirmwareTests().catch(error => useStore.getState().notify('error', 'Could not stop tests', String(error))) : runFirmwareTests())}>
          <FlaskConical size={14} /> {firmwareTestRunning ? 'Stop Tests' : 'Run Tests'}
        </button>
        {!running && (platformio || isNative || isRust) && (
          <button
            className="btn h-7 w-7 justify-center px-0 disabled:opacity-40"
            onClick={() => void buildActive()}
            disabled={debug.status !== 'idle' && debug.status !== 'exited'}
            title={platformio ? 'Build the PlatformIO project (pio run)' : 'Build this file without running it'}
            aria-label="Build"
          >
            <Hammer size={14} />
          </button>
        )}
        {!running && platformio && (
          <button
            className="btn h-7 w-7 justify-center px-0 disabled:opacity-40"
            onClick={() => void uploadPlatformio()}
            disabled={debug.status !== 'idle' && debug.status !== 'exited'}
            title="Build and upload the firmware to the connected board (pio run -t upload). Closes the serial monitor while flashing."
            aria-label="Upload to board"
          >
            <UploadCloud size={14} />
          </button>
        )}
        {running ? (
          <>
            {/* Narrate the in-progress build so the row is not just a bare Stop. */}
            <span className="row items-center gap-1.5 text-[11px] text-ide-muted">
              {/* motion-reduce: the phase label already conveys "busy"; honor the
                  OS reduced-motion setting like the splash animations do. */}
              <Loader2 size={13} className="animate-spin text-ide-accent motion-reduce:animate-none" />
              {phaseLabel}
            </span>
            <button className="btn bg-ide-danger text-white hover:brightness-110" onClick={() => void stopRun()}>
              <Square size={14} /> Stop
            </button>
          </>
        ) : sketch ? (
          <>
            {/* Simulation stays usable while the real-board tools are prepared. */}
            {!boardsReady && (
              <>
                {/* Same action as the Simulator toolbar's Run, so it carries
                    the same name and the same running state. Without the
                    simRunning arm this stayed an accent primary button that
                    silently did nothing (startSim returns early while a sim is
                    live), which is the normal case: loop() never ends. */}
                {simRunning ? (
                  <button
                    className="btn bg-ide-danger text-white hover:brightness-110"
                    onClick={() => void stopSim()}
                    title="Stop the simulation"
                  >
                    <Square size={14} /> Stop
                  </button>
                ) : (
                  <button
                    className="btn btn-accent"
                    onClick={() => void startSim()}
                    title="Run this sketch in the simulator (no hardware needed)"
                  >
                    <Play size={14} /> Run
                  </button>
                )}
                <button
                  className="btn text-[10px] disabled:opacity-60"
                  disabled={boardSetupBusy}
                  onClick={() => void setupBoardTools()}
                  title={boardSetupError || boardSetupMessage || 'Cortex sets up board tools automatically. No separate installation is needed.'}
                >
                  {boardSetupBusy ? (
                    <Loader2 size={11} className="animate-spin motion-reduce:animate-none" />
                  ) : (
                    <AlertTriangle size={11} className="text-ide-amber" />
                  )}
                  {boardSetupBusy ? 'Setting up board tools' : boardSetupError ? 'Retry board setup' : 'Set up board tools'}
                </button>
              </>
            )}
            <button
              // Circular icon buttons, the way Arduino IDE draws Verify/Upload.
              // Verify (compile only) is outlined; Upload (writes the chip) is
              // the filled accent, so the more consequential action reads as the
              // primary one.
              className={`grid h-7 w-7 place-items-center rounded-full border border-ide-border bg-ide-bar text-ide-text transition-colors enabled:hover:bg-ide-hover disabled:cursor-not-allowed disabled:opacity-40 ${
                boardsReady ? '' : 'hidden'
              }`}
              onClick={() => void verifyBoard()}
              disabled={!selectedFqbn}
              title="Verify (compile) for the selected board"
            >
              <CheckCircle2 size={16} />
            </button>
            <button
              className={`grid h-7 w-7 place-items-center rounded-full bg-ide-accent text-white transition enabled:hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40 ${
                boardsReady ? '' : 'hidden'
              }`}
              onClick={() => void uploadBoard()}
              disabled={!selectedFqbn}
              title="Compile and upload to the connected board"
            >
              <UploadCloud size={16} />
            </button>
            {/* No on-chip Debug button here: it needs a hardware probe + OpenOCD
                that Cortex does not drive yet, and a permanently-disabled button
                is worse than none. Host C/C++ debugging (the Debug button for a
                plain .cpp) is real and lives in the non-sketch branch below. */}
          </>
        ) : (
          <>
            <button className="btn btn-accent disabled:opacity-40" onClick={() => void runActive()} disabled={!canRun} title={runTitle}>
              <Play size={14} /> Run
            </button>
            {/* Host C/C++ debugging (gdb): compile with -g and launch a session. */}
            {isNative && (
              <button
                className="btn disabled:opacity-40"
                onClick={() => void startDebug()}
                disabled={debug.status === 'running' || debug.status === 'stopped' || debug.status === 'starting'}
                title="Debug this file with gdb (F5 breakpoints in the gutter)"
              >
                <Bug size={14} /> Debug
              </button>
            )}
          </>
        )}
      </div>

      {/* Board + Port selector, right of the action buttons for a sketch. */}
      {sketch && <BoardPortSelect />}

      {/* Serial Plotter + Serial Monitor, far right, the way Arduino IDE places
          them. Both open the bottom serial panel; the plotter opens it in plot
          mode. */}
      <div className="flex shrink-0 items-center gap-0.5 pl-1">
        <button className="btn" onClick={() => openSerial(true)} title="Serial Plotter">
          <LineChart size={15} />
        </button>
        <button className="btn" onClick={() => openSerial(false)} title="Serial Monitor">
          <Radio size={15} />
        </button>
      </div>
    </div>
  )
}
