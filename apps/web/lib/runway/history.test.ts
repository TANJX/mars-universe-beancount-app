import assert from "node:assert/strict"
import { test } from "node:test"

import { chartEvents, eventText, glyphFor, offsetIndex, xLabels } from "./chart"
import {
  historyBefore,
  historyNote,
  historyRow,
  parseRunwayHistory,
} from "./history"
import { monthSpan } from "./schedule"
import type { MonthRow } from "./types"

const sleeves = (over: Record<string, number> = {}) => ({
  checking: 1000,
  ef: 10000,
  reserve: 2000,
  core: 20000,
  ira: 5000,
  k401: 100,
  hsa: 900,
  gold: 0,
  play: 3000,
  other: 0,
  ...over,
})

const histRow = (month: string, over: Record<string, unknown> = {}) => ({
  month,
  sleeves: sleeves(),
  cards: 1500,
  loans: 30000,
  netWorth: 42000 - 1500 - 30000,
  takeHome: 6000,
  spending: 4800,
  net: 1200,
  deposits: { ira: 0, k401: 300, hsa: 0 },
  unmapped: 0,
  ...over,
})

const fixture = {
  asof: "2026-11-13",
  start: "2026-11",
  months: monthSpan("2024-11", 24),
  version: "d37f52248a87a422",
  people: [
    {
      id: "mars",
      available: true,
      reason: null,
      rows: monthSpan("2024-11", 24).map((m) =>
        histRow(
          m,
          m === "2025-04" ? { deposits: { ira: 7000, k401: 300, hsa: 0 } } : {}
        )
      ),
      unmappedAccounts: [],
    },
    {
      id: "sam",
      available: false,
      reason: "Balances are typed into the file, not read from the ledger",
      rows: [],
      unmappedAccounts: [],
    },
  ],
  errors: [],
}

const forecastRow = (month: string): MonthRow => ({
  ...historyRow(parseRunwayHistory(fixture)!.people[0].rows[0]),
  month,
  actual: undefined,
  deposits: undefined,
  events: [],
})

test("parseRunwayHistory reads the contract payload", () => {
  const h = parseRunwayHistory(fixture)
  assert.ok(h)
  assert.equal(h.start, "2026-11")
  assert.equal(h.months.length, 24)
  assert.equal(h.people.length, 2)
  assert.equal(h.people[0].rows.length, 24)
  assert.equal(h.people[0].rows[0].sleeves.core, 20000)
  assert.equal(h.people[1].available, false)
  assert.match(h.people[1].reason ?? "", /typed into the file/)
})

test("parseRunwayHistory tolerates a missing endpoint and bad rows", () => {
  assert.equal(parseRunwayHistory(null), null)
  assert.equal(parseRunwayHistory("<!doctype html>"), null)
  assert.equal(parseRunwayHistory({ status: 404 }), null)
  const h = parseRunwayHistory({
    people: [
      {
        id: "x",
        available: true,
        rows: [
          { month: "bad" },
          { month: "2026-10", sleeves: { core: "1" }, takeHome: 10 },
        ],
      },
      { available: true },
    ],
    errors: ["one", { message: "two" }, 3],
  })
  assert.ok(h)
  assert.equal(h.people.length, 1)
  assert.equal(h.people[0].rows.length, 1)
  assert.equal(h.people[0].rows[0].sleeves.core, 0)
  // A missing net falls back to take-home minus spending.
  assert.equal(h.people[0].rows[0].net, 10)
  assert.deepEqual(h.errors, ["one", "two"])
})

test("historyRow maps a past month onto the chart's row shape", () => {
  const h = parseRunwayHistory(fixture)!
  const r = historyRow(h.people[0].rows[0])
  assert.equal(r.actual, true)
  assert.equal(r.month, "2024-11")
  assert.equal(r.core, 20000)
  assert.equal(r.cash, 13000)
  assert.equal(r.invested, 29000)
  assert.equal(r.netWorth, 10500)
  assert.ok(Math.abs(r.playShare - 3000 / 29000) < 1e-12)
  // Net in the chart is take-home minus outflows; it must be the actual net.
  assert.equal(r.takeHome - r.outflows, 1200)
  assert.equal(r.spendOut, 4800)
  // Forecast-only fields are neutral.
  assert.equal(r.unvested, 0)
  assert.equal(r.reserveToCore, 0)
  assert.equal(r.iraOut, 0)
  assert.equal(r.taxOut, 0)
  assert.deepEqual(r.events, ["401k deposit"])
})

test("history events are deposits only, with the amount that came in", () => {
  const h = parseRunwayHistory(fixture)!
  const rows = h.people[0].rows.map(historyRow)
  const ev = chartEvents(rows)
  assert.ok(ev.every((e) => ["ira", "k401", "hsa"].includes(e.type)))
  const ira = ev.find((e) => e.type === "ira")
  assert.ok(ira)
  assert.equal(ira.month, "2025-04")
  assert.equal(eventText(ira), "IRA deposit: $7,000 in")
  assert.equal(glyphFor("401k deposit"), "k401")
})

test("historyBefore joins the last N months that meet the plan", () => {
  const person = parseRunwayHistory(fixture)!.people[0]
  const plan = monthSpan("2026-11", 24).map(forecastRow)
  const twelve = historyBefore(person, plan, 12)
  assert.equal(twelve.length, 12)
  assert.equal(twelve[0].month, "2025-11")
  assert.equal(twelve.at(-1)?.month, "2026-10")
  assert.equal(historyBefore(person, plan, 24).length, 24)
  assert.equal(historyBefore(person, plan, 0).length, 0)
  assert.equal(historyBefore(null, plan, 12).length, 0)
  // A plan that starts later leaves a gap: draw no history.
  const later = monthSpan("2027-02", 24).map(forecastRow)
  assert.equal(historyBefore(person, later, 12).length, 0)
  // A plan that starts earlier drops the overlapping months.
  const earlier = monthSpan("2026-08", 24).map(forecastRow)
  const e = historyBefore(person, earlier, 12)
  assert.equal(e.at(-1)?.month, "2026-07")
  // A hole in the history keeps only the run that reaches the plan.
  const holed = {
    ...person,
    rows: person.rows.filter((r) => r.month !== "2026-05"),
  }
  const hh = historyBefore(holed, plan, 12)
  assert.equal(hh[0].month, "2026-06")
})

test("historyNote explains a history range that draws only the plan", () => {
  const h = parseRunwayHistory(fixture)
  assert.equal(historyNote(0, null, "mars", 0, true), null)
  assert.equal(historyNote(12, h, "mars", 12, false), null)
  assert.match(historyNote(12, h, "sam", 0, false) ?? "", /typed into/)
  assert.match(historyNote(12, null, "mars", 0, true) ?? "", /not available/)
  assert.match(historyNote(24, h, "nobody", 0, false) ?? "", /No history/)
})

test("offsetIndex moves forecast-indexed items past the history", () => {
  assert.deepEqual(offsetIndex([{ i: 0 }, { i: 3 }], 12), [
    { i: 12 },
    { i: 15 },
  ])
  const xs = [{ i: 1 }]
  assert.equal(offsetIndex(xs, 0), xs)
})

test("xLabels stay apart over 36 and 48 months, phone to desktop", () => {
  for (const n of [36, 48])
    for (const pw of [300, 520, 900]) {
      const months = monthSpan(n === 36 ? "2025-11" : "2024-11", n)
      const step = pw / n
      const x = (i: number) => 36 + (i + 0.5) * step
      const labels = xLabels(months, x)
      assert.ok(labels.length >= 2)
      for (let k = 1; k < labels.length; k++)
        assert.ok(labels[k].x - labels[k - 1].x >= 62)
    }
})
