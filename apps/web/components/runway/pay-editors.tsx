"use client"

// Editors for the pay settings a person sets once and a job can override:
// pay schedule, payroll deductions and withholding, plus the job-only HSA
// employer money. Used by the jobs card's "Pay defaults" and by each job's
// "Pay overrides". Also holds the small helpers the jobs editor shares:
// marker math, local list keys, icon buttons with phone-sized hit areas.

import { ChevronRight, Plus, X } from "lucide-react"
import * as React from "react"

import { NumberField, pct, Segmented, Toggle } from "@/components/fire/controls"
import { formatMoney } from "@/lib/format"
import { deepEqual } from "@/lib/runway/patch"
import type {
  Deduction,
  PaySchedule,
  StateCode,
  Withholding,
} from "@/lib/runway/types"
import { cn } from "@/lib/utils"

import { type Fallback, FIELD, Field, MONTHS } from "./fields"

// ------------------------------------------------------------------ helpers

/** "Nov 2026". */
export function monLong(m: string | null | undefined): string {
  if (!m) return ""
  return `${MONTHS[Number(m.slice(5, 7)) - 1] ?? ""} ${m.slice(0, 4)}`
}

/** "Nov". */
export function monName(m: string): string {
  return MONTHS[Number(m.slice(5, 7)) - 1] ?? ""
}

export function money(v: number): string {
  return formatMoney(v, { maximumFractionDigits: 2 })
}

/** A percent as typed into a field: 0.04 -> 4. */
export function pctIn(v: number): number {
  return Number((v * 100).toFixed(4))
}

/** A reference value that may itself be null (a job's open `leave`, say),
 * so "no reference" needs its own wrapper. */
export interface Box<T> {
  v: T
}

export function box<O, T>(
  o: O | null | undefined,
  f: (o: O) => T
): Box<T> | null {
  return o == null ? null : { v: f(o) }
}

/** The dot and fallback props for one field: dot when the value differs
 * from the saved one, "Plan: value" when it differs from the plan. */
export function marks<T>(
  cur: T,
  saved: Box<T> | null,
  base: Box<T> | null,
  set: (v: T) => void,
  fmt: (v: T) => string
): { edited: boolean; onReset: () => void; fallback: Fallback | null } {
  return {
    edited: saved != null && !deepEqual(cur, saved.v),
    onReset: () => {
      if (saved) set(structuredClone(saved.v))
    },
    fallback:
      base != null && !deepEqual(cur, base.v)
        ? {
            source: "Plan",
            text: fmt(base.v),
            onReset: () => set(structuredClone(base.v)),
          }
        : null,
  }
}

/** The first message at `path` or below it. */
export function errUnder(
  errors: Record<string, string>,
  path: string
): string | undefined {
  for (const [k, msg] of Object.entries(errors)) {
    if (k === path || k.startsWith(`${path}.`) || k.startsWith(`${path}[`))
      return msg
  }
  return undefined
}

/** Stable keys for a list whose items carry no id (steps, deductions,
 * tiers). Callers keep them in step with their own edits; any other length
 * change appends or trims at the end. */
export function useLocalKeys(n: number) {
  const ref = React.useRef<string[]>([])
  const counter = React.useRef(0)
  const make = () => {
    counter.current += 1
    return `k${counter.current}`
  }
  while (ref.current.length < n) ref.current.push(make())
  if (ref.current.length > n) ref.current = ref.current.slice(0, n)
  return {
    keys: ref.current,
    append: () => {
      const k = make()
      ref.current = [...ref.current, k]
      return k
    },
    remove: (i: number) => {
      ref.current = ref.current.filter((_, j) => j !== i)
    },
    /** Reorder: `order[i]` is the old index now at `i`. */
    permute: (order: number[]) => {
      const old = ref.current
      ref.current = order.map((i) => old[i])
    },
  }
}

export function finePointer(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: fine)").matches
  )
}

/** Disables every control inside when `disabled` (read-only person). */
export function Lock({
  disabled,
  className,
  children,
}: {
  disabled: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <fieldset
      disabled={disabled}
      className={cn("m-0 min-w-0 border-0 p-0", className)}
    >
      {children}
    </fieldset>
  )
}

/** 24px icon button; 44px hit area on touch. Never hover-revealed. */
export function IconButton({
  label,
  onClick,
  disabled,
  title,
  className,
  children,
  ...rest
}: {
  label: string
  onClick: () => void
  /** Rendered as aria-disabled so it stays focusable and can explain why. */
  disabled?: boolean
  title?: string
  className?: string
  children: React.ReactNode
} & Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick" | "disabled" | "children"
>) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={disabled || undefined}
      title={title}
      onClick={() => {
        if (!disabled) onClick()
      }}
      className={cn(
        "relative flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none before:absolute before:-inset-1 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 aria-disabled:hover:text-muted-foreground pointer-coarse:before:-inset-2.5",
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

/** The switch with a 44px hit area on touch: a tap on the padding flips it. */
export function HitToggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <span
      className="relative inline-flex shrink-0 items-center pointer-coarse:before:absolute pointer-coarse:before:-inset-x-2 pointer-coarse:before:-inset-y-3.5"
      onClick={(e) => {
        if (e.target === e.currentTarget) onChange(!checked)
      }}
    >
      <Toggle checked={checked} onChange={onChange} label={label} />
    </span>
  )
}

/** "+ Add x": a text button, 36px on phones, 28px from md. */
export function AddButton({
  children,
  onClick,
  ...rest
}: {
  children: React.ReactNode
  onClick: () => void
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick">) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-9 w-fit items-center gap-1 rounded-md px-1.5 text-muted-foreground text-xs outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.97] md:h-7"
      {...rest}
    >
      <Plus size={12} aria-hidden="true" />
      {children}
    </button>
  )
}

/** Checkbox and its words in one label: the whole row is clickable. */
export function CheckRow({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  children: React.ReactNode
}) {
  return (
    <label className="flex min-h-9 w-fit cursor-pointer items-center gap-2 text-xs md:min-h-7">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-primary md:size-3.5"
      />
      {children}
    </label>
  )
}

export const TEXT_INPUT = cn(
  FIELD,
  "min-w-0 rounded-md border border-input bg-transparent px-2 outline-none placeholder:text-muted-foreground focus-visible:border-ring disabled:opacity-60 dark:bg-input/30"
)

// -------------------------------------------------------------- summaries

const STATE_LABEL: Record<StateCode, string> = {
  ny: "NY",
  ny_nonresident: "NY nonresident",
  nj: "NJ",
  none: "no state tax",
}

const STATE_OPTIONS: { value: StateCode; label: string }[] = [
  { value: "ny", label: "NY" },
  { value: "ny_nonresident", label: "NY nonresident" },
  { value: "nj", label: "NJ" },
  { value: "none", label: "None" },
]

function dayText(d: number): string {
  if (d === -1) return "last"
  const tens = d % 100
  const suffix =
    tens >= 11 && tens <= 13 ? "th" : (["th", "st", "nd", "rd"][d % 10] ?? "th")
  return `${d}${suffix}`
}

/** "semimonthly 15th and last", "biweekly from 2026-11-07". */
export function scheduleText(s: PaySchedule | null): string {
  if (!s) return "no schedule"
  if (s.frequency === "biweekly")
    return s.anchor ? `biweekly from ${s.anchor}` : "biweekly"
  return `semimonthly ${s.days.map(dayText).join(" and ")}`
}

export function deductionsText(d: Deduction[]): string {
  if (!d.length) return "no deductions"
  return d.length === 1 ? "1 deduction" : `${d.length} deductions`
}

export function withholdingText(w: Withholding): string {
  return `${w.filing}, ${STATE_LABEL[w.state]}`
}

export const DEFAULT_SCHEDULE: PaySchedule = {
  frequency: "semimonthly",
  anchor: null,
  days: [15, -1],
}

// --------------------------------------------------------------- schedule

export function ScheduleEditor({
  value,
  onChange,
  errors,
  path,
  readOnly,
}: {
  value: PaySchedule
  onChange: (next: PaySchedule) => void
  errors: Record<string, string>
  /** Body path of this schedule, for error lookup ("pay.schedule"). */
  path: string
  readOnly: boolean
}) {
  const uid = React.useId()
  const days = [value.days[0] ?? 15, value.days[1] ?? -1]
  const setDay = (i: number, d: number) => {
    const next = [...days]
    next[i] = d
    onChange({ ...value, days: next })
  }
  const clampDay = (v: number) => Math.min(31, Math.max(1, Math.round(v)))
  return (
    <Lock disabled={readOnly} className="flex flex-col gap-3">
      <Segmented
        ariaLabel="Pay frequency"
        className="h-9 w-full @md:w-fit md:h-7"
        optionClassName="flex-1"
        value={value.frequency}
        options={[
          { value: "biweekly", label: "Biweekly" },
          { value: "semimonthly", label: "Semimonthly" },
        ]}
        onChange={(frequency) => onChange({ ...value, frequency })}
      />
      {value.frequency === "biweekly" ? (
        <Field
          id={`${uid}-anchor`}
          label="Any real pay date"
          error={errors[`${path}.anchor`]}
        >
          <input
            id={`${uid}-anchor`}
            type="date"
            value={value.anchor ?? ""}
            onChange={(e) =>
              onChange({ ...value, anchor: e.target.value || null })
            }
            className={cn(TEXT_INPUT, "font-mono tabular-nums")}
          />
        </Field>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1">
          <Field id={`${uid}-d1`} label="Day 1">
            <NumberField
              id={`${uid}-d1`}
              ariaLabel="Day 1"
              className={FIELD}
              value={days[0] === -1 ? 31 : days[0]}
              onChange={(v) => setDay(0, clampDay(v))}
            />
          </Field>
          <Field id={`${uid}-d2`} label="Day 2">
            {days[1] === -1 ? (
              <span
                className={cn(
                  FIELD,
                  "flex items-center rounded-md border border-input border-dashed px-2 text-muted-foreground"
                )}
              >
                Last weekday
              </span>
            ) : (
              <NumberField
                id={`${uid}-d2`}
                ariaLabel="Day 2"
                className={FIELD}
                value={days[1]}
                onChange={(v) => setDay(1, clampDay(v))}
              />
            )}
          </Field>
          <span className="col-start-2">
            <CheckRow
              checked={days[1] === -1}
              onChange={(v) => setDay(1, v ? -1 : 30)}
            >
              Last weekday
            </CheckRow>
          </span>
        </div>
      )}
      {errors[`${path}.days`] || errors[path] ? (
        <span className="text-rose-600 text-xs dark:text-rose-400">
          {errors[`${path}.days`] ?? errors[path]}
        </span>
      ) : null}
    </Lock>
  )
}

// ------------------------------------------------------------- deductions

function deductionSummary(d: Deduction): string {
  return [
    `${money(d.amount)} /${d.per}`,
    d.pretax ? "pre-tax" : "after tax",
    d.ficaExempt ? "FICA exempt" : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

export function DeductionsEditor({
  value,
  onChange,
  errors,
  path,
  readOnly,
}: {
  value: Deduction[]
  onChange: (fn: (prev: Deduction[]) => Deduction[]) => void
  errors: Record<string, string>
  path: string
  readOnly: boolean
}) {
  const lk = useLocalKeys(value.length)
  const [open, setOpen] = React.useState<Set<string>>(() => new Set())
  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  // Rows with errors open themselves.
  React.useEffect(() => {
    const ks = lk.keys.filter((_, i) => errUnder(errors, `${path}[${i}]`))
    if (ks.length) setOpen((prev) => new Set([...prev, ...ks]))
  }, [errors, path, lk.keys])

  const set = (i: number, patch: Partial<Deduction>) =>
    onChange((prev) => prev.map((d, j) => (j === i ? { ...d, ...patch } : d)))

  return (
    <div className="flex flex-col">
      {value.length === 0 ? (
        <span className="py-1 text-muted-foreground text-xs">
          No payroll deductions.
        </span>
      ) : null}
      {value.map((d, i) => {
        const k = lk.keys[i]
        const isOpen = open.has(k)
        const bodyId = `${path}-${k}`
        const err = errUnder(errors, `${path}[${i}]`)
        return (
          <div key={k} className="flex flex-col">
            <div className="relative -mx-1.5 flex min-h-9 items-center gap-1.5 rounded-md px-1.5 text-xs hover:bg-muted/50 md:min-h-7">
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={bodyId}
                onClick={() => toggle(k)}
                className="flex min-w-0 shrink-0 items-center gap-1 rounded-sm outline-none after:absolute after:inset-0 focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <ChevronRight
                  size={12}
                  aria-hidden="true"
                  className={cn(
                    "text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none",
                    isOpen && "rotate-90"
                  )}
                />
                <span className="max-w-[10rem] truncate text-left">
                  {d.label || "Untitled"}
                </span>
              </button>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  err
                    ? "text-rose-600 dark:text-rose-400"
                    : "text-muted-foreground"
                )}
              >
                {err ?? deductionSummary(d)}
              </span>
              {readOnly ? null : (
                <IconButton
                  label={`Remove ${d.label || "deduction"}`}
                  className="relative z-[1] -mr-1"
                  onClick={() => {
                    lk.remove(i)
                    onChange((prev) => prev.filter((_, j) => j !== i))
                  }}
                >
                  <X size={12} aria-hidden="true" />
                </IconButton>
              )}
            </div>
            {isOpen ? (
              <Lock
                disabled={readOnly}
                className="mt-1 mb-2 ml-1 border-l pl-3"
              >
                <div
                  id={bodyId}
                  className="grid gap-x-4 gap-y-3 @md:grid-cols-2"
                >
                  <Field
                    id={`${bodyId}-label`}
                    label="Label"
                    error={errors[`${path}[${i}].label`]}
                  >
                    <input
                      id={`${bodyId}-label`}
                      value={d.label}
                      autoComplete="off"
                      spellCheck={false}
                      data-1p-ignore
                      onChange={(e) => set(i, { label: e.target.value })}
                      className={TEXT_INPUT}
                    />
                  </Field>
                  <Field
                    id={`${bodyId}-amount`}
                    label="Amount"
                    error={errors[`${path}[${i}].amount`]}
                  >
                    <NumberField
                      id={`${bodyId}-amount`}
                      ariaLabel={`${d.label || "Deduction"} amount`}
                      prefix="$"
                      className={FIELD}
                      value={d.amount}
                      onChange={(v) => set(i, { amount: Math.max(0, v) })}
                    />
                  </Field>
                  <Field label="Per">
                    <Segmented
                      ariaLabel={`${d.label || "Deduction"} taken per`}
                      className="h-9 w-full md:h-7"
                      optionClassName="flex-1"
                      value={d.per}
                      options={[
                        { value: "paycheck", label: "Paycheck" },
                        { value: "month", label: "Month" },
                      ]}
                      onChange={(per) =>
                        set(i, {
                          per,
                          paycheckOfMonth:
                            per === "month" ? (d.paycheckOfMonth ?? 1) : null,
                        })
                      }
                    />
                  </Field>
                  {d.per === "month" ? (
                    <Field
                      id={`${bodyId}-nth`}
                      label="Paycheck of month"
                      error={errors[`${path}[${i}].paycheckOfMonth`]}
                    >
                      <NumberField
                        id={`${bodyId}-nth`}
                        ariaLabel="Paycheck of month"
                        className={FIELD}
                        value={d.paycheckOfMonth ?? 1}
                        onChange={(v) =>
                          set(i, {
                            paycheckOfMonth: Math.min(
                              3,
                              Math.max(1, Math.round(v))
                            ),
                          })
                        }
                      />
                    </Field>
                  ) : null}
                  <div className="flex flex-wrap gap-x-4 @md:col-span-2">
                    <CheckRow
                      checked={d.pretax}
                      onChange={(pretax) => set(i, { pretax })}
                    >
                      Pre-tax
                    </CheckRow>
                    <CheckRow
                      checked={d.ficaExempt}
                      onChange={(ficaExempt) => set(i, { ficaExempt })}
                    >
                      FICA exempt
                    </CheckRow>
                  </div>
                </div>
              </Lock>
            ) : null}
          </div>
        )
      })}
      {readOnly ? null : (
        <AddButton
          onClick={() => {
            const k = lk.append()
            setOpen((prev) => new Set([...prev, k]))
            onChange((prev) => [
              ...prev,
              {
                label: "Deduction",
                amount: 0,
                per: "paycheck",
                paycheckOfMonth: null,
                pretax: true,
                ficaExempt: false,
                sleeve: null,
              },
            ])
          }}
        >
          Add deduction
        </AddButton>
      )}
    </div>
  )
}

// ------------------------------------------------------------ withholding

export function WithholdingEditor({
  value,
  onChange,
  saved,
  base,
  errors,
  path,
  readOnly,
}: {
  value: Withholding
  onChange: (fn: (prev: Withholding) => Withholding) => void
  /** Saved and plan versions of the same withholding, for field markers. */
  saved: Withholding | null
  base: Withholding | null
  errors: Record<string, string>
  path: string
  readOnly: boolean
}) {
  const uid = React.useId()
  const id = (k: string) => `${uid}-${k}`
  const m = <K extends keyof Withholding>(
    k: K,
    fmt: (v: Withholding[K]) => string
  ) =>
    marks(
      value[k],
      box(saved, (w) => w[k]),
      box(base, (w) => w[k]),
      (v) => onChange((prev) => ({ ...prev, [k]: v })),
      fmt
    )
  const sp = value.statePayroll
  const setSp = (patch: Partial<Withholding["statePayroll"]>) =>
    onChange((prev) => ({
      ...prev,
      statePayroll: { ...prev.statePayroll, ...patch },
    }))
  const mSp = <K extends "flatPerPaycheck" | "rate" | "annualCap">(
    k: K,
    fmt: (v: Withholding["statePayroll"][K]) => string
  ) =>
    marks(
      sp[k],
      box(saved, (w) => w.statePayroll[k]),
      box(base, (w) => w.statePayroll[k]),
      (v) => setSp({ [k]: v }),
      fmt
    )
  const usd0 = (v: number) => formatMoney(v, { maximumFractionDigits: 0 })
  const e = (k: string) => errUnder(errors, `${path}.${k}`)
  return (
    <Lock disabled={readOnly} className="grid gap-x-4 gap-y-3 @md:grid-cols-2">
      <Field label="Filing" {...m("filing", (v) => v)} error={e("filing")}>
        <Segmented
          ariaLabel="Filing status"
          className="h-9 w-full md:h-7"
          optionClassName="flex-1"
          value={value.filing}
          options={[
            { value: "single", label: "Single" },
            { value: "joint", label: "Joint" },
          ]}
          onChange={(filing) => onChange((prev) => ({ ...prev, filing }))}
        />
      </Field>
      <Field
        id={id("fed")}
        label="Federal standard deduction"
        {...m("federalStd", usd0)}
        error={e("federalStd")}
      >
        <NumberField
          id={id("fed")}
          ariaLabel="Federal standard deduction"
          prefix="$"
          className={FIELD}
          value={value.federalStd}
          onChange={(v) =>
            onChange((prev) => ({ ...prev, federalStd: Math.max(0, v) }))
          }
        />
      </Field>
      <Field
        id={id("state")}
        label="State"
        {...m("state", (v) => STATE_LABEL[v])}
        error={e("state")}
      >
        <select
          id={id("state")}
          value={value.state}
          onChange={(ev) => {
            const state = ev.target.value as StateCode
            onChange((prev) => ({ ...prev, state }))
          }}
          className={TEXT_INPUT}
        >
          {STATE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
      <Field
        id={id("stateStd")}
        label="State standard deduction"
        {...m("stateStd", usd0)}
        error={e("stateStd")}
      >
        <NumberField
          id={id("stateStd")}
          ariaLabel="State standard deduction"
          prefix="$"
          className={FIELD}
          value={value.stateStd}
          onChange={(v) =>
            onChange((prev) => ({ ...prev, stateStd: Math.max(0, v) }))
          }
        />
      </Field>
      <Field
        id={id("spFlat")}
        label="State payroll, flat"
        {...mSp("flatPerPaycheck", money)}
        error={e("statePayroll.flatPerPaycheck")}
      >
        <NumberField
          id={id("spFlat")}
          ariaLabel="State payroll flat amount per paycheck"
          prefix="$"
          suffix="/paycheck"
          className={FIELD}
          value={sp.flatPerPaycheck}
          onChange={(v) => setSp({ flatPerPaycheck: Math.max(0, v) })}
        />
      </Field>
      <Field
        id={id("spRate")}
        label="State payroll, rate"
        {...mSp("rate", (v) => pct(v, 3))}
        error={e("statePayroll.rate")}
      >
        <NumberField
          id={id("spRate")}
          ariaLabel="State payroll rate"
          suffix="% of pay"
          className={FIELD}
          value={pctIn(sp.rate)}
          onChange={(v) => setSp({ rate: Math.max(0, v) / 100 })}
        />
      </Field>
      <Field
        id={id("spCap")}
        label="State payroll, annual cap"
        aside="0 = no cap"
        {...mSp("annualCap", (v) => (v == null ? "no cap" : money(v)))}
        error={e("statePayroll.annualCap")}
      >
        <NumberField
          id={id("spCap")}
          ariaLabel="State payroll annual cap"
          prefix="$"
          className={FIELD}
          value={sp.annualCap ?? 0}
          onChange={(v) => setSp({ annualCap: v > 0 ? v : null })}
        />
      </Field>
      <Field
        id={id("ss")}
        label="Social Security wage base"
        {...m("ssWageBase", usd0)}
        error={e("ssWageBase")}
      >
        <NumberField
          id={id("ss")}
          ariaLabel="Social Security wage base"
          prefix="$"
          className={FIELD}
          value={value.ssWageBase}
          onChange={(v) =>
            onChange((prev) => ({ ...prev, ssWageBase: Math.max(0, v) }))
          }
        />
      </Field>
    </Lock>
  )
}

// ------------------------------------------------------- HSA employer money

export type HsaEmployer = { amount: number; month: number }

export function HsaEmployerEditor({
  value,
  onChange,
  errors,
  path,
  readOnly,
}: {
  value: HsaEmployer
  onChange: (next: HsaEmployer) => void
  errors: Record<string, string>
  path: string
  readOnly: boolean
}) {
  const uid = React.useId()
  return (
    <Lock disabled={readOnly} className="grid grid-cols-2 gap-x-4 gap-y-3">
      <Field
        id={`${uid}-amt`}
        label="Amount a year"
        error={errors[`${path}.amount`]}
      >
        <NumberField
          id={`${uid}-amt`}
          ariaLabel="HSA employer money a year"
          prefix="$"
          className={FIELD}
          value={value.amount}
          onChange={(v) => onChange({ ...value, amount: Math.max(0, v) })}
        />
      </Field>
      <Field id={`${uid}-mon`} label="Paid in" error={errors[`${path}.month`]}>
        <select
          id={`${uid}-mon`}
          value={value.month}
          onChange={(e) =>
            onChange({ ...value, month: Number(e.target.value) })
          }
          className={TEXT_INPUT}
        >
          {MONTHS.map((name, i) => (
            <option key={name} value={i + 1}>
              {name}
            </option>
          ))}
        </select>
      </Field>
    </Lock>
  )
}
