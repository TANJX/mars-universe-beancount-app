// Runway engine: monthly take-home, outflows and sleeve balances for one
// person and one job scenario. Pure and deterministic; no React.
//
// Two passes, in this order (the order matters, the numbers depend on it):
//   1. Paychecks and deposits. Walk the calendar month by month. On every pay
//      date pick the employer and gross, take each payroll contribution
//      stream (401k, HSA) under its pool's annual limit, add the employer
//      match and payroll withholding, and tally net pay per month. After the
//      month's paychecks, make the direct deposits (IRA, direct HSA) from
//      cash. Streams in one account share one running total per year, which
//      a job switch does not reset.
//   2. Balances. Month by month: growth, 401k and match (with vesting and
//      forfeiture), pay minus outflows into checking, top checking up from the
//      reserve then the emergency fund then the core, sweep extra cash to the
//      emergency fund then the reserve, keep the emergency fund at target,
//      then move whatever the reserve holds above (earmarks + the next 12
//      months of shortfall) into the core, spread over a set number of months.
//
// The play and gold sleeves get no new money; they only grow.

import {
  ACCOUNT_LABEL,
  directWant,
  payrollWant,
  phaseAt,
  poolLimit,
  tierAt,
  treatment,
} from "./contributions"
import { type Deferral, paycheck } from "./paycheck"
import {
  endOfMonth,
  isoDate,
  monthSpan,
  paydates,
  periodsPerYear,
  ym,
} from "./schedule"
import type {
  ContributionAccount,
  HsaCoverage,
  Job,
  JobScenario,
  Match,
  MonthRow,
  PaycheckRow,
  PoolYear,
  RunwayInputs,
  RunwayResult,
  SleeveKey,
} from "./types"
import { CONTRIBUTION_ACCOUNTS } from "./types"

const EQUITY_SLEEVES: SleeveKey[] = ["core", "play", "ira", "k401", "hsa"]

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

  // HDHP coverage for this scenario: a new job can change it from its start.
  const coverage: HsaCoverage[] =
    newJob?.hsaTier && newStart
      ? [
          ...(p.hsaCoverage.length
            ? p.hsaCoverage.filter((c) => c.from < newStart)
            : [{ from: "0000-01", tier: "self" as const }]),
          { from: newStart, tier: newJob.hsaTier },
        ]
      : p.hsaCoverage

  // ---- pass 1: paychecks and deposits
  const pay: Record<string, number> = {}
  const k4: Record<string, number> = {}
  const mt: Record<string, number> = {}
  const hsaIn: Record<string, number> = {}
  const hsaOut: Record<string, number> = {}
  const iraOut: Record<string, number> = {}
  const nChecks: Record<string, number> = {}
  const toSleeve: Record<string, Partial<Record<string, number>>> = {}
  const events: Record<string, string[]> = {}
  const addEvent = (m: string, e: string) => {
    const list = events[m] ?? []
    if (!list.includes(e)) list.push(e)
    events[m] = list
  }
  const add = (o: Record<string, number>, m: string, v: number) => {
    o[m] = (o[m] ?? 0) + v
  }
  const paychecks: PaycheckRow[] = []
  let forfeitMonth: string | null = null
  let prevEmployer: "current" | "new" | null = null
  let year = 0
  let ytdSs = 0
  let ytdSp = 0

  // One running total per account and year, shared by every stream in it.
  interface Pool {
    total: number
    before: number
    streams: Record<string, number>
    employer: number
    hitDate: string | null
    clippedDate: string | null
    cut: number
    overNoted: boolean
  }
  const poolState: Record<string, Record<ContributionAccount, Pool>> = {}
  const poolOf = (y: number, a: ContributionAccount): Pool => {
    poolState[y] ??= {} as Record<ContributionAccount, Pool>
    const byAccount = poolState[y]
    if (!byAccount[a]) {
      const before = p.contributions
        .filter((c) => c.account === a)
        .reduce((sum, c) => sum + Math.max(0, c.ytd[y] ?? 0), 0)
      byAccount[a] = {
        total: before,
        before,
        streams: {},
        employer: 0,
        hitDate: null,
        clippedDate: null,
        cut: 0,
        overNoted: false,
      }
    }
    return byAccount[a]
  }
  /** The limit as it stands in month `m`: an HSA assumes that month's
   * coverage lasts the year, as payroll would. */
  const limitIn = (a: ContributionAccount, y: number, m: string) =>
    poolLimit(a, p.limits, coverage, y, m)
  const roomIn = (a: ContributionAccount, y: number, m: string) =>
    Math.max(0, limitIn(a, y, m) - poolOf(y, a).total)
  const take = (
    a: ContributionAccount,
    y: number,
    id: string,
    amount: number
  ) => {
    const pool = poolOf(y, a)
    pool.total += amount
    pool.streams[id] = (pool.streams[id] ?? 0) + amount
  }
  const noteHit = (
    a: ContributionAccount,
    y: number,
    m: string,
    when: string,
    announce: boolean
  ) => {
    const pool = poolOf(y, a)
    const limit = limitIn(a, y, m)
    if (limit <= 0 || pool.hitDate || pool.total < limit - 0.005) return
    pool.hitDate = when
    if (announce) addEvent(m, `${ACCOUNT_LABEL[a]} limit reached`)
  }

  const byMonth: Record<string, Date[]> = {}
  for (const d of dates) {
    const m = ym(d)
    byMonth[m] ??= []
    byMonth[m].push(d)
  }
  const lastYear = Number(lastMonth.slice(0, 4))
  const walk = [...new Set([...Object.keys(byMonth), ...months])].sort()

  for (const m of walk) {
    const y = Number(m.slice(0, 4))
    const monthOfYear = Number(m.slice(5))
    if (y !== year) {
      year = y
      ytdSs = 0
      ytdSp = 0
    }
    const inHorizon = m >= h.start
    const covered = tierAt(coverage, m) !== "none"

    // Coverage that ended after the money went in leaves an excess.
    const hsaPool = poolOf(y, "hsa")
    if (
      inHorizon &&
      !hsaPool.overNoted &&
      hsaPool.total > limitIn("hsa", y, m) + 0.005
    ) {
      hsaPool.overNoted = true
      addEvent(m, "HSA over its limit")
    }

    const employerHsa = jobAt(m).hsaEmployer
    if (
      inHorizon &&
      covered &&
      employerHsa &&
      employerHsa.month === monthOfYear &&
      employerHsa.amount > 0
    ) {
      hsaPool.total += employerHsa.amount
      hsaPool.employer += employerHsa.amount
      add(hsaIn, m, employerHsa.amount)
      noteHit("hsa", y, m, m, false)
    }

    for (const d of byMonth[m] ?? []) {
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
        employer === "new" && newStart && newStart > h.start
          ? newStart
          : h.start,
        m
      )
      const nth = (nChecks[m] ?? 0) + 1
      nChecks[m] = nth
      const t = d.getTime()
      const left = countDates.filter(
        (x) => x.getUTCFullYear() === y && x.getTime() >= t
      ).length
      const roomStart = {
        k401: roomIn("k401", y, m),
        hsa: roomIn("hsa", y, m),
        ira: 0,
      }

      const deferrals: Deferral[] = []
      const announce = { k401: false, hsa: false, ira: false }
      let pre = 0
      let roth = 0
      let hsa = 0
      for (const c of p.contributions) {
        if (c.channel !== "payroll" || c.account === "ira") continue
        const ph = phaseAt(c.schedule, m)
        if (!ph || ph.pace === "off") continue
        if (c.account === "hsa" && !covered) continue
        // Spreading evenly lands on the limit by design; any other pace
        // reaching it is worth a marker.
        if (ph.pace !== "even") announce[c.account] = true
        const want = payrollWant(ph, {
          gross,
          paycheckOfMonth: nth,
          roomStart: roomStart[c.account],
          left,
        })
        const room = roomIn(c.account, y, m)
        const pool = poolOf(y, c.account)
        if (
          want > room + 0.005 &&
          (ph.pace === "fixed" || ph.pace === "percent")
        ) {
          pool.clippedDate ??= isoDate(d)
          pool.cut += want - room
        }
        const amount = Math.min(want, room)
        if (amount <= 0) continue
        take(c.account, y, c.id, amount)
        deferrals.push({ amount, ...treatment(c) })
        if (c.account === "hsa") hsa += amount
        else if (c.tax === "roth") roth += amount
        else pre += amount
      }
      noteHit("k401", y, m, isoDate(d), announce.k401)
      noteHit("hsa", y, m, isoDate(d), announce.hsa)

      const match = matchFor(job.match, gross, pre + roth)
      const pc = paycheck({
        gross,
        deferrals,
        job,
        paycheckOfMonth: nth,
        ytdStatePayroll: ytdSp,
        ytdSsWages: ytdSs,
      })
      ytdSs += pc.ssWages
      ytdSp += pc.statePayroll - job.withholding.statePayroll.flatPerPaycheck

      add(pay, m, pc.net)
      add(k4, m, pre + roth)
      add(mt, m, match)
      add(hsaIn, m, hsa)
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
        hsa,
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

    // Direct deposits, paid from cash after the month's paychecks.
    if (!inHorizon) continue
    const monthsLeft =
      h.spreadThrough === "horizon" && y === lastYear
        ? Number(lastMonth.slice(5)) - monthOfYear + 1
        : 13 - monthOfYear
    const directRoom = {
      k401: 0,
      hsa: roomIn("hsa", y, m),
      ira: roomIn("ira", y, m),
    }
    for (const c of p.contributions) {
      if (c.channel !== "direct" || c.account === "k401") continue
      const ph = phaseAt(c.schedule, m)
      if (!ph || ph.pace === "off") continue
      if (c.account === "hsa" && !covered) continue
      const want = directWant(ph, {
        monthOfYear,
        roomStart: directRoom[c.account],
        left: monthsLeft,
      })
      const room = roomIn(c.account, y, m)
      const pool = poolOf(y, c.account)
      if (want > room + 0.005 && ph.pace === "fixed") {
        pool.clippedDate ??= m
        pool.cut += want - room
      }
      const amount = Math.min(want, room)
      if (amount <= 0) continue
      take(c.account, y, c.id, amount)
      if (c.account === "hsa") {
        add(hsaOut, m, amount)
        add(hsaIn, m, amount)
        addEvent(m, "HSA deposit")
      } else {
        add(iraOut, m, amount)
        addEvent(m, "IRA deposit")
      }
    }
    noteHit("ira", y, m, m, false)
    noteHit("hsa", y, m, m, false)
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
  const taxOut: Record<string, number> = {}
  const out: Record<string, number> = {}
  const need: Record<string, number> = {}
  months.forEach((m, i) => {
    spendOut[m] = spending * (i === 0 ? h.firstMonthSpendFraction : 1)
    iraOut[m] ??= 0
    hsaOut[m] ??= 0
    taxOut[m] = 0
    for (const o of p.oneOffs)
      if (o.month === m) {
        taxOut[m] += o.amount
        if (o.amount !== 0) addEvent(m, o.label || "Tax due")
      }
    out[m] = spendOut[m] + iraOut[m] + hsaOut[m] + taxOut[m]
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
    b.hsa += hsaIn[m] ?? 0

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
      hsaOut: hsaOut[m],
      taxOut: taxOut[m],
      k401In: k4[m] ?? 0,
      hsaIn: hsaIn[m] ?? 0,
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

  // Sums over the horizon's months only (a pay date before `start` counts
  // toward its pool but is not part of the plan).
  const sum = (o: Record<string, number>) =>
    months.reduce((a, m) => a + (o[m] ?? 0), 0)

  const pools: RunwayResult["pools"] = {}
  const limitHit: Record<string, string> = {}
  for (const yy of new Set(months.map((m) => Number(m.slice(0, 4))))) {
    const byAccount = {} as Record<ContributionAccount, PoolYear>
    for (const a of CONTRIBUTION_ACCOUNTS) {
      const pool = poolOf(yy, a)
      const limit = poolLimit(a, p.limits, coverage, yy)
      const excess = pool.total - limit
      byAccount[a] = {
        limit,
        before: pool.before,
        streams: pool.streams,
        employer: pool.employer,
        contributed: pool.total,
        excess: excess > 0.005 ? excess : 0,
        hitDate: pool.hitDate,
        clippedDate: pool.clippedDate,
        cut: pool.cut,
        complete: `${yy}-12` <= lastMonth,
      }
    }
    pools[yy] = byAccount
    if (byAccount.k401.hitDate) limitHit[yy] = byAccount.k401.hitDate
  }
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
    hsaContributed: sum(hsaIn),
    iraContributed: sum(iraOut),
    pools,
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
