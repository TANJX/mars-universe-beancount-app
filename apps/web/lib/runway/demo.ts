// Built-in demo plan, used when the ledger has no config/runway.yaml (the page
// says so). Synthetic round numbers that describe nobody; the same people as
// runway.example.yaml.

import { addMonths } from "./schedule"
import type {
  Pay,
  PersonRecord,
  PlanBody,
  RunwayData,
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

const ALEX_PAY: Pay = {
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
}

const SAM_PAY: Pay = {
  schedule: { frequency: "semimonthly", anchor: null, days: [15, -1] },
  deductions: [],
  withholding: {
    ...DEFAULT_WITHHOLDING,
    statePayroll: { flatPerPaycheck: 0, rate: 0.00432, annualCap: 411.91 },
  },
}

const NO_OVERRIDES = { schedule: null, deductions: null, withholding: null }

function demoPeople(asof: string, start: string): PersonRecord[] {
  const y = Number(start.slice(0, 4))
  const limits = { [y + 2]: { k401: 25_000 } }
  const next = (n: number) => addMonths(start, n)
  const alexPlan: PlanBody = {
    label: "Alex",
    birthYear: null,
    pay: ALEX_PAY,
    jobs: [
      {
        id: "current",
        employer: "Current job",
        start: null,
        leave: null,
        enabled: true,
        note: null,
        salary: [
          { from: `${y}-01`, gross: 90_000, enabled: true, note: null },
          { from: `${y + 1}-02`, gross: 92_700, enabled: true, note: "Review" },
          { from: `${y + 2}-02`, gross: 95_481, enabled: true, note: "Review" },
        ],
        match: { type: "threshold", minPct: 0.04, pct: 0.02 },
        vesting: { date: "2027-09-01", unvestedStart: 500 },
        hsaEmployer: null,
        ...NO_OVERRIDES,
      },
    ],
    contributions: [
      {
        id: "k401-pretax",
        account: "k401",
        tax: "traditional",
        channel: "payroll",
        ytd: { [y]: 0 },
        schedule: [
          { from: start, pace: "percent", pct: 0.1 },
          { from: `${y + 1}-01`, pace: "even", share: 0.6, capPct: 0.3 },
        ],
      },
      {
        id: "k401-roth",
        account: "k401",
        tax: "roth",
        channel: "payroll",
        ytd: {},
        schedule: [
          { from: `${y + 1}-01`, pace: "even", share: 0.4, capPct: 0.2 },
        ],
      },
      {
        id: "ira-roth",
        account: "ira",
        tax: "roth",
        channel: "direct",
        ytd: {},
        schedule: [{ from: start, pace: "lump", month: 1, amount: null }],
      },
    ],
    limits,
    hsaCoverage: [],
    spendingMonthly: 4_200,
    oneOffs: [{ month: `${y + 1}-04`, amount: 1_500, label: "Tax due" }],
    cash: {
      buffer: 3_000,
      efMonths: 6,
      earmarks: [{ label: "Earmark", amount: 15_000 }],
      dcaMonths: 12,
      cardPayoff: { checking: 1 },
    },
    returns: { equity: 0.07, reserve: 0.039, ef: 0.0365, gold: 0.03 },
    playCap: 0.1,
    spreadThrough: "year_end",
  }
  const alex: PersonRecord = {
    id: "alex",
    plan: alexPlan,
    overrides: [],
    readOnly: false,
    file: "config/runway.yaml",
    scenarios: [
      {
        id: "offer-a",
        label: "Offer A",
        patch: {
          jobs: [
            {
              id: "offer-a",
              employer: "Offer A",
              start: next(8),
              leave: null,
              enabled: true,
              note: null,
              salary: [
                { from: next(8), gross: 110_000, enabled: true, note: null },
              ],
              match: { type: "flat", pct: 0.04 },
              vesting: null,
              hsaEmployer: null,
              ...NO_OVERRIDES,
            },
          ],
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
    sleeveText: {},
    notModeled: null,
  }
  const samPlan: PlanBody = {
    ...alexPlan,
    label: "Sam",
    pay: SAM_PAY,
    jobs: [
      {
        id: "current",
        employer: "Current job",
        start: null,
        leave: null,
        enabled: true,
        note: null,
        salary: [
          { from: `${y}-01`, gross: 140_000, enabled: true, note: null },
        ],
        match: { type: "none" },
        vesting: null,
        hsaEmployer: { amount: 500, month: 1 },
        ...NO_OVERRIDES,
      },
    ],
    contributions: [
      {
        id: "k401-pretax",
        account: "k401",
        tax: "traditional",
        channel: "payroll",
        ytd: { [y]: 18_000 },
        schedule: [
          {
            from: start,
            pace: "fixed",
            amount: 2_000,
            per: "paycheck",
            paycheckOfMonth: null,
          },
        ],
      },
      {
        id: "hsa",
        account: "hsa",
        tax: "traditional",
        channel: "payroll",
        ytd: { [y]: 2_750 },
        schedule: [
          {
            from: start,
            pace: "fixed",
            amount: 275,
            per: "month",
            paycheckOfMonth: 2,
          },
          { from: `${y + 1}-01`, pace: "front_load", share: 1, capPct: 0.25 },
        ],
      },
      {
        id: "ira-roth",
        account: "ira",
        tax: "roth",
        channel: "direct",
        ytd: {},
        schedule: [{ from: start, pace: "lump", month: 1, amount: null }],
      },
    ],
    hsaCoverage: [{ from: `${y}-01`, tier: "self" }],
    spendingMonthly: 5_500,
    oneOffs: [],
    cash: {
      buffer: 4_000,
      efMonths: 6,
      earmarks: [],
      dcaMonths: 6,
      cardPayoff: { checking: 1 },
    },
  }
  const sam: PersonRecord = {
    ...alex,
    id: "sam",
    plan: samPlan,
    scenarios: [],
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
    reserveLookahead: 12,
    fromConfig: false,
    version: "",
    shared: {
      returns: { equity: 0.07, reserve: 0.039, ef: 0.0365, gold: 0.03 },
      limits: { [Number(start.slice(0, 4)) + 2]: { k401: 25_000 } },
      playCap: 0.1,
      spreadThrough: "year_end",
    },
    people: demoPeople(today, start),
    unavailable: [],
    order: ["alex", "sam"],
    errors: [],
    warnings: [],
  }
}
