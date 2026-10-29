// `/api/ext/fire_data` payload → page `Inputs`.
//
// `config/fire.yaml` is snake_case, hand-edited, and per-user, so parsing is
// lenient: every field falls back to `DEMO_INPUTS`, and a missing file yields
// the demo plan (the page says so). The demo values are illustrative only and
// describe nobody in particular.

import { z } from "zod"

import type {
  EquityOutcome,
  FireEvent,
  Grant,
  Inputs,
  Job,
  Person,
  SalaryStep,
  Scenario,
  Snapshot,
  Spending,
  TierSpend,
  WorkState,
} from "./types"

const SnapshotSchema = z.object({
  asof: z.string(),
  buckets: z.record(z.string(), z.number()),
  expenses: z.array(z.object({ category: z.string(), amount: z.number() })),
  income: z.array(z.object({ category: z.string(), amount: z.number() })),
})

const ScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  overrides: z.record(z.string(), z.unknown()),
  updatedAt: z.string(),
})

export const FireDataSchema = z.object({
  snapshot: SnapshotSchema,
  config: z.record(z.string(), z.unknown()),
  scenarios: z.array(ScenarioSchema),
})

export interface FireData {
  snapshot: Snapshot
  inputs: Inputs
  fromConfig: boolean
  scenarios: Scenario[]
}

const DEMO_SPENDING: Spending = {
  housing: 24000,
  car: 3000,
  discretionary: 12000,
  essentials: 9000,
}

export const DEFAULT_EQUITY: EquityOutcome = {
  enabled: false,
  liquidityYear: new Date().getFullYear() + 4,
  multiple: 1,
  taxRate: 0.25,
  dilution: 0.2,
  exerciseAtLeave: true,
  odds: { fail: 0.5, modest: 0.35, big: 0.15 },
  modestMultiple: 2,
  bigMultiple: 10,
}

function demoJob(id: string, employer: string, salary: SalaryStep[]): Job {
  return {
    id,
    employer,
    enabled: true,
    start: null,
    leave: null,
    salary,
    grants: [],
    equity: DEFAULT_EQUITY,
  }
}

export const DEMO_INPUTS: Inputs = {
  startYear: new Date().getFullYear() + 1,
  endAge: 95,
  mode: "individual",
  tier: "base",
  customSpend: 60000,
  path: "normal",
  baristaIncome: 25000,
  assumptions: {
    realReturn: 0.05,
    returnVolatility: 0.16,
    swr: 0.035,
    coastAge: 60,
    realRaiseGrowth: 0.01,
    k401Limit: 24500,
  },
  retirementSpend: {
    individual: { lean: 40000, base: 55000, fat: 85000 },
    household: { lean: 60000, base: 90000, fat: 130000 },
  },
  primaryShare: 0.5,
  marriageYear: null,
  people: [
    {
      id: "me",
      name: "You",
      birthYear: 1995,
      workState: "none",
      pretax: { hsa: 0, commuter: 0 },
      otherIncome: 0,
      k401Deferral: 0,
      netWorth: "ledger",
      jobs: [
        demoJob("me-job", "Current job", [
          { year: new Date().getFullYear(), gross: 100000, enabled: true },
        ]),
      ],
      spending: DEMO_SPENDING,
    },
    {
      id: "partner",
      name: "Partner",
      birthYear: 1995,
      workState: "none",
      pretax: { hsa: 0, commuter: 0 },
      otherIncome: 0,
      k401Deferral: 0,
      netWorth: 0,
      jobs: [
        demoJob("partner-job", "Current job", [
          { year: new Date().getFullYear(), gross: 80000, enabled: true },
        ]),
      ],
      spending: {
        housing: 12000,
        car: 0,
        discretionary: 9000,
        essentials: 7000,
      },
    },
  ],
  kidCosts: [
    { from: 0, to: 4, amount: 20000 },
    { from: 5, to: 17, amount: 12000 },
    { from: 18, to: 21, amount: 25000 },
  ],
  events: [],
}

type Raw = Record<string, unknown>

const WORK_STATE_VALUES: WorkState[] = ["ny_from_nj", "ny", "nj", "none"]

const obj = (v: unknown): Raw =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {}
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const num = (v: unknown, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d
const str = (v: unknown, d: string): string => (typeof v === "string" ? v : d)

function tiers(v: unknown, d: TierSpend): TierSpend {
  const o = obj(v)
  return {
    lean: num(o.lean, d.lean),
    base: num(o.base, d.base),
    fat: num(o.fat, d.fat),
  }
}

function salarySteps(v: unknown): SalaryStep[] {
  return arr(v)
    .map((s) => obj(s))
    .filter((s) => typeof s.year === "number" && typeof s.gross === "number")
    .map((s) => ({
      year: s.year as number,
      gross: s.gross as number,
      enabled: s.enabled !== false,
      ...(typeof s.note === "string" ? { note: s.note } : {}),
    }))
    .sort((a, b) => a.year - b.year)
}

/** YAML reads 2027-12 as a string but a bare 2027 as a number. */
const ym = (v: unknown): string | null =>
  typeof v === "string" && /^\d{4}-\d{2}$/.test(v)
    ? v
    : typeof v === "number"
      ? `${v}-01`
      : null

function grant(v: unknown, i: number, jobId: string): Grant {
  const o = obj(v)
  const price = num(o.price, 1)
  const type = o.type === "nso" || o.type === "rsu" ? o.type : "iso"
  // A grant can be given as a dollar value at today's price (typical for an
  // offer letter) instead of a share count; options then strike at price.
  const value = num(o.value, 0)
  const shares = num(o.shares, value > 0 && price > 0 ? value / price : 0)
  return {
    id: str(o.id, `${jobId}-grant-${i}`),
    label: str(o.label, `Grant ${i + 1}`),
    type,
    shares,
    strike: num(o.strike, type === "rsu" ? 0 : value > 0 ? price : 0),
    price,
    vestStart: ym(o.vest_start) ?? `${new Date().getFullYear()}-01`,
    vestMonths: num(o.vest_months, 48),
    cliffMonths: num(o.cliff_months, 12),
    halves: o.halves === true,
    halfOffsetMonths: num(o.half_offset_months, 24),
  }
}

function equityOutcome(v: unknown): EquityOutcome {
  const o = obj(v)
  const d = DEFAULT_EQUITY
  const odds = obj(o.odds)
  return {
    enabled: o.enabled === true,
    liquidityYear: num(o.liquidity_year, d.liquidityYear),
    multiple: num(o.multiple, d.multiple),
    taxRate: num(o.tax_rate, d.taxRate),
    dilution: num(o.dilution, d.dilution),
    exerciseAtLeave: o.exercise_at_leave !== false,
    odds: {
      fail: num(odds.fail, d.odds.fail),
      modest: num(odds.modest, d.odds.modest),
      big: num(odds.big, d.odds.big),
    },
    modestMultiple: num(o.modest_multiple, d.modestMultiple),
    bigMultiple: num(o.big_multiple, d.bigMultiple),
  }
}

function job(v: unknown, i: number, personId: string): Job {
  const o = obj(v)
  const id = str(o.id, `${personId}-job-${i}`)
  return {
    id,
    employer: str(o.employer, `Job ${i + 1}`),
    enabled: o.enabled !== false,
    start: ym(o.start),
    leave: ym(o.leave),
    salary: salarySteps(o.salary),
    grants: arr(o.grants).map((g, k) => grant(g, k, id)),
    equity: equityOutcome(o.equity),
  }
}

function person(v: unknown, d: Person): Person {
  const o = obj(v)
  const sp = obj(o.spending)
  const nw = o.net_worth
  const id = str(o.id, d.id)
  // Older configs had a flat `salary` list on the person: one open job.
  const legacy = salarySteps(o.salary)
  const jobs = arr(o.jobs).length
    ? arr(o.jobs).map((j, i) => job(j, i, id))
    : legacy.length
      ? [{ ...demoJob(`${id}-job`, "Current job", legacy) }]
      : d.jobs
  return {
    id,
    name: str(o.name, d.name),
    birthYear: num(o.birth_year, d.birthYear),
    workState: WORK_STATE_VALUES.includes(o.work_state as WorkState)
      ? (o.work_state as WorkState)
      : d.workState,
    pretax: {
      hsa: num(obj(o.pretax).hsa, d.pretax.hsa),
      commuter: num(obj(o.pretax).commuter, d.pretax.commuter),
    },
    otherIncome: num(o.other_income, d.otherIncome),
    k401Deferral: num(o.k401_deferral, d.k401Deferral),
    netWorth:
      nw === "ledger"
        ? "ledger"
        : num(nw, d.netWorth === "ledger" ? 0 : d.netWorth),
    jobs,
    spending: {
      housing: num(sp.housing, d.spending.housing),
      car: num(sp.car, d.spending.car),
      discretionary: num(sp.discretionary, d.spending.discretionary),
      essentials: num(sp.essentials, d.spending.essentials),
    },
  }
}

function event(v: unknown, i: number): FireEvent | null {
  const o = obj(v)
  const base = {
    id: str(o.id, `event-${i}`),
    label: str(o.label, str(o.kind, "Event")),
    year: num(o.year, new Date().getFullYear()),
    enabled: o.enabled !== false,
  }
  switch (o.kind) {
    case "lump":
      return { ...base, kind: "lump", amount: num(o.amount, 0) }
    case "marker":
      return { ...base, kind: "marker" }
    case "kid":
      return { ...base, kind: "kid" }
    case "japan":
    case "abroad":
      return {
        ...base,
        kind: "japan",
        years: num(o.years, 2),
        netSaving: num(o.net_saving, 0),
      }
    case "crash":
      return { ...base, kind: "crash", drop: num(o.drop, 0.4) }
    case "lifestyle":
      return {
        ...base,
        kind: "lifestyle",
        amount: num(o.amount, 0),
        endYear: typeof o.end_year === "number" ? o.end_year : null,
        retirement: o.retirement === true,
      }
    default:
      return null
  }
}

export function inputsFromConfig(config: Raw): Inputs {
  const d = DEMO_INPUTS
  const a = obj(config.assumptions)
  const rs = obj(config.retirement_spend)
  const rawPeople = arr(config.people)
  const people = rawPeople.length
    ? rawPeople.map((p, i) =>
        person(p, d.people[Math.min(i, d.people.length - 1)])
      )
    : d.people
  const startYear = num(config.start_year, d.startYear)
  const bands = arr(obj(config.kids).cost_by_age)
    .map((b) => obj(b))
    .map((b) => ({
      from: num(b.from, 0),
      to: num(b.to, 0),
      amount: num(b.amount, 0),
    }))

  return {
    ...d,
    startYear,
    endAge: num(config.end_age, d.endAge),
    path:
      config.path === "coast" || config.path === "barista"
        ? config.path
        : d.path,
    baristaIncome: num(config.barista_income, d.baristaIncome),
    assumptions: {
      realReturn: num(a.real_return, d.assumptions.realReturn),
      returnVolatility: num(
        a.return_volatility,
        d.assumptions.returnVolatility
      ),
      swr: num(a.swr, d.assumptions.swr),
      coastAge: num(a.coast_age, d.assumptions.coastAge),
      realRaiseGrowth: num(a.real_raise_growth, d.assumptions.realRaiseGrowth),
      k401Limit: num(a.k401_limit, d.assumptions.k401Limit),
    },
    retirementSpend: {
      individual: tiers(rs.individual, d.retirementSpend.individual),
      household: tiers(rs.household, d.retirementSpend.household),
    },
    primaryShare: num(obj(config.household).primary_share, d.primaryShare),
    marriageYear:
      typeof obj(config.household).marriage_year === "number"
        ? (obj(config.household).marriage_year as number)
        : d.marriageYear,
    people,
    kidCosts: bands.length ? bands : d.kidCosts,
    events: arr(config.events)
      .map(event)
      .filter((e): e is FireEvent => e !== null),
  }
}

/** A saved scenario stores a full `Inputs`; merge onto the config so fields
 * added after it was saved still have values. */
export function applyScenario(base: Inputs, scenario: Scenario): Inputs {
  const o = scenario.overrides as Partial<Inputs>
  return {
    ...base,
    ...o,
    assumptions: { ...base.assumptions, ...(o.assumptions ?? {}) },
    retirementSpend: { ...base.retirementSpend, ...(o.retirementSpend ?? {}) },
  }
}

export function parseFireData(raw: unknown): FireData {
  const data = FireDataSchema.parse(raw)
  const fromConfig = Object.keys(data.config).length > 0
  return {
    snapshot: data.snapshot,
    inputs: fromConfig ? inputsFromConfig(data.config) : DEMO_INPUTS,
    fromConfig,
    scenarios: data.scenarios as Scenario[],
  }
}
