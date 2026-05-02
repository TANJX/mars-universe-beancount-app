import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { MINUS } from "@/lib/format"

interface DeltaPillProps {
  value: number
  className?: string
}

export function DeltaPill({ value, className }: DeltaPillProps) {
  const positive = value >= 0
  const sign = positive ? "+" : MINUS
  return (
    <Badge
      variant="outline"
      className={cn(
        "h-5 border-transparent px-1.5 text-xs tabular-nums",
        positive
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-rose-500/10 text-rose-600 dark:text-rose-400",
        className
      )}
    >
      {sign}
      {Math.abs(value).toFixed(1)}%
    </Badge>
  )
}
