// The one place sleeve order, labels and colors are defined. The chart,
// legend, tooltip, table headers and explainer all read from here.

import type { MonthRow } from "./types"

/** Sleeves as charted. "other" is anything held flat (receivables, gift
 * cards); it gets a neutral so it never competes with the named sleeves. */
export type SleeveId =
  | "other"
  | "checking"
  | "ef"
  | "reserve"
  | "core"
  | "ira"
  | "gold"
  | "k401"
  | "hsa"
  | "play"

/** Families the chart folds sleeves into by default. */
export type SleeveGroupId = "other" | "cash" | "taxable" | "retire" | "play"

export interface SleeveDef {
  id: SleeveId
  label: string
  short: string
  /** CSS custom property carrying the sleeve's color. */
  token: string
  /** Step in the "where the money goes" walk-through (flow order). */
  flow: number
  group: SleeveGroupId
}

/** Stack order, bottom to top, by family: other, cash, taxable, retirement,
 * play on top so its share reads at the edge. */
export const SLEEVES: SleeveDef[] = [
  {
    id: "other",
    label: "Other",
    short: "Other",
    token: "--sleeve-other",
    flow: 10,
    group: "other",
  },
  {
    id: "checking",
    label: "Checking buffer",
    short: "Checking",
    token: "--sleeve-checking",
    flow: 1,
    group: "cash",
  },
  {
    id: "ef",
    label: "Emergency fund",
    short: "Emergency",
    token: "--sleeve-ef",
    flow: 2,
    group: "cash",
  },
  {
    id: "reserve",
    label: "Reserve",
    short: "Reserve",
    token: "--sleeve-reserve",
    flow: 3,
    group: "cash",
  },
  {
    id: "core",
    label: "Core index",
    short: "Core",
    token: "--sleeve-core",
    flow: 4,
    group: "taxable",
  },
  {
    id: "gold",
    label: "Gold",
    short: "Gold",
    token: "--sleeve-gold",
    flow: 9,
    group: "taxable",
  },
  {
    id: "ira",
    label: "IRA",
    short: "IRA",
    token: "--sleeve-ira",
    flow: 5,
    group: "retire",
  },
  {
    id: "k401",
    label: "401k",
    short: "401k",
    token: "--sleeve-k401",
    flow: 6,
    group: "retire",
  },
  {
    id: "hsa",
    label: "HSA",
    short: "HSA",
    token: "--sleeve-hsa",
    flow: 7,
    group: "retire",
  },
  {
    id: "play",
    label: "Play sleeve",
    short: "Play",
    token: "--sleeve-play",
    flow: 8,
    group: "play",
  },
]

export interface SleeveGroup {
  id: SleeveGroupId
  label: string
  members: SleeveId[]
  /** A family reuses one member's color. */
  token: string
}

/** Families in stack order, bottom to top. */
export const SLEEVE_GROUPS: SleeveGroup[] = [
  { id: "other", label: "Other", members: ["other"], token: "--sleeve-other" },
  {
    id: "cash",
    label: "Cash",
    members: ["checking", "ef", "reserve"],
    token: "--sleeve-ef",
  },
  {
    id: "taxable",
    label: "Taxable",
    members: ["core", "gold"],
    token: "--sleeve-core",
  },
  {
    id: "retire",
    label: "Retirement",
    members: ["ira", "k401", "hsa"],
    token: "--sleeve-k401",
  },
  { id: "play", label: "Play", members: ["play"], token: "--sleeve-play" },
]

/** Invested sleeves (what play share divides by), bottom to top. */
export const INVESTED_SLEEVES: SleeveId[] = [
  "core",
  "gold",
  "ira",
  "k401",
  "hsa",
  "play",
]

export const SLEEVE_BY_ID = Object.fromEntries(
  SLEEVES.map((s) => [s.id, s])
) as Record<SleeveId, SleeveDef>

export function sleeveValue(row: MonthRow, id: SleeveId): number {
  return row[id]
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
    body: "Deposits paid from cash, up to the year's IRA limit (Roth and traditional share it).",
  },
  k401: {
    title: "401k",
    body: "Payroll deferrals, pre-tax and Roth under one annual limit, plus the employer match. Unvested match is lost if the job ends before the vesting date.",
  },
  hsa: {
    title: "HSA",
    body: "Payroll, direct and employer money, up to a limit prorated by the months covered by an HDHP. Payroll money skips income tax and FICA.",
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
    title: "Other",
    body: "Balances held flat and counted in net worth (receivables, gift cards).",
  },
}

export const NOT_MODELED_DEFAULT: string[] = [
  "Market swings: returns are smooth averages, so a bad year lowers the invested sleeves while the cash plan stays the same.",
  "Taxes on the taxable sleeves (dividends, realized gains) and the yearly return's true-up beyond the one-off bills listed.",
  "Bonuses, equity grants and side income.",
  "The tax saved at filing by a direct HSA or deductible traditional IRA deposit, and income limits on Roth IRA deposits.",
  "Taking out an excess contribution, the 6% excise on one left in, and the HSA last-month rule.",
  "Selling play-sleeve positions to bring it under its cap.",
  "Card rewards, refunds and irregular spending beyond the monthly average.",
]
