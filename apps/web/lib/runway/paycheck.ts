// One paycheck, the way payroll withholds it: each check's taxable wages are
// annualized, run through the yearly brackets, and divided back down. That is
// what a stub shows, which is what this model is calibrated against (the
// yearly return may true it up; one-off bills cover that).
//
// Brackets are the 2026 tables in lib/fire/tax.ts; nothing is copied here.

import {
  type Bracket,
  bracketTax,
  FED_JOINT,
  FED_SINGLE,
  NJ,
  NY,
} from "../fire/tax"
import { periodsPerYear } from "./schedule"
import type { Deduction, ResolvedJob, StateCode } from "./types"

const SS_RATE = 0.062
const MEDICARE = 0.0145

/** Annual state income tax on annual wages after the state deduction.
 * NY nonresident uses the NY schedule: the home-state (NJ) tax is assumed to
 * be credited away. Add a state here. */
export const STATE_WITHHOLDING: Record<
  StateCode,
  (annualWages: number, std: number) => number
> = {
  ny: (w, std) => bracketTax(Math.max(0, w - std), NY),
  ny_nonresident: (w, std) => bracketTax(Math.max(0, w - std), NY),
  nj: (w, std) => bracketTax(Math.max(0, w - std), NJ),
  none: () => 0,
}

/** Money a contribution stream takes off this check. */
export interface Deferral {
  amount: number
  incomeTaxExempt: boolean
  ficaExempt: boolean
}

export interface PaycheckInput {
  gross: number
  /** Payroll contributions this check (401k, HSA). */
  deferrals: Deferral[]
  job: ResolvedJob
  /** 1-based position of this check within its month. */
  paycheckOfMonth: number
  /** State payroll tax (SDI/PFL) already withheld this year. */
  ytdStatePayroll: number
  /** Social Security wages already taxed this year. */
  ytdSsWages: number
}

export interface PaycheckBreakdown {
  gross: number
  /** All payroll contributions taken off this check. */
  deferred: number
  pretaxDeductions: number
  postTaxDeductions: number
  federal: number
  state: number
  fica: number
  statePayroll: number
  /** SS wages taxed by this check (to carry into ytdSsWages). */
  ssWages: number
  net: number
  /** Deduction dollars that land in a sleeve, keyed by sleeve. */
  toSleeves: Partial<Record<string, number>>
}

export function appliesTo(d: Deduction, paycheckOfMonth: number): boolean {
  if (d.per === "paycheck") return true
  return (d.paycheckOfMonth ?? 1) === paycheckOfMonth
}

export function paycheck(input: PaycheckInput): PaycheckBreakdown {
  const { gross, job } = input
  let deferred = 0
  let deferredPretax = 0
  let deferredFica = 0
  for (const d of input.deferrals) {
    deferred += d.amount
    if (d.incomeTaxExempt) deferredPretax += d.amount
    if (d.ficaExempt) deferredFica += d.amount
  }
  const w = job.withholding
  const P = periodsPerYear(job.schedule.frequency)

  let pretaxDed = 0
  let ficaDed = 0
  let postDed = 0
  const toSleeves: Partial<Record<string, number>> = {}
  for (const d of job.deductions) {
    if (!appliesTo(d, input.paycheckOfMonth)) continue
    if (d.pretax) pretaxDed += d.amount
    else postDed += d.amount
    if (d.ficaExempt) ficaDed += d.amount
    if (d.sleeve) toSleeves[d.sleeve] = (toSleeves[d.sleeve] ?? 0) + d.amount
  }

  const taxable = gross - deferredPretax - pretaxDed
  const fedBrackets: Bracket[] = w.filing === "joint" ? FED_JOINT : FED_SINGLE
  const federal =
    bracketTax(Math.max(0, taxable * P - w.federalStd), fedBrackets) / P
  const state = STATE_WITHHOLDING[w.state](taxable * P, w.stateStd) / P

  const ficaWages = Math.max(0, gross - ficaDed - deferredFica)
  const ssWages = Math.max(
    0,
    Math.min(ficaWages, w.ssWageBase - input.ytdSsWages)
  )
  const fica = ssWages * SS_RATE + ficaWages * MEDICARE

  const sp = w.statePayroll
  const variable = sp.rate * gross
  const statePayroll =
    sp.flatPerPaycheck +
    (sp.annualCap == null
      ? variable
      : Math.max(0, Math.min(variable, sp.annualCap - input.ytdStatePayroll)))

  const net =
    gross -
    deferred -
    pretaxDed -
    postDed -
    statePayroll -
    federal -
    state -
    fica
  return {
    gross,
    deferred,
    pretaxDeductions: pretaxDed,
    postTaxDeductions: postDed,
    federal,
    state,
    fica,
    statePayroll,
    ssWages,
    net,
    toSleeves,
  }
}
