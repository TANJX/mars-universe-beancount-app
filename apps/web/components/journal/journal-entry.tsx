"use client"

import * as React from "react"

import { MerchantAvatar } from "@/components/primitives/merchant-avatar"
import { cn } from "@/lib/utils"
import {
  formatNativeAmount,
  formatPostingAmount,
  formatShortDate,
} from "@/lib/format"
import { accountMatches, classify } from "@/lib/transform/classify"
import type { Posting, Transaction } from "@/lib/types/beancount"

const COLS_BASE = "grid-cols-[5.5rem_1rem_1fr_9rem]"
const COLS_FILTERED = "grid-cols-[5.5rem_1rem_1fr_9rem_7rem_7rem]"

interface JournalEntryProps {
  txn: Transaction
  accountFilter: string
  /** USD running balance through this transaction, if filter is active. */
  cumulativeUSD?: number | null
}

export function JournalEntry({
  txn,
  accountFilter,
  cumulativeUSD,
}: JournalEntryProps) {
  const filtered = !!accountFilter
  const colsClass = filtered ? COLS_FILTERED : COLS_BASE

  const matching = filtered
    ? txn.postings.filter((p) => accountMatches(p.account, accountFilter))
    : []
  const contextual = filtered ? contextualNet(matching) : null

  // Classify on the fly so the avatar resolver can pick a class glyph for
  // transfers, rebalances, etc.
  const row = React.useMemo(() => classify(txn), [txn])

  return (
    <div className="overflow-hidden rounded-md border bg-card">
      {/* Transaction header row */}
      <div
        className={cn(
          "grid items-center gap-3 px-7",
          "h-11 group-data-[density=compact]/density:h-8",
          colsClass
        )}
      >
        <span className="font-mono text-xs text-muted-foreground tabular-nums">
          {formatShortDate(txn.date)}
        </span>
        <span
          className={cn(
            "text-center font-mono text-xs",
            txn.flag === "!"
              ? "text-rose-600 dark:text-rose-400"
              : "text-muted-foreground/60"
          )}
        >
          {txn.flag}
        </span>
        <div className="flex min-w-0 items-center gap-2 truncate">
          <MerchantAvatar row={row} size="md" />
          <span className="truncate text-sm font-medium">
            {txn.payee || txn.narration || "—"}
          </span>
          {txn.payee && txn.narration && (
            <span className="truncate text-sm text-muted-foreground">
              &ldquo;{txn.narration}&rdquo;
            </span>
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
        {/* Amount column on header is empty — postings sum to zero */}
        <span />
        {filtered && contextual && (
          <span
            className={cn(
              "text-right font-mono text-sm font-medium tabular-nums",
              contextual.number >= 0
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400"
            )}
          >
            {formatSignedNet(contextual.number, contextual.currency)}
          </span>
        )}
        {filtered && cumulativeUSD != null && (
          <span className="text-right font-mono text-xs text-muted-foreground tabular-nums">
            {formatNativeAmount(cumulativeUSD, "USD")}
          </span>
        )}
      </div>

      {/* Posting sub-rows */}
      {txn.postings.map((p, i) => (
        <PostingSubRow
          key={`${p.account}-${i}`}
          posting={p}
          accountFilter={accountFilter}
          colsClass={colsClass}
        />
      ))}
    </div>
  )
}

function PostingSubRow({
  posting,
  accountFilter,
  colsClass,
}: {
  posting: Posting
  accountFilter: string
  colsClass: string
}) {
  const filtered = !!accountFilter
  const matches = filtered && accountMatches(posting.account, accountFilter)
  const dimmed = filtered && !matches

  return (
    <div
      className={cn(
        "grid items-center gap-3 pr-7 pl-[1.625rem]",
        "h-7 group-data-[density=compact]/density:h-6",
        colsClass,
        // Colored left rail on the matching posting; transparent border keeps
        // alignment for non-matching siblings.
        filtered &&
          (matches
            ? "border-l-2 border-primary"
            : "border-l-2 border-transparent"),
        dimmed && "opacity-60"
      )}
    >
      <span />
      <span />
      <div className="min-w-0 pl-1.5">
        <span
          className={cn(
            "truncate font-mono text-xs",
            matches ? "font-medium text-foreground" : "text-muted-foreground"
          )}
        >
          {posting.account}
        </span>
      </div>
      <span
        className={cn(
          "text-right font-mono text-xs tabular-nums",
          matches ? "font-medium text-foreground" : "text-muted-foreground"
        )}
      >
        {formatPostingAmount(posting)}
      </span>
      {filtered && <span />}
      {filtered && <span />}
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
  // Multi-currency: convert to USD via price/cost where available.
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
