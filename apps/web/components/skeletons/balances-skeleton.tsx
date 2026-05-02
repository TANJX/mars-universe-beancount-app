import {
  SkeletonChart,
  SkeletonHeroAmount,
  SkeletonPeriodChip,
  SkeletonTreeRow,
} from "@/components/skeletons/atoms"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

// Desktop /balances skeleton — header (title + 3 numeric cells), chart
// card, then 2-col tree grid (Assets | Liabilities + Equity).
export function BalancesSkeleton() {
  return (
    <>
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
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-3 w-16" />
        </div>
        <SkeletonChart />
      </Card>

      <div className="grid grid-cols-2 items-start gap-4">
        <Card className="gap-0 overflow-hidden p-0">
          <SubtreeRows label />
        </Card>
        <Card className="gap-0 divide-y overflow-hidden p-0">
          <SubtreeRows label />
          <SubtreeRows label />
        </Card>
      </div>
    </>
  )
}

function SubtreeRows({ label }: { label?: boolean }) {
  return (
    <>
      {label && (
        <div className="flex items-center justify-between border-b px-4 pt-3 pb-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-16" />
        </div>
      )}
      {Array.from({ length: 5 }).map((_, i) => (
        <SkeletonTreeRow key={i} depth={i % 2} />
      ))}
    </>
  )
}

// Mobile /balances skeleton — page header, hero net worth, chart with
// hairlines, three trees (Assets / Liabilities / Equity).
export function MobileBalancesSkeleton() {
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
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-2.5 w-16" />
      </section>

      <div className="border-t border-b py-2">
        <SkeletonChart heightClass="h-40" />
      </div>

      <div className="px-3.5 pt-1">
        {Array.from({ length: 3 }).map((_, treeIdx) => (
          <div key={treeIdx}>
            <SkeletonTreeRow hasCaret hasSub={false} bold />
            {treeIdx < 2 &&
              Array.from({ length: 3 }).map((_, i) => (
                <SkeletonTreeRow key={i} depth={1} hasSub />
              ))}
          </div>
        ))}
      </div>
    </div>
  )
}
