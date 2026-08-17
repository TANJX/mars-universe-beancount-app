"use client"

import { ChevronDown } from "lucide-react"

import { useUIState } from "@/components/layout/ui-state"
import { Button } from "@/components/ui/button"
import { expandPeriodByMonth } from "@/lib/fava/periods"
import { cn } from "@/lib/utils"

interface ShowMorePeriodProps {
  className?: string
}

/**
 * Widens the active period one calendar month further into the past.
 *
 * The journal fetch is period-driven, so this re-queries fava over a longer
 * `time=` range instead of paginating client-side — the cumulative column and
 * its opening-balance seed re-derive against the new boundary for free. The
 * widened range is written to the URL (`?p=custom&from=…&to=…`) like any other
 * period change, so it survives reload and back/forward.
 *
 * Renders nothing under "All time", which already spans the whole ledger.
 */
export function ShowMorePeriod({ className }: ShowMorePeriodProps) {
  const { period, setPeriod } = useUIState()
  if (period.id === "all") return null

  return (
    <Button
      variant="outline"
      size="sm"
      className={cn("gap-1.5", className)}
      onClick={() => {
        const next = expandPeriodByMonth(period)
        if (next) setPeriod(next)
      }}
    >
      <ChevronDown size={14} className="text-muted-foreground" />
      Show more
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
        +1 month
      </span>
    </Button>
  )
}
