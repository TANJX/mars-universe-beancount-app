import assert from "node:assert/strict"
import { test } from "node:test"

import { horizonOf, runnable, scenarioBody } from "./config"
import { phaseAt } from "./contributions"
import { demoRunway } from "./demo"
import { matchFor, simulate } from "./engine"
import { applyPatch } from "./patch"
import type {
  Contribution,
  Job,
  Phase,
  PlanBody,
  RunwayPerson,
  RunwayResult,
} from "./types"
import { PLAN_ID } from "./types"

const data = demoRunway("2026-11-08")
const horizon = horizonOf(data, "year_end")
const [alexRec, samRec] = data.people
const run = (rec = alexRec, body: PlanBody = rec.plan): RunwayPerson =>
  runnable(rec, body, data.start)
const alex = run(alexRec)
const sam = run(samRec)
const sim = (p: RunwayPerson): RunwayResult => simulate({ person: p, horizon })

/** Alex taking Offer A from `start` (the demo scenario, moved), with the
 * scenario body optionally edited further. */
function offerA(start: string, edit?: (b: PlanBody) => PlanBody): RunwayPerson {
  const b = scenarioBody(alexRec, "offer-a")
  const moved: PlanBody = {
    ...b,
    jobs: b.jobs.map((j) =>
      j.id === "offer-a"
        ? { ...j, start, salary: j.salary.map((s) => ({ ...s, from: start })) }
        : j
    ),
  }
  return run(alexRec, edit ? edit(moved) : moved)
}

/** Every job edited the same way. */
const eachJob = (p: RunwayPerson, f: (j: Job) => Job): RunwayPerson => ({
  ...p,
  jobs: p.jobs.map(f),
})

function flat(p: RunwayPerson): RunwayPerson {
  return {
    ...p,
    returns: { equity: 0, reserve: 0, ef: 0, gold: 0 },
  }
}

/** Replace (or add) one stream on a person. */
function withStream(p: RunwayPerson, c: Contribution): RunwayPerson {
  return {
    ...p,
    contributions: [...p.contributions.filter((x) => x.id !== c.id), c],
  }
}
const stream = (p: RunwayPerson, id: string): Contribution => {
  const c = p.contributions.find((x) => x.id === id)
  assert.ok(c, `no stream ${id}`)
  return c
}
const hsaStream = (schedule: Phase[], ytd = {}): Contribution => ({
  id: "hsa",
  account: "hsa",
  tax: "traditional",
  channel: "payroll",
  ytd,
  schedule,
})
const near = (a: number, b: number, tol = 1e-6) =>
  assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`)

const SLEEVES = [
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
] as const

test("with zero returns, sleeves change by pay - out + 401k + match", () => {
  for (const rec of [alexRec, samRec]) {
    for (const id of [PLAN_ID, ...rec.scenarios.map((x) => x.id)]) {
      const p = flat(run(rec, scenarioBody(rec, id)))
      const r = sim(p)
      const s = p.starting
      let prev = SLEEVES.reduce((a, k) => a + s.sleeves[k], 0) - s.cards
      r.rows.forEach((row, i) => {
        const total = SLEEVES.reduce((a, k) => a + row[k], 0)
        const prevHsa = i > 0 ? r.rows[i - 1].hsa : s.sleeves.hsa
        // The IRA deposit is an outflow that stays inside the sleeves.
        const expected =
          row.takeHome -
          row.outflows +
          row.iraOut +
          row.k401In +
          row.match +
          (row.hsa - prevHsa) -
          (r.forfeitMonth === row.month ? r.forfeited : 0)
        assert.ok(
          Math.abs(total - prev - expected) < 1e-6,
          `${p.id} ${id} ${row.month}`
        )
        prev = total
      })
    }
  }
})

test("checking never ends below the buffer while the reserve has money", () => {
  const r = sim(alex)
  for (const row of r.rows)
    if (row.reserve > 0.01) assert.ok(row.checking >= alex.cash.buffer - 1e-6)
})

test("a fixed election clips at the annual limit and records when", () => {
  const p = withStream(sam, {
    ...stream(sam, "k401-pretax"),
    ytd: { 2026: 23_000 },
  })
  const r = sim(p)
  const y2026 = r.paychecks.filter((c) => c.date.startsWith("2026"))
  const total = y2026.reduce((a, c) => a + c.pre + c.roth, 0)
  assert.ok(Math.abs(total - 1_500) < 1e-6)
  assert.ok(r.limitHit["2026"])
  // 2027: 2,000 a check until 24,500 is reached on the 13th check.
  assert.equal(
    r.limitHit["2027"],
    r.paychecks.filter((c) => c.date.startsWith("2027"))[12].date
  )
})

test("leaving before the vesting date forfeits the unvested match", () => {
  // Offer A starts in March; the current job vests in September.
  const r = sim(offerA("2027-03"))
  assert.equal(r.forfeitMonth, "2027-03")
  assert.ok(r.forfeited >= alex.starting.unvested)
  const mar = r.rows.find((x) => x.month === "2027-03")
  assert.ok(mar?.events.includes("Match forfeited"))
  assert.ok(mar?.events.includes("New job starts"))
  // The new job has no vesting, so nothing is unvested after the switch.
  assert.equal(mar?.unvested, 0)
  const stay = sim(alex)
  assert.equal(stay.forfeitMonth, null)
  assert.equal(stay.forfeited, 0)
  // Leaving after the vesting month forfeits nothing.
  assert.equal(sim(offerA("2027-10")).forfeitMonth, null)
})

test("elections and matches", () => {
  const e = phaseAt(stream(alex, "k401-pretax").schedule, "2027-02")
  assert.equal(e?.pace, "even")
  assert.equal(
    matchFor({ type: "threshold", minPct: 0.04, pct: 0.02 }, 1000, 39),
    0
  )
  assert.equal(
    matchFor({ type: "threshold", minPct: 0.04, pct: 0.02 }, 1000, 40),
    20
  )
  // 100% of the first 3%, 50% of the next 2%: contributing 6% earns 4%.
  const tiered = matchFor(
    {
      type: "tiered",
      tiers: [
        { rate: 1, upToPct: 0.03 },
        { rate: 0.5, upToPct: 0.05 },
      ],
    },
    1000,
    60
  )
  assert.ok(Math.abs(tiered - 40) < 1e-9)
})

test("zero invested gives a zero play share, not NaN", () => {
  const p: RunwayPerson = {
    ...sam,
    ...eachJob(sam, (j) => ({ ...j, deductions: [], hsaEmployer: null })),
    pay: { ...sam.pay, deductions: [] },
    contributions: [],
    cash: { ...sam.cash, dcaMonths: 1, buffer: 1e9 },
    starting: {
      ...sam.starting,
      sleeves: {
        ...sam.starting.sleeves,
        core: 0,
        ira: 0,
        k401: 0,
        hsa: 0,
        gold: 0,
        play: 0,
      },
    },
  }
  const r = sim(p)
  for (const row of r.rows) assert.ok(Number.isFinite(row.playShare))
})

test("an unfunded deficit is reported when every source runs dry", () => {
  // Spending far above take-home with small starting cash: reserve, emergency
  // fund and core all empty and checking goes negative.
  const p: RunwayPerson = {
    ...flat(sam),
    spendingMonthly: sam.spendingMonthly * 4,
    starting: {
      ...sam.starting,
      sleeves: {
        ...sam.starting.sleeves,
        checking: 1_000,
        ef: 2_000,
        reserve: 3_000,
        core: 1_500,
      },
      cards: 0,
    },
  }
  const r = sim(p)
  assert.ok(r.unfundedMonths.length > 0)
  assert.ok(r.unfundedPeak > 0)
  assert.ok(Math.abs(r.minChecking + r.unfundedPeak) < 1e-6)
  assert.ok(
    r.unfundedPeakMonth && r.unfundedMonths.includes(r.unfundedPeakMonth)
  )
  assert.ok(r.coreDrawn > 0 && r.coreDrawnMonth)
  for (const row of r.rows) {
    const negative = row.checking < -0.005
    assert.equal(r.unfundedMonths.includes(row.month), negative, row.month)
    // Checking only goes negative once reserve, emergency fund and core are empty.
    if (negative) {
      assert.ok(row.reserve <= 1e-6)
      assert.ok(row.ef <= 1e-6)
      assert.ok(row.core <= 1e-6)
    }
  }
})

test("a funded plan reports no unfunded months", () => {
  const r = sim(alex)
  assert.deepEqual(r.unfundedMonths, [])
  assert.equal(r.unfundedPeak, 0)
  assert.equal(r.unfundedPeakMonth, null)
})

test("pre-tax and Roth 401k share one limit, split by share", () => {
  const r = sim(alex)
  const pool = r.pools["2027"].k401
  near(pool.contributed, 24_500, 0.01)
  near(pool.streams["k401-pretax"], 24_500 * 0.6, 0.01)
  near(pool.streams["k401-roth"], 24_500 * 0.4, 0.01)
  assert.equal(pool.excess, 0)
  assert.equal(pool.clippedDate, null)
})

test("a job switch mid-year does not reset the year's running total", () => {
  const p = offerA("2027-07")
  assert.equal(p.jobs.length, 2)
  const r = sim(p)
  // Both jobs paid in 2027.
  const paid = new Set(
    r.paychecks.filter((c) => c.date.startsWith("2027")).map((c) => c.jobId)
  )
  assert.deepEqual([...paid].sort(), ["current", "offer-a"])
  near(r.pools["2027"].k401.contributed, 24_500, 0.01)
  const y2027 = r.paychecks.filter((c) => c.date.startsWith("2027"))
  near(
    y2027.reduce((a, c) => a + c.pre + c.roth, 0),
    24_500,
    0.01
  )
})

test("the HSA limit is prorated by covered months", () => {
  const p: RunwayPerson = {
    ...withStream(
      eachJob(sam, (j) => ({ ...j, hsaEmployer: null })),
      hsaStream([{ from: "2026-11", pace: "even", share: 1, capPct: 1 }])
    ),
    hsaCoverage: [
      { from: "2026-01", tier: "self" },
      { from: "2027-07", tier: "none" },
    ],
  }
  const r = sim(p)
  const pool = r.pools["2027"].hsa
  near(pool.limit, 2_200)
  // Spread over the whole year as known in January, so half of it is in by
  // the time coverage ends: no excess.
  near(pool.contributed, 2_200, 0.01)
  assert.equal(pool.excess, 0)
  // Nothing goes in once coverage has ended.
  for (const c of r.paychecks)
    if (c.month >= "2027-07" && c.month <= "2027-12") assert.equal(c.hsa, 0)
})

test("front-loading an HSA and then losing coverage leaves an excess", () => {
  const p: RunwayPerson = {
    ...withStream(
      eachJob(sam, (j) => ({ ...j, hsaEmployer: null })),
      hsaStream([
        { from: "2026-11", pace: "front_load", share: 1, capPct: 0.5 },
      ])
    ),
    hsaCoverage: [
      { from: "2026-01", tier: "self" },
      { from: "2027-07", tier: "none" },
    ],
  }
  const r = sim(p)
  const pool = r.pools["2027"].hsa
  near(pool.limit, 2_200)
  near(pool.contributed, 4_400, 0.01)
  near(pool.excess, 2_200, 0.01)
  const row = r.rows.find((x) => x.month === "2027-07")
  assert.ok(row?.events.includes("HSA over its limit"))
})

test("a new job without an HDHP ends HSA coverage from its start", () => {
  const hsa = hsaStream([
    { from: "2026-11", pace: "front_load", share: 1, capPct: 0.5 },
  ])
  const covered = (b: PlanBody): PlanBody => ({
    ...b,
    contributions: [...b.contributions, hsa],
    hsaCoverage: [{ from: "2026-01", tier: "self" }],
  })
  const stay = sim(run(alexRec, covered(alexRec.plan)))
  assert.equal(stay.pools["2027"].hsa.excess, 0)
  // The scenario changes coverage, not the job.
  const moved = sim(
    offerA("2027-04", (b) =>
      applyPatch(covered(b), {
        hsaCoverage: [{ from: "2027-04", tier: "none" }],
      })
    )
  )
  near(moved.pools["2027"].hsa.limit, 1_100)
  near(moved.pools["2027"].hsa.excess, 3_300, 0.01)
})

test("employer HSA money counts toward the limit; a fixed stream clips", () => {
  const p: RunwayPerson = {
    ...withStream(
      eachJob(sam, (j) => ({ ...j, hsaEmployer: { amount: 500, month: 1 } })),
      hsaStream([
        {
          from: "2026-11",
          pace: "fixed",
          amount: 200,
          per: "paycheck",
          paycheckOfMonth: null,
        },
      ])
    ),
  }
  const r = sim(p)
  const pool = r.pools["2027"].hsa
  near(pool.employer, 500)
  near(pool.contributed, 4_400, 0.01)
  near(pool.streams.hsa, 3_900, 0.01)
  assert.ok(pool.clippedDate)
  assert.equal(pool.hitDate, pool.clippedDate)
  // 24 checks of 200 ask for 4,800; 3,900 fit beside the employer's 500.
  near(pool.cut, 900, 0.01)
})

test("a direct IRA deposit is paid from cash and clips at the limit", () => {
  const p = withStream(alex, {
    ...stream(alex, "ira-roth"),
    schedule: [{ from: "2026-11", pace: "lump", month: 1, amount: 9_000 }],
  })
  const r = sim(p)
  const jan = r.rows.find((x) => x.month === "2027-01")
  assert.ok(jan)
  near(jan.iraOut, 7_500)
  assert.ok(jan.events.includes("IRA deposit"))
  near(r.pools["2027"].ira.contributed, 7_500)
  const feb = r.rows.find((x) => x.month === "2027-02")
  assert.equal(feb?.iraOut, 0)
})

test("paycheck rows name the paying job; salary steps mark raises and cuts", () => {
  const r = sim(offerA("2027-07"))
  for (const c of r.paychecks) {
    const id = c.month < "2027-07" ? "current" : "offer-a"
    assert.equal(c.jobId, id, c.date)
    assert.equal(c.employer, id === "current" ? "Current job" : "Offer A")
  }
  const ev = (res: RunwayResult, m: string) =>
    res.rows.find((x) => x.month === m)?.events ?? []
  // The demo's February review step.
  assert.ok(ev(r, "2027-02").includes("Raise"))
  assert.ok(ev(r, "2027-07").includes("New job starts"))
  // Gross per check follows the step.
  const jan = r.paychecks.find((c) => c.month === "2027-01")
  const feb = r.paychecks.find((c) => c.month === "2027-02")
  near(jan?.gross ?? 0, 90_000 / 26)
  near(feb?.gross ?? 0, 92_700 / 26)

  // A lower step is a pay cut; a disabled step changes nothing.
  const cut = sim(
    eachJob(alex, (j) => ({
      ...j,
      salary: [
        ...j.salary.map((s) =>
          s.from === "2027-02" ? { ...s, enabled: false } : s
        ),
        { from: "2027-05", gross: 80_000, enabled: true, note: null },
      ],
    }))
  )
  assert.ok(!ev(cut, "2027-02").includes("Raise"))
  assert.ok(ev(cut, "2027-05").includes("Pay cut"))
})

test("a gap between jobs pays nothing and marks both ends", () => {
  const p = offerA("2027-05", (b) => ({
    ...b,
    jobs: b.jobs.map((j) =>
      j.id === "current" ? { ...j, leave: "2027-02" } : j
    ),
  }))
  const r = sim(p)
  const months = new Set(r.paychecks.map((c) => c.month))
  assert.ok(!months.has("2027-03") && !months.has("2027-04"))
  assert.ok(months.has("2027-02") && months.has("2027-05"))
  const row = (m: string) => r.rows.find((x) => x.month === m)
  assert.equal(row("2027-03")?.takeHome, 0)
  assert.ok(row("2027-03")?.events.includes("Current job ends"))
  assert.ok(row("2027-05")?.events.includes("Offer A starts"))
  // Leaving into a gap before vesting forfeits too.
  assert.equal(r.forfeitMonth, "2027-03")
  // A disabled job is ignored entirely.
  const off = sim(
    offerA("2027-05", (b) => ({
      ...b,
      jobs: b.jobs.map((j) =>
        j.id === "offer-a" ? { ...j, enabled: false } : j
      ),
    }))
  )
  assert.deepEqual(
    off.rows.map((x) => x.takeHome),
    sim(alex).rows.map((x) => x.takeHome)
  )
})
