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

export type ContributionAccount = "k401" | "ira" | "hsa"

/** Display order: payroll accounts first. Also the pool keys: every stream
 * in one account shares that account's annual limit. */
export const CONTRIBUTION_ACCOUNTS: ContributionAccount[] = [
  "k401",
  "hsa",
  "ira",
]

export type TaxTreatment = "traditional" | "roth"
/** payroll: taken off the paycheck. direct: paid from cash. */
export type Channel = "payroll" | "direct"

export type Pace =
  | { pace: "off" }
  | {
      pace: "fixed"
      amount: number
      /** Direct streams are always per month. */
      per: "paycheck" | "month"
      /** 1-based; which paycheck carries a per-month payroll amount. */
      paycheckOfMonth: number | null
    }
  | { pace: "percent"; pct: number }
  /** `share` of the pool's remaining room, spread over the periods left in
   * the year, at most `capPct` of a paycheck. */
  | { pace: "even"; share: number; capPct: number }
  /** `share` of the pool's remaining room as early as `capPct` of each
   * paycheck allows. */
  | { pace: "front_load"; share: number; capPct: number }
  /** Once a year in `month`; `amount` null means whatever room is left. */
  | { pace: "lump"; month: number; amount: number | null }

export type PaceKind = Pace["pace"]

/** One dated step of a stream; the latest `from` on or before a month wins. */
export type Phase = { from: string } & Pace

/** One stream of money into a tax-advantaged account. Tax effect and the
 * destination sleeve follow from (account, tax, channel). */
export interface Contribution {
  id: string
  account: ContributionAccount
  /** Always "traditional" for an HSA. */
  tax: TaxTreatment
  /** 401k is always payroll and IRA always direct; an HSA can be either. */
  channel: Channel
  /** Already contributed this year before `asof`, by year. */
  ytd: Record<string, number>
  schedule: Phase[]
}

export type HsaTier = "self" | "family" | "none"

/** HDHP coverage on the first of the month, from `from` onward. */
export interface HsaCoverage {
  from: string
  tier: HsaTier
}

/** Annual limits for one year, catch-up already included. */
export interface YearLimits {
  k401: number
  ira: number
  hsaSelf: number
  hsaFamily: number
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
  /** Employer money into the HSA once a year; counts toward the HSA limit. */
  hsaEmployer: { amount: number; month: number } | null
  /** A scenario job's HDHP coverage from its start month; null keeps the
   * person's coverage schedule. */
  hsaTier: HsaTier | null
}

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
  contributions: Contribution[]
  /** By year; a missing year reuses the closest earlier one. */
  limits: Record<string, YearLimits>
  /** Empty means self-only coverage throughout. */
  hsaCoverage: HsaCoverage[]
  spendingMonthly: number
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
  /** Pre-tax 401k. */
  pre: number
  /** Roth 401k. */
  roth: number
  /** Payroll HSA. */
  hsa: number
  pretaxDeductions: number
  postTaxDeductions: number
  federal: number
  state: number
  fica: number
  statePayroll: number
  net: number
  match: number
}

/** One account's annual limit and what goes against it in one year. */
export interface PoolYear {
  /** The year's final limit (an HSA's is prorated by covered months). */
  limit: number
  /** Contributed before `asof` (the streams' `ytd`). */
  before: number
  /** Contributed inside the horizon, by contribution id. */
  streams: Record<string, number>
  /** Employer money that counts toward the limit (HSA only). */
  employer: number
  /** before + streams + employer. */
  contributed: number
  /** Contributed above the final limit (coverage ended after the money
   * went in, or `ytd` already exceeded it). */
  excess: number
  /** Pay date or month the limit was reached. */
  hitDate: string | null
  /** First date a fixed or percent stream was cut short by the limit. */
  clippedDate: string | null
  /** How much those streams asked for beyond the limit, inside the horizon. */
  cut: number
  /** The whole rest of the year is inside the horizon. */
  complete: boolean
}

export interface MonthRow {
  month: string
  takeHome: number
  outflows: number
  /** max(0, outflows - takeHome): drawn from the reserve. */
  shortfall: number
  spendOut: number
  /** Direct IRA deposits, paid from cash. */
  iraOut: number
  /** Direct HSA deposits, paid from cash. */
  hsaOut: number
  /** One-off bills (tax due and the like); negative for refunds. */
  taxOut: number
  k401In: number
  /** Everything into the HSA: payroll, direct and employer money. */
  hsaIn: number
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
  hsaContributed: number
  iraContributed: number
  /** By year, then account. */
  pools: Record<string, Record<ContributionAccount, PoolYear>>
  matchTotal: number
  shortfallTotal: number
  movedToCore: number
  shortMonths: number
}
