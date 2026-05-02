"use client"

import * as React from "react"
import { AlertCircle } from "lucide-react"

import { BankPanel } from "@/components/plan/bank-panel"
import { CcStripA } from "@/components/plan/cc-strip-a"
import { PlanGrid } from "@/components/plan/plan-grid"
import { Skeleton } from "@/components/ui/skeleton"
import { usePlanGrid, usePlanSettings } from "@/hooks/use-plan"

export default function PlanPage() {
  const grid = usePlanGrid()
  const settings = usePlanSettings()
  const [stateFilter, setStateFilter] = React.useState<
    "todo" | "pending" | null
  >(null)

  if (grid.isPending) {
    return (
      <div className="flex h-full flex-col gap-3 overflow-hidden px-7 pt-4 pb-2">
        <header>
          <div className="text-xl font-medium tracking-tight">Plan</div>
          <div className="mt-0.5 text-xs text-muted-foreground">Loading…</div>
        </header>
        <Skeleton className="h-24 w-full shrink-0" />
        <Skeleton className="min-h-0 w-full flex-1" />
      </div>
    )
  }

  if (grid.error || !grid.data) {
    const msg =
      grid.error instanceof Error
        ? grid.error.message
        : String(grid.error ?? "Unknown error")
    return (
      <div className="flex h-full flex-col gap-3 overflow-hidden px-7 pt-4 pb-2">
        <header>
          <div className="text-xl font-medium tracking-tight">Plan</div>
        </header>
        <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose-500" />
          <div className="flex flex-col gap-0.5">
            <div className="font-medium">Couldn&apos;t load planner data</div>
            <div className="text-xs text-muted-foreground">{msg}</div>
          </div>
        </div>
      </div>
    )
  }

  const data = grid.data
  const dayLabel = formatToday(data.today)

  return (
    <div className="flex h-full flex-col gap-3 overflow-hidden px-7 pt-4 pb-2">
      <header className="shrink-0">
        <div className="text-xl font-medium tracking-tight">Plan</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {dayLabel} · {data.start} → {data.end}
        </div>
      </header>
      <div className="flex shrink-0 items-center gap-4 text-xs">
        <span className="font-medium text-muted-foreground">Cards</span>
        {data.todoCount > 0 && (
          <FilterChip
            tone="amber"
            active={stateFilter === "todo"}
            onClick={() =>
              setStateFilter(stateFilter === "todo" ? null : "todo")
            }
          >
            {data.todoCount} to-do{data.todoCount === 1 ? "" : "s"}
          </FilterChip>
        )}
        {data.pendingCount > 0 && (
          <FilterChip
            tone="sky"
            active={stateFilter === "pending"}
            onClick={() =>
              setStateFilter(stateFilter === "pending" ? null : "pending")
            }
          >
            {data.pendingCount} pending
          </FilterChip>
        )}
        {data.pastPlanCount > 0 && (
          <span className="rounded-sm bg-muted px-1.5 py-0.5 font-medium text-muted-foreground">
            {data.pastPlanCount} past plan{data.pastPlanCount === 1 ? "" : "s"}
          </span>
        )}
        {data.floatingProjections.length > 0 && (
          <span className="rounded-sm bg-rose-500/10 px-1.5 py-0.5 font-medium text-rose-700 dark:text-rose-400">
            {data.floatingProjections.length} unassigned CC
          </span>
        )}
        <div className="ml-auto">
          {settings.data && (
            <BankPanel banks={data.banks} settings={settings.data} />
          )}
        </div>
      </div>
      <div className="shrink-0">
        <CcStripA cards={data.ccCards} banks={data.banks} today={data.today} />
      </div>
      <PlanGrid
        data={data}
        bankOrder={settings.data?.bankPanel.bankOrder ?? []}
        hiddenBanks={new Set(settings.data?.bankPanel.hiddenBanks ?? [])}
        stateFilter={stateFilter}
      />
    </div>
  )
}

function FilterChip({
  tone,
  active,
  onClick,
  children,
}: {
  tone: "amber" | "sky"
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  const base =
    tone === "amber"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400 ring-amber-500/30"
      : "bg-sky-500/15 text-sky-700 dark:text-sky-400 ring-sky-500/30"
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-sm px-1.5 py-0.5 font-medium transition-colors ${base} ${
        active ? "ring-2" : "hover:ring-1"
      }`}
    >
      {children}
    </button>
  )
}

function formatToday(iso: string): string {
  const d = new Date(iso + "T00:00:00")
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ]
  return `${days[d.getDay()]}, ${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}
