"use client"

// Assumptions (returns, SWR, full retirement age, growth) and the "what moves
// the date" list: each preset is re-simulated against the
// current plan and ranked by years gained.

import type { LeverImpact } from "@/lib/fire/engine"
import type { Inputs } from "@/lib/fire/types"
import { cn } from "@/lib/utils"

import { pct, SectionCard, SliderRow } from "./controls"

export function AssumptionsPanel({
  inputs,
  onChange,
}: {
  inputs: Inputs
  onChange: (next: Inputs) => void
}) {
  const a = inputs.assumptions
  const setA = (patch: Partial<Inputs["assumptions"]>) =>
    onChange({ ...inputs, assumptions: { ...a, ...patch } })

  return (
    <SectionCard
      title="Assumptions"
      hint="All rates are real (after inflation)."
    >
      <div className="grid grid-cols-1 gap-x-6 gap-y-4 @md:grid-cols-2">
        <SliderRow
          label="Real return"
          value={a.realReturn}
          min={0.02}
          max={0.08}
          step={0.0025}
          format={(v) => pct(v, 2)}
          onChange={(v) => setA({ realReturn: v })}
          info="Return after inflation, roughly nominal minus inflation (7% nominal with 2% inflation is about 5% real). Sets how fast the portfolio grows and is the Monte Carlo mean. Long-run all-stock portfolios: about 5% (global) to 7% (US historical)."
        />
        <SliderRow
          label="Safe withdrawal rate"
          value={a.swr}
          min={0.025}
          max={0.05}
          step={0.0025}
          format={(v) => `${pct(v, 2)} · ${(1 / v).toFixed(1)}x`}
          onChange={(v) => setA({ swr: v })}
          info="Share of the portfolio withdrawn in the first retirement year, then raised with inflation; the FI target is retirement spend / SWR (the x multiple is 1 / SWR). It sits below the real return as a margin for volatility and sequence risk: 4% was built for 30-year retirements, and longer ones use about 3 to 3.5%. It does not follow the real return slider, so lower it yourself if you assume lower returns."
        />
        <SliderRow
          label="Return volatility (Monte Carlo)"
          value={a.returnVolatility}
          min={0.06}
          max={0.22}
          step={0.01}
          format={(v) => pct(v, 0)}
          onChange={(v) => setA({ returnVolatility: v })}
          info="Yearly standard deviation of real returns, used only by the Monte Carlo; the solid line ignores it. About 16% for all-equity, about 10% for 60/40. Higher widens the band and lowers the Lasts survival rate."
          hint="About 16% for all-equity; about 10% for 60/40."
        />
        <SliderRow
          label="Full retirement age"
          value={a.coastAge}
          min={45}
          max={67}
          step={1}
          format={(v) => `${v}`}
          onChange={(v) => setA({ coastAge: v })}
          info="Age when all work stops and full withdrawals begin on the Coast and Barista paths (earlier if the portfolio reaches the full FI target first, e.g. an ISO payout). The dotted coast line is what grows to the FI target by this age with no further saving. No effect on the Normal path's FI year."
        />
        <SliderRow
          label="Real raises after last step"
          value={a.realRaiseGrowth}
          min={0}
          max={0.04}
          step={0.0025}
          format={(v) => pct(v, 2)}
          onChange={(v) => setA({ realRaiseGrowth: v })}
          info="Yearly real pay growth applied after each person's last salary step or salary event."
        />
      </div>
    </SectionCard>
  )
}

export function ImpactPanel({
  impacts,
  fiYear,
  label,
  compact = false,
}: {
  impacts: LeverImpact[]
  fiYear: number | null
  /** What the year means on the current path ("FI year", "Coast from"). */
  label: string
  /** Pinned under the chart: two columns, no footnote. */
  compact?: boolean
}) {
  const sorted = [...impacts].sort(
    (x, y) => (y.years ?? -99) - (x.years ?? -99)
  )
  const max = Math.max(1, ...sorted.map((i) => Math.abs(i.years ?? 0)))
  return (
    <SectionCard
      title="What moves the date"
      hint={
        fiYear
          ? `Each change applied alone to the current plan (${label} ${fiYear}).`
          : `No ${label} year in the current plan.`
      }
    >
      <div
        className={cn(
          "grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs",
          compact && "@xl:grid-cols-2"
        )}
      >
        {sorted.map((i) => {
          const y = i.years ?? 0
          return (
            <div
              key={i.id}
              className="grid grid-cols-[9.5rem_1fr_4rem] items-center gap-2"
              title={i.detail}
            >
              <span className="truncate">{i.label}</span>
              <span className="relative h-2">
                <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
                <span
                  className={cn(
                    "absolute inset-y-0 rounded-sm",
                    y >= 0
                      ? "left-1/2 bg-emerald-500/70"
                      : "right-1/2 bg-rose-500/70"
                  )}
                  style={{ width: `${(Math.abs(y) / max) * 50}%` }}
                />
              </span>
              <span className="text-right font-mono tabular-nums">
                {i.years === null
                  ? "n/a"
                  : y === 0
                    ? "±0"
                    : `${y > 0 ? "−" : "+"}${Math.abs(y)} yr`}
              </span>
            </div>
          )
        })}
        {compact ? null : (
          <p className="mt-1 text-muted-foreground">
            Green pulls the date earlier, red pushes it later. Annual steps, so
            changes under a year show as ±0.
          </p>
        )}
      </div>
    </SectionCard>
  )
}
