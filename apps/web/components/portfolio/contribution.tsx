"use client"

import { Money } from "@/components/primitives/money"
import { Card } from "@/components/ui/card"
import type { PortfolioContribution } from "@/lib/fava/schemas"
import { formatMoney } from "@/lib/format"

/**
 * Meter, not a two-slice donut: one ratio against one limit. The pace marker
 * is the second question a limit always raises — not "how much is in" but
 * "am I on track to fill it".
 */
export function ContributionMeter({
  room,
  yearElapsed,
}: {
  room: PortfolioContribution
  yearElapsed: number
}) {
  const pct = room.limit ? (room.used / room.limit) * 100 : 0
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px]">{room.label}</span>
        <span className="flex items-baseline gap-1.5 font-mono text-xs tabular-nums">
          <Money value={room.used} maximumFractionDigits={0} />
          <span className="text-muted-foreground">
            / {formatMoney(room.limit, { maximumFractionDigits: 0 })}
          </span>
        </span>
      </div>
      <div className="relative">
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary/80"
            style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </div>
        {/* Pace marker: where a steady-contribution year would be today. */}
        <span
          aria-hidden
          title="Where a steady-contribution year would be today"
          className="absolute -top-[3px] h-[14px] w-px bg-foreground/45"
          style={{ left: `${yearElapsed * 100}%` }}
        />
      </div>
      <div className="flex items-baseline justify-between gap-3 text-[11px] text-muted-foreground">
        <span>
          {formatMoney(Math.max(0, room.limit - room.used), {
            maximumFractionDigits: 0,
          })}{" "}
          room left{room.cadence ? ` · ${room.cadence}` : ""}
        </span>
      </div>
    </div>
  )
}

export function ContributionCard({
  rooms,
  year,
  yearElapsed,
}: {
  rooms: PortfolioContribution[]
  year: number
  yearElapsed: number
}) {
  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <span className="font-medium text-sm">Contribution room · {year}</span>
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {Math.round(yearElapsed * 100)}% of year gone
        </span>
      </div>
      {rooms.length === 0 ? (
        <div className="py-4 text-center text-muted-foreground text-xs">
          No contribution limits configured.
        </div>
      ) : (
        rooms.map((r) => (
          <ContributionMeter key={r.key} room={r} yearElapsed={yearElapsed} />
        ))
      )}
    </Card>
  )
}
