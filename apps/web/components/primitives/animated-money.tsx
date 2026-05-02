"use client"

import * as React from "react"
import NumberFlow from "@number-flow/react"

import { cn } from "@/lib/utils"

interface AnimatedMoneyProps {
  value: number
  currency?: string
  /** "auto" colors positive green, negative red. Plain `null` → default. */
  tone?: "auto" | "pos" | "neg" | "muted" | null
  className?: string
}

export function AnimatedMoney({
  value,
  currency = "USD",
  tone = null,
  className,
}: AnimatedMoneyProps) {
  const isNegative = value < 0
  const colorClass =
    tone === "auto"
      ? isNegative
        ? "text-rose-600 dark:text-rose-400"
        : "text-emerald-600 dark:text-emerald-400"
      : tone === "pos"
        ? "text-emerald-600 dark:text-emerald-400"
        : tone === "neg"
          ? "text-rose-600 dark:text-rose-400"
          : tone === "muted"
            ? "text-muted-foreground"
            : ""

  // Re-key on color so a sign flip (auto tone) remounts the shadow DOM.
  // Otherwise NumberFlow's `mix-blend-mode: plus-lighter` symbol layers can
  // hold the old paint, leaving the currency glyph in the previous color
  // while digits show the new one.
  return (
    <NumberFlow
      key={colorClass || "default"}
      value={value}
      format={{
        style: "currency",
        currency,
        maximumFractionDigits: 2,
        minimumFractionDigits: 2,
      }}
      className={cn("font-mono tabular-nums", colorClass, className)}
    />
  )
}
