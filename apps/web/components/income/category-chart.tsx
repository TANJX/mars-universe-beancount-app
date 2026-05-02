"use client"

import * as React from "react"
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
  useChart,
} from "@/components/ui/chart"
import { formatChartDate } from "@/components/charts/chart-tooltip"
import { useDisplayAccount } from "@/lib/accounts/display-names"
import {
  useLookupCategoryColor,
  useRollupKey,
} from "@/lib/accounts/palette"
import { formatMoney } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { AccountPath } from "@/lib/types/beancount"
import type {
  CategoryMonthlyEntry,
  Granularity,
  MonthlyEntry,
} from "@/lib/types/views"

const TOP_N = 5

// Fallback palette when a category has no hand-picked color. Two hue families
// so income vs expense reads at a glance. Within each side, rank-1 (largest
// total) gets the darkest color so the densest band sits visually weighty at
// the bottom of each stack.
const INCOME_PALETTE = [
  "var(--color-emerald-700)",
  "var(--color-teal-500)",
  "var(--color-cyan-500)",
  "var(--color-sky-500)",
  "var(--color-indigo-400)",
]
const EXPENSE_PALETTE = [
  "var(--color-rose-700)",
  "var(--color-orange-500)",
  "var(--color-amber-500)",
  "var(--color-pink-500)",
  "var(--color-fuchsia-400)",
]
const OTHER_INCOME_COLOR = "var(--color-emerald-300)"
const OTHER_EXPENSE_COLOR = "var(--color-rose-300)"

interface CategoryChartProps {
  data: CategoryMonthlyEntry[]
  granularity: Granularity
  onHover?: (entry: MonthlyEntry | null) => void
}

interface ChartRow {
  month: string
  raw: CategoryMonthlyEntry
  [dataKey: string]: number | string | CategoryMonthlyEntry
}

function safeKey(prefix: "inc" | "exp", segment: string): string {
  return `${prefix}_${segment.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`
}

interface CategoryTooltipProps {
  active?: boolean
  payload?: Array<{
    dataKey?: string | number
    name?: string | number
    value?: number
    color?: string
  }>
  label?: string
  granularity: Granularity
}

/**
 * Split tooltip: groups income series under one section and expense series
 * under another, each with its own subtotal. Largest items render first
 * inside each group so the visual order matches the stack order.
 */
function CategoryTooltip({
  active,
  payload,
  label,
  granularity,
}: CategoryTooltipProps) {
  const { config } = useChart()
  if (!active || !payload?.length) return null

  const incomeRows: typeof payload = []
  const expenseRows: typeof payload = []
  for (const item of payload) {
    const key = String(item.dataKey ?? "")
    if (key.startsWith("inc_")) incomeRows.push(item)
    else if (key.startsWith("exp_")) expenseRows.push(item)
  }

  // Sort within each section by value desc so the largest contributors
  // appear at the top of the section.
  const byValueDesc = (a: { value?: number }, b: { value?: number }) =>
    (b.value ?? 0) - (a.value ?? 0)
  incomeRows.sort(byValueDesc)
  expenseRows.sort(byValueDesc)

  const sum = (rows: typeof payload) =>
    rows.reduce((acc, r) => acc + (r.value ?? 0), 0)

  const dateLabel =
    typeof label === "string" ? formatChartDate(label, granularity) : label

  return (
    <div className="grid min-w-44 gap-2 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      {dateLabel && <div className="font-medium">{dateLabel}</div>}
      {incomeRows.length > 0 && (
        <Section
          title="Income"
          total={sum(incomeRows)}
          rows={incomeRows}
          config={config}
        />
      )}
      {expenseRows.length > 0 && (
        <Section
          title="Expense"
          total={sum(expenseRows)}
          rows={expenseRows}
          config={config}
        />
      )}
    </div>
  )
}

function Section({
  title,
  total,
  rows,
  config,
}: {
  title: string
  total: number
  rows: NonNullable<CategoryTooltipProps["payload"]>
  config: ChartConfig
}) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[0.625rem] font-medium tracking-wide text-muted-foreground uppercase">
          {title}
        </span>
        <span className="font-mono font-medium tabular-nums">
          {formatMoney(total, { maximumFractionDigits: 0 })}
        </span>
      </div>
      <div className="grid gap-1">
        {rows.map((r, i) => {
          const key = String(r.dataKey ?? "")
          const label = config[key]?.label ?? r.name
          return (
            <div
              key={i}
              className={cn(
                "flex items-center justify-between gap-3 leading-none"
              )}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{ background: r.color }}
                />
                <span className="text-muted-foreground">{label}</span>
              </div>
              <span className="font-mono tabular-nums">
                {formatMoney(r.value ?? 0, { maximumFractionDigits: 0 })}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Estimated tooltip width used for right-edge collision detection. Real width
// varies with category names but stays close to this for typical accounts;
// over-estimating biases toward flipping early which is the safer default.
const TOOLTIP_WIDTH_PX = 220

export function CategoryChart({
  data,
  granularity,
  onHover,
}: CategoryChartProps) {
  // Track cursor position relative to the chart so the tooltip can flip to
  // the left of the cursor when there's not enough room on the right.
  const wrapperRef = React.useRef<HTMLDivElement>(null)
  const [tooltipPos, setTooltipPos] = React.useState<
    { x: number; y: number } | undefined
  >(undefined)

  const rollupKey = useRollupKey()
  const lookupCategoryColor = useLookupCategoryColor()
  const displayAccount = useDisplayAccount()

  // Apply per-subtree rollup once up-front. Downstream top-N, config, and
  // row building all operate on these collapsed buckets.
  const rolled: CategoryMonthlyEntry[] = React.useMemo(() => {
    return data.map((d) => {
      const income: Record<AccountPath, number> = {}
      const expenses: Record<AccountPath, number> = {}
      for (const [path, v] of Object.entries(d.income)) {
        const k = rollupKey(path)
        income[k] = (income[k] ?? 0) + v
      }
      for (const [path, v] of Object.entries(d.expenses)) {
        const k = rollupKey(path)
        expenses[k] = (expenses[k] ?? 0) + v
      }
      return { month: d.month, income, expenses }
    })
  }, [data, rollupKey])
  // Pick top-N categories by total over the visible window. The same picks
  // are reused for every bucket so stack ordering stays consistent.
  const { incTop, expTop, incHasOther, expHasOther } = React.useMemo(() => {
    const incTotals: Record<string, number> = {}
    const expTotals: Record<string, number> = {}
    for (const row of rolled) {
      for (const [k, v] of Object.entries(row.income)) {
        incTotals[k] = (incTotals[k] ?? 0) + v
      }
      for (const [k, v] of Object.entries(row.expenses)) {
        expTotals[k] = (expTotals[k] ?? 0) + v
      }
    }
    const sorted = (m: Record<string, number>) =>
      Object.entries(m)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => k)
    const incSorted = sorted(incTotals)
    const expSorted = sorted(expTotals)
    return {
      incTop: incSorted.slice(0, TOP_N),
      expTop: expSorted.slice(0, TOP_N),
      incHasOther: incSorted.length > TOP_N,
      expHasOther: expSorted.length > TOP_N,
    }
  }, [rolled])

  const config: ChartConfig = React.useMemo(() => {
    const c: ChartConfig = {}
    incTop.forEach((path, i) => {
      c[safeKey("inc", path)] = {
        label: displayAccount(path),
        color: lookupCategoryColor(path) ?? INCOME_PALETTE[i],
      }
    })
    if (incHasOther) {
      c[safeKey("inc", "__other")] = {
        label: "Other income",
        color: OTHER_INCOME_COLOR,
      }
    }
    expTop.forEach((path, i) => {
      c[safeKey("exp", path)] = {
        label: displayAccount(path),
        color: lookupCategoryColor(path) ?? EXPENSE_PALETTE[i],
      }
    })
    if (expHasOther) {
      c[safeKey("exp", "__other")] = {
        label: "Other expense",
        color: OTHER_EXPENSE_COLOR,
      }
    }
    return c
  }, [incTop, expTop, incHasOther, expHasOther, displayAccount, lookupCategoryColor])

  const incOtherKey = safeKey("inc", "__other")
  const expOtherKey = safeKey("exp", "__other")

  const rows: ChartRow[] = React.useMemo(() => {
    return rolled.map((d) => {
      const r: ChartRow = { month: d.month.slice(0, 7), raw: d }

      let incOther = 0
      for (const [path, v] of Object.entries(d.income)) {
        if (incTop.includes(path)) {
          r[safeKey("inc", path)] = v
        } else {
          incOther += v
        }
      }
      for (const path of incTop) {
        const k = safeKey("inc", path)
        if (!(k in r)) r[k] = 0
      }
      if (incHasOther) r[incOtherKey] = incOther

      let expOther = 0
      for (const [path, v] of Object.entries(d.expenses)) {
        if (expTop.includes(path)) {
          r[safeKey("exp", path)] = v
        } else {
          expOther += v
        }
      }
      for (const path of expTop) {
        const k = safeKey("exp", path)
        if (!(k in r)) r[k] = 0
      }
      if (expHasOther) r[expOtherKey] = expOther

      return r
    })
  }, [
    rolled,
    incTop,
    expTop,
    incHasOther,
    expHasOther,
    incOtherKey,
    expOtherKey,
  ])

  return (
    <ChartContainer ref={wrapperRef} config={config} className="h-56 w-full">
      <BarChart
        data={rows}
        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
        onMouseMove={(e: unknown) => {
          const ev = e as {
            activeCoordinate?: { x: number; y: number }
            activePayload?: Array<{
              payload?: { raw?: CategoryMonthlyEntry }
            }>
          }
          // Hover-scrub: surface the bucket totals to the page header.
          const point = ev?.activePayload?.[0]?.payload?.raw
          if (point && onHover) {
            const income = Object.values(point.income).reduce(
              (a, b) => a + b,
              0
            )
            const expense = Object.values(point.expenses).reduce(
              (a, b) => a + b,
              0
            )
            onHover({ month: point.month, income, expense })
          } else if (onHover) {
            onHover(null)
          }

          // Decide tooltip side: flip left when cursor is too close to the
          // right edge to fit the tooltip beside it.
          const cursor = ev?.activeCoordinate
          const wrapperWidth = wrapperRef.current?.clientWidth ?? 0
          if (cursor && wrapperWidth > 0) {
            const wantsFlip = cursor.x + TOOLTIP_WIDTH_PX + 12 > wrapperWidth
            setTooltipPos({
              x: wantsFlip ? cursor.x - TOOLTIP_WIDTH_PX - 12 : cursor.x + 12,
              y: 8,
            })
          }
        }}
        onMouseLeave={() => {
          onHover?.(null)
          setTooltipPos(undefined)
        }}
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
          position={tooltipPos}
          wrapperStyle={{ zIndex: 50, pointerEvents: "none" }}
          content={<CategoryTooltip granularity={granularity} />}
        />
        {incTop.map((path, i) => {
          const key = safeKey("inc", path)
          const last = !incHasOther && i === incTop.length - 1
          return (
            <Bar
              key={key}
              dataKey={key}
              stackId="income"
              fill={`var(--color-${key})`}
              radius={last ? [3, 3, 0, 0] : 0}
            />
          )
        })}
        {incHasOther && (
          <Bar
            dataKey={incOtherKey}
            stackId="income"
            fill={`var(--color-${incOtherKey})`}
            radius={[3, 3, 0, 0]}
          />
        )}
        {expTop.map((path, i) => {
          const key = safeKey("exp", path)
          const last = !expHasOther && i === expTop.length - 1
          return (
            <Bar
              key={key}
              dataKey={key}
              stackId="expense"
              fill={`var(--color-${key})`}
              radius={last ? [3, 3, 0, 0] : 0}
            />
          )
        })}
        {expHasOther && (
          <Bar
            dataKey={expOtherKey}
            stackId="expense"
            fill={`var(--color-${expOtherKey})`}
            radius={[3, 3, 0, 0]}
          />
        )}
      </BarChart>
    </ChartContainer>
  )
}
