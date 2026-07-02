"use client"

import * as React from "react"
import { mergeBankOrder } from "@/components/plan/bank-panel"
import { CcOverrideDialog } from "@/components/plan/cc-override-dialog"
import {
  MovePlanDialog,
  type MovePlanSeed,
} from "@/components/plan/move-plan-dialog"
import {
  TransferDialog,
  type TransferDialogSeed,
} from "@/components/plan/transfer-dialog"
import { Money } from "@/components/primitives/money"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  useDeletePlan,
  useDeleteTransfer,
  useSaveCcOverride,
  useSavePlan,
  useSaveTransfer,
} from "@/hooks/use-plan"
import { parseAmount } from "@/lib/plan/format"
import type {
  BankInfo,
  CCCard,
  GridEntry,
  PlanGridResponse,
} from "@/lib/plan/schemas"
import { cn } from "@/lib/utils"

type StateFlag = "todo" | "pending" | null

interface EntryPatch {
  amount?: string
  description?: string
}

const QUIET_AFTER_DAYS = 14

interface PlanGridProps {
  data: PlanGridResponse
  bankOrder?: string[]
  hiddenBanks?: Set<string>
  stateFilter?: "todo" | "pending" | null
}

interface DisplayRow {
  kind: "day" | "quiet"
  date?: string
  count?: number
  ref?: PlanGridResponse["rows"][number]
  gapKey?: string
  expanded?: boolean
}

export function PlanGrid({
  data,
  bankOrder,
  hiddenBanks,
  stateFilter,
}: PlanGridProps) {
  const banks = React.useMemo(() => {
    const accountToBank = new Map(data.banks.map((b) => [b.account, b]))
    const orderedAccounts = mergeBankOrder(
      bankOrder ?? [],
      data.banks.map((b) => b.account)
    )
    return orderedAccounts
      .map((a) => accountToBank.get(a))
      .filter((b): b is BankInfo => !!b)
      .filter((b) => !hiddenBanks?.has(b.account))
  }, [data.banks, bankOrder, hiddenBanks])

  const savePlan = useSavePlan()
  const deletePlan = useDeletePlan()
  const deleteTransfer = useDeleteTransfer()
  const saveCcOverride = useSaveCcOverride()
  const saveTransfer = useSaveTransfer()

  const findTransferLegs = React.useCallback(
    (transferId: string) => {
      let fromAccount = ""
      let toAccount = ""
      let date = ""
      let amount = ""
      let description = ""
      let state: StateFlag = null
      for (const row of data.rows) {
        for (const [account, entries] of Object.entries(row.entries)) {
          for (const e of entries) {
            if (e.transferId !== transferId) continue
            const amt = parseFloat(e.amount)
            if (amt < 0) {
              fromAccount = account
            } else if (amt > 0) {
              toAccount = account
              amount = e.amount
            }
            if (!date) date = row.date
            if (!description) description = e.description
            if (state == null) state = (e.state ?? null) as StateFlag
          }
        }
      }
      if (!fromAccount || !toAccount) return null
      return { fromAccount, toAccount, date, amount, description, state }
    },
    [data.rows]
  )

  const handleSave = React.useCallback(
    (date: string, account: string, entryId: string, patch: EntryPatch) => {
      const row = data.rows.find((r) => r.date === date)
      const original = row?.entries[account]?.find((e) => e.id === entryId)
      if (!original) return
      const merged = {
        id: entryId,
        date,
        account,
        amount: patch.amount ?? original.amount,
        description: patch.description ?? original.description,
        state: original.state ?? null,
        transferId: original.transferId ?? null,
      }
      if (!merged.amount && !merged.description) {
        deletePlan.mutate(entryId)
      } else {
        savePlan.mutate(merged)
      }
    },
    [data.rows, savePlan, deletePlan]
  )

  const handleCreate = React.useCallback(
    (date: string, account: string, amount: string) => {
      if (!amount.trim()) return
      savePlan.mutate({
        date,
        account,
        amount: amount.trim(),
        description: "",
        state: null,
      })
    },
    [savePlan]
  )

  const [ccDialog, setCcDialog] = React.useState<{
    card: CCCard
    cycleMonth: string
    paymentDate: string
  } | null>(null)

  const [transferSeed, setTransferSeed] =
    React.useState<TransferDialogSeed | null>(null)

  const [moveSeed, setMoveSeed] = React.useState<MovePlanSeed | null>(null)

  const handleMovePlan = React.useCallback(
    (entry: GridEntry, date: string, account: string) => {
      if (entry.kind !== "plan") return
      setMoveSeed({
        id: entry.id,
        fromDate: date,
        fromAccount: account,
        amount: entry.amount,
        description: entry.description,
        state: (entry.state ?? null) as StateFlag,
      })
    },
    []
  )

  const [expandedGaps, setExpandedGaps] = React.useState<Set<string>>(
    () => new Set()
  )
  const toggleGap = React.useCallback((key: string) => {
    setExpandedGaps((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const handleNewTransfer = React.useCallback(
    (date: string, fromAccount: string) => {
      setTransferSeed({
        date,
        fromAccount,
        toAccount: "",
        amount: "",
        description: "",
      })
    },
    []
  )

  const handleEditTransfer = React.useCallback(
    (transferId: string) => {
      const legs = findTransferLegs(transferId)
      if (!legs) return
      setTransferSeed({
        id: transferId,
        date: legs.date,
        fromAccount: legs.fromAccount,
        toAccount: legs.toAccount,
        amount: legs.amount,
        description: legs.description,
        state: legs.state,
      })
    },
    [findTransferLegs]
  )

  const setEntryState = React.useCallback(
    (entry: GridEntry, date: string, account: string, next: StateFlag) => {
      // CC projection rows have no plan record yet — promote them to a
      // single-leg override carrying the new state.
      if (
        (entry.kind === "cc-locked" || entry.kind === "cc-forecast") &&
        entry.ccCardRef &&
        entry.ccCycleMonth
      ) {
        saveCcOverride.mutate({
          cardAccountPath: entry.ccCardRef,
          cycleMonth: entry.ccCycleMonth,
          plans: [
            {
              date,
              account,
              amount: entry.amount,
              description: entry.description,
              state: next,
            },
          ],
        })
        return
      }
      if (entry.kind !== "plan") return
      if (entry.transferId) {
        const legs = findTransferLegs(entry.transferId)
        if (!legs) return
        saveTransfer.mutate({
          id: entry.transferId,
          date: legs.date,
          fromAccount: legs.fromAccount,
          toAccount: legs.toAccount,
          amount: legs.amount,
          description: legs.description,
          state: next,
        })
        return
      }
      savePlan.mutate({
        id: entry.id,
        date,
        account,
        amount: entry.amount,
        description: entry.description,
        state: next,
        transferId: entry.transferId ?? null,
        ccCardRef: entry.ccCardRef ?? null,
        ccCycleMonth: entry.ccCycleMonth ?? null,
      })
    },
    [savePlan, saveCcOverride, saveTransfer, findTransferLegs]
  )

  const handleOpenCcDialog = React.useCallback(
    (entry: GridEntry, rowDate: string) => {
      const ref = entry.ccCardRef
      const cycle = entry.ccCycleMonth
      if (!ref || !cycle) return
      const card = data.ccCards.find((c) => c.accountPath === ref)
      if (!card) return
      const paymentDate = paymentDateFor(card, cycle) ?? rowDate
      setCcDialog({ card, cycleMonth: cycle, paymentDate })
    },
    [data.ccCards]
  )

  const todayRowRef = React.useRef<HTMLTableRowElement>(null)
  const didScrollRef = React.useRef(false)
  React.useEffect(() => {
    if (didScrollRef.current) return
    todayRowRef.current?.scrollIntoView({
      block: "center",
      behavior: "instant",
    })
    didScrollRef.current = true
  }, [])

  const displayRows = React.useMemo(
    () => collapseQuietDays(data.rows, data.today, expandedGaps),
    [data.rows, data.today, expandedGaps]
  )

  return (
    <>
      <div
        className="relative min-h-0 flex-1 overflow-auto rounded-md ring-1 ring-foreground/10 select-none"
        onContextMenu={(e) => e.preventDefault()}
      >
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-20 bg-background">
            <tr className="text-left">
              <th className="sticky left-0 z-30 bg-background px-2 py-2 font-medium text-muted-foreground">
                Date
              </th>
              <th className="sticky left-[60px] z-30 bg-background px-2 py-2 text-right font-medium text-muted-foreground">
                Total
              </th>
              {banks.map((b) => (
                <th
                  key={b.account}
                  className="border-l border-border/40 px-2 py-2 text-right font-medium"
                  colSpan={2}
                >
                  {b.displayName}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((dr) => {
              if (dr.kind === "quiet") {
                return (
                  <QuietRow
                    key={`quiet-${dr.gapKey}`}
                    count={dr.count!}
                    banksCount={banks.length}
                    expanded={!!dr.expanded}
                    onToggle={() => toggleGap(dr.gapKey!)}
                  />
                )
              }
              const row = dr.ref!
              return (
                <Row
                  key={row.date}
                  row={row}
                  banks={banks}
                  today={data.today}
                  todayRowRef={todayRowRef}
                  onSave={handleSave}
                  onCreate={handleCreate}
                  onOpenCcDialog={handleOpenCcDialog}
                  onNewTransfer={handleNewTransfer}
                  onSetState={setEntryState}
                  onDeletePlan={(id) => deletePlan.mutate(id)}
                  onDeleteTransfer={(id) => {
                    if (
                      window.confirm(
                        "Delete this transfer? This will remove both legs."
                      )
                    ) {
                      deleteTransfer.mutate(id)
                    }
                  }}
                  onMovePlan={handleMovePlan}
                  onEditTransfer={handleEditTransfer}
                  stateFilter={stateFilter ?? null}
                />
              )
            })}
          </tbody>
        </table>
      </div>
      {ccDialog && (
        <CcOverrideDialog
          open={!!ccDialog}
          onOpenChange={(open) => {
            if (!open) setCcDialog(null)
          }}
          card={ccDialog.card}
          cycleMonth={ccDialog.cycleMonth}
          paymentDate={ccDialog.paymentDate}
          banks={data.banks}
          rows={data.rows}
        />
      )}
      <TransferDialog
        open={!!transferSeed}
        onOpenChange={(open) => {
          if (!open) setTransferSeed(null)
        }}
        banks={data.banks}
        seed={transferSeed}
      />
      <MovePlanDialog
        open={!!moveSeed}
        onOpenChange={(open) => {
          if (!open) setMoveSeed(null)
        }}
        banks={data.banks}
        seed={moveSeed}
      />
    </>
  )
}

function paymentDateFor(card: CCCard, cycleMonth: string): string | null {
  if (!card.paymentDueDay) return null
  const [y, m] = cycleMonth.split("-").map(Number)
  if (!y || !m) return null
  const lastDay = new Date(y, m, 0).getDate()
  const day =
    card.paymentDueDay === -1 ? lastDay : Math.min(card.paymentDueDay, lastDay)
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

function collapseQuietDays(
  rows: PlanGridResponse["rows"],
  today: string,
  expandedGaps: Set<string>
): DisplayRow[] {
  const out: DisplayRow[] = []
  let quietRun: PlanGridResponse["rows"] = []
  const flush = () => {
    if (quietRun.length === 0) return
    if (quietRun.length <= 2) {
      // Don't bother collapsing tiny runs — the placeholder is bigger than 2 rows.
      for (const r of quietRun) out.push({ kind: "day", date: r.date, ref: r })
    } else {
      const gapKey = quietRun[0].date
      const expanded = expandedGaps.has(gapKey)
      out.push({ kind: "quiet", count: quietRun.length, gapKey, expanded })
      if (expanded) {
        for (const r of quietRun)
          out.push({ kind: "day", date: r.date, ref: r })
      }
    }
    quietRun = []
  }
  const cutoff = addDays(today, QUIET_AFTER_DAYS)
  for (const r of rows) {
    const isEmpty = Object.values(r.entries).every((arr) => arr.length === 0)
    const collapsible = isEmpty && r.date > cutoff
    if (collapsible) {
      quietRun.push(r)
    } else {
      flush()
      out.push({ kind: "day", date: r.date, ref: r })
    }
  }
  flush()
  return out
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function QuietRow({
  count,
  banksCount,
  expanded,
  onToggle,
}: {
  count: number
  banksCount: number
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <tr className="border-t border-border/30 bg-muted/10">
      <td colSpan={2 + banksCount * 2} className="p-0">
        <button
          type="button"
          onClick={onToggle}
          className="w-full cursor-pointer px-3 py-1 text-left text-[10px] text-muted-foreground italic hover:bg-muted/30"
        >
          {expanded ? "−" : "+"}
          {count} quiet days {expanded ? "(collapse)" : ""}
        </button>
      </td>
    </tr>
  )
}

function Row({
  row,
  banks,
  today,
  todayRowRef,
  onSave,
  onCreate,
  onOpenCcDialog,
  onNewTransfer,
  onSetState,
  onDeletePlan,
  onDeleteTransfer,
  onMovePlan,
  onEditTransfer,
  stateFilter,
}: {
  row: PlanGridResponse["rows"][number]
  banks: BankInfo[]
  today: string
  todayRowRef: React.RefObject<HTMLTableRowElement | null>
  onSave: (
    date: string,
    account: string,
    entryId: string,
    patch: EntryPatch
  ) => void
  onCreate: (date: string, account: string, amount: string) => void
  onOpenCcDialog: (entry: GridEntry, rowDate: string) => void
  onNewTransfer: (date: string, fromAccount: string) => void
  onSetState: (
    entry: GridEntry,
    date: string,
    account: string,
    next: StateFlag
  ) => void
  onDeletePlan: (id: string) => void
  onDeleteTransfer: (transferId: string) => void
  onMovePlan: (entry: GridEntry, date: string, account: string) => void
  onEditTransfer: (transferId: string) => void
  stateFilter: "todo" | "pending" | null
}) {
  const isToday = row.date === today
  const isPast = row.date < today
  const d = new Date(`${row.date}T00:00:00`)
  const isWeekend = d.getDay() === 0 || d.getDay() === 6
  const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]
  const label = `${dayName} ${d.getMonth() + 1}/${d.getDate()}`
  const totalNum = parseFloat(row.total)

  return (
    <tr
      ref={isToday ? todayRowRef : undefined}
      className={cn(
        "group/row border-t border-border/30 hover:bg-muted/40",
        isToday && "bg-primary/5",
        !isToday && isWeekend && "bg-muted/30"
      )}
    >
      <td
        className={cn(
          "sticky left-0 z-10 bg-background px-2 py-1 text-right whitespace-nowrap group-hover/row:bg-muted/40",
          isPast && "text-muted-foreground/60",
          isToday && "font-semibold underline",
          !isToday && isWeekend && "text-muted-foreground italic"
        )}
      >
        {label}
      </td>
      <td
        className={cn(
          "sticky left-[60px] z-10 bg-background px-2 py-1 text-right group-hover/row:bg-muted/40",
          isPast && "opacity-50"
        )}
      >
        <Money value={totalNum} tone="auto" className="text-xs" />
      </td>
      {banks.map((b) => (
        <BankCells
          key={b.account}
          date={row.date}
          account={b.account}
          entries={row.entries[b.account] ?? []}
          balance={parseFloat(row.balances[b.account] ?? "0")}
          isPast={isPast}
          onSave={onSave}
          onCreate={onCreate}
          onOpenCcDialog={onOpenCcDialog}
          onNewTransfer={onNewTransfer}
          onSetState={onSetState}
          onDeletePlan={onDeletePlan}
          onDeleteTransfer={onDeleteTransfer}
          onMovePlan={onMovePlan}
          onEditTransfer={onEditTransfer}
          stateFilter={stateFilter}
        />
      ))}
    </tr>
  )
}

function BankCells({
  date,
  account,
  entries,
  balance,
  isPast,
  onSave,
  onCreate,
  onOpenCcDialog,
  onNewTransfer,
  onSetState,
  onDeletePlan,
  onDeleteTransfer,
  onMovePlan,
  onEditTransfer,
  stateFilter,
}: {
  date: string
  account: string
  entries: GridEntry[]
  balance: number
  isPast: boolean
  onSave: (
    date: string,
    account: string,
    entryId: string,
    patch: EntryPatch
  ) => void
  onCreate: (date: string, account: string, amount: string) => void
  onOpenCcDialog: (entry: GridEntry, rowDate: string) => void
  onNewTransfer: (date: string, fromAccount: string) => void
  onSetState: (
    entry: GridEntry,
    date: string,
    account: string,
    next: StateFlag
  ) => void
  onDeletePlan: (id: string) => void
  onDeleteTransfer: (transferId: string) => void
  onMovePlan: (entry: GridEntry, date: string, account: string) => void
  onEditTransfer: (transferId: string) => void
  stateFilter: "todo" | "pending" | null
}) {
  const negativeBalance = balance < 0
  const [creating, setCreating] = React.useState(false)
  const [draft, setDraft] = React.useState("")

  // Empty draft = silently cancel; non-empty + parseable = save; non-empty
  // + unparseable = reject so the input visibly rings red until corrected.
  const draftValid = draft.trim() === "" || parseAmount(draft.trim()) !== null

  const startCreate = () => {
    setDraft("")
    setCreating(true)
  }
  const commitCreate = () => {
    if (!draftValid) return
    if (draft.trim() !== "") onCreate(date, account, draft)
    setCreating(false)
  }
  const cancelCreate = () => {
    setDraft("")
    setCreating(false)
  }

  return (
    <>
      <td
        className={cn(
          "border-l border-border/40 px-2 py-1 text-right whitespace-nowrap",
          isPast && "text-muted-foreground/60"
        )}
      >
        <Money
          value={balance}
          tone={negativeBalance ? "neg" : "none"}
          className={cn("text-xs", isPast && "opacity-60")}
        />
      </td>
      <td
        className={cn(
          "px-2 py-1 align-middle whitespace-nowrap",
          !isPast && "hover:bg-muted/30"
        )}
      >
        {creating ? (
          <input
            autoFocus
            placeholder="amount"
            className={cn(
              "w-24 rounded-sm bg-card px-1 text-right text-xs text-foreground ring-1 focus:outline-none",
              draftValid
                ? "ring-primary/40"
                : "text-rose-600 ring-rose-500/60 dark:text-rose-400"
            )}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitCreate()
              if (e.key === "Escape") cancelCreate()
            }}
            onBlur={() => {
              if (!draft.trim()) cancelCreate()
              else if (draftValid) commitCreate()
              // else: keep input open so the user can fix it
            }}
          />
        ) : isPast ? (
          entries.length > 0 ? (
            <div className="flex flex-col gap-0.5">
              {entries.map((entry) => (
                <EntryView
                  key={entry.id}
                  entry={entry}
                  isPast={isPast}
                  isFiltered={
                    stateFilter !== null && entry.state !== stateFilter
                  }
                  onSave={(patch) => onSave(date, account, entry.id, patch)}
                  onOpenCcDialog={() => onOpenCcDialog(entry, date)}
                  onSetState={(next) => onSetState(entry, date, account, next)}
                  onDeletePlan={() => onDeletePlan(entry.id)}
                  onDeleteTransfer={() =>
                    entry.transferId && onDeleteTransfer(entry.transferId)
                  }
                  onMovePlan={() => onMovePlan(entry, date, account)}
                  onEditTransfer={() =>
                    entry.transferId && onEditTransfer(entry.transferId)
                  }
                  onNewPlanHere={startCreate}
                  onNewTransferHere={() => onNewTransfer(date, account)}
                />
              ))}
            </div>
          ) : null
        ) : (
          <ContextMenu>
            <ContextMenuTrigger className="block min-h-[1.25rem]">
              {entries.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                  {entries.map((entry) => (
                    <EntryView
                      key={entry.id}
                      entry={entry}
                      isPast={isPast}
                      isFiltered={
                        stateFilter !== null && entry.state !== stateFilter
                      }
                      onSave={(patch) => onSave(date, account, entry.id, patch)}
                      onOpenCcDialog={() => onOpenCcDialog(entry, date)}
                      onSetState={(next) =>
                        onSetState(entry, date, account, next)
                      }
                      onDeletePlan={() => onDeletePlan(entry.id)}
                      onDeleteTransfer={() =>
                        entry.transferId && onDeleteTransfer(entry.transferId)
                      }
                      onMovePlan={() => onMovePlan(entry, date, account)}
                      onEditTransfer={() =>
                        entry.transferId && onEditTransfer(entry.transferId)
                      }
                      onNewPlanHere={startCreate}
                      onNewTransferHere={() => onNewTransfer(date, account)}
                    />
                  ))}
                </div>
              ) : null}
            </ContextMenuTrigger>
            <ContextMenuContent className="text-xs">
              <ContextMenuItem onClick={startCreate}>
                New plan here…
              </ContextMenuItem>
              <ContextMenuItem onClick={() => onNewTransfer(date, account)}>
                New transfer here…
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )}
      </td>
    </>
  )
}

function EntryView({
  entry,
  isPast,
  isFiltered,
  onSave,
  onOpenCcDialog,
  onSetState,
  onDeletePlan,
  onDeleteTransfer,
  onMovePlan,
  onEditTransfer,
  onNewPlanHere,
  onNewTransferHere,
}: {
  entry: GridEntry
  isPast: boolean
  isFiltered: boolean
  onSave: (patch: EntryPatch) => void
  onOpenCcDialog: () => void
  onSetState: (next: StateFlag) => void
  onDeletePlan: () => void
  onDeleteTransfer: () => void
  onMovePlan: () => void
  onEditTransfer: () => void
  onNewPlanHere: () => void
  onNewTransferHere: () => void
}) {
  const cleared = entry.kind === "cleared"
  const scheduled = entry.kind === "scheduled"
  const ccLocked = entry.kind === "cc-locked"
  const ccForecast = entry.kind === "cc-forecast"
  const ccTaggedPlan =
    entry.kind === "plan" && !!entry.ccCardRef && !!entry.ccCycleMonth
  // CC entries — projection rows AND override plans — share one visual style.
  // The override-vs-projection distinction matters in the dialog, not the cell.
  const isCcEntry = ccLocked || ccForecast || ccTaggedPlan
  const planFirm = entry.kind === "plan" && !ccTaggedPlan && !entry.state
  // State chips render on any plan (including CC overrides). Only the
  // blue-color treatment is gated to non-CC plans (CC entries keep their
  // unified neutral color).
  const isTodo = entry.kind === "plan" && entry.state === "todo"
  const isPending = entry.kind === "plan" && entry.state === "pending"
  const planTodo = isTodo && !ccTaggedPlan
  const planPending = isPending && !ccTaggedPlan
  const amount = parseAmount(entry.amount)

  // CC entries open the override dialog rather than the inline editor.
  // The dialog is the single edit surface for "this card's payment for this cycle."
  const ccDialogTarget = !isPast && isCcEntry

  // Plain plans (not transfer legs, not past, not CC-tagged) are inline-editable.
  // Transfer legs route through the transfer endpoints; those land in stage 5.
  const editable =
    entry.kind === "plan" && !entry.transferId && !ccDialogTarget && !isPast

  // Every non-past entry gets a context menu so the "New plan / New transfer"
  // items are reachable from any cell (otherwise cells full of entries leave
  // no empty space for the cell-level menu). State actions cover plans
  // (incl. transfer legs, which route through saveTransfer) and CC projections.
  const showStateActions =
    entry.kind === "plan" ||
    entry.kind === "cc-locked" ||
    entry.kind === "cc-forecast"
  const canDelete = entry.kind === "plan" && !entry.transferId
  const canEditTransfer = !!entry.transferId && !isPast
  // Past transfer legs route through a standalone delete since the edit
  // dialog is hidden for past dates — cleaning up stale transfers that
  // never cleared parallels the plain-plan Delete option.
  const canDeleteTransfer =
    entry.kind === "plan" && !!entry.transferId && isPast
  const currentState = (entry.state ?? null) as StateFlag
  // Past entries: deletable plans get a stripped-down menu (Delete only).
  // Editing/marking new state on the past doesn't make sense; cleaning up
  // stale plans that never cleared does.
  const hasMenu = !isPast || canDelete || canDeleteTransfer

  const [editing, setEditing] = React.useState<"amount" | "description" | null>(
    null
  )
  const [draft, setDraft] = React.useState("")

  const startEdit = (field: "amount" | "description") => {
    if (!editable) return
    setDraft(field === "amount" ? entry.amount : entry.description)
    setEditing(field)
  }

  const draftAmountValid =
    editing !== "amount" ||
    draft.trim() === "" ||
    parseAmount(draft.trim()) !== null

  const commit = () => {
    if (editing === "amount") {
      if (!draftAmountValid) return // keep input open until corrected
      if (draft !== entry.amount) onSave({ amount: draft })
    } else if (editing === "description" && draft !== entry.description) {
      onSave({ description: draft })
    }
    setEditing(null)
  }

  const cancel = () => setEditing(null)

  const body = (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-sm text-xs",
        isPast && "opacity-60",
        scheduled && "text-muted-foreground italic",
        // All CC entries (projection or override plan) share one neutral style.
        // cc-forecast keeps italic-muted so the eye reads it as estimated.
        isCcEntry && "text-foreground/80",
        ccForecast && "text-muted-foreground/70 italic",
        (planFirm || planTodo || planPending) &&
          "text-blue-600 dark:text-blue-400",
        planTodo && "font-semibold",
        planPending && "italic",
        isFiltered && "opacity-25"
      )}
    >
      {editing === "amount" ? (
        <input
          autoFocus
          className={cn(
            "w-20 rounded-sm bg-card px-1 text-right text-xs text-foreground ring-1 focus:outline-none",
            draftAmountValid
              ? "ring-primary/40"
              : "text-rose-600 ring-rose-500/60 dark:text-rose-400"
          )}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit()
            if (e.key === "Escape") cancel()
          }}
          onBlur={() => {
            if (draftAmountValid) commit()
            // else: keep input open so the user can fix it
          }}
        />
      ) : amount !== null ? (
        <button
          type="button"
          disabled={!editable && !ccDialogTarget}
          onClick={(e) => {
            e.stopPropagation()
            if (ccDialogTarget) {
              onOpenCcDialog()
            } else if (editable) {
              startEdit("amount")
            }
          }}
          className={cn(
            "rounded-sm",
            (editable || ccDialogTarget) &&
              "cursor-pointer hover:bg-foreground/5",
            !editable && !ccDialogTarget && "cursor-default"
          )}
        >
          <Money
            value={amount}
            tone="none"
            className={cn(
              "text-xs",
              (ccLocked || ccTaggedPlan) && "font-medium",
              ccForecast && "italic"
            )}
          />
        </button>
      ) : null}
      {editing === "description" ? (
        <input
          autoFocus
          className="w-32 rounded-sm bg-card px-1 text-left text-[11px] text-foreground ring-1 ring-primary/40 focus:outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit()
            if (e.key === "Escape") cancel()
          }}
          onBlur={commit}
        />
      ) : (
        <button
          type="button"
          disabled={!editable && !ccDialogTarget}
          onClick={(e) => {
            e.stopPropagation()
            if (ccDialogTarget) {
              onOpenCcDialog()
            } else if (editable) {
              startEdit("description")
            }
          }}
          className={cn(
            "truncate text-left text-[11px]",
            !cleared &&
              !planFirm &&
              !planTodo &&
              !planPending &&
              "text-muted-foreground",
            entry.transferId && "before:content-['↔_']",
            editable && "cursor-text rounded-sm hover:bg-foreground/5",
            ccDialogTarget && "cursor-pointer rounded-sm hover:bg-foreground/5",
            !editable && !ccDialogTarget && "cursor-default"
          )}
        >
          {entry.description ||
            (editable ? (
              <span className="text-muted-foreground/40">+ note</span>
            ) : (
              ""
            ))}
        </button>
      )}
      {isTodo && (
        <span className="rounded-sm bg-amber-500/15 px-1 py-px text-[9px] font-medium text-amber-700 dark:text-amber-400">
          To-do
        </span>
      )}
      {isPending && (
        <span className="rounded-sm bg-sky-500/15 px-1 py-px text-[9px] font-medium text-sky-700 dark:text-sky-400">
          Pending
        </span>
      )}
      {ccForecast && (
        <span className="rounded-sm bg-muted px-1 py-px text-[9px] font-medium text-muted-foreground">
          Forecast
        </span>
      )}
      {entry.matchedCcPlan && (
        <span
          className="rounded-sm bg-emerald-500/15 px-1 py-px text-[9px] font-medium text-emerald-700 dark:text-emerald-400"
          title={`Matched ${entry.matchedCcPlan.displayName} payment${entry.matchedCcPlan.ccCycleMonth ? ` for ${entry.matchedCcPlan.ccCycleMonth}` : ""}`}
        >
          → {entry.matchedCcPlan.displayName}
        </span>
      )}
    </div>
  )

  if (!hasMenu) return body

  return (
    <ContextMenu>
      <ContextMenuTrigger className="contents">{body}</ContextMenuTrigger>
      <ContextMenuContent className="text-xs">
        {canEditTransfer && (
          <ContextMenuItem onClick={onEditTransfer}>
            Edit transfer…
          </ContextMenuItem>
        )}
        {!isPast && showStateActions && (
          <>
            <ContextMenuItem
              onClick={() =>
                onSetState(currentState === "todo" ? null : "todo")
              }
            >
              {currentState === "todo" ? "Clear To-do" : "Mark as To-do"}
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() =>
                onSetState(currentState === "pending" ? null : "pending")
              }
            >
              {currentState === "pending" ? "Clear Pending" : "Mark as Pending"}
            </ContextMenuItem>
          </>
        )}
        {editable && (
          <ContextMenuItem onClick={onMovePlan}>Move to…</ContextMenuItem>
        )}
        {canDelete && (
          <ContextMenuItem variant="destructive" onClick={onDeletePlan}>
            Delete
          </ContextMenuItem>
        )}
        {canDeleteTransfer && (
          <ContextMenuItem variant="destructive" onClick={onDeleteTransfer}>
            Delete transfer
          </ContextMenuItem>
        )}
        {!isPast && (
          <>
            {(showStateActions || canDelete) && <ContextMenuSeparator />}
            <ContextMenuItem onClick={onNewPlanHere}>
              New plan here…
            </ContextMenuItem>
            <ContextMenuItem onClick={onNewTransferHere}>
              New transfer here…
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
