"use client"

// Play sleeve as a share of invested money, against its cap. While it sits
// above the cap no new money goes in; the marker shows when growth elsewhere
// brings it under.

import * as React from "react"
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"

import { pct, usd } from "@/components/fire/controls"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart"
import type { MonthRow } from "@/lib/runway/types"

import {
  AXIS,
  monthLabel,
  monthShort,
  monthTick,
  monthTicks,
} from "./chart-utils"

const CONFIG: ChartConfig = {
  playShare: { label: "Play share", color: "var(--sleeve-play)" },
}

/** First month the share is under the cap, if it ever starts above it. */
export function firstUnderCap(rows: MonthRow[], cap: number): string | null {
  if (!rows.length || rows[0].playShare <= cap) return null
  return rows.find((r) => r.playShare <= cap)?.month ?? null
}

export function PlayShareChart({
  rows,
  cap,
  ariaLabel,
}: {
  rows: MonthRow[]
  cap: number
  ariaLabel: string
}) {
  const top = React.useMemo(() => {
    const maxShare = rows.reduce((a, r) => Math.max(a, r.playShare), 0)
    const raw = Math.max(cap * 1.6, maxShare * 1.1, 0.05)
    return Math.ceil(raw / 0.05) * 0.05
  }, [rows, cap])
  const ticks = Array.from(
    { length: Math.round(top / 0.05) + 1 },
    (_, i) => Math.round(i * 5) / 100
  )
  const months = rows.map((r) => r.month)
  const xTicks = monthTicks(months)
  const firstMonth = months[0] ?? ""
  const under = firstUnderCap(rows, cap)

  return (
    <ChartContainer
      config={CONFIG}
      className="h-full min-h-40 w-full"
      role="img"
      aria-label={ariaLabel}
    >
      <LineChart
        data={rows}
        margin={{ top: 14, right: 12, left: 0, bottom: 0 }}
        accessibilityLayer
      >
        <CartesianGrid vertical={false} strokeDasharray="2 4" />
        <XAxis
          dataKey="month"
          {...AXIS}
          ticks={xTicks}
          interval={0}
          tickFormatter={(m) => monthTick(String(m), firstMonth)}
        />
        <YAxis
          {...AXIS}
          width={56}
          domain={[0, top]}
          ticks={ticks}
          interval={0}
          tickFormatter={(v) => pct(v as number, 0)}
        />
        <ReferenceArea
          y1={cap}
          y2={top}
          fill="var(--muted-foreground)"
          fillOpacity={0.06}
          stroke="none"
        />
        <ReferenceLine
          y={cap}
          stroke="var(--foreground)"
          strokeDasharray="5 4"
          strokeWidth={1.25}
          label={{
            value: `Cap ${pct(cap, 0)}`,
            position: "insideTopRight",
            fontSize: 11,
            fill: "var(--muted-foreground)",
          }}
        />
        {under ? (
          <ReferenceLine
            x={under}
            stroke="var(--muted-foreground)"
            label={{
              value: `Under cap ${monthShort(under)}`,
              position: "insideTopLeft",
              fontSize: 11,
              fill: "var(--muted-foreground)",
            }}
          />
        ) : null}
        <ChartTooltip
          cursor={{ stroke: "var(--muted-foreground)", strokeOpacity: 0.4 }}
          content={<PlayTooltip />}
        />
        <Line
          dataKey="playShare"
          type="monotone"
          stroke="var(--color-playShare)"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 3, strokeWidth: 0 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  )
}

function PlayTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload?: MonthRow }>
}) {
  const row = payload?.[0]?.payload
  if (!active || !row) return null
  return (
    <div className="grid min-w-44 gap-1 rounded-lg border bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{monthLabel(row.month)}</div>
      <div className="flex justify-between gap-4">
        <span>Play share</span>
        <span className="font-mono tabular-nums">{pct(row.playShare, 1)}</span>
      </div>
      <div className="flex justify-between gap-4 text-muted-foreground">
        <span>Play balance</span>
        <span className="font-mono tabular-nums">{usd(row.play)}</span>
      </div>
      <div className="flex justify-between gap-4 text-muted-foreground">
        <span>Invested total</span>
        <span className="font-mono tabular-nums">{usd(row.invested)}</span>
      </div>
    </div>
  )
}
