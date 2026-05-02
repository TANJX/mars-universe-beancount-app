"use client"

import { Bar, ComposedChart, ReferenceLine, XAxis, YAxis } from "recharts"

import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
import { MoneyTooltip } from "@/components/charts/chart-tooltip"
import type { MonthlyEntry } from "@/lib/types/views"

const CONFIG: ChartConfig = {
  income: { label: "Income", color: "var(--color-emerald-500)" },
  expense: { label: "Expense", color: "var(--color-rose-500)" },
}

interface MobileMonthlyChartProps {
  data: MonthlyEntry[]
  onHover?: (entry: MonthlyEntry | null) => void
}

// Phone-sized variant of MonthlyChart: shorter, no Y-axis labels, no
// gridlines, no legend, no Net line. Recharts handles touchmove via its
// tooltip machinery so onHover works for finger scrub.
export function MobileMonthlyChart({ data, onHover }: MobileMonthlyChartProps) {
  const rows = data.map((d) => ({
    month: d.month.slice(0, 7),
    income: d.income,
    expense: d.expense,
    raw: d,
  }))

  return (
    <ChartContainer config={CONFIG} className="h-40 w-full">
      <ComposedChart
        data={rows}
        margin={{ top: 4, right: 8, left: 8, bottom: 0 }}
        onMouseMove={(e: unknown) => {
          const point = (
            e as { activePayload?: Array<{ payload?: { raw?: MonthlyEntry } }> }
          )?.activePayload?.[0]?.payload?.raw
          if (onHover) onHover(point ?? null)
        }}
        onMouseLeave={() => onHover?.(null)}
      >
        <XAxis
          dataKey="month"
          tickLine={false}
          axisLine={false}
          tickMargin={4}
          fontSize={10}
          minTickGap={32}
        />
        <YAxis hide />
        <ReferenceLine y={0} stroke="var(--border)" />
        <ChartTooltip
          cursor={{ fill: "var(--muted)", opacity: 0.4 }}
          content={<MoneyTooltip granularity="month" />}
        />
        <Bar
          dataKey="income"
          fill="var(--color-income)"
          radius={[2, 2, 0, 0]}
        />
        <Bar
          dataKey="expense"
          fill="var(--color-expense)"
          radius={[2, 2, 0, 0]}
        />
      </ComposedChart>
    </ChartContainer>
  )
}
