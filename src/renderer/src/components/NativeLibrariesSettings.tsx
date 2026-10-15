import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Download, Loader2 } from 'lucide-react'
import { useStore } from '../store/useStore'
import type { NativeLibStatus } from '@shared/nativeLibs'

/**
 * One row per catalog library with its C++ and Python state and an Install
 * button for each. Install runs through the same streamed, single-flight path as
 * board packages, so its progress shows in the Output panel and the buttons
 * disable while anything else is running.
 */
export function NativeLibrariesSettings(): JSX.Element {
  const running = useStore((s) => s.running)
  const installNativeLib = useStore((s) => s.installNativeLib)
  const [libs, setLibs] = useState<NativeLibStatus[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  const refresh = useCallback(() => {
    // An app started before this feature existed has no such bridge call; say so
    // instead of throwing inside an effect and blanking the whole Settings page.
    if (typeof window.api.nativeLibStatus !== 'function') {
      setError('This part of Cortex needs a restart to finish updating.')
      return
    }
    window.api
      .nativeLibStatus(useStore.getState().nativeLibQuery())
      .then((l) => {
        setLibs(l)
        setError('')
      })
      .catch((e) => setError(String(e)))
  }, [])

  // Re-read when an install finishes (running flips back to false).
  useEffect(() => {
    if (!running) refresh()
  }, [running, refresh])

  const install = async (id: string, target: 'cpp' | 'python'): Promise<void> => {
    setBusy(`${id}:${target}`)
    try {
      await installNativeLib(id, target)
    } finally {
      setBusy('')
      refresh()
    }
  }

  if (error) return <p className="text-[11px] text-ide-red">Library status unavailable: {error}</p>
  if (!libs) return <p className="text-[11px] text-ide-faint">Checking installed libraries...</p>

  const button = (lib: NativeLibStatus, target: 'cpp' | 'python', title: string): JSX.Element => {
    const working = busy === `${lib.id}:${target}`
    const manual = target === 'cpp' && lib.install.kind === 'manual'
    return (
      <button
        className="row shrink-0 gap-1 rounded border border-ide-border px-2 py-1 text-[11px] text-ide-text hover:bg-ide-hover disabled:opacity-50"
        disabled={running || manual}
        title={manual && lib.install.kind === 'manual' ? lib.install.reason : title}
        onClick={() => void install(lib.id, target)}
      >
        {working ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" /> : <Download size={12} />} Install
      </button>
    )
  }

  const state = (ok: boolean, label: string, action: JSX.Element): JSX.Element => (
    <div className="row items-center justify-between gap-2">
      <span className="text-[11px] text-ide-muted">{label}</span>
      {ok ? (
        <span className="row gap-1 text-[11px] text-ide-green">
          <CheckCircle2 size={12} /> Installed
        </span>
      ) : (
        action
      )}
    </div>
  )

  return (
    <div className="space-y-3">
      <p className="text-[11px] leading-relaxed text-ide-faint">
        Cortex works out include paths, link flags and runtime DLLs for these libraries on its own. Just
        <code> #include </code> or <code>import</code> them; install here when one is missing. Nothing is added to
        your PATH or to your project files.
      </p>
      {libs.map((lib) => (
        <div key={lib.id} className="space-y-1.5 rounded border border-ide-border p-2.5">
          <div>
            <span className="text-[12px] font-medium text-ide-text">{lib.name}</span>
            <span className="ml-2 text-[11px] text-ide-faint">{lib.blurb}</span>
          </div>
          {state(lib.installed, 'C / C++', button(lib, 'cpp', `Install ${lib.name} for C/C++`))}
          {lib.python !== null && state(lib.python, 'Python', button(lib, 'python', `pip install for ${lib.name}`))}
          {!lib.installed && lib.install.kind === 'manual' && (
            <p className="text-[11px] leading-relaxed text-ide-faint">{lib.install.reason}</p>
          )}
        </div>
      ))}
    </div>
  )
}
