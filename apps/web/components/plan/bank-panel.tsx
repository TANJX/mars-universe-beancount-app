"use client"

import { GripVertical } from "lucide-react"
import * as React from "react"

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useSavePlanSettings } from "@/hooks/use-plan"
import type { BankInfo, PlanSettings } from "@/lib/plan/schemas"
import { cn } from "@/lib/utils"

export function mergeBankOrder(
  currentOrder: string[],
  available: string[]
): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const a of currentOrder) {
    if (available.includes(a) && !seen.has(a)) {
      out.push(a)
      seen.add(a)
    }
  }
  for (const a of available) {
    if (!seen.has(a)) {
      out.push(a)
      seen.add(a)
    }
  }
  return out
}

interface BankPanelProps {
  banks: BankInfo[]
  settings: PlanSettings
}

export function BankPanel({ banks, settings }: BankPanelProps) {
  const save = useSavePlanSettings()
  const [open, setOpen] = React.useState(false)
  const [draggedAccount, setDraggedAccount] = React.useState<string | null>(
    null
  )

  const availableAccounts = banks.map((b) => b.account)
  const orderedAccounts = mergeBankOrder(
    settings.bankPanel.bankOrder,
    availableAccounts
  )
  const visibleCount = orderedAccounts.filter(
    (a) => !settings.bankPanel.hiddenBanks.includes(a)
  ).length

  const update = (next: PlanSettings) => save.mutate(next)

  const toggleHidden = (account: string) => {
    const isHidden = settings.bankPanel.hiddenBanks.includes(account)
    update({
      ...settings,
      bankPanel: {
        ...settings.bankPanel,
        hiddenBanks: isHidden
          ? settings.bankPanel.hiddenBanks.filter((a) => a !== account)
          : [...settings.bankPanel.hiddenBanks, account],
      },
    })
  }

  const toggleExcludedFromTotal = (account: string) => {
    const isExcluded =
      settings.bankPanel.excludedFromTotalBanks.includes(account)
    update({
      ...settings,
      bankPanel: {
        ...settings.bankPanel,
        excludedFromTotalBanks: isExcluded
          ? settings.bankPanel.excludedFromTotalBanks.filter(
              (a) => a !== account
            )
          : [...settings.bankPanel.excludedFromTotalBanks, account],
      },
    })
  }

  const moveBefore = (dragged: string, target: string) => {
    if (dragged === target) return
    const next = orderedAccounts.filter((a) => a !== dragged)
    const targetIndex = next.indexOf(target)
    if (targetIndex === -1) return
    next.splice(targetIndex, 0, dragged)
    update({
      ...settings,
      bankPanel: { ...settings.bankPanel, bankOrder: next },
    })
  }

  const reset = () => {
    update({
      ...settings,
      bankPanel: {
        bankOrder: [],
        hiddenBanks: [],
        excludedFromTotalBanks: [],
      },
    })
  }

  const displayName = (account: string) =>
    banks.find((b) => b.account === account)?.displayName ?? account

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground ring-1 ring-foreground/10 hover:bg-muted/50 hover:text-foreground"
          />
        }
      >
        Banks · {visibleCount}/{availableAccounts.length}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex w-80 flex-col gap-1 rounded-md bg-popover p-2 text-popover-foreground ring-1 ring-foreground/10"
      >
        <div className="flex items-center justify-between px-1 py-1">
          <span className="text-xs font-medium">Banks</span>
          <span className="text-[10px] text-muted-foreground">
            Show · In total
          </span>
        </div>
        <div className="flex max-h-80 flex-col gap-0.5 overflow-auto">
          {orderedAccounts.map((account) => {
            const isHidden = settings.bankPanel.hiddenBanks.includes(account)
            const isExcluded =
              settings.bankPanel.excludedFromTotalBanks.includes(account)
            return (
              <div
                key={account}
                draggable
                onDragStart={() => setDraggedAccount(account)}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = "move"
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  if (draggedAccount) moveBefore(draggedAccount, account)
                  setDraggedAccount(null)
                }}
                onDragEnd={() => setDraggedAccount(null)}
                className={cn(
                  "flex items-center gap-2 rounded-sm px-1.5 py-1 text-xs hover:bg-muted/30",
                  draggedAccount === account && "opacity-40"
                )}
              >
                <span
                  className="cursor-grab text-muted-foreground/60 active:cursor-grabbing"
                  aria-hidden
                >
                  <GripVertical size={12} />
                </span>
                <span className="flex-1 truncate">{displayName(account)}</span>
                <label
                  className="flex cursor-pointer items-center gap-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={!isHidden}
                    onChange={() => toggleHidden(account)}
                    className="h-3 w-3 cursor-pointer"
                  />
                </label>
                <label
                  className="flex cursor-pointer items-center gap-1 pl-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={!isExcluded}
                    onChange={() => toggleExcludedFromTotal(account)}
                    className="h-3 w-3 cursor-pointer"
                  />
                </label>
              </div>
            )
          })}
        </div>
        <div className="mt-1 flex justify-between border-t border-border/50 pt-2">
          <span className="px-1 text-[10px] text-muted-foreground">
            Drag to reorder
          </span>
          <button
            type="button"
            onClick={reset}
            className="px-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            Reset
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
