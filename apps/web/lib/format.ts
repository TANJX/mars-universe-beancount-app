// Formatting helpers. Uses mathematical minus "−" (not hyphen) for negatives,
// tabular-nums-friendly decimal output.

import type { Posting } from "@/lib/types/beancount"

export const MINUS = "−"

function defaultDecimals(currency: string): number {
  if (currency === "JPY") return 0
  if (currency === "USD") return 2
  return 6
}

interface FormatNativeOptions {
  decimals?: number
}

// Suffix-style amount: $47.62, −519 JPY, 0.123237 QUAL. Used in posting
// rows and FX native-amount displays where the Beancount-faithful look
// (currency code as suffix) is preferred over the user-friendly ¥/$.
export function formatNativeAmount(
  value: number,
  currency: string,
  opts: FormatNativeOptions = {}
): string {
  const decimals = opts.decimals ?? defaultDecimals(currency)
  const abs = Math.abs(value)
  const sign = value < 0 ? MINUS : ""
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  if (currency === "USD") return `${sign}$${formatted}`
  return `${sign}${formatted} ${currency}`
}

// Render a posting's amount with cost {} and price @ annotations inline.
// Examples: "−$47.62", "−519 JPY", "$3.63 @ 143 JPY",
// "0.123237 QUAL {194.75 USD}".
export function formatPostingAmount(p: Posting): string {
  let out = formatNativeAmount(p.amount.number, p.amount.currency)
  if (p.price) {
    const pd = p.price.currency === "JPY" ? 0 : 2
    const priceNum = p.price.number.toLocaleString("en-US", {
      minimumFractionDigits: pd,
      maximumFractionDigits: pd,
    })
    out += ` @ ${priceNum} ${p.price.currency}`
  }
  if (p.cost) {
    const costNum = p.cost.number.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
    out += ` {${costNum} ${p.cost.currency}}`
  }
  return out
}

interface FormatMoneyOptions {
  currency?: string
  showCurrencySymbol?: boolean
  minimumFractionDigits?: number
  maximumFractionDigits?: number
}

export function formatMoney(
  value: number,
  opts: FormatMoneyOptions = {}
): string {
  const { currency = "USD", showCurrencySymbol = true } = opts
  // If the caller sets only one of the fraction bounds, the other follows it
  // (toLocaleString requires min <= max). Both default to 2 when unset.
  const minimumFractionDigits =
    opts.minimumFractionDigits ?? opts.maximumFractionDigits ?? 2
  const maximumFractionDigits =
    opts.maximumFractionDigits ?? opts.minimumFractionDigits ?? 2

  const abs = Math.abs(value)
  const sign = value < 0 ? MINUS : ""

  if (currency === "USD" && showCurrencySymbol) {
    return `${sign}$${abs.toLocaleString("en-US", {
      minimumFractionDigits,
      maximumFractionDigits,
    })}`
  }

  if (currency === "JPY") {
    return `${sign}¥${Math.round(abs).toLocaleString("en-US")}`
  }

  if (currency === "CNY") {
    return `${sign}¥${abs.toLocaleString("en-US", {
      minimumFractionDigits,
      maximumFractionDigits,
    })}`
  }

  return `${sign}${abs.toLocaleString("en-US", {
    minimumFractionDigits,
    maximumFractionDigits,
  })} ${currency}`
}

export function formatPercent(value: number, fractionDigits = 1): string {
  return `${value.toFixed(fractionDigits)}%`
}

// Format "2026-04-15" → "04-15" for the current year, or full "2025-04-15"
// for off-year rows so the year isn't lost. Prototype convention for dense
// tables.
export function formatShortDate(iso: string, today = new Date()): string {
  const year = Number(iso.slice(0, 4))
  if (year && year !== today.getFullYear()) return iso
  return iso.slice(5)
}

// Format "2026-04-15" → "Today" / "Yesterday" / "Apr 24" relative to today,
// or "Apr 24, 2025" when the year differs from today's. Mobile timeline rows
// want a friendlier date than the desktop "04-15".
const REL_MONTHS = [
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
export function formatRelativeDate(iso: string, today = new Date()): string {
  const [y, m, d] = iso.split("-").map(Number)
  if (!y || !m || !d) return iso
  const that = new Date(y, m - 1, d)
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  const diffDays = Math.round((t.getTime() - that.getTime()) / 86_400_000)
  if (diffDays === 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  if (y !== today.getFullYear()) return `${REL_MONTHS[m - 1]} ${d}, ${y}`
  return `${REL_MONTHS[m - 1]} ${d}`
}

// Format "2026-04-15" → "Apr 15, 2026". Always carries the year — for captions
// where a bare "Apr 15" would be ambiguous against the selected period.
export function formatLongDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number)
  if (!y || !m || !d) return iso
  return `${REL_MONTHS[m - 1]} ${d}, ${y}`
}
