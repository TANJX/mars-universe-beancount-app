import {
  SkeletonChart,
  SkeletonHeroAmount,
  SkeletonPeriodChip,
  SkeletonRow,
} from "@/components/skeletons/atoms"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

// Desktop /expenses skeleton — header (title + total spent), daily chart
// card, filter bar, then a tabular row stack.
export function ExpensesSkeleton() {
  return (
    <>
      <header className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-3 w-44" />
        </div>
        <div className="flex flex-col items-end gap-2">
          <Skeleton className="h-2.5 w-20" />
          <Skeleton className="h-7 w-32" />
        </div>
      </header>

      <Card className="gap-2 p-4">
        <Skeleton className="h-3 w-24" />
        <SkeletonChart heightClass="h-32" />
      </Card>

      <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2">
        <Skeleton className="size-3 rounded-sm" />
        <Skeleton className="h-3 max-w-md flex-1" />
        <Skeleton className="h-3 w-16" />
      </div>

      <div className="flex flex-col">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="grid h-11 items-center gap-3 border-b px-5"
            style={{
              gridTemplateColumns:
                "4rem 1.75rem minmax(11rem, 1.6fr) 6.25rem minmax(7rem, 1fr) 6.875rem",
            }}
          >
            <Skeleton className="h-3 w-12" />
            <Skeleton className="size-7 rounded-full" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-16 justify-self-end" />
          </div>
        ))}
      </div>
    </>
  )
}

// Mobile /expenses skeleton — page header, hero spent, date-grouped
// timeline cards (sticky group label + 2 cards).
export function MobileExpensesSkeleton() {
  return (
    <div className="flex flex-col pb-6">
      <header
        className="flex items-end justify-between gap-3 px-5 pb-3"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-28" />
          <Skeleton className="h-2.5 w-32" />
        </div>
        <SkeletonPeriodChip />
      </header>

      <section className="flex items-baseline gap-2 px-5 pb-4">
        <SkeletonHeroAmount size="lg" withLabel={false} withDelta={false} />
        <Skeleton className="h-2.5 w-32" />
      </section>

      {Array.from({ length: 3 }).map((_, group) => (
        <section key={group}>
          <div className="flex items-baseline justify-between px-5 pt-4 pb-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-2.5 w-16" />
          </div>
          <div className="flex flex-col gap-1.5 px-3 pb-1">
            {Array.from({ length: 2 }).map((_, i) => (
              <Card key={i} className="rounded-[10px] border bg-card p-3">
                <SkeletonRow className="py-0" />
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
