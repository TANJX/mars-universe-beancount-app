"use client"

import { SparkArea } from "@/components/charts/spark-area"
import { Money } from "@/components/primitives/money"
import { MINUS } from "@/lib/format"
import type { SeriesPoint } from "@/lib/types/views"

interface MobileNetWorthHeroProps {
  netWorth: number
  delta: number
  series: SeriesPoint[]
}

export function MobileNetWorthHero({
  netWorth,
  delta,
  series,
}: MobileNetWorthHeroProps) {
  return (
    <section className="px-5 pt-2 pb-4">
      <div className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
        Net worth
      </div>
      <Money
        value={netWorth}
        className="block text-[42px] leading-tight font-medium"
      />
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="font-mono text-[13px] font-medium text-emerald-600 tabular-nums dark:text-emerald-400">
          {delta >= 0 ? "+" : MINUS}$
          {Math.abs(delta).toLocaleString("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </span>
        <span className="text-xs text-muted-foreground">this period</span>
      </div>
      <div className="mt-3.5">
        <SparkArea points={series} size="lg" label="Net worth" />
      </div>
    </section>
  )
}
