// Shapes for the /fire page. `Inputs` is the single editable state the page
// holds; the engine is a pure function of it plus the ledger's starting net
// worth. A saved scenario is just a named `Inputs`.

export type Mode = "individual" | "household"
export type Tier = "lean" | "base" | "fat" | "custom"
/** How the plan leaves full-time work; see `lib/fire/engine.ts`. */
export type Path = "normal" | "coast" | "barista"
export type Phase = "saving" | "coasting" | "barista" | "retired"

/** Gross pay from `year` until the next enabled step within the same job. */
export interface SalaryStep {
  year: number
  gross: number
  note?: string
  enabled: boolean
}

export interface Spending {
  housing: number
  car: number
  discretionary: number
  essentials: number
}

export type GrantType = "iso" | "nso" | "rsu"

/** One equity award. Options vest monthly after an optional cliff; `halves`
 * splits the grant into two equal tranches whose clocks start
 * `halfOffsetMonths` apart (a common refresh-style structure). */
export interface Grant {
  id: string
  label: string
  type: GrantType
  shares: number
  /** Exercise price per share; 0 for RSUs. */
  strike: number
  /** Current price per share (409A for private common). */
  price: number
  /** "YYYY-MM" vesting commencement. */
  vestStart: string
  vestMonths: number
  cliffMonths: number
  halves: boolean
  halfOffsetMonths: number
}

/** What a job's equity turns into. `multiple` is the outcome the main line
 * uses; Monte Carlo draws fail / modest / big by `odds` instead. */
export interface EquityOutcome {
  enabled: boolean
  liquidityYear: number
  multiple: number
  taxRate: number
  /** Share of value lost to later rounds before the exit, 0 to 1. */
  dilution: number
  /** Pay the strike for vested options when leaving before liquidity. */
  exerciseAtLeave: boolean
  odds: { fail: number; modest: number; big: number }
  modestMultiple: number
  bigMultiple: number
}

/** A job: pay while you are there, equity that vests while you are there.
 * A job ends at `leave`, or when the person's next enabled job starts. */
export interface Job {
  id: string
  employer: string
  enabled: boolean
  /** "YYYY-MM", or null if it began before the plan. */
  start: string | null
  /** "YYYY-MM" last month employed, or null for open-ended. */
  leave: string | null
  salary: SalaryStep[]
  grants: Grant[]
  equity: EquityOutcome
}

/** Where wages are taxed: drives the state schedule in `lib/fire/tax.ts`. */
export type WorkState = "ny_from_nj" | "ny" | "nj" | "none"

export interface Person {
  id: string
  name: string
  birthYear: number
  workState: WorkState
  /** Pre-tax payroll deductions that stay the person's money (an HSA
   * contribution, a commuter benefit spent on transit). */
  pretax: { hsa: number; commuter: number }
  otherIncome: number
  k401Deferral: number
  /** "ledger" = live snapshot net worth; a number = entered by hand. */
  netWorth: number | "ledger"
  jobs: Job[]
  spending: Spending
}

interface EventBase {
  id: string
  label: string
  year: number
  enabled: boolean
}

export type FireEvent =
  | (EventBase & { kind: "lump"; amount: number })
  | (EventBase & { kind: "marker" })
  | (EventBase & { kind: "kid" })
  | (EventBase & { kind: "japan"; years: number; netSaving: number })
  | (EventBase & { kind: "crash"; drop: number })

export type EventKind = FireEvent["kind"]

export interface Assumptions {
  realReturn: number
  returnVolatility: number
  swr: number
  coastAge: number
  realRaiseGrowth: number
  spendCreep: number
  k401Limit: number
}

export interface TierSpend {
  lean: number
  base: number
  fat: number
}

export interface Levers {
  /** $/yr change to the primary person's housing from `leverYear`. */
  housingDelta: number
  /** $/yr change to car costs from `leverYear`. */
  carDelta: number
  /** Fraction of discretionary spend cut, 0 to 0.5. */
  discretionaryTrim: number
  leverYear: number
}

export interface KidCostBand {
  from: number
  to: number
  amount: number
}

export interface Inputs {
  startYear: number
  endAge: number
  mode: Mode
  tier: Tier
  customSpend: number
  path: Path
  /** Side income per year on the barista path, until the full retirement age. */
  baristaIncome: number
  assumptions: Assumptions
  retirementSpend: { individual: TierSpend; household: TierSpend }
  primaryShare: number
  /** Federal returns are filed jointly from this year; null = single. */
  marriageYear: number | null
  people: Person[]
  kidCosts: KidCostBand[]
  events: FireEvent[]
  levers: Levers
}

export interface Snapshot {
  asof: string
  buckets: Record<string, number>
  expenses: { category: string; amount: number }[]
  income: { category: string; amount: number }[]
}

export interface Scenario {
  id: string
  name: string
  overrides: Partial<Inputs>
  updatedAt: string
}

export interface YearRow {
  year: number
  ages: number[]
  takeHome: number
  spend: number
  kidCost: number
  k401: number
  saving: number
  lump: number
  portfolio: number
  target: number
  coastTarget: number
  /** The snapshot year: estimated year-end from today's ledger, not a
   * projected step. */
  baseline: boolean
  /** Withdrawing from the portfolio (retired, or barista top-ups). */
  retired: boolean
  phase: Phase
  japan: boolean
}

export interface SimResult {
  rows: YearRow[]
  /** First year-end the portfolio covers the full FI target, on any path. */
  fiYear: number | null
  /** Year-end full-time saving stops: FI (normal), coast line (coast), or
   * portfolio + side income covering spend (barista). */
  freeYear: number | null
  /** First year money comes out of the portfolio. */
  drawYear: number | null
  coastYear: number | null
  /** Ledger net worth on the snapshot date (today). */
  nowPortfolio: number
  /** Estimated portfolio at the end of the snapshot year. */
  startPortfolio: number
  retirementSpend: number
  targetToday: number
  /** First year the portfolio cannot cover withdrawals (null = lasts). */
  depletedYear: number | null
}
