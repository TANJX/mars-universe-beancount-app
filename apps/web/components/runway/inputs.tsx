"use client"

// The inputs pane: four cards of page-level edits over the person's config.
// Edits are ephemeral (they reset when the person changes); a dot beside a
// label marks a field that differs from config, and clicking it resets that
// one field.

import { ChevronDown } from "lucide-react"
import * as React from "react"

import {
  InfoTip,
  NumberField,
  pct,
  Segmented,
  SliderRow,
  usd,
  usdShort,
} from "@/components/fire/controls"
import { Card } from "@/components/ui/card"
import { monthSpan } from "@/lib/runway/schedule"
import type {
  Election,
  ElectionMode,
  JobScenario,
  Match,
  RunwayInputs,
  RunwayPerson,
} from "@/lib/runway/types"
import { cn } from "@/lib/utils"

import { monthLabel } from "./chart-utils"

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

const MOBILE_QUERY = "(max-width: 767px)"

/** Card whose body folds on phones; the summary keeps its key values. */
function InputsSection({
  title,
  hint,
  summary,
  children,
}: {
  title: string
  hint: string
  summary: string
  children: React.ReactNode
}) {
  // The page only renders after the client fetch, so the media query is
  // known on first render: no flash from a default-then-correct state.
  const [open, setOpen] = React.useState(
    () =>
      typeof window === "undefined" || !window.matchMedia(MOBILE_QUERY).matches
  )
  return (
    <Card className="gap-0 p-0">
      <details
        open={open}
        onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
        className="group"
      >
        <summary className="flex cursor-pointer list-none items-start justify-between gap-4 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium text-muted-foreground text-xs tracking-wide">
              {title}
            </span>
            <span className="text-muted-foreground text-xs group-open:hidden">
              <span className="font-mono tabular-nums">{summary}</span>
            </span>
            <span className="hidden text-muted-foreground text-xs group-open:block">
              {hint}
            </span>
          </span>
          <ChevronDown
            size={14}
            className="mt-0.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
          />
        </summary>
        <div className="@container px-4 pb-4">
          <div className="grid gap-x-4 gap-y-3 @md:grid-cols-2">{children}</div>
        </div>
      </details>
    </Card>
  )
}

function EditedDot({ onReset }: { onReset: () => void }) {
  return (
    <button
      type="button"
      aria-label="Edited; reset to config"
      title="Edited. Click to reset to config."
      onClick={onReset}
      className="relative size-1.5 shrink-0 rounded-full bg-primary before:absolute before:-inset-2"
    />
  )
}

function Field({
  id,
  label,
  edited,
  onReset,
  info,
  aside,
  error,
  className,
  children,
}: {
  id?: string
  label: string
  edited?: boolean
  onReset?: () => void
  info?: React.ReactNode
  aside?: React.ReactNode
  error?: string | null
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <div className="flex items-center gap-1.5 text-xs">
        <label htmlFor={id}>{label}</label>
        {info ? <InfoTip label={label}>{info}</InfoTip> : null}
        {edited && onReset ? <EditedDot onReset={onReset} /> : null}
        {aside ? (
          <span className="ml-auto text-muted-foreground">{aside}</span>
        ) : null}
      </div>
      {children}
      {error ? (
        <span className="text-rose-600 text-xs dark:text-rose-400">
          {error}
        </span>
      ) : null}
    </div>
  )
}

const FIELD =
  "h-9 w-full text-base md:h-7 md:text-xs [&_input]:text-base md:[&_input]:text-xs"

export function MonthField({
  id,
  value,
  onChange,
  min,
  max,
  ariaLabel,
}: {
  id?: string
  value: string
  onChange: (v: string) => void
  min?: string
  max?: string
  ariaLabel: string
}) {
  return (
    <input
      id={id}
      type="month"
      aria-label={ariaLabel}
      value={value}
      min={min}
      max={max}
      onChange={(e) => {
        if (/^\d{4}-\d{2}$/.test(e.target.value)) onChange(e.target.value)
      }}
      className="h-9 w-full rounded-md border border-input bg-transparent px-2 font-mono text-base tabular-nums outline-none focus-visible:border-ring md:h-7 md:text-xs dark:bg-input/30"
    />
  )
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-medium text-muted-foreground text-xs @md:col-span-2">
      {children}
    </div>
  )
}

function matchText(m: Match): string {
  switch (m.type) {
    case "none":
      return "no match"
    case "flat":
      return `${pct(m.pct, 1)} of pay`
    case "threshold":
      return `${pct(m.pct, 1)} of pay if you defer ${pct(m.minPct, 0)} or more`
    case "tiered":
      return m.tiers
        .map((t) => `${pct(t.rate, 0)} up to ${pct(t.upToPct, 0)}`)
        .join(", ")
  }
}

const MODE_LABEL: { value: ElectionMode; label: string }[] = [
  { value: "max_spread", label: "Max" },
  { value: "fixed", label: "Per paycheck" },
  { value: "percent", label: "Percent" },
]

function switchMode(e: Election, mode: ElectionMode): Election {
  if (e.mode === mode) return e
  if (mode === "max_spread")
    return { from: e.from, mode, capPct: 1, rothShare: 0 }
  if (mode === "fixed") return { from: e.from, mode, pretax: 1000, roth: 0 }
  return { from: e.from, mode, pretaxPct: 0.1, rothPct: 0 }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function RunwayInputsPanel({
  inputs,
  config,
  scenario,
  onChange,
}: {
  inputs: RunwayInputs
  config: RunwayInputs
  scenario: JobScenario
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
  const years = [...new Set(months.map((m) => m.slice(0, 4)))]
  const efTarget = p.cash.efMonths * p.spendingMonthly

  const setElection = (i: number, e: Election) =>
    setP({
      k401: {
        ...p.k401,
        elections: p.k401.elections.map((x, j) => (j === i ? e : x)),
      },
    })

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
        hint="Salary, raises and the 401k election. Take-home is estimated per paycheck."
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

        <SubLabel>
          <span className="inline-flex items-center gap-1">
            401k election
            <InfoTip label="401k election">
              Max spreads the year&apos;s remaining limit over the paychecks
              left in that year, up to a share of each check. Per paycheck and
              Percent stop at the annual limit. Each row applies from its month
              until the next row.
            </InfoTip>
            {!same(p.k401.elections, c.k401.elections) ? (
              <EditedDot
                onReset={() =>
                  setP({ k401: { ...p.k401, elections: c.k401.elections } })
                }
              />
            ) : null}
          </span>
        </SubLabel>
        {p.k401.elections.length === 0 ? (
          <span className="text-muted-foreground text-xs @md:col-span-2">
            No election in config: no 401k deferrals.
          </span>
        ) : null}
        {p.k401.elections.map((e, i) => (
          <ElectionRow
            key={`${e.from}-${i}`}
            election={e}
            onChange={(next) => setElection(i, next)}
          />
        ))}
        <p className="text-muted-foreground text-xs @md:col-span-2">
          {p.job.employer} match: {matchText(p.job.match)}
          {p.job.vesting
            ? `, vests ${monthLabel(p.job.vesting.date.slice(0, 7))}`
            : ""}
          .
        </p>
      </InputsSection>

      <InputsSection
        title="Spending and cash"
        hint="What goes out each month and how much cash stays liquid."
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
        <p className="text-muted-foreground text-xs @md:col-span-2">
          Emergency fund target {usd(efTarget)}.
          {p.starting.cards > 0
            ? ` ${usd(p.starting.cards)} of card balances is paid from cash at the start.`
            : ""}
        </p>
      </InputsSection>

      <InputsSection
        title="Contributions and taxes"
        hint="Annual limits and one-off bills the reserve has to cover."
        summary={[
          ...years.map(
            (y) => `${y} ${usdShort(p.k401.limits[y] ?? limitFallback(p, y))}`
          ),
          p.ira ? `IRA ${usdShort(p.ira.amount)}` : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      >
        {years.map((y) => (
          <Field
            key={y}
            id={fid(`lim-${y}`)}
            label={`401k limit ${y}`}
            edited={(p.k401.limits[y] ?? null) !== (c.k401.limits[y] ?? null)}
            onReset={() => {
              const limits = { ...p.k401.limits }
              if (c.k401.limits[y] != null) limits[y] = c.k401.limits[y]
              else delete limits[y]
              setP({ k401: { ...p.k401, limits } })
            }}
          >
            <NumberField
              id={fid(`lim-${y}`)}
              ariaLabel={`401k limit ${y}`}
              prefix="$"
              className={FIELD}
              value={p.k401.limits[y] ?? limitFallback(p, y)}
              onChange={(v) =>
                setP({
                  k401: {
                    ...p.k401,
                    limits: { ...p.k401.limits, [y]: Math.max(0, v) },
                  },
                })
              }
            />
          </Field>
        ))}
        {p.ira ? (
          <Field
            id={fid("ira")}
            label={`IRA each ${MONTHS[p.ira.month - 1] ?? "year"}`}
            edited={p.ira.amount !== c.ira?.amount}
            onReset={() => c.ira && setP({ ira: { ...c.ira } })}
          >
            <NumberField
              id={fid("ira")}
              ariaLabel="IRA deposit"
              prefix="$"
              className={FIELD}
              value={p.ira.amount}
              onChange={(v) =>
                p.ira && setP({ ira: { ...p.ira, amount: Math.max(0, v) } })
              }
            />
          </Field>
        ) : null}
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

function limitFallback(p: RunwayPerson, year: string): number {
  const known = Object.keys(p.k401.limits)
    .filter((y) => y <= year)
    .sort()
  const y = known.at(-1) ?? Object.keys(p.k401.limits).sort()[0]
  return y ? p.k401.limits[y] : 0
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

function ElectionRow({
  election: e,
  onChange,
}: {
  election: Election
  onChange: (e: Election) => void
}) {
  const id = React.useId()
  return (
    <div className="flex flex-col gap-1.5 @md:col-span-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="w-20 shrink-0 text-muted-foreground">
          from {monthLabel(e.from)}
        </span>
        <Segmented<ElectionMode>
          ariaLabel={`401k election from ${monthLabel(e.from)}`}
          value={e.mode}
          onChange={(m) => onChange(switchMode(e, m))}
          options={MODE_LABEL}
        />
        {e.mode === "fixed" ? (
          <NumberField
            id={id}
            ariaLabel="Pre-tax 401k per paycheck"
            prefix="$"
            suffix="/check"
            className="h-9 w-32 text-base md:h-7 md:text-xs [&_input]:text-base md:[&_input]:text-xs"
            value={e.pretax}
            onChange={(v) => onChange({ ...e, pretax: Math.max(0, v) })}
          />
        ) : e.mode === "percent" ? (
          <NumberField
            id={id}
            ariaLabel="Pre-tax 401k percent of pay"
            suffix="% of pay"
            className="h-9 w-32 text-base md:h-7 md:text-xs [&_input]:text-base md:[&_input]:text-xs"
            value={Number((e.pretaxPct * 100).toFixed(2))}
            onChange={(v) =>
              onChange({ ...e, pretaxPct: Math.max(0, Math.min(100, v)) / 100 })
            }
          />
        ) : (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            up to
            <NumberField
              id={id}
              ariaLabel="Most of each paycheck to the 401k"
              suffix="%"
              className="h-9 w-20 text-base md:h-7 md:text-xs [&_input]:text-base md:[&_input]:text-xs"
              value={Number((e.capPct * 100).toFixed(2))}
              onChange={(v) =>
                onChange({ ...e, capPct: Math.max(0, Math.min(100, v)) / 100 })
              }
            />
            of a check
          </span>
        )}
      </div>
      {(e.mode === "fixed" && e.roth > 0) ||
      (e.mode === "percent" && e.rothPct > 0) ||
      (e.mode === "max_spread" && e.rothShare > 0) ? (
        <span className="pl-22 text-muted-foreground text-xs">
          Plus Roth 401k from config:{" "}
          {e.mode === "fixed"
            ? `${usd(e.roth)}/check`
            : e.mode === "percent"
              ? `${pct(e.rothPct, 1)} of pay`
              : `${pct(e.rothShare, 0)} of the deferral`}
          .
        </span>
      ) : null}
    </div>
  )
}
