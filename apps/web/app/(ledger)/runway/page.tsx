"use client"

// Runway: the next couple of years, month by month. One request:
// `/api/ext/runway_data` returns each person's resolved plan (balances from
// the ledger or their own file); `lib/runway/engine` does the rest.
//
// Like /fire and /portfolio there is no mobile tab-bar entry; the layout
// stacks to one column on narrow screens.

import { AlertCircle } from "lucide-react"

import { RunwayView } from "@/components/runway/runway-page"
import { Skeleton } from "@/components/ui/skeleton"
import { useRunwayData } from "@/hooks/use-runway"

export default function RunwayPage() {
  const runway = useRunwayData()

  if (runway.error) {
    return (
      <div className="flex flex-col gap-4 px-7 pt-2 pb-10">
        <h1 className="font-medium text-xl tracking-tight">Runway</h1>
        <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose-500" />
          <div className="flex flex-col gap-0.5">
            <div className="font-medium">Couldn&apos;t load runway data</div>
            <div className="text-muted-foreground text-xs">
              {runway.error instanceof Error
                ? runway.error.message
                : String(runway.error)}
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!runway.data) {
    return (
      <div className="flex flex-col gap-4 px-7 pt-2 pb-10 xl:grid xl:grid-cols-[minmax(0,1.45fr)_minmax(26rem,1fr)] xl:gap-6">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-10 w-72" />
          <div className="flex gap-6">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-12 w-28" />
            ))}
          </div>
          <Skeleton className="h-[34dvh] w-full" />
        </div>
        <Skeleton className="hidden h-[60dvh] xl:block" />
      </div>
    )
  }

  return (
    <RunwayView data={runway.data} onReload={() => void runway.refetch()} />
  )
}
