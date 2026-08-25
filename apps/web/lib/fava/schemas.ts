// Zod schemas for Fava's JSON wire format.
// Kept permissive (`.loose()` on unknown fields) so we don't break on
// fields Fava adds in newer versions that we don't read.

import { z } from "zod"
import { parseAmount, postingToUSD } from "@/lib/transform/parse-amount"
import type {
  Posting as DomainPosting,
  Transaction as DomainTransaction,
} from "@/lib/types/beancount"

// ─── Wire shapes ──────────────────────────────────────────────────────────

const WirePostingSchema = z
  .object({
    account: z.string(),
    amount: z.string(),
    meta: z.record(z.string(), z.unknown()).optional(),
  })
  .loose()

const WireTransactionSchema = z
  .object({
    t: z.literal("Transaction"),
    entry_hash: z.string(),
    date: z.string(),
    flag: z.string(),
    payee: z
      .string()
      .nullable()
      .optional()
      .transform((v) => v ?? ""),
    narration: z
      .string()
      .nullable()
      .optional()
      .transform((v) => v ?? ""),
    tags: z.array(z.string()).default([]),
    links: z.array(z.string()).default([]),
    meta: z.record(z.string(), z.unknown()).default({}),
    postings: z.array(WirePostingSchema),
  })
  .loose()

// /api/journal returns mixed entries; we only model Transaction. Other
// directives (Open, Close, Balance, Price, Pad, Note, Document, Custom)
// are filtered out at the boundary.
const WireJournalEntrySchema = z.object({ t: z.string() }).loose()

export const JournalResponseSchema = z.array(WireJournalEntrySchema)

// ─── Tree shapes (balance_sheet / income_statement) ───────────────────────

const CurrencyAmountSchema = z.record(z.string(), z.number())

export interface SerialisedTreeNode {
  account: string
  balance: Record<string, number>
  balance_children: Record<string, number>
  children: SerialisedTreeNode[]
  has_txns: boolean
  // Fava sends `null` (not omits) for these when the requested conversion
  // doesn't produce a cost figure for a node — accept null and undefined.
  cost?: Record<string, number> | null
  cost_children?: Record<string, number> | null
}

export const TreeNodeSchema: z.ZodType<SerialisedTreeNode> = z.lazy(
  () =>
    z
      .object({
        account: z.string(),
        balance: CurrencyAmountSchema,
        balance_children: CurrencyAmountSchema,
        children: z.array(TreeNodeSchema),
        has_txns: z.boolean(),
        cost: CurrencyAmountSchema.nullish(),
        cost_children: CurrencyAmountSchema.nullish(),
      })
      .loose() as z.ZodType<SerialisedTreeNode>
)

const DateRangeSchema = z
  .object({ begin: z.string(), end: z.string() })
  .nullable()

// Fava's `charts` array is heterogeneous: a "balances" time-series (data is
// a flat array of {date, balance}) sits alongside "hierarchy" snapshots
// (data is a tree node object). We don't enforce the inner shape here —
// `useBalanceSheet` filters by chart `type` and validates the right one.
const BalanceChartSchema = z
  .object({
    label: z.string().optional(),
    type: z.string().optional(),
    data: z.unknown(),
  })
  .loose()

export const BalanceChartPointSchema = z
  .object({
    date: z.string(),
    balance: CurrencyAmountSchema,
  })
  .loose()

export const BalanceSheetSchema = z
  .object({
    trees: z.array(TreeNodeSchema),
    charts: z.array(BalanceChartSchema).default([]),
    date_range: DateRangeSchema.optional(),
  })
  .loose()

// Same heterogeneity story as balance_sheet: bar/balance time-series have
// data:array, hierarchy snapshots have data:object. Validate inner shape on
// the consumer side after filtering by `type`.
export const IntervalChartPointSchema = z
  .object({
    date: z.string(),
    balance: CurrencyAmountSchema,
    account_balances: z
      .record(z.string(), CurrencyAmountSchema)
      .optional()
      .default({}),
  })
  .loose()

const IntervalChartSchema = z
  .object({
    label: z.string().optional(),
    type: z.string().optional(),
    data: z.unknown(),
  })
  .loose()

export const IncomeStatementSchema = z
  .object({
    trees: z.array(TreeNodeSchema),
    charts: z.array(IntervalChartSchema).default([]),
    date_range: DateRangeSchema.optional(),
  })
  .loose()

// ─── Bootstrap ────────────────────────────────────────────────────────────

export const LedgerDataSchema = z
  .object({
    accounts: z.array(z.string()).optional().default([]),
    currencies: z.array(z.string()).optional().default([]),
    errors: z.array(z.unknown()).optional().default([]),
  })
  .loose()

export const CommoditiesSchema = z.array(z.unknown()) // shape varies; we don't validate inner

// ─── Wire → Domain transformers ───────────────────────────────────────────

function transformPosting(
  wire: z.infer<typeof WirePostingSchema>
): DomainPosting | null {
  const parsed = parseAmount(wire.amount)
  if (!parsed) {
    // Implicit balancing leg — Fava normally evaluates these before
    // serialising, so we shouldn't see one. If we do, drop the posting; the
    // sum-to-zero invariant is no longer recoverable from the wire shape.
    return null
  }
  return {
    account: wire.account,
    amount: parsed.amount,
    cost: parsed.cost,
    price: parsed.price,
    meta: wire.meta,
  }
}

// Fava synthesises pseudo-transactions with these flags when serving a
// time-filtered journal: 'S' = opening-balance summarisation, 'C' = conversion
// balancing leg. They are artifacts of the requested date range, not ledger
// entries — drop them so they don't pollute Recent Activity, the Journal page,
// or date-range views. (Their amounts are still read, separately, by
// `extractOpeningBalances` below — dropping them from the row list is not the
// same as discarding the opening balance they carry.)
//
// Flag 'P' is deliberately NOT in this set: Beancount materialises it at load
// time from a `pad` directive and it genuinely moves the account balance (e.g.
// the -38,681.86 USD opening pad on Liabilities:Loan:Tesla). Dropping it made
// the journal's running total disagree with fava's account balance. Inside a
// time-filtered range the pad is folded into the 'S' entry above, so keeping it
// here can't double-count.
const FAVA_SYNTHETIC_FLAGS = new Set(["S", "C"])

export function transformTransactions(
  entries: z.infer<typeof JournalResponseSchema>
): DomainTransaction[] {
  const out: DomainTransaction[] = []
  for (const e of entries) {
    if (e.t !== "Transaction") continue
    const tx = WireTransactionSchema.parse(e)
    if (FAVA_SYNTHETIC_FLAGS.has(tx.flag)) continue
    const postings: DomainPosting[] = []
    for (const wp of tx.postings) {
      const p = transformPosting(wp)
      if (p) postings.push(p)
    }
    out.push({
      id: tx.entry_hash,
      date: tx.date,
      flag: tx.flag,
      payee: tx.payee,
      narration: tx.narration,
      tags: tx.tags,
      links: tx.links,
      meta: tx.meta,
      postings,
    })
  }
  return out
}

/**
 * USD opening balance per account, read off the flag-'S' summarisation
 * entries Fava prepends to a time-filtered journal.
 *
 * Fava applies `filter=` *before* summarising, so these amounts are the
 * pre-period balance of the **filtered** entry set. That makes them the only
 * filter-aware opening balance on offer: `/api/balance_sheet` accepts no
 * `filter=`, so a link/tag/payee narrowing can't be expressed there at all.
 *
 * Two properties worth knowing before consuming this:
 *   - Accounts Fava sweeps into retained earnings at the boundary (Income,
 *     Expenses) get no 'S' entry, so they're simply absent → seed 0.
 *   - Lot postings ("2.654 MINJX {45.44 USD, 2025-11-07}") carry a cost but
 *     no price, so they value at *cost basis*, not market value. Prefer the
 *     balance-sheet snapshot when an at-value figure matters and no filter
 *     is in play.
 */
export function extractOpeningBalances(
  entries: z.infer<typeof JournalResponseSchema>
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const e of entries) {
    if (e.t !== "Transaction") continue
    const tx = WireTransactionSchema.parse(e)
    if (tx.flag !== "S") continue
    for (const wp of tx.postings) {
      const p = transformPosting(wp)
      if (!p) continue
      out[p.account] = (out[p.account] ?? 0) + postingToUSD(p)
    }
  }
  return out
}
