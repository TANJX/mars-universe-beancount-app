// Payroll and income tax on wages, so take-home follows the bracket a salary
// actually lands in instead of a flat ratio.
//
// 2026 schedules. Brackets are inflation-indexed each year, so in a plan that
// works in today's dollars they stay put. Scope is wages only: federal income
// tax (single, or married filing jointly from a chosen year), Social Security
// up to its wage base, Medicare plus the 0.9% surtax, and state income tax per
// person. State is computed on each person's own wages with single schedules
// even after marriage: NY nonresident and NJ joint returns allocate by income
// anyway, and the difference is small next to the federal one.

import type { Person, WorkState } from "./types"

type Bracket = [upTo: number, rate: number]

const FED_SINGLE: Bracket[] = [
  [12_400, 0.1],
  [50_400, 0.12],
  [105_700, 0.22],
  [201_775, 0.24],
  [256_225, 0.32],
  [640_600, 0.35],
  [Number.POSITIVE_INFINITY, 0.37],
]
const FED_JOINT: Bracket[] = [
  [24_800, 0.1],
  [100_800, 0.12],
  [211_400, 0.22],
  [403_550, 0.24],
  [512_450, 0.32],
  [768_700, 0.35],
  [Number.POSITIVE_INFINITY, 0.37],
]
const STD_SINGLE = 16_100
const STD_JOINT = 32_200

const SS_RATE = 0.062
const SS_WAGE_BASE = 184_500
const MEDICARE = 0.0145
const MEDICARE_SURTAX = 0.009
const SURTAX_SINGLE = 200_000
const SURTAX_JOINT = 250_000

const NY: Bracket[] = [
  [8_500, 0.04],
  [11_700, 0.045],
  [13_900, 0.0525],
  [80_650, 0.055],
  [215_400, 0.06],
  [1_077_550, 0.0685],
  [5_000_000, 0.0965],
  [25_000_000, 0.103],
  [Number.POSITIVE_INFINITY, 0.109],
]
const NY_STD = 8_000
/** NY paid family leave + disability, employee share, capped. */
const NY_PAYROLL = (wages: number) => Math.min(wages * 0.00432, 411.91) + 31.2

const NJ: Bracket[] = [
  [20_000, 0.014],
  [35_000, 0.0175],
  [40_000, 0.035],
  [75_000, 0.05525],
  [500_000, 0.0637],
  [1_000_000, 0.0897],
  [Number.POSITIVE_INFINITY, 0.1075],
]
const NJ_EXEMPTION = 1_000
/** NJ disability + family leave insurance, employee share, capped. */
const NJ_PAYROLL = (wages: number) => Math.min(wages, 171_100) * 0.0042

function bracketTax(income: number, brackets: Bracket[]): number {
  let tax = 0
  let floor = 0
  for (const [upTo, rate] of brackets) {
    if (income <= floor) break
    tax += (Math.min(income, upTo) - floor) * rate
    floor = upTo
  }
  return Math.max(0, tax)
}

function marginal(income: number, brackets: Bracket[]): number {
  for (const [upTo, rate] of brackets) if (income <= upTo) return rate
  return brackets.at(-1)?.[1] ?? 0
}

export interface WageInput {
  person: Person
  gross: number
  /** Traditional 401k deferral this year. */
  k401: number
}

export interface WageTax {
  personId: string
  gross: number
  federal: number
  fica: number
  state: number
  total: number
  /** Gross minus 401k minus taxes: cash plus HSA and commuter dollars,
   * which stay the person's money. */
  takeHome: number
  /** Federal + state + Medicare on the next dollar of wages. */
  marginalRate: number
}

function stateTax(state: WorkState, wages: number): number {
  const nj = () =>
    bracketTax(Math.max(0, wages - NJ_EXEMPTION), NJ) + NJ_PAYROLL(wages)
  const ny = () =>
    bracketTax(Math.max(0, wages - NY_STD), NY) + NY_PAYROLL(wages)
  switch (state) {
    case "nj":
      return nj()
    case "ny":
      return ny()
    // NJ resident working in NY: NY taxes the wages as a nonresident, NJ
    // credits it, so the bill is whichever is larger (NY at these incomes).
    case "ny_from_nj":
      return Math.max(ny(), bracketTax(Math.max(0, wages - NJ_EXEMPTION), NJ))
    case "none":
      return 0
  }
}

function stateMarginal(state: WorkState, wages: number): number {
  switch (state) {
    case "nj":
      return marginal(wages - NJ_EXEMPTION, NJ)
    case "ny":
    case "ny_from_nj":
      return marginal(wages - NY_STD, NY)
    case "none":
      return 0
  }
}

/** Tax on one year's wages for everyone earning. `joint` files the people
 * together (federal brackets, deduction and Medicare surtax threshold are
 * shared); the federal bill is then split by each person's taxable wages. */
export function wageTaxes(earners: WageInput[], joint: boolean): WageTax[] {
  const rows = earners.map(({ person, gross, k401 }) => {
    const pretaxFica = Math.min(
      gross,
      person.pretax.hsa + person.pretax.commuter
    )
    const ficaWages = Math.max(0, gross - pretaxFica)
    const taxable = Math.max(0, ficaWages - k401)
    return { person, gross, k401, ficaWages, taxable }
  })

  const fedBy = new Map<string, { tax: number; rate: number }>()
  if (joint && rows.length > 1) {
    const sum = rows.reduce((a, r) => a + r.taxable, 0)
    const income = Math.max(0, sum - STD_JOINT)
    const tax = bracketTax(income, FED_JOINT)
    const rate = marginal(income, FED_JOINT)
    for (const r of rows) {
      fedBy.set(r.person.id, { tax: sum ? (tax * r.taxable) / sum : 0, rate })
    }
  } else {
    for (const r of rows) {
      const income = Math.max(0, r.taxable - STD_SINGLE)
      fedBy.set(r.person.id, {
        tax: bracketTax(income, FED_SINGLE),
        rate: marginal(income, FED_SINGLE),
      })
    }
  }

  const surtaxLine = joint && rows.length > 1 ? SURTAX_JOINT : SURTAX_SINGLE
  const medWages = rows.reduce((a, r) => a + r.ficaWages, 0)
  const surtaxTotal =
    joint && rows.length > 1
      ? Math.max(0, medWages - surtaxLine) * MEDICARE_SURTAX
      : 0

  return rows.map((r) => {
    const fed = fedBy.get(r.person.id) ?? { tax: 0, rate: 0 }
    const surtax =
      joint && rows.length > 1
        ? medWages
          ? (surtaxTotal * r.ficaWages) / medWages
          : 0
        : Math.max(0, r.ficaWages - surtaxLine) * MEDICARE_SURTAX
    const fica =
      Math.min(r.ficaWages, SS_WAGE_BASE) * SS_RATE +
      r.ficaWages * MEDICARE +
      surtax
    const state = stateTax(r.person.workState, r.taxable)
    const total = fed.tax + fica + state
    const overSurtax =
      (joint && rows.length > 1 ? medWages : r.ficaWages) > surtaxLine
    return {
      personId: r.person.id,
      gross: r.gross,
      federal: fed.tax,
      fica,
      state,
      total,
      takeHome: r.gross - r.k401 - total,
      marginalRate:
        fed.rate +
        stateMarginal(r.person.workState, r.taxable) +
        MEDICARE +
        (overSurtax ? MEDICARE_SURTAX : 0) +
        (r.ficaWages < SS_WAGE_BASE ? SS_RATE : 0),
    }
  })
}

export const WORK_STATES: { value: WorkState; label: string }[] = [
  { value: "ny_from_nj", label: "NY (lives in NJ)" },
  { value: "ny", label: "NY (lives in NY)" },
  { value: "nj", label: "NJ" },
  { value: "none", label: "No state tax" },
]
