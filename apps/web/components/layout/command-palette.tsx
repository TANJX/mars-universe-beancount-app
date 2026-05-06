"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  BarChart3,
  BookOpen,
  CalendarClock,
  Hash,
  LayoutGrid,
  ListTree,
  Receipt,
  Search as SearchIcon,
} from "lucide-react"

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { ClientOnly } from "@/components/primitives/client-only"
import { useShortcutsDialog } from "@/components/layout/shortcuts-dialog"
import { usePeriodHref } from "@/components/layout/ui-state"
import { useLedgerData } from "@/hooks/use-fava"

interface NavItem {
  href: string
  label: string
  icon: React.ComponentType<{ size?: number }>
  /** Letter that follows the `g` leader to navigate here. */
  leaderKey: string
}

// Keep in sync with components/layout/global-keys.tsx — the `g + <letter>`
// leader nav. If you change a binding there, update the leaderKey here too.
const NAV: NavItem[] = [
  { href: "/overview", label: "Overview", icon: LayoutGrid, leaderKey: "o" },
  { href: "/plan", label: "Plan", icon: CalendarClock, leaderKey: "p" },
  { href: "/balances", label: "Balances", icon: ListTree, leaderKey: "b" },
  { href: "/income", label: "Income", icon: BarChart3, leaderKey: "i" },
  { href: "/expenses", label: "Expenses", icon: Receipt, leaderKey: "e" },
  { href: "/journal", label: "Journal", icon: BookOpen, leaderKey: "j" },
]

interface CommandPaletteContextValue {
  openCommandPalette: () => void
}

const CommandPaletteContext =
  React.createContext<CommandPaletteContextValue | null>(null)

/** Imperative trigger for the ⌘K palette. Used by the sidebar Search button
 * and any other UI that wants to open the palette without a keyboard event. */
export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = React.useContext(CommandPaletteContext)
  if (!ctx) return { openCommandPalette: () => {} }
  return ctx
}

export function CommandPalette({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const value = React.useMemo<CommandPaletteContextValue>(
    () => ({ openCommandPalette: () => setOpen(true) }),
    []
  )
  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <ClientOnly>
        <CommandPaletteInner open={open} setOpen={setOpen} />
      </ClientOnly>
    </CommandPaletteContext.Provider>
  )
}

function CommandPaletteInner({
  open,
  setOpen,
}: {
  open: boolean
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
}) {
  const [query, setQuery] = React.useState("")
  const router = useRouter()
  const periodHref = usePeriodHref()
  const { data: ledger } = useLedgerData()
  const { openShortcuts } = useShortcutsDialog()

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [setOpen])

  const accounts = (ledger?.accounts ?? []) as string[]

  function go(href: string) {
    setOpen(false)
    router.push(periodHref(href))
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search"
      description="Jump to a page or an account."
      className="max-w-2xl sm:max-w-2xl"
    >
      <CommandInput
        placeholder="Type a page, account, or filter…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>

        <CommandGroup heading="Pages">
          {NAV.map((n) => (
            <CommandItem
              key={n.href}
              value={`page ${n.label}`}
              onSelect={() => go(n.href)}
            >
              <n.icon size={14} />
              <span>Go to {n.label}</span>
              <CommandShortcut>g {n.leaderKey}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>

        {accounts.length > 0 && (
          <CommandGroup heading="Accounts">
            {accounts.slice(0, 200).map((a) => (
              <CommandItem
                key={a}
                value={`account ${a}`}
                onSelect={() => go(`/journal?account=${encodeURIComponent(a)}`)}
              >
                <Hash size={14} className="shrink-0" />
                <span className="min-w-0 truncate font-mono text-sm">
                  <Highlight text={a} query={query} />
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandGroup heading="Search shortcuts">
          <CommandItem
            value="search forecast"
            onSelect={() => go("/journal?q=tag:forecast")}
          >
            <SearchIcon size={14} />
            <span>All forecast entries</span>
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading="Help">
          <CommandItem
            value="help shortcuts"
            onSelect={() => {
              setOpen(false)
              // Defer so the palette transition completes before opening
              // the dialog (avoids focus thrash with overlapping portals).
              setTimeout(openShortcuts, 50)
            }}
          >
            <SearchIcon size={14} />
            <span>Show all keyboard shortcuts</span>
            <CommandShortcut>?</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}

/**
 * Render `text` with case-insensitive matches for `query` wrapped in a
 * highlight span. Matches each *word* in the query independently against the
 * text, so typing "exp rest" in the input lights up "Expenses:Restaurants".
 *
 * Empty query → returns text unstyled. Bookkeeping prefix-tokens like the
 * cmdk `value=""` keyword aren't passed in here.
 */
function Highlight({ text, query }: { text: string; query: string }) {
  const trimmed = query.trim()
  if (!trimmed) return <>{text}</>

  // Split the input on whitespace, lowercase each word, then find their
  // positions in `text` and merge overlapping ranges.
  const words = trimmed.toLowerCase().split(/\s+/).filter(Boolean)
  const lower = text.toLowerCase()
  const ranges: Array<[number, number]> = []
  for (const w of words) {
    let from = 0
    while (true) {
      const idx = lower.indexOf(w, from)
      if (idx < 0) break
      ranges.push([idx, idx + w.length])
      from = idx + w.length
    }
  }
  if (!ranges.length) return <>{text}</>

  // Merge overlapping/adjacent ranges so we don't emit nested spans.
  ranges.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = [ranges[0]]
  for (let i = 1; i < ranges.length; i++) {
    const last = merged[merged.length - 1]
    if (ranges[i][0] <= last[1]) {
      last[1] = Math.max(last[1], ranges[i][1])
    } else {
      merged.push(ranges[i])
    }
  }

  const parts: React.ReactNode[] = []
  let cursor = 0
  for (const [start, end] of merged) {
    if (start > cursor) parts.push(text.slice(cursor, start))
    parts.push(
      <mark
        key={`m-${start}`}
        className="rounded-sm bg-primary/20 px-0.5 text-foreground"
      >
        {text.slice(start, end)}
      </mark>
    )
    cursor = end
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}
