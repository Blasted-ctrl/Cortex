import { useRef, useState } from 'react'
import { importWokwiDiagram, exportWokwiDiagram } from '@shared/wokwiDiagram'
import { useStore } from '../store/useStore'

export default function SimulatorExchange(): JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const s = useStore()
  const exportDiagram = async (): Promise<void> => {
    const root = s.workspaceRoot
    if (!root) return
    setBusy(true)
    try {
      const data = exportWokwiDiagram({ version: 3, board: s.sim3dBoard, parts: s.simParts, wires: s.simWires })
      const dir = `${root}/.cortex`, path = `${dir}/wokwi.diagram.json`
      let previous: string | null = null
      if (await window.api.exists(path)) {
        const read = await window.api.readFile(path)
        if (read.kind !== 'text') throw new Error('Existing export is not readable text; choose a different path outside this action.')
        if (!window.confirm('Replace .cortex/wokwi.diagram.json?')) return
        previous = read.content
      }
      if (useStore.getState().workspaceRoot !== root) throw new Error('Project changed during export. Try again.')
      await window.api.createDir(dir)
      await window.api.writeFile(path, JSON.stringify(data, null, 2), previous)
      s.notify('success', 'Wokwi diagram exported', path)
    } catch (err) { s.notify('error', 'Wokwi export failed', String(err)) }
    finally { setBusy(false) }
  }
  return <div className="mt-2 border-t border-ide-border pt-2">
    <div className="flex flex-wrap gap-1">
      <button className="btn text-[11px]" disabled={busy || !s.workspaceRoot || s.simRunning} onClick={() => input.current?.click()}>Import Wokwi diagram</button>
      <button className="btn text-[11px]" disabled={busy || !s.workspaceRoot || s.simRunning} onClick={() => void exportDiagram()}>Export Wokwi diagram</button>
      <button className="btn text-[11px]" onClick={() => window.open('https://wokwi.com/', '_blank')}>Open Wokwi</button>
      <button className="btn text-[11px]" onClick={() => window.open('https://www.tinkercad.com/circuits', '_blank')}>Open Tinkercad</button>
    </div>
    <p className="mt-1 text-ide-muted">Wokwi exchange: Uno, LED, button (no bounce), potentiometer and buzzer. Other parts/settings are rejected, not dropped. Online simulators open in your browser; Cortex does not upload code or embed their engines.</p>
    <input ref={input} className="hidden" aria-label="Import Wokwi diagram file" type="file" accept=".json,application/json" onChange={(e) => {
      const file = e.target.files?.[0]; e.target.value = ''
      if (!file) return
      const root = s.workspaceRoot
      setBusy(true)
      void (async () => {
        if (file.size > 2_000_000) throw new Error('Diagram exceeds 2 MB.')
        const diagram = importWokwiDiagram(JSON.parse(await file.text()))
        if (useStore.getState().workspaceRoot !== root) throw new Error('Project changed during import. Try again.')
        s.importDiagram(diagram)
      })().catch((err) => s.notify('error', 'Wokwi import failed', String(err))).finally(() => setBusy(false))
    }} />
  </div>
}
