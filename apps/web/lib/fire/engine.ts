// FIRE projection engine. Pure functions of `Inputs`; no React, no I/O.
//
// Annual steps in real (today's) dollars. Each year: take-home after any 401k
// deferral, minus spending, plus lumps, all landing at year end after the
// year's return. `inputs.path` decides what happens when a line is crossed:
//   normal   save until the FI target, then withdraw the retirement spend.
//   coast    save until the coast line, then save nothing (work covers costs)
//            until the full retirement age (`coastAge`), then withdraw; sooner
//            if the portfolio reaches the full FI target first.
//   barista  save until the portfolio plus side income covers spending, then
//            withdraw only the gap until the full retirement age, then the
//            full spend.
// Withdrawals include any kid costs still running, so the chart answers both
// "when" and "does it last".

import { equityLumps, grossFor, jobWindows, monthLabel } from "./equity"
import { type WageTax, wageTaxes } from "./tax"
import type {
  FireEvent,
  Inputs,
  Person,
  Phase,
  SimResult,
  Snapshot,
  YearRow,
} from "./types"

export function ledgerNetWorth(snapshot: Snapshot | null): number {
  if (!snapshot) return 0
  return Object.values(snapshot.buckets).reduce((a, b) => a + b, 0)
}

export function activePeople(inputs: Inputs): Person[] {
  return inputs.mode === "household" ? inputs.people : inputs.people.slice(0, 1)
}

function enabled<K extends FireEvent["kind"]>(
  inputs: Inputs,
  kind: K
): Extract<FireEvent, { kind: K }>[] {
  return inputs.events.filter(
    (e): e is Extract<FireEvent, { kind: K }> => e.kind === kind && e.enabled
  )
}

/** Shared-cost scale: the primary person carries `primaryShare` alone. */
function shareScale(inputs: Inputs): number {
  return inputs.mode === "household" ? 1 : inputs.primaryShare
}

export { grossFor }

export function kidCostIn(inputs: Inputs, year: number): number {
  let total = 0
  for (const kid of enabled(inputs, "kid")) {
    const age = year - kid.year
    const band = inputs.kidCosts.find((b) => age >= b.from && age <= b.to)
    if (band) total += band.amount
  }
  return total * shareScale(inputs)
}

/** Present value at the end of `year` of kid costs from `year + 1` on. */
function kidCostPV(inputs: Inputs, year: number, r: number): number {
  let pv = 0
  for (let y = year + 1; y <= year + 25; y++) {
    pv += kidCostIn(inputs, y) / (1 + r) ** (y - year)
  }
  return pv
}

/** Lifestyle steps in force in `year` (working-years spending). */
function lifestyleIn(inputs: Inputs, year: number): number {
  let total = 0
  for (const e of enabled(inputs, "lifestyle")) {
    if (year >= e.year && (e.endYear === null || year <= e.endYear)) {
      total += e.amount
    }
  }
  return total
}

/** The tier (or custom) spend plus every open-ended lifestyle step marked as
 * carrying into retirement, whatever its start year: a permanent change of
 * lifestyle belongs in the FI target from the start. */
export function retirementSpend(inputs: Inputs): number {
  const tiers =
    inputs.mode === "household"
      ? inputs.retirementSpend.household
      : inputs.retirementSpend.individual
  const tier =
    inputs.tier === "custom" ? inputs.customSpend : tiers[inputs.tier]
  let steps = 0
  for (const e of enabled(inputs, "lifestyle")) {
    if (e.retirement && e.endYear === null) steps += e.amount
  }
  return Math.max(0, tier + steps)
}

function workingSpend(inputs: Inputs, year: number): number {
  let spend = 0
  for (const p of activePeople(inputs)) {
    const s = p.spending
    spend += s.housing + s.car + s.discretionary + s.essentials
  }
  return Math.max(0, spend + lifestyleIn(inputs, year))
}

function startPortfolio(inputs: Inputs, snapshot: Snapshot | null): number {
  const ledger = ledgerNetWorth(snapshot)
  let p = 0
  for (const person of activePeople(inputs)) {
    p += person.netWorth === "ledger" ? ledger : person.netWorth
  }
  return p
}

/** Saving for the part of the snapshot year still ahead (Oct → Dec, say). */
function remainderSaving(inputs: Inputs, snapshot: Snapshot | null): number {
  if (!snapshot) return 0
  const asof = new Date(`${snapshot.asof}T00:00:00`)
  const year = asof.getFullYear()
  if (year >= inputs.startYear) return 0
  const end = new Date(year, 11, 31)
  const frac = Math.max(0, (end.getTime() - asof.getTime()) / (365 * 864e5))
  const pay = wagesFor(inputs, year)
  return (
    (pay.takeHome + pay.k401 - workingSpend(inputs, inputs.startYear)) * frac
  )
}

export interface Wages {
  /** Active people only: take-home after 401k and taxes, plus other income. */
  takeHome: number
  k401: number
  /** Per person (everyone, active or not), for display. */
  taxes: WageTax[]
  joint: boolean
}

/** One year's pay after tax. Tax is computed on everyone's wages, so a joint
 * return is right even when the plan only follows the primary person; only
 * the active people's take-home counts toward saving. */
export function wagesFor(inputs: Inputs, year: number): Wages {
  const a = inputs.assumptions
  const earners = inputs.people.map((person) => {
    const gross = grossFor(inputs, person, year)
    return {
      person,
      gross,
      k401: Math.min(person.k401Deferral, a.k401Limit, gross),
    }
  })
  const joint =
    inputs.marriageYear !== null &&
    year >= inputs.marriageYear &&
    earners.length > 1
  const taxes = wageTaxes(earners, joint)
  let takeHome = 0
  let k401 = 0
  for (const p of activePeople(inputs)) {
    const t = taxes.find((x) => x.personId === p.id)
    const e = earners.find((x) => x.person.id === p.id)
    if (!t || !e) continue
    takeHome += t.takeHome + p.otherIncome
    k401 += e.k401
  }
  return { takeHome, k401, taxes, joint }
}

export interface SimOptions {
  /** Real return per year, indexed from `startYear`; defaults to the mean. */
  returns?: number[]
  /** Equity outcome multiple per job id (Monte Carlo draws). */
  equityMultiples?: Record<string, number>
}

export function simulate(
  inputs: Inputs,
  snapshot: Snapshot | null,
  opts: SimOptions = {}
): SimResult {
  const a = inputs.assumptions
  const r = a.realReturn
  const people = activePeople(inputs)
  const primary = people[0]
  const endYear = primary.birthYear + inputs.endAge
  const spendRet = retirementSpend(inputs)
  const baseTarget = spendRet / a.swr
  const side = inputs.path === "barista" ? inputs.baristaIncome : 0
  const baristaBase = Math.max(0, spendRet - side) / a.swr

  const coastYear = primary.birthYear + a.coastAge
  const coastAtTarget = baseTarget + kidCostPV(inputs, coastYear, r)

  const japan = enabled(inputs, "japan")
  const crashes = enabled(inputs, "crash")
  const lumps = enabled(inputs, "lump")
  const equity = equityLumps(people, opts.equityMultiples)

  const now = startPortfolio(inputs, snapshot)
  const p0 = now + remainderSaving(inputs, snapshot)
  let p = p0
  let phase: Phase = "saving"
  let fiYear: number | null = null
  let freeYear: number | null = null
  let drawYear: number | null = null
  let coastHit: number | null = null
  let depletedYear: number | null = null
  const rows: YearRow[] = []

  // Baseline: the snapshot year, ending at today's ledger value plus the
  // saving still to come this year. Every projected row builds on it.
  const baseYear = inputs.startYear - 1
  rows.push({
    year: baseYear,
    ages: people.map((x) => baseYear - x.birthYear),
    takeHome: 0,
    spend: 0,
    kidCost: 0,
    k401: 0,
    saving: p0 - now,
    lump: 0,
    portfolio: p0,
    target: baseTarget + kidCostPV(inputs, baseYear, r),
    coastTarget:
      (baseTarget + kidCostPV(inputs, coastYear, r)) /
      (1 + r) ** (coastYear - baseYear),
    baseline: true,
    retired: false,
    phase: "saving",
    japan: false,
  })

  for (let year = inputs.startYear; year <= endYear; year++) {
    const i = year - inputs.startYear
    const ret = opts.returns?.[i] ?? r
    // Side work ends at the full retirement age; then full withdrawals.
    if (phase === "barista" && year >= coastYear) phase = "retired"
    if (phase === "coasting" && year >= coastYear) phase = "retired"
    const withdrawing = phase === "retired" || phase === "barista"
    if (withdrawing && drawYear === null) drawYear = year
    const j = japan.find((x) => year >= x.year && year < x.year + x.years)
    const kidCost = kidCostIn(inputs, year)

    let takeHome = 0
    let k401 = 0
    let spend = 0
    let saving: number

    if (phase === "retired") {
      spend = spendRet
      saving = -(spendRet + kidCost)
    } else if (phase === "barista") {
      spend = spendRet
      saving = -Math.max(0, spendRet + kidCost - side)
    } else if (j) {
      // Coasting never adds savings, but a drawn-down stint still costs.
      saving = phase === "coasting" ? Math.min(0, j.netSaving) : j.netSaving
    } else if (phase === "coasting") {
      // Work covers spending exactly: nothing in, nothing out.
      spend = workingSpend(inputs, year)
      saving = 0
    } else {
      const pay = wagesFor(inputs, year)
      takeHome = pay.takeHome
      k401 = pay.k401
      spend = workingSpend(inputs, year)
      saving = takeHome - spend - kidCost + k401
    }

    let lump = 0
    for (const l of lumps) if (l.year === year) lump += l.amount
    for (const e of equity) if (e.year === year) lump += e.amount

    p = p * (1 + ret) + saving + lump
    for (const c of crashes) if (c.year === year) p *= 1 - c.drop

    const kidPV = kidCostPV(inputs, year, r)
    const target = baseTarget + kidPV
    const coastTarget =
      year <= coastYear ? coastAtTarget / (1 + r) ** (coastYear - year) : target

    rows.push({
      year,
      ages: people.map((x) => year - x.birthYear),
      takeHome,
      spend,
      kidCost,
      k401,
      saving,
      lump,
      portfolio: p,
      target,
      coastTarget,
      baseline: false,
      retired: withdrawing,
      phase,
      japan: Boolean(j),
    })

    if (withdrawing && p < 0 && depletedYear === null) depletedYear = year
    if (fiYear === null && p >= target) fiYear = year
    if (coastHit === null && phase === "saving" && p >= coastTarget) {
      coastHit = year
    }

    // Phase changes take effect next year: the portfolio crossed a line at
    // the end of this one.
    if (phase === "saving" || phase === "coasting") {
      if (p >= target) {
        if (freeYear === null) freeYear = year
        phase = "retired"
      } else if (phase === "saving") {
        if (inputs.path === "coast" && p >= coastTarget && year < coastYear) {
          freeYear = year
          phase = "coasting"
        } else if (
          inputs.path === "barista" &&
          p >= baristaBase + kidPV &&
          year < coastYear
        ) {
          freeYear = year
          phase = "barista"
        }
      }
    }
  }

  return {
    rows,
    fiYear,
    freeYear,
    drawYear,
    coastYear: coastHit,
    nowPortfolio: now,
    startPortfolio: p0,
    retirementSpend: spendRet,
    targetToday: baseTarget + kidCostPV(inputs, inputs.startYear - 1, r),
    depletedYear,
  }
}

// ---------- Monte Carlo ----------

/** Small seeded PRNG so a given input set always draws the same paths. */
function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let x = t
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function normal(rand: () => number): number {
  const u = Math.max(rand(), 1e-12)
  const v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

export interface MonteCarlo {
  paths: number
  bands: { year: number; p10: number; p50: number; p90: number }[]
  fiYear: { p10: number | null; p50: number | null; p90: number | null }
  /** Share of paths that reach the path's free year before end age. */
  fiRate: number
  /** Share of paths that get free and never run out by end age. */
  successRate: number
  /** P(FI by year) for the cumulative curve. */
  fiByYear: { year: number; share: number }[]
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(q * sorted.length))
  )
  return sorted[idx]
}

export function monteCarlo(
  inputs: Inputs,
  snapshot: Snapshot | null,
  paths = 600,
  seed = 7
): MonteCarlo {
  const rand = mulberry32(seed)
  const years =
    inputs.people[0].birthYear + inputs.endAge - inputs.startYear + 1
  const { realReturn, returnVolatility } = inputs.assumptions
  const byYear = new Map<number, number[]>()
  const equityJobs = activePeople(inputs)
    .flatMap((p) => p.jobs)
    .filter((j) => j.enabled && j.equity.enabled && j.grants.length)
  const fiYears: number[] = []
  let ok = 0

  for (let k = 0; k < paths; k++) {
    const returns = Array.from(
      { length: years },
      () => realReturn + returnVolatility * normal(rand)
    )
    // Startup equity is the other big unknown: each path draws its own
    // fail / modest / big outcome per job from the odds.
    const equityMultiples: Record<string, number> = {}
    for (const j of equityJobs) {
      const { fail, modest, big } = j.equity.odds
      const u = rand() * Math.max(1e-9, fail + modest + big)
      equityMultiples[j.id] =
        u < fail
          ? 0
          : u < fail + modest
            ? j.equity.modestMultiple
            : j.equity.bigMultiple
    }
    const res = simulate(inputs, snapshot, { returns, equityMultiples })
    for (const row of res.rows) {
      const list = byYear.get(row.year) ?? []
      list.push(row.portfolio)
      byYear.set(row.year, list)
    }
    if (res.freeYear !== null) {
      fiYears.push(res.freeYear)
      if (res.depletedYear === null) ok++
    }
  }

  const bands = [...byYear.entries()].map(([year, vals]) => {
    const s = [...vals].sort((x, y) => x - y)
    return {
      year,
      p10: quantile(s, 0.1),
      p50: quantile(s, 0.5),
      p90: quantile(s, 0.9),
    }
  })
  // Unreached paths count as "never" (sorted last) so the percentiles stay
  // honest instead of describing only the lucky paths.
  const fiSorted = [
    ...fiYears.sort((x, y) => x - y),
    ...Array(paths - fiYears.length).fill(Number.POSITIVE_INFINITY),
  ]
  const pick = (q: number) => {
    const v = quantile(fiSorted, q)
    return Number.isFinite(v) ? v : null
  }
  const fiByYear = bands.map((b) => ({
    year: b.year,
    share: fiYears.filter((y) => y <= b.year).length / paths,
  }))

  return {
    paths,
    bands,
    fiYear: { p10: pick(0.1), p50: pick(0.5), p90: pick(0.9) },
    fiRate: fiYears.length / paths,
    successRate: ok / paths,
    fiByYear,
  }
}

// ---------- lever impact ----------

export interface LeverPreset {
  id: string
  label: string
  detail: string
  apply: (inputs: Inputs) => Inputs
}

function toggleEvent(
  inputs: Inputs,
  kind: FireEvent["kind"],
  on: boolean
): Inputs {
  return {
    ...inputs,
    events: inputs.events.map((e) =>
      e.kind === kind ? { ...e, enabled: on } : e
    ),
  }
}

function sumSpend(inputs: Inputs, pick: (s: Person["spending"]) => number) {
  return activePeople(inputs).reduce((a, p) => a + pick(p.spending), 0)
}

/** The plan plus one lifestyle step from the start year. */
function withStep(
  inputs: Inputs,
  id: string,
  amount: number,
  retirement = false
): Inputs {
  return {
    ...inputs,
    events: [
      ...inputs.events,
      {
        id: `preset-${id}`,
        kind: "lifestyle",
        label: id,
        year: inputs.startYear,
        enabled: true,
        amount,
        endYear: null,
        retirement,
      },
    ],
  }
}

export const LEVER_PRESETS: LeverPreset[] = [
  {
    id: "max401k",
    label: "Max the 401k",
    detail: "Traditional deferral at the limit, every working person",
    apply: (x) => ({
      ...x,
      people: x.people.map((p) => ({
        ...p,
        k401Deferral: x.assumptions.k401Limit,
      })),
    }),
  },
  {
    id: "housing",
    label: "Housing −$6k/yr",
    detail: "Cheaper lease or better split from the start year",
    apply: (x) => withStep(x, "housing", -6000),
  },
  {
    id: "car",
    label: "Drop the car",
    detail: "Car costs to zero from the start year",
    apply: (x) => withStep(x, "car", -sumSpend(x, (s) => s.car)),
  },
  {
    id: "trim",
    label: "Trim discretionary 30%",
    detail: "Restaurants, travel, purchases, leisure",
    apply: (x) =>
      withStep(x, "trim", -0.3 * sumSpend(x, (s) => s.discretionary)),
  },
  {
    id: "raise",
    label: "+$20k primary pay",
    detail: "Latest salary step of the last job $20k higher",
    apply: (x) => ({
      ...x,
      people: x.people.map((p, i) => {
        if (i > 0) return p
        const last = p.jobs.filter((j) => j.enabled).at(-1)
        if (!last) return p
        const latest = Math.max(
          ...last.salary.filter((s) => s.enabled).map((s) => s.year)
        )
        return {
          ...p,
          jobs: p.jobs.map((j) =>
            j !== last
              ? j
              : {
                  ...j,
                  salary: j.salary.map((s) =>
                    s.enabled && s.year === latest
                      ? { ...s, gross: s.gross + 20000 }
                      : s
                  ),
                }
          ),
        }
      }),
    }),
  },
  {
    id: "nokids",
    label: "No kids",
    detail: "Disable every kid event",
    apply: (x) => toggleEvent(x, "kid", false),
  },
  {
    id: "nojapan",
    label: "Skip Japan",
    detail: "Disable the Japan stint",
    apply: (x) => toggleEvent(x, "japan", false),
  },
  {
    id: "equity3",
    label: "Equity pays 3x",
    detail: "Every job's equity turns on at a 3x outcome",
    apply: (x) => ({
      ...x,
      people: x.people.map((p) => ({
        ...p,
        jobs: p.jobs.map((j) =>
          j.grants.length
            ? { ...j, equity: { ...j.equity, enabled: true, multiple: 3 } }
            : j
        ),
      })),
    }),
  },
  {
    id: "lifestyle",
    label: "Lifestyle +$10k/yr",
    detail: "Spend $10k more for good, retirement included",
    apply: (x) => withStep(x, "lifestyle", 10000, true),
  },
]

export interface LeverImpact {
  id: string
  label: string
  detail: string
  fiYear: number | null
  /** Years earlier (+) or later (−) than the current plan. */
  years: number | null
}

export function leverImpacts(
  inputs: Inputs,
  snapshot: Snapshot | null,
  baseFi: number | null
): LeverImpact[] {
  return LEVER_PRESETS.map((lv) => {
    const fi = simulate(lv.apply(inputs), snapshot).freeYear
    const years = fi !== null && baseFi !== null ? baseFi - fi : null
    return { id: lv.id, label: lv.label, detail: lv.detail, fiYear: fi, years }
  })
}

// ---------- timeline ----------

export interface TimelineMark {
  id: string
  year: number
  label: string
}

/** Everything that happens in a given year: enabled life events plus salary
 * steps inside the projection window (the step in force at the start is
 * today's pay, not an event). */
export function timelineMarks(inputs: Inputs): TimelineMark[] {
  const marks: TimelineMark[] = inputs.events
    .filter((e) => e.enabled)
    .map((e) => ({ id: e.id, year: e.year, label: e.label }))
  const first = inputs.startYear * 12
  for (const p of activePeople(inputs)) {
    const windows = jobWindows(p)
    for (const w of windows) {
      const { job } = w
      // Short on purpose: these label chart markers; detail stays in People.
      if (w.from >= first) {
        marks.push({
          id: `${job.id}-start`,
          year: Math.floor(w.from / 12),
          label: `${p.name} joins ${job.employer}`,
        })
      } else if (
        Number.isFinite(w.to) &&
        !windows.some((x) => x.from === w.to + 1)
      ) {
        marks.push({
          id: `${job.id}-leave`,
          year: Math.floor(w.to / 12),
          label: `${p.name} leaves ${job.employer} ${monthLabel(w.to).slice(5)}`,
        })
      }
      for (const s of job.salary) {
        const startYear = Number.isFinite(w.from) ? Math.floor(w.from / 12) : -1
        if (!s.enabled || s.year < inputs.startYear || s.year <= startYear)
          continue
        if (s.year * 12 > w.to) continue
        marks.push({
          id: `${job.id}-salary-${s.year}`,
          year: s.year,
          label: `${p.name} $${Math.round(s.gross / 1000)}k`,
        })
      }
      if (job.equity.enabled && job.grants.length) {
        marks.push({
          id: `${job.id}-liquidity`,
          year: job.equity.liquidityYear,
          label: `${job.employer} ${job.equity.multiple}x`,
        })
      }
    }
  }
  return marks.sort((a, b) => a.year - b.year)
}
