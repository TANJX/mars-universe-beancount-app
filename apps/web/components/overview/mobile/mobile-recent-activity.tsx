"use client"

import * as React from "react"
import Link from "next/link"

import { MerchantAvatar } from "@/components/primitives/merchant-avatar"
import { Money } from "@/components/primitives/money"
import { Tag } from "@/components/primitives/tag"
import { formatRelativeDate } from "@/lib/format"
import { accountSegment, accountTail } from "@/lib/transform/classify"
import type { JournalRow } from "@/lib/types/views"
import { cn } from "@/lib/utils"

interface MobileRecentActivityProps {
  rows: JournalRow[]
}

export function MobileRecentActivity({ rows }: MobileRecentActivityProps) {
  return (
    <section>
      <SectionLabel
        right={
          <Link
            href="/journal"
            className="text-[11.5px] text-primary active:text-primary/80"
          >
            See all ›
          </Link>
        }
      >
        Recent
      </SectionLabel>
      <div className="px-5">
        {rows.map((row) => (
          <Row key={row.txn.id} row={row} />
        ))}
      </div>
    </section>
  )
}

function SectionLabel({
  children,
  right,
}: {
  children: React.ReactNode
  right?: React.ReactNode
}) {
  return (
    <div className="flex items-baseline justify-between px-5 pt-5 pb-2.5">
      <span className="text-[11px] font-medium tracking-[0.1em] text-muted-foreground uppercase">
        {children}
      </span>
      {right}
    </div>
  )
}

function Row({ row }: { row: JournalRow }) {
  const { txn } = row
  const isTransfer = row.class === "transfer"
  const classTag = pickClassTag(row)
  const cat = row.category
    ? accountTail(row.category.account)
    : row.primary
      ? accountSegment(row.primary.account)
      : "—"
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-b py-2.5",
        row.isForecast &&
          "border-l-dotted border-l-[1.5px] border-l-muted-foreground pl-2.5 italic opacity-60"
      )}
    >
      <MerchantAvatar row={row} size="md" />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <div className="flex items-center gap-1.5 truncate text-[13px] text-foreground">
          <span className="truncate font-medium">
            {txn.payee || displayPayeeFallback(row)}
          </span>
          {classTag && (
            <Tag tone={classTag.tone} size="xs">
              {classTag.label}
            </Tag>
          )}
        </div>
        <div className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {formatRelativeDate(txn.date)} · {cat}
        </div>
      </div>
      <Money
        value={row.baseAmount}
        currency={row.baseCurrency}
        tone={isTransfer ? "muted" : "auto"}
        className="text-[13px] font-medium"
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
