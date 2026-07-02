"use client"

import * as React from "react"

import { MobileExpenseCard } from "@/components/expenses/mobile/mobile-expense-card"
import { MobilePeriodControl } from "@/components/filters/mobile-period-control"
import { MobilePageHeader } from "@/components/layout/mobile-page-header"
import { Money } from "@/components/primitives/money"
import { formatRelativeDate } from "@/lib/format"
import type { ExpenseRowData } from "@/lib/transform/expense-row"
import { type DateGroup, groupByDate } from "@/lib/transform/group-by-date"
import type { Period } from "@/lib/types/views"

interface MobileExpensesProps {
  period: Period
  rows: ExpenseRowData[]
}

export function MobileExpenses({ period, rows }: MobileExpensesProps) {
  const groups = React.useMemo(
    () =>
      groupByDate(
        rows,
        (r) => r.row.txn.date,
        (r) => r.share
      ),
    [rows]
  )
  const totalSpent = rows.reduce((s, r) => s + r.share, 0)

  return (
    <div
      className="flex flex-col"
      style={{
        paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
      }}
    >
      <MobilePageHeader
        title="Expenses"
        sub={period.range}
        right={<MobilePeriodControl />}
      />

      <section className="px-5 pb-4">
        <Money
          value={-totalSpent}
          tone="neg"
          className="text-[32px] font-medium"
        />
        <span className="ml-2 text-[11px] text-muted-foreground">
          spent · {rows.length} transactions
        </span>
      </section>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <div className="text-sm text-muted-foreground">
            No expenses in this period.
          </div>
          <div className="text-xs text-muted-foreground/70">
            Try widening the period via the chip above.
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
          {groups.map((g) => (
            <DateGroupSection key={g.date} group={g} />
          ))}
        </div>
      )}
    </div>
  )
}

function DateGroupSection({ group }: { group: DateGroup<ExpenseRowData> }) {
  return (
    <section>
      <div className="sticky top-0 z-10 flex items-baseline justify-between gap-3 bg-gradient-to-b from-background from-70% to-transparent px-5 pt-4 pb-2">
        <span className="text-[13px] font-semibold">
          {formatRelativeDate(group.date)}
        </span>
        <Money
          value={-group.total}
          tone="muted"
          className="text-[12px] font-normal"
        />
      </div>
      <div className="flex flex-col gap-1.5 px-3 pb-1">
        {group.rows.map((r) => (
          <MobileExpenseCard key={r.row.txn.id} data={r} />
        ))}
      </div>
    </section>
  )
}
