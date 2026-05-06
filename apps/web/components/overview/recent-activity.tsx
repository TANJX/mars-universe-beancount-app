"use client"

import * as React from "react"
import Link from "next/link"
import { Panel } from "@/components/overview/panel"
import { usePeriodHref } from "@/components/layout/ui-state"
import { MerchantAvatar } from "@/components/primitives/merchant-avatar"
import { Money } from "@/components/primitives/money"
import { Tag } from "@/components/primitives/tag"
import { cn } from "@/lib/utils"
import { formatShortDate } from "@/lib/format"
import { accountSegment, accountTail } from "@/lib/transform/classify"
import type { JournalRow } from "@/lib/types/views"

interface RecentActivityProps {
  rows: JournalRow[]
}

export function RecentActivity({ rows }: RecentActivityProps) {
  const periodHref = usePeriodHref()

  return (
    <Panel
      title="Recent activity"
      action={
        <Link
          href={periodHref("/journal")}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          View all →
        </Link>
      }
      bodyClassName="pb-0"
    >
      <div className="flex flex-col gap-1">
        {rows.map((row) => (
          <ActivityRow key={row.txn.id} row={row} />
        ))}
      </div>
    </Panel>
  )
}

function ActivityRow({ row }: { row: JournalRow }) {
  const { txn } = row
  const isTransfer = row.class === "transfer"
  const classTag = pickClassTag(row)

  // Account display for the secondary line: short name (last segment of primary)
  const primaryShort = row.primary ? accountSegment(row.primary.account) : "—"

  // Subtitle line: for transfers, show "→ counterparty"; otherwise category + account
  const subtitle = isTransfer
    ? row.counterparty
      ? `→ ${accountTail(row.counterparty.account)}`
      : "Transfer"
    : row.category
      ? `${accountTail(row.category.account)} · ${primaryShort}`
      : primaryShort

  return (
    <div
      className={cn(
        "grid h-10 grid-cols-[3.5rem_1.75rem_1fr_auto] items-center gap-2.5 px-4 group-data-[density=compact]/density:h-8",
        row.isForecast &&
          "border-l-[1.5px] border-dotted border-muted-foreground pl-[calc(1rem-1.5px)] italic opacity-60"
      )}
    >
      <span className="font-mono text-xs text-muted-foreground tabular-nums">
        {formatShortDate(txn.date)}
      </span>
      <MerchantAvatar row={row} size="md" />
      <div className="flex min-w-0 flex-col gap-0.5 leading-tight group-data-[density=compact]/density:flex-row group-data-[density=compact]/density:items-baseline group-data-[density=compact]/density:gap-2">
        <div className="flex items-center gap-1.5 truncate text-sm text-foreground">
          <span className="truncate">
            {txn.payee || displayPayeeFallback(row)}
          </span>
          {classTag && (
            <Tag tone={classTag.tone} size="xs">
              {classTag.label}
            </Tag>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground group-data-[density=compact]/density:hidden">
          {subtitle}
        </div>
      </div>
      <Money
        value={row.baseAmount}
        currency={row.baseCurrency}
        tone={isTransfer ? "muted" : "auto"}
        className="text-sm font-medium"
      />
    </div>
  )
}

function displayPayeeFallback(row: JournalRow): string {
  if (row.class === "transfer") return row.txn.narration || "Transfer"
  return row.txn.narration || "—"
}

interface ClassTag {
  tone: React.ComponentProps<typeof Tag>["tone"]
  label: string
}
function pickClassTag(row: JournalRow): ClassTag | null {
  if (row.isForecast) return { tone: "forecast", label: "Forecast" }
  switch (row.class) {
    case "transfer":
      return { tone: "neutral", label: "Transfer" }
    case "split":
      return { tone: "accent", label: "Split" }
    case "investment":
      return { tone: "accent", label: "Invest" }
    case "rebate":
      return { tone: "pos", label: "Rebate" }
    case "income":
      return { tone: "pos", label: "Income" }
    case "complex":
      return { tone: "neutral", label: `${row.txn.postings.length} legs` }
    default:
      return null
  }
}
