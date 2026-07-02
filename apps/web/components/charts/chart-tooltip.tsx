"use client"

import type * as React from "react"

import { ChartTooltipContent, useChart } from "@/components/ui/chart"
import { formatMoney } from "@/lib/format"

/**
 * Format a date label appropriate for a chart granularity.
 * Accepts ISO YYYY-MM-DD or YYYY-MM strings.
 */
export function formatChartDate(
  raw: string,
  granularity: "day" | "week" | "month" | "quarter" | "year" = "month"
): string {
  // YYYY-MM-DD or YYYY-MM
  const m =
    /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(raw) || /^(\d{4})-(\d{2})$/.exec(raw)
  if (!m) return raw
  const year = Number(m[1])
  const month = Number(m[2])
  const day = m[3] ? Number(m[3]) : null
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ]
  if (granularity === "year") return String(year)
  if (granularity === "quarter") {
    const q = Math.floor((month - 1) / 3) + 1
    return `Q${q} ${year}`
  }
  if (granularity === "month" || day == null) {
    return `${MONTHS[month - 1]} ${year}`
  }
  return `${MONTHS[month - 1]} ${day}, ${year}`
}

/**
 * Universal tooltip content. Renders:
 *   <date>
 *   ● <label>          <value>
 *
 * The series label is resolved from the chart's `ChartConfig` (so `dataKey`
 * "value" / "income" / "expense" / "net" → "Net worth" / "Income" / "Expense"
 * / "Net" instead of the raw key).
 *
 * Use as the `content` prop on a recharts ChartTooltip wrapper.
 */
export function MoneyTooltip({
  granularity = "month",
  ...props
}: React.ComponentProps<typeof ChartTooltipContent> & {
  granularity?: "day" | "week" | "month" | "quarter" | "year"
}) {
  const { config } = useChart()
  return (
    <ChartTooltipContent
      {...props}
      labelFormatter={(label) =>
        typeof label === "string" ? formatChartDate(label, granularity) : label
      }
      formatter={(value, name, item) => {
        const key = String(item.dataKey ?? name ?? "")
        const resolved = config[key]?.label ?? String(name)
        return (
          <div className="flex w-full min-w-[10rem] items-center justify-between gap-3">
            <div className="flex items-center gap-1.5">
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: item.color }}
              />
              <span className="text-muted-foreground">{resolved}</span>
            </div>
            <span className="font-mono tabular-nums">
              {formatMoney(value as number, { maximumFractionDigits: 0 })}
            </span>
          </div>
        )
      }}
      indicator="dot"
    />
  )
}
