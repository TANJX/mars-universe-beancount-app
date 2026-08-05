"use client"

import Link from "next/link"
import { usePeriodHref } from "@/components/layout/ui-state"
import { Panel } from "@/components/overview/panel"
import { AccountDot } from "@/components/primitives/account-dot"
import { Money } from "@/components/primitives/money"
import type { AccountSummary } from "@/lib/types/views"

interface AccountsSummaryProps {
  accounts: AccountSummary[]
  title?: string
  countLabel?: string
}

export function AccountsSummary({
  accounts,
  title = "Accounts",
  countLabel = "open",
}: AccountsSummaryProps) {
  const periodHref = usePeriodHref()

  return (
    <Panel
      title={title}
      action={
        <span className="text-xs text-muted-foreground">
          {accounts.length} {countLabel}
        </span>
      }
      bodyClassName="pb-0"
    >
      <div className="flex flex-col">
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
    </Panel>
  )
}

function Row({ account, href }: { account: AccountSummary; href: string }) {
  return (
    <div className="grid h-9 grid-cols-[0.75rem_1fr_auto] items-center gap-2.5 px-4 group-data-[density=compact]/density:h-7">
      <AccountDot root={account.root} />
      <div className="flex min-w-0 flex-col leading-tight group-data-[density=compact]/density:flex-row group-data-[density=compact]/density:items-baseline group-data-[density=compact]/density:gap-2">
        <Link
          href={href}
          className="truncate text-sm text-foreground underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {account.displayName ?? account.segment}
        </Link>
        {account.sub && (
          <span className="font-mono text-xs text-muted-foreground tabular-nums group-data-[density=compact]/density:hidden">
            {account.sub}
          </span>
        )}
      </div>
      <Money
        value={account.balance}
        className={
          account.balance < 0 ? "text-sm text-muted-foreground" : "text-sm"
        }
      />
    </div>
  )
}
