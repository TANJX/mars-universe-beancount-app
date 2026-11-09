// Runway: a monthly cash and sleeve simulator for one person over the next
// couple of years. The contract half of this file mirrors the JSON served by
// `/api/ext/runway_data` (resolved, camelCase); the engine half is what
// `engine.ts` returns and the page charts.
//
// Erasable TypeScript only (no enums, no namespaces) so `node --test` can run
// the engine straight from source.

export type SleeveKey =
  | "checking"
  | "ef"
  | "reserve"
  | "core"
  | "ira"
  | "k401"
  | "hsa"
  | "gold"
  | "play"
  | "other"

export const SLEEVE_KEYS: SleeveKey[] = [
  "checking",
  "ef",
  "reserve",
  "core",
  "ira",
  "k401",
  "hsa",
  "gold",
  "play",
  "other",
]

export type PayFrequency = "biweekly" | "semimonthly"
export type StateCode = "ny" | "ny_nonresident" | "nj" | "none"

export interface PaySchedule {
  frequency: PayFrequency
  /** Biweekly: any real pay date (YYYY-MM-DD). */
  anchor: string | null
  /** Semi-monthly: day of month, rolled back to a weekday; -1 = last weekday. */
  days: number[]
}

export interface Deduction {
  label: string
  amount: number
  per: "paycheck" | "month"
  /** 1-based; which paycheck of the month carries a per-month deduction. */
  paycheckOfMonth: number | null
  pretax: boolean
  ficaExempt: boolean
  /** Money that lands in a sleeve (an HSA, say) instead of leaving. */
  sleeve: SleeveKey | null
}

export interface Raise {
  month: number
  pct: number
}

export interface StatePayroll {
  flatPerPaycheck: number
  rate: number
  annualCap: number | null
}

export interface Withholding {
  filing: "single" | "joint"
  federalStd: number
  state: StateCode
  stateStd: number
  statePayroll: StatePayroll
  ssWageBase: number
}

export type Match =
  | { type: "none" }
  | { type: "flat"; pct: number }
  | { type: "threshold"; minPct: number; pct: number }
  | { type: "tiered"; tiers: { rate: number; upToPct: number }[] }

export interface Vesting {
  date: string
  unvestedStart: number
}

export interface Job {
  employer: string
  grossAnnual: number
  raise: Raise | null
  schedule: PaySchedule
  deductions: Deduction[]
  withholding: Withholding
  match: Match
  vesting: Vesting | null
}

export type Election =
  | { from: string; mode: "fixed"; pretax: number; roth: number }
  | { from: string; mode: "percent"; pretaxPct: number; rothPct: number }
  | { from: string; mode: "max_spread"; capPct: number; rothShare: number }

export type ElectionMode = Election["mode"]

export interface JobScenario {
  id: string
  label: string
  /** null for "stay". */
  start: string | null
  job: Job | null
}

export interface StartingAccount {
  account: string
  currency: string
  sleeve: SleeveKey
  usd: number
}

export interface Starting {
  source: "ledger" | "static"
  asof: string
  sleeves: Record<SleeveKey, number>
  /** Card balance owed today, positive; paid off from cash at the start. */
  cards: number
  /** Held flat and subtracted from net worth. */
  loans: number
  /** Unvested employer match already inside the 401k balance. */
  unvested: number
  accounts: StartingAccount[]
  unmapped: { account: string; currency: string; usd: number }[]
}

export interface SleeveText {
  title?: string
  body?: string
}

export interface RunwayPerson {
  id: string
  label: string
  job: Job
  k401: {
    limits: Record<string, number>
    ytd: Record<string, number>
    elections: Election[]
  }
  spendingMonthly: number
  ira: { amount: number; month: number } | null
  oneOffs: { month: string; amount: number; label: string }[]
  cash: {
    buffer: number
    efMonths: number
    earmarks: { label: string; amount: number }[]
    dcaMonths: number
    cardPayoff: Partial<Record<"checking" | "ef" | "reserve", number>>
  }
  returns: { equity: number; reserve: number; ef: number; gold: number }
  /** [0] is always the "stay" scenario. */
  scenarios: JobScenario[]
  starting: Starting
  inherited: string[]
  /** Optional private wording for the "where the money goes" blocks. */
  sleeveText: Partial<Record<SleeveKey, SleeveText>>
  notModeled: string[] | null
  /** Play-sleeve cap as a share of invested assets. */
  playCap: number
}

export interface RunwayIssue {
  personId: string | null
  path: string
  message: string
}

export type PersonStatus = "ok" | "locked" | "missing" | "error"

/** A person the endpoint could not resolve (encrypted, missing, broken). */
export interface UnavailablePerson {
  id: string
  label: string
  status: Exclude<PersonStatus, "ok">
  message: string
  file: string | null
}

export interface Horizon {
  /** Ledger date; only pay dates strictly after it are simulated. */
  asof: string
  /** First projected month, YYYY-MM. */
  start: string
  months: number
  firstMonthSpendFraction: number
  spreadThrough: "horizon" | "year_end"
  reserveLookahead: number
}

export interface RunwayData extends Horizon {
  fromConfig: boolean
  people: RunwayPerson[]
  unavailable: UnavailablePerson[]
  /** Person ids in config order (resolved and unavailable together). */
  order: string[]
  errors: RunwayIssue[]
  warnings: RunwayIssue[]
}

/** What the engine runs on: one person (with page edits applied) plus the
 * shared horizon. */
export interface RunwayInputs {
  person: RunwayPerson
  horizon: Horizon
}

// ---------------------------------------------------------------- engine out

export interface PaycheckRow {
  date: string
  month: string
  employer: "current" | "new"
  gross: number
  pre: number
  roth: number
  pretaxDeductions: number
  postTaxDeductions: number
  federal: number
  state: number
  fica: number
  statePayroll: number
  net: number
  match: number
}

export interface MonthRow {
  month: string
  takeHome: number
  outflows: number
  /** max(0, outflows - takeHome): drawn from the reserve. */
  shortfall: number
  spendOut: number
  iraOut: number
  /** One-off bills (tax due and the like); negative for refunds. */
  taxOut: number
  k401In: number
  match: number
  reserveToCore: number
  paychecks: number
  checking: number
  ef: number
  reserve: number
  core: number
  ira: number
  k401: number
  hsa: number
  gold: number
  play: number
  other: number
  unvested: number
  invested: number
  cash: number
  netWorth: number
  playShare: number
  events: string[]
}

export interface RunwayResult {
  rows: MonthRow[]
  paychecks: PaycheckRow[]
  startNetWorth: number
  forfeitMonth: string | null
  /** Unvested match lost when leaving before the vesting date. */
  forfeited: number
  /** Year to the pay date the 401k limit was reached. */
  limitHit: Record<string, string>
  efDrawn: number
  /** First month the emergency fund was drawn. */
  efDrawnMonth: string | null
  coreDrawn: number
  /** First month the core was drawn to top up checking. */
  coreDrawnMonth: string | null
  /** Lowest month-end checking balance (negative when nothing could cover it). */
  minChecking: number
  /** Months where checking stays below 0 after the top-up: reserve, emergency
   * fund and core are all empty. */
  unfundedMonths: string[]
  /** Deepest negative checking balance, as a positive amount (0 when none). */
  unfundedPeak: number
  /** Month of the deepest negative checking balance. */
  unfundedPeakMonth: string | null
  k401Contributed: number
  matchTotal: number
  shortfallTotal: number
  movedToCore: number
  shortMonths: number
}
