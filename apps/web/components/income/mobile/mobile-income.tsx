"use client"

import * as React from "react"

import { MobileBalancesTree } from "@/components/balances/mobile/mobile-balances-tree"
import { MobilePeriodControl } from "@/components/filters/mobile-period-control"
import { MobileMonthlyChart } from "@/components/income/mobile/mobile-monthly-chart"
import { MobilePageHeader } from "@/components/layout/mobile-page-header"
import { Money } from "@/components/primitives/money"
import type { IncomeStatement, MonthlyEntry, Period } from "@/lib/types/views"

interface MobileIncomeProps {
  period: Period
  statement: IncomeStatement
  /**
   * Trailing chart context (last N intervals). When absent the chart
   * section is omitted.
   */
  chart?: MonthlyEntry[]
}

export function MobileIncome({ period, statement, chart }: MobileIncomeProps) {
  // Beancount stores income negative. The desktop page reads
  // -(income.balanceChildren.USD ?? 0) so the user sees positive money in.
  const totalIn = -(statement.income.balanceChildren.USD ?? 0)
  const totalOut = statement.expenses.balanceChildren.USD ?? 0
  const net = totalIn - totalOut

  // Hover/touch-scrub on the chart updates the In/Net headline. Releasing
  // the touch snaps back to the period totals.
  const [hover, setHover] = React.useState<MonthlyEntry | null>(null)
  const headerIn = hover?.income ?? totalIn
  const headerNet = hover ? hover.income - hover.expense : net

  return (
    <div
      className="flex flex-col"
      style={{
        paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
      }}
    >
      <MobilePageHeader
        title="Income"
        sub={period.range}
        right={<MobilePeriodControl />}
      />

      <section className="flex gap-6 px-5 pb-3">
        <Stat label="In" value={headerIn} tone="pos" />
        <Stat label="Net" value={headerNet} />
      </section>

      {chart && chart.length > 0 && (
        <div className="border-t border-b py-2">
          <MobileMonthlyChart data={chart} onHover={setHover} />
        </div>
      )}

      <div className="px-3.5 pt-3">
        <MobileBalancesTree
          rootKind="Income"
          root={statement.income}
          flipSign
        />
        <MobileBalancesTree
          rootKind="Expenses"
          root={statement.expenses}
          flipSign
        />
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: "pos"
}) {
  return (
    <div>
      <div className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
        {label}
      </div>
      <Money
        value={value}
        tone={tone === "pos" ? "pos" : "none"}
        className="text-[26px] font-medium"
      />
    </div>
  )
}
