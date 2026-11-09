"use client"

// Pieces of the chart + controls workbench shared by /fire and /runway: the
// opaque pane fill and the sticky section chips at the top of the pane.

import { PanelRightClose } from "lucide-react"
import * as React from "react"

import { cn } from "@/lib/utils"

/** Opaque fill for the controls pane and its sticky nav (the nav must hide
 * what scrolls under it, so no alpha). */
export const PANE_FILL =
  "bg-[color-mix(in_oklch,var(--muted)_60%,var(--background))]"

export interface PaneSection {
  id: string
  label: string
}

/** Read and remember whether the pane is open, per browser. */
export function usePaneOpen(key: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = React.useState(true)
  React.useEffect(() => {
    try {
      if (localStorage.getItem(key) === "0") setOpen(false)
    } catch {}
  }, [key])
  const set = React.useCallback(
    (v: boolean) => {
      setOpen(v)
      try {
        localStorage.setItem(key, v ? "1" : "0")
      } catch {}
    },
    [key]
  )
  return [open, set]
}

/** Chips that jump within the controls pane, highlighting the section in
 * view. Sticky at the top of whichever element scrolls (the pane at xl, the
 * page below it). */
export function SectionNav({
  sections,
  paneRef,
  onFold,
}: {
  sections: PaneSection[]
  paneRef: React.RefObject<HTMLElement | null>
  onFold: () => void
}) {
  const [active, setActive] = React.useState(sections[0]?.id ?? "")
  const ids = sections.map((s) => s.id).join(",")
  React.useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    const isPane = getComputedStyle(pane).overflowY === "auto"
    const obs = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (top[0]) setActive(top[0].target.id)
      },
      { root: isPane ? pane : null, rootMargin: "0px 0px -70% 0px" }
    )
    for (const id of ids.split(",")) {
      const el = document.getElementById(id)
      if (el) obs.observe(el)
    }
    return () => obs.disconnect()
  }, [paneRef, ids])

  return (
    <nav
      className={cn(
        "-mx-4 flex flex-wrap items-center gap-1 rounded-t-xl px-4 pt-3 pb-2 xl:sticky xl:top-0 xl:z-[5]",
        PANE_FILL
      )}
    >
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => {
            const reduce = window.matchMedia(
              "(prefers-reduced-motion: reduce)"
            ).matches
            document.getElementById(s.id)?.scrollIntoView({
              behavior: reduce ? "auto" : "smooth",
              block: "start",
            })
          }}
          className={cn(
            "h-6 rounded-md px-2 text-xs transition-colors",
            active === s.id
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {s.label}
        </button>
      ))}
      <button
        type="button"
        onClick={onFold}
        aria-label="Hide controls"
        title="Hide controls"
        className="ml-auto hidden size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground xl:inline-flex"
      >
        <PanelRightClose size={15} />
      </button>
    </nav>
  )
}
