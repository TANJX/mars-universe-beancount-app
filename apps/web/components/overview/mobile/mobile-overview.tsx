"use client"

import { MobileAccountsSummary } from "@/components/overview/mobile/mobile-accounts-summary"
import { MobileMiniStats } from "@/components/overview/mobile/mobile-mini-stats"
import { MobileNetWorthHero } from "@/components/overview/mobile/mobile-net-worth-hero"
import { MobileRecentActivity } from "@/components/overview/mobile/mobile-recent-activity"
import { MobilePeriodControl } from "@/components/filters/mobile-period-control"
import { useResolvedUIConfig } from "@/lib/config"
import type { JournalRow, OverviewStats } from "@/lib/types/views"
import { MarsLogo } from "@/components/layout/mars-logo"

interface MobileOverviewProps {
  stats: OverviewStats
  visibleRecent: JournalRow[]
}

export function MobileOverview({ stats, visibleRecent }: MobileOverviewProps) {
  return (
    <div
      className="flex flex-col"
      style={{
        paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
      }}
    >
      <BrandHeader />
      <MobileNetWorthHero
        netWorth={stats.netWorth}
        delta={stats.netWorthDelta}
        series={stats.netWorthSeries}
      />
      <MobileMiniStats income={stats.income} expenses={stats.expenses} />
      <MobileRecentActivity rows={visibleRecent} />
      <MobileAccountsSummary
        accounts={stats.accounts}
        title="Accounts"
        countLabel="active"
      />
      {stats.inFlight.length > 0 && (
        <MobileAccountsSummary
          accounts={stats.inFlight}
          title="In-Flight"
          countLabel="pending"
        />
      )}
    </div>
  )
}

function BrandHeader() {
  const { branding } = useResolvedUIConfig()
  return (
    <header
      className="flex shrink-0 items-center justify-between px-5 pb-3"
      style={{ paddingTop: "max(0.75rem, env(safe-area-inset-top))" }}
    >
      <div className="flex items-center gap-2">
        <MarsLogo />
        <span className="text-sm font-semibold tracking-tight">
          {branding.title}
        </span>
      </div>
      <MobilePeriodControl />
    </header>
  )
}
