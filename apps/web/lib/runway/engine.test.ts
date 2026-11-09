import assert from "node:assert/strict"
import { test } from "node:test"

import { demoRunway } from "./demo"
import { electionAt, matchFor, simulate } from "./engine"
import type { RunwayInputs, RunwayPerson } from "./types"

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
  const p: RunwayPerson = {
    ...sam,
    k401: { ...sam.k401, ytd: { 2026: 23_000 } },
  }
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
  const e = electionAt(alex.k401.elections, "2027-02")
  assert.equal(e?.mode, "max_spread")
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
    k401: { ...sam.k401, elections: [] },
    job: { ...sam.job, deductions: [] },
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
    ira: null,
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
