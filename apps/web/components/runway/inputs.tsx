"use client"

// The inputs pane: the jobs editor (passed in), contributions, spending and
// cash, and returns. Every edit goes to the active target (the plan or a
// scenario). A dot beside a label marks a value that differs from what is
// saved; a "Plan:" or "Shared:" note marks one that overrides the next level
// down (see fields.tsx).

import * as React from "react"

import {
  NumberField,
  pct,
  Segmented,
  SliderRow,
  usd,
} from "@/components/fire/controls"
import type {
  RunwayInputs,
  RunwayPerson,
  RunwayResult,
  SpreadThrough,
} from "@/lib/runway/types"

import { monthLabel } from "./chart-utils"
import { ContributionsSection } from "./contributions"
import { type Fallback, FIELD, Field, InputsSection, Markers } from "./fields"

/** The override marker for a value at a dotted body path, or null. */
export type FallbackFor = (
  path: string,
  format: (v: unknown) => string
) => Fallback | null

const money = (v: unknown) => (typeof v === "number" ? usd(v) : "none")
const rate = (v: unknown) => (typeof v === "number" ? pct(v, 1) : "none")

export function RunwayInputsPanel({
  inputs,
  config,
  result,
  jobs,
  fallbackFor,
  onChange,
}: {
  inputs: RunwayInputs
  /** The saved version of the same plan (for the unsaved dots). */
  config: RunwayInputs
  /** The active run, for progress against each limit. */
  result: RunwayResult
  /** The jobs editor card. */
  jobs: React.ReactNode
  fallbackFor: FallbackFor
  onChange: (next: RunwayInputs) => void
}) {
  const p = inputs.person
  const c = config.person
  const uid = React.useId()
  const fid = (k: string) => `${uid}-${k}`
  const setP = (patch: Partial<RunwayPerson>) =>
    onChange({ ...inputs, person: { ...p, ...patch } })
  const setCash = (patch: Partial<RunwayPerson["cash"]>) =>
    setP({ cash: { ...p.cash, ...patch } })
  const setReturns = (patch: Partial<RunwayPerson["returns"]>) =>
    setP({ returns: { ...p.returns, ...patch } })
  const efTarget = p.cash.efMonths * p.spendingMonthly

  return (
    <div className="flex flex-col gap-4">
      {jobs}

      <ContributionsSection
        inputs={inputs}
        config={config}
        result={result}
        onChange={onChange}
      />

      <InputsSection
        title="Spending and cash"
        hint="What goes out each month, one-off bills, and how much cash stays liquid."
        summary={`${usd(p.spendingMonthly)}/mo · ${p.cash.efMonths} mo EF · ${usd(p.cash.buffer)} buffer`}
      >
        <Field
          id={fid("spend")}
          label="Monthly spending"
          edited={p.spendingMonthly !== c.spendingMonthly}
          onReset={() => setP({ spendingMonthly: c.spendingMonthly })}
          fallback={fallbackFor("spendingMonthly", money)}
        >
          <NumberField
            id={fid("spend")}
            ariaLabel="Monthly spending"
            prefix="$"
            suffix="/mo"
            className={FIELD}
            value={p.spendingMonthly}
            onChange={(v) => setP({ spendingMonthly: Math.max(0, v) })}
          />
        </Field>
        <Field
          id={fid("buffer")}
          label="Checking buffer"
          edited={p.cash.buffer !== c.cash.buffer}
          onReset={() => setCash({ buffer: c.cash.buffer })}
          fallback={fallbackFor("cash.buffer", money)}
        >
          <NumberField
            id={fid("buffer")}
            ariaLabel="Checking buffer"
            prefix="$"
            className={FIELD}
            value={p.cash.buffer}
            onChange={(v) => setCash({ buffer: Math.max(0, v) })}
          />
        </Field>
        <div className="flex flex-col gap-1 @md:col-span-2">
          <SliderRow
            label="Emergency fund"
            value={p.cash.efMonths}
            min={0}
            max={12}
            step={1}
            format={(v) => `${v} months · ${usd(v * p.spendingMonthly)}`}
            onChange={(v) => setCash({ efMonths: v })}
            hint={
              <Markers
                edited={p.cash.efMonths !== c.cash.efMonths}
                onReset={() => setCash({ efMonths: c.cash.efMonths })}
                fallback={fallbackFor("cash.efMonths", (v) => `${v} months`)}
              />
            }
          />
        </div>
        {p.cash.earmarks.map((e, i) => (
          <Field
            key={`${e.label}-${i}`}
            id={fid(`earmark-${i}`)}
            label={`Earmark in reserve: ${e.label}`}
            edited={e.amount !== c.cash.earmarks[i]?.amount}
            onReset={() =>
              setCash({
                earmarks: p.cash.earmarks.map((x, j) =>
                  j === i
                    ? { ...x, amount: c.cash.earmarks[i]?.amount ?? 0 }
                    : x
                ),
              })
            }
          >
            <NumberField
              id={fid(`earmark-${i}`)}
              ariaLabel={`Earmark: ${e.label}`}
              prefix="$"
              className={FIELD}
              value={e.amount}
              onChange={(v) =>
                setCash({
                  earmarks: p.cash.earmarks.map((x, j) =>
                    j === i ? { ...x, amount: Math.max(0, v) } : x
                  ),
                })
              }
            />
          </Field>
        ))}
        <div className="flex flex-col gap-1 @md:col-span-2">
          <SliderRow
            label="Move reserve excess to core over"
            info="The reserve keeps earmarks plus the next 12 months of shortfall. What it holds above that today moves into the core in equal steps over this many months; later excess moves right away."
            value={Math.max(1, Math.round(p.cash.dcaMonths))}
            min={1}
            max={24}
            step={1}
            format={(v) => `${v} ${v === 1 ? "month" : "months"}`}
            onChange={(v) => setCash({ dcaMonths: v })}
            hint={
              <Markers
                edited={p.cash.dcaMonths !== c.cash.dcaMonths}
                onReset={() => setCash({ dcaMonths: c.cash.dcaMonths })}
                fallback={fallbackFor("cash.dcaMonths", (v) => `${v} months`)}
              />
            }
          />
        </div>
        {p.oneOffs.map((o, i) => (
          <Field
            key={`${o.month}-${i}`}
            id={fid(`oneoff-${i}`)}
            label={`${o.label}, ${monthLabel(o.month)}`}
            edited={o.amount !== c.oneOffs[i]?.amount}
            onReset={() =>
              setP({
                oneOffs: p.oneOffs.map((x, j) =>
                  j === i ? { ...x, amount: c.oneOffs[i]?.amount ?? 0 } : x
                ),
              })
            }
            info="A negative amount is a refund."
          >
            <NumberField
              id={fid(`oneoff-${i}`)}
              ariaLabel={`${o.label} ${monthLabel(o.month)}`}
              prefix="$"
              className={FIELD}
              value={o.amount}
              onChange={(v) =>
                setP({
                  oneOffs: p.oneOffs.map((x, j) =>
                    j === i ? { ...x, amount: v } : x
                  ),
                })
              }
            />
          </Field>
        ))}
        <p className="text-muted-foreground text-xs @md:col-span-2">
          Emergency fund target {usd(efTarget)}.
          {p.starting.cards > 0
            ? ` ${usd(p.starting.cards)} of card balances is paid from cash at the start.`
            : ""}
        </p>
      </InputsSection>

      <InputsSection
        title="Returns and caps"
        hint="Smooth averages; a bad year lowers the invested sleeves, not the cash plan. These start from the shared defaults."
        summary={`stocks ${pct(p.returns.equity, 1)} · reserve ${pct(p.returns.reserve, 1)} · play cap ${pct(p.playCap, 0)}`}
      >
        {(
          [
            ["equity", "Stocks", 0.12],
            ["reserve", "Reserve yield", 0.06],
            ["ef", "Savings (HYSA) yield", 0.06],
            ["gold", "Gold", 0.1],
          ] as const
        ).map(([k, label, max]) => (
          <SliderRow
            key={k}
            label={label}
            value={p.returns[k]}
            min={0}
            max={max}
            step={0.001}
            format={(v) => `${pct(v, 1)}/yr`}
            onChange={(v) => setReturns({ [k]: v })}
            hint={
              <Markers
                edited={p.returns[k] !== c.returns[k]}
                onReset={() => setReturns({ [k]: c.returns[k] })}
                fallback={fallbackFor(`returns.${k}`, rate)}
              />
            }
          />
        ))}
        <SliderRow
          label="Play cap"
          info="The play sleeve's share of invested assets that the page flags as too much."
          value={p.playCap}
          min={0}
          max={0.3}
          step={0.01}
          format={(v) => pct(v, 0)}
          onChange={(v) => setP({ playCap: v })}
          hint={
            <Markers
              edited={p.playCap !== c.playCap}
              onReset={() => setP({ playCap: c.playCap })}
              fallback={fallbackFor("playCap", (v) =>
                typeof v === "number" ? pct(v, 0) : ""
              )}
            />
          }
        />
        <Field
          id={fid("spread")}
          label="Spread limits through"
          info="Pace even spreads the remaining limit over the paychecks left to Dec 31 (year end), or only over those inside the plan (horizon)."
          edited={p.spreadThrough !== c.spreadThrough}
          onReset={() => setP({ spreadThrough: c.spreadThrough })}
          fallback={fallbackFor("spreadThrough", (v) =>
            v === "horizon" ? "Horizon" : "Year end"
          )}
        >
          <Segmented<SpreadThrough>
            ariaLabel="Spread limits through"
            value={p.spreadThrough}
            onChange={(spreadThrough) => setP({ spreadThrough })}
            options={[
              { value: "year_end", label: "Year end" },
              { value: "horizon", label: "Horizon" },
            ]}
            className="h-9 w-full md:h-7 md:w-auto"
            optionClassName="flex-1 md:flex-none"
          />
        </Field>
      </InputsSection>
    </div>
  )
}
