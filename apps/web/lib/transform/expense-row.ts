// Curated Expenses-page projection. Sits on top of the generic classifier and
// adds the funding/share/category split that the Expenses row needs.
// Inclusion rule: any transaction with an Expenses:* posting. Reimbursable
// receivables (Assets:Receivable:*:Expensify) are *not* expenses — they're
// pending assets — and would double-count once the actual Expenses leg posts.

import { accountRoot, accountSegment, classify } from "@/lib/transform/classify"
import { postingToUSD } from "@/lib/transform/parse-amount"
import type { AccountPath, Posting, Transaction } from "@/lib/types/beancount"
import type { JournalRow } from "@/lib/types/views"

export interface ExpenseRowData {
  row: JournalRow
  /** Expense category — last segment of the dominant Expenses leg, or "—".
   * Use the consumer's display-name hook (`useDisplayAccount`) to resolve
   * user overrides; this field is the no-config fallback. */
  category: string
  /** Full account path of the dominant Expenses leg (or null). Lets the
   * consumer apply config-aware display-name lookups. */
  categoryAccount: AccountPath | null
  /** Funding account label (e.g., "Amex-Gold", "Suica", "Expensify receivable"). */
  fundingAccount: string
  /** Funding posting's currency, used to drive the FX native display. */
  fundingCurrency: string
  /** Funding posting's signed amount, in fundingCurrency (or receivable amount). */
  nativeAmount: number
  /** USD: total bill the user paid out (split context, otherwise = share). */
  totalPaid: number
  /** USD: user's share = sum of Expenses postings (USD-equiv). */
  share: number
  hasFxPrice: boolean
  /** 4+ legs OR has an Income leg (e.g., expense + rebate). */
  isComplex: boolean
  /** Root for the AccountDot before the funding label. */
  fundingRoot: "Assets" | "Liabilities" | "Equity" | "Income" | "Expenses"
}

export function deriveExpenseRow(txn: Transaction): ExpenseRowData | null {
  const ePostings = txn.postings.filter(
    (p) => accountRoot(p.account) === "Expenses"
  )
  if (ePostings.length === 0) return null

  const row = classify(txn)
  const share = ePostings.reduce((s, p) => s + postingToUSD(p), 0)

  // Funding = Liabilities or non-Receivable / non-Investment Asset postings.
  const funding = txn.postings.filter((p) => {
    const r = accountRoot(p.account)
    if (r === "Liabilities" && !p.account.includes(":Payable")) return true
    if (
      r === "Assets" &&
      !p.account.includes(":Receivable") &&
      !p.account.includes(":Investment")
    )
      return true
    return false
  })
  const totalPaid = Math.abs(
    funding.reduce((s, p) => s + (p.amount.number < 0 ? p.amount.number : 0), 0)
  )
  const fundingPosting =
    funding.find((p) => p.amount.number < 0) ?? funding[0] ?? null

  // Fall back to a Payable leg (Pattern F: family expense paid out of payable)
  // when no card / cash leg is present.
  const fallbackPayable = txn.postings.find(
    (p) =>
      accountRoot(p.account) === "Liabilities" && p.account.includes(":Payable")
  )
  const effectiveFunding = fundingPosting ?? fallbackPayable ?? null

  const fundingAccount = effectiveFunding
    ? accountSegment(effectiveFunding.account)
    : "—"
  const fundingCurrency = effectiveFunding?.amount.currency ?? "USD"
  const nativeAmount = effectiveFunding?.amount.number ?? -share
  const fundingRoot = effectiveFunding
    ? accountRoot(effectiveFunding.account)
    : "Assets"

  const dominantE = ePostings.reduce<Posting | null>((best, p) => {
    if (!best) return p
    return Math.abs(postingToUSD(p)) > Math.abs(postingToUSD(best)) ? p : best
  }, null)
  const category = dominantE ? accountSegment(dominantE.account) : "—"
  const categoryAccount = dominantE?.account ?? null

  const hasFxPrice = txn.postings.some((p) => p.price !== undefined)
  const incomeLegs = txn.postings.filter(
    (p) => accountRoot(p.account) === "Income"
  )
  const isComplex = txn.postings.length > 3 || incomeLegs.length > 0

  return {
    row,
    category,
    categoryAccount,
    fundingAccount,
    fundingCurrency,
    nativeAmount,
    totalPaid,
    share,
    hasFxPrice,
    isComplex,
    fundingRoot,
  }
}

export function deriveExpenseRows(txns: Transaction[]): ExpenseRowData[] {
  return txns
    .map(deriveExpenseRow)
    .filter((r): r is ExpenseRowData => r !== null)
    .sort((a, b) => b.row.txn.date.localeCompare(a.row.txn.date))
}
