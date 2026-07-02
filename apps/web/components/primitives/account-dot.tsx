import type { AccountRoot } from "@/lib/types/views"
import { cn } from "@/lib/utils"

const ROOT_COLORS: Record<AccountRoot, string> = {
  Assets: "bg-emerald-500",
  Liabilities: "bg-rose-500",
  Equity: "bg-amber-500",
  Income: "bg-emerald-500",
  Expenses: "bg-rose-500",
}

interface AccountDotProps {
  root: AccountRoot
  size?: number
  className?: string
}

export function AccountDot({ root, size = 8, className }: AccountDotProps) {
  return (
    <span
      className={cn(
        "inline-block shrink-0 rounded-full",
        ROOT_COLORS[root],
        className
      )}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  )
}
