import { SkeletonPeriodChip } from "@/components/skeletons/atoms"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

// Desktop /journal skeleton — header, filter bar, column headers, then
// a stack of full transaction cards (header row + 3 posting sub-rows).
export function JournalSkeleton() {
  return (
    <>
      <header className="flex flex-col gap-2">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-3 w-40" />
      </header>

      <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2">
        <Skeleton className="size-3 rounded-sm" />
        <Skeleton className="h-3 max-w-md flex-1" />
        <Skeleton className="h-3 w-16" />
      </div>

      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card
            key={i}
            className="gap-0 overflow-hidden rounded-md border bg-card p-0"
          >
            {/* Header row */}
            <div
              className="grid h-11 items-center gap-3 px-7"
              style={{
                gridTemplateColumns: "5.5rem 1rem 1fr 9rem",
              }}
            >
              <Skeleton className="h-3 w-12" />
              <span className="size-3" />
              <div className="flex items-center gap-2">
                <Skeleton className="size-7 rounded-full" />
                <Skeleton className="h-3 w-2/3" />
              </div>
              <span />
            </div>
            {/* Posting sub-rows */}
            {Array.from({ length: 3 }).map((_, j) => (
              <div
                key={j}
                className="grid h-7 items-center gap-3 pr-7 pl-[1.625rem]"
                style={{
                  gridTemplateColumns: "5.5rem 1rem 1fr 9rem",
                }}
              >
                <span />
                <span />
                <Skeleton className="h-2.5 w-1/2 opacity-70" />
                <Skeleton className="h-2.5 w-20 justify-self-end opacity-70" />
              </div>
            ))}
          </Card>
        ))}
      </div>
    </>
  )
}

// Mobile /journal skeleton — page header, date-grouped timeline of
// transaction cards (avatar + payee, then a posting list).
export function MobileJournalSkeleton() {
  return (
    <div className="flex flex-col pb-6">
      <header
        className="flex items-end justify-between gap-3 px-5 pb-3"
        style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
      >
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-2.5 w-40" />
        </div>
        <SkeletonPeriodChip />
      </header>

      {Array.from({ length: 3 }).map((_, group) => (
        <section key={group}>
          <div className="flex items-baseline justify-between px-5 pt-4 pb-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-2.5 w-12" />
          </div>
          <div className="flex flex-col gap-1.5 px-3 pb-1">
            {Array.from({ length: 2 }).map((_, i) => (
              <Card key={i} className="gap-0 rounded-[10px] border bg-card p-0">
                <div className="flex items-center gap-3 p-3">
                  <Skeleton className="size-7 shrink-0 rounded-full" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
                <div className="flex flex-col gap-1 border-t px-3 py-2 pl-13">
                  {Array.from({ length: 3 }).map((_, j) => (
                    <div
                      key={j}
                      className="flex items-baseline justify-between gap-3"
                    >
                      <Skeleton className="h-2.5 w-1/2 opacity-70" />
                      <Skeleton className="h-2.5 w-16 opacity-70" />
                    </div>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
