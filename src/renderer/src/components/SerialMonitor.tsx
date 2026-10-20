import { useShallow } from 'zustand/react/shallow'
import { useEffect, useRef, useState } from 'react'
import { Send, Plug, PlugZap, LineChart, List, Radio, RotateCcw } from 'lucide-react'
import { useStore } from '../store/useStore'
import SerialPlotter from './SerialPlotter'
import EmptyState from './EmptyState'
import { BAUD_RATES as BAUDS } from '@shared/serial'

export default function SerialMonitor(): JSX.Element {
  const {
    serialOpen,
    serialLines,
    serialCarry,
    ports,
    serialPath,
    serialBaud,
    setSerialPath,
    setSerialBaud,
    toggleSerial,
    resetBoard,
    refreshPorts,
    serialPlot: showPlot,
    setSerialPlot
  } = useStore(
    // Only what this panel shows: subscribing to the whole store re-rendered every
    // serial line whenever anything else in the app changed.
    useShallow((s) => ({
      serialOpen: s.serialOpen,
      serialLines: s.serialLines,
      serialCarry: s.serialCarry,
      ports: s.ports,
      serialPath: s.serialPath,
      serialBaud: s.serialBaud,
      setSerialPath: s.setSerialPath,
      setSerialBaud: s.setSerialBaud,
      toggleSerial: s.toggleSerial,
      resetBoard: s.resetBoard,
      refreshPorts: s.refreshPorts,
      serialPlot: s.serialPlot,
      setSerialPlot: s.setSerialPlot
    }))
  )
  const [input, setInput] = useState('')
  const [timestamps, setTimestamps] = useState(false)
  const [autoscroll, setAutoscroll] = useState(true)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void refreshPorts()
  }, [refreshPorts])

  useEffect(() => {
    if (autoscroll) endRef.current?.scrollIntoView({ block: 'end' })
  }, [serialLines, autoscroll])

  const send = async (): Promise<void> => {
    if (!input) return
    await window.api.serialWrite(input + '\n')
    setInput('')
  }

  return (
    <div className="flex h-full flex-col bg-ide-bg">
      {/* connect bar */}
      <div className="row shrink-0 gap-1.5 border-b border-ide-border px-2 py-1 text-[11px]">
        <select
          className="rounded bg-ide-panel px-1.5 py-1 outline-none hover:bg-ide-hover"
          value={serialPath}
          onChange={(e) => setSerialPath(e.target.value)}
          onFocus={() => void refreshPorts()}
        >
          {ports.length === 0 && <option value="">no ports</option>}
          {ports.map((p) => (
            <option key={p.path} value={p.path}>
              {p.path} {p.friendlyName ? `· ${p.friendlyName}` : p.manufacturer ? `· ${p.manufacturer}` : ''}
            </option>
          ))}
        </select>
        <select
          className="rounded bg-ide-panel px-1.5 py-1 outline-none hover:bg-ide-hover"
          value={serialBaud}
          onChange={(e) => setSerialBaud(Number(e.target.value))}
        >
          {BAUDS.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <button
          className={`btn ${serialOpen ? 'bg-ide-danger text-white' : 'btn-accent'}`}
          onClick={() => void toggleSerial()}
          disabled={!serialPath}
        >
          {serialOpen ? <PlugZap size={14} /> : <Plug size={14} />}
          {serialOpen ? 'Disconnect' : 'Connect'}
        </button>
        {serialOpen && (
          <button
            className="btn"
            onClick={() => void resetBoard()}
            title="Restart the board to see what it prints at boot (for example in setup())"
          >
            <RotateCcw size={14} /> Reset board
          </button>
        )}
        <div className="flex-1" />
        <label className="row gap-1 text-ide-muted">
          <input type="checkbox" checked={timestamps} onChange={(e) => setTimestamps(e.target.checked)} /> time
        </label>
        <label className="row gap-1 text-ide-muted">
          <input type="checkbox" checked={autoscroll} onChange={(e) => setAutoscroll(e.target.checked)} /> scroll
        </label>
        <button
          className={`btn ${showPlot ? 'text-ide-accent' : 'text-ide-muted'}`}
          onClick={() => setSerialPlot(!showPlot)}
          title="Toggle live plot"
        >
          {showPlot ? <List size={14} /> : <LineChart size={14} />}
        </button>
      </div>

      {/* body */}
      <div className="min-h-0 flex-1">
        {showPlot ? (
          <SerialPlotter />
        ) : (
          <div className="mono h-full overflow-auto px-3 py-1.5 text-[12.5px] leading-[1.5]">
            {serialLines.length === 0 ? (
              <EmptyState icon={<Radio size={22} />} mono>
                {serialOpen
                  ? 'Listening. Incoming data from the device appears here.'
                  : 'Connect to a serial port to see incoming data.'}
              </EmptyState>
            ) : (
              serialLines.map((line, i) => (
                <div key={line.id ?? `i${i}`} className="whitespace-pre-wrap text-ide-green">
                  {timestamps && <span className="mr-2 text-ide-faint">[{(line.ts / 1000).toFixed(2)}s]</span>}
                  {line.text}
                </div>
              ))
            )}
            {/* The carry is a partial line still waiting for its newline, so it
                is only meaningful while the port is open. After Disconnect it
                is the tail of a finished session. */}
            {serialOpen && serialCarry && (
              <span className="whitespace-pre-wrap text-ide-green/70">{serialCarry}</span>
            )}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {/* send bar */}
      <div className="row shrink-0 gap-1.5 border-t border-ide-border px-2 py-1.5">
        <input
          className="mono flex-1 rounded bg-ide-panel px-2 py-1 text-[12px] outline-none focus:ring-1 focus:ring-ide-accent"
          placeholder={serialOpen ? 'Send to device... (Enter)' : 'Connect first'}
          value={input}
          disabled={!serialOpen}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void send()}
        />
        <button className="btn btn-accent disabled:opacity-40" onClick={() => void send()} disabled={!serialOpen}>
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}
