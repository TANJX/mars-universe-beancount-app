"use client"

import * as React from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart"
import { MoneyTooltip } from "@/components/charts/chart-tooltip"
import type { ExpenseRowData } from "@/lib/transform/expense-row"

const CONFIG: ChartConfig = {
  expense: { label: "Expense", color: "var(--color-rose-500)" },
}

interface DailyEntry {
  date: string
  expense: number
}

interface DailyChartProps {
  rows: ExpenseRowData[]
  onHover?: (entry: DailyEntry | null) => void
}

export function DailyChart({ rows, onHover }: DailyChartProps) {
  const data = React.useMemo<DailyEntry[]>(() => {
    const totals = new Map<string, number>()
    for (const r of rows) {
      const date = r.row.txn.date
      totals.set(date, (totals.get(date) ?? 0) + r.share)
    }
    return Array.from(totals.entries())
      .map(([date, expense]) => ({ date, expense }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }, [rows])

  return (
    <ChartContainer config={CONFIG} className="h-40 w-full">
      <BarChart
        data={data}
        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        onMouseMove={(e: unknown) => {
          const point = (
            e as { activePayload?: Array<{ payload?: DailyEntry }> }
          )?.activePayload?.[0]?.payload
          if (onHover) onHover(point ?? null)
        }}
        onMouseLeave={() => onHover?.(null)}
      >
        <CartesianGrid vertical={false} strokeDasharray="2 4" />
        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          fontSize={11}
          tickFormatter={(v) => (v as string).slice(5)}
          minTickGap={24}
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
          content={<MoneyTooltip granularity="day" />}
        />
        <Bar
          dataKey="expense"
          fill="var(--color-expense)"
          radius={[3, 3, 0, 0]}
        />
      </BarChart>
    </ChartContainer>
  )
}
