"use client"

import { SparkArea } from "@/components/charts/spark-area"
import { Money } from "@/components/primitives/money"
import { formatPercent } from "@/lib/format"
import type { SeriesPoint } from "@/lib/types/views"

type Tone = "pos" | "neg" | "neutral"

interface StatTileProps {
  label: string
  amount: number
  series: SeriesPoint[]
  tone?: Tone
  pct?: number
}

const TONE_COLOR: Record<Tone, string> = {
  pos: "var(--color-emerald-500)",
  neg: "var(--color-rose-500)",
  neutral: "var(--primary)",
}

export function StatTile({
  label,
  amount,
  series,
  tone = "neutral",
  pct,
}: StatTileProps) {
  return (
    <div className="flex flex-col gap-1.5 bg-card px-4 py-3.5">
      <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="flex items-baseline justify-between gap-3">
        <Money
          value={amount}
          tone={tone === "pos" && amount > 0 ? "pos" : "none"}
          className="text-2xl font-medium tracking-tight"
        />
        {pct != null && (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {formatPercent(pct)} rate
          </span>
        )}
      </div>
      <SparkArea
        points={series}
        color={TONE_COLOR[tone]}
        size="sm"
        label={label}
      />
    </div>
  )
}
