"use client"

import { ShowMorePeriod } from "@/components/journal/show-more-period"
import { useUIState } from "@/components/layout/ui-state"
import { AccountDot } from "@/components/primitives/account-dot"
import { Money } from "@/components/primitives/money"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { useAccountBalance } from "@/hooks/use-account-balance"
import { useDisplayAccount } from "@/lib/accounts/display-names"
import { formatLongDate, formatNativeAmount } from "@/lib/format"
import { cn } from "@/lib/utils"

interface AccountBalanceCardProps {
  /** Full Beancount path of the filtered account. */
  account: string
  /**
   * True when tokens beyond the account (tag/link/payee/text/exclude) are also
   * narrowing the rows. The balance below comes from fava's balance sheet and
   * carries none of them, so we say so rather than implying the two agree.
   */
  hasOtherFilters?: boolean
  className?: string
}

/**
 * Shown in place of the journal rows when an account is selected but the
 * period holds no transactions for it. An empty list is otherwise
 * indistinguishable from "this account doesn't exist" — the standing balance
 * is the one thing still worth knowing, plus a one-click way to widen the
 * range until something shows up.
 */
export function AccountBalanceCard({
  account,
  hasOtherFilters = false,
  className,
}: AccountBalanceCardProps) {
  const { period } = useUIState()
  const displayAccount = useDisplayAccount()
  const balance = useAccountBalance(account)
  const name = displayAccount(account)

  // A zeroed account comes back with no currencies at all — headline it as
  // $0.00 rather than leaving the card's main line blank.
  const [headline, ...rest] = balance.totals.length
    ? balance.totals
    : [{ currency: "USD", amount: 0 }]

  const asOfLabel = balance.asOf
    ? `${balance.kind === "snapshot" ? "Balance as of" : "Total through"} ${formatLongDate(balance.asOf)}`
    : balance.kind === "snapshot"
      ? "Balance across all time"
      : "Total across all time"

  return (
    <Card className={cn("gap-3 py-4", className)}>
      <div className="flex items-start justify-between gap-4 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <AccountDot root={balance.root} />
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-medium">{name}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {account}
            </span>
          </div>
        </div>
        <span className="shrink-0 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {balance.root}
        </span>
      </div>

      <div className="flex flex-col gap-1 px-4">
        {balance.isPending ? (
          <Skeleton className="h-8 w-40" />
        ) : balance.isError ? (
          <div className="text-sm text-muted-foreground">
            Couldn&apos;t load this account&apos;s balance.
          </div>
        ) : (
          <Money
            value={headline.amount}
            currency={headline.currency}
            tone="auto"
            className="text-3xl font-medium tracking-tight"
          />
        )}
        <div className="text-xs text-muted-foreground">
          {balance.found || balance.isPending || balance.isError
            ? asOfLabel
            : "No postings on record for this account."}
        </div>
        {rest.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {rest.map((h) => (
              <span
                key={h.currency}
                className="font-mono text-xs text-muted-foreground tabular-nums"
              >
                {formatNativeAmount(h.amount, h.currency)}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 pt-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-muted-foreground">
            No transactions{period.range ? ` in ${period.range}` : ""}.
          </span>
          {hasOtherFilters && (
            <span className="text-xs text-muted-foreground/70">
              The balance above ignores the other active search filters.
            </span>
          )}
        </div>
        <ShowMorePeriod />
      </div>
    </Card>
  )
}
