"use client"

import { Area, AreaChart, ReferenceLine, XAxis, YAxis } from "recharts"

import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
import { MoneyTooltip } from "@/components/charts/chart-tooltip"
import type { NetWorthPoint } from "@/components/balances/net-worth-chart"

const CONFIG: ChartConfig = {
  net: { label: "Net worth", color: "var(--primary)" },
}

interface MobileNetWorthChartProps {
  data: NetWorthPoint[]
  onHover?: (point: NetWorthPoint | null) => void
}

// Phone-sized variant of NetWorthChart: shorter, no YAxis labels, no
// gridlines. Recharts handles touchmove internally via its tooltip
// machinery, so the same onHover hook works for finger scrub.
export function MobileNetWorthChart({
  data,
  onHover,
}: MobileNetWorthChartProps) {
  const rows = data.map((p) => ({
    month: p.date.slice(0, 7),
    net: p.net,
    raw: p,
  }))

  return (
    <ChartContainer config={CONFIG} className="h-40 w-full">
      <AreaChart
        data={rows}
        margin={{ top: 4, right: 8, left: 8, bottom: 0 }}
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
          <linearGradient
            id="mobile-net-worth-fill"
            x1="0"
            y1="0"
            x2="0"
            y2="1"
          >
            <stop offset="0%" stopColor="var(--color-net)" stopOpacity={0.3} />
            <stop offset="100%" stopColor="var(--color-net)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="month"
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          fontSize={10}
          minTickGap={48}
        />
        <YAxis hide domain={["dataMin", "dataMax"]} />
        <ReferenceLine y={0} stroke="var(--border)" strokeDasharray="3 3" />
        <ChartTooltip
          cursor={{ stroke: "var(--color-net)", strokeOpacity: 0.4 }}
          content={<MoneyTooltip granularity="month" indicator="line" />}
        />
        <Area
          type="monotone"
          dataKey="net"
          stroke="var(--color-net)"
          strokeWidth={1.5}
          fill="url(#mobile-net-worth-fill)"
          dot={false}
          activeDot={{ r: 3, fill: "var(--color-net)", strokeWidth: 0 }}
        />
      </AreaChart>
    </ChartContainer>
  )
}
