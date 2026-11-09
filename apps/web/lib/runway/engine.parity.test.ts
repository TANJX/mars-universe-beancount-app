// Parity with the standalone prototype this engine was ported from. The
// fixture holds a real person's numbers, so it never lives in this repo: point
// RUNWAY_PARITY_FIXTURE at a JSON file of the form
//   { horizon, person, expected: { <scenarioId>: { k401, match, need,
//     efDraw, coreDraw, moved, avgPay2027, shortMonths, forfeitMonth,
//     last: { checking, ef, reserve, core, ira, k401, gold, play, invested,
//             netWorth, playShare }, rows?: [{ month, takeHome, ... }] } } }
// (`totals.<key>` nesting is accepted too). Skipped when unset.

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"

import { normalizePerson } from "./config"
import { avgTakeHome, simulate } from "./engine"
import { paycheck } from "./paycheck"
import type { Horizon, RunwayResult } from "./types"

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
  const person = normalizePerson(
    fx.person,
    0,
    fx.horizon.start,
    fx.horizon.asof
  )
  const year2 = String(Number(fx.horizon.start.slice(0, 4)) + 1)
  const top = fx.expected
  const scenarios = (isObj(top.scenarios) ? top.scenarios : top) as Record<
    string,
    Obj
  >
  let checked = 0
  if (typeof top.startNetWorth === "number") {
    const r = simulate({ person, horizon: fx.horizon }, "stay")
    close("startNetWorth", r.startNetWorth, top.startNetWorth)
    checked++
  }
  for (const [key, want] of Object.entries(
    isObj(top.paycheck) ? top.paycheck : {}
  )) {
    const m = /^gross(\d+(?:\.\d+)?)_pre(\d+(?:\.\d+)?)$/.exec(key)
    if (!m) continue
    const pc = paycheck({
      gross: Number(m[1]),
      pre: Number(m[2]),
      roth: 0,
      job: person.job,
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
    const r: RunwayResult = simulate({ person, horizon: fx.horizon }, id)
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
