import assert from "node:assert/strict"
import { test } from "node:test"

import {
  chartEvents,
  chartWarnings,
  glyphFor,
  groupSeries,
  moneyK,
  monthSpanLabel,
  niceStep,
  shareSeries,
  signedK,
  stackLayers,
  stackTotals,
  warningPills,
  withOther,
  xLabels,
  yScale,
} from "./chart"
import { monthSpan } from "./schedule"
import type { MonthRow, RunwayResult } from "./types"

const row = (month: string, over: Partial<MonthRow> = {}): MonthRow => ({
  month,
  takeHome: 6000,
  outflows: 4500,
  shortfall: 0,
  spendOut: 4500,
  iraOut: 0,
  hsaOut: 0,
  taxOut: 0,
  k401In: 0,
  hsaIn: 0,
  match: 0,
  reserveToCore: 0,
  paychecks: 2,
  checking: 1500,
  ef: 15000,
  reserve: 2000,
  core: 16000,
  ira: 25000,
  k401: 10000,
  hsa: 7500,
  gold: 2000,
  play: 6000,
  other: 0,
  unvested: 0,
  invested: 66500,
  cash: 18500,
  netWorth: 85000,
  playShare: 6000 / 66500,
  events: [],
  ...over,
})

const result = (rows: MonthRow[], over: Partial<RunwayResult> = {}) =>
  ({
    rows,
    paychecks: [],
    startNetWorth: 0,
    forfeitMonth: null,
    forfeited: 0,
    limitHit: {},
    efDrawn: 0,
    efDrawnMonth: null,
    coreDrawn: 0,
    coreDrawnMonth: null,
    minChecking: 0,
    unfundedMonths: [],
    unfundedPeak: 0,
    unfundedPeakMonth: null,
    k401Contributed: 0,
    hsaContributed: 0,
    iraContributed: 0,
    pools: {},
    matchTotal: 0,
    shortfallTotal: 0,
    movedToCore: 0,
    shortMonths: 0,
    ...over,
  }) as RunwayResult

test("niceStep picks 1, 2, 2.5, 5 or 10 times a power of ten", () => {
  assert.equal(niceStep(219_420, 4), 100_000)
  assert.equal(niceStep(1, 4), 0.25)
  assert.equal(niceStep(18_000, 3), 10_000)
  assert.equal(niceStep(900, 4), 250)
})

test("yScale tops out 6% above the data with nice ticks below it", () => {
  const s = yScale(250, 207_000)
  assert.equal(s.lo, 0)
  assert.ok(Math.abs(s.hi - 219_420) < 1e-6)
  assert.deepEqual(s.ticks, [0, 100_000, 200_000])
  // Every tick sits under the top; none is the top itself.
  assert.ok(s.ticks.every((t) => t < s.hi))
})

test("yScale makes room below zero and uses fewer ticks on short plots", () => {
  const s = yScale(250, 20_000, -4_000)
  assert.equal(s.lo, -4_600)
  assert.ok(s.ticks.includes(0) && s.ticks.every((t) => t > s.lo))
  assert.equal(yScale(80, 100_000).ticks.length, 1)
  assert.ok(yScale(120, 100_000).ticks.length <= 3)
})

test("yScale keeps a second tick when the data just passes a nice step", () => {
  // 20,007 of data: a 20k step would leave only $0.
  assert.deepEqual(yScale(130, 18_874).ticks, [0, 10_000])
})

test("yScale on a share axis keeps 100% off the tick list", () => {
  const s = yScale(250, 1 / 1.06)
  assert.ok(Math.abs(s.hi - 1) < 1e-9)
  assert.deepEqual(s.ticks, [0, 0.25, 0.5, 0.75])
})

test("xLabels never collide and put the year on the first label of a year", () => {
  const months = monthSpan("2026-11", 24)
  const at = (step: number) => (i: number) => 44 + (i + 0.5) * step
  const wide = xLabels(months, at(30))
  for (let k = 1; k < wide.length; k++)
    assert.ok(wide[k].x - wide[k - 1].x >= 62)
  assert.equal(wide[0].label, "Nov ’26")
  // Jan 2027 is too close to the first label; Apr then carries the year.
  assert.deepEqual(
    wide.map((l) => l.label),
    ["Nov ’26", "Apr ’27", "Jul", "Oct", "Jan ’28", "Apr", "Jul", "Oct"]
  )
  // A phone-width plot drops the quarter months first, never the first.
  const narrow = xLabels(months, at(13))
  assert.equal(narrow[0].i, 0)
  for (let k = 1; k < narrow.length; k++)
    assert.ok(narrow[k].x - narrow[k - 1].x >= 62)
  assert.ok(narrow.every((l) => !l.label.startsWith("Apr")))
})

test("glyphFor maps engine strings, bills by month and unknowns", () => {
  assert.equal(glyphFor("Raise"), "raise")
  assert.equal(glyphFor("Pay cut"), "cut")
  assert.equal(glyphFor("New job starts"), "job")
  assert.equal(glyphFor("Acme starts"), "job")
  assert.equal(glyphFor("Acme ends"), "job")
  assert.equal(glyphFor("IRA deposit"), "ira")
  assert.equal(glyphFor("HSA deposit"), "hsa")
  assert.equal(glyphFor("401k limit reached"), "limit")
  assert.equal(glyphFor("HSA over its limit"), "limit")
  assert.equal(glyphFor("Match forfeited"), "forfeit")
  assert.equal(glyphFor("Tax due"), "bill")
  assert.equal(glyphFor("State tax bill"), "bill")
  assert.equal(
    glyphFor("Car registration", row("2027-03", { taxOut: 300 })),
    "bill"
  )
  assert.equal(glyphFor("Something new"), "other")
})

test("chartEvents adds detail copy where the row knows the amount", () => {
  const rows = [
    row("2027-01", { events: ["Raise", "IRA deposit"], iraOut: 7000 }),
    row("2027-04", { events: ["Tax refund"], taxOut: -800 }),
    row("2027-09", { events: ["401k limit reached"] }),
  ]
  const ev = chartEvents(rows)
  assert.deepEqual(
    ev.map((e) => [e.i, e.type, e.detail]),
    [
      [0, "raise", null],
      [0, "ira", "$7,000 paid from cash"],
      [1, "bill", "$800 back"],
      [2, "limit", "deferrals stop, take-home rises until January"],
    ]
  )
})

test("chartWarnings pins each warning to its month", () => {
  const rows = monthSpan("2026-11", 6).map((m) => row(m))
  const ws = chartWarnings(
    result(rows, {
      efDrawn: 1016,
      efDrawnMonth: "2026-12",
      forfeitMonth: "2027-03",
      forfeited: 3400,
      unfundedMonths: ["2027-01", "2027-02"],
      unfundedPeak: 750,
    }),
    "2027-06-15"
  )
  assert.deepEqual(
    ws.map((w) => [w.i, w.tone, w.short]),
    [
      [1, "rose", "Reserve empty"],
      [2, "rose", "Checking below $0"],
      [4, "amber", "Match forfeited"],
    ]
  )
  assert.equal(
    ws[0].text,
    "The reserve runs dry in Dec 2026; $1,016 comes out of the emergency fund."
  )
  assert.match(ws[2].text, /\(vests Jun 2027\)\.$/)
  assert.match(ws[1].text, /\(Jan to Feb 2027\)/)
})

test("withOther flags items only the comparison run has", () => {
  type Item = { i: number; k: string; other?: boolean }
  const a: Item[] = [{ i: 1, k: "x" }]
  const b: Item[] = [
    { i: 1, k: "x" },
    { i: 3, k: "y" },
  ]
  const out = withOther(a, b, (v) => v.k)
  assert.deepEqual(
    out.map((v) => [v.i, v.k, !!v.other]),
    [
      [1, "x", false],
      [3, "y", true],
    ]
  )
})

test("warningPills joins one month's warnings, rose winning the tone", () => {
  const pills = warningPills([
    { i: 8, month: "", tone: "amber", short: "Match forfeited", text: "" },
    { i: 8, month: "", tone: "rose", short: "Short month", text: "" },
    { i: 1, month: "", tone: "rose", short: "Reserve empty", text: "" },
  ])
  assert.deepEqual(pills, [
    { i: 1, tone: "rose", text: "Reserve empty" },
    { i: 8, tone: "rose", text: "Match forfeited + Short month" },
  ])
})

test("stackLayers stacks bottom to top and clamps negatives at zero", () => {
  const rows = [row("2026-11", { checking: -200 }), row("2026-12")]
  const defs = [groupSeries("cash", ["checking", "ef", "reserve"])]
  const L = stackLayers(rows, defs)
  assert.deepEqual(L[0].y0, [0, 0])
  assert.deepEqual(L[0].y1, [16_800, 18_500])
  assert.deepEqual(stackTotals(rows, defs), [16_800, 18_500])
})

test("shareSeries sums to 100% over the invested sleeves", () => {
  const r = row("2026-11")
  const ids = ["core", "gold", "ira", "k401", "hsa", "play"] as const
  const total = ids.reduce((t, id) => t + shareSeries(id).get(r), 0)
  assert.ok(Math.abs(total - 1) < 1e-9)
})

test("money formats", () => {
  assert.equal(moneyK(207_400), "$207k")
  assert.equal(moneyK(1500), "$1.5k")
  assert.equal(moneyK(-3000), "−$3k")
  assert.equal(signedK(4200), "+$4.2k")
  assert.equal(signedK(-650), "−$650")
  assert.equal(monthSpanLabel(["2026-12", "2027-02"]), "Dec 2026 to Feb 2027")
})
