import {
  SkeletonChart,
  SkeletonHeroAmount,
  SkeletonPeriodChip,
  SkeletonRow,
  SkeletonSectionLabel,
} from "@/components/skeletons/atoms"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

// Desktop /overview skeleton — mirrors NetWorthHero (split row), StatRow
// (3 cards with sparklines), then a 1.5fr/1fr grid of RecentActivity +
// (CategoryBars / AccountsSummary).
export function OverviewSkeleton() {
  return (
    <>
      <div className="flex items-start justify-between gap-6">
        <SkeletonHeroAmount size="xl" />
        <div className="w-60 shrink-0">
          <SkeletonChart heightClass="h-14" />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="gap-2 p-4">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-7 w-32" />
            <SkeletonChart heightClass="h-7" />
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-[1.5fr_1fr] gap-4">
        <Card className="gap-3 p-0 pt-3">
          <div className="flex items-center justify-between px-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-3 w-16" />
          </div>
          <div className="flex flex-col px-4 pb-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        </Card>
        <div className="flex flex-col gap-4">
          <Card className="gap-3 p-4">
            <Skeleton className="h-3 w-24" />
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="flex items-center gap-2">
                <Skeleton className="h-3 flex-1" />
                <Skeleton className="h-3 w-14" />
              </div>
            ))}
          </Card>
          <Card className="gap-2 p-0 pt-3">
            <div className="px-4">
              <Skeleton className="h-3 w-20" />
            </div>
            <div className="flex flex-col px-4 pb-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <SkeletonRow key={i} leading="dot" trailing="amount-stack" />
              ))}
            </div>
          </Card>
        </div>
      </div>
    </>
  )
}

// Mobile /overview skeleton — brand header → hero with sparkline →
// In/Out mini stats → Recent rows → Accounts rows.
export function MobileOverviewSkeleton() {
  return (
    <div className="flex flex-col pb-6">
      <header
        className="flex shrink-0 items-center justify-between px-5 pb-3"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <div className="flex items-center gap-2">
          <Skeleton className="size-6 rounded-md" />
          <Skeleton className="h-3 w-24" />
        </div>
        <SkeletonPeriodChip />
      </header>

      <section className="px-5 pt-2 pb-4">
        <SkeletonHeroAmount size="xl" />
        <SkeletonChart heightClass="h-14" className="mt-3.5" />
      </section>

      <div className="grid grid-cols-2 gap-2.5 px-5">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-[10px] border bg-card px-3.5 py-3"
          >
            <Skeleton className="h-2.5 w-10" />
            <Skeleton className="h-5 w-24" />
          </div>
        ))}
      </div>

      <SkeletonSectionLabel rightWidth="w-12" />
      <div className="px-5">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonRow key={i} className="border-b" />
        ))}
      </div>

      <SkeletonSectionLabel rightWidth="w-10" />
      <div className="px-5">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonRow
            key={i}
            leading="dot"
            trailing="amount-stack"
            className="border-b"
          />
        ))}
      </div>
    </div>
  )
}
