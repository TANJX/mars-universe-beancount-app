"use client"

import * as React from "react"

import { AccountDot } from "@/components/primitives/account-dot"
import { MerchantAvatar } from "@/components/primitives/merchant-avatar"
import { Tag } from "@/components/primitives/tag"
import { useDisplayAccount } from "@/lib/accounts/display-names"
import { cn } from "@/lib/utils"
import { formatNativeAmount, formatShortDate } from "@/lib/format"
import type { ExpenseRowData } from "@/lib/transform/expense-row"
import { ExpenseDetailSheet } from "@/components/expenses/detail-sheet"

const ROW_TEMPLATE =
  "grid-cols-[4rem_1.75rem_minmax(11rem,1.6fr)_6.25rem_minmax(7rem,1fr)_6.875rem]"

interface ExpensesTableProps {
  rows: ExpenseRowData[]
}

export function ExpensesTable({ rows }: ExpensesTableProps) {
  const [detailIndex, setDetailIndex] = React.useState<number | null>(null)
  const detail = detailIndex !== null ? rows[detailIndex] : null

  return (
    <div className="relative flex flex-col">
      <div
        className={cn(
          "grid gap-2.5 px-5 py-2 text-xs font-medium tracking-wide text-muted-foreground uppercase",
          ROW_TEMPLATE
        )}
      >
        <span>Date</span>
        <span />
        <span>Payee</span>
        <span>Category</span>
        <span>Account</span>
        <span className="text-right">Amount</span>
      </div>

      <div className="flex flex-col">
        {rows.map((data, i) => (
          <ExpenseRow
            key={data.row.txn.id}
            data={data}
            selected={i === detailIndex}
            onClick={() => setDetailIndex(i)}
          />
        ))}
      </div>

      {detail && (
        <ExpenseDetailSheet row={detail} onClose={() => setDetailIndex(null)} />
      )}
    </div>
  )
}

function ExpenseRow({
  data,
  selected,
  onClick,
}: {
  data: ExpenseRowData
  selected: boolean
  onClick: () => void
}) {
  const {
    row,
    category,
    categoryAccount,
    fundingAccount,
    fundingCurrency,
    nativeAmount,
    totalPaid,
    share,
    hasFxPrice,
    isComplex,
    fundingRoot,
  } = data
  const { txn, class: cls } = row
  const isSplit = cls === "split"
  const displayAccount = useDisplayAccount()
  const categoryLabel = categoryAccount ? displayAccount(categoryAccount) : category

  return (
    <button
      onClick={onClick}
      className={cn(
        "grid w-full items-center gap-2.5 px-5 text-left",
        "h-11 group-data-[density=compact]/density:h-8",
        "transition-colors hover:bg-accent/40",
        selected && "bg-accent",
        row.isForecast && "italic opacity-60",
        ROW_TEMPLATE
      )}
    >
      <span className="font-mono text-xs text-muted-foreground tabular-nums">
        {formatShortDate(txn.date)}
      </span>
      <MerchantAvatar row={row} size="md" />

      <div className="flex min-w-0 flex-col gap-0.5 leading-tight group-data-[density=compact]/density:flex-row group-data-[density=compact]/density:items-baseline group-data-[density=compact]/density:gap-2">
        <div className="flex items-center gap-1.5 truncate">
          <span className="truncate text-sm">
            {txn.payee || txn.narration || "—"}
          </span>
          {isSplit && (
            <Tag tone="accent" size="xs">
              Split
            </Tag>
          )}
          {isComplex && (
            <Tag tone="neutral" size="xs">
              Multi-leg {txn.postings.length}
            </Tag>
          )}
          {txn.tags.map((t) => (
            <span key={t} className="truncate font-mono text-xs text-primary">
              #{t}
            </span>
          ))}
          {txn.links.map((l) => (
            <span
              key={l}
              className="truncate font-mono text-xs text-sky-500 dark:text-sky-400"
            >
              ^{l}
            </span>
          ))}
        </div>
        {isSplit && (
          <span className="truncate font-mono text-xs text-muted-foreground tabular-nums group-data-[density=compact]/density:hidden">
            paid {formatNativeAmount(totalPaid, "USD")}, share{" "}
            {formatNativeAmount(share, "USD")}
          </span>
        )}
      </div>

      <span className="truncate text-sm text-muted-foreground">{categoryLabel}</span>

      <span className="flex items-center gap-1.5 truncate text-sm text-muted-foreground">
        <AccountDot root={fundingRoot} size={6} />
        <span className="truncate">{fundingAccount}</span>
      </span>

      <div className="flex flex-col items-end gap-0.5 text-right leading-tight">
        {hasFxPrice ? (
          <>
            <span className="font-mono text-sm font-medium tabular-nums">
              {formatNativeAmount(nativeAmount, fundingCurrency)}
            </span>
            <span className="font-mono text-xs text-muted-foreground tabular-nums group-data-[density=compact]/density:hidden">
              ≈ {formatNativeAmount(share, "USD")}
            </span>
          </>
        ) : (
          <span className="font-mono text-sm font-medium text-rose-600 tabular-nums dark:text-rose-400">
            {formatNativeAmount(-share, "USD")}
          </span>
        )}
      </div>
    </button>
  )
}
