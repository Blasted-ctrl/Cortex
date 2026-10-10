import { useEffect, useState } from 'react'
import { RefreshCw, Usb, Plug, PlugZap, CircuitBoard, CheckCircle2 } from 'lucide-react'
import { useStore } from '../store/useStore'
import PanelHeader from './PanelHeader'
import EmptyState from './EmptyState'
import BoardToolsSetup from './BoardToolsSetup'

export default function DevicesPanel(): JSX.Element {
  const {
    ports,
    serialPath,
    serialOpen,
    setSerialPath,
    toggleSerial,
    refreshPorts,
    setBottom,
    boardStatus,
    boards,
    refreshBoardStatus,
    serialError
  } = useStore()
  const [busy, setBusy] = useState(false)
  const boardsReady = !!boardStatus?.available && !boardStatus.setupRequired

  useEffect(() => {
    void refreshPorts()
    void refreshBoardStatus()
  }, [refreshPorts, refreshBoardStatus])

  const rescan = async (): Promise<void> => {
    setBusy(true)
    try {
      await Promise.allSettled([refreshPorts(), refreshBoardStatus()])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        actions={
          <button className="rounded p-1 hover:bg-ide-hover hover:text-ide-text" onClick={rescan} title="Rescan ports">
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
          </button>
        }
      >
        Serial &amp; Devices
      </PanelHeader>

      {/* Board toolchain (arduino-cli) status */}
      <div className="mx-2 mb-1 rounded bg-ide-bg/60 px-2 py-1.5 text-[11px]">
        {boardsReady ? (
          <div className="row gap-1.5">
            <CheckCircle2 size={14} className="text-ide-green" />
            <span className="text-ide-muted">Board tools ready</span>
          </div>
        ) : (
          <BoardToolsSetup />
        )}
        {boards.length > 0 && (
          <div className="mt-1 space-y-0.5">
            {boards.map((b) => (
              <div key={b.address} className="row gap-1.5 text-[10px] text-ide-faint">
                <CircuitBoard size={11} className="text-ide-accent" />
                <span className="mono text-ide-muted">{b.address}</span>
                {b.boardName && <span className="truncate">· {b.boardName}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {ports.length === 0 ? (
          <EmptyState icon={<Usb size={20} />}>
            No serial devices detected. Plug in a board (Arduino, ESP32, STM32) and press rescan.
          </EmptyState>
        ) : (
          ports.map((p) => {
            const selected = p.path === serialPath
            return (
              <button
                key={p.path}
                onClick={() => setSerialPath(p.path)}
                className={`row w-full gap-2 rounded px-2 py-1.5 text-left text-[12px] ${
                  selected ? 'bg-ide-active text-ide-text' : 'text-ide-muted hover:bg-ide-hover'
                }`}
              >
                <Usb size={14} className="shrink-0 text-ide-accent" />
                <span className="min-w-0">
                  <div className="mono truncate text-ide-text">{p.path}</div>
                  {/* Same rule as the palette: faint drops to 3.21:1 on the
                      selected row's background. */}
                  <div className={`truncate text-[10px] ${selected ? 'text-ide-muted' : 'text-ide-faint'}`}>
                    {p.friendlyName || p.manufacturer || 'Unknown device'}
                    {p.vendorId ? ` · ${p.vendorId}:${p.productId}` : ''}
                  </div>
                </span>
              </button>
            )
          })
        )}
      </div>
      <div className="shrink-0 space-y-1.5 border-t border-ide-border p-2">
        {serialError && (
          <div className="rounded border border-ide-red/40 bg-ide-red/10 px-2 py-1.5 text-[10px] leading-snug text-ide-on-red">
            {serialError}
            {/^.*(access is denied|denied).*$/i.test(serialError) && (
              <div className="mt-1 text-ide-muted">
                Another program (or an upload) is using this port. Close it and try again.
              </div>
            )}
          </div>
        )}
        <button
          className={`btn w-full justify-center ${serialOpen ? 'bg-ide-danger text-white' : 'btn-accent'}`}
          onClick={() => void toggleSerial()}
          disabled={!serialPath}
        >
          {serialOpen ? <PlugZap size={14} /> : <Plug size={14} />}
          {serialOpen ? 'Disconnect' : 'Connect'}
        </button>
        <button className="btn w-full justify-center text-ide-muted" onClick={() => setBottom('serial')}>
          Open Serial Monitor
        </button>
      </div>
    </div>
  )
}
