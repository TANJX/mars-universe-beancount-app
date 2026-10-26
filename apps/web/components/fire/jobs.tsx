"use client"

// Jobs inside the People card. A job carries its pay (salary steps) and its
// equity (grants that vest while you are there, plus what they turn into).
// Leaving is one field: it stops both the paychecks and the vesting, and a
// later enabled job ends the previous one automatically.

import { Plus, Trash2 } from "lucide-react"
import * as React from "react"

import { DEFAULT_EQUITY } from "@/lib/fire/config"
import {
  jobEquity,
  jobWindows,
  monthIndex,
  monthLabel,
  vestedShares,
} from "@/lib/fire/equity"
import type {
  EquityOutcome,
  Grant,
  GrantType,
  Job,
  Person,
  SalaryStep,
} from "@/lib/fire/types"
import { cn } from "@/lib/utils"

import { NumberField, Segmented, Toggle, usd, YearStepper } from "./controls"

const fmtShares = (n: number) => Math.round(n).toLocaleString("en-US")

export function JobsEditor({
  person,
  startYear,
  nowMonth,
  onChange,
}: {
  person: Person
  startYear: number
  /** Snapshot month index, for "vested today". */
  nowMonth: number
  onChange: (jobs: Job[]) => void
}) {
  const jobs = person.jobs
  const windows = jobWindows(person)
  const equity = jobEquity(person)
  const set = (id: string, patch: Partial<Job>) =>
    onChange(jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)))
  const add = () => {
    const last = jobs.at(-1)
    const gross = last?.salary.filter((s) => s.enabled).at(-1)?.gross ?? 100000
    onChange([
      ...jobs,
      {
        id: `${person.id}-job-${jobs.length}-${startYear}`,
        employer: "New job",
        enabled: true,
        start: `${startYear + 1}-01`,
        leave: null,
        salary: [{ year: startYear + 1, gross, enabled: true }],
        grants: [],
        equity: { ...DEFAULT_EQUITY, liquidityYear: startYear + 5 },
      },
    ])
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted-foreground">Jobs</span>
      {jobs.map((job) => {
        const w = windows.find((x) => x.job.id === job.id)
        const cutByNext =
          w && Number.isFinite(w.to) && job.leave !== monthLabel(w.to)
        return (
          <div
            key={job.id}
            className={cn(
              "flex flex-col gap-2.5 rounded-lg bg-background/60 p-2.5 ring-1 ring-foreground/5",
              !job.enabled && "opacity-55"
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Toggle
                checked={job.enabled}
                onChange={(v) => set(job.id, { enabled: v })}
                label={`Enable ${job.employer}`}
              />
              <input
                aria-label="Employer"
                value={job.employer}
                onChange={(e) => set(job.id, { employer: e.target.value })}
                className="min-w-0 flex-1 bg-transparent font-medium text-[13px] outline-none"
              />
              <button
                type="button"
                aria-label={`Remove ${job.employer}`}
                disabled={jobs.length <= 1}
                onClick={() => onChange(jobs.filter((j) => j.id !== job.id))}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
              >
                <Trash2 size={13} />
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <MonthField
                label="Start"
                value={job.start}
                emptyText="before plan"
                onChange={(v) => set(job.id, { start: v })}
              />
              <MonthField
                label="Leave"
                value={job.leave}
                emptyText="open"
                onChange={(v) => set(job.id, { leave: v })}
              />
              {cutByNext && w ? (
                <span className="text-muted-foreground">
                  ends {monthLabel(w.to)} (next job starts)
                </span>
              ) : null}
            </div>

            <SalarySteps
              steps={job.salary}
              who={job.employer}
              startYear={startYear}
              onChange={(salary) => set(job.id, { salary })}
            />

            <EquityEditor
              job={job}
              summary={equity.find((e) => e.job.id === job.id)}
              nowMonth={nowMonth}
              onChange={(patch) => set(job.id, patch)}
            />
          </div>
        )
      })}
      <button
        type="button"
        onClick={add}
        className="inline-flex h-6 w-fit items-center gap-1 rounded-md border px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Plus size={11} />
        Job
      </button>
    </div>
  )
}

function MonthField({
  label,
  value,
  emptyText,
  onChange,
}: {
  label: string
  value: string | null
  emptyText: string
  onChange: (v: string | null) => void
}) {
  return (
    <label className="inline-flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="month"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-7 rounded-md border border-input bg-transparent px-1.5 font-mono text-xs tabular-nums dark:bg-input/30"
      />
      {value ? null : (
        <span className="text-muted-foreground">{emptyText}</span>
      )}
    </label>
  )
}

export function SalarySteps({
  steps,
  who,
  startYear,
  onChange,
}: {
  steps: SalaryStep[]
  who: string
  startYear: number
  onChange: (salary: SalaryStep[]) => void
}) {
  const set = (k: number, patch: Partial<SalaryStep>) =>
    onChange(
      steps
        .map((x, m) => (m === k ? { ...x, ...patch } : x))
        .sort((a, b) => a.year - b.year)
    )
  const add = () => {
    const last = steps.at(-1)
    onChange([
      ...steps,
      {
        year: Math.max(startYear, (last?.year ?? startYear) + 1),
        gross: last?.gross ?? 0,
        note: "Raise",
        enabled: true,
      },
    ])
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground">Salary steps (gross)</span>
      {steps.map((s, k) => (
        <div
          // Index key: a year edit re-sorts the list, and the year is the
          // thing being edited, so it can't be the key.
          key={k}
          className={cn(
            "grid grid-cols-[auto_auto_7rem_1fr_auto] items-center gap-2",
            !s.enabled && "text-muted-foreground"
          )}
        >
          <Toggle
            checked={s.enabled}
            onChange={(v) => set(k, { enabled: v })}
            label={`Enable ${who} ${s.year} salary`}
          />
          <YearStepper value={s.year} onChange={(y) => set(k, { year: y })} />
          <NumberField
            ariaLabel={`${who} salary ${s.year}`}
            prefix="$"
            value={s.gross}
            onChange={(v) => set(k, { gross: v })}
          />
          <input
            aria-label={`${who} salary ${s.year} note`}
            placeholder="Note"
            value={s.note ?? ""}
            onChange={(e) => set(k, { note: e.target.value })}
            className="min-w-0 truncate bg-transparent outline-none placeholder:text-muted-foreground/60"
          />
          <button
            type="button"
            aria-label={`Remove ${who} ${s.year} salary`}
            disabled={steps.length <= 1}
            onClick={() => onChange(steps.filter((_, m) => m !== k))}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        className="inline-flex h-6 w-fit items-center gap-1 rounded-md border px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Plus size={11} />
        Salary step
      </button>
    </div>
  )
}

function EquityEditor({
  job,
  summary,
  nowMonth,
  onChange,
}: {
  job: Job
  summary: ReturnType<typeof jobEquity>[number] | undefined
  nowMonth: number
  onChange: (patch: Partial<Job>) => void
}) {
  const eq = job.equity
  const setEq = (patch: Partial<EquityOutcome>) =>
    onChange({ equity: { ...eq, ...patch } })
  const setGrant = (id: string, patch: Partial<Grant>) =>
    onChange({
      grants: job.grants.map((g) => (g.id === id ? { ...g, ...patch } : g)),
    })
  const addGrant = () =>
    onChange({
      grants: [
        ...job.grants,
        {
          id: `${job.id}-grant-${job.grants.length}`,
          label: `Grant ${job.grants.length + 1}`,
          type: "iso",
          shares: 0,
          strike: 1,
          price: 1,
          vestStart: job.start ?? monthLabel(nowMonth),
          vestMonths: 48,
          cliffMonths: 12,
          halves: false,
          halfOffsetMonths: 24,
        },
      ],
    })

  const vestedNow = job.grants.reduce(
    (a, g) =>
      a + vestedShares(g, Math.min(nowMonth, summary?.vestUntil ?? nowMonth)),
    0
  )

  return (
    <details className="group" open={job.grants.length > 0}>
      <summary className="cursor-pointer list-none text-muted-foreground [&::-webkit-details-marker]:hidden">
        <span className="mr-1 inline-block transition-transform group-open:rotate-90">
          ›
        </span>
        Equity
        {summary ? (
          <span className="ml-2 font-mono tabular-nums">
            {fmtShares(summary.vested)} of {fmtShares(summary.total)} vest by{" "}
            {monthLabel(summary.vestUntil)}
            {eq.enabled
              ? ` · ${usd(summary.payout(eq.multiple))} after tax at ${eq.multiple}x`
              : " · not in plan"}
          </span>
        ) : (
          <span className="ml-2">none</span>
        )}
      </summary>

      <div className="mt-2 flex flex-col gap-2.5">
        {job.grants.map((g) => (
          <GrantRow
            key={g.id}
            grant={g}
            onChange={(patch) => setGrant(g.id, patch)}
            onRemove={() =>
              onChange({ grants: job.grants.filter((x) => x.id !== g.id) })
            }
          />
        ))}
        <button
          type="button"
          onClick={addGrant}
          className="inline-flex h-6 w-fit items-center gap-1 rounded-md border px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Plus size={11} />
          Grant
        </button>

        {job.grants.length ? (
          <div className="flex flex-col gap-2 border-t pt-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="inline-flex items-center gap-1.5">
                <Toggle
                  checked={eq.enabled}
                  onChange={(v) => setEq({ enabled: v })}
                  label="Include equity in the plan"
                />
                In plan
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="text-muted-foreground">Liquidity</span>
                <YearStepper
                  value={eq.liquidityYear}
                  onChange={(y) => setEq({ liquidityYear: y })}
                />
              </span>
              <Segmented
                value={String(eq.multiple)}
                options={[0, 1, 3, 5, 10].map((m) => ({
                  value: String(m),
                  label: `${m}x`,
                }))}
                onChange={(v) => setEq({ multiple: Number(v) })}
              />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <PctField
                label="Tax"
                value={eq.taxRate}
                onChange={(v) => setEq({ taxRate: v })}
              />
              <PctField
                label="Dilution"
                value={eq.dilution}
                onChange={(v) => setEq({ dilution: v })}
              />
              <span className="inline-flex items-center gap-1.5">
                <Toggle
                  checked={eq.exerciseAtLeave}
                  onChange={(v) => setEq({ exerciseAtLeave: v })}
                  label="Exercise options when leaving"
                />
                Exercise on leaving
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="text-muted-foreground">Monte Carlo odds</span>
              <PctField
                label="fail 0x"
                value={eq.odds.fail}
                onChange={(v) => setEq({ odds: { ...eq.odds, fail: v } })}
              />
              <PctField
                label={`modest ${eq.modestMultiple}x`}
                value={eq.odds.modest}
                onChange={(v) => setEq({ odds: { ...eq.odds, modest: v } })}
              />
              <PctField
                label={`big ${eq.bigMultiple}x`}
                value={eq.odds.big}
                onChange={(v) => setEq({ odds: { ...eq.odds, big: v } })}
              />
            </div>
            {summary ? (
              <p className="text-muted-foreground">
                Vested today {fmtShares(vestedNow)}.
                {summary.exerciseCost > 0
                  ? ` Exercising on leaving costs ${usd(summary.exerciseCost)} in ${summary.exerciseYear}.`
                  : ""}{" "}
                After tax at 1x / 3x / 10x:{" "}
                <span className="font-mono text-foreground tabular-nums">
                  {usd(summary.payout(1))} / {usd(summary.payout(3))} /{" "}
                  {usd(summary.payout(10))}
                </span>
                .
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </details>
  )
}

function PctField({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <NumberField
        ariaLabel={label}
        className="w-16"
        suffix="%"
        value={Math.round(value * 1000) / 10}
        onChange={(v) => onChange(Math.min(1, Math.max(0, v / 100)))}
      />
    </span>
  )
}

function GrantRow({
  grant: g,
  onChange,
  onRemove,
}: {
  grant: Grant
  onChange: (patch: Partial<Grant>) => void
  onRemove: () => void
}) {
  const [value, setValue] = React.useState(0)
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-muted/40 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          aria-label="Grant label"
          value={g.label}
          onChange={(e) => onChange({ label: e.target.value })}
          className="min-w-0 flex-1 bg-transparent font-medium outline-none"
        />
        <select
          aria-label="Grant type"
          value={g.type}
          onChange={(e) => {
            const type = e.target.value as GrantType
            onChange(type === "rsu" ? { type, strike: 0 } : { type })
          }}
          className="h-7 rounded-md border bg-transparent px-1.5"
        >
          <option value="iso">ISO</option>
          <option value="nso">NSO</option>
          <option value="rsu">RSU</option>
        </select>
        <button
          type="button"
          aria-label={`Remove ${g.label}`}
          onClick={onRemove}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Field label="Shares">
          <NumberField
            ariaLabel="Shares"
            className="w-24"
            value={Math.round(g.shares)}
            onChange={(v) => onChange({ shares: Math.max(0, v) })}
          />
        </Field>
        {g.type === "rsu" ? null : (
          <Field label="Strike">
            <NumberField
              ariaLabel="Strike"
              prefix="$"
              className="w-20"
              value={g.strike}
              onChange={(v) => onChange({ strike: Math.max(0, v) })}
            />
          </Field>
        )}
        <Field label="Price now">
          <NumberField
            ariaLabel="Current price per share"
            prefix="$"
            className="w-20"
            value={g.price}
            onChange={(v) => onChange({ price: Math.max(0, v) })}
          />
        </Field>
        <Field label="Or $ value">
          <NumberField
            ariaLabel="Set shares from a dollar value at today's price"
            prefix="$"
            className="w-24"
            value={value}
            onChange={(v) => {
              setValue(v)
              if (v > 0 && g.price > 0) {
                onChange({
                  shares: v / g.price,
                  ...(g.type === "rsu" ? {} : { strike: g.price }),
                })
              }
            }}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Field label="Vest start">
          <input
            type="month"
            aria-label="Vesting start"
            value={g.vestStart}
            onChange={(e) =>
              e.target.value && onChange({ vestStart: e.target.value })
            }
            className="h-7 rounded-md border border-input bg-transparent px-1.5 font-mono text-xs tabular-nums dark:bg-input/30"
          />
        </Field>
        <Field label="Over">
          <NumberField
            ariaLabel="Vesting months"
            className="w-16"
            suffix="mo"
            value={g.vestMonths}
            onChange={(v) =>
              onChange({ vestMonths: Math.max(1, Math.round(v)) })
            }
          />
        </Field>
        <Field label="Cliff">
          <NumberField
            ariaLabel="Cliff months"
            className="w-16"
            suffix="mo"
            value={g.cliffMonths}
            onChange={(v) =>
              onChange({ cliffMonths: Math.max(0, Math.round(v)) })
            }
          />
        </Field>
        <span className="inline-flex items-center gap-1.5">
          <Toggle
            checked={g.halves}
            onChange={(v) => onChange({ halves: v })}
            label="Vest in two halves"
          />
          <span className="text-muted-foreground">
            two halves{g.halves ? `, 2nd starts +${g.halfOffsetMonths} mo` : ""}
          </span>
        </span>
      </div>
      <span className="text-muted-foreground">
        Spread today:{" "}
        <span className="font-mono tabular-nums">
          {usd(
            g.shares * Math.max(0, g.price - (g.type === "rsu" ? 0 : g.strike))
          )}
        </span>{" "}
        · fully vested{" "}
        {monthLabel(
          monthIndex(g.vestStart) +
            g.vestMonths +
            (g.halves ? g.halfOffsetMonths : 0)
        )}
      </span>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </span>
  )
}
