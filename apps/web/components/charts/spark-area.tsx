"use client"

import * as React from "react"
import { Area, AreaChart, XAxis, YAxis } from "recharts"

import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
import { MoneyTooltip } from "@/components/charts/chart-tooltip"
import type { SeriesPoint } from "@/lib/types/views"
import { cn } from "@/lib/utils"

interface SparkAreaProps {
  /** Dated series — date threads through to the tooltip label. */
  points: SeriesPoint[]
  color?: string
  label?: string
  size?: "sm" | "md" | "lg"
  className?: string
}

const SIZE_CLASSES: Record<NonNullable<SparkAreaProps["size"]>, string> = {
  sm: "h-7",
  md: "h-10",
  lg: "h-14",
}

export function SparkArea({
  points,
  color = "var(--primary)",
  label = "Value",
  size = "md",
  className,
}: SparkAreaProps) {
  // recharts feeds the dataKey from these rows; XAxis uses `month` for the
  // active label so the tooltip's labelFormatter can format the date.
  const data = points.map((p) => ({
    month: p.date.slice(0, 7),
    value: p.value,
  }))
  const config: ChartConfig = {
    value: { label, color },
  }
  const gradientId = `spark-${React.useId().replace(/:/g, "")}`

  return (
    <ChartContainer
      config={config}
      className={cn("aspect-auto w-full", SIZE_CLASSES[size], className)}
    >
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 2, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor="var(--color-value)"
              stopOpacity={0.3}
            />
            <stop
              offset="100%"
              stopColor="var(--color-value)"
              stopOpacity={0}
            />
          </linearGradient>
        </defs>
        <XAxis dataKey="month" hide />
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <ChartTooltip
          cursor={{
            stroke: "var(--color-value)",
            strokeWidth: 1,
            strokeOpacity: 0.3,
          }}
          content={<MoneyTooltip granularity="month" indicator="line" />}
        />
        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--color-value)"
          strokeWidth={1.25}
          fill={`url(#${gradientId})`}
          dot={false}
          activeDot={{ r: 2.5, fill: "var(--color-value)", strokeWidth: 0 }}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  )
}
