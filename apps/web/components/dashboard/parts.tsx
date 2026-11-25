"use client"
// Presentational pieces shared by the dashboard registry. Pure display: every
// value arrives as a prop (already resolved from the data document).
import {
  CalendarClock,
  CreditCard,
  type LucideIcon,
  Sparkles,
  Wallet,
} from "lucide-react"
import type * as React from "react"

import { formatMoney, MINUS } from "@/lib/format"
import { cn } from "@/lib/utils"

export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "text-xs font-medium tracking-wide text-muted-foreground uppercase",
        className
      )}
    >
      {children}
    </div>
  )
}

export function Num({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <span className={cn("font-mono tracking-tight tabular-nums", className)}>
      {children}
    </span>
  )
}

/** A quiet one-line empty state inside a panel or list. */
export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-2 text-sm text-muted-foreground">{children}</p>
}

export function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

export function usd(n: number, digits = 0): string {
  return formatMoney(n, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/** "+$1,200" / "−$1,200"; zero has no sign. */
export function signedUsd(n: number, digits = 0): string {
  return `${n > 0 ? "+" : ""}${usd(n, digits)}`
}

export type ValueFormat = "money" | "money2" | "percent" | "number"

export function formatValue(
  n: number,
  format: ValueFormat,
  signed = false
): string {
  const plus = signed && n > 0 ? "+" : ""
  switch (format) {
    case "money2":
      return plus + usd(n, 2)
    case "percent":
      return `${plus}${n < 0 ? MINUS : ""}${Math.round(Math.abs(n) * 100)}%`
    case "number":
      return `${plus}${n < 0 ? MINUS : ""}${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    default:
      return plus + usd(n)
  }
}

/** Good/bad coloring for a delta, by which direction is good. */
export function deltaClass(n: number, goodWhen: "up" | "down"): string {
  if (n === 0) return "text-muted-foreground"
  const good = goodWhen === "up" ? n > 0 : n < 0
  return good
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400"
}

const KIND_ICON: Record<string, LucideIcon> = {
  pay: Wallet,
  card: CreditCard,
  bill: CalendarClock,
  info: Sparkles,
}

export function KindIcon({
  kind,
  size = 14,
  className,
}: {
  kind: string
  size?: number
  className?: string
}) {
  const Icon = KIND_ICON[kind] ?? CalendarClock
  return <Icon size={size} className={className} aria-hidden="true" />
}
