import { AlertCircle, AlertTriangle, Info } from 'lucide-react'
import { useStore, isPlatformioProject, normPath } from '../store/useStore'
import EmptyState from './EmptyState'
import type { Diagnostic } from '@shared/ipc'
import { diagnosticHint } from '@shared/diagnosticHints'
import { includedHeaders } from '@shared/libraryComplete'

const baseName = (p: string): string => p.split(/[\\/]/).pop() || p

function SeverityIcon({ severity }: { severity: Diagnostic['severity'] }): JSX.Element {
  if (severity === 'error') return <AlertCircle size={14} className="shrink-0 text-ide-red" />
  if (severity === 'warning') return <AlertTriangle size={14} className="shrink-0 text-ide-yellow" />
  return <Info size={14} className="shrink-0 text-ide-muted" />
}

export default function ProblemsPanel(): JSX.Element {
  const { diagnostics, diagnosticCapture, revealLocation, tree, projectModel, tabs } = useStore()
  const platformio = isPlatformioProject(tree, projectModel)

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
        ) : [...groups.entries()].map(([file, items]) => {
          const source = tabs.find(tab => normPath(tab.path) === normPath(file))?.content ?? ''
          const embedded = includedHeaders(source).has('arduino.h')
          return (
          <div key={file}>
            <div className="row gap-1.5 px-3 py-1 text-[11px] font-medium text-ide-muted">
              {baseName(file)} <span className="text-ide-faint">· {items.length}</span>
            </div>
            {items.map((d, i) => {
              const hint = diagnosticHint(d.message, { platformio, embedded })
              return (
                <button
                  key={`${file}:${d.line}:${d.column}:${i}`}
                  onClick={() => void revealLocation(d.file, d.line, d.column)}
                  className="flex w-full items-start gap-2 px-3 py-1 pl-6 text-left hover:bg-ide-hover"
                >
                  <SeverityIcon severity={d.severity} />
                  <span className="min-w-0 flex-1 break-words text-ide-text">
                    {d.message}
                    {hint && <span className="mt-1 block text-[11px] leading-relaxed text-ide-muted">{hint}</span>}
                  </span>
                  {d.code && <span className="mono shrink-0 text-[10px] text-ide-faint">{d.code}</span>}
                  <span className="mono shrink-0 text-[10px] text-ide-faint">
                    {d.line}:{d.column}
                  </span>
                </button>
              )
            })}
          </div>
          )
        })}
      </div>
    </div>
  )
}
