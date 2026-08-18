"use client"

// PROTOTYPE variant 2 — "Dashboard"
// Axis: at-a-glance / chart-first. A hero figure and a KPI row lead, the trend
// chart gets real height, and holdings are demoted into a scrollable panel
// showing each sleeve's top positions. Closest sibling is /overview.

import * as React from "react"

import { SparkArea } from "@/components/charts/spark-area"
import { AnimatedMoney } from "@/components/primitives/animated-money"
import { Money } from "@/components/primitives/money"
import { Card } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatLongDate, formatMoney } from "@/lib/format"

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
  ContributionMeter,
  DriftChart,
  DriftStatusLine,
  Gain,
  HoverDateCaption,
  Label,
  MarginMeter,
  Pct,
  StackedShareBar,
  StaleBadge,
  TaxChip,
  ValueCostChart,
  ValueCostLegend,
} from "../shared"

type Grouping = "class" | "sleeve" | "ticker"

const TOP_PER_SLEEVE = 4

export function DashboardVariant() {
  const totals = portfolioTotals()
  const [hover, setHover] = React.useState<SeriesPoint | null>(null)
  const [grouping, setGrouping] = React.useState<Grouping>("class")
  const [expanded, setExpanded] = React.useState<string | null>(null)

  const headerValue = hover ? hover.value : totals.value
  const headerCost = hover ? hover.cost : totals.cost
  const headerGain = headerValue - headerCost
  const headerPct = headerCost ? (headerGain / headerCost) * 100 : 0

  const allocRows =
    grouping === "class"
      ? byAssetClass()
      : grouping === "sleeve"
        ? bySleeve()
        : byTicker()

  const drifted = SLEEVES.filter(
    (s) => (sleeveTotals(s).worstDrift ?? 0) > DRIFT_THRESHOLD_PP
  )
  const marginSleeve = SLEEVES.find((s) => s.marginFreeTranche && s.cash < 0)
  const idleCash = SLEEVES.filter((s) => s.cash > 500)

  const valueSpark = SERIES.map((p) => ({ date: p.date, value: p.value }))
  const gainSpark = SERIES.map((p) => ({
    date: p.date,
    value: p.value - p.cost,
  }))
  const costSpark = SERIES.map((p) => ({ date: p.date, value: p.cost }))

  return (
    <div className="flex flex-col gap-4 px-7 pt-3 pb-10">
      {/* ── hero ───────────────────────────────────────────────────────── */}
      <header className="flex items-end justify-between gap-8">
        <div>
          <div className="flex items-center gap-2.5">
            <Label>Portfolio value</Label>
            <StaleBadge />
          </div>
          <div className="mt-1 flex items-baseline gap-3.5">
            <AnimatedMoney
              value={headerValue}
              className="font-medium text-[2.6rem] leading-none tracking-tight"
            />
            <Gain value={headerGain} pct={headerPct} className="text-base" />
          </div>
          <HoverDateCaption
            hover={hover}
            fallback={`${SLEEVES.length} sleeves · as of ${formatLongDate(ASOF)}`}
          />
        </div>
        <div className="hidden w-72 md:block">
          <SparkArea
            points={valueSpark}
            color="var(--primary)"
            size="md"
            label="Portfolio value"
          />
        </div>
      </header>

      {/* ── KPI row ────────────────────────────────────────────────────── */}
      <Card className="grid grid-cols-3 gap-0 divide-x overflow-hidden p-0">
        <Kpi
          label="Cost basis"
          value={formatMoney(totals.cost, { maximumFractionDigits: 0 })}
          sub={`${formatMoney(totals.cash, { maximumFractionDigits: 0 })} uninvested`}
          series={costSpark}
          color="var(--muted-foreground)"
        />
        <Kpi
          label="Unrealized"
          value={formatMoney(totals.gain, { maximumFractionDigits: 0 })}
          sub={`${totals.gainPct >= 0 ? "+" : ""}${totals.gainPct.toFixed(1)}% on cost`}
          series={gainSpark}
          color="var(--color-emerald-500)"
          tone="pos"
        />
        <Kpi
          label="Realized 2026"
          value={formatMoney(REALIZED[REALIZED.length - 1].gains, {
            maximumFractionDigits: 0,
          })}
          sub={`+${formatMoney(REALIZED[REALIZED.length - 1].dividends, { maximumFractionDigits: 0 })} dividends`}
          series={gainSpark}
          color="var(--color-emerald-500)"
          tone="pos"
        />
      </Card>

      {/* ── trend gets real height ─────────────────────────────────────── */}
      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex items-center justify-between px-4 pt-3 pb-2">
          <span className="font-medium text-muted-foreground text-xs tracking-wide">
            Market value vs cost basis
          </span>
          <div className="flex items-center gap-4">
            <ValueCostLegend />
            <span className="font-mono text-muted-foreground text-xs tabular-nums">
              {SERIES.length} months
            </span>
          </div>
        </div>
        <div className="px-4 pb-4">
          <ValueCostChart data={SERIES} height="h-64" onHover={setHover} />
        </div>
      </Card>

      {/* ── holdings left, advisory rail right ─────────────────────────── */}
      <div className="grid grid-cols-[1.55fr_1fr] items-start gap-4">
        <Card className="gap-0 overflow-hidden p-0">
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <span className="font-medium text-sm">Holdings</span>
            <span className="font-mono text-muted-foreground text-xs tabular-nums">
              {SLEEVES.reduce((a, s) => a + sleeveTotals(s).open.length, 0)}{" "}
              positions
            </span>
          </div>
          {SLEEVES.filter((s) => sleeveTotals(s).open.length > 0).map((s) => {
            const t = sleeveTotals(s)
            const isOpen = expanded === s.id
            const sorted = t.open.slice().sort((a, b) => b.value - a.value)
            const shown = isOpen ? sorted : sorted.slice(0, TOP_PER_SLEEVE)
            const hiddenCount = sorted.length - shown.length
            return (
              <section key={s.id} className="border-b last:border-b-0">
                <div className="flex items-center justify-between gap-3 px-4 pt-2.5 pb-1.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-[13px]">{s.label}</span>
                    <TaxChip tax={s.tax} />
                  </div>
                  <div className="flex items-center gap-4 font-mono text-xs tabular-nums">
                    <Money value={t.value} maximumFractionDigits={0} />
                    <Gain value={t.gain} pct={t.gainPct} className="text-xs" />
                  </div>
                </div>
                {shown.map((h) => {
                  const gain = h.value - h.cost
                  const pct = h.cost ? (gain / h.cost) * 100 : 0
                  const weight = (h.value / t.securitiesValue) * 100
                  return (
                    <div
                      key={h.ticker}
                      className="grid grid-cols-[minmax(0,1fr)_5.5rem_6.5rem_3.5rem] items-center gap-x-3 px-4 py-1 transition-colors hover:bg-accent/40"
                    >
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="font-medium font-mono text-[13px]">
                          {h.ticker}
                        </span>
                        <span className="truncate text-muted-foreground text-xs">
                          {h.name}
                        </span>
                      </div>
                      <Money
                        value={h.value}
                        className="text-right text-xs"
                        maximumFractionDigits={0}
                      />
                      <span className="text-right">
                        <Gain
                          value={gain}
                          pct={pct}
                          className="justify-end text-xs"
                        />
                      </span>
                      <Pct
                        value={weight}
                        signed={false}
                        className="text-right text-[11px] text-muted-foreground"
                      />
                    </div>
                  )
                })}
                {(hiddenCount > 0 || isOpen) && (
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : s.id)}
                    aria-expanded={isOpen}
                    className="w-full px-4 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {isOpen ? "Show fewer" : `Show ${hiddenCount} more`}
                  </button>
                )}
              </section>
            )
          })}
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between">
              <span className="font-medium text-sm">Allocation</span>
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
            {/* Stacked bar: compact, but colour carries identity for the small
                segments, so the legend below is load-bearing. */}
            <StackedShareBar rows={allocRows} />
          </Card>

          <Card className="flex flex-col gap-3.5 p-4">
            <span className="font-medium text-sm">2026 contribution room</span>
            {CONTRIBUTIONS.map((r) => (
              <ContributionMeter key={r.key} room={r} />
            ))}
          </Card>

          <Card className="flex flex-col gap-3 p-4">
            <div className="flex items-center justify-between">
              <span className="font-medium text-sm">Target drift</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                ±{DRIFT_THRESHOLD_PP}pp band
              </span>
            </div>
            {SLEEVES.filter((s) => s.targets).map((s) => {
              const t = sleeveTotals(s)
              const fires = (t.worstDrift ?? 0) > DRIFT_THRESHOLD_PP
              return (
                <div key={s.id} className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[13px]">{s.label}</span>
                    <DriftStatusLine totals={t} />
                  </div>
                  {fires && <DriftChart rows={driftRows(s)} />}
                </div>
              )
            })}
            {drifted.length === 0 && (
              <p className="text-[11px] text-muted-foreground">
                Every sleeve with a target policy is inside its band.
              </p>
            )}
          </Card>

          {(marginSleeve || idleCash.length > 0) && (
            <Card className="flex flex-col gap-3.5 p-4">
              <span className="font-medium text-sm">Cash</span>
              {idleCash.map((s) => (
                <div
                  key={s.id}
                  className="flex items-baseline justify-between gap-3"
                >
                  <span className="text-[13px]">{s.label}</span>
                  <Money
                    value={s.cash}
                    className="text-xs"
                    maximumFractionDigits={0}
                  />
                </div>
              ))}
              {marginSleeve?.marginFreeTranche && (
                <MarginMeter
                  drawn={marginSleeve.cash}
                  tranche={marginSleeve.marginFreeTranche}
                />
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

function Kpi({
  label,
  value,
  sub,
  series,
  color,
  tone,
}: {
  label: string
  value: string
  sub: string
  series: { date: string; value: number }[]
  color: string
  tone?: "pos"
}) {
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3.5">
      <Label>{label}</Label>
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={`font-medium font-mono text-2xl tracking-tight tabular-nums ${
            tone === "pos" ? "text-emerald-600 dark:text-emerald-400" : ""
          }`}
        >
          {value}
        </span>
      </div>
      <span className="text-[11px] text-muted-foreground">{sub}</span>
      <SparkArea points={series} color={color} size="sm" label={label} />
    </div>
  )
}
