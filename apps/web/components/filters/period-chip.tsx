"use client"

import * as React from "react"
import { ChevronDown } from "lucide-react"

import { useUIState } from "@/components/layout/ui-state"
import type { Period } from "@/lib/types/views"
import { cn } from "@/lib/utils"

interface PeriodChipProps {
  onClick?: () => void
  className?: string
}

export function PeriodChip({ onClick, className }: PeriodChipProps) {
  const { period } = useUIState()
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex min-h-9 items-center gap-1.5 rounded-full border bg-muted px-3 py-1.5",
        "text-[13px] font-medium text-foreground",
        "transition-colors active:bg-accent/60",
        className
      )}
    >
      <span>{shortPeriodLabel(period)}</span>
      <ChevronDown size={12} className="text-muted-foreground" />
    </button>
  )
}

// Render the period in chip-sized text. The full `period.label` is too wordy
// ("Month to date" → "MTD"); the `period.range` is sometimes more meaningful
// ("Apr 2026" beats "This month" on a chip).
export function shortPeriodLabel(period: Period): string {
  switch (period.id) {
    case "mtd":
      return "MTD"
    case "ytd":
      return "YTD"
    case "qtd":
      return period.range || "QTD"
    case "this-month":
    case "last-month":
      return period.range || period.label
    case "last-12":
      return "12M"
    case "all":
      return "All"
    case "custom":
      return period.range || "Custom"
  }
}
