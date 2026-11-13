import assert from "node:assert/strict"
import { test } from "node:test"

import {
  bodyOf,
  normalizePerson,
  parseBody,
  runnable,
  scenarioBody,
} from "./config"
import { demoRunway } from "./demo"
import { applyPatch, countChanges, diffPatch } from "./patch"
import type { Job, PlanBody } from "./types"
import { PLAN_ID } from "./types"

const data = demoRunway("2026-11-08")

test("demo: every scenario body survives diffPatch then applyPatch", () => {
  for (const rec of data.people) {
    assert.deepEqual(scenarioBody(rec, PLAN_ID), rec.plan)
    for (const s of rec.scenarios) {
      const body = scenarioBody(rec, s.id)
      assert.notDeepEqual(body, rec.plan, `${rec.id} ${s.id} changes nothing`)
      const patch = diffPatch(body, rec.plan)
      assert.ok(countChanges(patch) > 0)
      assert.deepEqual(applyPatch(rec.plan, patch), body, `${rec.id} ${s.id}`)
      // And the stored patch is already minimal: diffing gives it back.
      assert.deepEqual(patch, s.patch)
    }
  }
})

test("demo: runnable and bodyOf are inverses", () => {
  for (const rec of data.people) {
    const p = runnable(rec, rec.plan, data.start)
    assert.deepEqual(bodyOf(p), rec.plan)
    assert.ok(p.limits[data.start.slice(0, 4)].k401 > 0)
  }
})

// A synthetic payload in the shape runway.py serves: the resolved plan body
// at the top, each scenario as a whole resolved body. Every field is already
// in the parsed (canonical) form, so parsing must not change it.
const withholding = {
  filing: "single",
  federalStd: 16_100,
  state: "nj",
  stateStd: 1_000,
  statePayroll: { flatPerPaycheck: 0, rate: 0.005, annualCap: 200 },
  ssWageBase: 184_500,
} as const

const currentJob: Job = {
  id: "current",
  employer: "Widgets Inc",
  start: null,
  leave: null,
  enabled: true,
  note: null,
  salary: [
    { from: "2026-01", gross: 80_000, enabled: true, note: null },
    { from: "2027-03", gross: 84_000, enabled: true, note: "Review" },
  ],
  match: { type: "flat", pct: 0.03 },
  vesting: { date: "2027-06-01", unvestedStart: 1_000 },
  hsaEmployer: { amount: 250, month: 1 },
  schedule: null,
  deductions: null,
  withholding: null,
}

const plan: PlanBody = {
  label: "Pat",
  birthYear: 1990,
  pay: {
    schedule: { frequency: "biweekly", anchor: "2026-11-06", days: [] },
    deductions: [
      {
        label: "Dental",
        amount: 5,
        per: "paycheck",
        paycheckOfMonth: null,
        pretax: true,
        ficaExempt: true,
        sleeve: null,
      },
    ],
    withholding,
  },
  jobs: [currentJob],
  contributions: [
    {
      id: "k401-pretax",
      account: "k401",
      tax: "traditional",
      channel: "payroll",
      ytd: { "2026": 12_000 },
      schedule: [{ from: "2026-11", pace: "percent", pct: 0.08 }],
    },
    {
      id: "hsa",
      account: "hsa",
      tax: "traditional",
      channel: "direct",
      ytd: {},
      schedule: [{ from: "2026-11", pace: "lump", month: 1, amount: null }],
    },
  ],
  limits: { "2028": { k401: 25_000 } },
  hsaCoverage: [{ from: "2026-01", tier: "self" }],
  spendingMonthly: 3_000,
  oneOffs: [
    { id: "tax-2027", month: "2027-04", amount: 900, label: "Tax due" },
    { id: "trip", month: "2027-08", amount: 2_000, label: "Trip" },
  ],
  cash: {
    buffer: 2_000,
    efMonths: 6,
    earmarks: [{ label: "Car", amount: 5_000 }],
    dcaMonths: 12,
    cardPayoff: { checking: 1 },
  },
  returns: { equity: 0.07, reserve: 0.04, ef: 0.035, gold: 0.03 },
  playCap: 0.1,
  spreadThrough: "year_end",
}

const offerJob: Job = {
  id: "offer",
  employer: "Gadgets LLC",
  start: "2027-05",
  leave: null,
  enabled: true,
  note: "Verbal offer",
  salary: [{ from: "2027-05", gross: 95_000, enabled: true, note: null }],
  match: {
    type: "tiered",
    tiers: [
      { rate: 1, upToPct: 0.03 },
      { rate: 0.5, upToPct: 0.05 },
    ],
  },
  vesting: null,
  hsaEmployer: null,
  schedule: { frequency: "semimonthly", anchor: null, days: [15, -1] },
  deductions: [],
  withholding: {
    ...withholding,
    state: "ny",
    statePayroll: { flatPerPaycheck: 0.6, rate: 0, annualCap: null },
  },
}

const scenarioBodies: Record<string, PlanBody> = {
  // A new job with its own pay settings, coverage ending, a new limit year.
  offer: {
    ...plan,
    jobs: [currentJob, offerJob],
    hsaCoverage: [
      { from: "2026-01", tier: "self" },
      { from: "2027-05", tier: "none" },
    ],
    limits: { ...plan.limits, "2027": { ira: 7_000 } },
  },
  // Leaving with a gap: the job ends, vesting dropped, a one-off removed,
  // a disabled salary step, a stream paused.
  sabbatical: {
    ...plan,
    label: "Pat on sabbatical",
    birthYear: null,
    jobs: [
      {
        ...currentJob,
        leave: "2027-02",
        vesting: null,
        salary: [
          currentJob.salary[0],
          { ...currentJob.salary[1], enabled: false },
        ],
      },
    ],
    contributions: [
      {
        ...plan.contributions[0],
        schedule: [
          ...plan.contributions[0].schedule,
          { from: "2027-03", pace: "off" },
        ],
      },
      plan.contributions[1],
    ],
    oneOffs: [plan.oneOffs[1]],
    spendingMonthly: 2_500,
    cash: { ...plan.cash, earmarks: [] },
  },
  // Same as the plan.
  same: plan,
}

const payload = {
  id: "pat",
  ...plan,
  name: plan.label,
  status: "ok",
  overrides: ["returns.equity", "limits.2028.k401"],
  readOnly: true,
  scenarios: [
    { id: "offer", label: "Take the offer", person: scenarioBodies.offer },
    {
      id: "sabbatical",
      label: "Sabbatical",
      person: scenarioBodies.sabbatical,
    },
    { id: "same", label: "No change", person: scenarioBodies.same },
  ],
  starting: {
    source: "static",
    asof: "2026-11-08",
    sleeves: { checking: 3_000, reserve: 10_000, k401: 20_000 },
    cards: 500,
    loans: 0,
    unvested: 1_000,
    accounts: [],
    unmapped: [],
  },
}

test("a served body parses to itself", () => {
  assert.deepEqual(parseBody(plan, "2026-11", "x"), plan)
  for (const [id, body] of Object.entries(scenarioBodies))
    assert.deepEqual(parseBody(body, "2026-11", "x"), body, id)
})

test("normalizePerson keeps served scenarios as patches that rebuild them", () => {
  const rec = normalizePerson(payload, 0, "2026-11", "2026-11-08")
  assert.equal(rec.id, "pat")
  assert.equal(rec.readOnly, true)
  assert.deepEqual(rec.overrides, ["returns.equity", "limits.2028.k401"])
  assert.deepEqual(rec.plan, plan)
  assert.deepEqual(
    rec.scenarios.map((s) => [s.id, s.label]),
    [
      ["offer", "Take the offer"],
      ["sabbatical", "Sabbatical"],
      ["same", "No change"],
    ]
  )
  for (const [id, body] of Object.entries(scenarioBodies))
    assert.deepEqual(scenarioBody(rec, id), body, id)

  const patch = (id: string) => rec.scenarios.find((s) => s.id === id)?.patch
  assert.deepEqual(patch("same"), {})
  // The offer patch carries only the added job, not the unchanged one.
  assert.deepEqual(
    ((patch("offer")?.jobs ?? []) as { id: string }[]).map((j) => j.id),
    ["offer"]
  )
  // Removed things come back as markers and nulls.
  assert.deepEqual(patch("sabbatical")?.oneOffs, [
    { id: "tax-2027", remove: true },
  ])
  assert.equal(patch("sabbatical")?.birthYear, null)
  // A plan edit flows into a scenario that does not touch it.
  const edited = { ...rec, plan: { ...rec.plan, playCap: 0.2 } }
  assert.equal(scenarioBody(edited, "offer").playCap, 0.2)
})

test("normalizePerson drops scenarios that reuse the plan id or repeat an id", () => {
  const rec = normalizePerson(
    {
      ...payload,
      scenarios: [
        { id: PLAN_ID, label: "Plan again", person: plan },
        { id: "offer", label: "A", person: scenarioBodies.offer },
        { id: "offer", label: "B", person: plan },
      ],
    },
    0,
    "2026-11",
    "2026-11-08"
  )
  assert.deepEqual(
    rec.scenarios.map((s) => s.label),
    ["A"]
  )
})
