"use client"

// PROTOTYPE variant 3 — "Advisor"
// Axis: interaction model. The page answers "is anything off?" before it
// answers "what do I own?". Everything that needs a decision is hoisted to the
// top as a resolved statement; holdings collapse to one row per sleeve and
// open on demand. No sibling in this app — this is the genuinely new direction.

import * as React from "react"

import { Money } from "@/components/primitives/money"
import { Card } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { formatLongDate, formatMoney } from "@/lib/format"
import { cn } from "@/lib/utils"

import {
  ASOF,
  byAssetClass,
  CONTRIBUTIONS,
  DRIFT_THRESHOLD_PP,
  driftRows,
  PRICE_ASOF,
  portfolioTotals,
  REALIZED,
  SERIES,
  SLEEVES,
  sleeveTotals,
  YEAR_ELAPSED,
} from "../mock"
import {
  ClosedDisclosure,
  ContributionMeter,
  DriftChart,
  Gain,
  HoldingRow,
  HoldingsHeader,
  Label,
  MarginMeter,
  Pct,
  RankedBars,
  TaxChip,
  ValueCostChart,
  ValueCostLegend,
} from "../shared"

interface Signal {
  id: string
  severity: "act" | "watch" | "ok"
  headline: string
  detail: string
}

function buildSignals(): Signal[] {
  const out: Signal[] = []

  for (const s of SLEEVES) {
    const t = sleeveTotals(s)
    if ((t.worstDrift ?? 0) > DRIFT_THRESHOLD_PP) {
      const rows = driftRows(s)
      const worst = rows.reduce(
        (a, r) => (Math.abs(r.drift) > Math.abs(a.drift) ? r : a),
        rows[0]
      )
      out.push({
        id: `drift-${s.id}`,
        severity: "act",
        headline: `${s.label} is ${Math.abs(worst.drift).toFixed(1)}pp ${worst.drift > 0 ? "over" : "under"} on ${worst.ticker}`,
        detail: `Past the ±${DRIFT_THRESHOLD_PP}pp band. Direct the next contributions to the underweight funds before selling anything.`,
      })
    }
  }

  const idle = SLEEVES.filter((s) => s.cash > 1000)
  for (const s of idle) {
    out.push({
      id: `cash-${s.id}`,
      severity: "watch",
      headline: `${formatMoney(s.cash, { maximumFractionDigits: 0 })} sitting uninvested in ${s.label}`,
      detail:
        s.tax === "hsa"
          ? "Fine if near-term medical costs are expected; otherwise it is out of the market."
          : "Not earning a market return where it is.",
    })
  }

  const staleDays = Math.round(
    (new Date(ASOF).getTime() - new Date(PRICE_ASOF).getTime()) / 86_400_000
  )
  if (staleDays > 7) {
    out.push({
      id: "stale",
      severity: "watch",
      headline: `Prices are ${staleDays} days old`,
      detail: `Every market value on this page is quoted at ${formatLongDate(PRICE_ASOF)}. Run the price updater to refresh.`,
    })
  }

  for (const r of CONTRIBUTIONS) {
    const pct = r.used / r.limit
    const ahead = pct >= YEAR_ELAPSED
    out.push({
      id: `contrib-${r.key}`,
      severity: ahead ? "ok" : "watch",
      headline: ahead
        ? `${r.label} on pace to max ${r.projectedFullBy}`
        : `${r.label} behind pace`,
      detail: `${formatMoney(r.used, { maximumFractionDigits: 0 })} of ${formatMoney(r.limit, { maximumFractionDigits: 0 })} at ${r.cadence}.`,
    })
  }

  const order = { act: 0, watch: 1, ok: 2 }
  return out.sort((a, b) => order[a.severity] - order[b.severity])
}

const SEVERITY: Record<
  Signal["severity"],
  { glyph: string; ring: string; text: string; word: string }
> = {
  act: {
    glyph: "▲",
    ring: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
    text: "text-rose-600 dark:text-rose-400",
    word: "Act",
  },
  watch: {
    glyph: "◆",
    ring: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    text: "text-amber-700 dark:text-amber-400",
    word: "Watch",
  },
  ok: {
    glyph: "●",
    ring: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    text: "text-emerald-600 dark:text-emerald-400",
    word: "On track",
  },
}

export function AdvisorVariant() {
  const totals = portfolioTotals()
  const signals = buildSignals()
  const [open, setOpen] = React.useState<string | null>(null)

  const acts = signals.filter((s) => s.severity === "act").length
  const watches = signals.filter((s) => s.severity === "watch").length

  const topWeight = Math.max(
    ...SLEEVES.flatMap((s) =>
      sleeveTotals(s).open.map((h) => (h.value / totals.securitiesValue) * 100)
    )
  )

  return (
    <div className="flex flex-col gap-4 px-7 pt-3 pb-10">
      {/* ── header: value is present but not the point ──────────────────── */}
      <header className="flex items-end justify-between gap-8">
        <div>
          <h1 className="font-medium text-xl tracking-tight">Portfolio</h1>
          <p className="mt-1 text-muted-foreground text-sm">
            {acts > 0 ? (
              <>
                <span className="font-medium text-rose-600 dark:text-rose-400">
                  {acts} thing{acts === 1 ? "" : "s"} to act on
                </span>
                {watches > 0 && <>, {watches} to watch</>}
              </>
            ) : (
              <>Nothing needs a decision today</>
            )}
            <span className="text-muted-foreground/70">
              {" "}
              · as of {formatLongDate(ASOF)}
            </span>
          </p>
        </div>
        <div className="flex items-end gap-7 text-right">
          <div className="flex flex-col gap-0.5">
            <Label>Unrealized</Label>
            <Gain
              value={totals.gain}
              pct={totals.gainPct}
              className="justify-end text-base"
            />
          </div>
          <div className="flex flex-col gap-0.5">
            <Label>Market value</Label>
            <Money
              value={totals.value}
              className="text-2xl tracking-tight"
              maximumFractionDigits={0}
            />
          </div>
        </div>
      </header>

      {/* ── signals lead ───────────────────────────────────────────────── */}
      <Card className="gap-0 divide-y overflow-hidden p-0">
        {signals.map((s) => {
          const sev = SEVERITY[s.severity]
          return (
            <div key={s.id} className="flex items-start gap-3 px-4 py-3">
              <span
                aria-hidden
                className={cn(
                  "mt-px flex size-5 shrink-0 items-center justify-center rounded-full text-[10px]",
                  sev.ring
                )}
              >
                {sev.glyph}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium text-[13px]">{s.headline}</span>
                  <span
                    className={cn(
                      "text-[10px] uppercase tracking-[0.06em]",
                      sev.text
                    )}
                  >
                    {sev.word}
                  </span>
                </div>
                <p className="mt-0.5 text-muted-foreground text-xs">
                  {s.detail}
                </p>
              </div>
            </div>
          )
        })}
      </Card>

      {/* ── the two policies, side by side ─────────────────────────────── */}
      <div className="grid grid-cols-2 items-start gap-4">
        <Card className="flex flex-col gap-4 p-4">
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">
              Contribution room · 2026
            </span>
            <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
              {(YEAR_ELAPSED * 100).toFixed(0)}% of year gone
            </span>
          </div>
          {CONTRIBUTIONS.map((r) => (
            <ContributionMeter key={r.key} room={r} />
          ))}
        </Card>

        <Card className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm">Target policy</span>
            <span className="font-mono text-[11px] text-muted-foreground">
              ±{DRIFT_THRESHOLD_PP}pp band
            </span>
          </div>
          {SLEEVES.filter((s) => s.targets).map((s) => {
            const t = sleeveTotals(s)
            const fires = (t.worstDrift ?? 0) > DRIFT_THRESHOLD_PP
            return (
              <div key={s.id} className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <span className="text-[13px]">{s.label}</span>
                  <span
                    className={cn(
                      "font-mono text-[11px] tabular-nums",
                      fires
                        ? "text-rose-600 dark:text-rose-400"
                        : "text-muted-foreground"
                    )}
                  >
                    worst {(t.worstDrift ?? 0).toFixed(1)}pp
                  </span>
                </div>
                {fires ? (
                  <DriftChart rows={driftRows(s)} />
                ) : (
                  // Inside the band: a row of target-vs-actual pairs reads
                  // faster than five bars sitting on zero.
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {driftRows(s).map((r) => (
                      <span
                        key={r.ticker}
                        className="font-mono text-[11px] text-muted-foreground tabular-nums"
                      >
                        {r.ticker}{" "}
                        <span className="text-foreground">
                          {r.actual.toFixed(0)}%
                        </span>
                        <span className="text-muted-foreground/60">
                          /{r.target}%
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </Card>
      </div>

      {/* ── allocation as ranked rows, class-first ─────────────────────── */}
      <div className="grid grid-cols-[1fr_1fr] items-start gap-4">
        <Card className="flex flex-col gap-2 p-4">
          <span className="font-medium text-sm">Where the money is</span>
          <RankedBars rows={byAssetClass()} />
        </Card>
        <Card className="gap-0 overflow-hidden p-0">
          <div className="flex items-center justify-between px-4 pt-3 pb-1">
            <span className="font-medium text-sm">Value vs cost</span>
            <ValueCostLegend />
          </div>
          <div className="px-2 pb-2">
            <ValueCostChart data={SERIES} height="h-40" />
          </div>
        </Card>
      </div>

      {/* ── holdings: one row per sleeve, expand on demand ─────────────── */}
      <Card className="gap-0 divide-y overflow-hidden p-0">
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="font-medium text-sm">Holdings by sleeve</span>
          <span className="font-mono text-muted-foreground text-xs tabular-nums">
            {SLEEVES.reduce((a, s) => a + sleeveTotals(s).open.length, 0)}{" "}
            positions
          </span>
        </div>
        {SLEEVES.map((s) => {
          const t = sleeveTotals(s)
          const isOpen = open === s.id
          const empty = t.open.length === 0
          return (
            <section key={s.id}>
              <button
                type="button"
                onClick={() => !empty && setOpen(isOpen ? null : s.id)}
                aria-expanded={empty ? undefined : isOpen}
                disabled={empty}
                className={cn(
                  "grid w-full grid-cols-[minmax(0,1fr)_7rem_8rem_5rem] items-center gap-x-3 px-4 py-2.5 text-left transition-colors",
                  empty ? "cursor-default" : "hover:bg-accent/40"
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  {!empty && (
                    <span
                      aria-hidden
                      className="font-mono text-[11px] text-muted-foreground"
                    >
                      {isOpen ? "−" : "+"}
                    </span>
                  )}
                  <span
                    className={cn(
                      "text-[13px]",
                      empty && "text-muted-foreground"
                    )}
                  >
                    {s.label}
                  </span>
                  <TaxChip tax={s.tax} />
                  {empty && (
                    <span className="text-[11px] text-muted-foreground">
                      closed · {t.closed.length} former position
                      {t.closed.length === 1 ? "" : "s"}
                    </span>
                  )}
                  {s.cash !== 0 && (
                    <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                      cash <Money value={s.cash} maximumFractionDigits={0} />
                    </span>
                  )}
                </div>
                <Money
                  value={t.value}
                  className="text-right text-[13px]"
                  maximumFractionDigits={0}
                />
                <span className="text-right">
                  <Gain
                    value={t.gain}
                    pct={t.gainPct}
                    className="justify-end text-xs"
                  />
                </span>
                <Pct
                  value={totals.value ? (t.value / totals.value) * 100 : 0}
                  signed={false}
                  className="text-right text-[11px] text-muted-foreground"
                />
              </button>
              {isOpen && (
                <div className="bg-muted/25">
                  <HoldingsHeader dense />
                  {t.open
                    .slice()
                    .sort((a, b) => b.value - a.value)
                    .map((h) => (
                      <HoldingRow
                        key={h.ticker}
                        h={h}
                        weight={(h.value / totals.securitiesValue) * 100}
                        topWeight={topWeight}
                        dense
                      />
                    ))}
                  {s.marginFreeTranche && s.cash < 0 && (
                    <div className="border-t px-4 py-2.5">
                      <MarginMeter
                        drawn={s.cash}
                        tranche={s.marginFreeTranche}
                      />
                    </div>
                  )}
                  <ClosedDisclosure closed={t.closed} />
                </div>
              )}
            </section>
          )
        })}
      </Card>

      {/* ── realized, quietly at the bottom ───────────────────────────── */}
      {/* Card is flex-col by default — flex-row has to be stated or the years
          stack and items-center reads as a centring bug. */}
      <Card className="flex flex-row items-center gap-6 p-4">
        <span className="font-medium text-sm">Realized</span>
        <Separator orientation="vertical" className="h-8" />
        {REALIZED.map((r) => (
          <div key={r.year} className="flex flex-col gap-0.5">
            <Label>{r.year}</Label>
            <span className="flex items-baseline gap-2">
              <Money
                value={r.gains}
                tone="pos"
                className="text-[13px]"
                maximumFractionDigits={0}
              />
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                +{formatMoney(r.dividends, { maximumFractionDigits: 0 })} div
              </span>
            </span>
          </div>
        ))}
      </Card>
    </div>
  )
}
