// Parity with the standalone prototype this engine was ported from. The
// fixture holds a real person's numbers, so it never lives in this repo: point
// RUNWAY_PARITY_FIXTURE at a JSON file of the form
//   { horizon, person, expected: { <scenarioId>: { k401, match, need,
//     efDraw, coreDraw, moved, avgPay2027, shortMonths, forfeitMonth,
//     last: { checking, ef, reserve, core, ira, k401, gold, play, invested,
//             netWorth, playShare }, rows?: [{ month, takeHome, ... }] } } }
// (`totals.<key>` nesting is accepted too). Skipped when unset.
//
// The person may be in the served shape (`jobs`, `contributions`, scenarios
// as `{ id, label, person }`) or in the prototype's (one `job` with a yearly
// `raise`, scenarios as `{ id, start, job }`, `k401.elections`, `ira`);
// `served` below converts the latter, a raise becoming salary steps.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { normalizePerson, runnable, scenarioBody } from "./config"
import { avgTakeHome, simulate } from "./engine"
import { activeJobAt, resolveJob } from "./jobs"
import { paycheck } from "./paycheck"
import { addMonths } from "./schedule"
import type { Horizon, RunwayPerson, RunwayResult } from "./types"
import { PLAN_ID } from "./types"

const path = process.env.RUNWAY_PARITY_FIXTURE
const TOL = 0.01

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** Prototype row names to engine row names. */
const ROW_ALIAS: Record<string, string> = {
  pay: "takeHome",
  out: "outflows",
  moved: "reserveToCore",
  k401c: "k401In",
}

const num = (v: unknown, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d

/** Salary steps for a prototype job paid from `from`: its gross, then one
 * step per raise month strictly after `from`, through `last`. */
function salarySteps(job: Obj, from: string, last: string): Obj[] {
  const gross = num(job.grossAnnual, 0)
  const steps: Obj[] = [{ from, gross, enabled: true, note: null }]
  const raise = isObj(job.raise) ? job.raise : null
  const pct = num(raise?.pct, 0)
  if (!raise || pct === 0) return steps
  const mm = String(num(raise.month, 1)).padStart(2, "0")
  let n = 0
  for (let y = Number(from.slice(0, 4)); y <= Number(last.slice(0, 4)); y++) {
    const m = `${y}-${mm}`
    if (m <= from || m > last) continue
    n++
    steps.push({
      from: m,
      gross: gross * (1 + pct) ** n,
      enabled: true,
      note: null,
    })
  }
  return steps
}

/** The prototype's person in the served shape (see the header). */
function served(raw: Obj, h: Horizon): Obj {
  if (!isObj(raw.job) || Array.isArray(raw.jobs)) return raw
  const { job: _job, k401: _k401, ira: _ira, scenarios: _sc, ...rest } = raw
  const base = raw.job as Obj
  const last = addMonths(h.start, h.months - 1)
  const jobOf = (j: Obj, id: string, start: string | null, own: boolean) => ({
    id,
    employer: typeof j.employer === "string" ? j.employer : id,
    start,
    leave: null,
    enabled: true,
    note: null,
    salary: salarySteps(j, start && start > h.start ? start : h.start, last),
    match: j.match ?? null,
    vesting: j.vesting ?? null,
    hsaEmployer: j.hsaEmployer ?? null,
    schedule: own ? (j.schedule ?? null) : null,
    deductions: own ? (j.deductions ?? null) : null,
    withholding: own ? (j.withholding ?? null) : null,
  })

  // 401k elections, the IRA and an HSA paycheck deduction become streams.
  const k = isObj(raw.k401) ? raw.k401 : {}
  const pre: Obj[] = []
  const roth: Obj[] = []
  let rothOn = false
  const elections = (Array.isArray(k.elections) ? k.elections : [])
    .filter(isObj)
    .sort((a, b) => String(a.from).localeCompare(String(b.from)))
  for (const e of elections) {
    const from = String(e.from).slice(0, 7)
    const both = (a: Obj, b: Obj, on: boolean) => {
      pre.push({ from, ...a })
      if (on || rothOn) roth.push({ from, ...(on ? b : { pace: "off" }) })
      rothOn = on
    }
    if (e.mode === "fixed") {
      const r = num(e.roth, 0)
      const fixed = (amount: number) => ({
        pace: "fixed",
        amount,
        per: "paycheck",
        paycheckOfMonth: null,
      })
      both(fixed(num(e.pretax, 0)), fixed(r), r > 0)
    } else if (e.mode === "percent") {
      const r = num(e.rothPct, 0)
      both(
        { pace: "percent", pct: num(e.pretaxPct, 0) },
        { pace: "percent", pct: r },
        r > 0
      )
    } else if (e.mode === "max_spread") {
      const cap = num(e.capPct, 1)
      const r = Math.max(0, Math.min(1, num(e.rothShare, 0)))
      both(
        { pace: "even", share: 1 - r, capPct: cap * (1 - r) },
        { pace: "even", share: r, capPct: cap * r },
        r > 0
      )
    }
  }
  const contributions: Obj[] = [
    {
      id: "k401-pretax",
      account: "k401",
      tax: "traditional",
      channel: "payroll",
      ytd: isObj(k.ytd) ? k.ytd : {},
      schedule: pre,
    },
  ]
  if (roth.length)
    contributions.push({
      id: "k401-roth",
      account: "k401",
      tax: "roth",
      channel: "payroll",
      ytd: {},
      schedule: roth,
    })
  const isHsa = (d: unknown) =>
    isObj(d) &&
    d.sleeve === "hsa" &&
    d.pretax === true &&
    d.ficaExempt !== false
  const deductions = Array.isArray(base.deductions) ? base.deductions : []
  for (const [i, d] of deductions.filter(isHsa).entries())
    contributions.push({
      id: i ? `hsa-${i + 1}` : "hsa",
      account: "hsa",
      tax: "traditional",
      channel: "payroll",
      ytd: {},
      schedule: [
        {
          from: h.start,
          pace: "fixed",
          amount: d.amount,
          per: d.per,
          paycheckOfMonth: d.paycheckOfMonth ?? null,
        },
      ],
    })
  const strip = (j: Obj): Obj =>
    Array.isArray(j.deductions)
      ? { ...j, deductions: j.deductions.filter((d) => !isHsa(d)) }
      : j
  if (isObj(raw.ira))
    contributions.push({
      id: "ira-roth",
      account: "ira",
      tax: "roth",
      channel: "direct",
      ytd: {},
      schedule: [
        {
          from: h.start,
          pace: "lump",
          month: num(raw.ira.month, 1),
          amount: num(raw.ira.amount, 0),
        },
      ],
    })
  const limits: Record<string, Obj> = {}
  for (const [y, n] of Object.entries(isObj(k.limits) ? k.limits : {}))
    limits[y] = { k401: n }
  for (const [y, row] of Object.entries(isObj(raw.limits) ? raw.limits : {}))
    limits[y] = { ...limits[y], ...(isObj(row) ? row : {}) }

  const current = strip(base)
  const plan: Obj = {
    ...rest,
    pay: {
      schedule: current.schedule,
      deductions: current.deductions,
      withholding: current.withholding,
    },
    jobs: [jobOf(current, "current", null, false)],
    contributions,
    limits,
    spreadThrough: h.spreadThrough,
  }
  // A scenario's job is an overlay on the current one, from its start.
  const scenarios = (Array.isArray(raw.scenarios) ? raw.scenarios : [])
    .filter(isObj)
    .filter((sc) => isObj(sc.job) && typeof sc.start === "string")
    .map((sc) => {
      const sj = sc.job as Obj
      const start = String(sc.start).slice(0, 7)
      const merged = strip({
        ...base,
        ...sj,
        withholding: {
          ...(base.withholding as Obj),
          ...(isObj(sj.withholding) ? sj.withholding : {}),
        },
      })
      const coverage = Array.isArray(raw.hsaCoverage)
        ? raw.hsaCoverage.filter(isObj)
        : []
      const hsaCoverage =
        typeof sj.hsaTier === "string"
          ? [
              ...(coverage.length
                ? coverage.filter((c) => String(c.from) < start)
                : [{ from: "0000-01", tier: "self" }]),
              { from: start, tier: sj.hsaTier },
            ]
          : coverage
      return {
        id: sc.id,
        label: sc.label ?? sc.id,
        person: {
          ...plan,
          jobs: [
            ...(plan.jobs as Obj[]),
            jobOf(merged, String(sc.id), start, true),
          ],
          hsaCoverage,
        },
      }
    })
  return { ...plan, scenarios }
}

function pick(o: Obj, keys: string[]): unknown {
  for (const k of keys) {
    let cur: unknown = o
    for (const part of k.split(".")) cur = (cur as Obj | undefined)?.[part]
    if (cur !== undefined) return cur
  }
  return undefined
}

function close(label: string, got: number, want: unknown) {
  if (typeof want !== "number") return
  assert.ok(
    Math.abs(got - want) <= TOL,
    `${label}: got ${got.toFixed(2)}, want ${want.toFixed(2)}`
  )
}

test("engine matches the prototype", { skip: !path }, () => {
  const fx = JSON.parse(readFileSync(path as string, "utf8")) as {
    horizon: Horizon
    person: unknown
    expected: Record<string, Obj>
  }
  const record = normalizePerson(
    served(fx.person as Obj, fx.horizon),
    0,
    fx.horizon.start,
    fx.horizon.asof
  )
  // The prototype knew one limit, the 401k's. Lift the IRA and HSA limits so
  // the comparison stays about the arithmetic the two share.
  const personFor = (id: string): RunwayPerson => {
    const p = runnable(record, scenarioBody(record, id), fx.horizon.start)
    return {
      ...p,
      limits: Object.fromEntries(
        Object.entries(p.limits).map(([y, l]) => [
          y,
          { ...l, ira: 1e9, hsaSelf: 1e9, hsaFamily: 1e9 },
        ])
      ),
    }
  }
  const person = personFor(PLAN_ID)
  const year2 = String(Number(fx.horizon.start.slice(0, 4)) + 1)
  const top = fx.expected
  const scenarios = (isObj(top.scenarios) ? top.scenarios : top) as Record<
    string,
    Obj
  >
  let checked = 0
  if (typeof top.startNetWorth === "number") {
    const r = simulate({ person, horizon: fx.horizon })
    close("startNetWorth", r.startNetWorth, top.startNetWorth)
    checked++
  }
  const first = activeJobAt(person.jobs, fx.horizon.start)
  const job = first ? resolveJob(first, person.pay) : null
  for (const [key, want] of Object.entries(
    isObj(top.paycheck) ? top.paycheck : {}
  )) {
    const m = /^gross(\d+(?:\.\d+)?)_pre(\d+(?:\.\d+)?)$/.exec(key)
    if (!m || !job) continue
    const pc = paycheck({
      gross: Number(m[1]),
      deferrals: [
        { amount: Number(m[2]), incomeTaxExempt: true, ficaExempt: false },
      ],
      job,
      paycheckOfMonth: 1,
      ytdStatePayroll: 0,
      ytdSsWages: 0,
    })
    close(`paycheck ${key}`, pc.net, want)
    checked++
  }
  for (const [id, exp] of Object.entries(scenarios)) {
    if (!isObj(exp)) continue
    checked++
    const r: RunwayResult = simulate({
      person: personFor(id),
      horizon: fx.horizon,
    })
    const last = r.rows.at(-1)
    assert.ok(last, `${id}: no rows`)
    assert.equal(
      r.forfeitMonth,
      (pick(exp, ["forfeitMonth"]) as string | null | undefined) ?? null,
      `${id}: forfeitMonth`
    )
    close(`${id} k401`, r.k401Contributed, pick(exp, ["k401", "totals.k401"]))
    close(`${id} match`, r.matchTotal, pick(exp, ["match", "totals.match"]))
    close(`${id} need`, r.shortfallTotal, pick(exp, ["need", "totals.need"]))
    close(`${id} efDraw`, r.efDrawn, pick(exp, ["efDraw", "totals.efDraw"]))
    close(
      `${id} coreDraw`,
      r.coreDrawn,
      pick(exp, ["coreDraw", "totals.coreDraw"])
    )
    close(`${id} moved`, r.movedToCore, pick(exp, ["moved", "totals.moved"]))
    close(
      `${id} avg pay ${year2}`,
      avgTakeHome(r, year2),
      pick(exp, [`avgPay${year2}`, `avgMonthlyPay${year2}`, "avgPay"])
    )
    const short = pick(exp, ["shortMonths", "monthsPayBelowOut"])
    if (typeof short === "number")
      assert.equal(r.shortMonths, short, `${id}: shortMonths`)
    const want = (pick(exp, ["last"]) ?? {}) as Obj
    for (const key of [
      "checking",
      "ef",
      "reserve",
      "core",
      "ira",
      "k401",
      "gold",
      "play",
      "invested",
      "netWorth",
    ] as const)
      close(`${id} last ${key}`, last[key], want[key])
    const share = want.playShare ?? want.playPct
    if (typeof share === "number")
      assert.ok(Math.abs(last.playShare - share) < 1e-6, `${id}: playShare`)
    const rows = pick(exp, ["rows"])
    if (Array.isArray(rows))
      for (const w of rows as Obj[]) {
        const g = r.rows.find((x) => x.month === w.month)
        assert.ok(g, `${id}: missing month ${String(w.month)}`)
        for (const [k0, v] of Object.entries(w)) {
          const k = ROW_ALIAS[k0] ?? k0
          if (k !== "month" && k in g)
            close(
              `${id} ${String(w.month)} ${k}`,
              g[k as keyof typeof g] as number,
              v
            )
        }
      }
  }
  assert.ok(checked > 0, "fixture had nothing to compare")
})
