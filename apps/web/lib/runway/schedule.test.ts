import assert from "node:assert/strict"
import { test } from "node:test"

import { addMonths, isoDate, monthSpan, paydates } from "./schedule"

test("semi-monthly rolls weekend dates back to Friday", () => {
  // 2026-11-15 is a Sunday; 2026-11-30 is a Monday.
  const d = paydates(
    { frequency: "semimonthly", anchor: null, days: [15, -1] },
    "2026-11-01",
    "2026-11-30"
  ).map(isoDate)
  assert.deepEqual(d, ["2026-11-13", "2026-11-30"])
})

test("-1 is the last weekday of the month", () => {
  // 2027-01-31 is a Sunday.
  const d = paydates(
    { frequency: "semimonthly", anchor: null, days: [-1] },
    "2027-01-01",
    "2027-01-31"
  ).map(isoDate)
  assert.deepEqual(d, ["2027-01-29"])
})

test("biweekly steps from an anchor on either side of asof", () => {
  const before = paydates(
    { frequency: "biweekly", anchor: "2026-10-02", days: [] },
    "2026-11-08",
    "2026-12-31"
  ).map(isoDate)
  assert.deepEqual(before, [
    "2026-11-13",
    "2026-11-27",
    "2026-12-11",
    "2026-12-25",
  ])
  const after = paydates(
    { frequency: "biweekly", anchor: "2027-01-08", days: [] },
    "2026-11-08",
    "2026-12-31"
  ).map(isoDate)
  assert.deepEqual(after, before)
})

test("pay dates are strictly after asof", () => {
  const d = paydates(
    { frequency: "biweekly", anchor: "2026-11-13", days: [] },
    "2026-11-13",
    "2026-11-30"
  ).map(isoDate)
  assert.deepEqual(d, ["2026-11-27"])
})

test("month helpers", () => {
  assert.equal(addMonths("2026-11", 2), "2027-01")
  assert.equal(addMonths("2027-01", -1), "2026-12")
  assert.deepEqual(monthSpan("2026-12", 3), ["2026-12", "2027-01", "2027-02"])
})
