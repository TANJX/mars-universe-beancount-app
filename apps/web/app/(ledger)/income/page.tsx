"use client"

import * as React from "react"
import { AlertCircle } from "lucide-react"

import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { MobileIncome } from "@/components/income/mobile/mobile-income"
import { CategoryChart } from "@/components/income/category-chart"
import { MonthlyChart } from "@/components/income/monthly-chart"
import { BalanceTree } from "@/components/balances/balance-tree"
import { AnimatedMoney } from "@/components/primitives/animated-money"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SkeletonTreeRow } from "@/components/skeletons/atoms"
import { MobileIncomeSkeleton } from "@/components/skeletons/income-skeleton"
import { useUIState } from "@/components/layout/ui-state"
import { useIncomeStatement } from "@/hooks/use-fava"
import { useIsMobile } from "@/hooks/use-mobile"
import { defaultGranularity } from "@/lib/fava/periods"
import type { Granularity, MonthlyEntry } from "@/lib/types/views"

type ChartView = "summary" | "categories"

export default function IncomePage() {
  const { period } = useUIState()
  const periodKey = `${period.id}:${period.from ?? ""}:${period.to ?? ""}`
  const defaultChartGranularity = clampGranularity(defaultGranularity(period))

  // Granularity defaults from the active period. A user override only applies
  // to the current period snapshot instead of being synchronized in an effect.
  const [granularityOverride, setGranularityOverride] = React.useState<{
    periodKey: string
    value: Granularity
  } | null>(null)
  const granularity =
    granularityOverride?.periodKey === periodKey
      ? granularityOverride.value
      : defaultChartGranularity
  const setGranularity = React.useCallback(
    (value: string) => {
      const next = value as Granularity
      setGranularityOverride(
        next === defaultChartGranularity ? null : { periodKey, value: next }
      )
    },
    [defaultChartGranularity, periodKey]
  )

  const [chartView, setChartView] = React.useState<ChartView>("summary")

  // Tree data follows the period filter.
  const trees = useIncomeStatement({ interval: granularity })
  // Chart series always paints context — last 12 *intervals* regardless of
  // the active period filter.
  const chart = useIncomeStatement({
    interval: granularity,
    timeOverride: chartContextTime(granularity),
  })

  const totalIn = trees.data ? -(trees.data.income.balanceChildren.USD ?? 0) : 0
  const totalOut = trees.data
    ? (trees.data.expenses.balanceChildren.USD ?? 0)
    : 0

  // Hover-scrub: when the user hovers a chart point, override the headline
  // numbers to show that point's totals.
  const [hover, setHover] = React.useState<MonthlyEntry | null>(null)
  const headerIn = hover?.income ?? totalIn
  const headerOut = hover?.expense ?? totalOut
  const headerNet = headerIn - headerOut

  const isError = trees.isError || chart.isError
  const error = trees.error || chart.error
  const isMobile = useIsMobile()
  const errorMsg = error
    ? error instanceof Error
      ? error.message
      : String(error)
    : null

  if (isMobile) {
    return (
      <>
        {isError && (
          <div className="mx-5 mt-3 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose-500" />
            <div className="flex flex-col gap-0.5">
              <div className="font-medium">
                Couldn&apos;t load income statement
              </div>
              <div className="text-xs text-muted-foreground">{errorMsg}</div>
            </div>
          </div>
        )}
        {trees.data ? (
          <MobileIncome
            period={period}
            statement={trees.data}
            chart={chart.data?.monthly}
          />
        ) : (
          <MobileIncomeSkeleton />
        )}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-4 px-7 pt-2 pb-10">
      <header className="flex items-start justify-between gap-6">
        <div>
          <div className="text-xl font-medium tracking-tight">Income</div>
          <div className="mt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
            {hover ? formatHoverLabel(hover.month, granularity) : period.range}
          </div>
        </div>
        <div className="flex items-end gap-7">
          <HeaderCell label="In" value={headerIn} tone="pos" />
          <HeaderCell label="Out" value={-headerOut} tone="neg" />
          <HeaderCell label="Net" value={headerNet} big />
        </div>
      </header>

      {isError && (
        <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose-500" />
          <div className="flex flex-col gap-0.5">
            <div className="font-medium">
              Couldn&apos;t load income statement
            </div>
            <div className="text-xs text-muted-foreground">
              {error instanceof Error ? error.message : String(error)}
            </div>
          </div>
        </div>
      )}

      <Card className="gap-0 overflow-visible p-0">
        <Tabs
          value={chartView}
          onValueChange={(v) => setChartView(v as ChartView)}
        >
          <div className="flex items-center justify-between px-4 pt-3 pb-2">
            <TabsList>
              <TabsTrigger value="summary">Summary</TabsTrigger>
              <TabsTrigger value="categories">Categories</TabsTrigger>
            </TabsList>
            <Tabs value={granularity} onValueChange={setGranularity}>
              <TabsList>
                {GRANULARITY_OPTIONS.map((o) => (
                  <TabsTrigger key={o.value} value={o.value}>
                    {o.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>
          <TabsContent value="summary" className="px-4 pb-4">
            {chart.isPending ? (
              <Skeleton className="h-56 w-full" />
            ) : chart.data ? (
              <MonthlyChart
                data={chart.data.monthly}
                granularity={granularity}
                onHover={setHover}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="categories" className="px-4 pb-4">
            {chart.isPending ? (
              <Skeleton className="h-56 w-full" />
            ) : chart.data ? (
              <CategoryChart
                data={chart.data.categoryMonthly}
                granularity={granularity}
                onHover={setHover}
              />
            ) : null}
          </TabsContent>
        </Tabs>
      </Card>

      <div className="grid grid-cols-2 items-start gap-4">
        <Card className="gap-0 overflow-hidden p-0">
          {trees.data ? (
            <BalanceTree
              title="Income"
              rootKind="Income"
              root={trees.data.income}
              flipSign
            />
          ) : (
            <TreePlaceholder title="Income" />
          )}
        </Card>
        <Card className="gap-0 overflow-hidden p-0">
          {trees.data ? (
            <BalanceTree
              title="Expenses"
              rootKind="Expenses"
              root={trees.data.expenses}
              flipSign
            />
          ) : (
            <TreePlaceholder title="Expenses" />
          )}
        </Card>
      </div>
    </div>
  )
}

const GRANULARITY_OPTIONS: { value: Granularity; label: string }[] = [
  { value: "month", label: "Month" },
  { value: "quarter", label: "Qtr" },
]

function clampGranularity(g: Granularity): Granularity {
  if (g === "day" || g === "week") return "month"
  if (g === "year") return "quarter"
  return g
}

/** Resolve a Fava `time=` window large enough to give the chart context. */
function chartContextTime(g: Granularity): string {
  const now = new Date()
  const end = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  const start = new Date(now)
  switch (g) {
    case "day":
      start.setMonth(start.getMonth() - 1)
      break
    case "week":
      start.setMonth(start.getMonth() - 3)
      break
    case "month":
      start.setMonth(start.getMonth() - 11)
      break
    case "quarter":
      start.setFullYear(start.getFullYear() - 2)
      break
  }
  const startStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`
  return `${startStr} - ${end}`
}

function formatHoverLabel(date: string, g: Granularity): string {
  // date is something like "2026-04-30" (month interval end). Render
  // contextually for the granularity.
  const m = /^(\d{4})-(\d{2})/.exec(date)
  if (!m) return date
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
  const year = m[1]
  const month = Number(m[2])
  if (g === "quarter") return `Q${Math.floor((month - 1) / 3) + 1} ${year}`
  return `${MONTHS[month - 1]} ${year}`
}

function TreePlaceholder({ title }: { title: string }) {
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b px-4 pt-3 pb-2">
        <span className="text-sm font-medium">{title}</span>
        <Skeleton className="h-3 w-20" />
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <SkeletonTreeRow key={i} depth={i % 2} />
      ))}
    </div>
  )
}

function HeaderCell({
  label,
  value,
  tone,
  big = false,
}: {
  label: string
  value: number
  tone?: "pos" | "neg"
  big?: boolean
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <AnimatedMoney
        value={value}
        tone={tone ?? "auto"}
        className={
          big ? "text-2xl font-medium tracking-tight" : "text-base font-medium"
        }
      />
    </div>
  )
}
