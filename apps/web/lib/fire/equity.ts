// Jobs and equity: when each job runs, what it pays in a given year, how much
// of each grant has vested by a month, and what a job's equity pays out.
// Pure functions; the engine turns the results into salary and lump sums.

import type { Grant, Inputs, Job, Person } from "./types"

/** "YYYY-MM" → absolute month index (year * 12 + month - 1). */
export function monthIndex(ym: string): number {
  const [y, m] = ym.split("-").map(Number)
  return y * 12 + ((m || 1) - 1)
}

export function monthLabel(idx: number): string {
  const y = Math.floor(idx / 12)
  return `${y}-${String((idx % 12) + 1).padStart(2, "0")}`
}

export interface JobWindow {
  job: Job
  /** First and last month employed; ±Infinity when open. */
  from: number
  to: number
}

/** Enabled jobs with their effective span. A job ends at its own `leave`, or
 * the month before the person's next enabled job starts, whichever is
 * earlier, so adding "next job" ends the current one without a second edit. */
export function jobWindows(person: Person): JobWindow[] {
  const jobs = person.jobs
    .filter((j) => j.enabled)
    .map((job) => ({
      job,
      from: job.start ? monthIndex(job.start) : Number.NEGATIVE_INFINITY,
      own: job.leave ? monthIndex(job.leave) : Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.from - b.from)
  return jobs.map((j, i) => {
    const next = jobs[i + 1]
    const cut = next ? next.from - 1 : Number.POSITIVE_INFINITY
    return { job: j.job, from: j.from, to: Math.min(j.own, cut) }
  })
}

/** Gross pay in `year`: each job's salary step in force, scaled by the share
 * of the year worked there, so a gap between jobs earns nothing. */
export function grossFor(inputs: Inputs, person: Person, year: number): number {
  let total = 0
  for (const w of jobWindows(person)) {
    const yFrom = year * 12
    const yTo = year * 12 + 11
    const months = Math.min(w.to, yTo) - Math.max(w.from, yFrom) + 1
    if (months <= 0) continue
    const steps = w.job.salary
      .filter((s) => s.enabled)
      .sort((a, b) => a.year - b.year)
    const step = steps.filter((s) => s.year <= year).at(-1) ?? steps[0]
    if (!step) continue
    const grown =
      step.gross *
      (1 + inputs.assumptions.realRaiseGrowth) ** Math.max(0, year - step.year)
    total += (grown * months) / 12
  }
  return total
}

function trancheVested(
  shares: number,
  monthsIn: number,
  vestMonths: number,
  cliffMonths: number
): number {
  if (monthsIn < cliffMonths || monthsIn <= 0) return 0
  return (shares * Math.min(monthsIn, vestMonths)) / Math.max(1, vestMonths)
}

/** Shares vested by month index `at` (monthly vesting, whole months). */
export function vestedShares(g: Grant, at: number): number {
  const start = monthIndex(g.vestStart)
  if (!g.halves) {
    return trancheVested(g.shares, at - start, g.vestMonths, g.cliffMonths)
  }
  const half = g.shares / 2
  return (
    trancheVested(half, at - start, g.vestMonths, g.cliffMonths) +
    trancheVested(
      half,
      at - start - g.halfOffsetMonths,
      g.vestMonths,
      g.cliffMonths
    )
  )
}

export interface JobEquity {
  job: Job
  /** Month vesting stops: leaving, or the liquidity event if still there. */
  vestUntil: number
  vested: number
  total: number
  /** Cash to exercise vested options on leaving (0 if not required). */
  exerciseCost: number
  exerciseYear: number | null
  /** After-tax proceeds at the liquidity year for a given outcome. */
  payout: (multiple: number) => number
}

export function jobEquity(person: Person): JobEquity[] {
  const out: JobEquity[] = []
  for (const w of jobWindows(person)) {
    const { job } = w
    if (!job.grants.length) continue
    const eq = job.equity
    const liquidity = eq.liquidityYear * 12 + 11
    const vestUntil = Math.min(w.to, liquidity)
    const vested = job.grants.map((g) => ({ g, n: vestedShares(g, vestUntil) }))
    const leftEarly = Number.isFinite(w.to) && w.to < liquidity
    const exerciseCost =
      eq.exerciseAtLeave && leftEarly
        ? vested.reduce(
            (a, v) => a + (v.g.type === "rsu" ? 0 : v.n * v.g.strike),
            0
          )
        : 0
    out.push({
      job,
      vestUntil,
      vested: vested.reduce((a, v) => a + v.n, 0),
      total: job.grants.reduce((a, g) => a + g.shares, 0),
      exerciseCost,
      exerciseYear: exerciseCost > 0 ? Math.floor(w.to / 12) : null,
      payout: (multiple) => {
        let gain = 0
        for (const v of vested) {
          const exitPrice = v.g.price * multiple * (1 - eq.dilution)
          // Strike already paid at leave is a sunk cost, not netted here.
          const strike = v.g.type === "rsu" || exerciseCost > 0 ? 0 : v.g.strike
          gain += v.n * Math.max(0, exitPrice - strike)
        }
        return gain * (1 - eq.taxRate)
      },
    })
  }
  return out
}

export interface EquityLump {
  year: number
  amount: number
  label: string
}

/** Lump sums from every active person's equity. `multiples` overrides the
 * outcome per job id (Monte Carlo draws); otherwise each job's own. */
export function equityLumps(
  people: Person[],
  multiples?: Record<string, number>
): EquityLump[] {
  const lumps: EquityLump[] = []
  for (const p of people) {
    for (const e of jobEquity(p)) {
      if (!e.job.equity.enabled) continue
      if (e.exerciseCost > 0 && e.exerciseYear !== null) {
        lumps.push({
          year: e.exerciseYear,
          amount: -e.exerciseCost,
          label: `${e.job.employer} exercise`,
        })
      }
      const m = multiples?.[e.job.id] ?? e.job.equity.multiple
      lumps.push({
        year: e.job.equity.liquidityYear,
        amount: e.payout(m),
        label: `${e.job.employer} liquidity`,
      })
    }
  }
  return lumps
}
