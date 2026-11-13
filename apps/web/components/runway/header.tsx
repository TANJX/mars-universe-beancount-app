"use client"

// Page header (title, person and scenario switches), the four headline
// numbers, and the secondary strip under the chart.

import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Flame,
  Lock,
} from "lucide-react"
import Link from "next/link"

import { pct, Segmented, Stat, usd } from "@/components/fire/controls"
import { buttonVariants } from "@/components/ui/button"
import type {
  PersonStatus,
  RunwayInputs,
  RunwayResult,
} from "@/lib/runway/types"
import { cn } from "@/lib/utils"

import { monthLabel, monthRange } from "./chart-utils"

export interface PersonOption {
  id: string
  name: string
  status: PersonStatus
  /** Has unsaved edits. */
  dirty?: boolean
}

export function RunwayHeader({
  people,
  personId,
  onPersonChange,
  scenarioBar,
  periodLabel,
  children,
}: {
  people: PersonOption[]
  personId: string
  onPersonChange: (id: string) => void
  /** The scenario switch and actions (scenario-bar.tsx). */
  scenarioBar?: React.ReactNode
  periodLabel: string
  /** Headline numbers, laid out to the right on wide screens. */
  children?: React.ReactNode
}) {
  const personLabel = (p: PersonOption) => (
    <span className="inline-flex items-center gap-1">
      {p.name}
      {p.dirty ? (
        <span
          className="size-1.5 rounded-full bg-primary"
          role="img"
          aria-label="unsaved changes"
        />
      ) : null}
      {p.status === "locked" ? (
        <Lock size={11} className="text-muted-foreground" aria-label="locked" />
      ) : p.status !== "ok" ? (
        <AlertCircle
          size={11}
          className="text-muted-foreground"
          aria-label="unavailable"
        />
      ) : null}
    </span>
  )
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="flex w-full min-w-0 flex-col gap-1.5 md:w-auto">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
          <h1 className="font-medium text-xl tracking-tight max-md:order-first">
            Runway
          </h1>
          {people.length > 1 ? (
            people.length <= 4 ? (
              <Segmented<string>
                ariaLabel="Person"
                value={personId}
                onChange={onPersonChange}
                options={people.map((p) => ({
                  value: p.id,
                  label: personLabel(p),
                }))}
                className="h-9 w-full md:h-7 md:w-auto"
                optionClassName="flex-1 md:flex-none"
              />
            ) : (
              <select
                aria-label="Person"
                value={personId}
                onChange={(e) => onPersonChange(e.target.value)}
                className="h-9 rounded-lg border border-input bg-transparent px-2 text-base md:h-7 md:text-xs"
              >
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.status === "ok" ? "" : ` (${p.status})`}
                  </option>
                ))}
              </select>
            )
          ) : null}
          {scenarioBar}
          {/* Phones: the buttons share the title's row (order) instead of
              taking a row of their own under the full-width switches. */}
          <span className="max-md:-mr-2 inline-flex items-center max-md:order-first max-md:ml-auto">
            <Link
              href="/fire"
              className={buttonVariants({ variant: "ghost", size: "xs" })}
            >
              <Flame /> Long run (FIRE)
            </Link>
          </span>
        </div>
        <p className="text-muted-foreground text-xs">
          {periodLabel}. Monthly figures, nominal dollars.
        </p>
      </div>
      {children}
    </header>
  )
}

export function RunwayKpis({
  result,
  inputs,
  endLabel,
}: {
  result: RunwayResult
  inputs: RunwayInputs
  endLabel: string
}) {
  const last = result.rows.at(-1)
  if (!last) return null
  const cap = inputs.person.playCap
  const over = last.playShare > cap
  return (
    <div className="grid w-full grid-cols-2 gap-x-6 gap-y-3 md:flex md:w-auto md:flex-wrap md:items-end">
      <Stat
        label="Cash-like left"
        value={usd(last.cash)}
        sub="checking + emergency + reserve"
      />
      <Stat
        label="Play share"
        value={pct(last.playShare, 1)}
        sub={
          <span className="inline-flex items-center gap-1">
            {over ? (
              <AlertTriangle
                size={11}
                className="text-amber-600 dark:text-amber-400"
              />
            ) : (
              <CheckCircle2 size={11} />
            )}
            {over ? "over" : "under"} cap {pct(cap, 0)} · {usd(last.play)}
          </span>
        }
      />
      <Stat
        label="Emergency fund"
        value={
          result.unfundedMonths.length > 0 ? (
            <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
              <AlertTriangle size={14} />
              {usd(result.unfundedPeak)} unfunded
            </span>
          ) : result.efDrawn > 0 ? (
            <span className="inline-flex items-center gap-1 text-rose-600 dark:text-rose-400">
              <AlertTriangle size={14} />
              {usd(result.efDrawn)} drawn
            </span>
          ) : (
            "Untouched"
          )
        }
        sub={
          result.unfundedMonths.length > 0 ? (
            <span className="text-rose-600 dark:text-rose-400">
              all empty, checking negative {monthRange(result.unfundedMonths)}
              {result.coreDrawn > 0
                ? ` · ${usd(result.coreDrawn)} sold from core`
                : ""}
            </span>
          ) : result.efDrawn > 0 && result.efDrawnMonth ? (
            `reserve ran dry in ${monthLabel(result.efDrawnMonth)}${
              result.coreDrawn > 0
                ? ` · ${usd(result.coreDrawn)} sold from core`
                : ""
            }`
          ) : (
            `kept at ${usd(inputs.person.cash.efMonths * inputs.person.spendingMonthly)}`
          )
        }
      />
      <Stat
        label={`Net worth ${endLabel}`}
        className="md:text-right"
        value={<span className="text-2xl">{usd(last.netWorth)}</span>}
        sub={`from ${usd(result.startNetWorth)} today`}
      />
    </div>
  )
}

export function RunwayKpiStrip({
  result,
  inputs,
  className,
}: {
  result: RunwayResult
  inputs: RunwayInputs
  className?: string
}) {
  const last = result.rows.at(-1)
  if (!last) return null
  const iraDeposits = result.rows.filter((r) => r.iraOut > 0).length
  const item = (label: string, value: number, sub: string) => (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-muted-foreground text-xs">{label}</span>
      <span className="font-mono text-sm tabular-nums">{usd(value)}</span>
      <span className="text-muted-foreground text-xs">{sub}</span>
    </div>
  )
  return (
    <div
      className={cn(
        "grid grid-cols-2 gap-x-6 gap-y-3 rounded-xl border bg-card px-4 py-3 md:grid-cols-4",
        className
      )}
    >
      {item(
        "401k",
        last.k401,
        `${usd(result.k401Contributed)} in + ${usd(result.matchTotal)} match`
      )}
      {item(
        "Core index",
        last.core,
        `${usd(result.movedToCore)} moved over ${Math.max(1, Math.round(inputs.person.cash.dcaMonths))} mo`
      )}
      {item(
        "IRA",
        last.ira,
        `${iraDeposits} ${iraDeposits === 1 ? "deposit" : "deposits"}`
      )}
      {item(
        "Shortfall covered",
        result.shortfallTotal,
        `${result.shortMonths} of ${result.rows.length} months short`
      )}
    </div>
  )
}
