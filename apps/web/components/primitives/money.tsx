import { formatMoney } from "@/lib/format"
import { cn } from "@/lib/utils"

type Tone = "auto" | "pos" | "neg" | "muted" | "none"

interface MoneyProps {
  value: number
  currency?: string
  tone?: Tone
  className?: string
  minimumFractionDigits?: number
  maximumFractionDigits?: number
}

function toneClass(tone: Tone, value: number): string {
  if (tone === "none") return ""
  if (tone === "muted") return "text-muted-foreground"
  if (tone === "pos") return "text-emerald-600 dark:text-emerald-400"
  if (tone === "neg") return "text-rose-600 dark:text-rose-400"
  if (value > 0) return "text-emerald-600 dark:text-emerald-400"
  if (value < 0) return "text-rose-600 dark:text-rose-400"
  return "text-muted-foreground"
}

export function Money({
  value,
  currency = "USD",
  tone = "none",
  className,
  minimumFractionDigits,
  maximumFractionDigits,
}: MoneyProps) {
  return (
    <span
      className={cn(
        "font-mono tracking-tight tabular-nums",
        tone !== "none" && toneClass(tone, value),
        className
      )}
    >
      {formatMoney(value, {
        currency,
        minimumFractionDigits,
        maximumFractionDigits,
      })}
    </span>
  )
}
