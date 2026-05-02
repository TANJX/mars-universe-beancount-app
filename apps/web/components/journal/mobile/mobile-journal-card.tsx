"use client"

import * as React from "react"

import { MerchantAvatar } from "@/components/primitives/merchant-avatar"
import { formatNativeAmount, formatPostingAmount } from "@/lib/format"
import { accountMatches, classify } from "@/lib/transform/classify"
import type { Posting, Transaction } from "@/lib/types/beancount"
import { cn } from "@/lib/utils"

interface MobileJournalCardProps {
  txn: Transaction
  /** Active account filter (URL `?account=`); enables Δ + Σ + posting highlight. */
  accountFilter?: string
  /** USD running balance through this transaction, when filtered. */
  cumulativeUSD?: number | null
}

export function MobileJournalCard({
  txn,
  accountFilter,
  cumulativeUSD,
}: MobileJournalCardProps) {
  const filtered = !!accountFilter
  const matching = filtered
    ? txn.postings.filter((p) => accountMatches(p.account, accountFilter!))
    : []
  const contextual = filtered ? contextualNet(matching) : null
  const row = React.useMemo(() => classify(txn), [txn])
  const payee = txn.payee || txn.narration || "—"
  const showFlag = txn.flag === "!"

  return (
    <div
      className={cn(
        "rounded-[10px] border bg-card",
        filtered && "border-l-2 border-l-primary"
      )}
    >
      <div className="flex items-center gap-3 p-3">
        <MerchantAvatar row={row} size="md" />
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <div className="flex flex-wrap items-center gap-1.5">
            {showFlag && (
              <span className="font-mono text-[11px] text-rose-600 dark:text-rose-400">
                !
              </span>
            )}
            <span className="truncate text-[13.5px] font-medium">{payee}</span>
            {txn.payee && txn.narration && (
              <span className="truncate text-[12px] text-muted-foreground">
                &ldquo;{txn.narration}&rdquo;
              </span>
            )}
            {txn.tags.map((t) => (
              <span key={t} className="font-mono text-[11px] text-primary">
                #{t}
              </span>
            ))}
            {txn.links.map((l) => (
              <span
                key={l}
                className="font-mono text-[11px] text-sky-500 dark:text-sky-400"
              >
                ^{l}
              </span>
            ))}
          </div>
          {filtered && contextual && (
            <div className="flex items-baseline gap-2 pt-0.5 font-mono text-[11px] tabular-nums">
              <span
                className={
                  contextual.number >= 0
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400"
                }
              >
                {formatSignedNet(contextual.number, contextual.currency)}
              </span>
              {cumulativeUSD != null && (
                <span className="text-muted-foreground">
                  Σ {formatNativeAmount(cumulativeUSD, "USD")}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-0.5 border-t px-3 py-2 pl-13">
        {txn.postings.map((p, i) => (
          <PostingLine
            key={`${p.account}-${i}`}
            posting={p}
            accountFilter={accountFilter}
          />
        ))}
      </div>
    </div>
  )
}

function PostingLine({
  posting,
  accountFilter,
}: {
  posting: Posting
  accountFilter?: string
}) {
  const matches =
    !!accountFilter && accountMatches(posting.account, accountFilter)
  const dimmed = !!accountFilter && !matches
  return (
    <div
      className={cn(
        "flex items-baseline justify-between gap-3 font-mono text-[11.5px] tabular-nums",
        dimmed && "opacity-60"
      )}
    >
      <span
        className={cn(
          "min-w-0 truncate",
          matches ? "font-medium text-foreground" : "text-muted-foreground"
        )}
      >
        {posting.account}
      </span>
      <span
        className={
          matches ? "font-medium text-foreground" : "text-muted-foreground"
        }
      >
        {formatPostingAmount(posting)}
      </span>
    </div>
  )
}

function contextualNet(matching: Posting[]): {
  number: number
  currency: string
} {
  const currencies = new Set(matching.map((p) => p.amount.currency))
  if (currencies.size === 1 && matching.length > 0) {
    return {
      number: matching.reduce((s, p) => s + p.amount.number, 0),
      currency: matching[0].amount.currency,
    }
  }
  // Multi-currency: convert via price/cost when available.
  const usd = matching.reduce((s, p) => {
    if (p.amount.currency === "USD") return s + p.amount.number
    if (p.price?.currency === "USD") return s + p.amount.number * p.price.number
    if (p.cost?.currency === "USD") return s + p.amount.number * p.cost.number
    return s
  }, 0)
  return { number: usd, currency: "USD" }
}

function formatSignedNet(value: number, currency: string): string {
  const sign = value >= 0 ? "+" : ""
  return `${sign}${formatNativeAmount(value, currency)}`
}
