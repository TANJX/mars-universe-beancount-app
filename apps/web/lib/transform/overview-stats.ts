// Compose Overview's headline stats. Pure: takes already-fetched data sets
// and returns an OverviewStats.
//
// Two distinct sources feed the sparklines:
//   - period-filtered totals (balance_sheet / income_statement) for the
//     headline Net Worth / Income / Expenses numbers
//   - a wider rolling history (`historyNetWorth`, `historyMonthly`) for the
//     sparkline curves, so even on "this month" the sparkline shows trend
//     context instead of a single dot.

import type { Bookmark } from "@/lib/config/types"
import { classifyAll } from "@/lib/transform/classify"
import type { Transaction } from "@/lib/types/beancount"
import type {
  AccountRoot,
  AccountSummary,
  BalanceTreeNode,
  CategoryShare,
  IncomeStatement,
  MonthlyEntry,
  OverviewStats,
  Period,
  SeriesPoint,
  TrialBalance,
} from "@/lib/types/views"

const SERIES_LIMIT = 12
const ZERO_THRESHOLD = 0.005

export interface OverviewInput {
  period: Period
  trial: TrialBalance & {
    charts: { date: string; balance: Record<string, number> }[]
  }
  income: IncomeStatement
  recentTxns: Transaction[]
  bookmarks: Bookmark[]
  /** Rolling net-worth history, period-independent. Last N monthly points. */
  historyNetWorth: { date: string; net: number }[]
  /** Rolling monthly income/expense, period-independent. */
  historyMonthly: MonthlyEntry[]
}

export function composeOverview(input: OverviewInput): OverviewStats {
  const {
    period,
    trial,
    income,
    recentTxns,
    bookmarks,
    historyNetWorth,
    historyMonthly,
  } = input

  // Net worth: subtree balance of Assets + Liabilities (USD).
  const assetsUSD = pickUSD(trial.trees.Assets?.balanceChildren)
  const liabUSD = pickUSD(trial.trees.Liabilities?.balanceChildren)
  const netWorth = assetsUSD + liabUSD

  // Net-worth sparkline: rolling history. Trend over the last N months,
  // independent of the page's selected period. Delta is the latest step
  // in that history.
  const netWorthSeries: SeriesPoint[] = historyNetWorth
    .slice(-SERIES_LIMIT)
    .map((p) => ({ date: p.date, value: p.net }))
  const netWorthDelta =
    netWorthSeries.length >= 2
      ? netWorthSeries[netWorthSeries.length - 1].value -
        netWorthSeries[netWorthSeries.length - 2].value
      : 0
  const prev = netWorthSeries[netWorthSeries.length - 2]?.value ?? 0
  const netWorthPct = prev !== 0 ? (netWorthDelta / Math.abs(prev)) * 100 : 0

  // Income / expenses headline numbers stay period-filtered.
  const incomeTotal = -(income.income.balanceChildren.USD ?? 0)
  const expensesTotal = income.expenses.balanceChildren.USD ?? 0
  // Sparklines come from rolling history.
  const monthlyTrail = historyMonthly.slice(-SERIES_LIMIT)
  const incomeSeries: SeriesPoint[] = monthlyTrail.map((m) => ({
    date: m.month,
    value: m.income,
  }))
  const expensesSeries: SeriesPoint[] = monthlyTrail.map((m) => ({
    date: m.month,
    value: m.expense,
  }))
  const savings = incomeTotal - expensesTotal
  const savingsRate = incomeTotal > 0 ? (savings / incomeTotal) * 100 : 0
  const savingsSeries: SeriesPoint[] = monthlyTrail.map((m) => ({
    date: m.month,
    value: m.income - m.expense,
  }))

  // Top spending categories: walk the expenses tree leaves, sort by
  // absolute USD share.
  const expensesLeaves = collectLeaves(income.expenses)
  const expensesTotalAbs = Math.abs(expensesTotal) || 1
  const topCategories: CategoryShare[] = expensesLeaves
    .map((node) => {
      const amount = node.balanceChildren.USD ?? 0
      return {
        account: node.account,
        segment: stripRoot(node.account),
        amount,
        share: amount / expensesTotalAbs,
      }
    })
    .filter((c) => c.amount > 0)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 6)

  // Active accounts: walk Assets:Checking + Liabilities:Credit children and
  // include any with a non-zero USD balance. Assets render before liabilities,
  // and within each group the largest abs balance comes first.
  const checkingNodes = collectGroupChildren(trial.trees.Assets, "Checking")
  const creditNodes = collectGroupChildren(trial.trees.Liabilities, "Credit")
  const sortByAbsDesc = (a: AccountSummary, b: AccountSummary) =>
    Math.abs(b.balance) - Math.abs(a.balance)
  const checkingActive = checkingNodes
    .map((n) => toAccountSummary(n, "Assets"))
    .filter((a) => Math.abs(a.balance) > ZERO_THRESHOLD)
    .sort(sortByAbsDesc)
  const creditActive = creditNodes
    .map((n) => toAccountSummary(n, "Liabilities"))
    .filter((a) => Math.abs(a.balance) > ZERO_THRESHOLD)
    .sort(sortByAbsDesc)
  const accounts: AccountSummary[] = [...checkingActive, ...creditActive]

  // In-flight accounts: bookmarked clearing/holding accounts (receivable,
  // payable, pending transfers). These sit alongside the main accounts list
  // so the user can see what's mid-settlement.
  const inFlight: AccountSummary[] = []
  for (const b of bookmarks) {
    const tree = trial.trees[b.root]
    const node = tree ? findNode(tree, b.accountPath) : null
    if (!node) continue
    inFlight.push({
      account: b.accountPath,
      root: b.root,
      segment: node.segment,
      displayName: b.label,
      balance: pickUSD(node.balanceChildren),
      delta: 0, // TODO: requires prior-period balance fetch
    })
  }

  // Recent activity: classify all rows in date desc; the page slices to a
  // display limit. Forecast rows are surfaced inline.
  const sorted = [...recentTxns].sort((a, b) => b.date.localeCompare(a.date))
  const recent = classifyAll(sorted)

  return {
    period,
    netWorth,
    netWorthDelta,
    netWorthPct,
    netWorthSeries,
    income: incomeTotal,
    incomeSeries,
    expenses: expensesTotal,
    expensesSeries,
    savings,
    savingsRate,
    savingsSeries,
    recent,
    topCategories,
    accounts,
    inFlight,
  }
}

function collectGroupChildren(
  root: BalanceTreeNode | undefined,
  groupSegment: string
): BalanceTreeNode[] {
  if (!root) return []
  const group = root.children.find((c) => c.segment === groupSegment)
  return group?.children ?? []
}

function toAccountSummary(
  node: BalanceTreeNode,
  root: AccountRoot
): AccountSummary {
  return {
    account: node.account,
    root,
    segment: node.segment,
    balance: pickUSD(node.balanceChildren),
    delta: 0, // TODO: requires prior-period balance fetch
  }
}

function pickUSD(inv?: Record<string, number>): number {
  return inv?.USD ?? 0
}

function collectLeaves(node: BalanceTreeNode): BalanceTreeNode[] {
  if (!node.children?.length) return [node]
  const out: BalanceTreeNode[] = []
  for (const c of node.children) {
    out.push(...collectLeaves(c))
  }
  return out
}

function findNode(node: BalanceTreeNode, path: string): BalanceTreeNode | null {
  if (node.account === path) return node
  for (const c of node.children) {
    const hit = findNode(c, path)
    if (hit) return hit
  }
  return null
}

function stripRoot(account: string): string {
  const idx = account.indexOf(":")
  return idx >= 0 ? account.slice(idx + 1) : account
}

// Re-export so callers can import the AccountRoot type once the file is in
// the import graph (saves an extra import line).
export type { AccountRoot }
