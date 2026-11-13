// Past months for the /runway chart. `/api/ext/runway_history` returns each
// person's month-end sleeve balances and monthly flows read from the ledger;
// this module parses that payload (tolerating a missing or malformed one)
// and turns a person's rows into the same MonthRow shape the forecast uses,
// flagged `actual` so the chart can style them and skip forecast-only logic.
// No React, no DOM, so the node test runner can load it.

import { addMonths } from "./schedule"
import type { SleeveId } from "./sleeves"
import type { MonthDeposits, MonthRow } from "./types"

/** Months of history the chart can show; 0 is the plan alone. */
export const HISTORY_RANGES = [0, 12, 24] as const
export type HistoryRange = (typeof HISTORY_RANGES)[number]

export interface HistoryRow {
  month: string
  sleeves: Record<SleeveId, number>
  cards: number
  loans: number
  netWorth: number
  takeHome: number
  spending: number
  net: number
  deposits: MonthDeposits
  unmapped: number
}

export interface HistoryPerson {
  id: string
  available: boolean
  reason: string | null
  rows: HistoryRow[]
  unmappedAccounts: string[]
}

export interface RunwayHistory {
  asof: string
  start: string
  months: string[]
  version: string
  people: HistoryPerson[]
  errors: string[]
}

const SLEEVE_KEYS: SleeveId[] = [
  "checking",
  "ef",
  "reserve",
  "core",
  "ira",
  "k401",
  "hsa",
  "gold",
  "play",
  "other",
]

const MONTH_RE = /^\d{4}-\d{2}$/

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0
const str = (v: unknown): string => (typeof v === "string" ? v : "")

function parseRow(raw: unknown): HistoryRow | null {
  if (!isObj(raw) || !MONTH_RE.test(str(raw.month))) return null
  const s = isObj(raw.sleeves) ? raw.sleeves : {}
  const d = isObj(raw.deposits) ? raw.deposits : {}
  const sleeves = Object.fromEntries(
    SLEEVE_KEYS.map((k) => [k, num(s[k])])
  ) as Record<SleeveId, number>
  const takeHome = num(raw.takeHome)
  const spending = num(raw.spending)
  return {
    month: str(raw.month),
    sleeves,
    cards: num(raw.cards),
    loans: num(raw.loans),
    netWorth: num(raw.netWorth),
    takeHome,
    spending,
    net: typeof raw.net === "number" ? num(raw.net) : takeHome - spending,
    deposits: { ira: num(d.ira), k401: num(d.k401), hsa: num(d.hsa) },
    unmapped: num(raw.unmapped),
  }
}

function parsePerson(raw: unknown): HistoryPerson | null {
  if (!isObj(raw) || !str(raw.id)) return null
  const rows = Array.isArray(raw.rows)
    ? raw.rows.map(parseRow).filter((r): r is HistoryRow => r != null)
    : []
  rows.sort((a, b) => a.month.localeCompare(b.month))
  return {
    id: str(raw.id),
    available: raw.available === true && rows.length > 0,
    reason: str(raw.reason) || null,
    rows,
    unmappedAccounts: Array.isArray(raw.unmappedAccounts)
      ? raw.unmappedAccounts.filter((a): a is string => typeof a === "string")
      : [],
  }
}

/** The payload, or null when it is not one (an HTML error page, a missing
 * endpoint, a shape this code does not know). Bad rows and people are
 * dropped rather than failing the whole payload. */
export function parseRunwayHistory(raw: unknown): RunwayHistory | null {
  if (!isObj(raw) || !Array.isArray(raw.people)) return null
  return {
    asof: str(raw.asof),
    start: str(raw.start),
    months: Array.isArray(raw.months)
      ? raw.months.filter((m): m is string => MONTH_RE.test(str(m)))
      : [],
    version: str(raw.version),
    people: raw.people
      .map(parsePerson)
      .filter((p): p is HistoryPerson => p != null),
    errors: Array.isArray(raw.errors)
      ? raw.errors
          .map((e) =>
            typeof e === "string" ? e : isObj(e) ? str(e.message) : ""
          )
          .filter(Boolean)
      : [],
  }
}

/** One past month as a chart row. Fields only the forecast knows (reserve
 * moves, match, unvested money, one-off bills) are 0; `outflows` is set so
 * that take-home minus outflows is the month's actual net. */
export function historyRow(h: HistoryRow): MonthRow {
  const s = h.sleeves
  const invested = s.core + s.gold + s.ira + s.k401 + s.hsa + s.play
  const cash = s.checking + s.ef + s.reserve
  const outflows = h.takeHome - h.net
  const events: string[] = []
  if (h.deposits.ira >= 0.5) events.push("IRA deposit")
  if (h.deposits.k401 >= 0.5) events.push("401k deposit")
  if (h.deposits.hsa >= 0.5) events.push("HSA deposit")
  return {
    month: h.month,
    takeHome: h.takeHome,
    outflows,
    shortfall: Math.max(0, outflows - h.takeHome),
    spendOut: h.spending,
    iraOut: 0,
    hsaOut: 0,
    taxOut: 0,
    k401In: h.deposits.k401,
    hsaIn: h.deposits.hsa,
    match: 0,
    reserveToCore: 0,
    paychecks: 0,
    ...s,
    unvested: 0,
    invested,
    cash,
    netWorth: h.netWorth,
    playShare: invested > 0 ? Math.max(0, s.play) / invested : 0,
    events,
    actual: true,
    deposits: { ...h.deposits },
  }
}

/** History rows to draw before `forecast`: the last `range` months that end
 * the month before the forecast starts. Empty when the range is 0, the
 * person has no history, or the months do not meet the forecast (a gap
 * would put two unrelated months side by side). */
export function historyBefore(
  person: HistoryPerson | null | undefined,
  forecast: MonthRow[],
  range: HistoryRange
): MonthRow[] {
  const start = forecast[0]?.month
  if (!range || !start || !person?.available) return []
  const before = person.rows.filter((r) => r.month < start)
  if (before.at(-1)?.month !== addMonths(start, -1)) return []
  const kept = before.slice(-range)
  // Keep only the contiguous run that reaches the forecast.
  let from = kept.length - 1
  while (from > 0 && addMonths(kept[from - 1].month, 1) === kept[from].month)
    from--
  return kept.slice(from).map(historyRow)
}

/** Why a history range draws only the forecast, or null when it draws
 * history. `failed` is a missing endpoint or a payload that did not parse. */
export function historyNote(
  range: HistoryRange,
  history: RunwayHistory | null,
  personId: string,
  shown: number,
  failed: boolean
): string | null {
  if (!range) return null
  if (failed || !history)
    return "History is not available from the ledger server yet."
  const p = history.people.find((x) => x.id === personId)
  if (!p) return "No history for this person."
  if (!p.available) return p.reason ?? "No history for this person."
  if (!shown) return "No history in the months before the plan starts."
  return null
}
