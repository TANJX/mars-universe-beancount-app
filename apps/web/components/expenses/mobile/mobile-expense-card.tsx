"use client"

import { MerchantAvatar } from "@/components/primitives/merchant-avatar"
import { Tag } from "@/components/primitives/tag"
import { useDisplayAccount } from "@/lib/accounts/display-names"
import { formatNativeAmount } from "@/lib/format"
import type { ExpenseRowData } from "@/lib/transform/expense-row"
import { cn } from "@/lib/utils"

interface MobileExpenseCardProps {
  data: ExpenseRowData
}

export function MobileExpenseCard({ data }: MobileExpenseCardProps) {
  const {
    row,
    category,
    categoryAccount,
    fundingAccount,
    fundingCurrency,
    nativeAmount,
    share,
    hasFxPrice,
    isComplex,
  } = data
  const { txn, class: cls } = row
  const isSplit = cls === "split"
  const payee = txn.payee || txn.narration || "—"
  const displayAccount = useDisplayAccount()
  const categoryLabel = categoryAccount ? displayAccount(categoryAccount) : category

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-[10px] border bg-card p-3",
        row.isForecast && "border-dashed opacity-55"
      )}
    >
      <MerchantAvatar row={row} size="md" />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[13.5px] font-medium">{payee}</span>
          {isSplit && (
            <Tag tone="accent" size="xs">
              Split
            </Tag>
          )}
          {row.isForecast && (
            <Tag tone="forecast" size="xs">
              Forecast
            </Tag>
          )}
          {isComplex && (
            <Tag tone="neutral" size="xs">
              {txn.postings.length} legs
            </Tag>
          )}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground tabular-nums">
          {categoryLabel} · {fundingAccount}
        </div>
      </div>
      <div className="flex flex-col items-end leading-tight">
        {hasFxPrice ? (
          <>
            <span className="font-mono text-[14px] font-medium tabular-nums">
              {formatNativeAmount(nativeAmount, fundingCurrency)}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
              ≈ {formatNativeAmount(-share, "USD")}
            </span>
          </>
        ) : (
          <span className="font-mono text-[14px] font-medium tabular-nums text-rose-600 dark:text-rose-400">
            {formatNativeAmount(-share, "USD")}
          </span>
        )}
      </div>
    </div>
  )
}
