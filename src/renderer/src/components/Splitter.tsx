import { useRef } from 'react'

/**
 * A thin drag handle between panels. Reports incremental pointer deltas so the
 * caller can clamp; uses pointer capture so the drag survives the cursor
 * leaving the 4px strip.
 *
 * dir 'x' = vertical rule, drag horizontally (resizes a width).
 * dir 'y' = horizontal rule, drag vertically (resizes a height).
 */
export default function Splitter({
  dir,
  label,
  controls,
  value,
  min,
  max,
  unit,
  onDelta,
  onBoundary,
  title
}: {
  dir: 'x' | 'y'
  label: string
  controls: string
  value: number
  min: number
  max: number
  unit: 'pixels' | 'percent'
  onDelta: (delta: number) => void
  onBoundary: (edge: 'min' | 'max') => void
  title?: string
}): JSX.Element {
  const last = useRef<number | null>(null)
  const disabled = min === max

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
    const negative = dir === 'x' ? 'ArrowLeft' : 'ArrowUp'
    const positive = dir === 'x' ? 'ArrowRight' : 'ArrowDown'
    if (e.key !== negative && e.key !== positive && e.key !== 'Home' && e.key !== 'End') return
    e.preventDefault()
    if (disabled) return
    if (e.key === 'Home' || e.key === 'End') onBoundary(e.key === 'Home' ? 'min' : 'max')
    else onDelta(e.key === negative ? -10 : 10)
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    last.current = dir === 'x' ? e.clientX : e.clientY
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    if (last.current === null) return
    const cur = dir === 'x' ? e.clientX : e.clientY
    const d = cur - last.current
    if (d !== 0) {
      onDelta(d)
      last.current = cur
    }
  }
  const end = (e: React.PointerEvent): void => {
    last.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-controls={controls}
      aria-orientation={dir === 'x' ? 'vertical' : 'horizontal'}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={`${Number(value.toFixed(1))}${unit === 'percent' ? '%' : ' pixels'}`}
      aria-disabled={disabled || undefined}
      title={title}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      className={
        // A 1px rule, the same weight as every other border in the app. A 4px
        // filled bar reads as a third panel, not a divider.
        dir === 'x'
          ? 'group relative z-10 w-px shrink-0 cursor-col-resize bg-ide-border transition-colors hover:bg-ide-accent'
          : 'group relative z-10 h-px shrink-0 cursor-row-resize bg-ide-border transition-colors hover:bg-ide-accent'
      }
    >
      {/* The hit area is wider than the rule so it stays easy to grab. */}
      <span
        className={
          dir === 'x'
            ? 'absolute inset-y-0 -left-1 -right-1 block'
            : 'absolute inset-x-0 -top-1 -bottom-1 block'
        }
      />
    </div>
  )
}
