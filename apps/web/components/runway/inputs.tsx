"use client"

// The inputs pane: four cards of page-level edits over the person's config.
// Edits are ephemeral (they reset when the person changes); a dot beside a
// label marks a field that differs from config, and clicking it resets that
// one field.

import * as React from "react"

import {
  NumberField,
  pct,
  SliderRow,
  usd,
  usdShort,
} from "@/components/fire/controls"
import { monthSpan } from "@/lib/runway/schedule"
import type {
  JobScenario,
  RunwayInputs,
  RunwayPerson,
  RunwayResult,
} from "@/lib/runway/types"

import { monthLabel } from "./chart-utils"
import { ContributionsSection, matchText } from "./contributions"
import { FIELD, Field, InputsSection, MONTHS, MonthField, same } from "./fields"

export function RunwayInputsPanel({
  inputs,
  config,
  scenario,
  result,
  onChange,
}: {
  inputs: RunwayInputs
  config: RunwayInputs
  scenario: JobScenario
  /** The active scenario's run, for progress against each limit. */
  result: RunwayResult
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

  const sc = p.scenarios.find((s) => s.id === scenario.id) ?? scenario
  const scC = c.scenarios.find((s) => s.id === scenario.id)
  const setScenario = (patch: Partial<JobScenario>) =>
    setP({
      scenarios: p.scenarios.map((s) =>
        s.id === sc.id ? { ...s, ...patch } : s
      ),
    })
  const isSwitch = Boolean(sc.job && sc.start)
  const months = monthSpan(inputs.horizon.start, inputs.horizon.months)
  const efTarget = p.cash.efMonths * p.spendingMonthly

  const firstMatch = sc.job?.match.type === "flat" ? sc.job.match.pct : 0
  const raisePct = p.job.raise?.pct ?? 0

  const paySummary = [
    `${usdShort(p.job.grossAnnual)}/yr`,
    isSwitch && sc.job ? `new ${usdShort(sc.job.grossAnnual)}` : null,
    raisePct ? `${pct(raisePct, 1)} raise` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <div className="flex flex-col gap-4">
      <InputsSection
        title="Pay and job"
        hint="Salary and raises. Take-home is estimated per paycheck."
        summary={paySummary}
      >
        {isSwitch && sc.job ? (
          <>
            <Field
              id={fid("start")}
              label="New job start"
              edited={scC ? sc.start !== scC.start : false}
              onReset={() => setScenario({ start: scC?.start ?? sc.start })}
            >
              <MonthField
                id={fid("start")}
                ariaLabel="New job start"
                value={sc.start ?? inputs.horizon.start}
                min={inputs.horizon.start}
                max={months.at(-1)}
                onChange={(start) => setScenario({ start })}
              />
            </Field>
            <Field
              id={fid("gross")}
              label="New job salary"
              edited={
                scC?.job ? sc.job.grossAnnual !== scC.job.grossAnnual : false
              }
              onReset={() =>
                scC?.job &&
                sc.job &&
                setScenario({
                  job: { ...sc.job, grossAnnual: scC.job.grossAnnual },
                })
              }
            >
              <NumberField
                id={fid("gross")}
                ariaLabel="New job salary"
                prefix="$"
                suffix="/yr"
                className={FIELD}
                value={sc.job.grossAnnual}
                onChange={(v) =>
                  sc.job &&
                  setScenario({
                    job: { ...sc.job, grossAnnual: Math.max(0, v) },
                  })
                }
              />
            </Field>
            <Field
              id={fid("match")}
              label="New job 401k match"
              edited={scC?.job ? !same(sc.job.match, scC.job.match) : false}
              onReset={() =>
                scC?.job &&
                sc.job &&
                setScenario({ job: { ...sc.job, match: scC.job.match } })
              }
              info={
                sc.job.match.type === "flat" || sc.job.match.type === "none"
                  ? undefined
                  : `From config: ${matchText(sc.job.match)}. Editing sets a flat match.`
              }
            >
              <NumberField
                id={fid("match")}
                ariaLabel="New job 401k match"
                suffix="% of pay"
                className={FIELD}
                value={Number((firstMatch * 100).toFixed(2))}
                onChange={(v) =>
                  sc.job &&
                  setScenario({
                    job: {
                      ...sc.job,
                      match:
                        v > 0
                          ? { type: "flat", pct: Math.max(0, v) / 100 }
                          : { type: "none" },
                    },
                  })
                }
              />
            </Field>
          </>
        ) : null}
        <Field
          id={fid("raise")}
          label="Raise each year"
          aside={
            p.job.raise ? `each ${MONTHS[p.job.raise.month - 1] ?? ""}` : null
          }
          edited={!same(p.job.raise, c.job.raise)}
          onReset={() => setP({ job: { ...p.job, raise: c.job.raise } })}
        >
          <NumberField
            id={fid("raise")}
            ariaLabel="Raise each year"
            suffix="%"
            className={FIELD}
            value={Number((raisePct * 100).toFixed(2))}
            onChange={(v) =>
              setP({
                job: {
                  ...p.job,
                  raise: { month: p.job.raise?.month ?? 1, pct: v / 100 },
                },
              })
            }
          />
        </Field>
      </InputsSection>

      <ContributionsSection
        inputs={inputs}
        config={config}
        scenario={scenario}
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
              p.cash.efMonths !== c.cash.efMonths ? (
                <ResetLink
                  onClick={() => setCash({ efMonths: c.cash.efMonths })}
                />
              ) : undefined
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
              p.cash.dcaMonths !== c.cash.dcaMonths ? (
                <ResetLink
                  onClick={() => setCash({ dcaMonths: c.cash.dcaMonths })}
                />
              ) : undefined
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
        title="Returns"
        hint="Smooth averages; a bad year lowers the invested sleeves, not the cash plan."
        summary={`stocks ${pct(p.returns.equity, 1)} · reserve ${pct(p.returns.reserve, 1)} · HYSA ${pct(p.returns.ef, 1)}`}
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
              p.returns[k] !== c.returns[k] ? (
                <ResetLink onClick={() => setReturns({ [k]: c.returns[k] })} />
              ) : undefined
            }
          />
        ))}
      </InputsSection>
    </div>
  )
}

function ResetLink({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-xs hover:text-foreground"
    >
      <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
      Edited; reset
    </button>
  )
}
