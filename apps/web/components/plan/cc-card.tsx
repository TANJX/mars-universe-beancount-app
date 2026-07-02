"use client"

import { Settings2 } from "lucide-react"
import * as React from "react"

import { Money } from "@/components/primitives/money"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useDeleteCcCard, useSaveCcCard } from "@/hooks/use-plan"
import type { BankInfo, CCCard, CCCardRecord } from "@/lib/plan/schemas"
import { cn } from "@/lib/utils"

const TODAY_FALLBACK = new Date().toISOString().slice(0, 10)

function daysSince(iso: string | null | undefined, today: string): number {
  if (!iso) return 9999
  const a = new Date(`${iso}T00:00:00`).getTime()
  const b = new Date(`${today}T00:00:00`).getTime()
  return Math.max(0, Math.round((b - a) / 86_400_000))
}

function nextDue(
  c: CCCard,
  today: string
): { date: string; daysAway: number } | null {
  if (!c.paymentDueDay) return null
  const [y, m] = today.split("-").map(Number)
  const todayDay = Number(today.slice(8, 10))
  let year = y
  let month = m
  if (todayDay > c.paymentDueDay) {
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  const date = `${year}-${String(month).padStart(2, "0")}-${String(c.paymentDueDay).padStart(2, "0")}`
  const a = new Date(`${today}T00:00:00`).getTime()
  const b = new Date(`${date}T00:00:00`).getTime()
  return { date, daysAway: Math.round((b - a) / 86_400_000) }
}

function formatShortDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
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

function bankShort(account: string | null | undefined): string {
  if (!account) return "—"
  return account.split(":").pop() ?? account
}

export function CcCardView({
  card,
  banks,
  today = TODAY_FALLBACK,
}: {
  card: CCCard
  banks: BankInfo[]
  today?: string
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="flex h-[100px] w-full min-w-[180px] flex-col gap-0.5 rounded-md bg-card px-3 py-2 text-left ring-1 ring-foreground/10 hover:bg-muted/30"
          />
        }
      >
        <CardSummary card={card} today={today} />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[26rem] rounded-md bg-popover p-3 text-popover-foreground ring-1 ring-foreground/10"
      >
        <CcCardEditor
          card={card}
          banks={banks}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}

function CardSummary({ card, today }: { card: CCCard; today: string }) {
  const due = nextDue(card, today)
  const stale = card.lastClosedDate ? daysSince(card.lastClosedDate, today) : 0

  let staleTone: "ok" | "warn" | "bad" | "setup" | "unknown" = "ok"
  if (!card.isConfigured || !card.hasMonthlyInputs) staleTone = "setup"
  else if (!card.lastClosedDate) staleTone = "unknown"
  else if (stale >= 30) staleTone = "bad"
  else if (stale >= 14) staleTone = "warn"

  const stmt = card.statementBalance ? parseFloat(card.statementBalance) : 0
  const curr = card.currentBalance ? parseFloat(card.currentBalance) : 0

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium tracking-tight">
          {card.displayName}
        </span>
        <StaleChip tone={staleTone} stale={stale} />
      </div>
      {card.isConfigured && card.hasMonthlyInputs ? (
        <>
          <div className="mt-0.5 flex items-baseline justify-between gap-2">
            <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
              Stmt
            </span>
            <Money value={stmt} tone="none" className="text-sm font-semibold" />
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
              Curr
            </span>
            <Money value={curr} tone="muted" className="text-xs" />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span>
              {due ? (
                <>
                  Pays {formatShortDate(due.date)} · in{" "}
                  {due.daysAway === 0 ? "today" : `${due.daysAway}d`}
                </>
              ) : (
                <>No due day set</>
              )}
            </span>
            <span className="font-medium text-foreground/70">
              {bankShort(card.fundingAccount)}
            </span>
          </div>
        </>
      ) : (
        <div className="mt-2 flex flex-1 items-center justify-center text-[10px] text-muted-foreground">
          Click to set up
        </div>
      )}
    </>
  )
}

function CcCardEditor({
  card,
  banks,
  onClose,
}: {
  card: CCCard
  banks: BankInfo[]
  onClose: () => void
}) {
  const save = useSaveCcCard()
  const remove = useDeleteCcCard()

  const [mode, setMode] = React.useState<"monthly" | "config">(() =>
    card.paymentDueDay == null || !card.fundingAccount ? "config" : "monthly"
  )
  const [stmt, setStmt] = React.useState(card.statementBalance ?? "")
  const [closed, setClosed] = React.useState(card.lastClosedDate ?? "")
  const [paymentDueDay, setPaymentDueDay] = React.useState(
    card.paymentDueDay?.toString() ?? ""
  )
  const [statementCloseDay, setStatementCloseDay] = React.useState(
    card.statementCloseDay?.toString() ?? ""
  )
  const [fundingAccount, setFundingAccount] = React.useState(
    card.fundingAccount ?? ""
  )
  const [minimumPaymentOnly, setMinimumPaymentOnly] = React.useState(
    card.minimumPaymentOnly ?? false
  )

  const persist = () => {
    const record: CCCardRecord = {
      accountPath: card.accountPath,
      fundingAccount: fundingAccount || undefined,
      statementCloseDay: statementCloseDay
        ? parseInt(statementCloseDay, 10)
        : undefined,
      paymentDueDay: paymentDueDay ? parseInt(paymentDueDay, 10) : undefined,
      statementBalance: stmt || undefined,
      lastClosedDate: closed || undefined,
      minimumPaymentOnly: minimumPaymentOnly || undefined,
    }
    save.mutate(record, { onSuccess: () => onClose() })
  }

  const isMonthly = mode === "monthly"

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium">{card.displayName}</span>
          <span className="text-[10px] text-muted-foreground">
            {card.accountPath.replace("Liabilities:Credit:", "")}
          </span>
        </div>
        <button
          type="button"
          onClick={() => setMode(isMonthly ? "config" : "monthly")}
          className={cn(
            "rounded-md p-1 text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            !isMonthly && "bg-muted/40 text-foreground"
          )}
          title="Card config"
        >
          <Settings2 size={14} />
        </button>
      </div>

      {isMonthly ? (
        <>
          <Field label="Statement balance" value={stmt} onChange={setStmt} />
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Current balance · from ledger
            </span>
            <div className="rounded-sm bg-muted/40 px-2 py-1 text-xs tabular-nums">
              ${card.currentBalance ?? "0.00"}
            </div>
            <span className="text-[10px] text-muted-foreground/70">
              Auto-derived from{" "}
              <span className="font-mono">{card.accountPath}</span>. Updates as
              the importer brings in new txns.
            </span>
          </div>
          <Field
            label="Last closed"
            value={closed}
            onChange={setClosed}
            type="date"
          />
        </>
      ) : (
        <>
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              Funding account
            </span>
            <select
              value={fundingAccount}
              onChange={(e) => setFundingAccount(e.target.value)}
              className="rounded-sm bg-background px-2 py-1 text-xs ring-1 ring-foreground/10 focus:ring-primary/40 focus:outline-none"
            >
              <option value="">Select account…</option>
              {banks.map((b) => (
                <option key={b.account} value={b.account}>
                  {b.displayName}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-muted-foreground/70">
              The default checking that pays this card. Override per-month from
              the grid.
            </span>
          </div>

          <div className="flex gap-2">
            <Field
              label="Statement closes (day)"
              value={statementCloseDay}
              onChange={setStatementCloseDay}
              placeholder="1-31"
            />
            <Field
              label="Payment due (day)"
              value={paymentDueDay}
              onChange={setPaymentDueDay}
              placeholder="1-31"
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2 rounded-sm bg-muted/30 px-2 py-1.5 text-[11px]">
            <input
              type="checkbox"
              checked={minimumPaymentOnly}
              onChange={(e) => setMinimumPaymentOnly(e.target.checked)}
              className="h-3 w-3"
            />
            <span>
              <span className="font-medium">Minimum-payment only</span>
              <span className="text-muted-foreground">
                {" "}
                · suppress next-month forecast (e.g., 0% APR carry)
              </span>
            </span>
          </label>
        </>
      )}

      <div className="mt-1 flex items-center justify-between border-t border-border/50 pt-2">
        {!isMonthly && (
          <button
            type="button"
            onClick={() => {
              if (
                window.confirm(
                  `Delete ${card.displayName}'s planner record? This won't close the account in beancount.`
                )
              ) {
                remove.mutate(card.accountPath, { onSuccess: () => onClose() })
              }
            }}
            className="text-[11px] text-rose-600 hover:underline dark:text-rose-400"
          >
            Delete record
          </button>
        )}
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={persist}
            disabled={save.isPending}
            className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {save.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
}) {
  return (
    <label className="flex flex-1 flex-col gap-0.5">
      <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-sm bg-background px-2 py-1 text-xs ring-1 ring-foreground/10 focus:ring-primary/40 focus:outline-none"
      />
    </label>
  )
}

function StaleChip({
  tone,
  stale,
}: {
  tone: "ok" | "warn" | "bad" | "setup" | "unknown"
  stale: number
}) {
  if (tone === "setup") {
    return (
      <span className="rounded-sm bg-rose-500/15 px-1 py-px text-[9px] font-medium text-rose-700 dark:text-rose-400">
        Set up
      </span>
    )
  }
  if (tone === "unknown") {
    return (
      <span
        className="rounded-sm bg-muted px-1 py-px text-[9px] font-medium text-muted-foreground"
        title="No statement close date set"
      >
        ? close
      </span>
    )
  }
  return (
    <span
      className={cn(
        "rounded-sm px-1 py-px text-[9px] font-medium",
        tone === "ok" &&
          "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
        tone === "warn" && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
        tone === "bad" && "bg-rose-500/15 text-rose-700 dark:text-rose-400"
      )}
      title={`Closed ${stale} days ago`}
    >
      {tone === "ok" && "✓ "}
      {tone === "warn" && "⚠ "}
      {tone === "bad" && "✕ "}
      {stale}d
    </span>
  )
}
