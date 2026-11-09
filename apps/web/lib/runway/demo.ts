// Built-in demo plan, used when the ledger has no config/runway.yaml (the page
// says so). Synthetic round numbers that describe nobody; the same people as
// runway.example.yaml.

import { addMonths } from "./schedule"
import type {
  Job,
  RunwayData,
  RunwayPerson,
  SleeveKey,
  Withholding,
} from "./types"

export function zeroSleeves(): Record<SleeveKey, number> {
  return {
    checking: 0,
    ef: 0,
    reserve: 0,
    core: 0,
    ira: 0,
    k401: 0,
    hsa: 0,
    gold: 0,
    play: 0,
    other: 0,
  }
}

export const DEFAULT_WITHHOLDING: Withholding = {
  filing: "single",
  federalStd: 16_100,
  state: "ny_nonresident",
  stateStd: 8_000,
  statePayroll: { flatPerPaycheck: 12, rate: 0, annualCap: null },
  ssWageBase: 184_500,
}

const ALEX_JOB: Job = {
  employer: "Current job",
  grossAnnual: 90_000,
  raise: { month: 2, pct: 0.03 },
  schedule: { frequency: "biweekly", anchor: "2026-11-13", days: [] },
  deductions: [
    {
      label: "Medical",
      amount: 30,
      per: "paycheck",
      paycheckOfMonth: null,
      pretax: true,
      ficaExempt: true,
      sleeve: null,
    },
    {
      label: "Commuter",
      amount: 20,
      per: "paycheck",
      paycheckOfMonth: null,
      pretax: true,
      ficaExempt: true,
      sleeve: null,
    },
    {
      label: "Life",
      amount: 1.5,
      per: "paycheck",
      paycheckOfMonth: null,
      pretax: false,
      ficaExempt: false,
      sleeve: null,
    },
  ],
  withholding: DEFAULT_WITHHOLDING,
  match: { type: "threshold", minPct: 0.04, pct: 0.02 },
  vesting: { date: "2027-09-01", unvestedStart: 500 },
}

const SAM_JOB: Job = {
  employer: "Current job",
  grossAnnual: 140_000,
  raise: null,
  schedule: { frequency: "semimonthly", anchor: null, days: [15, -1] },
  deductions: [
    {
      label: "HSA",
      amount: 300,
      per: "month",
      paycheckOfMonth: 2,
      pretax: true,
      ficaExempt: true,
      sleeve: "hsa",
    },
  ],
  withholding: {
    ...DEFAULT_WITHHOLDING,
    statePayroll: { flatPerPaycheck: 0, rate: 0.00432, annualCap: 411.91 },
  },
  match: { type: "none" },
  vesting: null,
}

function demoPeople(asof: string, start: string): RunwayPerson[] {
  const y = Number(start.slice(0, 4))
  const limits = { [y]: 24_500, [y + 1]: 24_500, [y + 2]: 25_000 }
  const next = (n: number) => addMonths(start, n)
  const alex: RunwayPerson = {
    id: "alex",
    label: "Alex",
    job: ALEX_JOB,
    k401: {
      limits,
      ytd: { [y]: 0 },
      elections: [
        { from: start, mode: "percent", pretaxPct: 0.1, rothPct: 0 },
        { from: `${y + 1}-01`, mode: "max_spread", capPct: 0.5, rothShare: 0 },
      ],
    },
    spendingMonthly: 4_200,
    ira: { amount: 7_500, month: 1 },
    oneOffs: [{ month: `${y + 1}-04`, amount: 1_500, label: "Tax due" }],
    cash: {
      buffer: 3_000,
      efMonths: 6,
      earmarks: [{ label: "Earmark", amount: 15_000 }],
      dcaMonths: 12,
      cardPayoff: { checking: 1 },
    },
    returns: { equity: 0.07, reserve: 0.039, ef: 0.0365, gold: 0.03 },
    scenarios: [
      { id: "stay", label: "Stay", start: null, job: null },
      {
        id: "offer-a",
        label: "Offer A",
        start: next(8),
        job: {
          ...ALEX_JOB,
          employer: "Offer A",
          grossAnnual: 110_000,
          raise: null,
          match: { type: "flat", pct: 0.04 },
          vesting: null,
        },
      },
    ],
    starting: {
      source: "static",
      asof,
      sleeves: {
        ...zeroSleeves(),
        checking: 6_200,
        ef: 21_000,
        reserve: 40_000,
        core: 55_000,
        ira: 12_000,
        k401: 18_000,
        play: 4_000,
      },
      cards: 1_800,
      loans: 0,
      unvested: 500,
      accounts: [],
      unmapped: [],
    },
    inherited: [],
    sleeveText: {},
    notModeled: null,
    playCap: 0.1,
  }
  const sam: RunwayPerson = {
    ...alex,
    id: "sam",
    label: "Sam",
    job: SAM_JOB,
    k401: {
      limits,
      ytd: { [y]: 18_000 },
      elections: [{ from: start, mode: "fixed", pretax: 2_000, roth: 0 }],
    },
    spendingMonthly: 5_500,
    oneOffs: [],
    cash: {
      buffer: 4_000,
      efMonths: 6,
      earmarks: [],
      dcaMonths: 6,
      cardPayoff: { checking: 1 },
    },
    scenarios: [{ id: "stay", label: "Stay", start: null, job: null }],
    starting: {
      ...alex.starting,
      sleeves: {
        ...zeroSleeves(),
        checking: 8_000,
        ef: 30_000,
        reserve: 25_000,
        core: 90_000,
        ira: 30_000,
        k401: 60_000,
        hsa: 5_000,
        gold: 6_000,
        play: 15_000,
      },
      cards: 3_000,
      unvested: 0,
    },
  }
  return [alex, sam]
}

/** Share of the month still ahead after `asof` (spending already happened
 * before it is in the starting balances). */
export function spendFraction(asof: string): number {
  const [y, m, d] = asof.split("-").map(Number)
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return Math.max(0, Math.min(1, (days - d) / days))
}

export function demoRunway(today: string): RunwayData {
  const start = today.slice(0, 7)
  return {
    asof: today,
    start,
    months: 24,
    firstMonthSpendFraction: spendFraction(today),
    spreadThrough: "year_end",
    reserveLookahead: 12,
    fromConfig: false,
    people: demoPeople(today, start),
    unavailable: [],
    order: ["alex", "sam"],
    errors: [],
    warnings: [],
  }
}
