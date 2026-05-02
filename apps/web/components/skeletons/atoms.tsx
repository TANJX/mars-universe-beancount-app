// Small reusable skeleton shapes that mirror the actual UI primitives
// (hero amount, chart area, list row, tree row, section label). Composers
// in this folder build up per-page skeletons by stacking these.

import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

const HERO_VALUE_HEIGHT = {
  md: "h-7",
  lg: "h-9",
  xl: "h-11",
} as const

const HERO_VALUE_WIDTH = {
  md: "w-32",
  lg: "w-44",
  xl: "w-56",
} as const

interface SkeletonHeroAmountProps {
  size?: keyof typeof HERO_VALUE_HEIGHT
  withDelta?: boolean
  withLabel?: boolean
  className?: string
}

export function SkeletonHeroAmount({
  size = "lg",
  withDelta = true,
  withLabel = true,
  className,
}: SkeletonHeroAmountProps) {
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {withLabel && <Skeleton className="h-2.5 w-20" />}
      <Skeleton
        className={cn(HERO_VALUE_HEIGHT[size], HERO_VALUE_WIDTH[size])}
      />
      {withDelta && <Skeleton className="h-3 w-28" />}
    </div>
  )
}

export function SkeletonChart({
  className,
  heightClass = "h-56",
}: {
  className?: string
  heightClass?: string
}) {
  return <Skeleton className={cn("w-full", heightClass, className)} />
}

interface SkeletonRowProps {
  leading?: "avatar" | "dot" | "none"
  /** "amount-stack" renders amount + delta vertically (matches mobile accounts). */
  trailing?: "amount" | "amount-stack" | "none"
  /** When 2, renders a dimmer second line for sub-text. */
  lines?: 1 | 2
  className?: string
}

export function SkeletonRow({
  leading = "avatar",
  trailing = "amount",
  lines = 2,
  className,
}: SkeletonRowProps) {
  return (
    <div className={cn("flex items-center gap-3 py-2.5", className)}>
      {leading === "avatar" && (
        <Skeleton className="size-7 shrink-0 rounded-full" />
      )}
      {leading === "dot" && (
        <Skeleton className="size-2 shrink-0 rounded-full" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton className="h-3 w-1/2" />
        {lines === 2 && <Skeleton className="h-2.5 w-1/3 opacity-60" />}
      </div>
      {trailing === "amount" && <Skeleton className="h-3 w-16" />}
      {trailing === "amount-stack" && (
        <div className="flex flex-col items-end gap-1.5">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-2.5 w-12 opacity-60" />
        </div>
      )}
    </div>
  )
}

interface SkeletonTreeRowProps {
  depth?: number
  hasCaret?: boolean
  /** Show the "N accounts" mono hint between name and amount. */
  hasSub?: boolean
  bold?: boolean
}

export function SkeletonTreeRow({
  depth = 0,
  hasCaret = true,
  hasSub = false,
  bold = false,
}: SkeletonTreeRowProps) {
  return (
    <div
      className="flex min-h-11 items-center gap-2 border-b py-2 pr-2"
      style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
    >
      {hasCaret ? (
        <Skeleton className="size-2.5 shrink-0 rounded-sm" />
      ) : (
        <span aria-hidden className="size-2.5 shrink-0" />
      )}
      <Skeleton className="size-2 shrink-0 rounded-full" />
      <Skeleton
        className={cn(
          "h-3 flex-1",
          bold ? "max-w-[35%]" : "max-w-[40%]",
          depth > 0 && "opacity-80"
        )}
      />
      {hasSub && <Skeleton className="h-2.5 w-16 opacity-60" />}
      <Skeleton className="h-3 w-20" />
    </div>
  )
}

export function SkeletonSectionLabel({
  rightWidth,
  className,
}: {
  rightWidth?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex items-baseline justify-between px-5 pt-5 pb-2.5",
        className
      )}
    >
      <Skeleton className="h-2.5 w-16" />
      {rightWidth && <Skeleton className={cn("h-2.5", rightWidth)} />}
    </div>
  )
}

export function SkeletonPeriodChip() {
  return <Skeleton className="h-9 w-24 rounded-full" />
}
