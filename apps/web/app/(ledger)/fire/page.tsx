"use client"

// FIRE explorer. One request: `/api/ext/fire_data` returns the live ledger
// snapshot, the user's `config/fire.yaml` and saved scenarios; everything else
// is computed client-side by `lib/fire/engine`.
//
// Mobile is deferred like /portfolio: no tab-bar entry, desktop layout at
// every width (sections stack to one column on narrow screens).

import { AlertCircle } from "lucide-react"

import { FireView } from "@/components/fire/fire-page"
import { Skeleton } from "@/components/ui/skeleton"
import { useFireData } from "@/hooks/use-fire"

export default function FirePage() {
  const fire = useFireData()

  if (fire.error) {
    return (
      <div className="flex flex-col gap-4 px-7 pt-2 pb-10">
        <h1 className="font-medium text-xl tracking-tight">FIRE</h1>
        <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose-500" />
          <div className="flex flex-col gap-0.5">
            <div className="font-medium">Couldn&apos;t load FIRE data</div>
            <div className="text-muted-foreground text-xs">
              {fire.error instanceof Error
                ? fire.error.message
                : String(fire.error)}
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (!fire.data) {
    return (
      <div className="flex flex-col gap-4 px-7 pt-2 pb-10">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-96 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return <FireView data={fire.data} />
}
