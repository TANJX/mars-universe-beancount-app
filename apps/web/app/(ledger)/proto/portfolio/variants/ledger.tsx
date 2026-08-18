"use client"

// PROTOTYPE variant 1 — "Ledger"
// Axis: density / table-first. The holdings table IS the page. Every chart is
// demoted to a strip that supports the table rather than competing with it.
// Closest sibling in this app is /balances and /plan.

import * as React from "react"

import { Money } from "@/components/primitives/money"
import { Card } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatLongDate } from "@/lib/format"

import {
  ASOF,
  byAssetClass,
  bySleeve,
  byTicker,
  CONTRIBUTIONS,
  DRIFT_THRESHOLD_PP,
  driftRows,
  portfolioTotals,
  REALIZED,
  SERIES,
  type SeriesPoint,
  SLEEVES,
  sleeveTotals,
} from "../mock"
import {
  ClosedDisclosure,
  DriftChart,
  DriftStatusLine,
  Gain,
  HoldingRow,
  HoldingsHeader,
  HoverDateCaption,
  Label,
  MarginMeter,
  Pct,
  RankedBars,
  StaleBadge,
  TaxChip,
  ValueCostChart,
  ValueCostLegend,
} from "../shared"

type Grouping = "class" | "ticker" | "sleeve"

export function LedgerVariant() {
  const totals = portfolioTotals()
  const [hover, setHover] = React.useState<SeriesPoint | null>(null)
  const [grouping, setGrouping] = React.useState<Grouping>("class")

  const headerValue = hover ? hover.value : totals.value
  const headerCost = hover ? hover.cost : totals.cost
  const headerGain = headerValue - headerCost
  const headerPct = headerCost ? (headerGain / headerCost) * 100 : 0

  const allocRows =
    grouping === "class"
      ? byAssetClass()
      : grouping === "ticker"
        ? byTicker()
        : bySleeve()

  const openSleeves = SLEEVES.filter((s) => sleeveTotals(s).open.length > 0)
  const topWeight = Math.max(
    ...openSleeves.flatMap((s) =>
      sleeveTotals(s).open.map((h) => (h.value / totals.securitiesValue) * 100)
    )
  )

  return (
    <div className="flex flex-col gap-3 px-7 pt-2 pb-10">
      {/* ── header ─────────────────────────────────────────────────────── */}
      <header className="flex items-start justify-between gap-6">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="font-medium text-xl tracking-tight">Portfolio</h1>
            <StaleBadge />
          </div>
          <HoverDateCaption
            hover={hover}
            fallback={`Holdings as of ${formatLongDate(ASOF)}`}
          />
        </div>
        <div className="flex items-end gap-7">
          <div className="flex flex-col gap-0.5 text-right">
            <Label>Cost basis</Label>
            <Money
              value={headerCost}
              className="text-base"
              maximumFractionDigits={0}
            />
          </div>
          <div className="flex flex-col gap-0.5 text-right">
            <Label>Unrealized</Label>
            <Gain
              value={headerGain}
              pct={headerPct}
              className="justify-end text-base"
            />
          </div>
          <div className="flex flex-col gap-0.5 text-right">
            <Label>Market value</Label>
            <Money
              value={headerValue}
              className="text-2xl tracking-tight"
              maximumFractionDigits={0}
            />
          </div>
        </div>
      </header>

      {/* ── one strip: trend, allocation, obligations ───────────────────── */}
      <div className="grid grid-cols-[1.35fr_1fr_1fr] items-stretch gap-3">
        <Card className="gap-0 overflow-hidden p-0">
          <div className="flex items-center justify-between px-4 pt-2.5 pb-1">
            <Label>Value vs cost</Label>
            <ValueCostLegend />
          </div>
          <div className="px-2 pb-2">
            <ValueCostChart data={SERIES} height="h-32" onHover={setHover} />
          </div>
        </Card>

        <Card className="gap-0 overflow-hidden p-0">
          <div className="flex items-center justify-between px-4 pt-2.5 pb-1.5">
            <Label>Allocation</Label>
            <Tabs
              value={grouping}
              onValueChange={(v) => setGrouping(v as Grouping)}
            >
              <TabsList className="h-6">
                <TabsTrigger value="class" className="px-2 text-[11px]">
                  Class
                </TabsTrigger>
                <TabsTrigger value="sleeve" className="px-2 text-[11px]">
                  Sleeve
                </TabsTrigger>
                <TabsTrigger value="ticker" className="px-2 text-[11px]">
                  Ticker
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="max-h-[8.5rem] overflow-y-auto px-4 pb-2">
            <RankedBars
              rows={allocRows}
              max={grouping === "ticker" ? 8 : undefined}
              showValue={false}
            />
          </div>
        </Card>

        <Card className="flex flex-col gap-3 p-4">
          <Label>2026 contribution room</Label>
          {CONTRIBUTIONS.map((r) => (
            <div key={r.key} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-xs">{r.label}</span>
                <span className="font-mono text-[11px] tabular-nums">
                  <Money value={r.limit - r.used} maximumFractionDigits={0} />{" "}
                  left
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary/80"
                  style={{ width: `${(r.used / r.limit) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </Card>
      </div>

      {/* ── the page: holdings ─────────────────────────────────────────── */}
      <Card className="gap-0 overflow-hidden p-0">
        <HoldingsHeader dense />
        {openSleeves.map((s) => {
          const t = sleeveTotals(s)
          const drift = driftRows(s)
          const fires = (t.worstDrift ?? 0) > DRIFT_THRESHOLD_PP
          return (
            <section key={s.id} className="border-b last:border-b-0">
              <div className="flex items-center justify-between gap-4 bg-muted/40 px-4 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-[13px]">{s.label}</span>
                  <TaxChip tax={s.tax} />
                  <DriftStatusLine totals={t} />
                </div>
                <div className="flex items-center gap-5 font-mono text-xs tabular-nums">
                  {s.cash !== 0 && (
                    <span className="text-muted-foreground">
                      cash <Money value={s.cash} maximumFractionDigits={0} />
                    </span>
                  )}
                  <Money value={t.securitiesValue} maximumFractionDigits={0} />
                  <Gain value={t.gain} pct={t.gainPct} className="text-xs" />
                  <Pct
                    value={(t.securitiesValue / totals.securitiesValue) * 100}
                    signed={false}
                    className="w-11 text-right text-muted-foreground"
                  />
                </div>
              </div>
              {t.open
                .slice()
                .sort((a, b) => b.value - a.value)
                .map((h) => (
                  <HoldingRow
                    key={`${s.id}-${h.ticker}`}
                    h={h}
                    weight={(h.value / totals.securitiesValue) * 100}
                    topWeight={topWeight}
                    dense
                  />
                ))}
              {/* Drift only earns chart space when it actually fires. */}
              {fires && (
                <div className="border-t bg-rose-500/[0.03] px-4 py-2">
                  <div className="mb-1 flex items-center gap-2">
                    <Label className="text-rose-600 dark:text-rose-400">
                      Drift past ±{DRIFT_THRESHOLD_PP}pp
                    </Label>
                  </div>
                  <DriftChart rows={drift} />
                </div>
              )}
              {s.marginFreeTranche && s.cash < 0 && (
                <div className="border-t px-4 py-2.5">
                  <MarginMeter drawn={s.cash} tranche={s.marginFreeTranche} />
                </div>
              )}
              <ClosedDisclosure closed={t.closed} />
            </section>
          )
        })}
      </Card>

      {/* ── realized ───────────────────────────────────────────────────── */}
      <Card className="gap-0 overflow-hidden p-0">
        <div className="grid grid-cols-[minmax(0,1fr)_8rem_8rem] gap-x-3 border-b px-4 py-2 text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]">
          <span>Realized</span>
          <span className="text-right">Gains</span>
          <span className="text-right">Dividends</span>
        </div>
        {REALIZED.map((r) => (
          <div
            key={r.year}
            className="grid grid-cols-[minmax(0,1fr)_8rem_8rem] gap-x-3 px-4 py-1.5"
          >
            <span className="font-mono text-[13px] tabular-nums">{r.year}</span>
            <Money value={r.gains} tone="pos" className="text-right text-xs" />
            <Money
              value={r.dividends}
              tone="pos"
              className="text-right text-xs"
            />
          </div>
        ))}
        <div className="grid grid-cols-[minmax(0,1fr)_8rem_8rem] gap-x-3 border-t px-4 py-1.5">
          <span className="text-[13px] text-muted-foreground">Lifetime</span>
          <Money
            value={REALIZED.reduce((a, r) => a + r.gains, 0)}
            tone="pos"
            className="text-right text-[13px]"
          />
          <Money
            value={REALIZED.reduce((a, r) => a + r.dividends, 0)}
            tone="pos"
            className="text-right text-[13px]"
          />
        </div>
      </Card>
    </div>
  )
}
