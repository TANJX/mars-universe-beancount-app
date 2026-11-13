import assert from "node:assert/strict"
import { test } from "node:test"

import { activeJobAt, grossAt, jobEnd, jobWindows, resolveJob } from "./jobs"
import { monthSpan } from "./schedule"
import type { Job, Pay } from "./types"

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  employer: id.toUpperCase(),
  start: null,
  leave: null,
  enabled: true,
  note: null,
  salary: [{ from: "2026-01", gross: 100_000, enabled: true, note: null }],
  match: { type: "none" },
  vesting: null,
  hsaEmployer: null,
  schedule: null,
  deductions: null,
  withholding: null,
  ...over,
})

const months = monthSpan("2026-11", 12)
const id = (j: Job | null) => j?.id ?? null

test("a job with no start pays from before the horizon", () => {
  const a = job("a")
  assert.equal(id(activeJobAt([a], "2000-01")), "a")
  assert.equal(id(activeJobAt([a], "2030-12")), "a")
})

test("a job does not pay before its start", () => {
  const b = job("b", { start: "2027-03" })
  assert.equal(activeJobAt([b], "2027-02"), null)
  assert.equal(id(activeJobAt([b], "2027-03")), "b")
})

test("on overlap the later start wins, whatever the list order", () => {
  const a = job("a")
  const b = job("b", { start: "2027-03" })
  const c = job("c", { start: "2027-06" })
  for (const list of [
    [a, b, c],
    [c, b, a],
    [b, a, c],
  ]) {
    assert.equal(id(activeJobAt(list, "2027-02")), "a")
    assert.equal(id(activeJobAt(list, "2027-03")), "b")
    assert.equal(id(activeJobAt(list, "2027-06")), "c")
  }
})

test("equal starts: the later one in the list wins", () => {
  const a = job("a", { start: "2027-01" })
  const b = job("b", { start: "2027-01" })
  assert.equal(id(activeJobAt([a, b], "2027-01")), "b")
  assert.equal(id(activeJobAt([b, a], "2027-01")), "a")
})

test("the leave month is inclusive; the month after is a gap", () => {
  const a = job("a", { leave: "2027-02" })
  assert.equal(id(activeJobAt([a], "2027-02")), "a")
  assert.equal(activeJobAt([a], "2027-03"), null)
})

test("a later job that has left hands back to the earlier one", () => {
  const a = job("a")
  const b = job("b", { start: "2027-03", leave: "2027-05" })
  assert.equal(id(activeJobAt([a, b], "2027-05")), "b")
  assert.equal(id(activeJobAt([a, b], "2027-06")), "a")
})

test("a disabled job never pays", () => {
  const a = job("a")
  const b = job("b", { start: "2027-03", enabled: false })
  assert.equal(id(activeJobAt([a, b], "2027-06")), "a")
  assert.equal(activeJobAt([job("x", { enabled: false })], "2027-06"), null)
})

test("grossAt takes the latest enabled step on or before the month", () => {
  const a = job("a", {
    salary: [
      { from: "2026-01", gross: 100_000, enabled: true, note: null },
      { from: "2027-02", gross: 110_000, enabled: false, note: "Skipped" },
      { from: "2027-06", gross: 120_000, enabled: true, note: null },
    ],
  })
  assert.equal(grossAt(a, "2025-12"), 0)
  assert.equal(grossAt(a, "2026-01"), 100_000)
  assert.equal(grossAt(a, "2027-03"), 100_000)
  assert.equal(grossAt(a, "2027-06"), 120_000)
  assert.equal(grossAt(job("none", { salary: [] }), "2027-06"), 0)
})

test("resolveJob fills pay settings from the person unless overridden", () => {
  const pay: Pay = {
    schedule: { frequency: "biweekly", anchor: "2026-11-13", days: [] },
    deductions: [
      {
        label: "Medical",
        amount: 10,
        per: "paycheck",
        paycheckOfMonth: null,
        pretax: true,
        ficaExempt: true,
        sleeve: null,
      },
    ],
    withholding: {
      filing: "single",
      federalStd: 16_100,
      state: "none",
      stateStd: 0,
      statePayroll: { flatPerPaycheck: 0, rate: 0, annualCap: null },
      ssWageBase: 184_500,
    },
  }
  const r = resolveJob(job("a"), pay)
  assert.deepEqual(r?.schedule, pay.schedule)
  assert.deepEqual(r?.deductions, pay.deductions)
  const own = {
    frequency: "semimonthly" as const,
    anchor: null,
    days: [15, -1],
  }
  const o = resolveJob(job("b", { schedule: own, deductions: [] }), pay)
  assert.deepEqual(o?.schedule, own)
  assert.deepEqual(o?.deductions, [])
  assert.deepEqual(o?.withholding, pay.withholding)
  assert.equal(resolveJob(job("c"), { ...pay, schedule: null }), null)
})

test("jobWindows groups consecutive months by paying job, gaps as null", () => {
  const a = job("a", { leave: "2027-01" })
  const b = job("b", { start: "2027-04", leave: "2027-08" })
  const c = job("c", { start: "2027-09", enabled: false })
  assert.deepEqual(jobWindows([a, b, c], months), [
    { jobId: "a", from: "2026-11", to: "2027-01" },
    { jobId: null, from: "2027-02", to: "2027-03" },
    { jobId: "b", from: "2027-04", to: "2027-08" },
    { jobId: null, from: "2027-09", to: "2027-10" },
  ])
})

test("jobEnd says when a job stops and what follows", () => {
  const a = job("a")
  const b = job("b", { start: "2027-04", leave: "2027-06" })
  const c = job("c", { start: "2027-09" })
  const jobs = [a, b, c]
  // b replaces a, leaves, and a pays again until c: a job's end is the end
  // of its last run.
  assert.deepEqual(
    jobWindows(jobs, months).map((w) => w.jobId),
    ["a", "b", "a", "c"]
  )
  assert.deepEqual(jobEnd(jobs, a, months), {
    last: "2027-08",
    next: c,
    gap: false,
  })
  assert.deepEqual(jobEnd(jobs, b, months), {
    last: "2027-06",
    next: a,
    gap: false,
  })
  // c pays to the end of the horizon.
  assert.equal(jobEnd(jobs, c, months), null)
  // A job that never pays inside the horizon has no end.
  assert.equal(jobEnd(jobs, job("z", { enabled: false }), months), null)
})

test("jobEnd reports a gap and the next paying job after it", () => {
  const a = job("a", { leave: "2027-01" })
  const b = job("b", { start: "2027-04" })
  assert.deepEqual(jobEnd([a, b], a, months), {
    last: "2027-01",
    next: b,
    gap: true,
  })
  // Nothing after the gap.
  assert.deepEqual(jobEnd([a], a, months), {
    last: "2027-01",
    next: null,
    gap: true,
  })
})
