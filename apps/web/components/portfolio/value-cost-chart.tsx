"use client"

import * as React from "react"
import { Area, AreaChart, CartesianGrid, Line, XAxis, YAxis } from "recharts"

import { MoneyTooltip } from "@/components/charts/chart-tooltip"
import { ClientOnly } from "@/components/primitives/client-only"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart"
import { Skeleton } from "@/components/ui/skeleton"
import type { PortfolioSeriesPoint } from "@/lib/fava/schemas"
import { cn } from "@/lib/utils"

const VC_CONFIG: ChartConfig = {
  value: { label: "Market value", color: "var(--primary)" },
  cost: { label: "Cost basis", color: "var(--muted-foreground)" },
}

/**
 * Emphasis form, not categorical: market value is the subject (filled area in
 * the accent hue), cost basis is context (a thin dashed line). The gap between
 * them reads directly as unrealized gain — which is the whole point of putting
 * them on one chart. Same unit, one axis; never a second y-scale.
 */
export function ValueCostChart({
  data,
  height = "h-56",
  onHover,
}: {
  data: PortfolioSeriesPoint[]
  height?: string
  onHover?: (p: PortfolioSeriesPoint | null) => void
}) {
  // Memoised on `data`: the parent re-renders on every hover tick, and a fresh
  // array each time makes recharts treat the series as new and replay its
  // mount animation, which reads as a chart that never settles.
  const rows = React.useMemo(
    () =>
      data.map((p) => ({
        month: p.date.slice(0, 7),
        value: p.value,
        cost: p.cost,
        raw: p,
      })),
    [data]
  )
  return (
    // LedgerShell swaps NoChromeShell for DesktopShell after hydration, which
    // narrows `main`. recharts measures its container once and keeps that
    // geometry, so a chart mounted before the swap plots into a stale,
    // far-too-narrow box. Holding it back one commit is what /balances
    // effectively does by gating on its loading skeleton.
    <ClientOnly fallback={<Skeleton className={cn("w-full", height)} />}>
      <ChartContainer config={VC_CONFIG} className={cn("w-full", height)}>
        <AreaChart
          data={rows}
          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          onMouseMove={(e: unknown) => {
            const p = (
              e as {
                activePayload?: Array<{
                  payload?: { raw?: PortfolioSeriesPoint }
                }>
              }
            )?.activePayload?.[0]?.payload?.raw
            onHover?.(p ?? null)
          }}
          onMouseLeave={() => onHover?.(null)}
        >
          <defs>
            <linearGradient
              id="portfolio-value-fill"
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop
                offset="0%"
                stopColor="var(--color-value)"
                stopOpacity={0.3}
              />
              <stop
                offset="55%"
                stopColor="var(--color-value)"
                stopOpacity={0.1}
              />
              <stop
                offset="100%"
                stopColor="var(--color-value)"
                stopOpacity={0}
              />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} strokeDasharray="2 4" />
          <XAxis
            dataKey="month"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            fontSize={11}
            minTickGap={32}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            fontSize={11}
            width={52}
            // Recharts' default rounds the top tick well past the data, which
            // leaves dead headroom and flattens the curve. Cap just above the
            // peak, rounded to a clean $5k step.
            domain={[
              0,
              (dataMax: number) => Math.ceil((dataMax * 1.06) / 5000) * 5000,
            ]}
            tickFormatter={(v) => `$${Math.round((v as number) / 1000)}k`}
          />
          <ChartTooltip
            cursor={{ stroke: "var(--color-value)", strokeOpacity: 0.3 }}
            content={<MoneyTooltip granularity="month" />}
          />
          <Area
            dataKey="value"
            type="monotone"
            stroke="var(--color-value)"
            strokeWidth={2}
            fill="url(#portfolio-value-fill)"
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
          />
          <Line
            dataKey="cost"
            type="monotone"
            stroke="var(--color-cost)"
            strokeWidth={1.5}
            strokeDasharray="3 3"
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
          />
        </AreaChart>
      </ChartContainer>
    </ClientOnly>
  )
}

export function ValueCostLegend() {
  return (
    <div className="flex items-center gap-3.5">
      <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <span
          aria-hidden
          className="inline-block h-2 w-2.5 rounded-[2px]"
          style={{ background: "var(--primary)" }}
        />
        Market value
      </span>
      <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <span
          aria-hidden
          className="inline-block h-0 w-2.5 border-t border-dashed"
          style={{ borderColor: "var(--muted-foreground)" }}
        />
        Cost basis
      </span>
    </div>
  )
}
