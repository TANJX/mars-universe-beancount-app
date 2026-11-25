// Calendar-date helpers for the dashboard. ISO dates ("2026-01-15") are read
// as local calendar dates, never as UTC instants, so a date never shows as the
// previous day. "Relative" means relative to the ledger's as-of date.

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

export function parseIso(iso: string): Date | null {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d)
}

export function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

/** Whole days from `from` to `iso` (positive = later). NaN on bad input. */
export function daysBetween(from: string, iso: string): number {
  const a = parseIso(from)
  const b = parseIso(iso)
  if (!a || !b) return Number.NaN
  return Math.round((b.getTime() - a.getTime()) / 86_400_000)
}

/** "Dec 7", or "Dec 7, 2025" when the year differs from `ref`'s. */
export function shortDate(iso: string, ref: string = todayIso()): string {
  const d = parseIso(iso)
  if (!d) return iso
  const refYear = parseIso(ref)?.getFullYear() ?? new Date().getFullYear()
  const year = d.getFullYear() !== refYear ? `, ${d.getFullYear()}` : ""
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year}`
}

/** "Today", "Tomorrow", "In 3 days", "Yesterday", else a short date. */
export function relDate(iso: string, asOf: string = todayIso()): string {
  const n = daysBetween(asOf, iso)
  if (Number.isNaN(n)) return iso
  if (n === 0) return "Today"
  if (n === 1) return "Tomorrow"
  if (n === -1) return "Yesterday"
  if (n > 1 && n < 7) return `In ${n} days`
  return shortDate(iso, asOf)
}

/** "Tuesday, Nov 24" for an issue eyebrow. */
export function longDate(iso: string): string {
  const d = parseIso(iso)
  if (!d) return iso
  const day = d.toLocaleDateString("en-US", { weekday: "long" })
  return `${day}, ${shortDate(iso)}`
}

/** "2h ago", "3d ago" for a timestamp; the raw string when unparseable. */
export function ago(timestamp: string, now: number = Date.now()): string {
  const t = Date.parse(timestamp)
  if (Number.isNaN(t)) return timestamp
  const mins = Math.max(0, Math.round((now - t) / 60_000))
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
