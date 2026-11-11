import assert from "node:assert/strict"
import { test } from "node:test"

import { paycheck } from "./paycheck"
import type { Job } from "./types"

const job = (over: Partial<Job> = {}): Job => ({
  employer: "Test",
  grossAnnual: 52_000,
  raise: null,
  schedule: { frequency: "biweekly", anchor: "2026-01-02", days: [] },
  deductions: [],
  withholding: {
    filing: "single",
    federalStd: 16_100,
    state: "none",
    stateStd: 0,
    statePayroll: { flatPerPaycheck: 0, rate: 0, annualCap: null },
    ssWageBase: 184_500,
  },
  match: { type: "none" },
  vesting: null,
  hsaEmployer: null,
  hsaTier: null,
  ...over,
})

const near = (a: number, b: number) =>
  assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`)

test("annualized federal withholding plus FICA, no state", () => {
  // 2000 x 26 = 52,000; minus 16,100 = 35,900 taxable.
  // 12,400 x 10% + 23,500 x 12% = 1,240 + 2,820 = 4,060 / 26.
  const p = paycheck({
    gross: 2000,
    deferrals: [],
    job: job(),
    paycheckOfMonth: 1,
    ytdStatePayroll: 0,
    ytdSsWages: 0,
  })
  near(p.federal, 4060 / 26)
  near(p.fica, 2000 * 0.0765)
  near(p.net, 2000 - 4060 / 26 - 153)
})

test("pre-tax 401k lowers income tax but not FICA; Roth lowers neither", () => {
  const base = {
    job: job(),
    paycheckOfMonth: 1,
    ytdStatePayroll: 0,
    ytdSsWages: 0,
  }
  const pre = paycheck({
    ...base,
    gross: 2000,
    deferrals: [{ amount: 200, incomeTaxExempt: true, ficaExempt: false }],
  })
  const roth = paycheck({
    ...base,
    gross: 2000,
    deferrals: [{ amount: 200, incomeTaxExempt: false, ficaExempt: false }],
  })
  near(pre.fica, roth.fica)
  assert.ok(pre.federal < roth.federal)
  assert.ok(pre.net > roth.net)
})

test("a payroll HSA is exempt from income tax and FICA", () => {
  const base = {
    job: job(),
    gross: 2000,
    paycheckOfMonth: 1,
    ytdStatePayroll: 0,
    ytdSsWages: 0,
  }
  const none = paycheck({ ...base, deferrals: [] })
  const hsa = paycheck({
    ...base,
    deferrals: [{ amount: 200, incomeTaxExempt: true, ficaExempt: true }],
  })
  near(hsa.fica, 1800 * 0.0765)
  assert.ok(hsa.federal < none.federal)
  near(hsa.deferred, 200)
  // Take-home falls by less than the 200 that went in.
  assert.ok(none.net - hsa.net < 200)
})

test("per-month deductions land on their paycheck only; sleeve tallies", () => {
  const j = job({
    deductions: [
      {
        label: "HSA",
        amount: 100,
        per: "month",
        paycheckOfMonth: 2,
        pretax: true,
        ficaExempt: true,
        sleeve: "hsa",
      },
    ],
  })
  const base = {
    gross: 2000,
    deferrals: [],
    job: j,
    ytdStatePayroll: 0,
    ytdSsWages: 0,
  }
  const first = paycheck({ ...base, paycheckOfMonth: 1 })
  const second = paycheck({ ...base, paycheckOfMonth: 2 })
  assert.equal(first.pretaxDeductions, 0)
  assert.equal(second.pretaxDeductions, 100)
  assert.equal(second.toSleeves.hsa, 100)
  near(second.fica, 1900 * 0.0765)
})

test("state payroll stops at its annual cap; SS stops at the wage base", () => {
  const j = job({
    withholding: {
      ...job().withholding,
      statePayroll: { flatPerPaycheck: 0, rate: 0.01, annualCap: 100 },
    },
  })
  const p = paycheck({
    gross: 2000,
    deferrals: [],
    job: j,
    paycheckOfMonth: 1,
    ytdStatePayroll: 95,
    ytdSsWages: 184_000,
  })
  near(p.statePayroll, 5)
  near(p.fica, 500 * 0.062 + 2000 * 0.0145)
})
