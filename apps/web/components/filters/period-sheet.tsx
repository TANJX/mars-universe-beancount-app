"use client"

import * as React from "react"
import { Check } from "lucide-react"
import type { DateRange } from "react-day-picker"

import { Calendar } from "@/components/ui/calendar"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { useUIState } from "@/components/layout/ui-state"
import { makeCustomPeriod, parseLocalDate } from "@/lib/fava/periods"
import { listPresets } from "@/lib/mock/periods"
import type { PeriodPresetId } from "@/lib/types/views"
import { cn } from "@/lib/utils"

interface PeriodSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Pane = "presets" | "custom"

const TIMEZONE_LABEL = (() => {
  // "UTC−05:00" — sign-flipped vs. getTimezoneOffset to match user expectation.
  if (typeof window === "undefined") return ""
  const offsetMin = -new Date().getTimezoneOffset()
  const sign = offsetMin >= 0 ? "+" : "−"
  const abs = Math.abs(offsetMin)
  const hh = String(Math.floor(abs / 60)).padStart(2, "0")
  const mm = String(abs % 60).padStart(2, "0")
  return `UTC${sign}${hh}:${mm}`
})()

export function PeriodSheet({ open, onOpenChange }: PeriodSheetProps) {
  const { period, setPeriod } = useUIState()
  const [pane, setPane] = React.useState<Pane>("presets")
  const presets = React.useMemo(
    () => listPresets().filter((p) => p.id !== "custom"),
    []
  )

  function pick(id: PeriodPresetId) {
    setPeriod(id)
    onOpenChange(false)
  }

  // Reset to the presets pane each time the sheet opens. Done inside
  // onOpenChange so the lint rule against synchronous setState-in-effect
  // doesn't flag what is really an event-driven side effect.
  function handleOpenChange(next: boolean) {
    if (next) setPane("presets")
    onOpenChange(next)
  }

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className={cn(
          "rounded-t-2xl border-t bg-popover p-0",
          "flex max-h-[85vh] flex-col gap-0"
        )}
      >
        <div
          aria-hidden
          className="mx-auto mt-1.5 mb-3 h-1 w-9 rounded-full bg-muted-foreground/30"
        />

        {pane === "presets" ? (
          <PresetsPane
            currentId={period.id}
            presets={presets}
            onPick={pick}
            onCustom={() => setPane("custom")}
          />
        ) : (
          <CustomPane
            initialFrom={period.from}
            initialTo={period.to}
            onCancel={() => setPane("presets")}
            onApply={(p) => {
              setPeriod(p)
              onOpenChange(false)
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function PresetsPane({
  currentId,
  presets,
  onPick,
  onCustom,
}: {
  currentId: PeriodPresetId
  presets: { id: PeriodPresetId; label: string; range: string }[]
  onPick: (id: PeriodPresetId) => void
  onCustom: () => void
}) {
  return (
    <div
      style={{
        paddingBottom: "max(1.75rem, env(safe-area-inset-bottom))",
      }}
    >
      <div className="flex items-baseline justify-between px-5 pb-2">
        <span className="text-base font-semibold">Period</span>
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {TIMEZONE_LABEL}
        </span>
      </div>

      <ul className="border-t">
        {presets.map((p) => {
          const active = p.id === currentId
          return (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onPick(p.id)}
                className={cn(
                  "flex min-h-12 w-full items-center justify-between gap-3 border-b px-5 py-3 text-left",
                  "transition-colors active:bg-accent/40",
                  active && "bg-accent/15"
                )}
              >
                <span>
                  <span
                    className={cn(
                      "block text-sm",
                      active
                        ? "font-semibold text-primary"
                        : "font-medium text-foreground"
                    )}
                  >
                    {p.label}
                  </span>
                  <span className="block font-mono text-[11.5px] text-muted-foreground tabular-nums">
                    {p.range}
                  </span>
                </span>
                {active && <Check size={14} className="text-primary" />}
              </button>
            </li>
          )
        })}

        <li>
          <button
            type="button"
            onClick={onCustom}
            className={cn(
              "flex min-h-12 w-full items-center justify-between gap-3 border-b px-5 py-3 text-left",
              "transition-colors active:bg-accent/40",
              currentId === "custom" && "bg-accent/15"
            )}
          >
            <span
              className={cn(
                "text-sm",
                currentId === "custom"
                  ? "font-semibold text-primary"
                  : "font-medium text-foreground"
              )}
            >
              Custom range…
            </span>
            {currentId === "custom" && (
              <Check size={14} className="text-primary" />
            )}
          </button>
        </li>
      </ul>
    </div>
  )
}

function CustomPane({
  initialFrom,
  initialTo,
  onCancel,
  onApply,
}: {
  initialFrom?: string
  initialTo?: string
  onCancel: () => void
  onApply: (period: ReturnType<typeof makeCustomPeriod>) => void
}) {
  const seed: DateRange | undefined =
    initialFrom && initialTo
      ? { from: parseLocalDate(initialFrom), to: parseLocalDate(initialTo) }
      : undefined
  const [range, setRange] = React.useState<DateRange | undefined>(seed)

  const ready = !!(range?.from && range?.to)

  return (
    <div
      className="flex flex-col"
      style={{
        paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
      }}
    >
      <div className="flex items-baseline justify-between px-5 pb-3">
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-muted-foreground active:text-foreground"
        >
          ← Presets
        </button>
        <span className="text-base font-semibold">Custom range</span>
        <span aria-hidden className="text-xs text-transparent">
          ←
        </span>
      </div>

      <div className="flex justify-center border-t border-b px-2 py-3">
        <Calendar
          mode="range"
          numberOfMonths={1}
          selected={range}
          onSelect={setRange}
          defaultMonth={range?.from ?? new Date()}
        />
      </div>

      <div className="flex items-center justify-between gap-3 px-5 py-3">
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {range?.from && range?.to
            ? `${range.from.toLocaleDateString()} – ${range.to.toLocaleDateString()}`
            : range?.from
              ? `${range.from.toLocaleDateString()} – …`
              : "Pick a start and end"}
        </span>
        <button
          type="button"
          disabled={!ready}
          onClick={() => {
            if (range?.from && range?.to) {
              onApply(makeCustomPeriod(range.from, range.to))
            }
          }}
          className={cn(
            "rounded-md px-3 py-1.5 text-sm font-medium",
            "bg-primary text-primary-foreground",
            "disabled:cursor-not-allowed disabled:opacity-40"
          )}
        >
          Apply
        </button>
      </div>
    </div>
  )
}
