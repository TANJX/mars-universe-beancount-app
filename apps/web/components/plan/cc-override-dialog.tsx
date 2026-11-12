"use client"

import { Plus, X } from "lucide-react"
import * as React from "react"

import { Money } from "@/components/primitives/money"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useSaveCcExpected, useSaveCcOverride } from "@/hooks/use-plan"
import { parseAmount } from "@/lib/plan/format"
import type {
  BankInfo,
  CCCard,
  CcOverrideSavePlan,
  PlanGridResponse,
} from "@/lib/plan/schemas"
import {
  type CcOverrideTarget,
  defaultPayTotal,
  findClosedStatement,
  findExpectedStatement,
  isActiveTarget,
  normalizeEstimate,
  overrideKey,
  planMatchesTarget,
  statementLabel,
} from "@/lib/plan/statements"
import { cn } from "@/lib/utils"

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
  // The statement being paid (closed or expected), or a legacy cycle month
  // for a card with no statement records.
  target: CcOverrideTarget
  paymentDate: string // default date for new splits
  banks: BankInfo[]
  rows: PlanGridResponse["rows"] // for balance lookups
}

export function CcOverrideDialog({
  open,
  onOpenChange,
  card,
  target,
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
            target={target}
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
  target: CcOverrideTarget
  paymentDate: string
  banks: BankInfo[]
  rows: PlanGridResponse["rows"]
  onClose: () => void
}

function gatherExistingPlans(
  rows: PlanGridResponse["rows"],
  cardPath: string,
  target: CcOverrideTarget
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
        if (planMatchesTarget(e, cardPath, target)) {
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
  target,
  paymentDate,
  banks,
  rows,
  onClose,
}: CcOverrideEditorProps) {
  const save = useSaveCcOverride()
  const saveExpected = useSaveCcExpected()
  const isLegacy = target.mode === "legacy"
  const closed =
    target.mode === "statement" && target.kind === "closed"
      ? findClosedStatement(card, target.statementId)
      : null
  const isExpected = target.mode === "statement" && target.kind === "expected"
  const expected =
    target.mode === "statement" && target.kind === "expected"
      ? findExpectedStatement(card, target.statementId)
      : null

  // Optional balance the owner expects the unclosed statement to land at.
  // Blank means "use the ledger forecast".
  // What is typed is normalised (no "$" or commas, formulas evaluated, 2
  // decimals) so the preview here and the value the server stores agree.
  const storedEstimate = expected?.estimatedBalance ?? ""
  const [estimate, setEstimate] = React.useState(storedEstimate)
  const estimateInput = normalizeEstimate(estimate)
  const estimateValid = estimateInput.ok
  const estimateValue = estimateInput.ok ? estimateInput.value : null
  const estimateChanged =
    isExpected && estimateInput.ok && estimateValue !== (storedEstimate || null)

  const stmtBalance = closed
    ? (parseAmount(closed.statementBalance) ?? 0)
    : (parseAmount(card.statementBalance ?? "") ?? 0)
  const paidThisCycle = parseAmount(card.paidThisCycle ?? "") ?? 0

  // `remaining` is what the dialog proposes to pay. For the active closed
  // statement (or the active legacy cycle) that is the amount still owed
  // after payments since close (the minimum on a minimum-payment-only
  // card); for the expected statement it is the estimate, else the ledger
  // forecast.
  const isActiveCycle = isActiveTarget(card, target)
  const defaultTotal = defaultPayTotal(card, target)
  const remaining = isExpected
    ? ((estimateInput.ok ? estimateInput.amount : null) ??
      parseAmount(card.computedForecast ?? "") ??
      0)
    : defaultTotal
  const showPaidLine = isActiveCycle && paidThisCycle > 0.005

  const [payTotal, setPayTotal] = React.useState<string>(() => {
    const existing = gatherExistingPlans(rows, card.accountPath, target)
    if (existing.length > 0) {
      const total = existing.reduce(
        (acc, p) => acc + Math.abs(parseAmount(p.amount) ?? 0),
        0
      )
      return total.toFixed(2)
    }
    return defaultTotal.toFixed(2)
  })
  const [splits, setSplits] = React.useState<SplitDraft[]>(() => {
    const existing = gatherExistingPlans(rows, card.accountPath, target)
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
        amount: defaultTotal.toFixed(2),
        description: card.displayName,
      },
    ]
  })

  const [hadExistingPlans] = React.useState(
    () => gatherExistingPlans(rows, card.accountPath, target).length > 0
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

  const key = overrideKey(target)

  // `expectId` names the statement this dialog was opened for: if it closed
  // meanwhile the server refuses, instead of putting the estimate on the
  // following cycle.
  const saveEstimate = () =>
    saveExpected.mutateAsync({
      accountPath: card.accountPath,
      estimatedBalance: estimateValue,
      ...(target.mode === "statement" ? { expectId: target.statementId } : {}),
    })

  // For an expected statement, persist an edited estimate before the plans.
  const saveEstimateIfChanged = async () => {
    if (!estimateChanged) return
    await saveEstimate()
  }

  const saveOverride = async (plans: CcOverrideSavePlan[]) => {
    try {
      await saveEstimateIfChanged()
      await save.mutateAsync({
        cardAccountPath: card.accountPath,
        ...key,
        plans,
      })
      onClose()
    } catch {
      // The mutation keeps the error; it is shown above the footer.
    }
  }

  const handleSaveEstimate = async () => {
    try {
      await saveEstimate()
      onClose()
    } catch {
      // shown above the footer
    }
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
    void saveOverride(out)
  }

  const handleSkip = () => {
    void saveOverride([
      {
        date: paymentDate,
        account: card.fundingAccount ?? splits[0]?.account ?? "",
        amount: "0.00",
        description: card.displayName,
        state: null,
      },
    ])
  }

  const handleClear = () => {
    // Clear all overrides → projection comes back.
    void saveOverride([])
  }

  const busy = save.isPending || saveExpected.isPending
  const errorMessage = save.error?.message ?? saveExpected.error?.message
  const cycleLabel = statementLabel(target)
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
          {!isLegacy &&
            (isExpected ? (
              <span
                className="rounded-sm bg-muted px-1 py-px text-[9px] font-medium text-muted-foreground"
                title="This statement has not closed yet. Its dates and balance are predictions."
              >
                Expected
              </span>
            ) : (
              <span
                className="rounded-sm bg-emerald-500/10 px-1 py-px text-[9px] font-medium text-emerald-700 dark:text-emerald-400"
                title="A closed statement on record"
              >
                Closed
              </span>
            ))}
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
            {isExpected ? (
              <label
                htmlFor="cc-estimated-balance"
                className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase"
              >
                Estimated balance
              </label>
            ) : (
              <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {closed ? "Balance at close" : "Statement"}
              </span>
            )}
            <div className="flex h-7 items-center justify-between gap-2">
              {isExpected ? (
                <div className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="text-sm text-muted-foreground">$</span>
                  <input
                    id="cc-estimated-balance"
                    type="text"
                    inputMode="decimal"
                    value={estimate}
                    placeholder={card.computedForecast ?? "0.00"}
                    onChange={(e) => setEstimate(e.target.value)}
                    aria-invalid={!estimateValid || undefined}
                    aria-describedby="cc-estimated-balance-hint"
                    className={cn(
                      "h-7 w-full min-w-0 rounded-sm bg-background px-2 text-right text-sm font-medium tabular-nums ring-1 ring-foreground/10 focus:ring-primary/40 focus:outline-none",
                      !estimateValid && "text-rose-600 ring-rose-500/60"
                    )}
                  />
                </div>
              ) : (
                <Money
                  value={stmtBalance}
                  tone="none"
                  className="text-sm font-medium"
                />
              )}
              {offFromTarget && (
                <span className="shrink-0 rounded-sm bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                  off ${Math.abs(total - remaining).toFixed(2)}
                </span>
              )}
            </div>
            {closed && (
              <span className="text-[10px] text-muted-foreground tabular-nums">
                closed {closed.id} · due {closed.effectiveDueDate}
                {closed.dueDate == null && " (predicted)"}
                {closed.minimumPayment != null &&
                  ` · minimum $${closed.minimumPayment}`}
              </span>
            )}
            {isExpected && (
              <>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  closes ~{target.statementId}
                  {expected?.dueDate ? ` · due ~${expected.dueDate}` : ""}
                </span>
                <div className="flex items-center justify-between gap-2">
                  <span
                    id="cc-estimated-balance-hint"
                    className={cn(
                      "text-[10px]",
                      estimateValid
                        ? "text-muted-foreground/70"
                        : "text-rose-600 dark:text-rose-400"
                    )}
                  >
                    {estimateValid
                      ? "blank uses the ledger forecast"
                      : "enter an amount above 0, or leave blank"}
                  </span>
                  <button
                    type="button"
                    onClick={handleSaveEstimate}
                    disabled={busy || !estimateChanged || !estimateValid}
                    className="rounded-sm px-1.5 py-0.5 text-[10px] font-medium text-foreground/80 ring-1 ring-foreground/10 hover:bg-muted/50 disabled:opacity-40"
                    title="Save only the estimate, without planning a payment"
                  >
                    Save estimate
                  </button>
                </div>
              </>
            )}
            {showPaidLine && (
              <span className="text-[10px] text-muted-foreground">
                paid ${paidThisCycle.toFixed(2)} → due $
                {Math.max(0, remaining).toFixed(2)}
              </span>
            )}
            {isLegacy && card.statementBalanceStale && (
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

        {errorMessage && (
          <p
            role="alert"
            className="text-[11px] text-rose-600 dark:text-rose-400"
          >
            {errorMessage}
          </p>
        )}

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
              {isLegacy ? "Skip this month" : "Skip this statement"}
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
              disabled={
                busy || !estimateValid || splits.some((s) => !s.account)
              }
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
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

function formatShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
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
