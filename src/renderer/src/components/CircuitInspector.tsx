import { useState } from 'react'
import { useStore, PART_PINS, INPUT_PARTS } from '../store/useStore'
import { ADC_MAX } from '@shared/simProtocol'
import { motorDrive, connectedBoardPins, type SimTerminal } from '@shared/simCircuit'
import { BOARDS } from './sim3d/board3d'

export default function CircuitInspector({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string | null) => void }): JSX.Element {
  const s = useStore()
  const [expanded, setExpanded] = useState(false)
  const selected = s.simParts.find((p) => p.id === selectedId)
  const inputPins = selected ? connectedBoardPins(s.simParts, s.simWires, { kind: 'part', partId: selected.id, pin: 'sig' }) : []
  const def = BOARDS[s.sim3dBoard]
  const label = (t: SimTerminal): string => t.kind === 'board' ? `${def.name}: ${def.pins.find((p) => !p.inspectOnly && p.pin === t.pin)?.label ?? t.pin}` : `${s.simParts.find((p) => p.id === t.partId)?.type ?? t.partId}.${t.pin}`
  const shown = expanded || !!selected || !!s.simWiring
  return <div className="absolute left-3 top-3 z-10 max-h-[80%] w-64 max-w-[calc(100%-1.5rem)] overflow-auto rounded border border-ide-border bg-ide-bar/95 p-2 text-[11px]">
    <button className="btn w-full justify-between" aria-expanded={shown} onClick={() => { setExpanded(!shown); if (shown) { onSelect(null); s.cancelWire() } }}>Circuit inspector <span>{shown ? '-' : '+'}</span></button>
    {shown && <div className="mt-2 space-y-2">
      <label className="block">Part
        <select aria-label="Selected circuit part" className="mt-1 w-full rounded border border-ide-border bg-ide-panel p-1" value={selectedId ?? ''} onChange={(e) => onSelect(e.target.value || null)}>
          <option value="">Choose a part</option>
          {s.simParts.map((p, i) => <option key={p.id} value={p.id}>{i + 1}. {p.type}</option>)}
        </select>
      </label>
      {selected && <>
        {INPUT_PARTS.includes(selected.type) && inputPins.length > 0 && <label className="block">Sensor input<input aria-label="Sensor input value" type="range" min={0} max={ADC_MAX} value={s.simInputs[inputPins[0]] ?? 0} onChange={(e) => s.setPartInput(selected.id, Number(e.target.value))} className="w-full accent-ide-amber" /></label>}
        {selected.type === 'button' && <button className="btn"
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); s.setPartButton(selected.id, true) }}
          onPointerUp={() => s.setPartButton(selected.id, false)}
          onPointerCancel={() => s.setPartButton(selected.id, false)}
          onLostPointerCapture={() => s.setPartButton(selected.id, false)}
          onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) s.setPartButton(selected.id, true) } }}
          onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); s.setPartButton(selected.id, false) } }}
          onBlur={() => s.setPartButton(selected.id, false)}>Hold button</button>}
        {selected.type === 'led' && <label className="block">LED color<input aria-label="LED color" type="color" value={selected.color || '#6FB65A'} onChange={(e) => s.setPartColor(selected.id, e.target.value)} className="ml-2 h-5 w-6 bg-transparent" /></label>}
        <div className="flex flex-wrap gap-1">{PART_PINS[selected.type].map((name) => <button key={name} className={`btn text-[10px] ${s.simWiring?.partId === selected.id && s.simWiring.pinName === name ? 'bg-ide-active' : ''}`} onClick={() => s.beginWire(selected.id, name)} title="Connect this terminal to another part terminal or board pin">{name}</button>)}</div>
        {selected.type === 'power' && <label className="block">Supply volts (theoretical)<input aria-label="Supply volts" className="ml-2 w-16 rounded border border-ide-border bg-ide-panel px-1" type="number" min="0" max="60" step="0.1" value={selected.props?.volts ?? 5} onChange={(e) => { if (e.target.value !== '') s.setPartProps(selected.id, { volts: Number(e.target.value) }) }} /></label>}
        {selected.type === 'stepper' && <><label className="block">Steps per revolution<input aria-label="Steps per revolution" className="ml-2 w-16 rounded border border-ide-border bg-ide-panel px-1" type="number" min="1" max="100000" value={selected.props?.stepsPerRevolution ?? 200} onChange={(e) => { if (e.target.value !== '') s.setPartProps(selected.id, { stepsPerRevolution: Number(e.target.value) }) }} /></label><div role="status">Steps: {s.simStepperStates[selected.id]?.steps ?? 0}</div></>}
        {selected.type === 'actuator' && <><label className="block">Travel (mm)<input aria-label="Actuator travel" className="ml-2 w-16 rounded border border-ide-border bg-ide-panel px-1" type="number" min="1" max="10000" value={selected.props?.travelMm ?? 100} onChange={(e) => { if (e.target.value !== '') s.setPartProps(selected.id, { travelMm: Number(e.target.value) }) }} /></label><div role="status">Position: {(s.simActuatorStates[selected.id]?.positionMm ?? 0).toFixed(1)} mm {s.simActuatorStates[selected.id]?.atMax ? '(upper limit)' : s.simActuatorStates[selected.id]?.atMin ? '(lower limit)' : ''}</div></>}
        {selected.type === 'motor' && <div role="status">Driver command: {Math.round(motorDrive(selected, s.simPinStates, s.simPinPwm) * 100)}%</div>}
        {['motor', 'stepper', 'actuator'].includes(selected.type) && <p className="text-ide-muted">Driver-controlled signal model. No torque, load, current or driver chip emulation.</p>}
        <div className="flex gap-1"><button className="btn" onClick={() => s.rotatePart(selected.id)}>Rotate</button><button className="btn text-ide-danger" onClick={() => { s.removePart(selected.id); onSelect(null) }}>Delete part</button></div>
      </>}
      {s.simWiring && <div className="rounded border border-ide-amber/40 p-1.5" role="status">Connecting {label({ kind: 'part', partId: s.simWiring.partId, pin: s.simWiring.pinName })}
        <select aria-label="Connect to board pin" className="mt-1 w-full rounded border border-ide-border bg-ide-panel p-1" value="" onChange={(e) => { if (e.target.value !== '') s.attachWire(Number(e.target.value)) }}>
          <option value="">Board pin...</option>{def.pins.filter((p) => !p.inspectOnly).map((p, i) => <option key={`${p.pin}-${i}`} value={p.pin}>{p.label}{p.face === 'bottom' ? ' (underside)' : ''}</option>)}
        </select><button className="btn mt-1" onClick={s.cancelWire}>Cancel connection</button>
      </div>}
      <details><summary className="cursor-pointer">Connections ({s.simWires.length})</summary><div className="mt-1 space-y-1">{s.simWires.map((w) => <div key={w.id} className="flex items-start gap-1"><span className="min-w-0 flex-1 break-words">{label(w.from)} to {label(w.to)}<span className="block text-ide-muted">{w.kind}</span></span><button className="btn px-1" aria-label={`Remove wire ${label(w.from)} to ${label(w.to)}`} onClick={() => s.removeWire(w.id)}>x</button></div>)}</div></details>
      <details><summary className="cursor-pointer">Board pins</summary><div className="mt-1 space-y-1">{def.pins.map((p, i) => <div key={i}><span className="mono text-ide-text">{p.label}{p.face === 'bottom' ? ' (underside)' : ''}</span><span className="ml-1 text-ide-muted">{p.functions?.join(', ') || (p.kind === 'gnd' ? 'Ground reference' : p.kind === 'power' ? 'Power rail' : 'Digital I/O')}</span></div>)}</div></details>
    </div>}
  </div>
}
