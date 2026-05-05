"use client"

import * as React from "react"

import { useHydrated } from "@/hooks/use-hydrated"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

interface Shortcut {
  keys: string[]
  description: string
}

interface ShortcutGroup {
  heading: string
  items: Shortcut[]
}

// Single source of truth for keyboard shortcut documentation. Changing a
// binding in `global-keys.tsx`, `period-command.tsx`, or `command-palette.tsx`
// should be mirrored here so the help dialog stays accurate.
const SHORTCUTS: ShortcutGroup[] = [
  {
    heading: "Navigation",
    items: [
      { keys: ["g", "o"], description: "Go to Overview" },
      { keys: ["g", "p"], description: "Go to Plan" },
      { keys: ["g", "b"], description: "Go to Balances" },
      { keys: ["g", "i"], description: "Go to Income" },
      { keys: ["g", "e"], description: "Go to Expenses" },
      { keys: ["g", "j"], description: "Go to Journal" },
    ],
  },
  {
    heading: "Period",
    items: [
      { keys: ["⌘", "P"], description: "Open period popover" },
      { keys: ["m"], description: "Toggle period popover" },
      { keys: ["["], description: "Previous period" },
      { keys: ["]"], description: "Next period" },
    ],
  },
  {
    heading: "Search",
    items: [
      { keys: ["⌘", "K"], description: "Open command palette" },
      { keys: ["/"], description: "Focus the page's search input" },
    ],
  },
  {
    heading: "Help",
    items: [{ keys: ["?"], description: "Show this dialog" }],
  },
]

interface ShortcutsContextValue {
  openShortcuts: () => void
}

const ShortcutsContext = React.createContext<ShortcutsContextValue | null>(null)

/** Imperative trigger for the shortcuts dialog. Used by the SettingsMenu
 * "Keyboard shortcuts" item, the ⌘K palette's Help group, and anywhere else
 * that wants to open the dialog without relying on a synthesized key event. */
export function useShortcutsDialog(): ShortcutsContextValue {
  const ctx = React.useContext(ShortcutsContext)
  if (!ctx) {
    // Outside of `<ShortcutsProvider>`: no-op so callers don't have to guard.
    return { openShortcuts: () => {} }
  }
  return ctx
}

/** Mounts the dialog + listens for `?`. Wrap the route group with this. */
export function ShortcutsDialog({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = React.useState(false)
  const hydrated = useHydrated()

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === "?") {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const value = React.useMemo<ShortcutsContextValue>(
    () => ({ openShortcuts: () => setOpen(true) }),
    []
  )

  return (
    <ShortcutsContext.Provider value={value}>
      {children}
      {hydrated && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Keyboard shortcuts</DialogTitle>
              <DialogDescription>
                Press <kbd className="font-mono">?</kbd> any time to open this
                dialog.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              {SHORTCUTS.map((group) => (
                <div key={group.heading} className="flex flex-col gap-1.5">
                  <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {group.heading}
                  </div>
                  <div className="flex flex-col">
                    {group.items.map((s) => (
                      <div
                        key={s.description}
                        className="flex items-center justify-between py-1 text-sm"
                      >
                        <span>{s.description}</span>
                        <span className="flex items-center gap-1">
                          {s.keys.map((k) => (
                            <kbd
                              key={k}
                              className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1.5 font-mono text-xs text-muted-foreground"
                            >
                              {k}
                            </kbd>
                          ))}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </ShortcutsContext.Provider>
  )
}
