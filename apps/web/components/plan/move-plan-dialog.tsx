"use client"

import * as React from "react"

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useSavePlan } from "@/hooks/use-plan"
import type { BankInfo } from "@/lib/plan/schemas"

export interface MovePlanSeed {
  id: string
  fromDate: string
  fromAccount: string
  amount: string
  description: string
  state: "todo" | "pending" | null
}

interface MovePlanDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  banks: BankInfo[]
  seed: MovePlanSeed | null
}

export function MovePlanDialog({
  open,
  onOpenChange,
  banks,
  seed,
}: MovePlanDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && seed && (
          <MoveEditor
            seed={seed}
            banks={banks}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function MoveEditor({
  seed,
  banks,
  onClose,
}: {
  seed: MovePlanSeed
  banks: BankInfo[]
  onClose: () => void
}) {
  const save = useSavePlan()
  const [date, setDate] = React.useState(seed.fromDate)
  const [account, setAccount] = React.useState(seed.fromAccount)

  const unchanged = date === seed.fromDate && account === seed.fromAccount
  const valid = !!date && !!account && !unchanged

  const handleSave = () => {
    if (!valid) return
    save.mutate(
      {
        id: seed.id,
        date,
        account,
        amount: seed.amount,
        description: seed.description,
        state: seed.state,
      },
      { onSuccess: () => onClose() }
    )
  }

  const fromBank = banks.find((b) => b.account === seed.fromAccount)

  return (
    <>
      <DialogHeader>
        <DialogTitle>Move plan</DialogTitle>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        <div className="rounded-sm bg-muted/40 px-2 py-1.5 text-[11px] text-muted-foreground">
          From{" "}
          <span className="text-foreground">
            {fromBank?.displayName ?? seed.fromAccount}
          </span>{" "}
          on <span className="text-foreground">{seed.fromDate}</span>
          {seed.amount ? (
            <>
              {" "}
              · <span className="text-foreground">{seed.amount}</span>
            </>
          ) : null}
          {seed.description ? (
            <>
              {" "}
              · <span className="text-foreground">{seed.description}</span>
            </>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Date">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-7 rounded-sm bg-background px-2 text-xs ring-1 ring-foreground/10 focus:ring-primary/40 focus:outline-none"
            />
          </Field>
          <Field label="Account">
            <select
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              className="h-7 rounded-sm bg-background px-2 text-xs ring-1 ring-foreground/10 focus:ring-primary/40 focus:outline-none"
            >
              {banks.map((b) => (
                <option key={b.account} value={b.account}>
                  {b.displayName}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="mt-1 flex items-center justify-end border-t border-border/50 pt-2">
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
              disabled={!valid || save.isPending}
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {save.isPending ? "Moving…" : "Move"}
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
