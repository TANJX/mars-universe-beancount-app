"use client"

import * as React from "react"

import { useUIState } from "@/components/layout/ui-state"
import { useBalanceSheet, useIncomeStatement } from "@/hooks/use-fava"
import { periodClosingTime, periodEndDay } from "@/lib/fava/periods"
import { findTreeNode } from "@/lib/fava/tree"
import { accountRoot } from "@/lib/transform/classify"
import type { AccountRoot } from "@/lib/types/views"

export interface CurrencyTotal {
  currency: string
  amount: number
}

export interface AccountBalance {
  root: AccountRoot
  /**
   * "snapshot" — a closing balance carried forward (Assets/Liabilities/Equity).
   * "cumulative" — everything booked through `asOf` (Income/Expenses, which
   * fava sweeps into retained earnings rather than carrying forward).
   */
  kind: "snapshot" | "cumulative"
  /**
   * Subtree totals, sign-flipped for Income/Expenses so inflow reads positive.
   * USD leads when present, then the remaining commodities by descending
   * magnitude — so `totals[0]` is always the figure worth putting in lights.
   * Empty when the account nets to zero (fava omits zeroed currencies).
   */
  totals: CurrencyTotal[]
  /** Last day the figure covers, ISO. Null under "All time" (no upper bound). */
  asOf: string | null
  /** False once loaded when the account has no node in the tree at all. */
  found: boolean
  isPending: boolean
  isError: boolean
}

/**
 * Balance of `account` (subtree-inclusive) at the end of the active period.
 *
 * Routes through balance_sheet for real accounts and income_statement for
 * Income/Expenses, since fava only publishes each root in one of the two. Both
 * are asked for `1900 - {period end}` so the figure is independent of whether
 * anything was posted *inside* the period — which is exactly the case the
 * journal's balance card exists for.
 */
export function useAccountBalance(account: string): AccountBalance {
  const { period } = useUIState()
  const root = accountRoot(account)
  const carriesForward =
    root === "Assets" || root === "Liabilities" || root === "Equity"

  // "All time" has no upper bound in the journal either — omit `time=` so
  // future-dated forecast entries are counted the same way the rows are.
  const isAllTime = period.id === "all"
  const time = isAllTime ? undefined : periodClosingTime(period)
  const asOf = isAllTime ? null : periodEndDay(period)

  const sheet = useBalanceSheet({ timeOverride: time, enabled: carriesForward })
  const statement = useIncomeStatement({
    timeOverride: time,
    // The card reads only the tree; coarsen the interval so fava doesn't
    // serialise a per-month chart series across the whole ledger history.
    interval: "year",
    enabled: !carriesForward,
  })
  const query = carriesForward ? sheet : statement

  return React.useMemo(() => {
    const tree = carriesForward
      ? sheet.data?.trees[root]
      : root === "Income"
        ? statement.data?.income
        : statement.data?.expenses
    const node = tree ? findTreeNode(tree, account) : null
    // Beancount stores Income negative and Expenses positive; the rest of the
    // app flips both so "money in" reads positive (see BalanceTree.flipSign).
    const sign = carriesForward ? 1 : -1
    const totals = Object.entries(node?.balanceChildren ?? {})
      .map(([currency, amount]) => ({ currency, amount: amount * sign }))
      // USD first so it headlines when the account holds any; the rest by size
      // so a JPY-only or commodity-only account still leads with real money
      // instead of a hollow $0.00.
      .sort((a, b) => {
        if (a.currency === "USD") return -1
        if (b.currency === "USD") return 1
        return Math.abs(b.amount) - Math.abs(a.amount)
      })

    return {
      root,
      kind: carriesForward ? "snapshot" : "cumulative",
      totals,
      asOf,
      found: node !== null,
      isPending: query.isPending,
      isError: query.isError,
    }
  }, [
    account,
    root,
    carriesForward,
    asOf,
    sheet.data,
    statement.data,
    query.isPending,
    query.isError,
  ])
}
