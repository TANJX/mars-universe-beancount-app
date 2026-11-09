// Runway engine: monthly take-home, outflows and sleeve balances for one
// person and one job scenario. Pure and deterministic; no React.
//
// Two passes, in this order (the order matters, the numbers depend on it):
//   1. Paychecks. Walk every pay date, pick the employer and gross, apply the
//      401k election under the annual limit, the employer match, payroll
//      withholding, and tally net pay, 401k and match per month.
//   2. Balances. Month by month: growth, 401k and match (with vesting and
//      forfeiture), pay minus outflows into checking, top checking up from the
//      reserve then the emergency fund then the core, sweep extra cash to the
//      emergency fund then the reserve, keep the emergency fund at target,
//      then move whatever the reserve holds above (earmarks + the next 12
//      months of shortfall) into the core, spread over a set number of months.
//
// The play and gold sleeves get no new money; they only grow.

import { paycheck } from "./paycheck"
import {
  endOfMonth,
  isoDate,
  monthSpan,
  paydates,
  periodsPerYear,
  ym,
} from "./schedule"
import type {
  Election,
  Job,
  JobScenario,
  Match,
  MonthRow,
  PaycheckRow,
  RunwayInputs,
  RunwayResult,
  SleeveKey,
} from "./types"

const EQUITY_SLEEVES: SleeveKey[] = ["core", "play", "ira", "k401", "hsa"]

/** Limit for a year, reusing the closest earlier year when it is missing. */
export function limitFor(limits: Record<string, number>, year: number): number {
  if (limits[year] != null) return limits[year]
  const known = Object.keys(limits)
    .map(Number)
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b)
  const earlier = known.filter((y) => y <= year).at(-1)
  const pick = earlier ?? known[0]
  return pick != null ? limits[pick] : 0
}

/** The latest election whose `from` month is on or before `month`. */
export function electionAt(
  elections: Election[],
  month: string
): Election | null {
  let best: Election | null = null
  for (const e of elections)
    if (e.from <= month && (!best || e.from >= best.from)) best = e
  return best
}

export function matchFor(match: Match, gross: number, contrib: number): number {
  if (gross <= 0) return 0
  switch (match.type) {
    case "none":
      return 0
    case "flat":
      return gross * match.pct
    case "threshold":
      return contrib >= gross * match.minPct ? gross * match.pct : 0
    case "tiered": {
      const c = contrib / gross
      let floor = 0
      let total = 0
      for (const t of match.tiers) {
        const width = Math.max(0, t.upToPct - floor)
        total += t.rate * Math.max(0, Math.min(c - floor, width)) * gross
        floor = t.upToPct
      }
      return total
    }
  }
}

/** Number of raise months strictly after `after` and on or before `month`. */
function raisesBetween(raiseMonth: number, after: string, month: string) {
  let n = 0
  const y0 = Number(after.slice(0, 4))
  const y1 = Number(month.slice(0, 4))
  for (let y = y0; y <= y1; y++) {
    const r = `${y}-${String(raiseMonth).padStart(2, "0")}`
    if (r > after && r <= month) n++
  }
  return n
}

function scenarioOf(inputs: RunwayInputs, id: string): JobScenario {
  const s = inputs.person.scenarios.find((x) => x.id === id)
  return s ?? { id: "stay", label: "Stay", start: null, job: null }
}

function grossFor(job: Job, after: string, month: string): number {
  const P = periodsPerYear(job.schedule.frequency)
  const n = job.raise ? raisesBetween(job.raise.month, after, month) : 0
  return (job.grossAnnual * (1 + (job.raise?.pct ?? 0)) ** n) / P
}

export function simulate(
  inputs: RunwayInputs,
  scenarioId: string
): RunwayResult {
  const { person: p, horizon: h } = inputs
  const scen = scenarioOf(inputs, scenarioId)
  const months = monthSpan(h.start, h.months)
  const lastMonth = months.at(-1) ?? h.start
  const newJob = scen.job && scen.start ? scen.job : null
  const newStart = newJob ? (scen.start as string) : null
  const isNew = (m: string) => newStart != null && m >= newStart
  const jobAt = (m: string): Job => (isNew(m) && newJob ? newJob : p.job)

  // Pay dates follow each job's own schedule; the switch happens at the start
  // of the new job's first month.
  const through = isoDate(endOfMonth(lastMonth))
  const curDates = paydates(p.job.schedule, h.asof, through).filter(
    (d) => !isNew(ym(d))
  )
  const newDates =
    newJob && newStart
      ? paydates(newJob.schedule, h.asof, through).filter((d) => isNew(ym(d)))
      : []
  const dates = [...curDates, ...newDates].sort(
    (a, b) => a.getTime() - b.getTime()
  )
  // For counting the checks left in a year (max_spread). "horizon" spreads
  // the limit over the checks inside the horizon only, as the prototype did.
  let countDates = dates
  if (h.spreadThrough === "year_end") {
    const yearEnd = `${lastMonth.slice(0, 4)}-12-31`
    const job = jobAt(lastMonth)
    const extra = paydates(job.schedule, through, yearEnd)
    countDates = [...dates, ...extra]
  }

  const vestMonth = p.job.vesting ? p.job.vesting.date.slice(0, 7) : null

  // ---- pass 1: paychecks
  const pay: Record<string, number> = {}
  const k4: Record<string, number> = {}
  const mt: Record<string, number> = {}
  const nChecks: Record<string, number> = {}
  const toSleeve: Record<string, Partial<Record<string, number>>> = {}
  const events: Record<string, string[]> = {}
  const addEvent = (m: string, e: string) => {
    const list = events[m] ?? []
    if (!list.includes(e)) list.push(e)
    events[m] = list
  }
  const paychecks: PaycheckRow[] = []
  const limitHit: Record<string, string> = {}
  let forfeitMonth: string | null = null
  let prevEmployer: "current" | "new" | null = null
  let year = 0
  let ytd = 0
  let ytdSs = 0
  let ytdSp = 0

  for (const d of dates) {
    const m = ym(d)
    const y = d.getUTCFullYear()
    if (y !== year) {
      year = y
      ytd = p.k401.ytd[y] ?? 0
      ytdSs = 0
      ytdSp = 0
    }
    const employer = isNew(m) ? "new" : "current"
    const job = jobAt(m)
    if (
      prevEmployer === "current" &&
      employer === "new" &&
      vestMonth &&
      m < vestMonth
    )
      forfeitMonth = m
    if (prevEmployer === "current" && employer === "new")
      addEvent(m, "New job starts")
    prevEmployer = employer

    const gross = grossFor(
      job,
      employer === "new" && newStart && newStart > h.start ? newStart : h.start,
      m
    )
    const limit = limitFor(p.k401.limits, y)
    const room = Math.max(0, limit - ytd)
    const e = electionAt(p.k401.elections, m)
    let pre = 0
    let roth = 0
    if (e?.mode === "fixed") {
      pre = Math.min(e.pretax, room)
      roth = Math.min(e.roth, room - pre)
    } else if (e?.mode === "percent") {
      pre = Math.min(gross * e.pretaxPct, room)
      roth = Math.min(gross * e.rothPct, room - pre)
    } else if (e?.mode === "max_spread") {
      const t = d.getTime()
      const left = countDates.filter(
        (x) => x.getUTCFullYear() === y && x.getTime() >= t
      ).length
      const x = Math.max(
        0,
        Math.min(room / Math.max(1, left), gross * e.capPct)
      )
      pre = x * (1 - e.rothShare)
      roth = x * e.rothShare
    }
    pre = Math.max(0, pre)
    roth = Math.max(0, roth)
    ytd += pre + roth
    if (limit > 0 && ytd >= limit - 0.005 && !limitHit[y]) {
      limitHit[y] = isoDate(d)
      if (e?.mode !== "max_spread") addEvent(m, "401k limit reached")
    }

    const match = matchFor(job.match, gross, pre + roth)
    const nth = (nChecks[m] ?? 0) + 1
    nChecks[m] = nth
    const pc = paycheck({
      gross,
      pre,
      roth,
      job,
      paycheckOfMonth: nth,
      ytdStatePayroll: ytdSp,
      ytdSsWages: ytdSs,
    })
    ytdSs += pc.ssWages
    ytdSp += pc.statePayroll - job.withholding.statePayroll.flatPerPaycheck

    pay[m] = (pay[m] ?? 0) + pc.net
    k4[m] = (k4[m] ?? 0) + pre + roth
    mt[m] = (mt[m] ?? 0) + match
    const ts = toSleeve[m] ?? {}
    for (const [k, v] of Object.entries(pc.toSleeves))
      ts[k] = (ts[k] ?? 0) + (v ?? 0)
    toSleeve[m] = ts
    paychecks.push({
      date: isoDate(d),
      month: m,
      employer,
      gross,
      pre,
      roth,
      pretaxDeductions: pc.pretaxDeductions,
      postTaxDeductions: pc.postTaxDeductions,
      federal: pc.federal,
      state: pc.state,
      fica: pc.fica,
      statePayroll: pc.statePayroll,
      net: pc.net,
      match,
    })
  }
  if (forfeitMonth) addEvent(forfeitMonth, "Match forfeited")

  // Raise markers (current job only; the new job's raise is its own).
  if (p.job.raise)
    for (const m of months)
      if (
        !isNew(m) &&
        m > h.start &&
        Number(m.slice(5)) === p.job.raise.month &&
        p.job.raise.pct !== 0
      )
        addEvent(m, "Raise")

  // ---- outflows
  const spending = Math.max(0, p.spendingMonthly)
  const spendOut: Record<string, number> = {}
  const iraOut: Record<string, number> = {}
  const taxOut: Record<string, number> = {}
  const out: Record<string, number> = {}
  const need: Record<string, number> = {}
  months.forEach((m, i) => {
    spendOut[m] = spending * (i === 0 ? h.firstMonthSpendFraction : 1)
    iraOut[m] =
      p.ira && Number(m.slice(5)) === p.ira.month
        ? Math.max(0, p.ira.amount)
        : 0
    if (iraOut[m] > 0) addEvent(m, "IRA deposit")
    taxOut[m] = 0
    for (const o of p.oneOffs)
      if (o.month === m) {
        taxOut[m] += o.amount
        if (o.amount !== 0) addEvent(m, o.label || "Tax due")
      }
    out[m] = spendOut[m] + iraOut[m] + taxOut[m]
    need[m] = Math.max(0, out[m] - (pay[m] ?? 0))
  })

  // ---- pass 2: balances
  const s = p.starting
  const b: Record<SleeveKey, number> = { ...s.sleeves }
  for (const k of ["checking", "ef", "reserve"] as const)
    b[k] -= s.cards * (p.cash.cardPayoff[k] ?? 0)
  let unvested = p.job.vesting ? s.unvested : 0
  const loans = s.loans
  const startNetWorth =
    Object.values(s.sleeves).reduce((a, v) => a + v, 0) - s.cards - loans

  const efT = Math.max(0, p.cash.efMonths) * spending
  const buf = Math.max(0, p.cash.buffer)
  const earmarks = p.cash.earmarks.reduce(
    (a, e) => a + Math.max(0, e.amount),
    0
  )
  const N = Math.max(1, Math.round(p.cash.dcaMonths))
  const look = Math.max(0, Math.round(h.reserveLookahead))
  const resNeed = (i: number) =>
    earmarks +
    months.slice(i + 1, i + 1 + look).reduce((a, m) => a + need[m], 0)
  const startExcess = Math.max(0, b.reserve - resNeed(0))
  const step = startExcess / N

  const r = {
    eq: p.returns.equity / 12,
    res: p.returns.reserve / 12,
    ef: p.returns.ef / 12,
    gold: p.returns.gold / 12,
  }
  const rows: MonthRow[] = []
  let efDrawn = 0
  let efDrawnMonth: string | null = null
  let coreDrawn = 0
  let coreDrawnMonth: string | null = null
  let forfeited = 0
  let minChecking = Number.POSITIVE_INFINITY
  let unfundedPeak = 0
  let unfundedPeakMonth: string | null = null
  const unfundedMonths: string[] = []

  months.forEach((m, i) => {
    for (const k of EQUITY_SLEEVES) b[k] *= 1 + r.eq
    b.gold *= 1 + r.gold
    b.reserve *= 1 + r.res
    b.ef *= 1 + r.ef

    b.k401 += (k4[m] ?? 0) + (mt[m] ?? 0)
    if (!isNew(m)) unvested += mt[m] ?? 0
    if (forfeitMonth === m) {
      b.k401 -= unvested
      forfeited = unvested
      unvested = 0
    }
    if (vestMonth && m >= vestMonth && forfeitMonth === null) unvested = 0
    if (!p.job.vesting) unvested = 0

    for (const [k, v] of Object.entries(toSleeve[m] ?? {}))
      if (k in b) b[k as SleeveKey] += v ?? 0

    b.checking += (pay[m] ?? 0) - out[m]
    b.ira += iraOut[m]

    if (b.checking < buf) {
      let gap = buf - b.checking
      const fromRes = Math.min(gap, Math.max(0, b.reserve))
      b.reserve -= fromRes
      gap -= fromRes
      const fromEf = Math.min(gap, Math.max(0, b.ef))
      b.ef -= fromEf
      gap -= fromEf
      efDrawn += fromEf
      if (fromEf > 0 && !efDrawnMonth) efDrawnMonth = m
      const fromCore = Math.min(gap, Math.max(0, b.core))
      b.core -= fromCore
      coreDrawn += fromCore
      if (fromCore > 0 && !coreDrawnMonth) coreDrawnMonth = m
      gap -= fromCore
      b.checking = buf - gap
    }
    // Every source is empty and checking is still negative: an unfunded
    // deficit (card debt or missed bills in real life). Track it explicitly.
    if (b.checking < -0.005) {
      unfundedMonths.push(m)
      if (-b.checking > unfundedPeak) {
        unfundedPeak = -b.checking
        unfundedPeakMonth = m
      }
    }
    minChecking = Math.min(minChecking, b.checking)
    if (b.checking > buf) {
      let x = b.checking - buf
      b.checking = buf
      const toEf = Math.max(0, Math.min(x, efT - b.ef))
      b.ef += toEf
      x -= toEf
      b.reserve += x
    }
    if (b.ef > efT) {
      b.reserve += b.ef - efT
      b.ef = efT
    }
    if (b.ef < efT) {
      const t = Math.min(efT - b.ef, Math.max(0, b.reserve - resNeed(i)))
      b.ef += t
      b.reserve -= t
    }
    const excess = Math.max(0, b.reserve - resNeed(i))
    const moved = i < N ? Math.min(excess, step) : excess
    b.reserve -= moved
    b.core += moved

    const invested = b.core + b.play + b.gold + b.ira + b.k401 + b.hsa
    const cash = b.checking + b.ef + b.reserve
    rows.push({
      month: m,
      takeHome: pay[m] ?? 0,
      outflows: out[m],
      shortfall: need[m],
      spendOut: spendOut[m],
      iraOut: iraOut[m],
      taxOut: taxOut[m],
      k401In: k4[m] ?? 0,
      match: mt[m] ?? 0,
      reserveToCore: moved,
      paychecks: nChecks[m] ?? 0,
      checking: b.checking,
      ef: b.ef,
      reserve: b.reserve,
      core: b.core,
      ira: b.ira,
      k401: b.k401,
      hsa: b.hsa,
      gold: b.gold,
      play: b.play,
      other: b.other,
      unvested,
      invested,
      cash,
      netWorth: cash + invested + b.other - loans,
      playShare: invested > 0 ? b.play / invested : 0,
      events: events[m] ?? [],
    })
  })

  const sum = (o: Record<string, number>) =>
    Object.values(o).reduce((a, v) => a + v, 0)
  return {
    rows,
    paychecks,
    startNetWorth,
    forfeitMonth,
    forfeited,
    limitHit,
    efDrawn,
    efDrawnMonth,
    coreDrawn,
    coreDrawnMonth,
    minChecking: Number.isFinite(minChecking) ? minChecking : 0,
    unfundedMonths,
    unfundedPeak,
    unfundedPeakMonth,
    k401Contributed: sum(k4),
    matchTotal: sum(mt),
    shortfallTotal: months.reduce((a, m) => a + need[m], 0),
    movedToCore: rows.reduce((a, row) => a + row.reserveToCore, 0),
    shortMonths: rows.filter((row) => row.shortfall > 0).length,
  }
}

export function compareScenarios(
  inputs: RunwayInputs
): Record<string, RunwayResult> {
  const out: Record<string, RunwayResult> = {}
  for (const s of inputs.person.scenarios) out[s.id] = simulate(inputs, s.id)
  return out
}

/** Average monthly take-home over the calendar year `year` (12 months, as
 * the prototype divides, even when fewer are in the horizon). */
export function avgTakeHome(result: RunwayResult, year: string): number {
  const rows = result.rows.filter((r) => r.month.startsWith(year))
  return rows.reduce((a, r) => a + r.takeHome, 0) / 12
}
