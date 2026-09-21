// Numeric and label atoms the Portfolio page is built from.
//
// Every string a reader sees that names something in the ledger — a sleeve, a
// security, an asset class — arrives in the payload or in ui.yaml. The only
// vocabulary fixed here is the tax-treatment chip, which is a closed set of
// IRS categories rather than anything about this ledger.

import type * as React from "react"

import { formatChartDate } from "@/components/charts/chart-tooltip"
import { Money } from "@/components/primitives/money"
import type { TaxTreatment } from "@/lib/config"
import type { PortfolioSeriesPoint } from "@/lib/fava/schemas"
import { formatLongDate, MINUS } from "@/lib/format"
import { cn } from "@/lib/utils"

/**
 * A 7-step sequential ramp, defined in `globals.css` so it flips under
 * `.dark`. It exists because this design system has no categorical palette:
 * `--chart-1..5` is a near-monochrome warm-neutral sequence that does not flip
 * between themes. Identity is carried by the legend's text; the ramp only
 * reinforces rank.
 */
export const ALLOC_RAMP = [
  "var(--alloc-1)",
  "var(--alloc-2)",
  "var(--alloc-3)",
  "var(--alloc-4)",
  "var(--alloc-5)",
  "var(--alloc-6)",
  "var(--alloc-7)",
]

/** Ramp step by rank, clamped so an 8th+ row reuses the lightest step. */
export function rampAt(i: number): string {
  return ALLOC_RAMP[Math.min(i, ALLOC_RAMP.length - 1)]
}

export function Pct({
  value,
  className,
  digits = 1,
  signed = true,
}: {
  value: number
  className?: string
  digits?: number
  signed?: boolean
}) {
  const sign = value < 0 ? MINUS : signed ? "+" : ""
  return (
    <span className={cn("font-mono tabular-nums", className)}>
      {sign}
      {Math.abs(value).toFixed(digits)}%
    </span>
  )
}

/** Signed gain, tinted. Emerald/rose are the system's existing P/L tones. */
export function Gain({
  value,
  pct,
  className,
}: {
  value: number
  pct?: number
  className?: string
}) {
  const tone = value >= 0 ? "pos" : "neg"
  return (
    <span className={cn("inline-flex items-baseline gap-1.5", className)}>
      <Money value={value} tone={tone} maximumFractionDigits={0} />
      {pct != null && (
        <Pct
          value={pct}
          className={cn(
            "text-xs",
            value >= 0
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400"
          )}
        />
      )}
    </span>
  )
}

export function Units({ value }: { value: number }) {
  // Whole shares read as integers; fractional positions keep enough places to
  // stay honest without turning the column into noise.
  const s = Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : value.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      })
  return <span className="font-mono text-xs tabular-nums">{s}</span>
}

/** Uppercase micro-label. Tracking loosened — caps default too tight. */
export function Label({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "font-medium text-[10.5px] text-muted-foreground uppercase tracking-[0.06em]",
        className
      )}
    >
      {children}
    </div>
  )
}

/**
 * Market value is only as fresh as the newest `price` directive. Rather than
 * imply live quotes, say how old the prices are — but only once they are old
 * enough to matter, so a ledger updated this morning carries no badge.
 */
export function StaleBadge({
  days,
  priceAsof,
}: {
  days: number | null
  priceAsof?: string | null
}) {
  if (days == null || days < 1) return null
  // Relative age is what you scan for; the date is what you act on, so the
  // badge carries both rather than implying live quotes.
  return (
    <span
      title={
        priceAsof
          ? `Every market value on this page is quoted at ${formatLongDate(priceAsof)}. Run the price updater to refresh.`
          : undefined
      }
      className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10.5px] text-amber-700 tabular-nums dark:text-amber-400"
    >
      <span aria-hidden>◆</span>
      prices {days}d old
      {priceAsof && (
        <span className="text-amber-700/70 dark:text-amber-400/70">
          · {formatLongDate(priceAsof)}
        </span>
      )}
    </span>
  )
}

const TAX_LABEL: Record<TaxTreatment, string> = {
  roth: "Roth",
  traditional: "Pre-tax",
  hsa: "Triple tax-free",
  taxable: "Taxable",
  "401k": "Pre-tax",
  // A Roth 401k is after-tax; labelling it "Pre-tax" states the opposite.
  "roth-401k": "Roth 401k",
}

/** Nothing renders for a sleeve with no configured treatment. */
export function TaxChip({ tax }: { tax: TaxTreatment | null }) {
  if (!tax) return null
  return (
    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground tracking-[0.03em]">
      {TAX_LABEL[tax]}
    </span>
  )
}

export function HoverDateCaption({
  hover,
  fallback,
}: {
  hover: PortfolioSeriesPoint | null
  fallback: string
}) {
  return (
    <div className="mt-0.5 font-mono text-muted-foreground text-xs tabular-nums">
      {hover ? formatChartDate(hover.date.slice(0, 7), "month") : fallback}
    </div>
  )
}
