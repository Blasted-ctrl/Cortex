import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, CheckCircle2, XCircle, X, Plus, Search } from 'lucide-react'
import { useStore } from '../store/useStore'
import { isValidIndexUrl } from '@shared/boardUrls'
import { BAUD_RATES } from '@shared/serial'
import type { ToolchainInfo } from '@shared/ipc'
import { NativeLibrariesSettings } from './NativeLibrariesSettings'
import { AutoSaveSetting } from './AutoSaveSetting'

const KIND_LABEL: Record<ToolchainInfo['kind'], string> = {
  cpp: 'C / C++',
  c: 'C / C++',
  embedded: 'Embedded toolchains',
  python: 'Python',
  rust: 'Rust',
  node: 'JavaScript',
  cmake: 'Build Systems',
  other: 'CLI & Tools'
}

type Category = 'appearance' | 'build' | 'libraries' | 'serial' | 'ai' | 'boards' | 'diagnostics'
const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'build', label: 'Build' },
  { id: 'libraries', label: 'Libraries' },
  { id: 'serial', label: 'Serial' },
  { id: 'ai', label: 'Cortex Agent' },
  { id: 'boards', label: 'Board Manager' },
  { id: 'diagnostics', label: 'Diagnostics' }
]
const catLabel = (id: Category): string => CATEGORIES.find((c) => c.id === id)?.label ?? id

const input =
  'w-full rounded border border-ide-border bg-ide-bg px-2 py-1.5 text-[12px] text-ide-text outline-none focus:border-ide-accent'

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-ide-text">{label}</span>
      {hint && <span className="mb-1.5 block text-[11px] leading-relaxed text-ide-faint">{hint}</span>}
      {children}
    </label>
  )
}

/**
 * A text field that commits on blur/Enter instead of on every keystroke.
 * Binding these straight to updateSettings made each character an IPC round-trip
 * plus a settings.json write.
 */
function DraftInput({
  value,
  onCommit,
  placeholder
}: {
  value: string
  onCommit: (v: string) => void
  placeholder?: string
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  const revision = useRef(0)
  const cleanRevision = useRef(0)
  const submitted = useRef<{ value: string; revision: number } | null>(null)
  useEffect(() => {
    const savedCurrentDraft = submitted.current?.value === value && submitted.current.revision === revision.current
    if (revision.current !== cleanRevision.current && !savedCurrentDraft) return
    cleanRevision.current = revision.current
    submitted.current = null
    setDraft(value)
  }, [value])
  return (
    <input
      className={input}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => { revision.current++; setDraft(e.target.value) }}
      onBlur={() => {
        if (draft === value) {
          cleanRevision.current = revision.current
          submitted.current = null
          return
        }
        submitted.current = { value: draft, revision: revision.current }
        onCommit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        if (e.key === 'Escape') {
          revision.current++
          cleanRevision.current = revision.current
          submitted.current = null
          setDraft(value)
        }
      }}
    />
  )
}

/**
 * Settings as a full editor-area surface: a search box + category nav on the
 * left and a wide content pane. Every entry point (left rail, title bar,
 * Ctrl+comma, palette) opens this view. Fields are a searchable registry so the
 * search filters the actual controls, not a fake list. The API key is saved
 * through the main process and never sent back to the renderer.
 */
export default function SettingsView(): JSX.Element {
  const {
    settings,
    loadSettings,
    updateSettings,
    setTheme,
    compiler,
    toolchains,
    detectToolchains,
    setMainView,
    serialBaud,
    setSerialBaud
  } = useStore()
  const [cat, setCat] = useState<Category>('appearance')
  const [query, setQuery] = useState('')
  const contentRef = useRef<HTMLDivElement>(null)
  const [rescanning, setRescanning] = useState(false)
  const [keyDraft, setKeyDraft] = useState('')
  const [keySaved, setKeySaved] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')
  const draftVersion = useRef({ key: 0, url: 0 })

  useEffect(() => {
    if (!settings) void loadSettings()
  }, [settings, loadSettings])
  // Reset the shared scroll container when the shown content changes.
  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [cat, query])

  const rescan = async (): Promise<void> => {
    setRescanning(true)
    await detectToolchains(true)
    setRescanning(false)
  }
  const boardUrls = settings?.boards?.additionalUrls ?? []
  const currentUrls = (): string[] => useStore.getState().settings?.boards?.additionalUrls ?? []
  const commitSettings = async (operation: Promise<void>, onSaved?: () => void): Promise<void> => {
    try { await operation }
    catch { return } // updateSettings already reports persistence failures.
    onSaved?.()
  }
  const addBoardUrl = (): void => {
    const u = urlDraft.trim()
    if (!isValidIndexUrl(u)) return
    const urls = currentUrls()
    const version = draftVersion.current.url
    const clearDraft = (): void => {
      if (draftVersion.current.url !== version) return
      draftVersion.current.url++
      setUrlDraft('')
    }
    if (urls.includes(u)) { clearDraft(); return }
    void commitSettings(updateSettings({ boards: { additionalUrls: [...urls, u] } }), clearDraft)
  }
  const removeBoardUrl = (u: string): void => {
    void commitSettings(updateSettings({ boards: { additionalUrls: currentUrls().filter((x) => x !== u) } }))
  }
  const saveKey = (): void => {
    if (!settings || !keyDraft.trim()) return
    const version = draftVersion.current.key
    void commitSettings(updateSettings({ ai: { ...settings.ai, apiKey: keyDraft } }), () => {
      if (draftVersion.current.key !== version) return
      draftVersion.current.key++
      setKeyDraft('')
      setKeySaved(true)
    })
  }

  const toolGroups = new Map<string, ToolchainInfo[]>()
  for (const t of toolchains) {
    const g = KIND_LABEL[t.kind]
    if (!toolGroups.has(g)) toolGroups.set(g, [])
    toolGroups.get(g)!.push(t)
  }

  // The searchable field registry. `keywords` broadens matching beyond the
  // visible label (e.g. "gcc" finds the compiler field). `el` is the rendered
  // control, so search shows the real fields.
  type FieldDef = { cat: Category; label: string; keywords: string; el: JSX.Element }
  const fields: FieldDef[] = useMemo(() => {
    if (!settings) return []
    return [
      {
        cat: 'appearance',
        label: 'Auto save',
        keywords: 'autosave save files unsaved restart lose work editor',
        el: <AutoSaveSetting />
      },
      {
        cat: 'appearance',
        label: 'Theme',
        keywords: 'dark light color mode',
        el: (
          <Field label="Theme">
            <div
              className="row w-56 gap-1 rounded border border-ide-border bg-ide-bg p-0.5"
              role="group"
              aria-label="Theme"
            >
              {(['dark', 'light'] as const).map((t) => {
                const active = (settings.theme ?? 'dark') === t
                return (
                  <button
                    key={t}
                    className={`flex-1 rounded px-2 py-1 text-[12px] capitalize transition-colors ${
                      active ? 'bg-ide-accent text-white' : 'text-ide-muted hover:bg-ide-hover hover:text-ide-text'
                    }`}
                    aria-pressed={active}
                    onClick={() => !active && void commitSettings(setTheme(t))}
                  >
                    {t}
                  </button>
                )
              })}
            </div>
          </Field>
        )
      },
      {
        cat: 'build',
        label: 'Default C++ compiler',
        keywords: 'gcc clang g++ clang++ toolchain',
        el: (
          <Field label="Default C++ compiler" hint="Used when a project has not pinned one of its own.">
            <DraftInput
              value={settings.defaultCppCompiler}
              placeholder={compiler ? `auto: ${compiler}` : 'auto-detect'}
              onCommit={(v) => void commitSettings(updateSettings({ defaultCppCompiler: v }))}
            />
          </Field>
        )
      },
      {
        cat: 'build',
        label: 'Default C++ standard',
        keywords: 'c++11 c++17 c++20 c++23 std',
        el: (
          <Field label="Default C++ standard">
            <select
              className={input}
              value={settings.defaultCppStandard}
              onChange={(e) => void commitSettings(updateSettings({ defaultCppStandard: e.target.value }))}
            >
              {['c++11', 'c++14', 'c++17', 'c++20', 'c++23', 'c++2c'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        )
      },
      {
        cat: 'build',
        label: 'Python interpreter',
        keywords: 'python venv interpreter path',
        el: (
          <Field label="Python interpreter" hint="Path to the python used to run scripts. Leave blank to auto-detect.">
            <DraftInput value={settings.pythonPath} onCommit={(v) => void commitSettings(updateSettings({ pythonPath: v }))} />
          </Field>
        )
      },
      {
        cat: 'serial',
        label: 'Baud rate',
        keywords: 'serial monitor speed bps 115200 9600 baudrate',
        el: (
          <Field
            label="Baud rate"
            hint="The serial monitor and plotter open the port at this speed. A change takes effect immediately."
          >
            <select
              className={input.replace('w-full', 'w-40')}
              value={serialBaud}
              onChange={(e) => void setSerialBaud(Number(e.target.value))}
            >
              {BAUD_RATES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </Field>
        )
      },
      {
        cat: 'ai',
        label: 'Provider',
        keywords: 'ai anthropic claude openai gpt gemini ollama lm studio custom',
        el: (
          <Field label="Provider">
            <select
              className={input}
              value={settings.ai.provider}
              onChange={(e) =>
                void commitSettings(updateSettings({ ai: { ...settings.ai, provider: e.target.value as never, model: '' } }))
              }
            >
              <option value="none">None (offline)</option>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="openai">OpenAI (GPT)</option>
              <option value="gemini">Google (Gemini)</option>
              <option value="local">Local (Ollama / LM Studio)</option>
              <option value="custom">Custom (OpenAI-compatible)</option>
            </select>
          </Field>
        )
      },
      {
        cat: 'ai',
        label: 'Model',
        keywords: 'ai model',
        el: (
          <Field label="Model">
            <DraftInput
              value={settings.ai.model}
              placeholder={
                {
                  anthropic: 'claude-opus-4-8',
                  openai: 'gpt-4o',
                  gemini: 'gemini-2.5-flash',
                  local: 'llama3.1',
                  custom: 'model id',
                  none: ''
                }[settings.ai.provider]
              }
              onCommit={(v) => void commitSettings(updateSettings({ ai: { ...settings.ai, model: v } }))}
            />
          </Field>
        )
      },
      {
        cat: 'ai',
        label: 'API key',
        keywords: 'ai api key token secret',
        el: (
          <Field label="API key">
            <div className="row gap-1.5">
              <input
                type="password"
                className={input}
                placeholder={settings.ai.apiKeySet ? 'saved. type a new key to replace' : 'paste your key'}
                value={keyDraft}
                onChange={(e) => {
                  draftVersion.current.key++
                  setKeyDraft(e.target.value)
                  setKeySaved(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && keyDraft.trim()) saveKey()
                }}
              />
              <button
                className="btn btn-accent shrink-0 text-[12px] disabled:opacity-40"
                disabled={!keyDraft.trim()}
                onClick={saveKey}
              >
                Save
              </button>
            </div>
            {(keySaved || settings.ai.apiKeySet) && !keyDraft && (
              <span className="mt-1 block text-[11px] text-ide-moss">Key saved.</span>
            )}
            <span className="mt-1.5 block text-[11px] leading-relaxed text-ide-faint">
              Encrypted at rest when your OS keyring is available; otherwise stored locally without encryption.
            </span>
          </Field>
        )
      },
      {
        cat: 'ai',
        label: 'Base URL',
        keywords: 'ai base url endpoint ollama localhost',
        el: (
          <Field label="Base URL (optional)">
            <DraftInput
              value={settings.ai.baseUrl}
              placeholder="e.g. http://localhost:11434 for Ollama"
              onCommit={(v) => void commitSettings(updateSettings({ ai: { ...settings.ai, baseUrl: v } }))}
            />
          </Field>
        )
      },
      {
        cat: 'boards',
        label: 'Board Manager URLs',
        keywords: 'esp32 esp8266 package index core additional url',
        el: (
          <div className="space-y-2">
            <p className="text-[11px] leading-relaxed text-ide-faint">
              Extra package index URLs for the Boards Manager. ESP32 and ESP8266 are included by default. A new URL
              takes effect the next time you search or install a core.
            </p>
            <div className="space-y-1 rounded border border-ide-border bg-ide-bg p-2">
              {boardUrls.length === 0 ? (
                <div className="text-[12px] text-ide-faint">No additional URLs.</div>
              ) : (
                boardUrls.map((u) => (
                  <div key={u} className="row justify-between gap-2 text-[12px]">
                    <span className="mono min-w-0 truncate text-ide-muted" title={u}>
                      {u}
                    </span>
                    <button
                      className="shrink-0 rounded p-0.5 text-ide-faint hover:bg-ide-hover hover:text-ide-text"
                      title="Remove"
                      onClick={() => removeBoardUrl(u)}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="row gap-1.5">
              <input
                className={input}
                value={urlDraft}
                placeholder="https://.../package_..._index.json"
                onChange={(e) => { draftVersion.current.url++; setUrlDraft(e.target.value) }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addBoardUrl()
                }}
              />
              <button
                className="btn btn-accent row shrink-0 gap-1 text-[12px] disabled:opacity-40"
                disabled={!urlDraft.trim()}
                onClick={addBoardUrl}
              >
                <Plus size={13} /> Add
              </button>
            </div>
          </div>
        )
      },
      {
        cat: 'libraries',
        label: 'C++ and Python libraries',
        keywords: 'libraries opencv raylib sdl sdl2 glfw cv2 install headers include link dependencies numpy pip pacman msys2',
        el: <NativeLibrariesSettings />
      },
      {
        cat: 'diagnostics',
        label: 'Detected toolchains',
        keywords: 'diagnostics compilers tools detected version rescan system',
        el: (
          <div className="space-y-2">
            <div className="row items-center justify-between">
              <p className="text-[11px] leading-relaxed text-ide-faint">
                Read-only: the compilers and tools Cortex detected on this machine.
              </p>
              <button
                className="row shrink-0 gap-1 rounded px-1.5 py-0.5 text-[11px] text-ide-muted hover:bg-ide-hover hover:text-ide-text"
                onClick={rescan}
                title="Rescan your system"
              >
                <RefreshCw size={12} className={rescanning ? 'animate-spin' : ''} /> Rescan
              </button>
            </div>
            {toolchains.length === 0 ? (
              <div className="text-[12px] text-ide-faint">Scanning your system...</div>
            ) : (
              <div className="space-y-2 rounded border border-ide-border bg-ide-bg p-3">
                {[...toolGroups.entries()].map(([group, items]) => (
                  <div key={group}>
                    <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-ide-faint">{group}</div>
                    {items.map((t) => (
                      <div
                        key={t.id}
                        className="row justify-between gap-2 py-0.5 text-[12px]"
                        title={t.version || 'not found'}
                      >
                        <span className="row min-w-0 gap-1.5">
                          {t.available ? (
                            <CheckCircle2 size={13} className="shrink-0 text-ide-green" />
                          ) : (
                            <XCircle size={13} className="shrink-0 text-ide-faint" />
                          )}
                          <span className={`truncate ${t.available ? 'text-ide-text' : 'text-ide-faint'}`}>{t.name}</span>
                        </span>
                        {t.available && t.version && (
                          <span className="mono shrink-0 truncate text-[10px] text-ide-muted" style={{ maxWidth: 120 }}>
                            {t.version.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? t.version.split(' ')[0]}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      }
    ]
  }, [settings, compiler, toolchains, rescanning, keyDraft, keySaved, urlDraft, boardUrls, serialBaud])

  const q = query.trim().toLowerCase()
  const matches = (f: FieldDef): boolean =>
    !q || f.label.toLowerCase().includes(q) || f.keywords.includes(q) || catLabel(f.cat).toLowerCase().includes(q)
  const shown = q ? fields.filter(matches) : fields.filter((f) => f.cat === cat)
  const matchingCats = new Set(fields.filter(matches).map((f) => f.cat))

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-ide-border bg-ide-bg">
      <div className="row h-9 shrink-0 items-center justify-between border-b border-ide-border bg-ide-panel px-3">
        <span className="text-[12px] font-semibold text-ide-text">Settings</span>
        <button
          className="rounded p-1 text-ide-muted hover:bg-ide-hover hover:text-ide-text"
          onClick={() => setMainView('editor')}
          title="Close settings"
          aria-label="Close settings"
        >
          <X size={15} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <nav className="flex w-52 shrink-0 flex-col border-r border-ide-border bg-ide-panel" aria-label="Settings categories">
          <div className="row m-2 gap-1.5 rounded border border-ide-border bg-ide-bg px-2">
            <Search size={13} className="shrink-0 text-ide-faint" />
            <input
              className="h-7 w-full bg-transparent text-[12px] text-ide-text outline-none placeholder:text-ide-faint"
              placeholder="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search settings"
            />
            {query && (
              <button
                className="shrink-0 rounded p-0.5 text-ide-faint hover:text-ide-text"
                title="Clear"
                aria-label="Clear search"
                onClick={() => setQuery('')}
              >
                <X size={12} />
              </button>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
            {CATEGORIES.map((c) => {
              const dim = !!q && !matchingCats.has(c.id)
              return (
                <button
                  key={c.id}
                  className={`w-full rounded px-2 py-1.5 text-left text-[12.5px] transition-colors ${
                    !q && cat === c.id
                      ? 'bg-ide-active text-ide-text'
                      : dim
                        ? 'text-ide-faint hover:bg-ide-hover'
                        : 'text-ide-muted hover:bg-ide-hover hover:text-ide-text'
                  }`}
                  aria-current={!q && cat === c.id}
                  onClick={() => {
                    setQuery('')
                    setCat(c.id)
                  }}
                >
                  {c.label}
                </button>
              )
            })}
          </div>
        </nav>
        <div ref={contentRef} className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-2xl space-y-4 p-6">
            {!settings ? (
              <div className="text-[12px] text-ide-faint">Loading settings...</div>
            ) : q ? (
              shown.length === 0 ? (
                <div className="text-[12px] text-ide-faint">No settings match &quot;{query}&quot;.</div>
              ) : (
                // Search: matching fields, grouped by category.
                CATEGORIES.filter((c) => shown.some((f) => f.cat === c.id)).map((c) => (
                  <section key={c.id} className="space-y-4">
                    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-ide-faint">{c.label}</h3>
                    {shown.filter((f) => f.cat === c.id).map((f) => (
                      <div key={f.label}>{f.el}</div>
                    ))}
                  </section>
                ))
              )
            ) : (
              <>
                <h2 className="text-[16px] font-semibold text-ide-text">{catLabel(cat)}</h2>
                {shown.map((f) => (
                  <div key={f.label}>{f.el}</div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
