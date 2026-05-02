"use client"

import * as React from "react"

import { MobileBalancesTree } from "@/components/balances/mobile/mobile-balances-tree"
import { MobileNetWorthChart } from "@/components/balances/mobile/mobile-net-worth-chart"
import type { NetWorthPoint } from "@/components/balances/net-worth-chart"
import { MobilePeriodControl } from "@/components/filters/mobile-period-control"
import { MobilePageHeader } from "@/components/layout/mobile-page-header"
import { Money } from "@/components/primitives/money"
import type { Period, TrialBalance } from "@/lib/types/views"

interface MobileBalancesProps {
  period: Period
  trees: TrialBalance["trees"]
  netWorth: number
  series?: NetWorthPoint[]
}

export function MobileBalances({
  period,
  trees,
  netWorth,
  series,
}: MobileBalancesProps) {
  // Hover/touch-scrub: while a finger is on the chart, the hero amount
  // tracks the scrubbed point. Releasing the touch snaps back to the
  // period total.
  const [hover, setHover] = React.useState<NetWorthPoint | null>(null)
  const heroValue = hover ? hover.net : netWorth

  return (
    <div
      className="flex flex-col"
      style={{
        paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
      }}
    >
      <MobilePageHeader
        title="Balances"
        sub={period.range}
        right={<MobilePeriodControl />}
      />

      <section className="px-5 pb-4">
        <Money
          value={heroValue}
          tone="none"
          className="text-[28px] font-medium"
        />
        <span className="ml-2 text-[11px] text-muted-foreground">
          net worth
        </span>
      </section>

      {series && series.length > 0 && (
        <div className="border-t border-b py-2">
          <MobileNetWorthChart data={series} onHover={setHover} />
        </div>
      )}

      <div className="px-3.5 pt-1">
        {trees.Assets && (
          <MobileBalancesTree rootKind="Assets" root={trees.Assets} />
        )}
        {trees.Liabilities && (
          <MobileBalancesTree rootKind="Liabilities" root={trees.Liabilities} />
        )}
        {trees.Equity && (
          <MobileBalancesTree
            rootKind="Equity"
            root={trees.Equity}
            defaultOpen={false}
          />
        )}
      </div>
    </div>
  )
}
