"use client"
// Today's issue: the agent-written dashboard from /api/ext/dashboard, framed
// as a page. Used by the /today route (and the Home prototype's Spec variant).
// One column below md; the catalog's Grid adds columns from md up.
import { DashboardView } from "@/components/dashboard/dashboard-view"
import { useDashboard } from "@/hooks/use-dashboard"

export function TodayIssue() {
  const q = useDashboard()
  return (
    <div className="@container/issue flex max-w-[1180px] flex-col gap-4 px-5 pt-3 pb-24 md:px-7 md:pt-7 md:pb-10">
      {q.isPending ? (
        <p className="py-10 text-sm text-muted-foreground">
          Loading today&apos;s issue…
        </p>
      ) : q.isError ? (
        <div className="flex flex-col gap-1 py-10 text-sm">
          <p className="font-medium">Could not load today&apos;s issue.</p>
          <p className="text-muted-foreground">{q.error.message}</p>
        </div>
      ) : (
        <DashboardView
          spec={q.data.spec}
          lkg={q.data.lkg}
          data={q.data.data}
          dataError={q.data.dataError}
        />
      )}
    </div>
  )
}
