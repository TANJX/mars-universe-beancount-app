// Shared chart bits for the runway charts.

import { formatChartDate } from "@/components/charts/chart-tooltip"
import type { ChartConfig } from "@/components/ui/chart"
import { SLEEVES } from "@/lib/runway/sleeves"

const SHORT = [
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

/** Axis tick: "Nov" for most months, "Jan ’27" at a year turn and on the
 * first tick so the year is always on screen. */
export function monthTick(m: string, first: string): string {
  const mo = Number(m.slice(5, 7))
  const label = SHORT[mo - 1] ?? m
  return mo === 1 || m === first ? `${label} ’${m.slice(2, 4)}` : label
}

/** Tick months on calendar quarters (Jan, Apr, Jul, Oct) so every year
 * turn gets a tick, plus the first month; widen the step on long horizons. */
export function monthTicks(months: string[]): string[] {
  const n = months.length
  const every = n <= 36 ? 3 : n <= 72 ? 6 : 12
  const picked = months.filter((m) => (Number(m.slice(5, 7)) - 1) % every === 0)
  const first = months[0]
  if (!first) return picked
  // Drop a quarter tick that would crowd the first one.
  const out = picked.filter((m, i) => !(i === 0 && monthsBetween(first, m) < 3))
  return out[0] === first ? out : [first, ...out]
}

function monthsBetween(a: string, b: string): number {
  const t = (m: string) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7))
  return t(b) - t(a)
}

/** "Nov 2026" for tooltips and tables. */
export function monthLabel(m: string): string {
  return formatChartDate(m, "month")
}

/** "Nov ’26" for compact markers. */
export function monthShort(m: string): string {
  return `${SHORT[Number(m.slice(5, 7)) - 1]} ’${m.slice(2, 4)}`
}

export const SLEEVE_CONFIG: ChartConfig = Object.fromEntries(
  SLEEVES.map((s) => [s.id, { label: s.label, color: `var(${s.token})` }])
)

export const AXIS = {
  tickLine: false,
  axisLine: false,
  fontSize: 11,
  tickMargin: 6,
} as const

/** "Jan to May 2027", "Dec 2026 to Feb 2027" or "Mar 2027" for a span of
 * months (first and last of a sorted list). */
export function monthRange(months: string[]): string {
  const a = months[0]
  const b = months.at(-1)
  if (!a || !b) return ""
  if (a === b) return monthLabel(a)
  const short = (m: string) => SHORT[Number(m.slice(5, 7)) - 1] ?? m
  return a.slice(0, 4) === b.slice(0, 4)
    ? `${short(a)} to ${short(b)} ${b.slice(0, 4)}`
    : `${monthLabel(a)} to ${monthLabel(b)}`
}
