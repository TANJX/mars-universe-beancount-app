import { SkeletonChart, SkeletonHeroAmount } from "@/components/skeletons/atoms"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

// Desktop /portfolio skeleton — header (title + 3 numeric cells), the
// value-vs-cost chart card, the allocation / contribution two-up, then the
// positions table. Mirrors the real layout so nothing shifts on arrival.
export function PortfolioSkeleton() {
  return (
    <div className="flex flex-col gap-4 px-7 pt-2 pb-10">
      <header className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-3 w-40" />
        </div>
        <div className="flex items-end gap-7">
          <SkeletonHeroAmount size="md" withDelta={false} />
          <SkeletonHeroAmount size="md" withDelta={false} />
          <SkeletonHeroAmount size="lg" withDelta={false} />
        </div>
      </header>

      <Card className="gap-2 p-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-24" />
        </div>
        <SkeletonChart />
      </Card>

      <div className="grid grid-cols-2 items-start gap-4">
        <Card className="flex flex-col gap-3.5 p-4">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-6 w-40 rounded-md" />
          </div>
          <Skeleton className="h-7 w-full rounded-md" />
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-2.5 w-24" />
            ))}
          </div>
        </Card>
        <Card className="flex flex-col gap-4 p-4">
          <div className="flex items-center justify-between">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-2.5 w-24" />
          </div>
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-2 w-full rounded-full" />
              <div className="flex items-baseline justify-between">
                <Skeleton className="h-2.5 w-40" />
                <Skeleton className="h-2.5 w-20" />
              </div>
            </div>
          ))}
        </Card>
      </div>

      <Card className="gap-0 overflow-hidden p-0">
        <div className="flex items-center justify-between px-4 py-2.5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-32" />
        </div>
        <div className="border-b px-4 py-2">
          <Skeleton className="h-2.5 w-full opacity-60" />
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0"
          >
            <Skeleton className="h-3 w-40" />
            <div className="flex-1" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-14" />
          </div>
        ))}
      </Card>
    </div>
  )
}
