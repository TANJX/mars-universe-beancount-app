// `/api/ext/runway_data` payload → page data.
//
// The endpoint resolves `config/runway.yaml` (defaults, includes, ledger
// balances) into camelCase people. Parsing here is still lenient: every field
// falls back to a safe default, so one odd value never blanks the page. A
// missing config (or no resolvable people) yields the demo plan, and the page
// says so.
//
// People the endpoint could not resolve come back two ways, both handled:
// as entries with a `status` ("locked" | "missing" | "error"), or as errors
// whose message names the cause (a git-crypt encrypted include, say).

import { z } from "zod"

import { CHANNELS, defaultLimits, paceAllowed } from "./contributions"
import { DEFAULT_WITHHOLDING, demoRunway, zeroSleeves } from "./demo"
import { applyPatch, diffPatch } from "./patch"
import type {
  Channel,
  Contribution,
  Deduction,
  Horizon,
  HsaCoverage,
  HsaTier,
  Job,
  LimitsGiven,
  Match,
  Pace,
  PaySchedule,
  PersonRecord,
  Phase,
  PlanBody,
  Returns,
  RunwayData,
  RunwayInputs,
  RunwayIssue,
  RunwayPerson,
  SalaryStep,
  ScenarioDef,
  SharedSettings,
  SleeveKey,
  SleeveText,
  SpreadThrough,
  StateCode,
  UnavailablePerson,
  Withholding,
  YearLimits,
} from "./types"
import { PLAN_ID, SLEEVE_KEYS } from "./types"

export const RunwayDataSchema = z
  .object({
    asof: z.string().optional(),
    fromConfig: z.boolean().optional(),
    start: z.string().optional(),
    months: z.number().optional(),
    firstMonthSpendFraction: z.number().optional(),
    reserveLookahead: z.number().optional(),
    version: z.string().optional(),
    shared: z.record(z.string(), z.unknown()).optional(),
    defaults: z.record(z.string(), z.unknown()).optional(),
    people: z.array(z.record(z.string(), z.unknown())).optional(),
    errors: z.array(z.unknown()).optional(),
    warnings: z.array(z.unknown()).optional(),
  })
  .loose()

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const obj = (v: unknown): Obj => (isObj(v) ? v : {})
const num = (v: unknown, d: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : d
const numOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null
const str = (v: unknown, d: string): string =>
  typeof v === "string" && v ? v : d
const bool = (v: unknown, d: boolean): boolean =>
  typeof v === "boolean" ? v : d
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const MONTH = /^\d{4}-\d{2}$/
const month = (v: unknown, d: string): string =>
  typeof v === "string" && MONTH.test(v.slice(0, 7)) ? v.slice(0, 7) : d
const isSleeve = (v: unknown): v is SleeveKey =>
  typeof v === "string" && (SLEEVE_KEYS as string[]).includes(v)

function numRecord(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, x] of Object.entries(obj(v)))
    if (typeof x === "number" && Number.isFinite(x)) out[k] = x
  return out
}

function parseSchedule(v: unknown): PaySchedule | null {
  const o = obj(v)
  if (o.frequency !== "biweekly" && o.frequency !== "semimonthly") return null
  return {
    frequency: o.frequency,
    anchor: typeof o.anchor === "string" ? o.anchor : null,
    days: arr(o.days).filter((x): x is number => typeof x === "number"),
  }
}

function parseDeduction(v: unknown): Deduction | null {
  const o = obj(v)
  const amount = numOrNull(o.amount)
  if (amount == null) return null
  const pretax = bool(o.pretax, false)
  return {
    label: str(o.label, "Deduction"),
    amount,
    per: o.per === "month" ? "month" : "paycheck",
    paycheckOfMonth: numOrNull(o.paycheckOfMonth),
    pretax,
    ficaExempt: bool(o.ficaExempt, pretax),
    sleeve: isSleeve(o.sleeve) ? o.sleeve : null,
  }
}

function parseMatch(v: unknown): Match {
  const o = obj(v)
  switch (o.type) {
    case "flat":
      return { type: "flat", pct: num(o.pct, 0) }
    case "threshold":
      return { type: "threshold", minPct: num(o.minPct, 0), pct: num(o.pct, 0) }
    case "tiered":
      return {
        type: "tiered",
        tiers: arr(o.tiers).map((t) => ({
          rate: num(obj(t).rate, 0),
          upToPct: num(obj(t).upToPct, 0),
        })),
      }
    default:
      return { type: "none" }
  }
}

const STATES: StateCode[] = ["ny", "ny_nonresident", "nj", "none"]
const TIERS: HsaTier[] = ["self", "family", "none"]
const isTier = (v: unknown): v is HsaTier =>
  typeof v === "string" && (TIERS as string[]).includes(v)

function parseWithholding(v: unknown): Withholding {
  const w = obj(v)
  const sp = obj(w.statePayroll)
  const dw = DEFAULT_WITHHOLDING
  const ytd = numRecord(sp.ytd)
  return {
    filing: w.filing === "joint" ? "joint" : "single",
    federalStd: num(w.federalStd, dw.federalStd),
    state: STATES.includes(w.state as StateCode)
      ? (w.state as StateCode)
      : dw.state,
    stateStd: num(w.stateStd, dw.stateStd),
    statePayroll: {
      flatPerPaycheck: num(sp.flatPerPaycheck, 0),
      rate: num(sp.rate, 0),
      annualCap: numOrNull(sp.annualCap),
      ...(Object.keys(ytd).length ? { ytd } : {}),
    },
    ssWageBase: num(w.ssWageBase, dw.ssWageBase),
  }
}

const parseDeductions = (v: unknown): Deduction[] =>
  arr(v)
    .map(parseDeduction)
    .filter((x): x is Deduction => x !== null)

function parseSalary(v: unknown, start: string): SalaryStep[] {
  return byFrom(
    arr(v)
      .map(obj)
      .filter((x) => typeof x.from === "string")
      .map((x) => ({
        from: month(x.from, start),
        gross: Math.max(0, num(x.gross, 0)),
        enabled: bool(x.enabled, true),
        note: typeof x.note === "string" && x.note ? x.note : null,
      }))
  )
}

function parseJob(v: unknown, i: number, start: string): Job {
  const o = obj(v)
  const he = isObj(o.hsaEmployer) ? o.hsaEmployer : null
  const ve = isObj(o.vesting) ? o.vesting : null
  return {
    id: str(o.id, `job-${i + 1}`),
    employer: str(o.employer, `Job ${i + 1}`),
    start: o.start == null ? null : month(o.start, start),
    leave: o.leave == null ? null : month(o.leave, start),
    enabled: bool(o.enabled, true),
    note: typeof o.note === "string" && o.note ? o.note : null,
    salary: parseSalary(o.salary, start),
    match: parseMatch(o.match),
    vesting: ve
      ? {
          date: str(ve.date, "2100-01-01"),
          unvestedStart: num(ve.unvestedStart, 0),
        }
      : null,
    hsaEmployer: he
      ? {
          amount: Math.max(0, num(he.amount, 0)),
          month: Math.max(1, Math.min(12, num(he.month, 1))),
        }
      : null,
    schedule: o.schedule == null ? null : parseSchedule(o.schedule),
    deductions: o.deductions == null ? null : parseDeductions(o.deductions),
    withholding: o.withholding == null ? null : parseWithholding(o.withholding),
  }
}

function parsePace(o: Obj, channel: Channel): Pace | null {
  const kind = o.pace
  if (typeof kind !== "string") return null
  switch (kind) {
    case "off":
      return { pace: "off" }
    case "fixed":
      return {
        pace: "fixed",
        amount: Math.max(0, num(o.amount, 0)),
        per: channel === "direct" || o.per === "month" ? "month" : "paycheck",
        paycheckOfMonth:
          channel === "direct" ? null : numOrNull(o.paycheckOfMonth),
      }
    case "percent":
      return paceAllowed("percent", channel)
        ? { pace: "percent", pct: Math.max(0, num(o.pct, 0)) }
        : null
    case "even":
      return {
        pace: "even",
        share: Math.max(0, Math.min(1, num(o.share, 1))),
        capPct: Math.max(0, num(o.capPct, 1)),
      }
    case "front_load":
      return paceAllowed("front_load", channel)
        ? {
            pace: "front_load",
            share: Math.max(0, Math.min(1, num(o.share, 1))),
            capPct: Math.max(0, num(o.capPct, 1)),
          }
        : null
    case "lump":
      return paceAllowed("lump", channel)
        ? {
            pace: "lump",
            month: Math.max(1, Math.min(12, Math.round(num(o.month, 1)))),
            amount: numOrNull(o.amount),
          }
        : null
    default:
      return null
  }
}

const byFrom = <T extends { from: string }>(list: T[]): T[] =>
  [...list].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))

function parseContribution(
  v: unknown,
  index: number,
  start: string
): Contribution | null {
  const o = obj(v)
  const account = o.account
  if (account !== "k401" && account !== "ira" && account !== "hsa") return null
  const channels = CHANNELS[account]
  const channel =
    channels.find((c) => c === o.channel) ?? (channels[0] as Channel)
  const tax =
    account === "hsa" || o.tax !== "roth" ? "traditional" : ("roth" as const)
  const schedule: Phase[] = []
  for (const x of arr(o.schedule)) {
    const po = obj(x)
    const pace = parsePace(po, channel)
    if (pace) schedule.push({ from: month(po.from, start), ...pace })
  }
  return {
    id: str(o.id, `${account}-${index + 1}`),
    account,
    tax,
    channel,
    ytd: numRecord(o.ytd),
    ...(typeof o.ytdFrom === "string" && o.ytdFrom
      ? { ytdFrom: o.ytdFrom, ytdLedger: numRecord(o.ytdLedger) }
      : {}),
    schedule: byFrom(schedule),
  }
}

const LIMIT_KEYS = ["k401", "ira", "hsaSelf", "hsaFamily"] as const
/** Years of limits kept on a person: the longest horizon is ten years. */
const LIMIT_YEARS = 11

/** Configured limits as served: by year, any subset of the four keys. */
function parseGiven(v: unknown): LimitsGiven {
  const out: LimitsGiven = {}
  for (const [y, raw] of Object.entries(obj(v))) {
    const o = obj(raw)
    const row: Partial<YearLimits> = {}
    for (const k of LIMIT_KEYS) {
      const n = numOrNull(o[k])
      if (n != null) row[k] = Math.max(0, n)
    }
    if (Object.keys(row).length) out[y] = row
  }
  return out
}

/** Limits for every year the horizon can reach. Each field takes the config
 * value for that year, else the closest earlier configured year, else the
 * bundled IRS table (with catch-up from the birth year). */
export function resolveLimits(
  given: LimitsGiven,
  start: string,
  birthYear: number | null
): Record<string, YearLimits> {
  const years = Object.keys(given)
    .map(Number)
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b)
  const first = Number(start.slice(0, 4))
  const out: Record<string, YearLimits> = {}
  for (let y = first; y < first + LIMIT_YEARS; y++) {
    const row = defaultLimits(y, birthYear)
    for (const k of LIMIT_KEYS) {
      const at = years.filter((g) => g <= y && given[g]?.[k] != null).at(-1)
      const n = at != null ? given[at]?.[k] : undefined
      if (n != null) row[k] = n
    }
    out[y] = row
  }
  return out
}

const DEFAULT_RETURNS: Returns = {
  equity: 0.07,
  reserve: 0.039,
  ef: 0.0365,
  gold: 0.03,
}
const spreadOf = (v: unknown, d: SpreadThrough): SpreadThrough =>
  v === "horizon" || v === "year_end" ? v : d

function parseReturns(v: unknown, d: Returns = DEFAULT_RETURNS): Returns {
  const r = obj(v)
  return {
    equity: num(r.equity, d.equity),
    reserve: num(r.reserve, d.reserve),
    ef: num(r.ef, d.ef),
    gold: num(r.gold, d.gold),
  }
}

export function parseShared(v: unknown): SharedSettings {
  const o = obj(v)
  return {
    returns: parseReturns(o.returns),
    limits: parseGiven(o.limits),
    playCap: num(o.playCap, 0.1),
    spreadThrough: spreadOf(o.spreadThrough, "year_end"),
  }
}

/** One plan body (the person's or a scenario's) exactly as served. */
export function parseBody(
  v: unknown,
  start: string,
  fallbackLabel: string
): PlanBody {
  const o = obj(v)
  const c = obj(o.cash)
  const pay = obj(o.pay)
  const cardPayoff: PlanBody["cash"]["cardPayoff"] = {}
  for (const key of ["checking", "ef", "reserve"] as const) {
    const x = numOrNull(obj(c.cardPayoff)[key])
    if (x != null) cardPayoff[key] = x
  }
  if (Object.keys(cardPayoff).length === 0) cardPayoff.checking = 1
  return {
    label: str(o.label, fallbackLabel),
    birthYear: numOrNull(o.birthYear),
    pay: {
      schedule: parseSchedule(pay.schedule),
      deductions: parseDeductions(pay.deductions),
      withholding: parseWithholding(pay.withholding),
    },
    jobs: arr(o.jobs).map((j, i) => parseJob(j, i, start)),
    contributions: arr(o.contributions)
      .map((x, i) => parseContribution(x, i, start))
      .filter((x): x is Contribution => x !== null),
    limits: parseGiven(o.limits),
    hsaCoverage: byFrom(
      arr(o.hsaCoverage)
        .map(obj)
        .filter((x) => isTier(x.tier))
        .map(
          (x): HsaCoverage => ({
            from: month(x.from, start),
            tier: x.tier as HsaTier,
          })
        )
    ),
    spendingMonthly: num(o.spendingMonthly, 0),
    oneOffs: arr(o.oneOffs)
      .map((x) => obj(x))
      .filter((x) => typeof x.month === "string")
      .map((x) => ({
        ...(typeof x.id === "string" ? { id: x.id } : {}),
        month: month(x.month, start),
        amount: num(x.amount, 0),
        label: str(x.label, "One-off"),
      })),
    cash: {
      buffer: num(c.buffer, 0),
      efMonths: num(c.efMonths, 6),
      earmarks: arr(c.earmarks).map((e) => ({
        label: str(obj(e).label, "Earmark"),
        amount: num(obj(e).amount, 0),
      })),
      dcaMonths: num(c.dcaMonths, 12),
      cardPayoff,
    },
    returns: parseReturns(o.returns),
    playCap: num(o.playCap, 0.1),
    spreadThrough: spreadOf(o.spreadThrough, "year_end"),
  }
}

/** One resolved person from the endpoint, every field defaulted. */
export function normalizePerson(
  v: unknown,
  index: number,
  start: string,
  asof: string
): PersonRecord {
  const o = obj(v)
  const s = obj(o.starting)
  const id = str(o.id, `person-${index + 1}`)
  const plan = parseBody(
    o,
    start,
    str(o.name, str(o.id, `Person ${index + 1}`))
  )

  const scenarios: ScenarioDef[] = []
  for (const [i, x] of arr(o.scenarios).entries()) {
    const so = obj(x)
    const sid = str(so.id, `scenario-${i + 1}`)
    if (sid === PLAN_ID || scenarios.some((y) => y.id === sid)) continue
    // Served as a whole body; kept as a patch over the plan so plan edits
    // flow into every scenario.
    const body = isObj(so.person)
      ? parseBody(so.person, start, plan.label)
      : plan
    scenarios.push({
      id: sid,
      label: str(so.label, sid),
      patch: diffPatch(body, plan) as Record<string, unknown>,
    })
  }

  const sleeves = zeroSleeves()
  for (const [key, val] of Object.entries(obj(s.sleeves))) {
    // The prototype called the IRA sleeve "roth".
    const kk = key === "roth" ? "ira" : key
    if (isSleeve(kk)) sleeves[kk] = num(val, 0)
  }

  const sleeveText: Partial<Record<SleeveKey, SleeveText>> = {}
  // `sleeve_info` in YAML is a list of { id, title, body }.
  for (const item of arr(o.sleeveInfo)) {
    const t = obj(item)
    const key = t.id === "roth" ? "ira" : t.id
    if (isSleeve(key))
      sleeveText[key] = {
        title: typeof t.title === "string" ? t.title : undefined,
        body: typeof t.body === "string" ? t.body : undefined,
      }
  }
  for (const [key, val] of Object.entries(obj(o.sleeveText ?? o.sleeves))) {
    const t = obj(val)
    if (
      isSleeve(key) &&
      (typeof t.title === "string" || typeof t.body === "string")
    )
      sleeveText[key] = {
        title: typeof t.title === "string" ? t.title : undefined,
        body: typeof t.body === "string" ? t.body : undefined,
      }
  }
  const notModeled = Array.isArray(o.notModeled)
    ? o.notModeled.filter((x): x is string => typeof x === "string")
    : null

  return {
    id,
    plan,
    scenarios,
    overrides: arr(o.overrides).filter(
      (x): x is string => typeof x === "string"
    ),
    readOnly: bool(o.readOnly, false),
    file: str(o.file, "config/runway.yaml"),
    starting: {
      source: s.source === "ledger" ? "ledger" : "static",
      asof: str(s.asof, asof),
      sleeves,
      cards: num(s.cards, 0),
      loans: num(s.loans, 0),
      unvested: num(s.unvested, 0),
      accounts: arr(s.accounts).map((a) => {
        const ao = obj(a)
        return {
          account: str(ao.account, ""),
          currency: str(ao.currency, "USD"),
          sleeve: isSleeve(ao.sleeve) ? ao.sleeve : "other",
          usd: num(ao.usd, 0),
        }
      }),
      unmapped: arr(s.unmapped).map((a) => {
        const ao = obj(a)
        return {
          account: str(ao.account, ""),
          currency: str(ao.currency, "USD"),
          usd: num(ao.usd, 0),
        }
      }),
    },
    sleeveText,
    notModeled,
  }
}

/** The plan body of a scenario (or the plan itself for PLAN_ID). */
export function scenarioBody(
  record: PersonRecord,
  scenarioId: string
): PlanBody {
  const s = record.scenarios.find((x) => x.id === scenarioId)
  return s ? applyPatch(record.plan, s.patch) : record.plan
}

/** A plan body made runnable: limits resolved, balances attached. */
export function runnable(
  record: PersonRecord,
  body: PlanBody,
  start: string
): RunwayPerson {
  const { limits, ...rest } = body
  return {
    ...rest,
    id: record.id,
    limits: resolveLimits(limits, start, body.birthYear),
    limitsGiven: limits,
    starting: record.starting,
    sleeveText: record.sleeveText,
    notModeled: record.notModeled,
  }
}

/** Back from the runnable shape to the plan body (what is saved). */
export function bodyOf(p: RunwayPerson): PlanBody {
  return {
    label: p.label,
    birthYear: p.birthYear,
    pay: p.pay,
    jobs: p.jobs,
    contributions: p.contributions,
    limits: p.limitsGiven,
    hsaCoverage: p.hsaCoverage,
    spendingMonthly: p.spendingMonthly,
    oneOffs: p.oneOffs,
    cash: p.cash,
    returns: p.returns,
    playCap: p.playCap,
    spreadThrough: p.spreadThrough,
  }
}

function parseIssue(v: unknown): RunwayIssue {
  const o = obj(v)
  return {
    personId: typeof o.personId === "string" ? o.personId : null,
    path: str(o.path, ""),
    message: str(o.message, String(v)),
  }
}

function statusFromMessage(msg: string): UnavailablePerson["status"] {
  if (/git-?crypt|encrypted|locked/i.test(msg)) return "locked"
  if (/missing|not found|no such|does not exist/i.test(msg)) return "missing"
  return "error"
}

const FILE_RE = /([\w./-]+\.ya?ml)/

/** Today as YYYY-MM-DD in local time. */
export function todayIso(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function unavailableFrom(o: Obj, i: number): UnavailablePerson {
  const message = str(o.message, "")
  return {
    id: str(o.id, `person-${i + 1}`),
    label: str(o.label ?? o.name, str(o.id, `Person ${i + 1}`)),
    status:
      o.status === "locked" || o.status === "missing" ? o.status : "error",
    message,
    file:
      typeof o.file === "string"
        ? o.file
        : (FILE_RE.exec(message)?.[1] ?? null),
  }
}

export function parseRunwayData(raw: unknown, today = todayIso()): RunwayData {
  const parsed = RunwayDataSchema.safeParse(raw)
  const demo = demoRunway(today)
  if (!parsed.success) return demo
  const d = parsed.data
  const asof = str(d.asof, today).slice(0, 10)
  const start = month(d.start, asof.slice(0, 7))
  const errors = arr(d.errors).map(parseIssue)
  const warnings = arr(d.warnings).map(parseIssue)

  const people: PersonRecord[] = []
  const unavailable: UnavailablePerson[] = []
  arr(d.people).forEach((p, i) => {
    const o = obj(p)
    if (typeof o.status === "string" && o.status !== "ok") {
      unavailable.push(unavailableFrom(o, i))
      return
    }
    // Wrapped shape { id, name, status, data } or the resolved person itself.
    const body = isObj(o.data)
      ? { id: o.id, label: o.name ?? o.label, ...o.data }
      : o
    people.push(normalizePerson(body, i, start, asof))
  })
  // The roster lists every configured person in config order, including the
  // ones that could not be resolved (encrypted, missing, invalid).
  const roster = arr(d.roster).map(obj)
  roster.forEach((o, i) => {
    if (o.status === "ok" || typeof o.status !== "string") return
    const id = str(o.id, `person-${i + 1}`)
    if (people.some((p) => p.id === id) || unavailable.some((u) => u.id === id))
      return
    unavailable.push(unavailableFrom(o, i))
  })
  const rank = new Map(roster.map((o, i) => [str(o.id, ""), i]))
  for (const p of people) {
    const r = roster.find((o) => o.id === p.id)
    if (r && typeof r.file === "string" && r.file) p.file = r.file
  }

  // Flat shape: a person whose include could not be read is dropped and
  // reported as an error on `people[n]`. Surface it so the page can say why.
  const known = new Set([...people, ...unavailable].map((x) => x.id))
  for (const e of errors) {
    const m = /^people\[(\d+)\](?:\.include)?$/.exec(e.path)
    if (!m && !(e.personId && !known.has(e.personId))) continue
    const id = e.personId ?? `person-${Number(m?.[1] ?? 0) + 1}`
    if (known.has(id)) continue
    known.add(id)
    unavailable.push({
      id,
      label: e.personId ?? `Person ${Number(m?.[1] ?? 0) + 1}`,
      status: statusFromMessage(e.message),
      message: e.message,
      file: FILE_RE.exec(e.message)?.[1] ?? null,
    })
  }

  const fromConfig = bool(d.fromConfig, true)
  if (!fromConfig || (people.length === 0 && unavailable.length === 0))
    return { ...demo, errors, warnings }

  return {
    asof,
    start,
    months: Math.max(1, Math.min(120, Math.round(num(d.months, 24)))),
    firstMonthSpendFraction: Math.max(
      0,
      Math.min(1, num(d.firstMonthSpendFraction, demo.firstMonthSpendFraction))
    ),
    version: str(d.version, ""),
    shared: parseShared(d.shared),
    reserveLookahead: Math.max(0, Math.round(num(d.reserveLookahead, 12))),
    fromConfig: true,
    people,
    unavailable,
    order: [...people.map((p) => p.id), ...unavailable.map((u) => u.id)].sort(
      (a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9)
    ),
    errors,
    warnings,
  }
}

export function horizonOf(
  data: RunwayData,
  spreadThrough: SpreadThrough
): Horizon {
  return {
    asof: data.asof,
    start: data.start,
    months: data.months,
    firstMonthSpendFraction: data.firstMonthSpendFraction,
    spreadThrough,
    reserveLookahead: data.reserveLookahead,
  }
}

/** Engine inputs for one runnable plan. */
export function personInputs(
  person: RunwayPerson,
  data: RunwayData
): RunwayInputs {
  return { person, horizon: horizonOf(data, person.spreadThrough) }
}

export const DEMO_RUNWAY: RunwayData = demoRunway("2026-11-08")
