import { useState } from 'react'
import { AUTO_SAVE_DELAY_MS, readAutoSave, writeAutoSave } from '../store/autoSave'

/** Settings > Appearance: whether edits are written to disk shortly after you stop typing. */
export function AutoSaveSetting(): JSX.Element {
  const [on, setOn] = useState(readAutoSave)
  return (
    <div>
      <span className="mb-1 block text-[12px] font-medium text-ide-text">Auto save</span>
      <span className="mb-1.5 block text-[11px] leading-relaxed text-ide-faint">
        Saves changed files about {(AUTO_SAVE_DELAY_MS / 1000).toFixed(1)} seconds after you stop typing, so an unexpected
        restart does not lose work. Ctrl+S still saves immediately.
      </span>
      <div className="row w-56 gap-1 rounded border border-ide-border bg-ide-bg p-0.5" role="group" aria-label="Auto save">
        {([true, false] as const).map((value) => {
          const active = on === value
          return (
            <button
              key={String(value)}
              className={`flex-1 rounded px-2 py-1 text-[12px] transition-colors ${
                active ? 'bg-ide-accent text-white' : 'text-ide-muted hover:bg-ide-hover hover:text-ide-text'
              }`}
              aria-pressed={active}
              onClick={() => {
                writeAutoSave(value)
                setOn(value)
              }}
            >
              {value ? 'On' : 'Off'}
            </button>
          )
        })}
      </div>
    </div>
  )
}
