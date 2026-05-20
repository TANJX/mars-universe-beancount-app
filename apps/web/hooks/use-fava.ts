// React Query hooks bound to Fava's JSON API.
// Each hook keys on the user-visible inputs + `mtime` so file edits invalidate
// without us tracking the file watcher manually.

"use client"

import { useQuery } from "@tanstack/react-query"

import { favaFetch, favaQuery, type FavaEnvelope } from "@/lib/fava/client"
import {
  BalanceChartPointSchema,
  BalanceSheetSchema,
  CommoditiesSchema,
  IncomeStatementSchema,
  IntervalChartPointSchema,
  JournalResponseSchema,
  LedgerDataSchema,
  transformTransactions,
} from "@/lib/fava/schemas"
import { z } from "zod"
import { convertTreeNode } from "@/lib/fava/tree"
import { periodToFavaTime } from "@/lib/fava/periods"
import { useUIState } from "@/components/layout/ui-state"
import type { Transaction } from "@/lib/types/beancount"
import type {
  AccountRoot,
  BalanceTreeNode,
  CategoryMonthlyEntry,
  Conversion,
  IncomeStatement,
  MonthlyEntry,
  TrialBalance,
} from "@/lib/types/views"

// ─── Bootstrap ────────────────────────────────────────────────────────────

export function useLedgerData() {
  return useQuery({
    queryKey: ["ledger_data"],
    queryFn: async () => {
      const res = await favaFetch("ledger_data", LedgerDataSchema)
      return res.data
    },
    staleTime: 60_000,
  })
}

// ─── Balance sheet ────────────────────────────────────────────────────────

interface UseBalanceSheetOptions {
  conversion?: Conversion
  /** Override the time= filter; bypasses the period from UIState. */
  timeOverride?: string
  /** Skip the request when false. */
  enabled?: boolean
}

export interface BalanceSheetResult extends TrialBalance {
  /** Net-worth-over-time series, points keyed by interval-end date. */
  charts: { date: string; balance: Record<string, number> }[]
}

export function useBalanceSheet(opts: UseBalanceSheetOptions = {}) {
  const { period, conversion: ctxConversion } = useUIState()
  const conversion = opts.conversion ?? ctxConversion
  const time = opts.timeOverride ?? periodToFavaTime(period)

  return useQuery<BalanceSheetResult>({
    queryKey: ["balance_sheet", time ?? "", conversion],
    enabled: opts.enabled ?? true,
    queryFn: async () => {
      const res = await favaFetch(
        `balance_sheet${favaQuery({ time, conversion })}`,
        BalanceSheetSchema
      )
      const trial = toTrialBalance(res, conversion, [
        "Assets",
        "Liabilities",
        "Equity",
      ])
      // Fava's `charts` mixes time-series ("balances") with hierarchy
      // snapshots ("hierarchy"). We only want the time-series one for the
      // net-worth sparkline; validate just that one's shape.
      const chart = res.data.charts.find(
        (c) => c.type === "balances" && Array.isArray(c.data)
      )
      const points = chart
        ? z.array(BalanceChartPointSchema).safeParse(chart.data)
        : null
      return { ...trial, charts: points?.success ? points.data : [] }
    },
  })
}

// ─── Net-worth time series ────────────────────────────────────────────────

export interface NetWorthSeriesPoint {
  date: string
  net: number
}

/**
 * Pulls Fava's "Net Worth" balances chart with no time filter, so the series
 * spans the full ledger history regardless of the page's selected period.
 * Used by the Balances chart for trend context.
 */
export function useNetWorthSeries() {
  const { conversion } = useUIState()
  return useQuery<NetWorthSeriesPoint[]>({
    queryKey: ["net_worth_series", conversion],
    queryFn: async () => {
      const res = await favaFetch(
        `balance_sheet${favaQuery({ conversion, interval: "month" })}`,
        BalanceSheetSchema
      )
      const chart = res.data.charts.find(
        (c) => c.type === "balances" && Array.isArray(c.data)
      )
      const parsed = chart
        ? z.array(BalanceChartPointSchema).safeParse(chart.data)
        : null
      if (!parsed?.success) return []
      return parsed.data.map((p) => ({
        date: p.date,
        net: p.balance.USD ?? 0,
      }))
    },
    staleTime: 60_000,
  })
}

// ─── Income statement ─────────────────────────────────────────────────────

interface UseIncomeStatementOptions {
  conversion?: Conversion
  interval?: "day" | "week" | "month" | "quarter" | "year"
  /** Override the time= filter; bypasses the period from UIState. */
  timeOverride?: string
}

export function useIncomeStatement(opts: UseIncomeStatementOptions = {}) {
  const { period } = useUIState()
  const conversion = opts.conversion ?? "at_value"
  const interval = opts.interval ?? "month"
  const time = opts.timeOverride ?? periodToFavaTime(period)

  return useQuery({
    queryKey: ["income_statement", time ?? "", conversion, interval],
    queryFn: async () => {
      const res = await favaFetch(
        `income_statement${favaQuery({ time, conversion, interval })}`,
        IncomeStatementSchema
      )
      return toIncomeStatement(res.data)
    },
  })
}

// ─── Journal ──────────────────────────────────────────────────────────────

interface UseJournalOptions {
  /** Fava's account substring filter; we send it directly. */
  account?: string
  /** Free-form Fava advanced filter — escape hatch for unions etc. */
  filter?: string
  /** Override the time= filter; bypasses the period from UIState. */
  timeOverride?: string
  /** When false, suppress the request entirely (React Query `enabled`). */
  enabled?: boolean
}

export function useJournal(opts: UseJournalOptions = {}) {
  const { period } = useUIState()
  const time = opts.timeOverride ?? periodToFavaTime(period)

  return useQuery<Transaction[]>({
    queryKey: ["journal", time ?? "", opts.account ?? "", opts.filter ?? ""],
    enabled: opts.enabled ?? true,
    queryFn: async () => {
      const res = await favaFetch(
        `journal${favaQuery({ time, account: opts.account, filter: opts.filter })}`,
        JournalResponseSchema
      )
      return transformTransactions(res.data)
    },
  })
}

// ─── Commodities (price map) ──────────────────────────────────────────────

export function useCommodities() {
  return useQuery({
    queryKey: ["commodities"],
    queryFn: async () => {
      const res = await favaFetch("commodities", CommoditiesSchema)
      return res.data
    },
    staleTime: 5 * 60_000,
  })
}

// ─── Wire → Layer 2 transformers ──────────────────────────────────────────

function toTrialBalance(
  res: FavaEnvelope<{
    trees: Parameters<typeof convertTreeNode>[0][]
    date_range?: { begin: string; end: string } | null
  }>,
  conversion: Conversion,
  expectedRoots: AccountRoot[]
): TrialBalance {
  const trees: Partial<Record<AccountRoot, BalanceTreeNode>> = {}
  for (const t of res.data.trees) {
    const root = t.account as AccountRoot
    if (expectedRoots.includes(root)) {
      trees[root] = convertTreeNode(t)
    }
  }
  const dateRange = res.data.date_range
    ? { start: res.data.date_range.begin, end: res.data.date_range.end }
    : null
  return { dateRange, conversion, trees }
}

function toIncomeStatement(data: {
  trees: Parameters<typeof convertTreeNode>[0][]
  charts: { type?: string; data: unknown }[]
}): IncomeStatement {
  const incomeWire = data.trees.find((t) => t.account === "Income")
  const expensesWire = data.trees.find((t) => t.account === "Expenses")
  if (!incomeWire || !expensesWire) {
    throw new Error("income_statement response missing Income or Expenses tree")
  }
  const income = convertTreeNode(incomeWire)
  const expenses = convertTreeNode(expensesWire)

  // Find the first chart whose data is an array of points carrying
  // account_balances. Fava ships several charts ("Net Profit", per-category,
  // hierarchy snapshots); only the time-series ones are useful for monthly.
  const monthly: MonthlyEntry[] = []
  const categoryMonthly: CategoryMonthlyEntry[] = []
  for (const chart of data.charts) {
    if (!Array.isArray(chart.data)) continue
    const parsed = z.array(IntervalChartPointSchema).safeParse(chart.data)
    if (!parsed.success) continue
    const points = parsed.data
    if (!points.length || !points[0].account_balances) continue
    for (const point of points) {
      let inc = 0
      let exp = 0
      const incomeBuckets: Record<string, number> = {}
      const expenseBuckets: Record<string, number> = {}
      for (const [account, amounts] of Object.entries(
        point.account_balances ?? {}
      )) {
        const usd = amounts.USD ?? 0
        if (account.startsWith("Income:") || account === "Income") {
          // beancount: income postings are negative; flip for display
          const flipped = -usd
          inc += flipped
          incomeBuckets[account] = (incomeBuckets[account] ?? 0) + flipped
        } else if (account.startsWith("Expenses:") || account === "Expenses") {
          exp += usd
          expenseBuckets[account] = (expenseBuckets[account] ?? 0) + usd
        }
      }
      monthly.push({ month: point.date, income: inc, expense: exp })
      categoryMonthly.push({
        month: point.date,
        income: incomeBuckets,
        expenses: expenseBuckets,
      })
    }
    break
  }

  return { income, expenses, monthly, categoryMonthly }
}
