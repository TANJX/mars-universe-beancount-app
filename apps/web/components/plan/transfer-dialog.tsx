"use client"

import * as React from "react"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useDeleteTransfer, useSaveTransfer } from "@/hooks/use-plan"
import { parseAmount } from "@/lib/plan/format"
import type { BankInfo } from "@/lib/plan/schemas"

export interface TransferDialogSeed {
  id?: string
  date: string
  fromAccount: string
  toAccount: string
  amount: string
  description: string
}

interface TransferDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  banks: BankInfo[]
  seed: TransferDialogSeed | null
}

export function TransferDialog({
  open,
  onOpenChange,
  banks,
  seed,
}: TransferDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && seed && (
          <TransferEditor
            seed={seed}
            banks={banks}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function TransferEditor({
  seed,
  banks,
  onClose,
}: {
  seed: TransferDialogSeed
  banks: BankInfo[]
  onClose: () => void
}) {
  const save = useSaveTransfer()
  const remove = useDeleteTransfer()
  const [from, setFrom] = React.useState(seed.fromAccount)
  const [to, setTo] = React.useState(seed.toAccount)
  const [amount, setAmount] = React.useState(seed.amount)
  const [date, setDate] = React.useState(seed.date)
  const [description, setDescription] = React.useState(seed.description)

  const isEdit = !!seed.id
  const sameAccount = from && to && from === to
  const parsedAmount = parseAmount(amount)
  const valid =
    !!from && !!to && !sameAccount && parsedAmount !== null && parsedAmount > 0

  const handleSave = () => {
    if (!valid) return
    save.mutate(
      {
        id: seed.id,
        date,
        fromAccount: from,
        toAccount: to,
        amount,
        description,
        state: null,
      },
      { onSuccess: () => onClose() }
    )
  }

  const handleDelete = () => {
    if (!seed.id) return
    if (!window.confirm("Delete this transfer? This will remove both legs.")) {
      return
    }
    remove.mutate(seed.id, { onSuccess: () => onClose() })
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isEdit ? "Edit transfer" : "New transfer"}</DialogTitle>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="From">
            <select
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-7 rounded-sm bg-background px-2 text-xs ring-1 ring-foreground/10 focus:ring-primary/40 focus:outline-none"
            >
              <option value="">Select…</option>
              {banks.map((b) => (
                <option key={b.account} value={b.account}>
                  {b.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field label="To">
            <select
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-7 rounded-sm bg-background px-2 text-xs ring-1 ring-foreground/10 focus:ring-primary/40 focus:outline-none"
            >
              <option value="">Select…</option>
              {banks.map((b) => (
                <option key={b.account} value={b.account}>
                  {b.displayName}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {sameAccount && (
          <div className="rounded-sm bg-rose-500/10 px-2 py-1 text-[11px] text-rose-700 dark:text-rose-400">
            From and To must be different accounts.
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Field label="Amount">
            <input
              type="text"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="500 or =250+250"
              className="h-7 rounded-sm bg-background px-2 text-right text-xs tabular-nums ring-1 ring-foreground/10 focus:ring-primary/40 focus:outline-none"
            />
          </Field>
          <Field label="Date">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-7 rounded-sm bg-background px-2 text-xs ring-1 ring-foreground/10 focus:ring-primary/40 focus:outline-none"
            />
          </Field>
        </div>

        <Field label="Description (optional)">
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="rent fund move…"
            className="h-7 rounded-sm bg-background px-2 text-xs ring-1 ring-foreground/10 focus:ring-primary/40 focus:outline-none"
          />
        </Field>

        <div className="mt-1 flex items-center justify-between border-t border-border/50 pt-2">
          {isEdit && (
            <button
              type="button"
              onClick={handleDelete}
              className="text-[11px] text-rose-600 hover:underline dark:text-rose-400"
            >
              Delete transfer
            </button>
          )}
          <div className="ml-auto flex gap-2">
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
              disabled={!valid || save.isPending}
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {save.isPending ? "Saving…" : isEdit ? "Save" : "Create"}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      {children}
    </label>
  )
}
