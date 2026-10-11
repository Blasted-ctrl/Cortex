import type { BrowserWindow } from 'electron'
import { resolve, isAbsolute, relative, dirname } from 'path'
import { realpath } from 'fs/promises'
import { IPC } from '../../shared/ipc'
import type { AgentRunRequest, AgentEvent, AgentStagedEdit, Diagnostic, ProjectModel } from '../../shared/ipc'
import { getSettings } from './settingsService'
import * as fsService from './fsService'
import { searchInFiles } from './searchService'
import { buildProjectModel } from './projectModelService'
import * as environment from './environmentService'
import * as docs from './datasheetService'
import { getProjectConfig } from './projectConfigService'
import { buildHardwareGraph } from '../../shared/hardwareGraph'
import { formatEnvironmentReport, formatHardwareGraph } from '../../shared/agentContext'
import { formatDocHits } from '../../shared/datasheet'
import {
  AGENT_TOOLS,
  AGENT_SYSTEM_PROMPT,
  MAX_AGENT_STEPS,
  READ_FILE,
  SEARCH_PROJECT,
  GET_DIAGNOSTICS,
  GET_PROJECT_MODEL,
  GET_ENVIRONMENT,
  GET_HARDWARE_GRAPH,
  SEARCH_DOCS,
  PROPOSE_EDIT,
  toAnthropicTools,
  toOpenAiTools,
  STRUCTURED_FALLBACK_INSTRUCTION,
  parseStructuredProposal
} from '../../shared/agentTools'
import ENGINEER_GUIDE from '../prompts/embedded-engineer.md?raw'

/**
 * The full system prompt: the senior-embedded-engineer operating manual (the
 * shared skills file), then the concrete tool contract and approval model. The
 * manual sets how the agent works; AGENT_SYSTEM_PROMPT sets what its tools are.
 */
const SYSTEM = `${ENGINEER_GUIDE}\n\n---\n\n${AGENT_SYSTEM_PROMPT}`

/**
 * The Cortex engineering agent: a provider-native tool-calling loop that reads
 * the project (files, search, diagnostics, the derived hardware model) and
 * proposes file edits. Read-only tools run automatically behind the workspace
 * boundary; propose_edit NEVER writes to disk, it stages a diff the renderer
 * applies only after the human approves. AI-driven file access is confined
 * exactly as a user's is (fsService.withinWorkspace + the trusted workspace
 * root, never a renderer-supplied path).
 */

// One task at a time (the panel runs one), tracked so cancel() can stop it.
const active = new Map<string, { cancelled: boolean }>()

export function cancel(id: string): void {
  const a = active.get(id)
  if (a) a.cancelled = true
}

function emit(win: BrowserWindow, event: AgentEvent): void {
  if (!win.isDestroyed()) win.webContents.send(IPC.AGENT_EVENT, event)
}

const MAX_TOOL_RESULT = 12000 // chars fed back to the model per tool result

export async function run(win: BrowserWindow, req: AgentRunRequest): Promise<void> {
  const token = { cancelled: false }
  active.set(req.id, token)
  try {
    const settings = await getSettings()
    const { provider, apiKey, baseUrl } = settings.ai
    const model = settings.ai.model || defaultModel(provider)

    if (provider === 'none' || (!apiKey && provider !== 'local')) {
      emit(win, {
        id: req.id,
        kind: 'error',
        error: 'Connect an AI provider in Settings (a key for Claude/OpenAI/Gemini, or a local endpoint) to use the agent.'
      })
      return
    }
    const root = fsService.getWorkspaceRoot()
    if (!root) {
      emit(win, { id: req.id, kind: 'error', error: 'Open a workspace folder before running the agent.' })
      return
    }

    if (provider === 'anthropic') {
      await anthropicLoop(win, req, token, apiKey, model, baseUrl)
    } else if (provider === 'gemini') {
      // Gemini tool-calling is deferred; use the structured single-shot fallback.
      await structuredFallback(win, req, token, provider, apiKey, model, baseUrl)
    } else {
      await openAiLoop(win, req, token, provider, apiKey, model, baseUrl)
    }
  } catch (err) {
    emit(win, { id: req.id, kind: 'error', error: err instanceof Error ? err.message : String(err) })
  } finally {
    active.delete(req.id)
  }
}

function defaultModel(provider: string): string {
  const d: Record<string, string> = {
    anthropic: 'claude-opus-4-8',
    openai: 'gpt-4o',
    gemini: 'gemini-2.5-flash',
    local: 'llama3.1',
    custom: ''
  }
  return d[provider] || ''
}

// ---- tool execution (shared by every provider loop) -----------------------

/**
 * Resolve a model-supplied path against the TRUSTED workspace root and confine
 * it there, PHYSICALLY: after the textual `..`-collapse check, the real path
 * (symlinks resolved) must still be inside the workspace's real path. Without
 * this, a symlink/junction planted in a cloned repo would let read_file (which
 * auto-runs with no approval gate) follow it out of the workspace and stream a
 * file like an SSH key to the model. Returns null when the path escapes, either
 * textually or through a link. For a not-yet-existing file, the nearest existing
 * ancestor is checked (so a new file in a real workspace dir is allowed).
 */
async function resolveInWs(root: string, p: string): Promise<string | null> {
  if (typeof p !== 'string' || !p.trim()) return null
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p)
  if (!fsService.withinWorkspace(abs)) return null
  try {
    const realRoot = await realpath(root)
    // Resolve the deepest existing ancestor of `abs` (abs itself if it exists).
    let probe = abs
    // eslint-disable-next-line no-constant-condition
    for (;;) {
      try {
        const real = await realpath(probe)
        const relToRoot = relative(realRoot, real)
        // Inside the real workspace iff the relative path does not climb out.
        if (relToRoot === '' || (!relToRoot.startsWith('..') && !isAbsolute(relToRoot))) return abs
        return null
      } catch {
        const parent = dirname(probe)
        if (parent === probe) return null // reached the filesystem root
        probe = parent
      }
    }
  } catch {
    return null
  }
}

function rel(root: string, abs: string): string {
  const r = relative(root, abs)
  return r ? r.replace(/\\/g, '/') : abs
}

function clip(s: string): string {
  return s.length > MAX_TOOL_RESULT ? s.slice(0, MAX_TOOL_RESULT) + `\n... [truncated, ${s.length} chars total]` : s
}

/** A tool's outcome: `ok` drives the audit chip; `result` is fed to the model.
 *  Returned explicitly rather than sniffed from the result text, so a file whose
 *  content legitimately begins with "Error" is not shown as a failed call. */
interface ToolResult {
  ok: boolean
  result: string
}
const err = (result: string): ToolResult => ({ ok: false, result })
const ok = (result: string): ToolResult => ({ ok: true, result })

/**
 * Execute one tool call. Returns the outcome to feed back to the model plus an
 * ok flag for the audit trail. propose_edit additionally emits a staged-edit
 * event (never writes to disk).
 */
async function execTool(
  win: BrowserWindow,
  req: AgentRunRequest,
  name: string,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const root = fsService.getWorkspaceRoot()
  if (!root) return err('Error: no workspace is open.')
  try {
    if (name === READ_FILE) {
      const abs = await resolveInWs(root, String(input.path ?? ''))
      if (!abs) return err(`Error: refused, path is outside the workspace: ${input.path}`)
      if (!(await fsService.exists(abs))) return err(`Error: no such file: ${input.path}`)
      const r = await fsService.readFile(abs)
      if (r.kind === 'binary') return err(`Error: ${input.path} is a binary file.`)
      if (r.kind === 'too-large') return err(`Error: ${input.path} is too large to read (${r.size} bytes).`)
      return ok(clip(r.content))
    }

    if (name === SEARCH_PROJECT) {
      const query = String(input.query ?? '')
      if (!query.trim()) return err('Error: empty query.')
      const regex = input.regex === true || input.regex === 'true'
      const res = await searchInFiles({ root, query, caseSensitive: false, wholeWord: false, regex })
      if (res.files.length === 0) return ok(`No matches for ${JSON.stringify(query)}.`)
      const lines: string[] = [`${res.total} match(es) in ${res.files.length} file(s)${res.truncated ? ' (truncated)' : ''}:`]
      for (const f of res.files.slice(0, 40)) {
        for (const m of f.matches.slice(0, 8)) lines.push(`${rel(root, f.path)}:${m.line}: ${m.preview.trim().slice(0, 200)}`)
      }
      return ok(clip(lines.join('\n')))
    }

    if (name === GET_DIAGNOSTICS) {
      return ok(formatDiagnostics(root, req.diagnostics))
    }

    if (name === GET_PROJECT_MODEL) {
      const pm = await buildProjectModel(root)
      return ok(clip(formatProjectModel(pm)))
    }

    if (name === GET_ENVIRONMENT) {
      // The board comes from the persisted project config (the selected target),
      // so the agent reasons about the same environment the panels show.
      const cfg = await getProjectConfig(root)
      const report = await environment.inspect(root, cfg.boardFqbn ?? null, false)
      if (!report) return err('Error: could not build the environment report.')
      return ok(clip(formatEnvironmentReport(report)))
    }

    if (name === GET_HARDWARE_GRAPH) {
      const pm = await buildProjectModel(root)
      return ok(clip(formatHardwareGraph(buildHardwareGraph(pm))))
    }

    if (name === SEARCH_DOCS) {
      const query = String(input.query ?? '')
      if (!query.trim()) return err('Error: empty query.')
      const k = Math.max(1, Math.min(10, Number(input.k) || 5))
      const hits = await docs.search(root, query, k)
      return ok(clip(formatDocHits(hits)))
    }

    if (name === PROPOSE_EDIT) {
      const p = String(input.path ?? '')
      const newContent = String(input.new_content ?? '')
      const summary = typeof input.summary === 'string' ? input.summary : undefined
      const abs = await resolveInWs(root, p)
      if (!abs) {
        emit(win, {
          id: req.id,
          kind: 'edit',
          edit: { path: p, oldContent: '', newContent, summary, error: 'Refused: path is outside the workspace.' }
        })
        return err(`Error: refused, path is outside the workspace: ${p}`)
      }
      let oldContent = ''
      let originalExists = true
      try {
        const r = await fsService.readFile(abs)
        if (r.kind === 'binary' || r.kind === 'too-large') {
          const reason = r.kind === 'binary' ? 'a binary file' : 'too large to edit'
          emit(win, { id: req.id, kind: 'edit', edit: { path: abs, oldContent: '', newContent, summary, error: `Refused: ${p} is ${reason}.` } })
          return err(`Error: ${p} is ${reason}.`)
        }
        oldContent = r.content
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        originalExists = false
      }
      const edit: AgentStagedEdit = { path: abs, oldContent, originalExists, newContent, summary }
      emit(win, { id: req.id, kind: 'edit', edit })
      return ok(`Edit staged for ${originalExists ? '' : 'a new file '}${p}. It is shown to the engineer for review and has NOT been applied.`)
    }

    return err(`Error: unknown tool ${name}.`)
  } catch (e) {
    return err(`Error running ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

function formatDiagnostics(root: string, diags: Diagnostic[]): string {
  if (!diags || diags.length === 0) return 'No problems reported.'
  const lines = diags.slice(0, 60).map((d) => {
    const f = d.file ? (isAbsolute(d.file) ? rel(root, d.file) : d.file) : '?'
    return `${f}:${d.line}:${d.column} [${d.severity}] ${d.message}${d.code ? ` (${d.code})` : ''}`
  })
  if (diags.length > 60) lines.push(`... and ${diags.length - 60} more`)
  return lines.join('\n')
}

function formatProjectModel(pm: ProjectModel): string {
  const lines: string[] = []
  const b = pm.boards[0]
  if (b) lines.push(`Board: ${b.name}${b.platform ? ` (platform ${b.platform}${b.framework ? `, framework ${b.framework}` : ''})` : ''}`)
  if (pm.languages.length) lines.push(`Languages: ${pm.languages.map((l) => `${l.label} (${l.fileCount})`).join(', ')}`)
  if (pm.buses.length) {
    const seen = new Set<string>()
    const buses = pm.buses.filter((x) => (seen.has(x.bus + x.instance) ? false : seen.add(x.bus + x.instance)))
    lines.push(`Buses${pm.busesTruncated ? ' (partial)' : ''}: ${buses.map((x) => `${x.instance} ${x.bus}${x.address ? ` @ ${x.address}` : ''}${x.baud ? ` @ ${x.baud}` : ''}`).join('; ')}`)
  }
  if (pm.libraries.length) {
    const headers = [...new Set(pm.libraries.map((l) => l.header))]
    lines.push(`Device/library includes${pm.librariesTruncated ? ' (partial)' : ''}: ${headers.slice(0, 30).join(', ')}`)
  }
  if (pm.pins.length) {
    lines.push(`GPIO pins referenced${pm.pinsTruncated ? ' (partial)' : ''}: ${pm.pins.slice(0, 40).map((p) => `${p.pin} (${p.role}${p.mode ? `:${p.mode}` : ''})`).join(', ')}`)
  }
  return lines.length ? lines.join('\n') : 'No derived model available for this workspace.'
}

// ---- Anthropic tool loop --------------------------------------------------

async function anthropicLoop(
  win: BrowserWindow,
  req: AgentRunRequest,
  token: { cancelled: boolean },
  apiKey: string,
  model: string,
  baseUrl: string
): Promise<void> {
  const url = (baseUrl || 'https://api.anthropic.com') + '/v1/messages'
  const tools = toAnthropicTools()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = req.messages.map((m) => ({ role: m.role, content: m.content }))

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    if (token.cancelled) return void emit(win, { id: req.id, kind: 'done' })
    emit(win, { id: req.id, kind: 'status', text: step === 0 ? 'Thinking...' : 'Working...' })
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 8192, system: SYSTEM, tools, messages })
    })
    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const data = (await res.json()) as {
      stop_reason: string
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      content: any[]
    }
    // Cancelled while the request was in flight (fetch cannot be interrupted):
    // stop before emitting this turn's text/edits so a stopped run does not keep
    // streaming into the transcript.
    if (token.cancelled) return void emit(win, { id: req.id, kind: 'done' })
    const content = data.content || []
    for (const block of content) {
      if (block.type === 'text' && block.text) emit(win, { id: req.id, kind: 'text', delta: block.text })
    }
    const toolUses = content.filter((b) => b.type === 'tool_use')
    if (data.stop_reason !== 'tool_use' || toolUses.length === 0) {
      emit(win, { id: req.id, kind: 'done' })
      return
    }
    messages.push({ role: 'assistant', content })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolResults: any[] = []
    for (const tu of toolUses) {
      if (token.cancelled) return void emit(win, { id: req.id, kind: 'done' })
      const input = (tu.input || {}) as Record<string, unknown>
      const r = await execTool(win, req, tu.name, input)
      emit(win, { id: req.id, kind: 'tool', tool: tu.name, input: shortInput(input), ok: r.ok, result: firstLine(r.result) })
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: r.result })
    }
    messages.push({ role: 'user', content: toolResults })
  }
  emit(win, { id: req.id, kind: 'status', text: `Stopped after ${MAX_AGENT_STEPS} steps.` })
  emit(win, { id: req.id, kind: 'done' })
}

// ---- OpenAI-compatible tool loop ------------------------------------------

async function openAiLoop(
  win: BrowserWindow,
  req: AgentRunRequest,
  token: { cancelled: boolean },
  provider: string,
  apiKey: string,
  model: string,
  baseUrl: string
): Promise<void> {
  const url =
    (baseUrl || (provider === 'openai' ? 'https://api.openai.com' : 'http://localhost:11434')) + '/v1/chat/completions'
  const tools = toOpenAiTools()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [{ role: 'system', content: SYSTEM }, ...req.messages.map((m) => ({ role: m.role, content: m.content }))]

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    if (token.cancelled) return void emit(win, { id: req.id, kind: 'done' })
    emit(win, { id: req.id, kind: 'status', text: step === 0 ? 'Thinking...' : 'Working...' })
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, tools, tool_choice: 'auto', messages })
    })
    if (!res.ok) throw new Error(`AI API error ${res.status}: ${(await res.text()).slice(0, 500)}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json()) as any
    if (token.cancelled) return void emit(win, { id: req.id, kind: 'done' })
    const msg = data.choices?.[0]?.message
    if (!msg) throw new Error('AI API returned no message.')
    if (msg.content) emit(win, { id: req.id, kind: 'text', delta: msg.content })
    const calls = msg.tool_calls || []
    if (calls.length === 0) {
      emit(win, { id: req.id, kind: 'done' })
      return
    }
    messages.push(msg)
    for (const call of calls) {
      if (token.cancelled) return void emit(win, { id: req.id, kind: 'done' })
      let input: Record<string, unknown> = {}
      try {
        input = JSON.parse(call.function?.arguments || '{}')
      } catch {
        input = {}
      }
      const r = await execTool(win, req, call.function?.name, input)
      emit(win, { id: req.id, kind: 'tool', tool: call.function?.name, input: shortInput(input), ok: r.ok, result: firstLine(r.result) })
      messages.push({ role: 'tool', tool_call_id: call.id, content: r.result })
    }
  }
  emit(win, { id: req.id, kind: 'status', text: `Stopped after ${MAX_AGENT_STEPS} steps.` })
  emit(win, { id: req.id, kind: 'done' })
}

// ---- structured single-shot fallback (no tool-calling) --------------------

async function structuredFallback(
  win: BrowserWindow,
  req: AgentRunRequest,
  token: { cancelled: boolean },
  provider: string,
  apiKey: string,
  model: string,
  baseUrl: string
): Promise<void> {
  const root = fsService.getWorkspaceRoot()!
  emit(win, { id: req.id, kind: 'status', text: 'Gathering context...' })
  // The fallback cannot read on demand, so assemble the read-only context up
  // front: project model, diagnostics, and the active file.
  const ctx: string[] = []
  try {
    const pm = await buildProjectModel(root)
    ctx.push('PROJECT MODEL:\n' + formatProjectModel(pm))
    ctx.push('HARDWARE GRAPH:\n' + formatHardwareGraph(buildHardwareGraph(pm)))
  } catch {
    /* no model */
  }
  try {
    const cfg = await getProjectConfig(root)
    const report = await environment.inspect(root, cfg.boardFqbn ?? null, false)
    if (report) ctx.push('ENVIRONMENT:\n' + formatEnvironmentReport(report))
  } catch {
    /* no environment */
  }
  // The fallback cannot call search_docs, so pre-retrieve passages for the task
  // (the last user message) and front-load them with their citations.
  try {
    const taskText = req.messages[req.messages.length - 1]?.content ?? ''
    const hits = await docs.search(root, taskText, 5)
    if (hits.length) ctx.push('RELEVANT DOCUMENTATION (cite these):\n' + formatDocHits(hits))
  } catch {
    /* no docs */
  }
  ctx.push('DIAGNOSTICS:\n' + formatDiagnostics(root, req.diagnostics))
  if (req.activePath) {
    const abs = await resolveInWs(root, req.activePath)
    if (abs && (await fsService.exists(abs))) {
      const r = await fsService.readFile(abs)
      if (r.kind === 'text') ctx.push(`ACTIVE FILE ${rel(root, abs)}:\n${clip(r.content)}`)
    }
  }
  // Thread the prior turns so a follow-up task keeps context, matching the tool
  // loops (which forward the whole conversation). The last message is the task.
  const history = req.messages
    .slice(0, -1)
    .map((m) => `${m.role === 'user' ? 'ENGINEER' : 'AGENT'}: ${m.content}`)
    .join('\n')
  const task = req.messages[req.messages.length - 1]?.content ?? ''
  const prompt = `${ctx.join('\n\n')}${history ? `\n\nCONVERSATION SO FAR:\n${history}` : ''}\n\nTASK: ${task}\n\n${STRUCTURED_FALLBACK_INSTRUCTION}`
  if (token.cancelled) return void emit(win, { id: req.id, kind: 'done' })

  emit(win, { id: req.id, kind: 'status', text: 'Thinking...' })
  const text = await singleShot(provider, apiKey, model, baseUrl, prompt)
  if (token.cancelled) return void emit(win, { id: req.id, kind: 'done' })

  const parsed = parseStructuredProposal(text)
  if (!parsed) {
    // Not JSON: surface the reply as a plain answer.
    emit(win, { id: req.id, kind: 'text', delta: text })
    emit(win, { id: req.id, kind: 'done' })
    return
  }
  if (parsed.answer) emit(win, { id: req.id, kind: 'text', delta: parsed.answer })
  for (const e of parsed.edits) {
    await execTool(win, req, PROPOSE_EDIT, { path: e.path, new_content: e.new_content, summary: e.summary })
  }
  emit(win, { id: req.id, kind: 'done' })
}

/** One non-streaming completion, used only by the structured fallback. */
async function singleShot(provider: string, apiKey: string, model: string, baseUrl: string, prompt: string): Promise<string> {
  if (provider === 'gemini') {
    const base = baseUrl || 'https://generativelanguage.googleapis.com'
    const mdl = model || 'gemini-2.5-flash'
    const url = `${base}/v1beta/models/${mdl}:generateContent?key=${encodeURIComponent(apiKey)}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }] })
    })
    if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${(await res.text()).slice(0, 500)}`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (await res.json()) as any
    return (data.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || '').join('')
  }
  // OpenAI-compatible non-streaming (also covers a local endpoint used as fallback).
  const url =
    (baseUrl || (provider === 'openai' ? 'https://api.openai.com' : 'http://localhost:11434')) + '/v1/chat/completions'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }] })
  })
  if (!res.ok) throw new Error(`AI API error ${res.status}: ${(await res.text()).slice(0, 500)}`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (await res.json()) as any
  return data.choices?.[0]?.message?.content || ''
}

// ---- small formatting helpers for the audit trail -------------------------

function shortInput(input: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(input)) {
    if (k === 'new_content') parts.push(`${k}: <${String(v).length} chars>`)
    else parts.push(`${k}: ${JSON.stringify(v).slice(0, 80)}`)
  }
  return parts.join(', ')
}

function firstLine(s: string): string {
  const line = s.split('\n')[0]
  return line.length > 160 ? line.slice(0, 160) + '...' : line
}
