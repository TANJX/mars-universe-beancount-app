"use client"

import * as React from "react"

import { useUIState } from "@/components/layout/ui-state"
import { useBalanceSheet } from "@/hooks/use-fava"
import { periodOpeningTime } from "@/lib/fava/periods"
import { accountRoot } from "@/lib/transform/classify"
import type { BalanceTreeNode } from "@/lib/types/views"

/**
 * USD opening balance for `account` at the start of the current period.
 *
 * Mirrors fava's `clamp()` semantics: only meaningful for Assets,
 * Liabilities, and Equity. Income and Expenses are swept into retained
 * earnings at the period boundary so their pre-period total reads as
 * zero by convention.
 *
 * Returns 0 when the account isn't filtered, when the root doesn't carry
 * forward, or when the snapshot is still loading.
 */
export function useAccountOpeningBalance(account: string | undefined): number {
  const { period } = useUIState()
  const root = account ? accountRoot(account) : null
  // "all time" has no prior period — opening = 0 by definition. Skip the
  // fetch so the cumulative column starts at 0 and runs up to the
  // current balance, matching fava with no `time=` filter.
  const carries =
    (root === "Assets" || root === "Liabilities" || root === "Equity") &&
    period.id !== "all"
  const time = carries ? periodOpeningTime(period) : undefined

  const sheet = useBalanceSheet({
    timeOverride: time,
    enabled: carries,
  })

  return React.useMemo(() => {
    if (!carries || !sheet.data || !account || !root) return 0
    const tree = sheet.data.trees[root]
    if (!tree) return 0
    const node = findNode(tree, account)
    return node?.balanceChildren.USD ?? 0
  }, [carries, sheet.data, account, root])
}

function findNode(tree: BalanceTreeNode, path: string): BalanceTreeNode | null {
  if (tree.account === path) return tree
  for (const child of tree.children ?? []) {
    if (path === child.account || path.startsWith(`${child.account}:`)) {
      const found = findNode(child, path)
      if (found) return found
    }
  }
  return null
}
