"use client"

import Link from "next/link"
import { usePeriodHref } from "@/components/layout/ui-state"
import { AccountDot } from "@/components/primitives/account-dot"
import { Money } from "@/components/primitives/money"
import type { AccountSummary } from "@/lib/types/views"

interface MobileAccountsSummaryProps {
  accounts: AccountSummary[]
  title?: string
  countLabel?: string
}

export function MobileAccountsSummary({
  accounts,
  title = "Accounts",
  countLabel = "open",
}: MobileAccountsSummaryProps) {
  const periodHref = usePeriodHref()

  return (
    <section>
      <div className="flex items-baseline justify-between px-5 pt-5 pb-2.5">
        <span className="text-[11px] font-medium tracking-[0.1em] text-muted-foreground uppercase">
          {title}
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          {accounts.length} {countLabel}
        </span>
      </div>
      <div className="px-5">
        {accounts.map((account) => (
          <Row
            key={account.account}
            account={account}
            href={periodHref(
              `/journal?account=${encodeURIComponent(account.account)}`
            )}
          />
        ))}
      </div>
    </section>
  )
}

function Row({ account, href }: { account: AccountSummary; href: string }) {
  return (
    <div className="flex items-center gap-3 border-b py-3">
      <AccountDot root={account.root} />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <Link
          href={href}
          className="truncate text-[13.5px] font-medium text-foreground underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {account.displayName ?? account.segment}
        </Link>
        {account.sub && (
          <span className="truncate font-mono text-[11px] text-muted-foreground tabular-nums">
            {account.sub}
          </span>
        )}
      </div>
      <Money value={account.balance} className="text-sm font-medium" />
    </div>
  )
}
