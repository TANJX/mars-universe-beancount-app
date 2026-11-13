"use client"

// Month scrubbing for the runway chart, one model for every input:
// - mouse: moving previews a month, a click pins it (click it again to
//   unpin), leaving the plot clears an unpinned preview;
// - touch and pen: tap or drag sideways pins the month under the finger
//   (the plot is `touch-action: pan-y`, so vertical swipes still scroll);
// - keyboard: arrows step, Home and End jump, Escape clears.
// The readout (tooltip, legend values, notes) reads `index`; null means
// "end of plan" for the legend and nothing for the crosshair.

import * as React from "react"

export interface ScrubState {
  index: number | null
  pinned: boolean
}

export interface Scrub extends ScrubState {
  set: (index: number | null, pinned: boolean) => void
  /** Pin `index`, or clear it when it is already pinned. */
  toggle: (index: number) => void
  /** Handlers for the plot element; `indexAt` maps a clientX to a month. */
  bind: (indexAt: (clientX: number) => number | null) => {
    onPointerMove: (e: React.PointerEvent) => void
    onPointerDown: (e: React.PointerEvent) => void
    onPointerUp: () => void
    onPointerCancel: () => void
    onPointerLeave: (e: React.PointerEvent) => void
    onKeyDown: (e: React.KeyboardEvent) => void
  }
}

export function useScrub(count: number): Scrub {
  const [state, setState] = React.useState<ScrubState>({
    index: null,
    pinned: false,
  })
  const dragging = React.useRef(false)
  const last = count - 1

  // A shorter run (horizon edit) must not leave the index past the end.
  React.useEffect(() => {
    setState((s) =>
      s.index != null && s.index > last ? { index: null, pinned: false } : s
    )
  }, [last])

  const set = React.useCallback((index: number | null, pinned: boolean) => {
    setState((s) => {
      const next = { index, pinned: index != null && pinned }
      return s.index === next.index && s.pinned === next.pinned ? s : next
    })
  }, [])

  const toggle = React.useCallback((index: number) => {
    setState((s) =>
      s.pinned && s.index === index
        ? { index: null, pinned: false }
        : { index, pinned: true }
    )
  }, [])

  const bind: Scrub["bind"] = (indexAt) => ({
    onPointerMove: (e) => {
      const i = indexAt(e.clientX)
      if (i == null) return
      if (e.pointerType === "mouse") {
        if (!state.pinned) set(i, false)
      } else if (dragging.current) set(i, true)
    },
    onPointerDown: (e) => {
      const i = indexAt(e.clientX)
      if (i == null) return
      if (e.pointerType === "mouse") {
        if (e.button !== 0) return
        toggle(i)
      } else {
        dragging.current = true
        set(i, true)
      }
    },
    onPointerUp: () => {
      dragging.current = false
    },
    onPointerCancel: () => {
      dragging.current = false
    },
    onPointerLeave: (e) => {
      if (e.pointerType === "mouse" && !state.pinned) set(null, false)
    },
    onKeyDown: (e) => {
      if (last < 0) return
      const cur = state.index ?? last
      const go = (i: number) => {
        set(Math.max(0, Math.min(last, i)), true)
        e.preventDefault()
      }
      if (e.key === "ArrowRight") go(cur + 1)
      else if (e.key === "ArrowLeft") go(cur - 1)
      else if (e.key === "Home") go(0)
      else if (e.key === "End") go(last)
      else if (e.key === "Escape" && state.index != null) {
        set(null, false)
        e.preventDefault()
      }
    },
  })

  return { ...state, set, toggle, bind }
}

/** Polite screen-reader text that waits for the scrub to settle. */
export function useDebouncedText(text: string, ms = 250): string {
  const [out, setOut] = React.useState("")
  React.useEffect(() => {
    const t = window.setTimeout(() => setOut(text), ms)
    return () => window.clearTimeout(t)
  }, [text, ms])
  return out
}
