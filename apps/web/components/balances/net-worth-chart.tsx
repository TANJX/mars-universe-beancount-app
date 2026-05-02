"use client"

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts"

import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
import { MoneyTooltip } from "@/components/charts/chart-tooltip"

const CONFIG: ChartConfig = {
  net: { label: "Net worth", color: "var(--primary)" },
}

export interface NetWorthPoint {
  date: string
  net: number
}

interface NetWorthChartProps {
  data: NetWorthPoint[]
  /** Notify parent of the currently-hovered data row, for header scrub. */
  onHover?: (point: NetWorthPoint | null) => void
}

export function NetWorthChart({ data, onHover }: NetWorthChartProps) {
  const rows = data.map((p) => ({
    month: p.date.slice(0, 7),
    net: p.net,
    raw: p,
  }))

  return (
    <ChartContainer config={CONFIG} className="h-56 w-full">
      <AreaChart
        data={rows}
        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        onMouseMove={(e: unknown) => {
          const point = (
            e as {
              activePayload?: Array<{ payload?: { raw?: NetWorthPoint } }>
            }
          )?.activePayload?.[0]?.payload?.raw
          if (onHover) onHover(point ?? null)
        }}
        onMouseLeave={() => onHover?.(null)}
      >
        <defs>
          <linearGradient id="net-worth-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-net)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--color-net)" stopOpacity={0} />
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
          width={56}
          tickFormatter={(v) => `$${Math.round((v as number) / 1000)}k`}
        />
        <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="3 3" />
        <ChartTooltip
          cursor={{ stroke: "var(--color-net)", strokeOpacity: 0.3 }}
          content={<MoneyTooltip granularity="month" />}
        />
        <Area
          type="monotone"
          dataKey="net"
          stroke="var(--color-net)"
          strokeWidth={1.5}
          fill="url(#net-worth-fill)"
          dot={false}
          activeDot={{ r: 3, fill: "var(--color-net)", strokeWidth: 0 }}
        />
      </AreaChart>
    </ChartContainer>
  )
}
