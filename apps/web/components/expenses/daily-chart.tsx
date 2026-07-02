"use client"

import * as React from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"
import { MoneyTooltip } from "@/components/charts/chart-tooltip"
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart"
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
    if (totals.size === 0) return []
    const dates = Array.from(totals.keys()).sort()
    const start = dates[0]
    const end = dates[dates.length - 1]
    const out: DailyEntry[] = []
    const cursor = new Date(`${start}T00:00:00`)
    const last = new Date(`${end}T00:00:00`)
    while (cursor <= last) {
      const y = cursor.getFullYear()
      const m = String(cursor.getMonth() + 1).padStart(2, "0")
      const d = String(cursor.getDate()).padStart(2, "0")
      const key = `${y}-${m}-${d}`
      out.push({ date: key, expense: totals.get(key) ?? 0 })
      cursor.setDate(cursor.getDate() + 1)
    }
    return out
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
