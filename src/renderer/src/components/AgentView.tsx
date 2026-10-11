import { useEffect, useRef, useState } from 'react'
import {
  Send,
  Square,
  Eraser,
  FileText,
  Search,
  AlertTriangle,
  Cpu,
  FilePlus2,
  Wrench,
  Check,
  X,
  CircleDot,
  Loader2,
  AlertTriangle as WarnIcon,
  Settings2
} from 'lucide-react'
import { useStore, type AgentEntry, type AgentEdit } from '../store/useStore'
import DiffView from './DiffView'

const TASK_IDEAS = [
  'Explain what setup() and loop() do in this sketch, using the actual pins.',
  'Find and explain any risks in this firmware: long ISRs, blocking calls, missing volatile.',
  'Make the onboard LED blink at 2 Hz.'
]

const TOOL_ICON: Record<string, typeof FileText> = {
  read_file: FileText,
  search_project: Search,
  get_diagnostics: AlertTriangle,
  get_project_model: Cpu,
  propose_edit: FilePlus2
}

function relPath(root: string | null, p: string): string {
  if (!root) return p
  const nr = root.replace(/\\/g, '/').replace(/\/$/, '')
  const np = p.replace(/\\/g, '/')
  return np.toLowerCase().startsWith(nr.toLowerCase() + '/') ? np.slice(nr.length + 1) : np
}

export default function AgentView(): JSX.Element {
  const {
    agentLog,
    agentEdits,
    agentRunning,
    agentStatus,
    runAgent,
    cancelAgent,
    clearAgent,
    workspaceRoot,
    settings
  } = useStore()
  const configured =
    (settings?.ai.provider ?? 'none') !== 'none' &&
    (settings?.ai.provider === 'local' || !!settings?.ai.apiKeySet)
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const setMainView = useStore((s) => s.setMainView)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [agentLog, agentStatus, agentEdits])

  const submit = (): void => {
    if (!input.trim() || agentRunning || !configured || !workspaceRoot) return
    const text = input
    setInput('')
    void runAgent(text)
  }

  const pending = agentEdits.filter((e) => e.status === 'pending').length

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-2.5 overflow-auto p-3">
        {!configured ? (
          <div className="space-y-3">
            <p className="text-[12px] leading-relaxed text-ide-muted">The agent needs an AI provider.</p>
            <button className="btn btn-accent w-full justify-center text-[12px]" onClick={() => setMainView('settings')}>
              <Settings2 size={14} /> Set up the assistant
            </button>
          </div>
        ) : !workspaceRoot ? (
          <p className="text-[12px] leading-relaxed text-ide-muted">Open a workspace folder to use the agent.</p>
        ) : agentLog.length === 0 ? (
          <div className="space-y-3">
            <p className="text-[12px] leading-relaxed text-ide-muted">
              A task-oriented agent. It reads your project (files, diagnostics, the hardware model), then proposes edits
              you approve file by file. Nothing is written until you approve it.
            </p>
            <div className="space-y-1.5">
              {TASK_IDEAS.map((t) => (
                <button
                  key={t}
                  onClick={() => void runAgent(t)}
                  className="row w-full gap-2 rounded border border-ide-border bg-ide-bg/60 px-3 py-2 text-left text-[12px] hover:border-ide-accent/50"
                >
                  <Wrench size={13} className="shrink-0 text-ide-accent" /> {t}
                </button>
              ))}
            </div>
          </div>
        ) : (
          agentLog.map((entry, i) => <Entry key={i} entry={entry} edits={agentEdits} root={workspaceRoot} />)
        )}
        {agentRunning && agentStatus && (
          <div className="row gap-2 text-[11px] text-ide-faint">
            <CircleDot size={12} className="animate-pulse text-ide-accent" /> {agentStatus}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="shrink-0 border-t border-ide-border p-2">
        <div className="mb-1.5 row justify-between px-1 text-[10px] text-ide-faint">
          <span>{pending > 0 ? `${pending} edit${pending > 1 ? 's' : ''} awaiting review` : 'proposes edits you approve'}</span>
          {agentLog.length > 0 && !agentRunning && (
            <button className="row gap-1 hover:text-ide-text" onClick={clearAgent} title="Clear the conversation">
              <Eraser size={11} /> Clear
            </button>
          )}
        </div>
        <div className="row gap-1.5">
          <textarea
            rows={2}
            className="flex-1 resize-none rounded bg-ide-bg px-2 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-ide-accent disabled:opacity-50"
            placeholder={
              !configured ? 'Connect a provider first' : !workspaceRoot ? 'Open a folder first' : 'Describe a task...'
            }
            value={input}
            disabled={!configured || !workspaceRoot || agentRunning}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          {agentRunning ? (
            <button className="btn self-end bg-ide-danger text-white" onClick={cancelAgent} title="Stop the agent">
              <Square size={14} />
            </button>
          ) : (
            <button
              className="btn btn-accent self-end disabled:opacity-40"
              onClick={submit}
              disabled={!input.trim() || !configured || !workspaceRoot}
            >
              <Send size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function Entry({ entry, edits, root }: { entry: AgentEntry; edits: AgentEdit[]; root: string | null }): JSX.Element | null {
  if (entry.type === 'user') {
    return (
      <div className="text-right">
        <div className="inline-block max-w-[92%] whitespace-pre-wrap rounded-lg bg-ide-accent/90 px-3 py-2 text-left text-[12.5px] leading-relaxed text-white">
          {entry.text}
        </div>
      </div>
    )
  }
  if (entry.type === 'assistant') {
    return (
      <div className="inline-block max-w-[92%] whitespace-pre-wrap rounded-lg bg-ide-bg px-3 py-2 text-[12.5px] leading-relaxed text-ide-text">
        {entry.text}
      </div>
    )
  }
  if (entry.type === 'error') {
    return (
      <div className="rounded-lg border border-ide-red/40 bg-ide-red/10 px-3 py-2 text-[12px] leading-relaxed text-ide-on-red">
        {entry.text}
      </div>
    )
  }
  if (entry.type === 'tool') {
    const Icon = TOOL_ICON[entry.tool] ?? Wrench
    return (
      <details className="rounded border border-ide-border bg-ide-bg/50 text-[11px]">
        <summary className="row cursor-pointer list-none gap-1.5 px-2 py-1 text-ide-muted">
          <Icon size={12} className={entry.ok ? 'text-ide-accent' : 'text-ide-red'} />
          <span className="font-medium text-ide-text">{entry.tool}</span>
          <span className="min-w-0 flex-1 truncate text-ide-faint">{entry.input}</span>
        </summary>
        <div className="mono border-t border-ide-border px-2 py-1 text-[10.5px] text-ide-faint">{entry.result}</div>
      </details>
    )
  }
  // edit
  const edit = edits.find((e) => e.id === entry.editId)
  if (!edit) return null
  return <EditCard edit={edit} root={root} />
}

const STATUS_LABEL: Record<string, string> = {
  approved: 'applied',
  failed: 'failed',
  rejected: 'rejected',
  stale: 'needs re-run'
}

function EditCard({ edit, root }: { edit: AgentEdit; root: string | null }): JSX.Element {
  const approveAgentEdit = useStore((s) => s.approveAgentEdit)
  const rejectAgentEdit = useStore((s) => s.rejectAgentEdit)
  const isNew = edit.originalExists === false && !edit.error
  // Truncation guard: warn when a rewrite drops most of an existing file, the
  // one thing a whole-file replacement gets dangerously wrong and a diff alone
  // can bury.
  const oldN = edit.oldContent ? edit.oldContent.split('\n').length : 0
  const newN = edit.newContent ? edit.newContent.split('\n').length : 0
  const bigDrop = !edit.error && oldN >= 20 && newN < oldN * 0.5

  return (
    <div className="overflow-hidden rounded-lg border border-ide-border">
      <div className="row items-center gap-2 border-b border-ide-border bg-ide-bar px-2.5 py-1.5">
        <FilePlus2 size={13} className="shrink-0 text-ide-accent" />
        <span className="mono min-w-0 flex-1 truncate text-[11.5px] text-ide-text" title={relPath(root, edit.path)}>
          {relPath(root, edit.path)}
          {isNew && <span className="ml-1 text-[10px] text-ide-moss">new</span>}
        </span>
        {edit.status === 'pending' ? (
          <div className="row shrink-0 gap-1">
            <button
              className="btn border border-ide-moss/50 bg-ide-moss/15 px-2 py-0.5 text-[11px] text-ide-on-moss hover:bg-ide-moss/25"
              onClick={() => void approveAgentEdit(edit.id)}
              title="Apply this edit"
            >
              <Check size={12} /> Approve
            </button>
            <button
              className="btn border border-ide-border px-2 py-0.5 text-[11px] text-ide-muted hover:text-ide-text"
              onClick={() => rejectAgentEdit(edit.id)}
              title="Discard this edit"
            >
              <X size={12} /> Reject
            </button>
          </div>
        ) : edit.status === 'applying' ? (
          <span className="row shrink-0 gap-1 text-[10px] text-ide-muted">
            <Loader2 size={11} className="animate-spin" /> applying
          </span>
        ) : (
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
              edit.status === 'approved'
                ? 'bg-ide-moss/15 text-ide-on-moss'
                : edit.status === 'failed'
                  ? 'bg-ide-red/15 text-ide-on-red'
                  : edit.status === 'stale'
                    ? 'bg-ide-amber/15 text-ide-on-amber'
                    : 'bg-ide-bar text-ide-faint'
            }`}
          >
            {STATUS_LABEL[edit.status] ?? edit.status}
          </span>
        )}
      </div>
      {edit.summary && <div className="border-b border-ide-border px-2.5 py-1 text-[11px] text-ide-muted">{edit.summary}</div>}
      {bigDrop && (
        <div className="row items-center gap-1.5 border-b border-ide-amber/30 bg-ide-amber/10 px-2.5 py-1 text-[10.5px] text-ide-on-amber">
          <WarnIcon size={12} className="shrink-0" /> Removes most of the file ({oldN} to {newN} lines). Make sure this is
          intended, not a truncated response.
        </div>
      )}
      {edit.error ? (
        <div className={`px-2.5 py-2 text-[11px] ${edit.status === 'stale' ? 'text-ide-amber' : 'text-ide-red'}`}>{edit.error}</div>
      ) : (
        <DiffView oldContent={edit.oldContent} newContent={edit.newContent} />
      )}
    </div>
  )
}
