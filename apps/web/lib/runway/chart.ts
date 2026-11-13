// Pure helpers behind the /runway main chart: scales, axis labels, stacking,
// and the events and warnings drawn on their month. No React, no DOM, so the
// node test runner can load it.

import {
  SLEEVE_BY_ID,
  SLEEVE_GROUPS,
  type SleeveGroupId,
  type SleeveId,
} from "./sleeves"
import type { MonthRow, RunwayResult } from "./types"

const MON = [
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
const MINUS = "−"

/** "Nov 2026". */
export function monthLong(m: string): string {
  return `${MON[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`
}

/** "Nov ’26". */
export function monthAbbr(m: string): string {
  return `${MON[Number(m.slice(5, 7)) - 1] ?? m} ’${m.slice(2, 4)}`
}

/** "Jan to May 2027", "Dec 2026 to Feb 2027" or "Mar 2027". */
export function monthSpanLabel(months: string[]): string {
  const a = months[0]
  const b = months.at(-1)
  if (!a || !b) return ""
  if (a === b) return monthLong(a)
  const short = (m: string) => MON[Number(m.slice(5, 7)) - 1] ?? m
  return a.slice(0, 4) === b.slice(0, 4)
    ? `${short(a)} to ${short(b)} ${b.slice(0, 4)}`
    : `${monthLong(a)} to ${monthLong(b)}`
}

const NF = new Intl.NumberFormat("en-US")

/** "$1,016", "-$1,016". */
export function money(v: number): string {
  const r = Math.round(v)
  return `${r < 0 ? "-" : ""}$${NF.format(Math.abs(r))}`
}

/** "$207k", "$1.5k", "$900", "$1.25M" for axes, chips and labels. */
export function moneyK(v: number): string {
  const a = Math.abs(v)
  const s = v < 0 ? MINUS : ""
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`
  if (a >= 1e4) return `${s}$${Math.round(a / 1e3)}k`
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1).replace(/\.0$/, "")}k`
  return `${s}$${Math.round(a)}`
}

/** "+$4.2k", "−$650", "$0". */
export function signedK(v: number): string {
  const r = Math.round(v)
  if (r === 0) return moneyK(0)
  return `${r > 0 ? "+" : MINUS}${moneyK(Math.abs(r))}`
}

/** "12%", "7.5%". */
export function percent(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits).replace(/\.0+$/, "")}%`
}

// ---------------------------------------------------------------- scales

/** Smallest of 1, 2, 2.5, 5, 10 times a power of ten that splits `range`
 * into at most `target` steps. */
export function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target)
  if (!(raw > 0)) return 1
  const mag = 10 ** Math.floor(Math.log10(raw))
  for (const f of [1, 2, 2.5, 5, 10]) if (f * mag >= raw - 1e-12) return f * mag
  return 10 * mag
}

export interface YScale {
  lo: number
  hi: number
  ticks: number[]
}

/** The top sits 6% above the data, not on a rounded tick, so there is no
 * empty band at the top; ticks stay on nice values below it. A negative
 * minimum gets 15% room below. Fewer ticks on a short plot. */
export function yScale(plotHeight: number, maxV: number, minV = 0): YScale {
  const hi = maxV > 0 ? maxV * 1.06 : 1
  const lo = minV < 0 ? minV * 1.15 : 0
  const target =
    plotHeight < 90 ? 1 : plotHeight < 150 ? 2 : plotHeight < 230 ? 3 : 4
  const at = (k: number) => {
    const step = niceStep(hi - lo, k)
    const ticks: number[] = []
    for (let t = Math.ceil(lo / step) * step; t <= hi * 0.985; t += step)
      ticks.push(Number(t.toFixed(6)))
    return ticks
  }
  // A range just past two nice steps (20k of data on a 20k step) would
  // leave only the $0 line; ask for one more step until a second tick fits.
  let ticks = at(target)
  for (let k = target + 1; target > 1 && ticks.length < 2 && k <= 8; k++)
    ticks = at(k)
  return { lo, hi, ticks }
}

export interface XLabel {
  i: number
  x: number
  label: string
}

/** Month labels that never collide: candidates are the first month and the
 * calendar quarters, kept greedily by priority (first, Jan, Jul, then Apr
 * and Oct) while at least `minGap` px from every label already kept. The
 * first label shown in each year carries the year. */
export function xLabels(
  months: string[],
  x: (i: number) => number,
  minGap = 62
): XLabel[] {
  const cand = months
    .map((m, i) => ({ i, mo: Number(m.slice(5, 7)) }))
    .filter((c) => c.i === 0 || (c.mo - 1) % 3 === 0)
  const pr = (c: { i: number; mo: number }) =>
    c.i === 0 ? 0 : c.mo === 1 ? 1 : c.mo === 7 ? 2 : 3
  const keep: { i: number; mo: number }[] = []
  for (const c of [...cand].sort((a, b) => pr(a) - pr(b) || a.i - b.i))
    if (keep.every((k) => Math.abs(x(k.i) - x(c.i)) >= minGap)) keep.push(c)
  keep.sort((a, b) => a.i - b.i)
  const seen = new Set<string>()
  return keep.map((k) => {
    const m = months[k.i]
    const yr = m.slice(0, 4)
    const label = seen.has(yr) ? (MON[k.mo - 1] ?? m) : monthAbbr(m)
    seen.add(yr)
    return { i: k.i, x: x(k.i), label }
  })
}

// ---------------------------------------------------------------- stacking

/** One band of a stacked chart: a sleeve, a family, or a share of one. */
export interface SeriesDef {
  id: string
  label: string
  /** CSS custom property name, e.g. "--sleeve-ef". */
  token: string
  /** Family; a 2px card gap is drawn only where this changes. */
  group: SleeveGroupId
  get: (r: MonthRow) => number
}

export interface Layer {
  def: SeriesDef
  y0: number[]
  y1: number[]
}

/** Stack bottom to top; negative values count as 0. */
export function stackLayers(rows: MonthRow[], defs: SeriesDef[]): Layer[] {
  const base = rows.map(() => 0)
  return defs.map((def) => {
    const y0 = base.slice()
    const y1 = rows.map((r, i) => {
      base[i] += Math.max(0, def.get(r))
      return base[i]
    })
    return { def, y0, y1 }
  })
}

/** Total of the stack per month (what the top edge traces). */
export function stackTotals(rows: MonthRow[], defs: SeriesDef[]): number[] {
  return rows.map((r) => defs.reduce((t, d) => t + Math.max(0, d.get(r)), 0))
}

export function sleeveSeries(id: SleeveId): SeriesDef {
  const s = SLEEVE_BY_ID[id]
  return {
    id,
    label: s.label,
    token: s.token,
    group: s.group,
    get: (r) => r[id],
  }
}

/** A family as one band; only the members this run uses count. */
export function groupSeries(id: SleeveGroupId, used: SleeveId[]): SeriesDef {
  const g = SLEEVE_GROUPS.find((x) => x.id === id) ?? SLEEVE_GROUPS[0]
  const members = g.members.filter((m) => used.includes(m))
  return {
    id: g.id,
    label: g.label,
    token: g.token,
    group: g.id,
    get: (r) => members.reduce((t, m) => t + r[m], 0),
  }
}

/** Share of invested money (core, gold, IRA, 401k, HSA, play). */
export function shareSeries(id: SleeveId): SeriesDef {
  const s = sleeveSeries(id)
  return {
    ...s,
    get: (r) => (r.invested > 0 ? Math.max(0, r[id]) / r.invested : 0),
  }
}

// ---------------------------------------------------------------- events

export type GlyphType =
  | "raise"
  | "cut"
  | "job"
  | "ira"
  | "k401"
  | "hsa"
  | "limit"
  | "forfeit"
  | "bill"
  | "other"

/** Key order and wording, one entry per glyph. */
export const GLYPH_KEY: { type: GlyphType; label: string }[] = [
  { type: "raise", label: "Raise" },
  { type: "cut", label: "Pay cut" },
  { type: "job", label: "Job change" },
  { type: "ira", label: "IRA deposit" },
  { type: "k401", label: "401k deposit" },
  { type: "hsa", label: "HSA deposit" },
  { type: "limit", label: "Limit reached" },
  { type: "forfeit", label: "Match forfeited" },
  { type: "bill", label: "One-off bill" },
  { type: "other", label: "Other" },
]

export interface ChartEvent {
  i: number
  month: string
  type: GlyphType
  /** The engine's own string ("Raise", "IRA deposit", "State tax bill"). */
  label: string
  detail: string | null
  /** Only in the comparison run (drawn hollow). */
  other?: boolean
}

/** Glyph type for one engine event string. One-off bills carry free-text
 * labels, so an unmatched string in a month with a one-off amount is a
 * bill; anything else unknown gets the generic glyph. */
export function glyphFor(e: string, row?: MonthRow): GlyphType {
  if (e === "Raise") return "raise"
  if (e === "Pay cut") return "cut"
  if (e === "New job starts" || / (starts|ends)$/.test(e)) return "job"
  if (e === "IRA deposit") return "ira"
  if (e === "401k deposit") return "k401"
  if (e === "HSA deposit") return "hsa"
  if (/ limit reached$/.test(e) || e === "HSA over its limit") return "limit"
  if (e === "Match forfeited") return "forfeit"
  if (e === "Tax due" || /\btax\b/i.test(e)) return "bill"
  if (row && Math.abs(row.taxOut) >= 0.5) return "bill"
  return "other"
}

function detailFor(
  type: GlyphType,
  e: string,
  row: MonthRow,
  result: RunwayResult | null,
  bills: number
): string | null {
  if (row.actual) {
    const d = row.deposits
    const v =
      type === "ira"
        ? d?.ira
        : type === "k401"
          ? d?.k401
          : type === "hsa"
            ? d?.hsa
            : 0
    return v && v >= 0.5 ? `${money(v)} in` : null
  }
  switch (type) {
    case "ira":
      return row.iraOut >= 0.5 ? `${money(row.iraOut)} paid from cash` : null
    case "hsa":
      return row.hsaOut >= 0.5 ? `${money(row.hsaOut)} paid from cash` : null
    case "limit":
      if (e === "401k limit reached")
        return "deferrals stop, take-home rises until January"
      if (/ limit reached$/.test(e)) return "no more deposits until January"
      return null
    case "forfeit":
      return result && result.forfeitMonth === row.month && result.forfeited > 0
        ? `${money(result.forfeited)} of unvested match lost`
        : null
    case "bill":
      if (bills !== 1 || Math.abs(row.taxOut) < 0.5) return null
      return row.taxOut < 0
        ? `${money(-row.taxOut)} back`
        : `${money(row.taxOut)} due`
    default:
      return null
  }
}

/** Every event in the run, with its glyph and detail copy. */
export function chartEvents(
  rows: MonthRow[],
  result: RunwayResult | null = null
): ChartEvent[] {
  const out: ChartEvent[] = []
  rows.forEach((row, i) => {
    const typed = row.events.map((e) => ({ e, type: glyphFor(e, row) }))
    const bills = typed.filter((t) => t.type === "bill").length
    for (const { e, type } of typed)
      out.push({
        i,
        month: row.month,
        type,
        label: e,
        detail: detailFor(type, e, row, result, bills),
      })
  })
  return out
}

/** Items indexed against the forecast, moved `by` months to the right (the
 * history months drawn before it). */
export function offsetIndex<T extends { i: number }>(xs: T[], by: number): T[] {
  return by ? xs.map((x) => ({ ...x, i: x.i + by })) : xs
}

/** "Raise: take-home up" style line for the tooltip. */
export function eventText(e: ChartEvent): string {
  return e.detail ? `${e.label}: ${e.detail}` : e.label
}

// ---------------------------------------------------------------- warnings

export type WarningTone = "rose" | "amber"

export interface ChartWarning {
  i: number
  month: string
  tone: WarningTone
  /** Pill text on the chart. */
  short: string
  /** Note text under the chart. */
  text: string
  other?: boolean
}

/** Warnings from the run, each pinned to its month. `vestDate` (YYYY-MM-DD)
 * adds the vesting date to the forfeit note. */
export function chartWarnings(
  result: RunwayResult,
  vestDate: string | null = null
): ChartWarning[] {
  const months = result.rows.map((r) => r.month)
  const out: ChartWarning[] = []
  const add = (
    month: string | null,
    tone: WarningTone,
    short: string,
    text: string
  ) => {
    const i = month ? months.indexOf(month) : -1
    if (i >= 0 && month) out.push({ i, month, tone, short, text })
  }
  if (result.efDrawn > 0 && result.efDrawnMonth)
    add(
      result.efDrawnMonth,
      "rose",
      "Reserve empty",
      `The reserve runs dry in ${monthLong(result.efDrawnMonth)}; ${money(result.efDrawn)} comes out of the emergency fund.`
    )
  if (result.coreDrawn > 0 && result.coreDrawnMonth)
    add(
      result.coreDrawnMonth,
      "rose",
      "Core sold",
      `${money(result.coreDrawn)} is sold from the core index to cover checking, starting ${monthLong(result.coreDrawnMonth)}.`
    )
  if (result.unfundedMonths.length > 0)
    add(
      result.unfundedMonths[0],
      "rose",
      "Checking below $0",
      `Checking goes ${money(result.unfundedPeak)} negative (${monthSpanLabel(result.unfundedMonths)}): reserve, emergency fund and core are empty.`
    )
  if (result.forfeitMonth && result.forfeited > 0)
    add(
      result.forfeitMonth,
      "amber",
      "Match forfeited",
      `Leaving in ${monthLong(result.forfeitMonth)} forfeits ${money(result.forfeited)} of unvested match${vestDate ? ` (vests ${monthLong(vestDate.slice(0, 7))})` : ""}.`
    )
  return out.sort((a, b) => a.i - b.i)
}

/** Main items plus the comparison run's items that the main run does not
 * have in the same month, flagged `other`. */
export function withOther<T extends { i: number; other?: boolean }>(
  main: T[],
  other: T[] | null,
  key: (x: T) => string
): T[] {
  if (!other) return main
  const have = new Set(main.map((x) => `${x.i}|${key(x)}`))
  return [
    ...main,
    ...other
      .filter((x) => !have.has(`${x.i}|${key(x)}`))
      .map((x) => ({ ...x, other: true })),
  ].sort((a, b) => a.i - b.i)
}

/** Warnings grouped by month, rose first; the pill joins their short text. */
export function warningPills(
  warnings: ChartWarning[]
): { i: number; tone: WarningTone; text: string }[] {
  const by = new Map<number, ChartWarning[]>()
  for (const w of warnings) by.set(w.i, [...(by.get(w.i) ?? []), w])
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, ws]) => ({
      i,
      tone: ws.some((w) => w.tone === "rose") ? "rose" : "amber",
      text: [...new Set(ws.map((w) => w.short))].join(" + "),
    }))
}
