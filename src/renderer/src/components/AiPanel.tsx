import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { Sparkles, Send, X, ScanSearch, Zap, Cpu, Settings2 } from 'lucide-react'
import { useStore } from '../store/useStore'
import { buildHardwareGraph } from '@shared/hardwareGraph'
import PanelHeader from './PanelHeader'
import AgentView from './AgentView'

const QUICK_ACTIONS = [
  { icon: ScanSearch, label: 'Analyze firmware', prompt: 'Analyze this firmware for stack overflow risk, race conditions, long ISRs, heap fragmentation, DMA misuse, and missing volatile qualifiers. List concrete findings.' },
  { icon: Zap, label: 'Optimize power', prompt: 'Review this code for power consumption. Identify peripherals left enabled, missing sleep modes, and estimate battery-life impact.' },
  { icon: Cpu, label: 'Explain this file', prompt: 'Explain what this file does at a high level, then walk through the key functions.' }
]

export default function AiPanel({ width, panelRef }: { width: number; panelRef: RefObject<HTMLDivElement> }): JSX.Element {
  const { chat, aiStreaming, sendChat, toggleAi, tabs, activePath, settings, setMainView, projectModel, agentMode, setAgentMode } =
    useStore()
  // "Configured" means it can actually answer: a provider, plus a key unless the
  // provider is a local endpoint (which needs none).
  const provider = settings?.ai.provider ?? 'none'
  const configured = provider !== 'none' && (provider === 'local' || !!settings?.ai.apiKeySet)
  const [input, setInput] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const activeTab = tabs.find((t) => t.path === activePath)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [chat])

  // The AI's whole differentiator is understanding the system the code
  // controls, not just the code - so give it the derived project model, not
  // just the open file. Scoped to what's likely relevant: the board/platform,
  // buses, and recognized devices (whole-project - these lists are small) and
  // pin usage (only the active file's, not all 200 possible entries - a
  // firmware question is almost always about the file open in front of the
  // person asking it).
  const graph = useMemo(() => (projectModel ? buildHardwareGraph(projectModel) : null), [projectModel])
  const projectSummary = (): string => {
    if (!projectModel) return ''
    const lines: string[] = []
    const board = projectModel.boards[0]
    if (board) {
      const bits = [board.platform && `platform: ${board.platform}`, board.framework && `framework: ${board.framework}`]
        .filter(Boolean)
        .join(', ')
      lines.push(`Board: ${board.name}${bits ? ` (${bits})` : ''}`)
    }
    if (projectModel.languages.length) {
      lines.push(`Languages: ${projectModel.languages.map((l) => `${l.label} (${l.fileCount})`).join(', ')}`)
    }
    if (graph) {
      // The scans cap out on very large projects; when they did, say so
      // rather than presenting a partial list as the whole system.
      const caveat = graph.incomplete ? ' [partial scan - list may be incomplete]' : ''
      const buses = graph.nodes.filter((n) => n.kind === 'bus')
      if (buses.length) {
        lines.push(`Buses${caveat}: ${buses.map((b) => b.label + (b.detail ? ` (${b.detail})` : '')).join('; ')}`)
      }
      const devices = graph.nodes.filter((n) => n.kind === 'device')
      if (devices.length) {
        const desc = devices.map((d) => {
          const onBus = graph.edges.find((e) => e.from === d.id && e.relation === 'likely-on-bus')
          return `${d.label} (${d.detail}${onBus ? `; ${onBus.note}` : ''})`
        })
        lines.push(`Devices (driver includes found in source)${caveat}: ${desc.join('; ')}`)
      }
    }
    if (activeTab) {
      const norm = (p: string): string => p.replace(/\\/g, '/')
      const filePins = projectModel.pins.filter((p) => norm(p.file).endsWith(norm(activeTab.path).split('/').pop() ?? ''))
      if (filePins.length) {
        const desc = filePins.map((p) => `${p.pin} (${p.role}${p.mode ? `: ${p.mode}` : ''}, line ${p.line})`).join(', ')
        lines.push(`Pins referenced in this file: ${desc}`)
      }
    }
    return lines.length ? `Project:\n${lines.join('\n')}\n\n` : ''
  }

  const currentContext = (): string | undefined => {
    const project = projectSummary()
    const file = activeTab ? `File: ${activeTab.name} (${activeTab.language.label})\n\n\`\`\`\n${activeTab.content}\n\`\`\`` : ''
    const combined = project + file
    return combined.trim() ? combined : undefined
  }

  const submit = async (text: string): Promise<void> => {
    if (!text.trim() || aiStreaming) return
    setInput('')
    await sendChat(text, currentContext())
  }

  return (
    <div
      ref={panelRef}
      className="flex shrink-0 flex-col overflow-hidden rounded-lg border border-ide-border bg-ide-panel"
      style={{ width }}
    >
      <PanelHeader
        icon={<Sparkles size={14} className="text-ide-accent" />}
        actions={
          <div className="row gap-1.5">
            {/* Agent (task-oriented, tool loop) vs plain Chat (single answer). */}
            <div className="row overflow-hidden rounded border border-ide-border text-[10px] font-medium">
              {(['agent', 'chat'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setAgentMode(m === 'agent')}
                  className={`px-1.5 py-0.5 ${
                    (m === 'agent') === agentMode
                      ? 'bg-ide-active text-ide-text'
                      : 'text-ide-muted hover:bg-ide-hover hover:text-ide-text'
                  }`}
                  title={m === 'agent' ? 'Task agent: reads the project and proposes edits' : 'Ask a question'}
                >
                  {m === 'agent' ? 'Agent' : 'Chat'}
                </button>
              ))}
            </div>
            <button className="rounded p-1 hover:bg-ide-hover hover:text-ide-text" onClick={toggleAi} title="Close">
              <X size={14} />
            </button>
          </div>
        }
      >
        Cortex Agent
      </PanelHeader>

      {agentMode ? (
        <AgentView />
      ) : (
        <>
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {chat.length === 0 && !configured ? (
          // Do not advertise an assistant that cannot answer. Say it plainly and
          // give the one control that fixes it.
          <div className="space-y-3">
            <p className="text-[12px] leading-relaxed text-ide-muted">
              Cortex Agent is not connected yet.
            </p>
            <p className="text-[11px] leading-relaxed text-ide-faint">
              Choose a provider and paste a key (Claude, OpenAI, Gemini), or point Cortex at a local
              model with Ollama or LM Studio, which needs no key.
            </p>
            <button className="btn btn-accent w-full justify-center text-[12px]" onClick={() => setMainView('settings')}>
              <Settings2 size={14} /> Set up the assistant
            </button>
          </div>
        ) : chat.length === 0 ? (
          <div className="space-y-3">
            <p className="text-[12px] leading-relaxed text-ide-muted">
              An assistant tuned for embedded work. It sees your active file as context.
            </p>
            <div className="space-y-1.5">
              {QUICK_ACTIONS.map(({ icon: Icon, label, prompt }) => (
                <button
                  key={label}
                  onClick={() => void submit(prompt)}
                  className="row w-full gap-2 rounded border border-ide-border bg-ide-bg/60 px-3 py-2 text-left text-[12px] hover:border-ide-accent/50"
                >
                  <Icon size={14} className="text-ide-accent" /> {label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          chat.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'text-right' : ''}>
              <div
                className={`inline-block max-w-[92%] whitespace-pre-wrap rounded-lg px-3 py-2 text-left text-[12.5px] leading-relaxed ${
                  m.role === 'user' ? 'bg-ide-accent/90 text-white' : 'bg-ide-bg text-ide-text'
                }`}
              >
                {m.content || (aiStreaming && i === chat.length - 1 ? '▍' : '')}
              </div>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      <div className="shrink-0 border-t border-ide-border p-2">
        {activeTab && (
          <div className="mb-1.5 truncate px-1 text-[10px] text-ide-faint">
            context: <span className="mono text-ide-muted">{activeTab.name}</span>
          </div>
        )}
        <div className="row gap-1.5">
          <textarea
            rows={2}
            className="flex-1 resize-none rounded bg-ide-bg px-2 py-1.5 text-[12px] outline-none focus:ring-1 focus:ring-ide-accent disabled:opacity-50"
            placeholder={configured ? 'Ask about your firmware...' : 'Connect a provider in Settings first'}
            value={input}
            disabled={!configured}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void submit(input)
              }
            }}
          />
          <button
            className="btn btn-accent self-end disabled:opacity-40"
            onClick={() => void submit(input)}
            disabled={aiStreaming || !input.trim() || !configured}
          >
            <Send size={14} />
          </button>
        </div>
      </div>
        </>
      )}
    </div>
  )
}
