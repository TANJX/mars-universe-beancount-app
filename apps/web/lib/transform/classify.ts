// Pure classifier turning a Beancount Transaction into a UI JournalRow.
// Rules grounded in real journal patterns — see
// docs/plans/2026-04-24-data-model-redesign.md §5.

import type { Posting, Transaction } from "@/lib/types/beancount"
import type {
  AccountRoot,
  JournalRow,
  TransactionClass,
} from "@/lib/types/views"

export function accountRoot(account: string): AccountRoot {
  const root = account.split(":")[0]
  if (
    root === "Assets" ||
    root === "Liabilities" ||
    root === "Equity" ||
    root === "Income" ||
    root === "Expenses"
  ) {
    return root
  }
  return "Equity"
}

export function accountSegment(account: string): string {
  return account.split(":").pop() ?? account
}

/** Path with the root stripped — e.g. "Assets:Checking:Chase" → "Checking:Chase". */
export function accountTail(account: string): string {
  const parts = account.split(":")
  return parts.length > 1 ? parts.slice(1).join(":") : account
}

/**
 * Hierarchical (subtree) account match. `Expenses` matches every `Expenses:*`;
 * `Assets:Checking:Chase` matches only itself and its descendants. Empty
 * filter matches every account.
 */
export function accountMatches(account: string, filter: string): boolean {
  if (!filter) return true
  if (account === filter) return true
  return account.startsWith(`${filter}:`)
}

interface RootBuckets {
  assets: Posting[]
  liabilities: Posting[]
  income: Posting[]
  expenses: Posting[]
  equity: Posting[]
  receivables: Posting[]
  payables: Posting[]
}

function bucket(postings: Posting[]): RootBuckets {
  const out: RootBuckets = {
    assets: [],
    liabilities: [],
    income: [],
    expenses: [],
    equity: [],
    receivables: [],
    payables: [],
  }
  for (const p of postings) {
    const root = accountRoot(p.account)
    if (root === "Assets") {
      out.assets.push(p)
      if (p.account.includes(":Receivable")) out.receivables.push(p)
    } else if (root === "Liabilities") {
      out.liabilities.push(p)
      if (p.account.includes(":Payable")) out.payables.push(p)
    } else if (root === "Income") {
      out.income.push(p)
    } else if (root === "Expenses") {
      out.expenses.push(p)
    } else if (root === "Equity") {
      out.equity.push(p)
    }
  }
  return out
}

function classifyClass(
  txn: Transaction,
  b: RootBuckets,
  hasInvestmentLot: boolean
): TransactionClass {
  const len = txn.postings.length
  const al = b.assets.length + b.liabilities.length
  const hasE = b.expenses.length > 0
  // Rebate legs are cosmetic — they don't make a transfer stop being a
  // transfer. Exclude them from hasI so a contribution-with-match still
  // classifies as transfer, an expense-with-promo still as expense, etc.
  const hasRebate = b.income.some((p) =>
    accountMatches(p.account, "Income:Rebate")
  )
  const hasI = b.income.some(
    (p) => !accountMatches(p.account, "Income:Rebate")
  )

  if (hasInvestmentLot) return "investment"

  // Pure rebate: free money lands in a single account (card cashback,
  // gift-card credit). When another A/L leg or an expense is present, the
  // rebate is auxiliary and the txn classifies by its underlying shape.
  if (hasRebate && !hasE && !hasI && al <= 1) return "rebate"

  // Rule 5-7: 2-leg simple cases
  if (len === 2) {
    if (al >= 1 && hasE) return "expense"
    if (al >= 1 && hasI) return "income"
    if (al === 2 && !hasE && !hasI) return "transfer"
  }

  // Rule 8: split — 3+ legs with E + receivable/payable
  if (len >= 3 && hasE && (b.receivables.length > 0 || b.payables.length > 0)) {
    return "split"
  }

  // Rule 9-11: 3+ legs by dominant root
  if (hasE) return "expense"
  if (hasI) return "income"
  if (al >= 2 && !hasE && !hasI) return "transfer"

  return "complex"
}

function pickPrimaryCategoryCounterparty(
  cls: TransactionClass,
  postings: Posting[],
  b: RootBuckets
): {
  primary: Posting | null
  category: Posting | null
  counterparty: Posting | null
} {
  const al = [...b.assets, ...b.liabilities]
  const sortByAbs = (xs: Posting[]) =>
    [...xs].sort(
      (a, b) => Math.abs(b.amount.number) - Math.abs(a.amount.number)
    )

  switch (cls) {
    case "expense": {
      const negAL = al.filter((p) => p.amount.number < 0)
      const primary = sortByAbs(negAL.length ? negAL : al)[0] ?? null
      const category = sortByAbs(b.expenses)[0] ?? null
      return { primary, category, counterparty: null }
    }
    case "income":
    case "rebate": {
      const posAL = al.filter((p) => p.amount.number > 0)
      const primary = sortByAbs(posAL.length ? posAL : al)[0] ?? null
      const category = sortByAbs(b.income)[0] ?? null
      return { primary, category, counterparty: null }
    }
    case "transfer": {
      const sorted = [...al].sort((a, b) => a.amount.number - b.amount.number)
      const primary = sorted[0] ?? null
      const counterparty = sorted[sorted.length - 1] ?? null
      return { primary, category: null, counterparty }
    }
    case "split": {
      const nonReceivableAL = al.filter(
        (p) =>
          !p.account.includes(":Receivable") && !p.account.includes(":Payable")
      )
      const primary =
        sortByAbs(nonReceivableAL.length ? nonReceivableAL : al)[0] ?? null
      const category = sortByAbs(b.expenses)[0] ?? null
      return { primary, category, counterparty: null }
    }
    case "investment": {
      const cashLeg =
        al.find((p) => p.amount.currency === "USD" && p.cost === undefined) ??
        null
      const lotLeg = postings.find((p) => p.cost !== undefined) ?? null
      return { primary: cashLeg, category: lotLeg, counterparty: null }
    }
    case "complex":
    default: {
      const sorted = sortByAbs(postings)
      return { primary: sorted[0] ?? null, category: null, counterparty: null }
    }
  }
}

interface ClassifyOptions {
  baseCurrency?: "USD"
}

export function classify(
  txn: Transaction,
  opts: ClassifyOptions = {}
): JournalRow {
  const baseCurrency = opts.baseCurrency ?? "USD"
  const b = bucket(txn.postings)

  const hasInvestmentLot = txn.postings.some((p) => p.cost !== undefined)
  const hasFxPrice = txn.postings.some((p) => p.price !== undefined)
  const isMultiCurrency =
    new Set(txn.postings.map((p) => p.amount.currency)).size > 1
  const isForecast = txn.flag === "!"

  const cls = classifyClass(txn, b, hasInvestmentLot)
  const { primary, category, counterparty } = pickPrimaryCategoryCounterparty(
    cls,
    txn.postings,
    b
  )

  const others = txn.postings.filter(
    (p) => p !== primary && p !== category && p !== counterparty
  )

  // Signed amount: from user's perspective on `primary`. Wire sign already
  // matches the user's perspective for both Asset and Liability (a CC charge
  // shows as negative on the liability — money "out").
  let signedAmount = 0
  let signedCurrency: string = baseCurrency
  if (primary) {
    signedAmount = primary.amount.number
    signedCurrency = primary.amount.currency
  }

  // Base currency conversion. Three sources, in priority:
  //   1. primary itself is USD → use signedAmount
  //   2. primary has price spec @ USD → convert
  //   3. find a USD-denominated posting elsewhere; use its absolute value with
  //      the primary's sign direction (covers FX patterns like Suica)
  let baseAmount = signedAmount
  if (signedCurrency !== baseCurrency) {
    if (primary?.price?.currency === baseCurrency) {
      baseAmount = primary.amount.number * primary.price.number
    } else {
      const usdLeg = txn.postings.find(
        (p) => p.amount.currency === baseCurrency && p !== primary
      )
      if (usdLeg) {
        const sign = signedAmount < 0 ? -1 : 1
        baseAmount = sign * Math.abs(usdLeg.amount.number)
      }
    }
  }

  return {
    txn,
    class: cls,
    primary,
    category,
    counterparty,
    others,
    signedAmount,
    signedCurrency,
    baseAmount,
    baseCurrency,
    isMultiCurrency,
    hasInvestmentLot,
    hasFxPrice,
    isForecast,
    isComplex: txn.postings.length > 4,
  }
}

export function classifyAll(
  txns: Transaction[],
  opts: ClassifyOptions = {}
): JournalRow[] {
  return txns.map((t) => classify(t, opts))
}
