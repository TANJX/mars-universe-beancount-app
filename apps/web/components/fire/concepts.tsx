"use client"

// The concepts layer: each FIRE idea in two or three sentences, worked with the
// live numbers from the current plan rather than a textbook example.

import type { MonteCarlo } from "@/lib/fire/engine"
import type { Inputs, SimResult } from "@/lib/fire/types"

import { pct, SectionCard, usd } from "./controls"

export interface ConceptExtras {
  tierYears: { lean: number | null; base: number | null; fat: number | null }
  tierSpend: { lean: number; base: number; fat: number }
  baristaYear: number | null
  baristaIncome: number
  saferSuccess: number | null
  saferSwr: number
}

export function ConceptsPanel({
  inputs,
  result,
  mc,
  extras,
}: {
  inputs: Inputs
  result: SimResult
  mc: MonteCarlo | null
  extras: ConceptExtras
}) {
  const a = inputs.assumptions
  const primary = inputs.people[0]
  const multiple = 1 / a.swr
  const kidPV = result.targetToday - result.retirementSpend / a.swr
  const fiAge =
    result.fiYear && primary ? result.fiYear - primary.birthYear : null
  const bridge = fiAge !== null ? Math.max(0, 59.5 - fiAge) : null
  const coastRow = result.rows.find((r) => r.year === result.coastYear)
  const yr = (y: number | null) => (y ? `${y}` : "not reached")

  const cards: { title: string; body: React.ReactNode }[] = [
    {
      title: "The FI number",
      body: (
        <>
          Financial independence is when invested assets can fund spending
          forever. At a {pct(a.swr, 1)} withdrawal rate that is{" "}
          {multiple.toFixed(1)}x annual spend: {usd(result.retirementSpend)} ×{" "}
          {multiple.toFixed(1)} = <b>{usd(result.retirementSpend / a.swr)}</b>
          {kidPV > 1000 ? (
            <>
              , plus {usd(kidPV)} for kid costs still ahead, so{" "}
              <b>{usd(result.targetToday)}</b> today
            </>
          ) : null}
          . Every $1,000/yr of permanent spend moves the target by{" "}
          {usd(1000 * multiple)}.
        </>
      ),
    },
    {
      title: "Withdrawal rate",
      body: (
        <>
          The 4% rule comes from 30-year US retirements. A{" "}
          {inputs.endAge - (fiAge ?? 50)}-year horizon needs a lower rate, which
          is why the plan uses {pct(a.swr, 1)}. In the Monte Carlo, retiring the
          moment the line is crossed survives to age {inputs.endAge} in{" "}
          <b>{mc ? pct(mc.successRate, 0) : "…"}</b> of paths
          {extras.saferSuccess !== null ? (
            <>
              ; at {pct(extras.saferSwr, 1)} it is{" "}
              <b>{pct(extras.saferSuccess, 0)}</b>
            </>
          ) : null}
          .
        </>
      ),
    },
    {
      title: "Lean, base, fat",
      body: (
        <>
          The same plan at three retirement lifestyles: lean{" "}
          {usd(extras.tierSpend.lean)} reaches FI in{" "}
          <b>{yr(extras.tierYears.lean)}</b>, base {usd(extras.tierSpend.base)}{" "}
          in <b>{yr(extras.tierYears.base)}</b>, fat {usd(extras.tierSpend.fat)}{" "}
          in <b>{yr(extras.tierYears.fat)}</b>. The tier is the single biggest
          choice in the plan.
        </>
      ),
    },
    {
      title: "Coast FIRE",
      body: (
        <>
          Coast is the point where you could stop saving and growth alone
          reaches the FI number by your full retirement age ({a.coastAge}). In
          this plan that is <b>{yr(result.coastYear)}</b>
          {coastRow ? <> at about {usd(coastRow.portfolio)}</> : null}. After
          coast, work only has to cover current spending, which is what makes a
          lower-paid or part-time chapter safe.
        </>
      ),
    },
    {
      title: "Barista FIRE",
      body: (
        <>
          If side income (a studio, freelance, part-time) reliably covers{" "}
          {usd(extras.baristaIncome)}/yr, the portfolio only funds the rest:{" "}
          {usd(result.retirementSpend - extras.baristaIncome)} / {pct(a.swr, 1)}{" "}
          = {usd((result.retirementSpend - extras.baristaIncome) / a.swr)}.
          Reached in <b>{yr(extras.baristaYear)}</b> on this plan.
        </>
      ),
    },
    {
      title: "Sequence risk",
      body: (
        <>
          A crash in the first five years of retirement hurts far more than one
          at the end, because withdrawals lock in the losses. Defences: a cash
          bucket of 1 to 2 years of spend, a spending floor you can drop to in
          bad years, and a bond glide path in the decade before FI. Try the
          crash event a year after FI to see it.
        </>
      ),
    },
    {
      title: "Getting money out before 59½",
      body: (
        <>
          {bridge !== null ? (
            <>
              FI at {fiAge} leaves about <b>{Math.ceil(bridge)} years</b> before
              penalty-free retirement withdrawals.{" "}
            </>
          ) : null}
          Taxable savings and Roth contributions cover the first years; a Roth
          conversion ladder (convert pre-tax money each year, withdraw it 5
          years later) covers the rest. Plan for about 5 ×{" "}
          {usd(result.retirementSpend)} = {usd(5 * result.retirementSpend)}{" "}
          outside pre-tax accounts at FI.
        </>
      ),
    },
    {
      title: "Reading the Monte Carlo",
      body: (
        <>
          {mc ? (
            <>
              {mc.paths} random return paths (mean {pct(a.realReturn, 1)},
              volatility {pct(a.returnVolatility, 0)}). FI year: optimistic 10th
              percentile <b>{yr(mc.fiYear.p10)}</b>, median{" "}
              <b>{yr(mc.fiYear.p50)}</b>, pessimistic 90th{" "}
              <b>{yr(mc.fiYear.p90)}</b>. The shaded band on the chart is the
              10th to 90th percentile portfolio.
            </>
          ) : (
            "Running…"
          )}
        </>
      ),
    },
  ]

  return (
    <SectionCard
      title="Concepts, with your numbers"
      hint="Updates live as you change the plan."
    >
      <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @4xl:grid-cols-4">
        {cards.map((c) => (
          <div
            key={c.title}
            className="flex flex-col gap-1 rounded-lg bg-muted/40 p-3 text-xs leading-relaxed"
          >
            <span className="font-medium text-[13px]">{c.title}</span>
            <span className="text-muted-foreground [&_b]:font-medium [&_b]:text-foreground">
              {c.body}
            </span>
          </div>
        ))}
      </div>
    </SectionCard>
  )
}
