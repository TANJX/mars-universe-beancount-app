"use client"

import { useRouter } from "next/navigation"
import * as React from "react"

import { NAV_PAGES } from "@/components/layout/nav"
import { usePeriodHref } from "@/components/layout/ui-state"

/**
 * Vim-style "leader" keyboard nav for the app. Mounted once at the
 * route-group layout. Listens at the window level; no-ops when an input,
 * textarea, or contenteditable owns focus, or when modifier keys are held.
 *
 *   g + <key>  → any page; letters are `leaderKey` in nav.ts
 *   /       → focus the page's primary search input (data-search="primary")
 *   ?       → log a placeholder; future shortcuts dialog
 *
 * `[` / `]` (period prev/next) and `m` (open period popover) are owned by
 * PeriodCommand; ⌘P/⌘K are owned by their respective components, and ⌘B
 * (toggle sidebar) by SidebarProvider.
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
        const page = NAV_PAGES.find((p) => p.leaderKey === e.key.toLowerCase())
        if (page) {
          e.preventDefault()
          router.push(periodHref(page.href))
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
