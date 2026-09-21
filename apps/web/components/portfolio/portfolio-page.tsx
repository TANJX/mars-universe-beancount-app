"use client"

// The settled Portfolio layout: header → value vs cost (full width) →
// allocation + contribution room (two-up) → positions → realized.
//
// Holdings are always as-of a date, never scoped by the global period chip.
// The header carries the three totals as Balances-style stat cells so the two
// pages read as siblings, and every figure scrubs with the chart hover.

import * as React from "react"

import { AllocationCard } from "@/components/portfolio/allocation"
import {
  Gain,
  HoverDateCaption,
  Label,
  StaleBadge,
} from "@/components/portfolio/atoms"
import { ContributionCard } from "@/components/portfolio/contribution"
import {
  asofYear,
  sleeveViews,
  topWeightOf,
  yearElapsed,
} from "@/components/portfolio/derive"
import { PositionsCard } from "@/components/portfolio/positions"
import { RealizedCard } from "@/components/portfolio/realized"
import {
  ValueCostChart,
  ValueCostLegend,
} from "@/components/portfolio/value-cost-chart"
import { Money } from "@/components/primitives/money"
import { Card } from "@/components/ui/card"
import type { Portfolio, PortfolioSeriesPoint } from "@/lib/fava/schemas"
import { formatLongDate } from "@/lib/format"

export function PortfolioView({ portfolio }: { portfolio: Portfolio }) {
  const [hover, setHover] = React.useState<PortfolioSeriesPoint | null>(null)

  const totals = portfolio.totals
  // Hovering the chart scrubs the header.
  const value = hover ? hover.value : totals.value
  const cost = hover ? hover.cost : totals.cost
  const gain = value - cost
  const gainPct = cost ? (gain / cost) * 100 : 0

  const views = React.useMemo(() => sleeveViews(portfolio), [portfolio])
  const topWeight = topWeightOf(views)
  const year = asofYear(portfolio.asof)
  const elapsed = yearElapsed(portfolio.asof)

  return (
    <div className="flex flex-col gap-4 px-7 pt-2 pb-10">
      <header className="flex items-start justify-between gap-6">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="font-medium text-xl tracking-tight">Portfolio</h1>
            <StaleBadge
              days={portfolio.staleDays}
              priceAsof={portfolio.priceAsof}
            />
          </div>
          <HoverDateCaption
            hover={hover}
            fallback={`Holdings as of ${formatLongDate(portfolio.asof)}`}
          />
        </div>
        <div className="flex items-end gap-7">
          <div className="flex flex-col gap-0.5 text-right">
            <Label>Cost basis</Label>
            <Money
              value={cost}
              className="text-base"
              maximumFractionDigits={0}
            />
          </div>
          <div className="flex flex-col gap-0.5 text-right">
            <Label>Unrealized</Label>
            <Gain
              value={gain}
              pct={gainPct}
              className="justify-end text-base"
            />
          </div>
          <div className="flex flex-col gap-0.5 text-right">
            <Label>Market value</Label>
            <Money
              value={value}
              className="text-2xl tracking-tight"
              maximumFractionDigits={0}
            />
          </div>
        </div>
      </header>

      {/* ── value vs cost, full width ─────────────────────────────────── */}
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex items-center justify-between gap-6 px-4 pt-3 pb-2">
          <span className="font-medium text-muted-foreground text-xs tracking-wide">
            Market value vs cost basis
          </span>
          <div className="flex items-center gap-4">
            <ValueCostLegend />
            <span className="font-mono text-muted-foreground text-xs tabular-nums">
              {portfolio.series.length} months
            </span>
          </div>
        </div>
        <div className="px-4 pb-4">
          {portfolio.series.length > 0 ? (
            <ValueCostChart
              data={portfolio.series}
              height="h-56"
              onHover={setHover}
            />
          ) : (
            <div className="flex h-56 items-center justify-center text-muted-foreground text-xs">
              No value history available.
            </div>
          )}
        </div>
      </Card>

      {/* ── allocation + contribution room ────────────────────────────── */}
      <div className="grid grid-cols-2 items-start gap-4">
        <AllocationCard portfolio={portfolio} />
        <ContributionCard
          rooms={portfolio.contributions}
          year={year}
          yearElapsed={elapsed}
        />
      </div>

      {/* ── positions ─────────────────────────────────────────────────── */}
      <PositionsCard
        views={views}
        topWeight={topWeight}
        totalValue={totals.value}
        positions={totals.positions}
      />

      {/* ── realized ──────────────────────────────────────────────────── */}
      <RealizedCard rows={portfolio.realized} />
    </div>
  )
}
