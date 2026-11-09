// The one place sleeve order, labels and colors are defined. The chart,
// legend, tooltip, table headers and explainer all read from here.

import type { MonthRow, SleeveKey } from "./types"

/** Sleeves as charted. "other" folds the HSA and anything held flat (a
 * ninth hue would be a generated color; it gets a neutral instead). */
export type SleeveId =
  | "other"
  | "checking"
  | "ef"
  | "reserve"
  | "core"
  | "ira"
  | "gold"
  | "k401"
  | "play"

export interface SleeveDef {
  id: SleeveId
  label: string
  short: string
  /** CSS custom property carrying the sleeve's color. */
  token: string
  /** Step in the "where the money goes" walk-through (flow order). */
  flow: number
}

/** Stack order, bottom to top: cash-like at the base, play on top so its
 * share reads at the edge. */
export const SLEEVES: SleeveDef[] = [
  {
    id: "other",
    label: "HSA and other",
    short: "Other",
    token: "--sleeve-other",
    flow: 9,
  },
  {
    id: "checking",
    label: "Checking buffer",
    short: "Checking",
    token: "--sleeve-checking",
    flow: 1,
  },
  {
    id: "ef",
    label: "Emergency fund",
    short: "Emergency",
    token: "--sleeve-ef",
    flow: 2,
  },
  {
    id: "reserve",
    label: "Reserve",
    short: "Reserve",
    token: "--sleeve-reserve",
    flow: 3,
  },
  {
    id: "core",
    label: "Core index",
    short: "Core",
    token: "--sleeve-core",
    flow: 4,
  },
  { id: "ira", label: "IRA", short: "IRA", token: "--sleeve-ira", flow: 5 },
  { id: "gold", label: "Gold", short: "Gold", token: "--sleeve-gold", flow: 8 },
  { id: "k401", label: "401k", short: "401k", token: "--sleeve-k401", flow: 6 },
  {
    id: "play",
    label: "Play sleeve",
    short: "Play",
    token: "--sleeve-play",
    flow: 7,
  },
]

export const SLEEVE_BY_ID = Object.fromEntries(
  SLEEVES.map((s) => [s.id, s])
) as Record<SleeveId, SleeveDef>

export function sleeveValue(row: MonthRow, id: SleeveId): number {
  return id === "other" ? row.hsa + row.other : row[id]
}

/** Whether a sleeve ever holds money in this run (empty ones stay out of the
 * legend and tooltip). */
export function sleeveUsed(rows: MonthRow[], id: SleeveId): boolean {
  return rows.some((r) => Math.abs(sleeveValue(r, id)) >= 0.5)
}

/** Generic copy for the explainer. A person file can override any of it
 * with private wording (fund names, an earmark's name). */
export const SLEEVE_TEXT: Record<SleeveId, { title: string; body: string }> = {
  checking: {
    title: "Checking buffer",
    body: "Pays daily spending. Pay lands here; anything above the buffer moves on, and the reserve tops it up when pay falls short.",
  },
  ef: {
    title: "Emergency fund",
    body: "A set number of months of spending in a high-yield savings account. Refilled from the reserve, touched only if the reserve runs dry.",
  },
  reserve: {
    title: "Reserve",
    body: "Short-term Treasuries or cash. Holds the earmarks plus the next 12 months of shortfall; anything above that moves into the core.",
  },
  core: {
    title: "Core index",
    body: "Broad index funds in a taxable account. Receives the reserve's excess, spread over a set number of months.",
  },
  ira: {
    title: "IRA",
    body: "One deposit each year, paid from cash in the deposit month.",
  },
  k401: {
    title: "401k",
    body: "Payroll deferrals and the employer match. Unvested match is lost if the job ends before the vesting date.",
  },
  play: {
    title: "Play sleeve",
    body: "Single stocks and other bets. No new money while it is above its cap; it only grows or shrinks with the market.",
  },
  gold: {
    title: "Gold",
    body: "A small hedge, held as is. No new money in this plan.",
  },
  other: {
    title: "HSA and other",
    body: "HSA contributions taken from pay, plus balances held flat (receivables, gift cards).",
  },
}

export const NOT_MODELED_DEFAULT: string[] = [
  "Market swings: returns are smooth averages, so a bad year lowers the invested sleeves while the cash plan stays the same.",
  "Taxes on the taxable sleeves (dividends, realized gains) and the yearly return's true-up beyond the one-off bills listed.",
  "Bonuses, equity grants and side income.",
  "Selling play-sleeve positions to bring it under its cap.",
  "Card rewards, refunds and irregular spending beyond the monthly average.",
]

/** Map an engine sleeve key to its charted sleeve. */
export function chartSleeveOf(k: SleeveKey): SleeveId {
  return k === "hsa" ? "other" : k
}
