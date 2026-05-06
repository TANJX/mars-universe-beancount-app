"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { usePeriodHref } from "@/components/layout/ui-state"

/**
 * Vim-style "leader" keyboard nav for the app. Mounted once at the
 * route-group layout. Listens at the window level; no-ops when an input,
 * textarea, or contenteditable owns focus, or when modifier keys are held.
 *
 *   g + o   → /overview
 *   g + p   → /plan
 *   g + b   → /balances
 *   g + i   → /income
 *   g + e   → /expenses
 *   g + j   → /journal
 *   /       → focus the page's primary search input (data-search="primary")
 *   ?       → log a placeholder; future shortcuts dialog
 *
 * `[` / `]` (period prev/next) and `m` (open period popover) are owned by
 * PeriodCommand; ⌘P/⌘K are owned by their respective components.
 */
export function GlobalKeys() {
  const router = useRouter()
  const periodHref = usePeriodHref()
  const leaderRef = React.useRef<number | null>(null)

  React.useEffect(() => {
    function isTypingTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false
      const tag = t.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true
      if (t.isContentEditable) return true
      return false
    }

    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) return

      // Leader: 'g' followed by a target letter within 1.2s.
      if (leaderRef.current !== null && Date.now() - leaderRef.current < 1200) {
        leaderRef.current = null
        switch (e.key.toLowerCase()) {
          case "o":
            e.preventDefault()
            router.push(periodHref("/overview"))
            return
          case "b":
            e.preventDefault()
            router.push(periodHref("/balances"))
            return
          case "i":
            e.preventDefault()
            router.push(periodHref("/income"))
            return
          case "e":
            e.preventDefault()
            router.push(periodHref("/expenses"))
            return
          case "j":
            e.preventDefault()
            router.push(periodHref("/journal"))
            return
          case "p":
            e.preventDefault()
            router.push(periodHref("/plan"))
            return
        }
      }

      if (e.key === "g") {
        leaderRef.current = Date.now()
        return
      }
      if (e.key === "/") {
        const el = document.querySelector<HTMLInputElement>(
          'input[data-search="primary"]'
        )
        if (el) {
          e.preventDefault()
          el.focus()
        }
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [periodHref, router])

  return null
}
