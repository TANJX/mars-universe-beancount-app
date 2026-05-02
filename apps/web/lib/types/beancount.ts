// Layer 1 — Beancount-faithful core types.
// These match Fava's wire format (post-parse). Every view in the app derives
// from this type. See docs/plans/2026-04-24-data-model-redesign.md §4.

export type AccountPath = string
export type Currency = string

export interface Amount {
  number: number
  currency: Currency
}

export interface Cost {
  number: number
  currency: Currency
  date?: string
  label?: string
}

export interface Price {
  number: number
  currency: Currency
}

export interface Posting {
  account: AccountPath
  amount: Amount
  cost?: Cost
  price?: Price
  meta?: Record<string, unknown>
}

export type DirectiveFlag = "*" | "!" | "P" | "txn" | string

export interface Transaction {
  id: string
  date: string
  flag: DirectiveFlag
  payee: string
  narration: string
  tags: string[]
  links: string[]
  meta: Record<string, unknown>
  postings: Posting[]
}
