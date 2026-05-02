"use client"

import * as React from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { CcCardView } from "@/components/plan/cc-card"
import { cn } from "@/lib/utils"
import type { BankInfo, CCCard } from "@/lib/plan/schemas"

const CARDS_PER_PAGE = 5

export function CcStripA({
  cards,
  banks,
  today,
}: {
  cards: CCCard[]
  banks: BankInfo[]
  today?: string
}) {
  const sorted = React.useMemo(() => {
    // Active (statementBalance > 0) cards come first, ordered by payment
    // recency (soonest due first). Cards with no due day go to the end of
    // the active group. Inactive ($0 / unconfigured) cards drop to the end.
    const todayIso = today ?? new Date().toISOString().slice(0, 10)
    const ranked = cards.map((c, idx) => ({
      card: c,
      idx,
      hasBalance: parseFloat(c.statementBalance ?? "0") > 0,
      nextDueRank: nextDueRank(c, todayIso),
    }))
    ranked.sort((a, b) => {
      if (a.hasBalance !== b.hasBalance) return a.hasBalance ? -1 : 1
      if (a.nextDueRank !== b.nextDueRank) return a.nextDueRank - b.nextDueRank
      return a.idx - b.idx
    })
    return ranked.map((r) => r.card)
  }, [cards, today])

  const [page, setPage] = React.useState(0)
  const pages = Math.max(1, Math.ceil(sorted.length / CARDS_PER_PAGE))
  const start = page * CARDS_PER_PAGE
  const visible = sorted.slice(start, start + CARDS_PER_PAGE)

  return (
    <div className="flex items-stretch gap-2">
      <PageButton
        direction="prev"
        disabled={page === 0}
        onClick={() => setPage((p) => Math.max(0, p - 1))}
      />
      <div className="flex min-w-0 flex-1 gap-2 overflow-x-hidden py-px">
        {visible.map((c) => (
          <div key={c.accountPath} className="min-w-[180px] flex-1">
            <CcCardView card={c} banks={banks} today={today} />
          </div>
        ))}
        {Array.from({
          length: Math.max(0, CARDS_PER_PAGE - visible.length),
        }).map((_, i) => (
          <div key={`pad-${i}`} className="min-w-[180px] flex-1" />
        ))}
      </div>
      <PageButton
        direction="next"
        disabled={page >= pages - 1}
        onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
      />
      <div className="flex shrink-0 items-center pl-1 text-[10px] text-muted-foreground tabular-nums">
        {page + 1}/{pages}
      </div>
    </div>
  )
}

function nextDueRank(card: CCCard, todayIso: string): number {
  // Returns days-until-next-payment as the sort key. Cards without a due day
  // get a large sentinel so they sink to the end of their group.
  if (!card.paymentDueDay) return Number.MAX_SAFE_INTEGER
  const [y, m] = todayIso.split("-").map(Number)
  const todayDay = Number(todayIso.slice(8, 10))
  let year = y
  let month = m
  if (todayDay > card.paymentDueDay) {
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  const lastDay = new Date(year, month, 0).getDate()
  const day =
    card.paymentDueDay === -1 ? lastDay : Math.min(card.paymentDueDay, lastDay)
  const dueIso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
  const dueT = new Date(dueIso + "T00:00:00").getTime()
  const todayT = new Date(todayIso + "T00:00:00").getTime()
  return Math.round((dueT - todayT) / 86_400_000)
}

function PageButton({
  direction,
  disabled,
  onClick,
}: {
  direction: "prev" | "next"
  disabled: boolean
  onClick: () => void
}) {
  const Icon = direction === "prev" ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={direction === "prev" ? "Previous cards" : "Next cards"}
      className={cn(
        "flex w-7 shrink-0 items-center justify-center rounded-md ring-1 ring-foreground/10 transition-colors",
        disabled
          ? "cursor-not-allowed text-muted-foreground/40"
          : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      )}
    >
      <Icon size={14} />
    </button>
  )
}
