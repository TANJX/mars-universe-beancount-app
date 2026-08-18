"use client"

// PROTOTYPE harness chrome — delete with the rest of app/(ledger)/proto/.
// Behaviour and styling follow the prototype skill's picker spec verbatim:
// number keys and arrows switch, R re-mounts, selection persists in ?v=,
// the highlight slides but the variant swap is instant.

import * as React from "react"

export function ProtoPicker({
  names,
  current,
  onSelect,
  onReplay,
}: {
  names: string[]
  current: number
  onSelect: (i: number) => void
  onReplay: () => void
}) {
  const navRef = React.useRef<HTMLElement | null>(null)
  const itemRefs = React.useRef<(HTMLButtonElement | null)[]>([])
  const [style, setStyle] = React.useState<React.CSSProperties>({})
  const [ready, setReady] = React.useState(false)

  const measure = React.useCallback(() => {
    const el = itemRefs.current[current]
    if (!el) return
    setStyle({
      width: `${el.offsetWidth}px`,
      transform: `translateX(${el.offsetLeft}px)`,
    })
  }, [current])

  // Position without animating on first paint, then enable the slide.
  React.useLayoutEffect(() => {
    measure()
  }, [measure])

  React.useEffect(() => {
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => setReady(true))
    )
    return () => cancelAnimationFrame(raf)
  }, [])

  React.useEffect(() => {
    window.addEventListener("resize", measure)
    return () => window.removeEventListener("resize", measure)
  }, [measure])

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (
        t &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)
      )
        return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const num = Number.parseInt(e.key, 10)
      if (num >= 1 && num <= names.length) onSelect(num - 1)
      else if (e.key === "ArrowRight") onSelect((current + 1) % names.length)
      else if (e.key === "ArrowLeft")
        onSelect((current - 1 + names.length) % names.length)
      else if (e.key === "r" || e.key === "R") onReplay()
    }
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [names.length, current, onSelect, onReplay])

  return (
    <nav
      ref={navRef}
      className="proto-picker"
      aria-label="Prototype variants"
      {...(ready ? { "data-ready": "" } : {})}
    >
      <span
        className="proto-picker-highlight"
        aria-hidden="true"
        style={style}
      />
      {names.map((name, i) => (
        <button
          key={name}
          type="button"
          ref={(el) => {
            itemRefs.current[i] = el
          }}
          className="proto-picker-item"
          onClick={() => onSelect(i)}
          {...(i === current
            ? { "data-active": "", "aria-current": "true" as const }
            : {})}
        >
          {name}
        </button>
      ))}
      <span className="proto-picker-divider" aria-hidden="true" />
      <button
        type="button"
        className="proto-picker-item proto-picker-replay"
        aria-label="Replay animation (R)"
        onClick={onReplay}
      >
        ↻
      </button>
    </nav>
  )
}
