import { AlertCircle, AlertTriangle, Info } from 'lucide-react'
import { useStore } from '../store/useStore'
import EmptyState from './EmptyState'
import type { Diagnostic } from '@shared/ipc'

const baseName = (p: string): string => p.split(/[\\/]/).pop() || p

function SeverityIcon({ severity }: { severity: Diagnostic['severity'] }): JSX.Element {
  if (severity === 'error') return <AlertCircle size={14} className="shrink-0 text-ide-red" />
  if (severity === 'warning') return <AlertTriangle size={14} className="shrink-0 text-ide-yellow" />
  return <Info size={14} className="shrink-0 text-ide-muted" />
}

export default function ProblemsPanel(): JSX.Element {
  const { diagnostics, diagnosticCapture, revealLocation } = useStore()

  // Group by file, preserving first-seen order.
  const groups = new Map<string, Diagnostic[]>()
  for (const d of diagnostics) {
    if (!groups.has(d.file)) groups.set(d.file, [])
    groups.get(d.file)!.push(d)
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-[12.5px]">
      {diagnosticCapture && (diagnosticCapture.omittedDiagnostics > 0 || diagnosticCapture.unparsedBytes > 0) && (
        <div role="status" aria-live="polite" className="shrink-0 border-b border-ide-border px-3 py-2 text-[11px] leading-relaxed text-ide-muted">
          <div className="font-medium text-ide-text">Diagnostics incomplete.</div>
          {diagnosticCapture.omittedDiagnostics > 0 && (
            <div>{`${diagnosticCapture.omittedDiagnostics} additional diagnostic${diagnosticCapture.omittedDiagnostics === 1 ? '' : 's'} omitted.`}</div>
          )}
          {diagnosticCapture.unparsedBytes > 0 && (
            <div>{`${diagnosticCapture.unparsedBytes} byte${diagnosticCapture.unparsedBytes === 1 ? '' : 's'} of compiler output skipped; additional diagnostic count unknown.`}</div>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {diagnostics.length === 0 ? (
          <EmptyState icon={<Info size={22} />}>
            No located compiler diagnostics.
          </EmptyState>
        ) : [...groups.entries()].map(([file, items]) => (
          <div key={file}>
            <div className="row gap-1.5 px-3 py-1 text-[11px] font-medium text-ide-muted">
              {baseName(file)} <span className="text-ide-faint">· {items.length}</span>
            </div>
            {items.map((d, i) => (
              <button
                key={`${file}:${d.line}:${d.column}:${i}`}
                onClick={() => void revealLocation(d.file, d.line, d.column)}
                className="row w-full gap-2 px-3 py-1 pl-6 text-left hover:bg-ide-hover"
              >
                <SeverityIcon severity={d.severity} />
                <span className="min-w-0 flex-1 truncate text-ide-text">{d.message}</span>
                {d.code && <span className="mono shrink-0 text-[10px] text-ide-faint">{d.code}</span>}
                <span className="mono shrink-0 text-[10px] text-ide-faint">
                  {d.line}:{d.column}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
