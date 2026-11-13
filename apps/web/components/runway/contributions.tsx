"use client"

// The Contributions card: every stream of money into the 401k, HSA and IRA,
// grouped by account, each group measured against its annual limit for the
// selected year. A stream is a row that opens into its dated changes.

import { AlertTriangle, ChevronRight, Plus, X } from "lucide-react"
import * as React from "react"

import {
  InfoTip,
  NumberField,
  pct,
  Segmented,
  usd,
  usdShort,
} from "@/components/fire/controls"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { resolveLimits } from "@/lib/runway/config"
import {
  ACCOUNT_LABEL,
  limitsFor,
  newContribution,
  paceSummary,
  phaseAt,
  streamLabel,
} from "@/lib/runway/contributions"
import { addMonths, monthSpan } from "@/lib/runway/schedule"
import {
  type Channel,
  CONTRIBUTION_ACCOUNTS,
  type Contribution,
  type ContributionAccount,
  type HsaCoverage,
  type HsaTier,
  type Match,
  type Pace,
  type PaceKind,
  type Phase,
  type PoolYear,
  type RunwayInputs,
  type RunwayPerson,
  type RunwayResult,
  type TaxTreatment,
} from "@/lib/runway/types"
import { cn } from "@/lib/utils"

import { monthLabel } from "./chart-utils"
import { EditedDot, InputsSection, MONTHS, MonthField, same } from "./fields"

const SLEEVE_TOKEN: Record<ContributionAccount, string> = {
  k401: "--sleeve-k401",
  hsa: "--sleeve-hsa",
  ira: "--sleeve-ira",
}

/** Inline field: 16px on phones so iOS does not zoom, compact from md up. */
const INLINE =
  "h-9 text-base md:h-7 md:text-xs [&_input]:text-base md:[&_input]:text-xs"

export function matchText(m: Match): string {
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

/** "2027-12-24" as "Dec 24"; "2027-01" as "Jan". */
function shortDate(d: string): string {
  const mon = MONTHS[Number(d.slice(5, 7)) - 1] ?? ""
  return d.length > 7 ? `${mon} ${Number(d.slice(8, 10))}` : mon
}

// ------------------------------------------------------------- limit meter

export type MeterTone = "before" | "traditional" | "roth" | "employer"

export interface MeterSegment {
  label: string
  value: number
  tone: MeterTone
}

const TONE_FILL: Record<MeterTone, string> = {
  before: "color-mix(in oklch, var(--meter) 28%, transparent)",
  traditional: "var(--meter)",
  roth: "color-mix(in oklch, var(--meter) 55%, transparent)",
  employer: "color-mix(in oklch, var(--meter) 78%, var(--foreground))",
}

/** Progress against an annual limit. Segments stack left to right; anything
 * past the limit is drawn in rose after a tick at the limit. */
export function LimitMeter({
  limit,
  segments,
  token,
  label,
}: {
  limit: number
  segments: MeterSegment[]
  /** CSS custom property carrying the account's color. */
  token: string
  label: string
}) {
  const shown = segments.filter((s) => s.value > 0.5)
  const sum = shown.reduce((a, s) => a + s.value, 0)
  const scale = Math.max(limit, sum, 1)
  const over = sum > limit + 0.5
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={Math.round(limit)}
      aria-valuenow={Math.round(Math.min(sum, limit))}
      aria-valuetext={`${usd(sum)} of ${usd(limit)}${over ? `, ${usd(sum - limit)} over` : ""}`}
      className="relative h-1.5 overflow-hidden rounded-full bg-muted"
      style={{ "--meter": `var(${token})` } as React.CSSProperties}
    >
      <div className="flex h-full gap-px">
        {shown.map((s) => (
          <span
            key={s.label}
            title={`${s.label} ${usd(s.value)}`}
            className="h-full transition-[width] duration-200 ease-out motion-reduce:transition-none"
            style={{
              width: `${(s.value / scale) * 100}%`,
              background: TONE_FILL[s.tone],
            }}
          />
        ))}
      </div>
      {over ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-0 right-0 border-background border-l-2 bg-rose-500 dark:bg-rose-400"
          style={{ left: `${(limit / scale) * 100}%` }}
        />
      ) : null}
    </div>
  )
}

/** The one line under a meter: full, room left, clipped, or over. */
export function PoolStatus({
  pool,
  account,
  year,
}: {
  pool: PoolYear
  account: ContributionAccount
  year: string
}) {
  const room = Math.max(0, pool.limit - pool.contributed)
  if (pool.excess > 0)
    return (
      <p className="flex items-start gap-1.5 text-pretty text-rose-600 text-xs dark:text-rose-400">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        <span>
          {usd(pool.excess)} over the {year} limit
          {account === "hsa"
            ? ", which counts only the months covered by an HDHP"
            : ""}
          . Take the excess out by the tax filing deadline to avoid the 6%
          excise.
        </span>
      </p>
    )
  if (pool.clippedDate)
    return (
      <p className="flex items-start gap-1.5 text-pretty text-amber-600 text-xs dark:text-amber-400">
        <AlertTriangle size={12} className="mt-0.5 shrink-0" />
        <span>
          Asks for {usd(pool.cut)} more than the limit allows, from{" "}
          {shortDate(pool.clippedDate)}. This plan stops at the limit; payroll
          may not.
        </span>
      </p>
    )
  let text: string
  if (pool.limit <= 0)
    text =
      account === "hsa"
        ? `No HDHP coverage in ${year}: nothing can go in.`
        : "No limit set."
  else if (room < 0.5)
    text = pool.hitDate
      ? `Full ${pool.hitDate.length > 7 ? "on" : "in"} ${shortDate(pool.hitDate)}`
      : "Full"
  else if (!pool.complete)
    text = `${usd(room)} of room left when the plan ends; ${year} runs past it`
  else text = `${usd(room)} of room unused`
  return <p className="text-pretty text-muted-foreground text-xs">{text}</p>
}

// ------------------------------------------------------------------ pieces

/** One account: its name, contributed over limit, the meter and its rows. */
export function ContributionGroup({
  title,
  total,
  limit,
  onLimitChange,
  limitEdited,
  onLimitReset,
  limitInfo,
  children,
}: {
  title: string
  total: number
  limit: number
  /** Omit for a derived, read-only limit (an HSA's). */
  onLimitChange?: (v: number) => void
  limitEdited?: boolean
  onLimitReset?: () => void
  limitInfo?: React.ReactNode
  children: React.ReactNode
}) {
  const id = React.useId()
  return (
    <section className="flex flex-col gap-1.5" aria-labelledby={id}>
      <div className="flex items-center gap-1.5 text-xs">
        <h3 id={id} className="font-medium">
          {title}
        </h3>
        {limitInfo ? (
          <InfoTip label={`${title} limit`}>{limitInfo}</InfoTip>
        ) : null}
        {limitEdited && onLimitReset ? (
          <EditedDot
            onReset={onLimitReset}
            label={`${title} limit edited; reset to config`}
          />
        ) : null}
        <span className="ml-auto inline-flex items-center gap-1.5 font-mono tabular-nums">
          {usd(total)}
          <span className="text-muted-foreground">/</span>
          {onLimitChange ? (
            <NumberField
              ariaLabel={`${title} limit`}
              prefix="$"
              className={cn(INLINE, "w-24")}
              value={Math.round(limit)}
              onChange={(v) => onLimitChange(Math.max(0, v))}
            />
          ) : (
            usd(limit)
          )}
        </span>
      </div>
      {children}
    </section>
  )
}

/** A row that opens into an editor. The whole row is the toggle; the edited
 * dot and remove button sit above it. */
export function ContributionRow({
  label,
  summary,
  total,
  edited,
  onReset,
  onRemove,
  defaultOpen = false,
  children,
}: {
  label: string
  summary: React.ReactNode
  total?: number
  edited?: boolean
  onReset?: () => void
  onRemove?: () => void
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(defaultOpen)
  const id = React.useId()
  return (
    <div className="flex flex-col">
      <div className="relative -mx-1.5 flex min-h-9 items-center gap-1.5 rounded-md px-1.5 text-xs hover:bg-muted/50 md:min-h-7">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((o) => !o)}
          className="flex shrink-0 items-center gap-1 rounded-sm outline-none after:absolute after:inset-0 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <ChevronRight
            size={12}
            className={cn(
              "text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
              open && "rotate-90"
            )}
          />
          <span className="w-16 text-left">{label}</span>
        </button>
        {edited && onReset ? (
          <span className="relative z-[1] flex">
            <EditedDot
              onReset={onReset}
              label={`${label} edited; reset to config`}
            />
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {summary}
        </span>
        {total != null ? (
          <span className="font-mono tabular-nums">{usd(total)}</span>
        ) : null}
        {onRemove ? (
          <button
            type="button"
            aria-label={`Remove ${label}`}
            onClick={onRemove}
            className="relative z-[1] -mr-1 flex size-6 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X size={12} />
          </button>
        ) : null}
      </div>
      {open ? (
        <div id={id} className="mt-1 mb-2 ml-1 border-l pl-3">
          {children}
        </div>
      ) : null}
    </div>
  )
}

/** A read-only line in a group (employer money, a note). */
function StaticRow({
  label,
  summary,
  total,
}: {
  label: string
  summary: string
  total?: number
}) {
  return (
    <div className="flex min-h-9 items-center gap-1.5 text-xs md:min-h-7">
      <span className="w-16 shrink-0 pl-4 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {summary}
      </span>
      {total != null ? (
        <span className="font-mono text-muted-foreground tabular-nums">
          {usd(total)}
        </span>
      ) : null}
    </div>
  )
}

/** Dated changes: the latest one on or before a month applies. Controlled;
 * `renderPhase` draws one change's editor. */
export function Schedule<T extends { from: string }>({
  value,
  onValueChange,
  renderPhase,
  newPhase,
  min,
  max,
  name,
}: {
  value: T[]
  onValueChange: (next: T[]) => void
  renderPhase: (
    phase: T,
    set: (next: T) => void,
    index: number
  ) => React.ReactNode
  /** A new change starting in `from`, usually a copy of the last one. */
  newPhase: (from: string, last: T | undefined) => T
  min: string
  max: string
  /** What is being scheduled, for labels ("Pre-tax 401k"). */
  name: string
}) {
  const [error, setError] = React.useState<{ i: number; text: string } | null>(
    null
  )
  const sorted = (list: T[]) =>
    [...list].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
  const taken = new Set(value.map((p) => p.from))
  // The next free month for a new change: the January after the last one,
  // else the month after it, inside the horizon.
  const last = value.at(-1)
  const candidates = last
    ? [`${Number(last.from.slice(0, 4)) + 1}-01`, addMonths(last.from, 1)]
    : [min]
  let next = candidates.find((m) => m >= min && m <= max && !taken.has(m))
  if (!next && last)
    for (let m = addMonths(last.from, 1); m <= max; m = addMonths(m, 1))
      if (m >= min && !taken.has(m)) {
        next = m
        break
      }

  return (
    <div className="flex flex-col gap-2.5">
      {value.map((phase, i) => (
        <div
          key={`${phase.from}-${i}`}
          className={cn("flex flex-col gap-1.5", i > 0 && "border-t pt-2.5")}
        >
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">From</span>
            {i === 0 ? (
              <span>{monthLabel(phase.from)}</span>
            ) : (
              <>
                <MonthField
                  ariaLabel={`${name}: change starts`}
                  className="w-36"
                  value={phase.from}
                  min={min}
                  max={max}
                  onChange={(from) => {
                    if (from === phase.from) return
                    if (taken.has(from)) {
                      setError({
                        i,
                        text: `Another change already starts ${monthLabel(from)}.`,
                      })
                      return
                    }
                    setError(null)
                    onValueChange(
                      sorted(
                        value.map((p, j) => (j === i ? { ...p, from } : p))
                      )
                    )
                  }}
                />
                <button
                  type="button"
                  aria-label={`Remove the change from ${monthLabel(phase.from)}`}
                  onClick={() => {
                    setError(null)
                    onValueChange(value.filter((_, j) => j !== i))
                  }}
                  className="ml-auto flex size-9 items-center justify-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 md:size-7"
                >
                  <X size={12} />
                </button>
              </>
            )}
          </div>
          {error?.i === i ? (
            <span
              role="alert"
              className="text-rose-600 text-xs dark:text-rose-400"
            >
              {error.text}
            </span>
          ) : null}
          {renderPhase(
            phase,
            (p) => onValueChange(value.map((x, j) => (j === i ? p : x))),
            i
          )}
        </div>
      ))}
      {next ? (
        <button
          type="button"
          onClick={() => {
            setError(null)
            onValueChange(sorted([...value, newPhase(next as string, last)]))
          }}
          className="inline-flex h-9 items-center gap-1 self-start rounded-sm text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 md:h-7"
        >
          <Plus size={12} />
          Add change
        </button>
      ) : null}
    </div>
  )
}

// --------------------------------------------------------------- pace field

type Amount = "max" | "amount" | "percent" | "off"

function amountOf(p: Pace): Amount {
  switch (p.pace) {
    case "even":
    case "front_load":
      return "max"
    case "fixed":
      return "amount"
    case "percent":
      return "percent"
    case "lump":
      return p.amount == null ? "max" : "amount"
    case "off":
      return "off"
  }
}

const isMonthly = (p: Pace) => p.pace === "even" || p.pace === "fixed"

function MonthSelect({
  value,
  onChange,
  ariaLabel,
}: {
  value: number
  onChange: (m: number) => void
  ariaLabel: string
}) {
  return (
    <select
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-9 rounded-md border border-input bg-transparent px-1.5 text-base outline-none focus-visible:border-ring md:h-7 md:text-xs dark:bg-input/30"
    >
      {MONTHS.map((m, i) => (
        <option key={m} value={i + 1}>
          {m}
        </option>
      ))}
    </select>
  )
}

/** How much, then when. Two short choices instead of one six-way control:
 * payroll is Max / Amount / Percent / Off, then Even or Early for Max;
 * direct is Max / Amount / Off, then once a year or monthly. Values typed
 * for one choice come back when you return to it. */
export function PaceField({
  value,
  onValueChange,
  channel,
  showSplit,
  name,
}: {
  value: Pace
  onValueChange: (next: Pace) => void
  channel: Channel
  /** Another stream in the account also takes "Max": show this one's share. */
  showSplit?: boolean
  name: string
}) {
  const memory = React.useRef<Partial<Record<PaceKind, Pace>>>({})
  memory.current[value.pace] = value
  const recall = <K extends PaceKind>(kind: K, fallback: Pace): Pace =>
    memory.current[kind] ?? fallback

  const amount = amountOf(value)
  const monthly = isMonthly(value)
  const pickAmount = (a: Amount) => {
    if (a === amount) return
    if (a === "off") return onValueChange({ pace: "off" })
    if (channel === "payroll") {
      if (a === "max")
        return onValueChange(
          memory.current.even ??
            memory.current.front_load ?? { pace: "even", share: 1, capPct: 0.5 }
        )
      if (a === "percent")
        return onValueChange(recall("percent", { pace: "percent", pct: 0.1 }))
      return onValueChange(
        recall("fixed", {
          pace: "fixed",
          amount: 500,
          per: "paycheck",
          paycheckOfMonth: null,
        })
      )
    }
    // Direct: keep the timing (once a year or monthly) across Max and Amount.
    const month = value.pace === "lump" ? value.month : 1
    if (a === "max")
      return onValueChange(
        monthly
          ? recall("even", { pace: "even", share: 1, capPct: 1 })
          : { pace: "lump", month, amount: null }
      )
    return onValueChange(
      monthly
        ? recall("fixed", {
            pace: "fixed",
            amount: 500,
            per: "month",
            paycheckOfMonth: null,
          })
        : { pace: "lump", month, amount: 1000 }
    )
  }

  const pctField = (
    label: string,
    v: number,
    set: (n: number) => void,
    suffix: string,
    width = "w-20"
  ) => (
    <NumberField
      ariaLabel={`${name}: ${label}`}
      suffix={suffix}
      className={cn(INLINE, width)}
      value={Number((v * 100).toFixed(2))}
      onChange={(n) => set(Math.max(0, Math.min(100, n)) / 100)}
    />
  )

  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<Amount>
          ariaLabel={`${name}: how much`}
          value={amount}
          onChange={pickAmount}
          className="h-9 md:h-7"
          options={
            channel === "payroll"
              ? [
                  { value: "max", label: "Max" },
                  { value: "amount", label: "Amount" },
                  { value: "percent", label: "Percent" },
                  { value: "off", label: "Off" },
                ]
              : [
                  { value: "max", label: "Max" },
                  { value: "amount", label: "Amount" },
                  { value: "off", label: "Off" },
                ]
          }
        />
        {value.pace === "fixed" ? (
          <NumberField
            ariaLabel={`${name}: amount`}
            prefix="$"
            suffix={
              channel === "direct" || value.per === "month" ? "/mo" : "/check"
            }
            className={cn(INLINE, "w-32")}
            value={value.amount}
            onChange={(v) =>
              onValueChange({ ...value, amount: Math.max(0, v) })
            }
          />
        ) : value.pace === "percent" ? (
          pctField(
            "percent of pay",
            value.pct,
            (v) => onValueChange({ ...value, pct: v }),
            "% of pay",
            "w-32"
          )
        ) : value.pace === "lump" && value.amount != null ? (
          <NumberField
            ariaLabel={`${name}: amount`}
            prefix="$"
            className={cn(INLINE, "w-28")}
            value={value.amount}
            onChange={(v) =>
              onValueChange({ ...value, amount: Math.max(0, v) })
            }
          />
        ) : null}
      </div>

      {channel === "payroll" &&
      (value.pace === "even" || value.pace === "front_load") ? (
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <Segmented<"even" | "front_load">
            ariaLabel={`${name}: when`}
            value={value.pace}
            onChange={(pace) => onValueChange({ ...value, pace })}
            className="h-9 md:h-7"
            options={[
              { value: "even", label: "Even" },
              { value: "front_load", label: "Early" },
            ]}
          />
          <span className="inline-flex items-center gap-1.5">
            up to
            {pctField(
              "most of each check",
              value.capPct,
              (v) => onValueChange({ ...value, capPct: v }),
              "%"
            )}
            of a check
          </span>
        </div>
      ) : null}

      {channel === "direct" && value.pace !== "off" ? (
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <Segmented<"once" | "monthly">
            ariaLabel={`${name}: when`}
            value={monthly ? "monthly" : "once"}
            className="h-9 md:h-7"
            onChange={(when) => {
              if ((when === "monthly") === monthly) return
              if (when === "monthly")
                onValueChange(
                  amount === "max"
                    ? { pace: "even", share: 1, capPct: 1 }
                    : {
                        pace: "fixed",
                        amount:
                          value.pace === "lump" && value.amount != null
                            ? Math.round(value.amount / 12)
                            : 500,
                        per: "month",
                        paycheckOfMonth: null,
                      }
                )
              else
                onValueChange({
                  pace: "lump",
                  month: 1,
                  amount:
                    value.pace === "fixed"
                      ? Math.round(value.amount * 12)
                      : null,
                })
            }}
            options={[
              { value: "once", label: "Once a year" },
              { value: "monthly", label: "Monthly" },
            ]}
          />
          {value.pace === "lump" ? (
            <span className="inline-flex items-center gap-1.5">
              in
              <MonthSelect
                ariaLabel={`${name}: deposit month`}
                value={value.month}
                onChange={(month) => onValueChange({ ...value, month })}
              />
            </span>
          ) : null}
        </div>
      ) : null}

      {showSplit && (value.pace === "even" || value.pace === "front_load") ? (
        <div className="flex items-center gap-1.5 text-muted-foreground">
          takes
          {pctField(
            "share of the limit",
            value.share,
            (v) => onValueChange({ ...value, share: v }),
            "%"
          )}
          of the room left
        </div>
      ) : null}
    </div>
  )
}

// ----------------------------------------------------------------- section

const TIER_LABEL: Record<HsaTier, string> = {
  self: "Self-only",
  family: "Family",
  none: "No HDHP",
}

const KINDS: {
  account: ContributionAccount
  tax: TaxTreatment
  channel: Channel
  label: string
}[] = [
  {
    account: "k401",
    tax: "traditional",
    channel: "payroll",
    label: "401k, pre-tax",
  },
  { account: "k401", tax: "roth", channel: "payroll", label: "401k, Roth" },
  {
    account: "hsa",
    tax: "traditional",
    channel: "payroll",
    label: "HSA, from payroll",
  },
  {
    account: "hsa",
    tax: "traditional",
    channel: "direct",
    label: "HSA, direct deposit",
  },
  { account: "ira", tax: "roth", channel: "direct", label: "IRA, Roth" },
  {
    account: "ira",
    tax: "traditional",
    channel: "direct",
    label: "IRA, traditional",
  },
]

const isMax = (p: Pace) => p.pace === "even" || p.pace === "front_load"

/** What a schedule does across one year: the pace in force in January, then
 * each change inside the year ("10% of pay → Max, even from Jul"). `first` is
 * the plan's first month. */
function yearSummary<T extends { from: string }>(
  schedule: T[],
  year: string,
  first: string,
  text: (p: T) => string,
  none: string
): string {
  // The plan's first month stands in for January in its first year.
  const base = `${year}-01` > first ? `${year}-01` : first
  const start = phaseAt(schedule, base)
  const inside = schedule
    .filter((p) => p.from > base && p.from <= `${year}-12`)
    .sort((a, b) => (a.from < b.from ? -1 : 1))
  const parts: string[] = []
  let prev: string | null = null
  for (const p of [...(start ? [start] : []), ...inside]) {
    const t = text(p)
    if (t === prev) continue
    parts.push(
      p === start ? t : `${t} from ${MONTHS[Number(p.from.slice(5)) - 1]}`
    )
    prev = t
  }
  return parts.length ? parts.join(" → ") : none
}

export function ContributionsSection({
  inputs,
  config,
  result,
  onChange,
}: {
  inputs: RunwayInputs
  /** The saved version of the same plan (for the unsaved dots). */
  config: RunwayInputs
  result: RunwayResult
  onChange: (next: RunwayInputs) => void
}) {
  const p = inputs.person
  const c = config.person
  const months = monthSpan(inputs.horizon.start, inputs.horizon.months)
  const first = months[0] ?? inputs.horizon.start
  const last = months.at(-1) ?? first
  const years = [...new Set(months.map((m) => m.slice(0, 4)))]
  // Open on the first year with enough of it left to plan around.
  const [picked, setYear] = React.useState(() =>
    Number(first.slice(5)) >= 11 && years[1] ? years[1] : years[0]
  )
  const year = years.includes(picked) ? picked : years[0]
  const pools = result.pools[year]

  const setP = (patch: Partial<RunwayPerson>) =>
    onChange({ ...inputs, person: { ...p, ...patch } })
  const setStream = (id: string, next: Contribution) =>
    setP({
      contributions: p.contributions.map((x) => (x.id === id ? next : x)),
    })

  const missing = KINDS.filter(
    (k) =>
      !p.contributions.some(
        (x) =>
          x.account === k.account && x.tax === k.tax && x.channel === k.channel
      )
  )

  const shownAccounts = CONTRIBUTION_ACCOUNTS.filter(
    (a) =>
      p.contributions.some((x) => x.account === a) ||
      (a === "hsa" && (pools?.hsa.employer ?? 0) > 0)
  )
  const overCount = shownAccounts.filter(
    (a) => (pools?.[a].excess ?? 0) > 0
  ).length
  const summary = shownAccounts.length
    ? [
        ...shownAccounts.map(
          (a) => `${ACCOUNT_LABEL[a]} ${usdShort(pools?.[a].contributed ?? 0)}`
        ),
        overCount ? `${overCount} over limit` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "None"

  const limitNow = limitsFor(p.limits, Number(year))
  const limitCfg = limitsFor(c.limits, Number(year))
  // Only the edited key is written for that year; the rest stays as given
  // (or from the IRS table).
  const setLimit = (key: "k401" | "ira", v: number) => {
    const limitsGiven = {
      ...p.limitsGiven,
      [year]: { ...(p.limitsGiven[year] ?? {}), [key]: v },
    }
    setP({
      limitsGiven,
      limits: resolveLimits(limitsGiven, first, p.birthYear),
    })
  }
  const jobsWithMatch = p.jobs.filter((j) => j.enabled)
  const hsaEmployers = p.jobs.filter((j) => j.enabled && j.hsaEmployer)

  const coverageNow: HsaCoverage[] = p.hsaCoverage.length
    ? p.hsaCoverage
    : [{ from: `${first.slice(0, 4)}-01`, tier: "self" }]

  const group = (a: ContributionAccount) => {
    const pool = pools?.[a]
    if (!pool) return null
    const streams = p.contributions.filter((x) => x.account === a)
    const maxStreams = streams.filter((x) => x.schedule.some(isMax)).length
    const segments: MeterSegment[] = [
      { label: "Before today", value: pool.before, tone: "before" },
      ...streams.map(
        (x): MeterSegment => ({
          label: streamLabel(x),
          value: pool.streams[x.id] ?? 0,
          tone: x.tax === "roth" ? "roth" : "traditional",
        })
      ),
      { label: "Employer", value: pool.employer, tone: "employer" },
    ]
    const limitKey = a === "hsa" ? null : a
    return (
      <ContributionGroup
        key={a}
        title={ACCOUNT_LABEL[a]}
        total={pool.contributed}
        limit={pool.limit}
        onLimitChange={limitKey ? (v) => setLimit(limitKey, v) : undefined}
        limitEdited={
          limitKey ? limitNow[limitKey] !== limitCfg[limitKey] : false
        }
        onLimitReset={
          limitKey ? () => setLimit(limitKey, limitCfg[limitKey]) : undefined
        }
        limitInfo={
          a === "hsa"
            ? "One twelfth of the yearly limit for each month covered by an HDHP on the 1st. Employer money counts toward it."
            : a === "k401"
              ? "Pre-tax and Roth deferrals share this limit, across every employer in the year. The employer match does not count toward it."
              : "Roth and traditional IRA deposits share this limit."
        }
      >
        <LimitMeter
          limit={pool.limit}
          segments={segments}
          token={SLEEVE_TOKEN[a]}
          label={`${ACCOUNT_LABEL[a]} limit, ${year}`}
        />
        <PoolStatus pool={pool} account={a} year={year} />
        <div className="flex flex-col">
          {streams.map((x) => {
            const cfg = c.contributions.find((y) => y.id === x.id)
            const name = `${streamLabel(x)} ${ACCOUNT_LABEL[a]}`
            return (
              <ContributionRow
                key={x.id}
                label={streamLabel(x)}
                summary={yearSummary(
                  x.schedule,
                  year,
                  first,
                  (ph) => paceSummary(ph, x.channel),
                  "Nothing set"
                )}
                total={(pool.streams[x.id] ?? 0) + (x.ytd[year] ?? 0)}
                edited={cfg ? !same(x, cfg) : false}
                onReset={cfg ? () => setStream(x.id, cfg) : undefined}
                onRemove={() =>
                  setP({
                    contributions: p.contributions.filter((y) => y.id !== x.id),
                  })
                }
                defaultOpen={!cfg}
              >
                <Schedule<Phase>
                  name={name}
                  value={x.schedule}
                  min={first}
                  max={last}
                  onValueChange={(schedule) =>
                    setStream(x.id, { ...x, schedule })
                  }
                  newPhase={(from, prev) =>
                    prev
                      ? { ...prev, from }
                      : x.channel === "payroll"
                        ? { from, pace: "even", share: 1, capPct: 0.5 }
                        : { from, pace: "lump", month: 1, amount: null }
                  }
                  renderPhase={(phase, set) => (
                    <PaceField
                      name={name}
                      channel={x.channel}
                      showSplit={
                        maxStreams > 1 || (isMax(phase) && phase.share < 1)
                      }
                      value={phase}
                      onValueChange={(pace) =>
                        set({ from: phase.from, ...pace })
                      }
                    />
                  )}
                />
              </ContributionRow>
            )
          })}
          {pool.employer > 0 ? (
            <StaticRow
              label="Employer"
              summary={
                hsaEmployers.length
                  ? hsaEmployers
                      .map((j) =>
                        j.hsaEmployer
                          ? `${j.employer} ${usd(j.hsaEmployer.amount)} each ${MONTHS[j.hsaEmployer.month - 1]}`
                          : ""
                      )
                      .join(" · ")
                  : "From the job"
              }
              total={pool.employer}
            />
          ) : null}
          {a === "hsa" ? (
            <ContributionRow
              label="Coverage"
              summary={yearSummary(
                coverageNow,
                year,
                first,
                (x) => TIER_LABEL[x.tier],
                TIER_LABEL.none
              )}
              edited={!same(p.hsaCoverage, c.hsaCoverage)}
              onReset={() => setP({ hsaCoverage: c.hsaCoverage })}
            >
              <div className="flex flex-col gap-2.5">
                <Schedule<HsaCoverage>
                  name="HDHP coverage"
                  value={coverageNow}
                  min={first}
                  max={last}
                  onValueChange={(hsaCoverage) => setP({ hsaCoverage })}
                  newPhase={(from, prev) => ({
                    from,
                    tier: prev?.tier === "none" ? "self" : "none",
                  })}
                  renderPhase={(phase, set) => (
                    <Segmented<HsaTier>
                      ariaLabel={`HDHP coverage from ${monthLabel(phase.from)}`}
                      value={phase.tier}
                      onChange={(tier) => set({ ...phase, tier })}
                      className="h-9 self-start md:h-7"
                      options={[
                        { value: "self", label: TIER_LABEL.self },
                        { value: "family", label: TIER_LABEL.family },
                        { value: "none", label: TIER_LABEL.none },
                      ]}
                    />
                  )}
                />
                <p className="text-pretty text-muted-foreground text-xs">
                  Covered means on an HDHP on the 1st of the month. Nothing goes
                  in during months without it.
                </p>
              </div>
            </ContributionRow>
          ) : null}
        </div>
        {a === "k401" ? (
          <p className="text-pretty text-muted-foreground text-xs">
            {jobsWithMatch.length
              ? jobsWithMatch
                  .map(
                    (j) =>
                      `${j.employer} match: ${matchText(j.match)}${
                        j.vesting
                          ? `, vests ${monthLabel(j.vesting.date.slice(0, 7))}`
                          : ""
                      }.`
                  )
                  .join(" ")
              : "No job, so no match."}
          </p>
        ) : null}
      </ContributionGroup>
    )
  }

  return (
    <InputsSection
      title="Contributions"
      hint="What goes into tax-advantaged accounts, against each year's limit."
      summary={summary}
    >
      <div className="flex flex-col gap-4 @md:col-span-2">
        {years.length > 1 ? (
          <Segmented<string>
            ariaLabel="Year"
            value={year}
            onChange={setYear}
            className="h-9 self-start md:h-7"
            options={years.map((y) => ({ value: y, label: y }))}
          />
        ) : null}

        {shownAccounts.length === 0 ? (
          <p className="text-pretty text-muted-foreground text-xs">
            No contributions in config. Add one to see its effect on take-home
            and its limit.
          </p>
        ) : null}
        {shownAccounts.map(group)}

        <div className="flex items-center gap-3 text-xs">
          {missing.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex h-9 items-center gap-1 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 md:h-7">
                <Plus size={12} />
                Add contribution
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-auto min-w-44">
                {missing.map((k) => (
                  <DropdownMenuItem
                    key={k.label}
                    className="text-xs"
                    onClick={() =>
                      setP({
                        contributions: [
                          ...p.contributions,
                          newContribution(
                            k.account,
                            k.tax,
                            k.channel,
                            first,
                            p.contributions.map((x) => x.id)
                          ),
                        ],
                      })
                    }
                  >
                    {k.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
    </InputsSection>
  )
}
