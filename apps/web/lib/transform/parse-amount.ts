// Parser for Fava's `Posting.amount` strings.
// Encodings observed in the live ledger:
//   "123.45 USD"                                  — plain
//   "-519 JPY"                                    — plain, signed
//   "0.12 SCHG {33.14 USD}"                       — units + cost
//   "0.12 SCHG {33.14 USD, 2025-12-27}"           — units + cost + lot date
//   "0.12 SCHG {33.14 USD, \"label\"}"            — units + cost + lot label (rare)
//   "5 USD @ 140 JPY"                             — units + unit price
//   "5 USD @@ 700 JPY"                            — units + total price (we normalize to per-unit)
//   ""                                            — implicit balancing leg → returns null
//
// Unrecognized input throws so we surface schema drift loudly during integration.

import type { Amount, Cost, Price } from "@/lib/types/beancount"

export interface ParsedAmount {
  amount: Amount
  cost?: Cost
  price?: Price
}

const NUM = String.raw`-?\d[\d_]*(?:\.\d+)?`
const CCY = String.raw`[A-Z][A-Z0-9._-]*`

const COST_RE = new RegExp(
  String.raw`\{\s*(${NUM})\s+(${CCY})(?:\s*,\s*(\d{4}-\d{2}-\d{2}))?(?:\s*,\s*"([^"]*)")?\s*\}`
)
const PRICE_TOTAL_RE = new RegExp(String.raw`@@\s*(${NUM})\s+(${CCY})`)
const PRICE_UNIT_RE = new RegExp(String.raw`(?<!@)@\s*(${NUM})\s+(${CCY})`)
const HEAD_RE = new RegExp(String.raw`^\s*(${NUM})\s+(${CCY})`)

export function parseAmount(input: string): ParsedAmount | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  let working = trimmed

  // Cost in braces (strip first; doesn't interact with the leading amount).
  let cost: Cost | undefined
  const costMatch = working.match(COST_RE)
  if (costMatch) {
    cost = {
      number: parseNumber(costMatch[1]),
      currency: costMatch[2],
    }
    if (costMatch[3]) cost.date = costMatch[3]
    if (costMatch[4]) cost.label = costMatch[4]
    working = working.replace(COST_RE, " ").trim()
  }

  // Total price (`@@`) before unit price (`@`) — total form needs the head
  // amount to normalize, so we capture it before stripping.
  let price: Price | undefined
  const totalMatch = working.match(PRICE_TOTAL_RE)
  if (totalMatch) {
    const head = working.match(HEAD_RE)
    const units = head ? parseNumber(head[1]) : 0
    const total = parseNumber(totalMatch[1])
    price = {
      number: units !== 0 ? total / Math.abs(units) : total,
      currency: totalMatch[2],
    }
    working = working.replace(PRICE_TOTAL_RE, " ").trim()
  } else {
    const unitMatch = working.match(PRICE_UNIT_RE)
    if (unitMatch) {
      price = { number: parseNumber(unitMatch[1]), currency: unitMatch[2] }
      working = working.replace(PRICE_UNIT_RE, " ").trim()
    }
  }

  // Whatever is left should be `<number> <currency>`.
  const head = working.match(HEAD_RE)
  if (!head) {
    throw new Error(
      `parseAmount: cannot parse "${input}" (residual "${working}")`
    )
  }
  const amount: Amount = {
    number: parseNumber(head[1]),
    currency: head[2],
  }
  return { amount, cost, price }
}

function parseNumber(s: string): number {
  // Beancount allows underscores as digit grouping; strip before parseFloat.
  return parseFloat(s.replace(/_/g, ""))
}
