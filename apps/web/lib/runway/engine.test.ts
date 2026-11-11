import assert from "node:assert/strict"
import { test } from "node:test"

import { normalizePerson } from "./config"
import { phaseAt } from "./contributions"
import { demoRunway } from "./demo"
import { matchFor, simulate } from "./engine"
import type { Contribution, Phase, RunwayInputs, RunwayPerson } from "./types"

const data = demoRunway("2026-11-08")
const horizon = {
  asof: data.asof,
  start: data.start,
  months: data.months,
  firstMonthSpendFraction: data.firstMonthSpendFraction,
  spreadThrough: data.spreadThrough,
  reserveLookahead: data.reserveLookahead,
}
const alex = data.people[0]
const sam = data.people[1]

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
  for (const p of [alex, sam]) {
    const inputs: RunwayInputs = { person: flat(p), horizon }
    for (const sc of p.scenarios) {
      const r = simulate(inputs, sc.id)
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
          `${p.id} ${sc.id} ${row.month}`
        )
        prev = total
      })
    }
  }
})

test("checking never ends below the buffer while the reserve has money", () => {
  const r = simulate({ person: alex, horizon }, "stay")
  for (const row of r.rows)
    if (row.reserve > 0.01) assert.ok(row.checking >= alex.cash.buffer - 1e-6)
})

test("a fixed election clips at the annual limit and records when", () => {
  const p = withStream(sam, {
    ...stream(sam, "k401-pretax"),
    ytd: { 2026: 23_000 },
  })
  const r = simulate({ person: p, horizon }, "stay")
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
  const p: RunwayPerson = {
    ...alex,
    scenarios: alex.scenarios.map((s) =>
      s.id === "offer-a" ? { ...s, start: "2027-03" } : s
    ),
  }
  const r = simulate({ person: p, horizon }, "offer-a")
  assert.equal(r.forfeitMonth, "2027-03")
  assert.ok(r.forfeited >= alex.starting.unvested)
  const stay = simulate({ person: p, horizon }, "stay")
  assert.equal(stay.forfeitMonth, null)
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
    contributions: [],
    job: { ...sam.job, deductions: [], hsaEmployer: null },
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
  const r = simulate({ person: p, horizon }, "stay")
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
  const r = simulate({ person: p, horizon }, "stay")
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
  const r = simulate({ person: alex, horizon }, "stay")
  assert.deepEqual(r.unfundedMonths, [])
  assert.equal(r.unfundedPeak, 0)
  assert.equal(r.unfundedPeakMonth, null)
})

test("pre-tax and Roth 401k share one limit, split by share", () => {
  const r = simulate({ person: alex, horizon }, "stay")
  const pool = r.pools["2027"].k401
  near(pool.contributed, 24_500, 0.01)
  near(pool.streams["k401-pretax"], 24_500 * 0.6, 0.01)
  near(pool.streams["k401-roth"], 24_500 * 0.4, 0.01)
  assert.equal(pool.excess, 0)
  assert.equal(pool.clippedDate, null)
})

test("a job switch mid-year does not reset the year's running total", () => {
  const p: RunwayPerson = {
    ...alex,
    scenarios: alex.scenarios.map((s) =>
      s.id === "offer-a" ? { ...s, start: "2027-07" } : s
    ),
  }
  const r = simulate({ person: p, horizon }, "offer-a")
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
      sam,
      hsaStream([{ from: "2026-11", pace: "even", share: 1, capPct: 1 }])
    ),
    job: { ...sam.job, hsaEmployer: null },
    hsaCoverage: [
      { from: "2026-01", tier: "self" },
      { from: "2027-07", tier: "none" },
    ],
  }
  const r = simulate({ person: p, horizon }, "stay")
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
      sam,
      hsaStream([
        { from: "2026-11", pace: "front_load", share: 1, capPct: 0.5 },
      ])
    ),
    job: { ...sam.job, hsaEmployer: null },
    hsaCoverage: [
      { from: "2026-01", tier: "self" },
      { from: "2027-07", tier: "none" },
    ],
  }
  const r = simulate({ person: p, horizon }, "stay")
  const pool = r.pools["2027"].hsa
  near(pool.limit, 2_200)
  near(pool.contributed, 4_400, 0.01)
  near(pool.excess, 2_200, 0.01)
  const row = r.rows.find((x) => x.month === "2027-07")
  assert.ok(row?.events.includes("HSA over its limit"))
})

test("a new job without an HDHP ends HSA coverage from its start", () => {
  const p: RunwayPerson = {
    ...withStream(
      alex,
      hsaStream([
        { from: "2026-11", pace: "front_load", share: 1, capPct: 0.5 },
      ])
    ),
    scenarios: alex.scenarios.map((s) =>
      s.id === "offer-a" && s.job
        ? { ...s, start: "2027-04", job: { ...s.job, hsaTier: "none" } }
        : s
    ),
  }
  const stay = simulate({ person: p, horizon }, "stay")
  assert.equal(stay.pools["2027"].hsa.excess, 0)
  const moved = simulate({ person: p, horizon }, "offer-a")
  near(moved.pools["2027"].hsa.limit, 1_100)
  near(moved.pools["2027"].hsa.excess, 3_300, 0.01)
})

test("employer HSA money counts toward the limit; a fixed stream clips", () => {
  const p: RunwayPerson = {
    ...withStream(
      sam,
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
    job: { ...sam.job, hsaEmployer: { amount: 500, month: 1 } },
  }
  const r = simulate({ person: p, horizon }, "stay")
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
  const r = simulate({ person: p, horizon }, "stay")
  const jan = r.rows.find((x) => x.month === "2027-01")
  assert.ok(jan)
  near(jan.iraOut, 7_500)
  assert.ok(jan.events.includes("IRA deposit"))
  near(r.pools["2027"].ira.contributed, 7_500)
  const feb = r.rows.find((x) => x.month === "2027-02")
  assert.equal(feb?.iraOut, 0)
})

test("the old election, IRA and HSA-deduction shape converts to streams", () => {
  const legacy = {
    id: "pat",
    job: {
      grossAnnual: 120_000,
      schedule: { frequency: "semimonthly", days: [15, -1] },
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
        { label: "Commuter", amount: 50, per: "paycheck", pretax: true },
      ],
    },
    k401: {
      limits: { 2026: 24_500, 2027: 25_000 },
      ytd: { 2026: 1_000 },
      elections: [
        { from: "2026-11", mode: "fixed", pretax: 500, roth: 100 },
        { from: "2027-01", mode: "max_spread", capPct: 0.5, rothShare: 0.25 },
        { from: "2027-07", mode: "percent", pretaxPct: 0.1, rothPct: 0 },
      ],
    },
    ira: { amount: 7_000, month: 2 },
  }
  const p = normalizePerson(legacy, 0, "2026-11", "2026-11-08")
  assert.deepEqual(
    p.contributions.map((c) => c.id),
    ["k401-pretax", "k401-roth", "hsa", "ira-roth"]
  )
  assert.deepEqual(stream(p, "k401-pretax").ytd, { 2026: 1_000 })
  assert.deepEqual(stream(p, "k401-roth").schedule, [
    {
      from: "2026-11",
      pace: "fixed",
      amount: 100,
      per: "paycheck",
      paycheckOfMonth: null,
    },
    { from: "2027-01", pace: "even", share: 0.25, capPct: 0.125 },
    { from: "2027-07", pace: "off" },
  ])
  assert.deepEqual(stream(p, "hsa").schedule, [
    {
      from: "2026-11",
      pace: "fixed",
      amount: 300,
      per: "month",
      paycheckOfMonth: 2,
    },
  ])
  // The HSA deduction became a stream; the commuter one stays a deduction.
  assert.deepEqual(
    p.job.deductions.map((d) => d.label),
    ["Commuter"]
  )
  assert.equal(p.limits["2027"].k401, 25_000)
  assert.equal(p.limits["2028"].k401, 25_000)
  assert.equal(p.limits["2027"].ira, 7_500)
})
