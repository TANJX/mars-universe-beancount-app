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
import type { Token } from "@/lib/search/parse"
import type { Posting, Transaction } from "@/lib/types/beancount"

import { COLS_BASE, COLS_FILTERED } from "./cols"

interface JournalEntryProps {
  txn: Transaction
  accountFilter: string
  /** USD running balance through this transaction, if filter is active. */
  cumulativeUSD?: number | null
  /** Click handler for tag/link badges — appends to the search filter. */
  onAddToken?: (token: Token) => void
}

export function JournalEntry({
  txn,
  accountFilter,
  cumulativeUSD,
  onAddToken,
}: JournalEntryProps) {
  const filtered = !!accountFilter
  const colsClass = filtered ? COLS_FILTERED : COLS_BASE

  const matching = filtered
    ? txn.postings.filter((p) => accountMatches(p.account, accountFilter))
    : []
  const contextual = filtered ? contextualNet(matching) : null

  // Classify on the fly so the avatar resolver can pick a class glyph for
  // transfers, etc.
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
        <span className="whitespace-nowrap font-mono text-xs text-muted-foreground tabular-nums">
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
            <button
              key={t}
              type="button"
              onClick={() => onAddToken?.({ kind: "tag", value: t })}
              title={`Filter by tag #${t}`}
              className="truncate rounded font-mono text-xs text-primary hover:underline focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none"
            >
              #{t}
            </button>
          ))}
          {txn.links.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => onAddToken?.({ kind: "link", value: l })}
              title={`Filter by link ^${l}`}
              className="truncate rounded font-mono text-xs text-sky-500 hover:underline focus-visible:ring-2 focus-visible:ring-sky-500/30 focus-visible:outline-none dark:text-sky-400"
            >
              ^{l}
            </button>
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
        {/* A zero balance renders as an empty cell — only show the running
            total while the account actually carries one. */}
        {filtered && cumulativeUSD != null && cumulativeUSD !== 0 && (
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
          onAddToken={onAddToken}
        />
      ))}
    </div>
  )
}

function PostingSubRow({
  posting,
  accountFilter,
  colsClass,
  onAddToken,
}: {
  posting: Posting
  accountFilter: string
  colsClass: string
  onAddToken?: (token: Token) => void
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
        dimmed && "opacity-60"
      )}
    >
      <span />
      <span />
      <div className="min-w-0 pl-1.5">
        <button
          type="button"
          onClick={() =>
            onAddToken?.({ kind: "account", value: posting.account })
          }
          title={`Filter by account ${posting.account}`}
          className={cn(
            "truncate rounded font-mono text-xs hover:underline focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:outline-none",
            matches ? "font-medium text-foreground" : "text-muted-foreground"
          )}
        >
          {posting.account}
        </button>
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
