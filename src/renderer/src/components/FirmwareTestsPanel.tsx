import { useEffect, useState } from 'react'
import type { FirmwareTestSelection, SuiteResult } from '@shared/firmwareTest'
import { useStore } from '../store/useStore'

const label = (result: SuiteResult): string => 'scenario' in result ? result.scenario.id : result.scenarioPath
const preview = (text: string): string => text.length > 65_536 ? `${text.slice(0, 65_536)}\n[Preview limited to 64 Ki characters; complete logs are in report.json.]` : text

function ResultDetails({ result }: { result: SuiteResult }): JSX.Element {
  return <div className="min-w-0 flex-1 overflow-auto p-3">
    <h3 className="font-semibold">{label(result)}: {result.status.toUpperCase()}</h3>
    {result.error && <pre className="my-2 whitespace-pre-wrap text-ide-red">{preview(result.error)}</pre>}
    {'scenario' in result && <>
      <p className="my-2 text-ide-muted">{result.execution.virtualDurationMs} ms virtual simulation; {result.execution.hostWallMs.toFixed(2)} ms host execution.</p>
      {result.assertions.map(assertion => <details key={assertion.id} className="my-1 rounded border border-ide-border p-2" open={!assertion.passed}>
        <summary className={assertion.passed ? 'text-ide-text' : 'text-ide-red'}>{assertion.passed ? 'PASS' : 'FAIL'} {assertion.id} at {assertion.atMs} ms virtual</summary>
        <p className="my-1">{assertion.message}</p>
        <pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(assertion.evidence, null, 2)}</pre>
      </details>)}
      <details className="my-2"><summary>Inputs and outputs (last 30 events)</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(result.timeline.slice(-30), null, 2)}</pre></details>
      <details className="my-2"><summary>Saved scenario configuration</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(result.scenario, null, 2)}</pre></details>
      <details className="my-2"><summary>Build configuration</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(result.build ?? {}, null, 2)}</pre></details>
      {(['stdout', 'stderr', 'compiler'] as const).map(stream => <details key={stream} className="my-2"><summary>{stream} log</summary><pre className="overflow-auto whitespace-pre-wrap">{preview(result.logs[stream]) || '(empty)'}</pre></details>)}
    </>}
  </div>
}

export default function FirmwareTestsPanel(): JSX.Element {
  const { workspaceRoot, firmwareTestRunning: running, firmwareTestStopping: stopping, firmwareTestResult: response,
    firmwareTestError: error, runFirmwareTests, stopFirmwareTests, openFile, notify } = useStore()
  const [path, setPath] = useState('')
  const [firmware, setFirmware] = useState('')
  const [selected, setSelected] = useState(0)
  const [choiceError, setChoiceError] = useState<string | null>(null)
  useEffect(() => {
    setSelected(Math.max(0, response?.report.results.findIndex(result => result.status !== 'passed') ?? 0))
  }, [response])
  const choose = async (kind: FirmwareTestSelection): Promise<string | null> => {
    setChoiceError(null)
    try { return await window.api.firmwareTestChoose(kind) }
    catch (failure) { setChoiceError(String(failure)); return null }
  }
  const replay = async (): Promise<void> => {
    const report = await choose('report')
    if (report) await runFirmwareTests({ replay: report, ...(firmware ? { firmware } : {}) })
  }
  const openReport = (file: string): void => { void openFile(file).catch(failure => notify('error', 'Could not open report', String(failure))) }
  return <section aria-label="Firmware test results" className="flex h-full flex-col text-[12px]">
    <div className="shrink-0 space-y-2 border-b border-ide-border p-2">
      <p className="text-ide-muted">Uno host model. Runs trusted native firmware, not physical-board code or an electrical safety check.</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2">Scenarios
          <input className="min-w-32 flex-1 rounded border border-ide-border bg-ide-bg p-1" value={path} onChange={event => setPath(event.target.value)} disabled={running} placeholder="Auto: .cortex/scenarios or bundled example project" />
        </label>
        <button className="btn" disabled={!workspaceRoot || running} onClick={() => void choose('scenario').then(value => { if (value) setPath(value) })}>File...</button>
        <button className="btn" disabled={!workspaceRoot || running} onClick={() => void choose('scenarios').then(value => { if (value) setPath(value) })}>Folder...</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2">Firmware override
          <input className="min-w-32 flex-1 rounded border border-ide-border bg-ide-bg p-1" value={firmware} onChange={event => setFirmware(event.target.value)} disabled={running} placeholder="Optional project-local .ino for failure/fix comparison" />
        </label>
        <button className="btn" disabled={!workspaceRoot || running} onClick={() => void choose('firmware').then(value => { if (value) setFirmware(value) })}>Sketch...</button>
        {running ? <button className="btn" disabled={stopping} onClick={() => void stopFirmwareTests().catch(failure => setChoiceError(String(failure)))}>{stopping ? 'Stopping...' : 'Stop Tests'}</button>
          : <button className="btn btn-accent" disabled={!workspaceRoot} onClick={() => void runFirmwareTests({ ...(path ? { path } : {}), ...(firmware ? { firmware } : {}) })}>Run Tests</button>}
        <button className="btn" disabled={!workspaceRoot || running} onClick={() => void replay()}>Replay saved report...</button>
      </div>
      <div role="status" aria-live="polite">
        {running ? 'Saving, compiling and testing...' : response ? `${response.report.results.filter(result => result.status === 'passed').length} passed; ${response.report.results.filter(result => result.status === 'failed').length} failed; ${response.report.results.filter(result => result.status === 'error').length} runner errors. Exit ${response.report.exitCode}.` : 'Choose scenarios or run the example from an open project.'}
      </div>
      {(error || choiceError) && <p role="alert" className="text-ide-red">{error || choiceError}</p>}
      {response && <>
        {response.notes.map((note, index) => <p key={index} className="text-ide-amber">{note}</p>)}
        <div className="flex flex-wrap gap-2">
          <button className="btn" onClick={() => openReport(response.summaryPath)}>Open summary</button>
          <button className="btn" onClick={() => openReport(response.reportPath)}>Open full JSON</button>
          <button className="btn" disabled={running} onClick={() => void runFirmwareTests({ replay: response.reportPath, ...(firmware ? { firmware } : {}) })}>Rerun saved inputs</button>
        </div>
      </>}
    </div>
    {response && <div className="flex min-h-0 flex-1">
      <div aria-label="Test scenarios" className="w-56 shrink-0 overflow-auto border-r border-ide-border p-1">
        {response.report.results.map((result, index) => <button key={index} aria-pressed={selected === index} className={`block w-full break-words rounded p-2 text-left ${selected === index ? 'bg-ide-hover' : ''}`} onClick={() => setSelected(index)}>{result.status.toUpperCase()} {label(result)}</button>)}
      </div>
      {response.report.results[selected] && <ResultDetails result={response.report.results[selected]} />}
    </div>}
  </section>
}
