import { AlertTriangle, Download, Loader2 } from 'lucide-react'
import { useStore } from '../store/useStore'

export default function BoardToolsSetup(): JSX.Element {
  const busy = useStore((s) => s.boardSetupBusy)
  const message = useStore((s) => s.boardSetupMessage)
  const error = useStore((s) => s.boardSetupError)
  const setup = useStore((s) => s.setupBoardTools)

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-4 text-center" aria-busy={busy}>
      {busy ? (
        <Loader2 size={22} className="animate-spin text-ide-accent motion-reduce:animate-none" />
      ) : (
        <AlertTriangle size={22} className="text-ide-amber" />
      )}
      <div className="text-[12px] font-semibold text-ide-text">
        {busy ? 'Setting up board tools' : 'Board tools need setup'}
      </div>
      <div className="text-[12px] text-ide-muted" role={error ? 'alert' : 'status'} aria-live="polite">
        {error || (busy ? message : 'Cortex sets up the tools needed to compile and upload to your board. No separate installation is needed.')}
      </div>
      {!busy && (
        <button className="btn btn-accent mt-1" onClick={() => void setup()}>
          <Download size={13} /> {error ? 'Retry setup' : 'Set up board tools'}
        </button>
      )}
      <div className="text-[10px] text-ide-faint">
        Initial setup needs an internet connection. The simulator works while setup runs.
      </div>
    </div>
  )
}
