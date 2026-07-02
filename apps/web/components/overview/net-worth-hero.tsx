"use client"

import { SparkArea } from "@/components/charts/spark-area"
import { DeltaPill } from "@/components/primitives/delta-pill"
import { Money } from "@/components/primitives/money"
import { MINUS } from "@/lib/format"
import type { Period, SeriesPoint } from "@/lib/types/views"

interface NetWorthHeroProps {
  period: Period
  netWorth: number
  delta: number
  pct: number
  series: SeriesPoint[]
}

export function NetWorthHero({
  period,
  netWorth,
  delta,
  pct,
  series,
}: NetWorthHeroProps) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div>
        <div className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Net worth · {period.label}
        </div>
        <div className="flex items-baseline gap-3.5">
          <Money
            value={netWorth}
            className="text-4xl font-medium tracking-tight"
          />
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-sm font-medium text-emerald-600 tabular-nums dark:text-emerald-400">
              {delta >= 0 ? "+" : MINUS}$
              {Math.abs(delta).toLocaleString("en-US", {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
            <DeltaPill value={pct} />
            <span className="text-xs text-muted-foreground">
              vs prior period
            </span>
          </div>
        </div>
      </div>
      <div className="w-60 shrink-0">
        <SparkArea points={series} size="lg" label="Net worth" />
      </div>
    </div>
  )
}
