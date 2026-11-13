// Contributions to tax-advantaged accounts: the rules every stream shares.
//
// A stream is one account (401k, IRA, HSA), one tax treatment and one channel
// (payroll or direct), with a dated schedule of paces. Streams in the same
// account share a pool, and the pool owns the annual limit. Everything here is
// pure; the engine walks the calendar and calls in.

import type {
  Channel,
  Contribution,
  ContributionAccount,
  HsaCoverage,
  HsaTier,
  Pace,
  PaceKind,
  Phase,
  TaxTreatment,
  YearLimits,
} from "./types"

/** IRS limits by year, used when the config gives none. A later year reuses
 * the latest one here, so add a row each January. */
export const DEFAULT_LIMITS: Record<
  string,
  YearLimits & { k401CatchUp: number; iraCatchUp: number; hsaCatchUp: number }
> = {
  2026: {
    k401: 24_500,
    k401CatchUp: 8_000,
    ira: 7_500,
    iraCatchUp: 1_100,
    hsaSelf: 4_400,
    hsaFamily: 8_750,
    hsaCatchUp: 1_000,
  },
}

function closest<T>(byYear: Record<string, T>, year: number): T | undefined {
  if (byYear[year] != null) return byYear[year]
  const known = Object.keys(byYear)
    .map(Number)
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b)
  const pick = known.filter((y) => y <= year).at(-1) ?? known[0]
  return pick != null ? byYear[pick] : undefined
}

/** The bundled limits for a year, with catch-up for the age reached in it
 * (50 for the 401k and IRA, 55 for the HSA). */
export function defaultLimits(
  year: number,
  birthYear: number | null
): YearLimits {
  const d = closest(DEFAULT_LIMITS, year)
  if (!d) return { k401: 0, ira: 0, hsaSelf: 0, hsaFamily: 0 }
  const age = birthYear != null ? year - birthYear : 0
  return {
    k401: d.k401 + (age >= 50 ? d.k401CatchUp : 0),
    ira: d.ira + (age >= 50 ? d.iraCatchUp : 0),
    hsaSelf: d.hsaSelf + (age >= 55 ? d.hsaCatchUp : 0),
    hsaFamily: d.hsaFamily + (age >= 55 ? d.hsaCatchUp : 0),
  }
}

/** Limits for a year, reusing the closest earlier year when it is missing. */
export function limitsFor(
  limits: Record<string, YearLimits>,
  year: number
): YearLimits {
  return closest(limits, year) ?? defaultLimits(year, null)
}

/** The latest phase whose `from` month is on or before `month`. */
export function phaseAt<T extends { from: string }>(
  schedule: T[],
  month: string
): T | null {
  let best: T | null = null
  for (const p of schedule)
    if (p.from <= month && (!best || p.from >= best.from)) best = p
  return best
}

/** HDHP coverage in a month. No schedule at all means self-only throughout;
 * months before the first entry are not covered. */
export function tierAt(coverage: HsaCoverage[], month: string): HsaTier {
  if (coverage.length === 0) return "self"
  return phaseAt(coverage, month)?.tier ?? "none"
}

/** Covered months in a year, by tier. With `knownThrough`, later months are
 * assumed to keep that month's coverage: the limit as payroll sees it on the
 * day, before a later change is known. */
export function coveredMonths(
  coverage: HsaCoverage[],
  year: number,
  knownThrough?: string
): { self: number; family: number } {
  const out = { self: 0, family: 0 }
  for (let m = 1; m <= 12; m++) {
    const month = `${year}-${String(m).padStart(2, "0")}`
    const at = knownThrough && month > knownThrough ? knownThrough : month
    const tier = tierAt(coverage, at)
    if (tier !== "none") out[tier]++
  }
  return out
}

/** The HSA limit for a year: one twelfth of the tier's limit per month
 * covered on the first of that month. */
export function hsaLimit(
  limits: YearLimits,
  coverage: HsaCoverage[],
  year: number,
  knownThrough?: string
): number {
  const n = coveredMonths(coverage, year, knownThrough)
  return (n.self * limits.hsaSelf + n.family * limits.hsaFamily) / 12
}

export function poolLimit(
  account: ContributionAccount,
  limits: Record<string, YearLimits>,
  coverage: HsaCoverage[],
  year: number,
  knownThrough?: string
): number {
  const l = limitsFor(limits, year)
  if (account === "hsa") return hsaLimit(l, coverage, year, knownThrough)
  return account === "k401" ? l.k401 : l.ira
}

/** How payroll treats a stream. Direct streams are paid from take-home cash,
 * so they are exempt from nothing on the paycheck. */
export function treatment(
  c: Pick<Contribution, "account" | "tax" | "channel">
): {
  incomeTaxExempt: boolean
  ficaExempt: boolean
} {
  if (c.channel !== "payroll")
    return { incomeTaxExempt: false, ficaExempt: false }
  if (c.account === "hsa") return { incomeTaxExempt: true, ficaExempt: true }
  return { incomeTaxExempt: c.tax === "traditional", ficaExempt: false }
}

export const CHANNELS: Record<ContributionAccount, Channel[]> = {
  k401: ["payroll"],
  hsa: ["payroll", "direct"],
  ira: ["direct"],
}

export const PACES: Record<Channel, PaceKind[]> = {
  payroll: ["off", "fixed", "percent", "even", "front_load"],
  direct: ["off", "fixed", "even", "lump"],
}

/** Whether a pace is allowed on a channel (percent needs a paycheck, a lump
 * needs a cash deposit). */
export function paceAllowed(pace: PaceKind, channel: Channel): boolean {
  return PACES[channel].includes(pace)
}

export interface PaceContext {
  gross: number
  /** 1-based position of the paycheck in its month. */
  paycheckOfMonth: number
  /** The pool's room before any stream took from it this period. */
  roomStart: number
  /** Periods left in the year, this one included. */
  left: number
}

/** What a payroll stream asks for on one paycheck, before the pool clips it. */
export function payrollWant(p: Pace, x: PaceContext): number {
  switch (p.pace) {
    case "off":
    case "lump":
      return 0
    case "fixed":
      if (p.per === "month" && (p.paycheckOfMonth ?? 1) !== x.paycheckOfMonth)
        return 0
      return Math.max(0, p.amount)
    case "percent":
      return Math.max(0, x.gross * p.pct)
    case "even":
      return Math.max(
        0,
        Math.min(
          (x.roomStart * p.share) / Math.max(1, x.left),
          x.gross * p.capPct
        )
      )
    case "front_load":
      return Math.max(0, Math.min(x.roomStart * p.share, x.gross * p.capPct))
  }
}

/** What a direct stream asks for in one month, before the pool clips it.
 * `monthOfYear` is 1..12; `left` counts the months left in the year. */
export function directWant(
  p: Pace,
  x: { monthOfYear: number; roomStart: number; left: number }
): number {
  switch (p.pace) {
    case "off":
    case "percent":
      return 0
    case "fixed":
      return Math.max(0, p.amount)
    case "lump":
      if (p.month !== x.monthOfYear) return 0
      return Math.max(0, p.amount ?? x.roomStart)
    case "even":
      return Math.max(0, (x.roomStart * p.share) / Math.max(1, x.left))
    case "front_load":
      return Math.max(0, x.roomStart * p.share)
  }
}

// ------------------------------------------------------------------ wording

export const ACCOUNT_LABEL: Record<ContributionAccount, string> = {
  k401: "401k",
  hsa: "HSA",
  ira: "IRA",
}

/** A stream's name inside its account group. */
export function streamLabel(
  c: Pick<Contribution, "account" | "tax" | "channel">
): string {
  if (c.account === "hsa") return c.channel === "payroll" ? "Payroll" : "Direct"
  if (c.tax === "roth") return "Roth"
  return c.account === "k401" ? "Pre-tax" : "Traditional"
}

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

const money = (v: number) =>
  `$${Math.round(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
const percent = (v: number) => `${Number((v * 100).toFixed(1))}%`

/** One line for a pace: "Max, even · 60%", "$150 a check", "Max each Jan". */
export function paceSummary(p: Pace, channel: Channel): string {
  switch (p.pace) {
    case "off":
      return "Off"
    case "fixed":
      if (channel === "direct") return `${money(p.amount)} a month`
      return p.per === "month"
        ? `${money(p.amount)} a month`
        : `${money(p.amount)} a check`
    case "percent":
      return `${percent(p.pct)} of pay`
    case "even":
      return `Max, even${p.share < 1 ? ` · ${percent(p.share)}` : ""}`
    case "front_load":
      return `Max, early${p.share < 1 ? ` · ${percent(p.share)}` : ""}`
    case "lump": {
      const when = MONTHS[p.month - 1] ?? "year"
      return p.amount == null
        ? `Max each ${when}`
        : `${money(p.amount)} each ${when}`
    }
  }
}

/** A new stream of the given kind, starting in `from`. */
export function newContribution(
  account: ContributionAccount,
  tax: TaxTreatment,
  channel: Channel,
  from: string,
  taken: string[]
): Contribution {
  const base = account === "hsa" ? `hsa-${channel}` : `${account}-${tax}`
  let id = base
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`
  const phase: Phase =
    channel === "payroll"
      ? { from, pace: "even", share: 1, capPct: 0.5 }
      : { from, pace: "lump", month: 1, amount: null }
  return { id, account, tax, channel, ytd: {}, schedule: [phase] }
}
