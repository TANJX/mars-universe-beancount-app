import {
  SkeletonChart,
  SkeletonHeroAmount,
  SkeletonPeriodChip,
  SkeletonTreeRow,
} from "@/components/skeletons/atoms"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

// Desktop /income skeleton — header (title + In/Out/Net cells), chart
// card with segmented control, 2-col Income/Expenses trees.
export function IncomeSkeleton() {
  return (
    <>
      <header className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-20" />
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
          <Skeleton className="h-7 w-32 rounded-md" />
        </div>
        <SkeletonChart />
      </Card>

      <div className="grid grid-cols-2 items-start gap-4">
        {[0, 1].map((card) => (
          <Card key={card} className="gap-0 overflow-hidden p-0">
            <div className="flex items-center justify-between border-b px-4 pt-3 pb-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-16" />
            </div>
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonTreeRow key={i} depth={i % 2} />
            ))}
          </Card>
        ))}
      </div>
    </>
  )
}

// Mobile /income skeleton — page header, In/Net stats, monthly chart,
// stacked Income + Expenses trees.
export function MobileIncomeSkeleton() {
  return (
    <div className="flex flex-col pb-6">
      <header
        className="flex items-end justify-between gap-3 px-5 pb-3"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-2.5 w-32" />
        </div>
        <SkeletonPeriodChip />
      </header>

      <section className="flex gap-6 px-5 pb-3">
        <SkeletonHeroAmount size="md" withDelta={false} />
        <SkeletonHeroAmount size="md" withDelta={false} />
      </section>

      <div className="border-t border-b py-2">
        <SkeletonChart heightClass="h-40" />
      </div>

      <div className="px-3.5 pt-3">
        {[0, 1].map((tree) => (
          <div key={tree}>
            <SkeletonTreeRow hasCaret bold />
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonTreeRow key={i} depth={1} hasSub />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
