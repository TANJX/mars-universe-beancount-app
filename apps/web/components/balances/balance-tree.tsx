"use client"

import { ChevronRight } from "lucide-react"
import Link from "next/link"
import * as React from "react"
import { usePeriodHref } from "@/components/layout/ui-state"
import { AccountDot } from "@/components/primitives/account-dot"
import { Money } from "@/components/primitives/money"
import { formatPercent } from "@/lib/format"
import { accountSegment } from "@/lib/transform/classify"
import type { AccountRoot, BalanceTreeNode } from "@/lib/types/views"
import { cn } from "@/lib/utils"

// Sub-$1 USD subtree dust gets hidden — closed accounts, rounding noise.
const DUST_USD = 1

interface BalanceTreeProps {
  /** Display title (defaults to root.segment / accountRoot label). */
  title: string
  /** Drives the section dot + progress-bar colour. */
  rootKind: AccountRoot
  /** Subtree root. The root row itself is rendered as the section header. */
  root: BalanceTreeNode
  /**
   * Flip displayed amounts (multiply by −1). Used for Income/Expenses where
   * Beancount stores Income as negative and Expenses as positive but the user
   * expects "money in" to be positive and "money spent" to be negative.
   */
  flipSign?: boolean
  /** Whether to expand sections by default. */
  defaultOpen?: boolean
  baseCurrency?: string
}

export function BalanceTree({
  title,
  rootKind,
  root,
  flipSign = false,
  defaultOpen = true,
  baseCurrency = "USD",
}: BalanceTreeProps) {
  const rawTotal = pickValue(root.balanceChildren, baseCurrency)
  const total = flipSign ? -rawTotal : rawTotal
  const totalForShare = Math.abs(total) || 1

  const [expanded, setExpanded] = React.useState<Set<string>>(() => {
    if (!defaultOpen) return new Set()
    const out = new Set<string>()
    for (const c of root.children) {
      if (c.children?.length) out.add(c.account)
    }
    return out
  })

  const toggle = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const visibleChildren = root.children.filter((c) => !isDust(c, baseCurrency))

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between border-b px-4 pt-3 pb-2">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AccountDot root={rootKind} />
          {title}
        </span>
        <Money
          value={total}
          tone="auto"
          className="text-sm font-medium tabular-nums"
        />
      </div>
      {visibleChildren.map((n) => (
        <NodeRow
          key={n.account}
          node={n}
          depth={0}
          rootKind={rootKind}
          totalForShare={totalForShare}
          flipSign={flipSign}
          expanded={expanded}
          toggle={toggle}
          baseCurrency={baseCurrency}
        />
      ))}
    </div>
  )
}

function NodeRow({
  node,
  depth,
  rootKind,
  totalForShare,
  flipSign,
  expanded,
  toggle,
  baseCurrency,
}: {
  node: BalanceTreeNode
  depth: number
  rootKind: AccountRoot
  totalForShare: number
  flipSign: boolean
  expanded: Set<string>
  toggle: (key: string) => void
  baseCurrency: string
}) {
  const visibleChildren =
    node.children?.filter((c) => !isDust(c, baseCurrency)) ?? []
  const hasChildren = visibleChildren.length > 0
  const isOpen = expanded.has(node.account)
  const periodHref = usePeriodHref()

  // Prefer own balance when the account has its own postings; else aggregate.
  const ownVal = node.balance[baseCurrency]
  const childVal = node.balanceChildren[baseCurrency]
  const rawAmount =
    Object.keys(node.balance).length > 0 || node.hasTxns
      ? (ownVal ?? 0)
      : (childVal ?? 0)
  const amount = flipSign ? -rawAmount : rawAmount
  const subtree = childVal ?? 0
  const share = totalForShare > 0 ? Math.abs(subtree) / totalForShare : 0

  const journalHref = periodHref(
    `/journal?account=${encodeURIComponent(node.account)}`
  )

  return (
    <>
      <div
        className={cn(
          "group/row grid h-8 grid-cols-[1fr_7rem_3rem_3rem] items-center gap-3 px-4",
          "text-sm group-data-[density=compact]/density:h-7 hover:bg-accent/40"
        )}
        style={{ paddingLeft: `${1 + depth * 1.25}rem` }}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {hasChildren ? (
            <button
              type="button"
              onClick={() => toggle(node.account)}
              className="-ml-1 flex size-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              aria-label={isOpen ? "Collapse" : "Expand"}
            >
              <ChevronRight
                size={12}
                className={cn("transition-transform", isOpen && "rotate-90")}
              />
            </button>
          ) : (
            <span className="-ml-1 size-4" />
          )}
          <Link
            href={journalHref}
            className="truncate underline-offset-2 hover:underline"
            title={`View ${node.account} in Journal`}
          >
            {accountSegment(node.account)}
          </Link>
        </div>
        <Money
          value={amount}
          tone="auto"
          className="text-right text-sm tabular-nums"
        />
        <span className="text-right font-mono text-xs text-muted-foreground tabular-nums">
          {share > 0 ? formatPercent(share * 100) : "—"}
        </span>
        <div className="h-[3px] overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", BAR_COLOR[rootKind])}
            style={{ width: `${Math.min(100, share * 100)}%` }}
          />
        </div>
      </div>
      {hasChildren &&
        isOpen &&
        visibleChildren.map((c) => (
          <NodeRow
            key={c.account}
            node={c}
            depth={depth + 1}
            rootKind={rootKind}
            totalForShare={totalForShare}
            flipSign={flipSign}
            expanded={expanded}
            toggle={toggle}
            baseCurrency={baseCurrency}
          />
        ))}
    </>
  )
}

const BAR_COLOR: Record<AccountRoot, string> = {
  Assets: "bg-emerald-500",
  Liabilities: "bg-rose-500",
  Equity: "bg-amber-500",
  Income: "bg-emerald-500",
  Expenses: "bg-rose-500",
}

function pickValue(inv: Record<string, number>, currency: string): number {
  return inv[currency] ?? 0
}

function isDust(node: BalanceTreeNode, baseCurrency: string): boolean {
  return Math.abs(pickValue(node.balanceChildren, baseCurrency)) < DUST_USD
}
