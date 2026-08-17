"use client"

import * as React from "react"

import { MobilePeriodControl } from "@/components/filters/mobile-period-control"
import { AccountBalanceCard } from "@/components/journal/account-balance-card"
import { MobileJournalCard } from "@/components/journal/mobile/mobile-journal-card"
import { ShowMorePeriod } from "@/components/journal/show-more-period"
import { MobilePageHeader } from "@/components/layout/mobile-page-header"
import { formatRelativeDate } from "@/lib/format"
import type { Token } from "@/lib/search/parse"
import { type DateGroup, groupByDate } from "@/lib/transform/group-by-date"
import type { Transaction } from "@/lib/types/beancount"
import type { Period } from "@/lib/types/views"

interface MobileJournalProps {
  period: Period
  rows: Transaction[]
  totalCount: number
  accountFilter?: string
  /** True when tokens beyond the account are also narrowing the rows. */
  hasOtherFilters?: boolean
  /** Map of txn.id → cumulative USD running balance (when filtered). */
  cumulative?: Map<string, number>
  /** Click handler for tag/link badges — appends to the search filter. */
  onAddToken?: (token: Token) => void
}

export function MobileJournal({
  period,
  rows,
  totalCount,
  accountFilter,
  hasOtherFilters = false,
  cumulative,
  onAddToken,
}: MobileJournalProps) {
  const groups = React.useMemo(() => groupByDate(rows, (t) => t.date), [rows])

  return (
    <div
      className="flex flex-col"
      style={{
        paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))",
      }}
    >
      <MobilePageHeader
        title="Journal"
        sub={`${rows.length} of ${totalCount} · ${period.range}`}
        right={<MobilePeriodControl />}
      />

      {rows.length === 0 ? (
        accountFilter ? (
          <div className="px-3 pt-2">
            <AccountBalanceCard
              account={accountFilter}
              hasOtherFilters={hasOtherFilters}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <div className="flex flex-col gap-1">
              <div className="text-sm text-muted-foreground">
                No transactions in this period.
              </div>
              <div className="text-xs text-muted-foreground/70">
                Widen the period below, or via the chip above.
              </div>
            </div>
            <ShowMorePeriod />
          </div>
        )
      ) : (
        <>
          <div className="flex flex-col">
            {groups.map((g) => (
              <DateGroupSection
                key={g.date}
                group={g}
                accountFilter={accountFilter}
                cumulative={cumulative}
                onAddToken={onAddToken}
              />
            ))}
          </div>
          <div className="flex justify-center px-3 pt-4">
            <ShowMorePeriod />
          </div>
        </>
      )}
    </div>
  )
}

function DateGroupSection({
  group,
  accountFilter,
  cumulative,
  onAddToken,
}: {
  group: DateGroup<Transaction>
  accountFilter?: string
  cumulative?: Map<string, number>
  onAddToken?: (token: Token) => void
}) {
  return (
    <section>
      <div className="sticky top-0 z-10 flex items-baseline justify-between gap-3 bg-gradient-to-b from-background from-70% to-transparent px-5 pt-4 pb-2">
        <span className="text-[13px] font-semibold">
          {formatRelativeDate(group.date)}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {group.rows.length} txn{group.rows.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="flex flex-col gap-1.5 px-3 pb-1">
        {group.rows.map((txn) => (
          <MobileJournalCard
            key={txn.id}
            txn={txn}
            accountFilter={accountFilter}
            cumulativeUSD={
              accountFilter && cumulative
                ? (cumulative.get(txn.id) ?? null)
                : null
            }
            onAddToken={onAddToken}
          />
        ))}
      </div>
    </section>
  )
}
