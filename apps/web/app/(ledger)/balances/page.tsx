"use client"

import * as React from "react"
import { AlertCircle } from "lucide-react"

import { BalanceTree } from "@/components/balances/balance-tree"
import { MobileBalances } from "@/components/balances/mobile/mobile-balances"
import {
  NetWorthChart,
  type NetWorthPoint,
} from "@/components/balances/net-worth-chart"
import { SkeletonTreeRow } from "@/components/skeletons/atoms"
import { MobileBalancesSkeleton } from "@/components/skeletons/balances-skeleton"
import { Card } from "@/components/ui/card"
import { AnimatedMoney } from "@/components/primitives/animated-money"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatChartDate } from "@/components/charts/chart-tooltip"
import { Skeleton } from "@/components/ui/skeleton"
import { useUIState } from "@/components/layout/ui-state"
import { useBalanceSheet, useNetWorthSeries } from "@/hooks/use-fava"
import { useIsMobile } from "@/hooks/use-mobile"
import type { Conversion } from "@/lib/types/views"

function pickUSD(inv: Record<string, number> | undefined): number {
  return inv?.USD ?? 0
}

export default function BalancesPage() {
  const { period, conversion, setConversion } = useUIState()
  const isMobile = useIsMobile()
  const sheet = useBalanceSheet()
  const series = useNetWorthSeries()

  const trees = sheet.data?.trees ?? {}
  const assetsBal = pickUSD(trees.Assets?.balanceChildren)
  const liabBal = pickUSD(trees.Liabilities?.balanceChildren)
  const netWorth = assetsBal + liabBal

  // Hover-scrub: when the chart is hovered, the header reads the hovered
  // point. On mouse-out we snap back to the period totals.
  const [hover, setHover] = React.useState<NetWorthPoint | null>(null)
  const headerNet = hover ? hover.net : netWorth

  const errored = sheet.error || series.error
  const errorMsg = errored
    ? errored instanceof Error
      ? errored.message
      : String(errored)
    : null

  if (isMobile) {
    return (
      <>
        {errorMsg && (
          <div className="mx-5 mt-3 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm">
            <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose-500" />
            <div className="flex flex-col gap-0.5">
              <div className="font-medium">Couldn&apos;t load balances</div>
              <div className="text-xs text-muted-foreground">{errorMsg}</div>
            </div>
          </div>
        )}
        {sheet.data ? (
          <MobileBalances
            period={period}
            trees={trees}
            netWorth={netWorth}
            series={series.data}
          />
        ) : (
          <MobileBalancesSkeleton />
        )}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-4 px-7 pt-2 pb-10">
      <header className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-2">
          <div>
            <div className="text-xl font-medium tracking-tight">Balances</div>
            <div className="mt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
              {hover ? formatChartDate(hover.date, "month") : period.range}
            </div>
          </div>
          <Tabs
            value={conversion}
            onValueChange={(v) => setConversion(v as Conversion)}
          >
            <TabsList>
              <TabsTrigger value="at_value">At Market Value</TabsTrigger>
              <TabsTrigger value="at_cost">At Cost</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="flex items-end gap-7">
          {!hover && (
            <>
              <HeaderCell label="Assets" value={assetsBal} tone="pos" />
              <HeaderCell label="Liabilities" value={liabBal} tone="neg" />
            </>
          )}
          <HeaderCell label="Net Worth" value={headerNet} big />
        </div>
      </header>

      {errorMsg && (
        <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose-500" />
          <div className="flex flex-col gap-0.5">
            <div className="font-medium">Couldn&apos;t load balances</div>
            <div className="text-xs text-muted-foreground">{errorMsg}</div>
          </div>
        </div>
      )}

      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <span className="text-xs font-medium tracking-wide text-muted-foreground">
            Net worth over time
          </span>
          {series.data && series.data.length > 0 && (
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {series.data.length} months
            </span>
          )}
        </div>
        <div className="px-4 pb-4">
          {series.isPending ? (
            <Skeleton className="h-56 w-full" />
          ) : series.data && series.data.length > 0 ? (
            <NetWorthChart data={series.data} onHover={setHover} />
          ) : (
            <div className="flex h-56 items-center justify-center text-xs text-muted-foreground">
              No net-worth history available.
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 items-start gap-4">
        <Card className="gap-0 overflow-hidden p-0">
          {trees.Assets ? (
            <BalanceTree title="Assets" rootKind="Assets" root={trees.Assets} />
          ) : (
            <TreePlaceholder title="Assets" />
          )}
        </Card>
        <Card className="gap-0 divide-y overflow-hidden p-0">
          {trees.Liabilities ? (
            <BalanceTree
              title="Liabilities"
              rootKind="Liabilities"
              root={trees.Liabilities}
            />
          ) : (
            <TreePlaceholder title="Liabilities" />
          )}
          {trees.Equity ? (
            <BalanceTree title="Equity" rootKind="Equity" root={trees.Equity} />
          ) : (
            <TreePlaceholder title="Equity" />
          )}
        </Card>
      </div>
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
