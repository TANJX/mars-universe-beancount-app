"use client"

// What the ledger says today: net worth by bucket, trailing-12-month cleared
// income and spending, and two savings rates side by side. The trailing rate
// is history (one-offs included); the forward rate is what the projection
// actually uses, computed from the plan's salary and spending inputs.

import { activePeople, grossFor, wagesFor } from "@/lib/fire/engine"
import type { Inputs, Snapshot } from "@/lib/fire/types"

import { pct, SectionCard, usd } from "./controls"

const BUCKET_LABELS: Record<string, string> = {
  cash: "Cash (checking + savings)",
  taxable: "Taxable brokerage + crypto",
  roth: "Roth IRA",
  traditional: "Traditional IRA",
  "401k": "401k (pre-tax)",
  "roth-401k": "Roth 401k",
  hsa: "HSA",
  otherAssets: "Receivables, gift cards, other",
  cardDebt: "Card balances",
  loans: "Loans",
  otherLiabilities: "Other payables",
}

const ORDER = Object.keys(BUCKET_LABELS)

export function GroundTruth({
  snapshot,
  inputs,
}: {
  snapshot: Snapshot
  inputs: Inputs
}) {
  const buckets = ORDER.filter((k) => snapshot.buckets[k]).map((k) => ({
    key: k,
    label: BUCKET_LABELS[k],
    value: snapshot.buckets[k],
  }))
  const nw = buckets.reduce((a, b) => a + b.value, 0)
  const retirement = ["roth", "traditional", "401k", "roth-401k", "hsa"].reduce(
    (a, k) => a + (snapshot.buckets[k] ?? 0),
    0
  )

  const income = snapshot.income.reduce((a, r) => a + r.amount, 0)
  const spend = snapshot.expenses.reduce((a, r) => a + r.amount, 0)
  const maxSpend = Math.max(1, ...snapshot.expenses.map((e) => e.amount))

  const primary = activePeople(inputs)[0]
  const year = Number(snapshot.asof.slice(0, 4))
  const tax = primary
    ? wagesFor(inputs, year).taxes.find((t) => t.personId === primary.id)
    : undefined
  const fwdTakeHome = primary && tax ? tax.takeHome + primary.otherIncome : 0
  const s = primary?.spending
  const fwdSpend = s ? s.housing + s.car + s.discretionary + s.essentials : 0
  const gross = primary ? grossFor(inputs, primary, year) : 0

  return (
    <SectionCard
      title="Ground truth (live ledger)"
      hint={`As of ${snapshot.asof}. Trailing 12 months, cleared entries only.`}
    >
      <div className="grid grid-cols-1 gap-5 @2xl:grid-cols-2">
        <div className="flex flex-col gap-1.5 text-xs">
          <div className="flex justify-between font-medium">
            <span>Net worth</span>
            <span className="font-mono tabular-nums">{usd(nw)}</span>
          </div>
          {buckets.map((b) => (
            <div
              key={b.key}
              className="flex justify-between text-muted-foreground"
            >
              <span>{b.label}</span>
              <span className="font-mono tabular-nums">{usd(b.value)}</span>
            </div>
          ))}
          <div className="mt-1 flex justify-between border-t pt-1.5">
            <span>Retirement accounts</span>
            <span className="font-mono tabular-nums">{usd(retirement)}</span>
          </div>
          <p className="text-muted-foreground">
            Illiquid equity (options, private shares) is not in net worth. Add
            it as an ISO liquidity event below.
          </p>
        </div>

        <div className="flex flex-col gap-1.5 text-xs">
          <div className="flex justify-between font-medium">
            <span>Spending, last 12 months</span>
            <span className="font-mono tabular-nums">{usd(spend)}</span>
          </div>
          {snapshot.expenses.slice(0, 9).map((e) => (
            <div
              key={e.category}
              className="grid grid-cols-[7rem_1fr_4.5rem] items-center gap-2"
            >
              <span className="truncate text-muted-foreground">
                {e.category}
              </span>
              <span className="h-1.5 rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-primary/60"
                  style={{ width: `${(e.amount / maxSpend) * 100}%` }}
                />
              </span>
              <span className="text-right font-mono tabular-nums">
                {usd(e.amount)}
              </span>
            </div>
          ))}
          <div className="mt-1 grid grid-cols-3 gap-2 border-t pt-1.5">
            <Rate
              label="Trailing rate"
              value={income ? (income - spend) / income : 0}
              sub={`${usd(income - spend)} of ${usd(income)} booked`}
            />
            <Rate
              label="Forward, take-home"
              value={fwdTakeHome ? (fwdTakeHome - fwdSpend) / fwdTakeHome : 0}
              sub={`${usd(fwdTakeHome - fwdSpend)} / yr`}
            />
            <Rate
              label="Forward, gross"
              value={gross ? (fwdTakeHome - fwdSpend) / gross : 0}
              sub={`on ${usd(gross)}`}
            />
          </div>
        </div>
      </div>
    </SectionCard>
  )
}

function Rate({
  label,
  value,
  sub,
}: {
  label: string
  value: number
  sub: string
}) {
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-sm tabular-nums">{pct(value, 0)}</span>
      <span className="text-[10.5px] text-muted-foreground">{sub}</span>
    </div>
  )
}
