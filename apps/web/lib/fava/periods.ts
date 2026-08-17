// Map our Period preset → Fava's `time=` filter syntax. Also exposes the
// helpers the topbar prev/next arrows need (shift a period one unit in either
// direction) and a sensible default granularity per period length.
//
// Fava reference: https://beancount.github.io/fava/usage.html#filtering
//   2026          → year
//   2026-Q2       → quarter
//   2026-04       → month
//   2026-04-15    → day
//   2026-01 - 2026-03  → range (with surrounding spaces)

import { getPreset } from "@/lib/mock/periods"
import type { Granularity, Period } from "@/lib/types/views"

// ─── Fava `time=` ─────────────────────────────────────────────────────────

export function periodToFavaTime(period: Period): string | undefined {
  switch (period.id) {
    case "mtd": {
      // Month-to-date: from the 1st through today.
      const d = now()
      return `${formatDay(monthFloor(d))} - ${formatDay(d)}`
    }
    case "this-month":
      // Full calendar month, including future-dated entries within it.
      return formatMonth(now())
    case "last-month":
      return formatMonth(addMonths(now(), -1))
    case "qtd":
      return formatQuarter(now())
    case "ytd": {
      const d = now()
      return `${d.getFullYear()}-01-01 - ${formatDay(d)}`
    }
    case "last-12": {
      const end = now()
      return `${formatMonth(addMonths(end, -11))} - ${formatMonth(end)}`
    }
    case "all":
      // Omit `time=` entirely — fava treats no filter as "every entry".
      return undefined
    case "custom": {
      if (period.from && period.to) {
        return `${period.from} - ${period.to}`
      }
      return undefined
    }
  }
}

/**
 * Build a fava `time=` string covering everything *before* the active
 * period — i.e. `1900 - {period.start - 1 day}`. Used to fetch an
 * opening-balance snapshot at the period boundary so the journal's
 * cumulative column for Assets/Liabilities/Equity carries forward
 * (matches fava's clamp() semantics).
 */
export function periodOpeningTime(period: Period): string {
  const { start } = periodBounds(period)
  const dayBefore = new Date(start)
  dayBefore.setDate(dayBefore.getDate() - 1)
  return `1900 - ${formatDay(dayBefore)}`
}

/** The period's last day, inclusive, as ISO `YYYY-MM-DD`. */
export function periodEndDay(period: Period): string {
  return formatDay(periodBounds(period).end)
}

/**
 * Mirror of `periodOpeningTime`: a fava `time=` covering everything up to and
 * including the period's last day — `1900 - {period.end}`. Yields a closing
 * snapshot for Assets/Liabilities/Equity and an all-time-through-end total for
 * Income/Expenses.
 */
export function periodClosingTime(period: Period): string {
  return `1900 - ${periodEndDay(period)}`
}

// ─── Resolve a period to absolute date bounds ─────────────────────────────

export interface PeriodBounds {
  start: Date
  end: Date
}

export function periodBounds(period: Period): PeriodBounds {
  const today = now()
  switch (period.id) {
    case "mtd":
      return { start: monthFloor(today), end: today }
    case "this-month":
      return monthBounds(today)
    case "last-month":
      return monthBounds(addMonths(today, -1))
    case "qtd":
      return quarterBounds(today)
    case "ytd":
      return {
        start: new Date(today.getFullYear(), 0, 1),
        end: new Date(today.getFullYear(), today.getMonth(), today.getDate()),
      }
    case "last-12":
      // addMonths lands on the 1st, which is the window start we want.
      return { start: addMonths(today, -11), end: today }
    case "all":
      // Wide bounds anchored well before any plausible ledger start. Lets
      // chart-bucketing fall through to "year" granularity without
      // special-casing every consumer.
      return { start: new Date(1900, 0, 1), end: today }
    case "custom": {
      if (period.from && period.to) {
        // parseLocalDate, not `new Date(iso)`: plain Date parsing reads
        // YYYY-MM-DD as UTC midnight, which lands on the *previous* local
        // day in negative-offset timezones and shifts the opening-balance
        // boundary (periodOpeningTime) back by one day.
        return {
          start: parseLocalDate(period.from),
          end: parseLocalDate(period.to),
        }
      }
      return { start: today, end: today }
    }
  }
}

// ─── Granularity defaults ─────────────────────────────────────────────────

/** Default chart bucket size for a given period. */
export function defaultGranularity(period: Period): Granularity {
  const { start, end } = periodBounds(period)
  const days = Math.max(1, (end.getTime() - start.getTime()) / 86400000)
  if (days <= 31) return "day"
  if (days <= 95) return "week"
  if (days <= 540) return "month"
  if (days <= 2000) return "quarter"
  return "year"
}

// ─── Prev / next ──────────────────────────────────────────────────────────

/** Step a period one unit backwards or forwards. Returns null when the
 * period has no sensible neighbour in that direction (e.g., MTD has no
 * "next" since you're already at today's edge; `last-12` would shift its
 * window off-screen; `custom` with no bounds is undefined).
 *
 * Stepping rules:
 *   mtd        → prev: last-month   | next: null (already at today)
 *   this-month → prev: last-month   | next: null (no future month)
 *   last-month → prev: <prev month> | next: this-month  (full April,
 *                                                       not MTD)
 *   <month>    → prev/next: adjacent months
 *   qtd        → prev: <prev quarter> | next: null (already at today)
 *   ytd        → prev: <prev year> | next: null
 *   custom     → shift by current range width
 */
export function shiftPeriod(period: Period, dir: -1 | 1): Period | null {
  const today = now()
  switch (period.id) {
    case "mtd":
    case "this-month": {
      // Both surfaces of the current month are one-way: prev → last-month,
      // next is disabled (no future month exists yet).
      if (dir === 1) return null
      return getPreset("last-month")
    }
    case "last-month": {
      const lastMonth = addMonths(today, -1)
      const next = addMonths(lastMonth, dir)
      return monthCustom(next, today)
    }
    case "qtd": {
      // QTD has no "next" — we're already at today's edge of this quarter.
      if (dir === 1) return null
      const prev = addMonths(today, -3)
      const { start, end } = quarterBounds(prev)
      return {
        id: "custom",
        label: quarterLabel(prev),
        range: quarterRange(prev),
        from: formatDay(start),
        to: formatDay(end),
        // Note: anchor is the quarter's start; subsequent shifts will treat
        // this as a quarter-aligned range via `quarterCustom` if the user
        // keeps stepping back.
      }
    }
    case "ytd": {
      if (dir === 1) return null
      const prev = new Date(today.getFullYear() - 1, 0, 1)
      const start = new Date(prev.getFullYear(), 0, 1)
      const end = new Date(prev.getFullYear(), 11, 31)
      return {
        id: "custom",
        label: String(prev.getFullYear()),
        range: String(prev.getFullYear()),
        from: formatDay(start),
        to: formatDay(end),
      }
    }
    case "custom": {
      if (!period.from || !period.to) return null
      const start = parseLocalDate(period.from)
      const end = parseLocalDate(period.to)

      // If the range is exactly a calendar month, step by one calendar month
      // (preserves alignment across Feb's 28 vs Aug's 31 days).
      if (isMonthAligned(start, end)) {
        const next = new Date(start.getFullYear(), start.getMonth() + dir, 1)
        return monthCustom(next, today)
      }
      // Quarter-aligned ranges: step by one quarter.
      if (isQuarterAligned(start, end)) {
        const next = new Date(
          start.getFullYear(),
          start.getMonth() + dir * 3,
          1
        )
        const { start: qs, end: qe } = quarterBounds(next)
        return {
          id: "custom",
          label: quarterLabel(next),
          range: quarterRange(next),
          from: formatDay(qs),
          to: formatDay(qe),
        }
      }
      // Arbitrary ranges: shift by the elapsed-day width.
      const width = end.getTime() - start.getTime() + 86400000
      const newStart = new Date(start.getTime() + dir * width)
      const newEnd = new Date(end.getTime() + dir * width)
      return {
        id: "custom",
        label: customLabel(newStart, newEnd),
        range: customRange(newStart, newEnd),
        from: formatDay(newStart),
        to: formatDay(newEnd),
      }
    }
    case "last-12":
    case "all":
      // Unbounded / sliding windows have no sensible prev/next step.
      return null
  }
}

// ─── Widen ────────────────────────────────────────────────────────────────

/**
 * Widen `period` by one more calendar month of history, holding its end date
 * fixed. Backs the journal's "Show more" button: the journal fetch is
 * period-driven, so widening re-queries fava over a longer `time=` range
 * rather than paginating client-side.
 *
 * Returns null for "all time", which already spans every entry.
 */
export function expandPeriodByMonth(period: Period): Period | null {
  if (period.id === "all") return null
  const { start, end } = periodBounds(period)
  return makeCustomPeriod(subtractOneMonth(start), end)
}

/**
 * One calendar month earlier, keeping the day-of-month where the target month
 * is long enough (Mar 31 → Feb 28). Unlike `addMonths` this does *not* snap to
 * the 1st, so widening a mid-month range adds exactly one month instead of up
 * to two.
 */
function subtractOneMonth(d: Date): Date {
  const out = new Date(d.getFullYear(), d.getMonth() - 1, 1)
  const lastDay = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate()
  out.setDate(Math.min(d.getDate(), lastDay))
  return out
}

// ─── Custom-range builder ─────────────────────────────────────────────────

/**
 * Parse an ISO YYYY-MM-DD as a *local* date (not UTC). Plain `new Date(iso)`
 * treats `2026-02-01` as UTC midnight, which becomes Jan 31 in PST/EST.
 */
export function parseLocalDate(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return new Date(iso)
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

/**
 * Build a Period from arbitrary date bounds. Recognises calendar-month and
 * calendar-quarter alignment and routes through monthCustom/quarterCustom so
 * the popover shows the right label ("Feb 2026") and prev/next stays aligned.
 */
export function makeCustomPeriod(from: Date, to: Date): Period {
  if (isMonthAligned(from, to)) {
    return monthCustom(from, now())
  }
  if (isQuarterAligned(from, to)) {
    return {
      id: "custom",
      label: quarterLabel(from),
      range: quarterRange(from),
      from: formatDay(from),
      to: formatDay(to),
    }
  }
  return {
    id: "custom",
    label: customLabel(from, to),
    range: customRange(from, to),
    from: formatDay(from),
    to: formatDay(to),
  }
}

/**
 * Build a Period for the calendar month containing `d`. If it's the current
 * month, returns the `this-month` preset; if it's the prior month, returns
 * `last-month`; otherwise a month-aligned `custom` Period whose `from`/`to`
 * are the 1st and last day of `d`'s month.
 */
function monthCustom(d: Date, today: Date): Period {
  if (
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth()
  ) {
    return getPreset("this-month")
  }
  const lastMonth = addMonths(today, -1)
  if (
    d.getFullYear() === lastMonth.getFullYear() &&
    d.getMonth() === lastMonth.getMonth()
  ) {
    return getPreset("last-month")
  }
  const start = monthFloor(d)
  const end = monthCeil(d)
  return {
    id: "custom",
    label: monthLabel(d),
    range: monthRange(d),
    from: formatDay(start),
    to: formatDay(end),
  }
}

function isMonthAligned(start: Date, end: Date): boolean {
  // Same month + start is the 1st + end is the last day of that month.
  if (
    start.getFullYear() !== end.getFullYear() ||
    start.getMonth() !== end.getMonth()
  ) {
    return false
  }
  if (start.getDate() !== 1) return false
  const lastDay = new Date(start.getFullYear(), start.getMonth() + 1, 0)
  return end.getDate() === lastDay.getDate()
}

function isQuarterAligned(start: Date, end: Date): boolean {
  // Start = first day of a quarter, end = last day of that same quarter.
  if (start.getDate() !== 1 || start.getMonth() % 3 !== 0) return false
  const qEnd = new Date(start.getFullYear(), start.getMonth() + 3, 0)
  return (
    end.getFullYear() === qEnd.getFullYear() &&
    end.getMonth() === qEnd.getMonth() &&
    end.getDate() === qEnd.getDate()
  )
}

// ─── Internal helpers ─────────────────────────────────────────────────────

function now(): Date {
  return new Date()
}

/**
 * Shift `d` by `n` calendar months, always landing on the 1st. The setDate(1)
 * must come first: setMonth keeps the day-of-month and normalizes overflow, so
 * Jul 31 minus one month would otherwise become Jul 1 (via "Jun 31").
 */
function addMonths(d: Date, n: number): Date {
  const out = new Date(d)
  out.setDate(1)
  out.setMonth(out.getMonth() + n)
  return out
}

function monthBounds(d: Date): PeriodBounds {
  return {
    start: new Date(d.getFullYear(), d.getMonth(), 1),
    end: new Date(d.getFullYear(), d.getMonth() + 1, 0),
  }
}

function quarterBounds(d: Date): PeriodBounds {
  const q = Math.floor(d.getMonth() / 3)
  return {
    start: new Date(d.getFullYear(), q * 3, 1),
    end: new Date(d.getFullYear(), q * 3 + 3, 0),
  }
}

function monthFloor(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

function monthCeil(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0)
}

function formatMonth(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`
}

function formatDay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function formatQuarter(d: Date): string {
  const q = Math.floor(d.getMonth() / 3) + 1
  return `${d.getFullYear()}-Q${q}`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
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

function monthLabel(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

function monthRange(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

function monthDay(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

function quarterLabel(d: Date): string {
  return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`
}

function quarterRange(d: Date): string {
  return quarterLabel(d)
}

function customLabel(from: Date, to: Date): string {
  if (
    from.getFullYear() === to.getFullYear() &&
    from.getMonth() === to.getMonth() &&
    from.getDate() === to.getDate()
  ) {
    return `${monthDay(from)}, ${from.getFullYear()}`
  }
  return "Custom"
}

function customRange(from: Date, to: Date): string {
  const sameYear = from.getFullYear() === to.getFullYear()
  if (sameYear) {
    return `${monthDay(from)} – ${monthDay(to)}, ${to.getFullYear()}`
  }
  return `${monthDay(from)}, ${from.getFullYear()} – ${monthDay(to)}, ${to.getFullYear()}`
}
