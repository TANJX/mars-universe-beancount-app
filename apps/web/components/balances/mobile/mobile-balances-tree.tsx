"use client"

import * as React from "react"
import { ChevronRight } from "lucide-react"

import { AccountDot } from "@/components/primitives/account-dot"
import { Money } from "@/components/primitives/money"
import { accountSegment } from "@/lib/transform/classify"
import type { AccountRoot, BalanceTreeNode } from "@/lib/types/views"
import { cn } from "@/lib/utils"

// Sub-$1 USD subtree dust gets hidden (matches the desktop BalanceTree).
const DUST_USD = 1

interface MobileBalancesTreeProps {
  rootKind: AccountRoot
  root: BalanceTreeNode
  defaultOpen?: boolean
  baseCurrency?: string
  /**
   * Flip displayed amounts (multiply by −1). Used for Income / Expenses
   * where Beancount stores Income as negative and Expenses as positive but
   * the user expects "money in" to be positive.
   */
  flipSign?: boolean
}

export function MobileBalancesTree({
  rootKind,
  root,
  defaultOpen = true,
  baseCurrency = "USD",
  flipSign = false,
}: MobileBalancesTreeProps) {
  const rawTotal = pickValue(root.balanceChildren, baseCurrency)
  const total = flipSign ? -rawTotal : rawTotal
  const visibleChildren = root.children.filter((c) => !isDust(c))

  const [openRoot, setOpenRoot] = React.useState(defaultOpen)
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpenRoot((v) => !v)}
        className="flex min-h-12 items-center gap-2.5 border-b px-2 py-2.5 text-left active:bg-accent/40"
      >
        <ChevronRight
          size={11}
          className={cn(
            "shrink-0 text-muted-foreground transition-transform",
            openRoot && "rotate-90"
          )}
        />
        <AccountDot root={rootKind} />
        <span className="flex-1 truncate text-sm font-medium">{rootKind}</span>
        <Money value={total} tone="auto" className="text-sm font-medium" />
      </button>
      {openRoot &&
        visibleChildren.map((node) => (
          <NodeRow
            key={node.account}
            node={node}
            depth={1}
            expanded={expanded}
            toggle={toggle}
            baseCurrency={baseCurrency}
            flipSign={flipSign}
          />
        ))}
    </div>
  )
}

function NodeRow({
  node,
  depth,
  expanded,
  toggle,
  baseCurrency,
  flipSign,
}: {
  node: BalanceTreeNode
  depth: number
  expanded: Set<string>
  toggle: (key: string) => void
  baseCurrency: string
  flipSign: boolean
}) {
  const visibleChildren = node.children?.filter((c) => !isDust(c)) ?? []
  const hasChildren = visibleChildren.length > 0
  const isOpen = expanded.has(node.account)

  // Prefer own balance when the account has its own postings; else the
  // aggregated subtree balance.
  const ownVal = node.balance[baseCurrency]
  const childVal = node.balanceChildren[baseCurrency]
  const rawAmount =
    Object.keys(node.balance).length > 0 || node.hasTxns
      ? (ownVal ?? 0)
      : (childVal ?? 0)
  const amount = flipSign ? -rawAmount : rawAmount
  const sub = hasChildren ? `${visibleChildren.length} accounts` : null

  return (
    <>
      <button
        type="button"
        onClick={() => hasChildren && toggle(node.account)}
        disabled={!hasChildren}
        style={{ paddingLeft: `${0.5 + depth * 1.25}rem` }}
        className={cn(
          "flex min-h-11 items-center gap-2 border-b py-2 pr-2 text-left",
          hasChildren ? "active:bg-accent/40" : "cursor-default"
        )}
      >
        {hasChildren ? (
          <ChevronRight
            size={10}
            className={cn(
              "shrink-0 text-muted-foreground transition-transform",
              isOpen && "rotate-90"
            )}
          />
        ) : (
          <span aria-hidden className="size-2.5 shrink-0" />
        )}
        <span className="flex-1 truncate text-[13px] text-foreground">
          {accountSegment(node.account)}
        </span>
        {sub && (
          <span className="font-mono text-[10.5px] text-muted-foreground tabular-nums">
            {sub}
          </span>
        )}
        <Money value={amount} tone="auto" className="text-[13px] font-normal" />
      </button>
      {hasChildren &&
        isOpen &&
        visibleChildren.map((c) => (
          <NodeRow
            key={c.account}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            toggle={toggle}
            baseCurrency={baseCurrency}
            flipSign={flipSign}
          />
        ))}
    </>
  )
}

function pickValue(inv: Record<string, number>, currency: string): number {
  return inv[currency] ?? 0
}

function isDust(node: BalanceTreeNode): boolean {
  const values = Object.values(node.balanceChildren ?? {})
  if (values.length === 0) return true
  return values.every((v) => Math.abs(v) < DUST_USD)
}
