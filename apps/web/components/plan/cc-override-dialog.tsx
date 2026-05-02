"use client"

import * as React from "react"
import { Plus, X } from "lucide-react"

import { Money } from "@/components/primitives/money"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useSaveCcOverride } from "@/hooks/use-plan"
import { parseAmount } from "@/lib/plan/format"
import { cn } from "@/lib/utils"
import type { BankInfo, CCCard, PlanGridResponse } from "@/lib/plan/schemas"

interface SplitDraft {
  id?: string
  account: string
  date: string
  amount: string // editable string for non-last rows; ignored for the last row (derived)
  description: string
}

interface CcOverrideDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  card: CCCard
  cycleMonth: string // "YYYY-MM"
  paymentDate: string // default date for new splits
  banks: BankInfo[]
  rows: PlanGridResponse["rows"] // for balance lookups
}

export function CcOverrideDialog({
  open,
  onOpenChange,
  card,
  cycleMonth,
  paymentDate,
  banks,
  rows,
}: CcOverrideDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        {open && (
          <CcOverrideEditor
            card={card}
            cycleMonth={cycleMonth}
            paymentDate={paymentDate}
            banks={banks}
            rows={rows}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

interface CcOverrideEditorProps {
  card: CCCard
  cycleMonth: string
  paymentDate: string
  banks: BankInfo[]
  rows: PlanGridResponse["rows"]
  onClose: () => void
}

function gatherExistingPlans(
  rows: PlanGridResponse["rows"],
  cardPath: string,
  cycleMonth: string
) {
  const out: Array<{
    id: string
    date: string
    account: string
    amount: string
    description: string
  }> = []
  for (const row of rows) {
    for (const [account, entries] of Object.entries(row.entries)) {
      for (const e of entries) {
        if (
          e.kind === "plan" &&
          e.ccCardRef === cardPath &&
          e.ccCycleMonth === cycleMonth
        ) {
          out.push({
            id: e.id,
            date: row.date,
            account,
            amount: e.amount,
            description: e.description,
          })
        }
      }
    }
  }
  return out
}

function CcOverrideEditor({
  card,
  cycleMonth,
  paymentDate,
  banks,
  rows,
  onClose,
}: CcOverrideEditorProps) {
  const save = useSaveCcOverride()
  const stmtBalance = parseAmount(card.statementBalance ?? "") ?? 0
  const paidThisCycle = parseAmount(card.paidThisCycle ?? "") ?? 0

  // `card.remaining` describes the *active* cycle on the server. When the
  // modal opens for the active cycle, prefer it as the default — that's
  // the post-payment balance. For non-active cycles (e.g., a cc-forecast
  // row) fall back to the raw statement.
  const isActiveCycle = card.cycleMonth === cycleMonth
  const remaining =
    isActiveCycle && card.remaining != null
      ? (parseAmount(card.remaining) ?? stmtBalance)
      : stmtBalance
  const showPaidLine = isActiveCycle && paidThisCycle > 0.005

  const [payTotal, setPayTotal] = React.useState<string>(() => {
    const existing = gatherExistingPlans(rows, card.accountPath, cycleMonth)
    if (existing.length > 0) {
      const total = existing.reduce(
        (acc, p) => acc + Math.abs(parseAmount(p.amount) ?? 0),
        0
      )
      return total.toFixed(2)
    }
    return remaining.toFixed(2)
  })
  const [splits, setSplits] = React.useState<SplitDraft[]>(() => {
    const existing = gatherExistingPlans(rows, card.accountPath, cycleMonth)
    if (existing.length > 0) {
      return existing.map((p) => ({
        id: p.id,
        account: p.account,
        date: p.date,
        amount: Math.abs(parseAmount(p.amount) ?? 0).toFixed(2),
        description: p.description || card.displayName,
      }))
    }
    return [
      {
        account: card.fundingAccount ?? "",
        date: paymentDate,
        amount: remaining.toFixed(2),
        description: card.displayName,
      },
    ]
  })

  const [hadExistingPlans] = React.useState(
    () => gatherExistingPlans(rows, card.accountPath, cycleMonth).length > 0
  )

  const total = parseAmount(payTotal) ?? 0
  const lastIndex = splits.length - 1

  // Auto-remainder for the last row.
  const remainder = React.useMemo(() => {
    const allocated = splits
      .slice(0, lastIndex)
      .reduce((acc, s) => acc + (parseAmount(s.amount) ?? 0), 0)
    return Math.round((total - allocated) * 100) / 100
  }, [splits, total, lastIndex])

  const updateSplit = (i: number, patch: Partial<SplitDraft>) => {
    setSplits((prev) =>
      prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s))
    )
  }

  const removeSplit = (i: number) => {
    setSplits((prev) => prev.filter((_, idx) => idx !== i))
  }

  const addSplit = () => {
    setSplits((prev) => {
      // Lock the previous last row's amount to its current derived remainder
      // so it doesn't shift when the new last row picks up the leftover.
      const next = prev.map((s, idx) =>
        idx === prev.length - 1 ? { ...s, amount: remainder.toFixed(2) } : s
      )
      next.push({
        account: "",
        date: paymentDate,
        amount: "",
        description: card.displayName,
      })
      return next
    })
  }

  const handleSave = () => {
    if (splits.length === 0) return
    const out = splits.map((s, i) => {
      const positive =
        i === lastIndex ? remainder : (parseAmount(s.amount) ?? 0)
      // negate (CC payments are outflows from checking accounts)
      const amount = -Math.abs(positive)
      return {
        id: s.id,
        date: s.date,
        account: s.account,
        amount: amount.toFixed(2),
        description: s.description || card.displayName,
        state: null,
      }
    })
    save.mutate(
      {
        cardAccountPath: card.accountPath,
        cycleMonth,
        plans: out,
      },
      { onSuccess: () => onClose() }
    )
  }

  const handleSkip = () => {
    save.mutate(
      {
        cardAccountPath: card.accountPath,
        cycleMonth,
        plans: [
          {
            date: paymentDate,
            account: card.fundingAccount ?? splits[0]?.account ?? "",
            amount: "0.00",
            description: card.displayName,
            state: null,
          },
        ],
      },
      { onSuccess: () => onClose() }
    )
  }

  const handleClear = () => {
    // Clear all overrides → projection comes back.
    save.mutate(
      {
        cardAccountPath: card.accountPath,
        cycleMonth,
        plans: [],
      },
      { onSuccess: () => onClose() }
    )
  }

  const cycleLabel = formatCycleMonth(cycleMonth)
  // "Off" compares against `remaining` (statement net of paidThisCycle on
  // the active cycle; raw statement otherwise) so paying $502.10 against a
  // $1,492.11 statement where $990.01 already cleared shows as on-target,
  // not "off $990.01".
  const offFromTarget = Math.abs(total - remaining) > 0.005

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span>Pay {card.displayName}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {cycleLabel}
          </span>
        </DialogTitle>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3 rounded-md bg-muted/30 px-3 py-2.5">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Pay total
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-sm text-muted-foreground">$</span>
              <input
                type="text"
                value={payTotal}
                onChange={(e) => setPayTotal(e.target.value)}
                className="h-7 w-full rounded-sm bg-background px-2 text-right text-sm font-medium tabular-nums ring-1 ring-foreground/10 focus:ring-primary/40 focus:outline-none"
              />
            </div>
          </label>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Statement
            </span>
            <div className="flex h-7 items-center justify-between gap-2">
              <Money
                value={stmtBalance}
                tone="none"
                className="text-sm font-medium"
              />
              {offFromTarget && (
                <span className="rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                  off ${Math.abs(total - remaining).toFixed(2)}
                </span>
              )}
            </div>
            {showPaidLine && (
              <span className="text-[10px] text-muted-foreground">
                paid ${paidThisCycle.toFixed(2)} → due $
                {Math.max(0, remaining).toFixed(2)}
              </span>
            )}
            {card.statementBalanceStale && (
              <span className="text-[10px] text-amber-700 dark:text-amber-400">
                statement may be out of date — last close{" "}
                {card.lastClosedDate ?? "—"}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <div className="grid grid-cols-[1fr_9rem_7rem_1.5rem] items-end gap-2 pr-1 pb-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            <span>Account</span>
            <span>Date</span>
            <span className="text-right">Amount</span>
            <span />
          </div>

          {splits.map((s, i) => {
            const isLast = i === lastIndex
            const balance = lookupBalance(rows, s.date, s.account)
            return (
              <div key={i} className="flex flex-col gap-0.5">
                <div className="grid grid-cols-[1fr_9rem_7rem_1.5rem] items-center gap-2">
                  <select
                    value={s.account}
                    onChange={(e) =>
                      updateSplit(i, { account: e.target.value })
                    }
                    className="h-7 rounded-sm bg-background px-2 text-xs ring-1 ring-foreground/10 focus:ring-primary/40 focus:outline-none"
                  >
                    <option value="">Select account…</option>
                    {banks.map((b) => (
                      <option key={b.account} value={b.account}>
                        {b.displayName}
                      </option>
                    ))}
                  </select>
                  <input
                    type="date"
                    value={s.date}
                    onChange={(e) => updateSplit(i, { date: e.target.value })}
                    className="h-7 rounded-sm bg-background px-2 text-xs ring-1 ring-foreground/10 focus:ring-primary/40 focus:outline-none"
                  />
                  {isLast ? (
                    <div
                      className={cn(
                        "flex h-7 items-center justify-end rounded-sm bg-muted/40 px-2 text-xs tabular-nums ring-1 ring-foreground/5",
                        remainder < 0 && "text-rose-600 dark:text-rose-400"
                      )}
                      title="Auto remainder = total − other rows"
                    >
                      {remainder.toFixed(2)}
                    </div>
                  ) : (
                    <input
                      type="text"
                      value={s.amount}
                      onChange={(e) =>
                        updateSplit(i, { amount: e.target.value })
                      }
                      className="h-7 rounded-sm bg-background px-2 text-right text-xs tabular-nums ring-1 ring-foreground/10 focus:ring-primary/40 focus:outline-none"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => removeSplit(i)}
                    disabled={splits.length === 1}
                    className="flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30"
                    title={
                      splits.length === 1
                        ? "At least one row required"
                        : "Remove"
                    }
                  >
                    <X size={12} />
                  </button>
                </div>
                <div
                  className={cn(
                    "px-1 text-[10px] leading-tight",
                    balance !== null && balance < 0
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-muted-foreground/70"
                  )}
                >
                  {s.account && balance !== null
                    ? `balance $${balance.toFixed(2)} on ${formatShort(s.date)}`
                    : " "}
                </div>
              </div>
            )
          })}

          <button
            type="button"
            onClick={addSplit}
            className="mt-1 flex w-fit items-center gap-1 rounded-sm px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            <Plus size={12} />
            Add account
          </button>
        </div>

        <div className="mt-1 flex items-center justify-between gap-2 border-t border-border/50 pt-2">
          <div className="flex gap-2">
            {hadExistingPlans && (
              <button
                type="button"
                onClick={handleClear}
                className="text-[11px] text-muted-foreground hover:underline"
                title="Remove all overrides — default projection comes back"
              >
                Reset to projection
              </button>
            )}
            <button
              type="button"
              onClick={handleSkip}
              className="text-[11px] text-muted-foreground hover:underline"
              title="Save a $0 plan to suppress this cycle"
            >
              Skip this month
            </button>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onClose()}
              className="rounded-md px-3 py-1 text-xs text-muted-foreground hover:bg-muted/50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={save.isPending || splits.some((s) => !s.account)}
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

function lookupBalance(
  rows: PlanGridResponse["rows"],
  date: string,
  account: string
): number | null {
  if (!account) return null
  const row = rows.find((r) => r.date === date)
  if (!row) return null
  const raw = row.balances[account]
  if (raw == null) return null
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : null
}

function formatCycleMonth(cycleMonth: string): string {
  const [y, m] = cycleMonth.split("-").map(Number)
  if (!y || !m) return cycleMonth
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ]
  return `${months[m - 1]} ${y}`
}

function formatShort(iso: string): string {
  const d = new Date(iso + "T00:00:00")
  if (Number.isNaN(d.getTime())) return iso
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ]
  return `${months[d.getMonth()]} ${d.getDate()}`
}
