"use client"

import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts"

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
import { MoneyTooltip } from "@/components/charts/chart-tooltip"
import type { Granularity, MonthlyEntry } from "@/lib/types/views"

const CONFIG: ChartConfig = {
  income: { label: "Income", color: "var(--color-emerald-500)" },
  expense: { label: "Expense", color: "var(--color-rose-500)" },
  net: { label: "Net", color: "var(--primary)" },
}

interface MonthlyChartProps {
  data: MonthlyEntry[]
  granularity: Granularity
  onHover?: (entry: MonthlyEntry | null) => void
}

export function MonthlyChart({
  data,
  granularity,
  onHover,
}: MonthlyChartProps) {
  // The Net line is meaningful at month+ scale; on day/week it zigzags
  // through zero and obscures the bars.
  const showNetLine = granularity !== "day" && granularity !== "week"
  const rows = data.map((d) => ({
    month: d.month.slice(0, 7),
    income: d.income,
    expense: d.expense,
    net: d.income - d.expense,
    raw: d,
  }))

  return (
    <ChartContainer config={CONFIG} className="h-56 w-full">
      <ComposedChart
        data={rows}
        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        onMouseMove={(e: unknown) => {
          const point = (
            e as { activePayload?: Array<{ payload?: { raw?: MonthlyEntry } }> }
          )?.activePayload?.[0]?.payload?.raw
          if (onHover) onHover(point ?? null)
        }}
        onMouseLeave={() => onHover?.(null)}
      >
        <CartesianGrid vertical={false} strokeDasharray="2 4" />
        <XAxis
          dataKey="month"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          fontSize={11}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          fontSize={11}
          width={56}
          tickFormatter={(v) => `$${(v as number) / 1000}k`}
        />
        <ChartTooltip
          cursor={{ fill: "var(--muted)", opacity: 0.4 }}
          content={<MoneyTooltip granularity={granularity} />}
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar
          dataKey="income"
          fill="var(--color-income)"
          radius={[3, 3, 0, 0]}
        />
        <Bar
          dataKey="expense"
          fill="var(--color-expense)"
          radius={[3, 3, 0, 0]}
        />
        {showNetLine && (
          <Line
            type="monotone"
            dataKey="net"
            stroke="var(--color-net)"
            strokeWidth={1.5}
            dot={{ r: 3, fill: "var(--color-net)" }}
            activeDot={{ r: 4 }}
          />
        )}
      </ComposedChart>
    </ChartContainer>
  )
}
