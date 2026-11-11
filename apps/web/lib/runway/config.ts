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
import type {
  Channel,
  Contribution,
  ContributionAccount,
  Deduction,
  Horizon,
  HsaCoverage,
  HsaTier,
  Job,
  JobScenario,
  Match,
  Pace,
  PaySchedule,
  Phase,
  RunwayData,
  RunwayInputs,
  RunwayIssue,
  RunwayPerson,
  SleeveKey,
  SleeveText,
  StateCode,
  UnavailablePerson,
  YearLimits,
} from "./types"
import { SLEEVE_KEYS } from "./types"

export const RunwayDataSchema = z
  .object({
    asof: z.string().optional(),
    fromConfig: z.boolean().optional(),
    start: z.string().optional(),
    months: z.number().optional(),
    firstMonthSpendFraction: z.number().optional(),
    spreadThrough: z.string().optional(),
    reserveLookahead: z.number().optional(),
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

function parseSchedule(v: unknown, d: PaySchedule): PaySchedule {
  const o = obj(v)
  const frequency =
    o.frequency === "biweekly" || o.frequency === "semimonthly"
      ? o.frequency
      : d.frequency
  return {
    frequency,
    anchor: typeof o.anchor === "string" ? o.anchor : d.anchor,
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

function parseJob(v: unknown, d: Job): Job {
  const o = obj(v)
  const w = obj(o.withholding)
  const sp = obj(w.statePayroll)
  const dw = d.withholding
  const raise = o.raise === null ? null : isObj(o.raise) ? o.raise : undefined
  const vesting =
    o.vesting === null ? null : isObj(o.vesting) ? o.vesting : undefined
  return {
    employer: str(o.employer, d.employer),
    grossAnnual: num(o.grossAnnual, d.grossAnnual),
    raise:
      raise === undefined
        ? d.raise
        : raise === null
          ? null
          : { month: num(raise.month, 1), pct: num(raise.pct, 0) },
    schedule: parseSchedule(o.schedule, d.schedule),
    deductions: Array.isArray(o.deductions)
      ? o.deductions
          .map(parseDeduction)
          .filter((x): x is Deduction => x !== null)
      : d.deductions,
    withholding: {
      filing: w.filing === "joint" ? "joint" : dw.filing,
      federalStd: num(w.federalStd, dw.federalStd),
      state: STATES.includes(w.state as StateCode)
        ? (w.state as StateCode)
        : dw.state,
      stateStd: num(w.stateStd, dw.stateStd),
      statePayroll: {
        flatPerPaycheck: num(
          sp.flatPerPaycheck,
          dw.statePayroll.flatPerPaycheck
        ),
        rate: num(sp.rate, dw.statePayroll.rate),
        annualCap:
          "annualCap" in sp
            ? numOrNull(sp.annualCap)
            : dw.statePayroll.annualCap,
      },
      ssWageBase: num(w.ssWageBase, dw.ssWageBase),
    },
    match: "match" in o ? parseMatch(o.match) : d.match,
    hsaEmployer:
      "hsaEmployer" in o
        ? isObj(o.hsaEmployer)
          ? {
              amount: Math.max(0, num(o.hsaEmployer.amount, 0)),
              month: Math.max(1, Math.min(12, num(o.hsaEmployer.month, 1))),
            }
          : null
        : d.hsaEmployer,
    hsaTier: isTier(o.hsaTier) ? o.hsaTier : null,
    vesting:
      vesting === undefined
        ? d.vesting
        : vesting === null
          ? null
          : {
              date: str(vesting.date, "2100-01-01"),
              unvestedStart: num(vesting.unvestedStart, 0),
            },
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
    schedule: byFrom(schedule),
  }
}

/** The pre-contributions shape (`k401.elections`, `ira`, an HSA paycheck
 * deduction) as streams. Each account converts only when the new list has no
 * stream for it, so a half-migrated config never counts money twice. Returns
 * the labels of deductions that became streams. */
function legacyContributions(
  o: Obj,
  job: Job,
  start: string,
  have: Set<ContributionAccount>
): { list: Contribution[]; hsaDeductions: Set<string> } {
  const list: Contribution[] = []
  const hsaDeductions = new Set<string>()
  const k = obj(o.k401)
  const elections = byFrom(
    arr(k.elections)
      .map(obj)
      .filter((e) => typeof e.mode === "string")
      .map((e): Obj & { from: string } => ({
        ...e,
        from: month(e.from, start),
      }))
  )
  const ytd = numRecord(k.ytd)
  if (!have.has("k401") && (elections.length || Object.keys(ytd).length)) {
    const pre: Phase[] = []
    const roth: Phase[] = []
    let rothOn = false
    for (const e of elections) {
      const from = e.from
      const both = (a: Pace, b: Pace, on: boolean) => {
        pre.push({ from, ...a })
        if (on || rothOn) roth.push({ from, ...(on ? b : { pace: "off" }) })
        rothOn = on
      }
      if (e.mode === "fixed") {
        const r = num(e.roth, 0)
        both(
          {
            pace: "fixed",
            amount: num(e.pretax, 0),
            per: "paycheck",
            paycheckOfMonth: null,
          },
          { pace: "fixed", amount: r, per: "paycheck", paycheckOfMonth: null },
          r > 0
        )
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
    list.push({
      id: "k401-pretax",
      account: "k401",
      tax: "traditional",
      channel: "payroll",
      ytd,
      schedule: pre,
    })
    if (roth.length)
      list.push({
        id: "k401-roth",
        account: "k401",
        tax: "roth",
        channel: "payroll",
        ytd: {},
        schedule: roth,
      })
  }
  if (!have.has("hsa"))
    for (const d of job.deductions) {
      if (d.sleeve !== "hsa" || !d.pretax || !d.ficaExempt) continue
      hsaDeductions.add(d.label)
      list.push({
        id: hsaDeductions.size > 1 ? `hsa-${hsaDeductions.size}` : "hsa",
        account: "hsa",
        tax: "traditional",
        channel: "payroll",
        ytd: {},
        schedule: [
          {
            from: start,
            pace: "fixed",
            amount: d.amount,
            per: d.per,
            paycheckOfMonth: d.paycheckOfMonth,
          },
        ],
      })
    }
  if (!have.has("ira") && isObj(o.ira))
    list.push({
      id: "ira-roth",
      account: "ira",
      tax: "roth",
      channel: "direct",
      ytd: {},
      schedule: [
        {
          from: start,
          pace: "lump",
          month: Math.max(1, Math.min(12, num(o.ira.month, 1))),
          amount: num(o.ira.amount, 0),
        },
      ],
    })
  return { list, hsaDeductions }
}

const LIMIT_KEYS = ["k401", "ira", "hsaSelf", "hsaFamily"] as const
/** Years of limits kept on a person: the longest horizon is ten years. */
const LIMIT_YEARS = 11

/** Limits for every year the horizon can reach. Each field takes the config
 * value for that year, else the closest earlier configured year, else the
 * bundled IRS table (with catch-up from the birth year). */
function parseLimits(
  v: unknown,
  legacyK401: Record<string, number>,
  start: string,
  birthYear: number | null
): Record<string, YearLimits> {
  const given: Record<string, Partial<YearLimits>> = {}
  for (const [y, n] of Object.entries(legacyK401)) given[y] = { k401: n }
  for (const [y, raw] of Object.entries(obj(v))) {
    const o = obj(raw)
    const row: Partial<YearLimits> = { ...given[y] }
    for (const k of LIMIT_KEYS) {
      const n = numOrNull(o[k])
      if (n != null) row[k] = Math.max(0, n)
    }
    given[y] = row
  }
  const years = Object.keys(given)
    .map(Number)
    .filter((y) => Number.isFinite(y))
    .sort((a, b) => a - b)
  const first = Number(start.slice(0, 4))
  const out: Record<string, YearLimits> = {}
  for (let y = first; y < first + LIMIT_YEARS; y++) {
    const row = defaultLimits(y, birthYear)
    for (const k of LIMIT_KEYS) {
      const at = years.filter((g) => g <= y && given[g][k] != null).at(-1)
      const n = at != null ? given[at][k] : undefined
      if (n != null) row[k] = n
    }
    out[y] = row
  }
  return out
}

const BLANK_JOB: Job = {
  employer: "Current job",
  grossAnnual: 0,
  raise: null,
  schedule: { frequency: "biweekly", anchor: null, days: [] },
  deductions: [],
  withholding: DEFAULT_WITHHOLDING,
  match: { type: "none" },
  vesting: null,
  hsaEmployer: null,
  hsaTier: null,
}

/** One resolved person from the endpoint, every field defaulted. */
export function normalizePerson(
  v: unknown,
  index: number,
  start: string,
  asof: string,
  playCap = 0.1
): RunwayPerson {
  const o = obj(v)
  const parsedJob = parseJob(o.job, BLANK_JOB)
  const c = obj(o.cash)
  const r = obj(o.returns)
  const s = obj(o.starting)

  const given = arr(o.contributions)
    .map((x, i) => parseContribution(x, i, start))
    .filter((x): x is Contribution => x !== null)
  const legacy = legacyContributions(
    o,
    parsedJob,
    start,
    new Set(given.map((x) => x.account))
  )
  const contributions = [...legacy.list, ...given]
  // A deduction that became an HSA stream leaves every job's deduction list.
  const strip = (j: Job): Job =>
    legacy.hsaDeductions.size
      ? {
          ...j,
          deductions: j.deductions.filter(
            (d) => !(d.sleeve === "hsa" && legacy.hsaDeductions.has(d.label))
          ),
        }
      : j
  const job = strip(parsedJob)

  const scenarios: JobScenario[] = arr(o.scenarios).map((x, i) => {
    const so = obj(x)
    return {
      id: str(so.id, `scenario-${i}`),
      label: str(so.label, str(so.id, `Scenario ${i + 1}`)),
      start: so.start == null ? null : month(so.start, start),
      job: so.job == null ? null : strip(parseJob(so.job, parsedJob)),
    }
  })
  if (!scenarios.some((x) => x.id === "stay"))
    scenarios.unshift({ id: "stay", label: "Stay", start: null, job: null })

  const sleeves = zeroSleeves()
  for (const [key, val] of Object.entries(obj(s.sleeves))) {
    // The prototype called the IRA sleeve "roth".
    const kk = key === "roth" ? "ira" : key
    if (isSleeve(kk)) sleeves[kk] = num(val, 0)
  }

  const cardPayoff: RunwayPerson["cash"]["cardPayoff"] = {}
  for (const key of ["checking", "ef", "reserve"] as const) {
    const x = numOrNull(obj(c.cardPayoff)[key])
    if (x != null) cardPayoff[key] = x
  }
  if (Object.keys(cardPayoff).length === 0) cardPayoff.checking = 1

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
    id: str(o.id, `person-${index + 1}`),
    label: str(o.label, str(o.name, str(o.id, `Person ${index + 1}`))),
    job,
    contributions,
    limits: parseLimits(
      o.limits,
      numRecord(obj(o.k401).limits),
      start,
      numOrNull(o.birthYear)
    ),
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
    returns: {
      equity: num(r.equity, 0.07),
      reserve: num(r.reserve, 0.04),
      ef: num(r.ef, 0.035),
      gold: num(r.gold, 0.03),
    },
    scenarios,
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
    inherited: arr(o.inherited).filter(
      (x): x is string => typeof x === "string"
    ),
    sleeveText,
    notModeled,
    playCap: num(o.playCap, playCap),
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
  const playCap = num((d as Obj).playCap, 0.1)
  const errors = arr(d.errors).map(parseIssue)
  const warnings = arr(d.warnings).map(parseIssue)

  const people: RunwayPerson[] = []
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
    people.push(normalizePerson(body, i, start, asof, playCap))
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

  const spread =
    d.spreadThrough === "horizon" || d.spreadThrough === "year_end"
      ? d.spreadThrough
      : "year_end"
  return {
    asof,
    start,
    months: Math.max(1, Math.min(120, Math.round(num(d.months, 24)))),
    firstMonthSpendFraction: Math.max(
      0,
      Math.min(1, num(d.firstMonthSpendFraction, demo.firstMonthSpendFraction))
    ),
    spreadThrough: spread,
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

export function horizonOf(data: RunwayData): Horizon {
  return {
    asof: data.asof,
    start: data.start,
    months: data.months,
    firstMonthSpendFraction: data.firstMonthSpendFraction,
    spreadThrough: data.spreadThrough,
    reserveLookahead: data.reserveLookahead,
  }
}

export function personInputs(
  person: RunwayPerson,
  data: RunwayData
): RunwayInputs {
  return { person, horizon: horizonOf(data) }
}

export const DEMO_RUNWAY: RunwayData = demoRunway("2026-11-08")
