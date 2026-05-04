// Layer 2 — UI projection types. Derived from Layer 1 (`./beancount.ts`).
// See docs/plans/2026-04-24-data-model-redesign.md §4.

import type { AccountPath, Currency, Posting, Transaction } from "./beancount"

export type AccountRoot =
  | "Assets"
  | "Liabilities"
  | "Equity"
  | "Income"
  | "Expenses"

export type TransactionClass =
  | "expense"
  | "income"
  | "transfer"
  | "split"
  | "investment"
  | "complex"

export interface JournalRow {
  txn: Transaction
  class: TransactionClass

  /** The account the user perceives money came from / went to. */
  primary: Posting | null

  /** The "category" leg — usually unique E or I leg. Null for transfers. */
  category: Posting | null

  /** The other A/L leg for transfers. */
  counterparty: Posting | null

  /** Remaining postings (visible in detail sheet). */
  others: Posting[]

  /** User-perspective signed amount in primary's native currency. */
  signedAmount: number
  signedCurrency: Currency

  /** Converted to base currency (USD) for sorting/totaling. */
  baseAmount: number
  baseCurrency: "USD"

  /** Display flags. */
  isMultiCurrency: boolean
  hasInvestmentLot: boolean
  hasFxPrice: boolean
  isForecast: boolean
  isComplex: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree types — mirror Fava's SerialisedTreeNode 1:1.

export type CurrencyAmount = Record<Currency, number>

export interface BalanceTreeNode {
  account: AccountPath
  segment: string
  balance: CurrencyAmount
  balanceChildren: CurrencyAmount
  cost?: CurrencyAmount
  costChildren?: CurrencyAmount
  hasTxns: boolean
  children: BalanceTreeNode[]
}

export interface TrialBalance {
  dateRange: { start: string; end: string } | null
  conversion: "at_cost" | "at_value"
  /** Up to 5 root trees. /balances uses all 5; /balance_sheet uses only A/L/E. */
  trees: Partial<Record<AccountRoot, BalanceTreeNode>>
}

// ─────────────────────────────────────────────────────────────────────────────
// Income statement specifics.

/**
 * Per-bucket category breakdown. Keys are the full leaf account path
 * (e.g., `Expenses:Food:Restaurant`, `Income:Salary:Acme`).
 * Values are USD totals already sign-flipped so income > 0 reads as inflow.
 */
export interface CategoryMonthlyEntry {
  month: string
  income: Record<AccountPath, number>
  expenses: Record<AccountPath, number>
}

export interface MonthlyEntry {
  month: string
  income: number
  expense: number
}

export interface IncomeStatement {
  income: BalanceTreeNode
  expenses: BalanceTreeNode
  monthly: MonthlyEntry[]
  categoryMonthly: CategoryMonthlyEntry[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Overview-page composed view.

export interface CategoryShare {
  account: AccountPath
  segment: string
  amount: number
  share: number
}

export interface AccountSummary {
  account: AccountPath
  root: AccountRoot
  segment: string
  /** Display name override (e.g., "Chase Checking" instead of "Chase"). */
  displayName?: string
  balance: number
  delta: number
  /** Native currency sub-line (e.g., "¥3,602"). */
  sub?: string
}

export interface SeriesPoint {
  /** ISO date label for tooltip / x-axis. */
  date: string
  value: number
}

export interface OverviewStats {
  period: Period
  netWorth: number
  netWorthDelta: number
  netWorthPct: number
  netWorthSeries: SeriesPoint[]
  income: number
  incomeSeries: SeriesPoint[]
  expenses: number
  expensesSeries: SeriesPoint[]
  savings: number
  savingsRate: number
  savingsSeries: SeriesPoint[]
  recent: JournalRow[]
  topCategories: CategoryShare[]
  accounts: AccountSummary[]
  inFlight: AccountSummary[]
}

// ─────────────────────────────────────────────────────────────────────────────
// UI state types.

export type PeriodPresetId =
  | "mtd"
  | "this-month"
  | "last-month"
  | "qtd"
  | "ytd"
  | "last-12"
  | "custom"

export interface Period {
  id: PeriodPresetId
  label: string
  range: string
  /** Set when id === "custom". ISO YYYY-MM-DD. */
  from?: string
  /** Set when id === "custom". ISO YYYY-MM-DD. */
  to?: string
}

/** Time-bucket size for chart series. */
export type Granularity = "day" | "week" | "month" | "quarter" | "year"

export type Density = "compact" | "comfortable"

/** Balance-sheet valuation method: original cost vs. current market value. */
export type Conversion = "at_cost" | "at_value"
