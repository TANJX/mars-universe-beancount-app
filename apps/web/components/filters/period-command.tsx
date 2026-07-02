"use client"

import { CalendarRange, ChevronLeft, ChevronRight } from "lucide-react"
import * as React from "react"
import type { DateRange } from "react-day-picker"
import { useUIState } from "@/components/layout/ui-state"
import { Calendar } from "@/components/ui/calendar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  makeCustomPeriod,
  parseLocalDate,
  shiftPeriod,
} from "@/lib/fava/periods"
import { listPresets } from "@/lib/mock/periods"
import type { PeriodPresetId } from "@/lib/types/views"
import { cn } from "@/lib/utils"

export function PeriodCommand() {
  const { period, setPeriod } = useUIState()
  const [open, setOpen] = React.useState(false)
  const [calendarOpen, setCalendarOpen] = React.useState(false)
  const [pendingRange, setPendingRange] = React.useState<DateRange | undefined>(
    undefined
  )
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const presets = React.useMemo(
    () => listPresets().filter((p) => p.id !== "custom"),
    []
  )

  function toggle() {
    setOpen((o) => !o)
  }

  // When opened programmatically (⌘P / `m`), Base UI doesn't move focus
  // into the menu. Find the menu after it mounts and focus its first item
  // so arrow keys take over.
  React.useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      const item = document.querySelector<HTMLElement>(
        '[data-slot="dropdown-menu-content"] [role="menuitemradio"], [data-slot="dropdown-menu-content"] [role="menuitem"]'
      )
      item?.focus()
    }, 30)
    return () => window.clearTimeout(t)
  }, [open])

  // ⌘P / Ctrl+P (or `m` when nothing focused) opens the dropdown.
  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isInput =
        document.activeElement &&
        ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)
      if (e.key.toLowerCase() === "p" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        toggle()
      }
      if (!isInput && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === "[") shift(-1)
        else if (e.key === "]") shift(1)
        else if (e.key.toLowerCase() === "m") toggle()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period])

  function pick(id: PeriodPresetId) {
    setPeriod(id)
    setOpen(false)
  }

  function applyRange() {
    if (!pendingRange?.from || !pendingRange?.to) return
    setPeriod(makeCustomPeriod(pendingRange.from, pendingRange.to))
    setCalendarOpen(false)
  }

  function shift(dir: -1 | 1) {
    const next = shiftPeriod(period, dir)
    if (next) setPeriod(next)
  }

  const customRange: DateRange | undefined =
    period.from && period.to
      ? {
          from: parseLocalDate(period.from),
          to: parseLocalDate(period.to),
        }
      : undefined

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => shift(-1)}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label="Previous period"
        title="Previous period · ["
        disabled={shiftPeriod(period, -1) === null}
      >
        <ChevronLeft size={14} />
      </button>

      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          ref={triggerRef}
          className={cn(
            "flex items-center gap-2 rounded-md px-2.5 py-1.5",
            "border bg-card text-sm font-medium text-foreground",
            "transition-colors hover:bg-accent/50"
          )}
        >
          <CalendarRange size={12} className="text-muted-foreground" />
          <span>{period.label}</span>
          {period.range && (
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {period.range}
            </span>
          )}
          <kbd className="ml-1 rounded-sm border px-1 font-mono text-xs text-muted-foreground/80">
            ⌘P
          </kbd>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={6}
          className="w-auto min-w-80"
        >
          <DropdownMenuRadioGroup
            value={period.id}
            onValueChange={(v) => pick(v as PeriodPresetId)}
          >
            {presets.map((p) => (
              <DropdownMenuRadioItem key={p.id} value={p.id}>
                <span className="flex-1 whitespace-nowrap">{p.label}</span>
                <DropdownMenuShortcut className="font-mono whitespace-nowrap tabular-nums">
                  {p.range}
                </DropdownMenuShortcut>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            closeOnClick={false}
            onClick={() => {
              setOpen(false)
              setTimeout(() => setCalendarOpen(true), 50)
            }}
          >
            <span className="flex-1 whitespace-nowrap">Custom range…</span>
            {period.id === "custom" && (
              <DropdownMenuShortcut className="font-mono whitespace-nowrap tabular-nums">
                {period.range}
              </DropdownMenuShortcut>
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Calendar lives in its own popover anchored to an invisible trigger
        positioned next to the period button; opened from the "Custom range…"
        item above. */}
      <Popover
        open={calendarOpen}
        onOpenChange={(next) => {
          if (next) setPendingRange(customRange)
          setCalendarOpen(next)
        }}
      >
        <PopoverTrigger aria-hidden className="sr-only" tabIndex={-1} />
        <PopoverContent align="start" sideOffset={6} className="w-auto p-0">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Custom range
            </span>
            <button
              type="button"
              onClick={() => {
                setCalendarOpen(false)
                setOpen(true)
              }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              ← Presets
            </button>
          </div>
          <Calendar
            mode="range"
            numberOfMonths={2}
            selected={pendingRange}
            onSelect={setPendingRange}
            defaultMonth={pendingRange?.from ?? customRange?.from ?? new Date()}
          />
          <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
            <span className="text-xs text-muted-foreground tabular-nums">
              {pendingRange?.from && pendingRange?.to
                ? `${pendingRange.from.toLocaleDateString()} – ${pendingRange.to.toLocaleDateString()}`
                : pendingRange?.from
                  ? `${pendingRange.from.toLocaleDateString()} – …`
                  : "Pick a start and end date"}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setCalendarOpen(false)}
                className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={applyRange}
                disabled={!pendingRange?.from || !pendingRange?.to}
                className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Apply
              </button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <button
        type="button"
        onClick={() => shift(1)}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
        aria-label="Next period"
        title="Next period · ]"
        disabled={shiftPeriod(period, 1) === null}
      >
        <ChevronRight size={14} />
      </button>
    </div>
  )
}
