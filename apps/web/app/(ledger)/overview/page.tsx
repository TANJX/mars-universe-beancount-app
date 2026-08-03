"use client"

import { AlertCircle } from "lucide-react"
import { useUIState } from "@/components/layout/ui-state"
import { AccountsSummary } from "@/components/overview/accounts-summary"
import { CategoryBars } from "@/components/overview/category-bars"
import { MobileOverview } from "@/components/overview/mobile/mobile-overview"
import { NetWorthHero } from "@/components/overview/net-worth-hero"
import { RecentActivity } from "@/components/overview/recent-activity"
import { StatRow } from "@/components/overview/stat-row"
import {
  MobileOverviewSkeleton,
  OverviewSkeleton,
} from "@/components/skeletons/overview-skeleton"
import {
  useBalanceSheet,
  useIncomeStatement,
  useJournal,
  useNetWorthSeries,
} from "@/hooks/use-fava"
import { useIsMobile } from "@/hooks/use-mobile"
import { useResolvedUIConfig } from "@/lib/config"
import { composeOverview } from "@/lib/transform/overview-stats"

// Recent Activity is a "what happened lately" feed, NOT a slice of the
// page's selected period. Always pulls the past 7 days so it stays useful
// when the user is viewing YTD or last-12 months.
const RECENT_LIMIT = 25
const RECENT_WINDOW_DAYS = 7

function pastWeekTime(): string {
  const today = new Date()
  const start = new Date(today)
  start.setDate(start.getDate() - RECENT_WINDOW_DAYS)
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  return `${fmt(start)} - ${fmt(today)}`
}

/** Build a Fava `time=` window covering the last 12 months ending today. */
function trailing12mTime(): string {
  const today = new Date()
  // Build from parts rather than setMonth: setMonth keeps the day-of-month and
  // normalizes overflow, so Jul 31 minus 11 months would skip a month.
  const start = new Date(today.getFullYear(), today.getMonth() - 11, 1)
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
  return `${fmt(start)} - ${fmt(today)}`
}

export default function OverviewPage() {
  const { period } = useUIState()
  const isMobile = useIsMobile()
  const balanceSheet = useBalanceSheet()
  const incomeStmt = useIncomeStatement()
  const { sidebar } = useResolvedUIConfig()

  // Period-independent rolling history for the sparklines on the hero +
  // stat tiles. So even on "this month" the curve has 12 months of trend.
  const netWorthHistory = useNetWorthSeries()
  const incomeHistory = useIncomeStatement({
    interval: "month",
    timeOverride: trailing12mTime(),
  })

  // Recent Activity always shows the past 7 days, independent of the page's
  // selected period. Otherwise the panel becomes useless when the user is
  // viewing YTD or last-12-months.
  const recentJournal = useJournal({ timeOverride: pastWeekTime() })

  const ready =
    balanceSheet.data &&
    incomeStmt.data &&
    recentJournal.data &&
    netWorthHistory.data &&
    incomeHistory.data
  const stats = ready
    ? composeOverview({
        period,
        trial: balanceSheet.data!,
        income: incomeStmt.data!,
        recentTxns: recentJournal.data!,
        bookmarks: sidebar.bookmarks,
        historyNetWorth: netWorthHistory.data!,
        historyMonthly: incomeHistory.data!.monthly,
      })
    : null

  const visibleRecent = (stats?.recent ?? []).slice(0, RECENT_LIMIT)

  const errored = balanceSheet.error || incomeStmt.error || recentJournal.error
  const errorMsg = errored
    ? errored instanceof Error
      ? errored.message
      : String(errored)
    : null

  if (isMobile) {
    return (
      <>
        {errorMsg && <ErrorBanner message={errorMsg} className="mx-5 mt-3" />}
        {stats ? (
          <MobileOverview stats={stats} visibleRecent={visibleRecent} />
        ) : (
          <MobileOverviewSkeleton />
        )}
      </>
    )
  }

  return (
    <div className="flex flex-col gap-4 px-7 pt-2 pb-10">
      {errorMsg && <ErrorBanner message={errorMsg} />}

      {stats ? (
        <>
          <NetWorthHero
            period={stats.period}
            netWorth={stats.netWorth}
            delta={stats.netWorthDelta}
            pct={stats.netWorthPct}
            series={stats.netWorthSeries}
          />
          <StatRow
            income={stats.income}
            incomeSeries={stats.incomeSeries}
            expenses={stats.expenses}
            expensesSeries={stats.expensesSeries}
            savings={stats.savings}
            savingsSeries={stats.savingsSeries}
            savingsRate={stats.savingsRate}
          />
          <div className="grid grid-cols-[1.5fr_1fr] gap-4">
            <RecentActivity rows={visibleRecent} />
            <div className="flex flex-col gap-4">
              <CategoryBars
                period={stats.period}
                categories={stats.topCategories}
              />
              <AccountsSummary
                accounts={stats.accounts}
                title="Accounts"
                countLabel="active"
              />
              {stats.inFlight.length > 0 && (
                <AccountsSummary
                  accounts={stats.inFlight}
                  title="In-Flight"
                  countLabel="pending"
                />
              )}
            </div>
          </div>
        </>
      ) : (
        <OverviewSkeleton />
      )}
    </div>
  )
}

function ErrorBanner({
  message,
  className,
}: {
  message: string
  className?: string
}) {
  return (
    <div
      className={
        "flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 p-3 text-sm " +
        (className ?? "")
      }
    >
      <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose-500" />
      <div className="flex flex-col gap-0.5">
        <div className="font-medium">Couldn&apos;t load overview</div>
        <div className="text-xs text-muted-foreground">{message}</div>
      </div>
    </div>
  )
}
