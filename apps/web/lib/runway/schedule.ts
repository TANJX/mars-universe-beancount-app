// Pay dates and month arithmetic. Dates are UTC midnights; months are
// "YYYY-MM" strings, which compare correctly as plain strings.

import type { PayFrequency, PaySchedule } from "./types"

const DAY = 86_400_000

export function parseDate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number)
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1))
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function ym(d: Date): string {
  return d.toISOString().slice(0, 7)
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number)
  const t = y * 12 + (m - 1) + n
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`
}

export function monthSpan(start: string, months: number): string[] {
  return Array.from({ length: Math.max(0, months) }, (_, i) =>
    addMonths(start, i)
  )
}

/** Last calendar day of a month, as a UTC date. */
export function endOfMonth(month: string): Date {
  const [y, m] = month.split("-").map(Number)
  return new Date(Date.UTC(y, m, 0))
}

export function periodsPerYear(freq: PayFrequency): number {
  return freq === "biweekly" ? 26 : 24
}

/** Weekend dates roll back to the Friday before (holidays are ignored). */
function rollBackToWeekday(d: Date): Date {
  const dow = d.getUTCDay()
  if (dow === 6) return new Date(d.getTime() - DAY)
  if (dow === 0) return new Date(d.getTime() - 2 * DAY)
  return d
}

/** Pay dates strictly after `fromExclusive` and on or before `through`. */
export function paydates(
  schedule: PaySchedule,
  fromExclusive: string,
  through: string
): Date[] {
  const from = parseDate(fromExclusive).getTime()
  const to = parseDate(through).getTime()
  const out: Date[] = []
  if (to <= from) return out
  if (schedule.frequency === "biweekly") {
    const anchor = parseDate(schedule.anchor ?? fromExclusive).getTime()
    const step = 14 * DAY
    // First anchor-aligned date after `from`, whichever side the anchor is on.
    const k = Math.floor((from - anchor) / step) + 1
    for (let t = anchor + k * step; t <= to; t += step) out.push(new Date(t))
    return out
  }
  const days = schedule.days.length ? schedule.days : [15, -1]
  let month = fromExclusive.slice(0, 7)
  const last = through.slice(0, 7)
  while (month <= last) {
    const end = endOfMonth(month)
    const dates = days
      .map((d) => {
        if (d < 0) return rollBackToWeekday(end)
        const day = Math.min(d, end.getUTCDate())
        return rollBackToWeekday(
          new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), day))
        )
      })
      .sort((a, b) => a.getTime() - b.getTime())
    for (const d of dates) {
      const t = d.getTime()
      if (t > from && t <= to && !out.some((x) => x.getTime() === t))
        out.push(d)
    }
    month = addMonths(month, 1)
  }
  return out
}
