"use client"

import { cn } from "@/lib/utils"

interface AllTimeFilterPromptProps {
  /** Reset the period (typically back to month-to-date). */
  onResetPeriod: () => void
}

/**
 * Rendered in place of the journal rows when the user selects "All time"
 * without a narrowing filter committed. We suppress the Fava fetch in
 * this state — loading the entire ledger is many MB and seconds. The
 * user must add a filter (account / tag / link / payee / text) or pick
 * a shorter period before any data is fetched.
 */
export function AllTimeFilterPrompt({
  onResetPeriod,
}: AllTimeFilterPromptProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-start gap-2 py-4 text-sm text-muted-foreground"
      )}
    >
      <p>Pick a filter to view all-time history.</p>
      <button
        type="button"
        onClick={onResetPeriod}
        className="text-xs underline-offset-2 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none"
      >
        Reset to Month-to-date
      </button>
    </div>
  )
}
